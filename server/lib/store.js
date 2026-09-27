'use strict';
// Tiny file-backed store: sessions.json (rewritten, debounced), alerts.jsonl
// (append-only) and shots/ (JPEG/PNG evidence). No native modules, so the
// server installs anywhere Node runs.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

class Store {
  constructor(dir) {
    this.dir = dir;
    this.shotDir = path.join(dir, 'shots');
    fs.mkdirSync(this.shotDir, { recursive: true });
    this.sessionsFile = path.join(dir, 'sessions.json');
    this.alertsFile = path.join(dir, 'alerts.jsonl');
    this.sessions = new Map();
    this.byToken = new Map();
    this.alerts = [];
    this._dirty = false;
    this._load();
    this._timer = setInterval(() => this.flush(), 2000);
    this._timer.unref();
  }

  _load() {
    try {
      const arr = JSON.parse(fs.readFileSync(this.sessionsFile, 'utf8'));
      for (const s of arr) {
        this.sessions.set(s.id, s);
        this.byToken.set(s.tokenHash, s.id);
      }
    } catch { /* first run */ }
    try {
      for (const line of fs.readFileSync(this.alertsFile, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try { this.alerts.push(JSON.parse(line)); } catch { /* skip corrupt line */ }
      }
    } catch { /* first run */ }
  }

  flush() {
    if (!this._dirty) return;
    this._dirty = false;
    const tmp = this.sessionsFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify([...this.sessions.values()]));
    fs.renameSync(tmp, this.sessionsFile);
  }

  save() { this._dirty = true; }

  close() { clearInterval(this._timer); this.flush(); }

  createSession(fields) {
    const id = crypto.randomUUID();
    const token = crypto.randomBytes(32).toString('hex');
    const session = {
      id,
      tokenHash: sha(token),
      startedAt: Date.now(),
      lastSeen: Date.now(),
      endedAt: null,
      endReason: null,
      terminate: null,
      offlineFlagged: false,
      alertCount: 0,
      highCount: 0,
      lastAlert: null,
      lastState: null,
      exitFailures: 0,
      ...fields,
    };
    this.sessions.set(id, session);
    this.byToken.set(session.tokenHash, id);
    this.save();
    return { session, token };
  }

  authenticate(token) {
    const id = this.byToken.get(sha(String(token || '')));
    return id ? this.sessions.get(id) : null;
  }

  latestFor(examCode, studentId) {
    let best = null;
    for (const s of this.sessions.values()) {
      if (s.examCode === examCode && s.studentId.toLowerCase() === studentId.toLowerCase()) {
        if (!best || s.startedAt > best.startedAt) best = s;
      }
    }
    return best;
  }

  addAlert(alert) {
    this.alerts.push(alert);
    fs.appendFileSync(this.alertsFile, JSON.stringify(alert) + '\n');
    const s = this.sessions.get(alert.sessionId);
    if (s) {
      s.alertCount += 1;
      if (alert.severity === 'high') s.highCount += 1;
      s.lastAlert = { type: alert.type, severity: alert.severity, at: alert.receivedAt };
      this.save();
    }
  }

  listAlerts({ sessionId, limit = 200 } = {}) {
    let out = this.alerts;
    if (sessionId) out = out.filter((a) => a.sessionId === sessionId);
    return out.slice(-limit).reverse();
  }

  writeShot(alertId, index, buffer, ext) {
    const file = `${alertId}-${index}.${ext}`;
    fs.writeFileSync(path.join(this.shotDir, file), buffer);
    return file;
  }
}

module.exports = { Store };
