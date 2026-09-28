'use strict';
// One exam institute's worth of API: policy signing, session lifecycle, alert intake,
// live dashboard. Returns an Express Router so a caller can mount it anywhere —
// server.js mounts one at "/" for a single-institute install, central.js mounts one
// per institute at "/i/<slug>" so many institutes can share one running server.

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { ensureKeys, sign } = require('./keys');
const { Store } = require('./store');

const DEFAULT_SETTINGS = {
  allowClipboard: false, contentProtection: true, allowMultipleDisplays: false, strictSubresources: false,
  openAllowedPopupsInPlace: true, showWarnings: true, focusGraceMs: 800, alertCooldownMs: 5000,
  heartbeatSeconds: 15, processCheckSeconds: 20, allowedPermissions: [], screenshotQuality: 65, screenshotMaxWidth: 1920,
};

const DEFAULT_BLOCKED_PROCESSES = [
  'teamviewer', 'anydesk', 'rustdesk', 'ultraviewer', 'parsec', 'vncviewer', 'x11vnc', 'nomachine', 'nxserver',
  'obs', 'obs64', 'obs-studio', 'simplescreenrecorder', 'kazam', 'vokoscreen', 'peek',
  'zoom', 'skype', 'discord',
  'snippingtool', 'screenclippingtool', 'flameshot', 'gnome-screenshot', 'spectacle', 'shutter',
];

const ALERT_TYPE_RE = /^[A-Z][A-Z0-9_]{1,47}$/;
const SEVERITIES = new Set(['low', 'medium', 'high']);
const HEARTBEAT_TIMEOUT_MS = 60000;

const safeEq = (a, b) => {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
};
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const strList = (v, maxItems, maxLen) => (Array.isArray(v) ? v.slice(0, maxItems).map((x) => str(String(x), maxLen)) : []);

function limiter(max, windowMs) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip;
    const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
    arr.push(now);
    hits.set(key, arr);
    if (arr.length > max) return res.status(429).json({ error: 'rate_limited', message: 'Too many attempts. Wait a minute and retry.' });
    next();
  };
}

/**
 * opts:
 *   dataDir     folder for keys/, sessions.json, alerts.jsonl, shots/
 *   examsFile   path to this institute's exams.json (auto-seeded with a demo exam if missing)
 *   checkAdmin(user, password) -> boolean   dashboard login check
 *   publicDir   folder with the dashboard's static files (default ../public next to this file)
 */
function createTenant(opts) {
  const dataDir = path.resolve(opts.dataDir);
  const examsFile = path.resolve(opts.examsFile);
  const checkAdmin = opts.checkAdmin;
  const publicDir = opts.publicDir || path.join(__dirname, '..', 'public');

  fs.mkdirSync(dataDir, { recursive: true });
  const keys = ensureKeys(dataDir);
  const store = new Store(dataDir);

  if (!fs.existsSync(examsFile)) {
    fs.mkdirSync(path.dirname(examsFile), { recursive: true });
    fs.writeFileSync(examsFile, JSON.stringify({
      DEMO101: {
        title: 'Demo Assessment', startUrl: 'https://example.com/',
        allow: [{ host: 'example.com', ports: [443] }, { host: '*.example.com', ports: [443] }],
        durationMinutes: 60, exitCode: 'FINISH-1234', opensAt: null, closesAt: null, students: null,
        settings: { allowClipboard: false }, blockedProcesses: null,
      },
    }, null, 2));
  }
  const loadExams = () => JSON.parse(fs.readFileSync(examsFile, 'utf8'));

  const router = express.Router();

  const sseClients = new Set();
  const broadcast = (event, data) => {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of sseClients) c.write(msg);
  };
  const sseKeepAlive = setInterval(() => { for (const c of sseClients) c.write(': ping\n\n'); }, 25000);
  sseKeepAlive.unref();

  const publicSession = (s) => {
    let status = 'online';
    if (s.endedAt) status = 'ended';
    else if (s.terminate) status = 'terminating';
    else if (Date.now() - s.lastSeen > HEARTBEAT_TIMEOUT_MS) status = 'offline';
    return {
      id: s.id, examCode: s.examCode, examTitle: s.examTitle, studentId: s.studentId, studentName: s.studentName,
      device: s.device, ip: s.ip, startedAt: s.startedAt, lastSeen: s.lastSeen, endedAt: s.endedAt,
      endReason: s.endReason, status, alertCount: s.alertCount, highCount: s.highCount, lastAlert: s.lastAlert,
      endsAt: s.endsAt, lastState: s.lastState,
    };
  };

  function recordAlert(session, a, shots = []) {
    const id = crypto.randomUUID();
    const alert = {
      id, sessionId: session.id, examCode: session.examCode, studentId: session.studentId, studentName: session.studentName,
      type: a.type, severity: a.severity, detail: a.detail, url: a.url || '', source: a.source || 'client',
      clientTs: a.clientTs || null, receivedAt: Date.now(), context: a.context || null, log: a.log || [], shots,
    };
    store.addAlert(alert);
    broadcast('alert', { alert, session: publicSession(session) });
    return alert;
  }

  function adminAuth(req, res, next) {
    const [scheme, b64] = (req.headers.authorization || '').split(' ');
    if (scheme === 'Basic' && b64) {
      const decoded = Buffer.from(b64, 'base64').toString('utf8');
      const i = decoded.indexOf(':');
      if (i >= 0 && checkAdmin(decoded.slice(0, i), decoded.slice(i + 1))) return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="Exam admin", charset="UTF-8"');
    res.status(401).send('Authentication required');
  }

  function sessionAuth(req, res, next) {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    const s = m && store.authenticate(m[1]);
    if (!s) return res.status(401).json({ error: 'invalid_token' });
    if (req.params.id && req.params.id !== s.id) return res.status(403).json({ error: 'wrong_session' });
    req.examSession = s;
    next();
  }

  // ===== Client API ==========================================================
  router.get('/api/health', (req, res) => res.json({ ok: true, time: Date.now() }));

  router.post('/api/session/start', limiter(30, 60000), express.json({ limit: '100kb' }), (req, res) => {
    const b = req.body || {};
    const fail = (status, error, message) => res.status(status).json({ error, message });

    let exams;
    try { exams = loadExams(); } catch { return fail(500, 'config_error', 'Server exam configuration is unreadable.'); }

    const examCode = str(b.examCode, 64).trim().toUpperCase();
    const studentId = str(b.studentId, 64).trim();
    const studentName = str(b.studentName, 100).trim();
    const exam = exams[examCode];
    if (!exam) return fail(404, 'unknown_exam', 'Unknown exam code.');
    if (b.consent !== true) return fail(400, 'consent_required', 'You must accept the monitoring notice to continue.');
    if (!/^[\w.@-]{1,64}$/.test(studentId)) return fail(400, 'bad_student_id', 'Invalid student ID.');
    if (!studentName) return fail(400, 'bad_name', 'Name is required.');
    if (Array.isArray(exam.students) && !exam.students.map((x) => String(x).toLowerCase()).includes(studentId.toLowerCase())) {
      return fail(403, 'not_enrolled', 'This student ID is not enrolled for this exam.');
    }

    const now = Date.now();
    if (exam.opensAt && now < Date.parse(exam.opensAt)) return fail(403, 'not_open', 'This exam has not opened yet.');
    if (exam.closesAt && now > Date.parse(exam.closesAt)) return fail(403, 'closed', 'This exam is closed.');

    const prev = store.latestFor(examCode, studentId);
    let endsAt = null;
    if (prev && prev.endsAt) endsAt = prev.endsAt;
    else if (exam.durationMinutes) endsAt = now + exam.durationMinutes * 60000;
    if (exam.closesAt) endsAt = Math.min(endsAt ?? Infinity, Date.parse(exam.closesAt));
    if (endsAt !== null && endsAt <= now) return fail(403, 'time_over', 'Your exam time is over.');

    const d = b.device || {};
    const device = {
      hostname: str(d.hostname, 100), username: str(d.username, 100), platform: str(d.platform, 20),
      arch: str(d.arch, 20), osRelease: str(d.osRelease, 60), appVersion: str(d.appVersion, 20),
      sessionType: str(d.sessionType, 20), ips: strList(d.ips, 8, 64), macs: strList(d.macs, 8, 32),
      displays: Number.isFinite(d.displays) ? d.displays : null,
    };

    const { session, token } = store.createSession({
      examCode, examTitle: exam.title || examCode, studentId, studentName, device, ip: req.ip, endsAt,
      exitCode: exam.exitCode ? String(exam.exitCode) : null,
    });

    if (prev && !prev.endedAt) {
      prev.endedAt = now;
      prev.endReason = 'replaced by new login';
      recordAlert(session, {
        type: 'DUPLICATE_LOGIN', severity: 'medium', source: 'server',
        detail: `Student started a new session while ${prev.device?.hostname || 'another machine'} (${prev.ip}) was still active.`,
      });
      store.save();
    }

    const policyObj = {
      v: 1, sessionId: session.id, examCode, title: session.examTitle, startUrl: exam.startUrl,
      allow: exam.allow || [], settings: { ...DEFAULT_SETTINGS, ...(exam.settings || {}) },
      blockedProcesses: exam.blockedProcesses || DEFAULT_BLOCKED_PROCESSES, endsAt, issuedAt: now,
    };
    const policy = JSON.stringify(policyObj);
    broadcast('session', publicSession(session));
    res.json({ sessionId: session.id, token, policy, signature: sign(keys.privateKey, policy), serverTime: now });
  });

  router.post('/api/session/:id/heartbeat', sessionAuth, express.json({ limit: '20kb' }), (req, res) => {
    const s = req.examSession;
    const now = Date.now();
    if (s.endedAt) return res.json({ ended: true, reason: s.endReason });

    s.lastSeen = now;
    const st = req.body?.state || {};
    s.lastState = { focused: !!st.focused, url: str(st.url, 300), displays: Number(st.displays) || null };
    if (s.offlineFlagged) {
      s.offlineFlagged = false;
      recordAlert(s, { type: 'CONNECTION_RESTORED', severity: 'low', source: 'server', detail: 'Heartbeat resumed.' });
    }
    store.save();

    if (s.terminate) {
      s.endedAt = now;
      s.endReason = `terminated by admin: ${s.terminate.reason}`;
      store.save();
      broadcast('session', publicSession(s));
      return res.json({ terminate: true, reason: s.terminate.reason });
    }
    broadcast('session', publicSession(s));
    res.json({ ok: true, serverTime: now });
  });

  router.post('/api/session/:id/exit', sessionAuth, limiter(20, 60000), express.json({ limit: '5kb' }), (req, res) => {
    const s = req.examSession;
    if (s.endedAt) return res.json({ ok: true });
    if (s.exitCode && !safeEq(str(req.body?.code, 100), s.exitCode)) {
      s.exitFailures += 1;
      if (s.exitFailures % 3 === 0) {
        recordAlert(s, { type: 'EXIT_CODE_GUESS', severity: 'medium', source: 'server', detail: `${s.exitFailures} wrong exit codes entered.` });
      }
      store.save();
      return res.status(403).json({ error: 'bad_code', message: 'Incorrect exit code.' });
    }
    s.endedAt = Date.now();
    s.endReason = 'completed';
    store.save();
    broadcast('session', publicSession(s));
    res.json({ ok: true });
  });

  router.post('/api/alerts', sessionAuth, express.json({ limit: '40mb' }), (req, res) => {
    const s = req.examSession;
    const b = req.body || {};
    if (b.sessionId !== s.id) return res.status(403).json({ error: 'wrong_session' });
    const type = str(b.type, 48);
    if (!ALERT_TYPE_RE.test(type)) return res.status(400).json({ error: 'bad_type' });
    const severity = SEVERITIES.has(b.severity) ? b.severity : 'medium';

    const alertId = crypto.randomUUID();
    const shots = [];
    const rawShots = Array.isArray(b.screenshots) ? b.screenshots.slice(0, 8) : [];
    for (const [i, sh] of rawShots.entries()) {
      if (!sh || typeof sh.data !== 'string' || sh.data.length > 12_000_000) continue;
      const buf = Buffer.from(sh.data, 'base64');
      let ext = null;
      if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) ext = 'jpg';
      else if (buf.length > 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) ext = 'png';
      if (!ext) continue;
      shots.push({ file: store.writeShot(alertId, i, buf, ext), label: str(sh.label, 60) });
    }

    let context = null;
    try {
      const raw = JSON.stringify(b.context || {});
      if (raw.length <= 6000) context = JSON.parse(raw);
    } catch { /* ignore */ }
    const log = Array.isArray(b.log)
      ? b.log.slice(-50).map((e) => ({ t: str(e?.t, 40), type: str(e?.type, 48), detail: str(e?.detail, 300) }))
      : [];

    const alert = recordAlert(s, {
      type, severity, detail: str(b.detail, 2000), url: str(b.url, 500), clientTs: str(b.ts, 40), context, log,
    }, shots);
    res.json({ ok: true, id: alert.id });
  });

  // ===== Admin API + dashboard ================================================
  router.get('/', (req, res) => res.redirect(req.baseUrl + '/admin/'));
  router.use('/admin', adminAuth, express.static(publicDir));

  router.get('/api/admin/sessions', adminAuth, (req, res) => {
    const exam = str(req.query.exam, 64);
    const list = [...store.sessions.values()].filter((s) => !exam || s.examCode === exam).map(publicSession);
    list.sort((a, b) => b.lastSeen - a.lastSeen);
    res.json(list);
  });

  router.get('/api/admin/exams', adminAuth, (req, res) => {
    try { res.json(Object.entries(loadExams()).map(([code, e]) => ({ code, title: e.title }))); } catch { res.json([]); }
  });

  function normalizeExam(input) {
    const code = str(input?.code, 64).trim().toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9_-]{1,63}$/.test(code)) throw new Error('Use 2–64 letters, numbers, hyphens or underscores for the exam code.');
    const title = str(input?.title, 160).trim() || code;
    let start;
    try { start = new URL(str(input?.startUrl, 1000).trim()); } catch { throw new Error('Enter a valid exam start URL.'); }
    if (!['https:', 'http:'].includes(start.protocol)) throw new Error('The exam start URL must use http or https.');
    const rawAllowed = Array.isArray(input?.allowedUrls) ? input.allowedUrls : [];
    const urls = [start.href, ...rawAllowed.map((v) => str(v, 1000).trim()).filter(Boolean)];
    const rules = new Map();
    for (const value of urls) {
      let u;
      try { u = new URL(value); } catch { throw new Error('Each allowed site must be a full URL, for example https://exam.example.com'); }
      if (!['https:', 'http:'].includes(u.protocol)) throw new Error('Allowed sites must use http or https.');
      const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
      const scheme = u.protocol.slice(0, -1);
      const key = u.hostname.toLowerCase() + '|' + scheme;
      if (!rules.has(key)) rules.set(key, { host: u.hostname.toLowerCase(), ports: [], schemes: [scheme] });
      if (!rules.get(key).ports.includes(port)) rules.get(key).ports.push(port);
    }
    const durationMinutes = Number(input?.durationMinutes || 0);
    if (!Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 1440) throw new Error('Duration must be between 1 and 1440 minutes.');
    const students = Array.isArray(input?.students) ? input.students.map((v) => str(v, 64).trim()).filter(Boolean).slice(0, 100000) : [];
    return { code, exam: {
      title, startUrl: start.href, allow: [...rules.values()], durationMinutes,
      exitCode: str(input?.exitCode, 100).trim() || null,
      opensAt: input?.opensAt ? str(input.opensAt, 64) : null, closesAt: input?.closesAt ? str(input.closesAt, 64) : null,
      students: students.length ? students : null,
      settings: { allowClipboard: input?.allowClipboard === true },
      blockedProcesses: null,
    }};
  }

  router.get('/api/admin/exam-config', adminAuth, (req, res) => {
    try {
      const exams = loadExams();
      res.json(Object.entries(exams).map(([code, e]) => ({
        code, title: e.title || code, startUrl: e.startUrl || '', durationMinutes: e.durationMinutes || 60,
        exitCode: e.exitCode || '', opensAt: e.opensAt || '', closesAt: e.closesAt || '', students: e.students || [],
        allowClipboard: !!e.settings?.allowClipboard,
        allowedUrls: (e.allow || []).flatMap((r) => (r.ports || [443]).map((p) => `${(r.schemes || ['https'])[0]}://${r.host}${p === 443 && (r.schemes || ['https'])[0] === 'https' ? '' : p === 80 && (r.schemes || ['https'])[0] === 'http' ? '' : ':' + p}`)),
      })));
    } catch { res.status(500).json({ error: 'config_error', message: 'Could not read exam configuration.' }); }
  });

  router.put('/api/admin/exams/:code', adminAuth, express.json({ limit: '100kb' }), (req, res) => {
    try {
      const { code, exam } = normalizeExam({ ...req.body, code: req.params.code });
      const exams = loadExams(); exams[code] = exam;
      fs.writeFileSync(examsFile, JSON.stringify(exams, null, 2));
      res.json({ ok: true, code });
    } catch (e) { res.status(400).json({ error: 'invalid_exam', message: e.message || 'Invalid exam configuration.' }); }
  });

  router.delete('/api/admin/exams/:code', adminAuth, (req, res) => {
    try {
      const code = str(req.params.code, 64).trim().toUpperCase();
      const exams = loadExams();
      if (!exams[code]) return res.status(404).json({ error: 'not_found' });
      delete exams[code]; fs.writeFileSync(examsFile, JSON.stringify(exams, null, 2));
      res.json({ ok: true });
    } catch { res.status(500).json({ error: 'config_error' }); }
  });

  router.get('/api/admin/alerts', adminAuth, (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 200, 1000);
    res.json(store.listAlerts({ sessionId: str(req.query.sessionId, 64) || undefined, limit }));
  });

  router.get('/api/admin/shots/:file', adminAuth, (req, res) => {
    if (!/^[\w-]+\.(jpg|png)$/.test(req.params.file)) return res.status(400).end();
    const p = path.join(store.shotDir, req.params.file);
    if (!fs.existsSync(p)) return res.status(404).end();
    res.set('Cache-Control', 'private, max-age=86400');
    res.sendFile(p);
  });

  router.post('/api/admin/sessions/:id/terminate', adminAuth, express.json({ limit: '5kb' }), (req, res) => {
    const s = store.sessions.get(req.params.id);
    if (!s) return res.status(404).json({ error: 'not_found' });
    if (s.endedAt) return res.status(409).json({ error: 'already_ended' });
    s.terminate = { reason: str(req.body?.reason, 200) || 'Ended by invigilator', at: Date.now() };
    store.save();
    broadcast('session', publicSession(s));
    res.json({ ok: true });
  });

  router.get('/api/admin/export.csv', adminAuth, (req, res) => {
    const cell = (v) => {
      let t = String(v ?? '');
      if (/^[=+\-@\t\r]/.test(t)) t = "'" + t;
      return '"' + t.replace(/"/g, '""') + '"';
    };
    const rows = [['time', 'exam', 'student_id', 'student_name', 'type', 'severity', 'source', 'detail', 'url', 'screenshots']];
    for (const a of store.listAlerts({ sessionId: str(req.query.sessionId, 64) || undefined, limit: 100000 }).reverse()) {
      rows.push([new Date(a.receivedAt).toISOString(), a.examCode, a.studentId, a.studentName, a.type, a.severity, a.source, a.detail, a.url, a.shots.length]);
    }
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="alerts.csv"');
    res.send(rows.map((r) => r.map(cell).join(',')).join('\n'));
  });

  router.get('/api/admin/stream', adminAuth, (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    res.write('retry: 3000\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
  });

  const watchdog = setInterval(() => {
    const now = Date.now();
    for (const s of store.sessions.values()) {
      if (s.endedAt) continue;
      if (s.endsAt && now > s.endsAt + 120000) {
        s.endedAt = now; s.endReason = 'time up'; store.save();
        broadcast('session', publicSession(s));
        continue;
      }
      if (!s.offlineFlagged && now - s.lastSeen > HEARTBEAT_TIMEOUT_MS) {
        s.offlineFlagged = true;
        store.save();
        recordAlert(s, {
          type: 'CONNECTION_LOST', severity: 'high', source: 'server',
          detail: `No heartbeat for ${Math.round((now - s.lastSeen) / 1000)}s (network cut, app killed, or machine off).`,
        });
      }
    }
  }, 10000);
  watchdog.unref();

  const close = () => {
    clearInterval(watchdog);
    clearInterval(sseKeepAlive);
    for (const c of sseClients) c.end();
    store.close();
  };

  return { router, store, keys, close, dataDir, examsFile };
}

module.exports = { createTenant, DEFAULT_SETTINGS, DEFAULT_BLOCKED_PROCESSES };
