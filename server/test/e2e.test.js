'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createServer } = require('../server');

// Smallest valid JPEG header + padding; the server only checks magic bytes.
const FAKE_JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]).toString('base64');

test('full session lifecycle', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'exam-e2e-'));
  const examsFile = path.join(tmp, 'exams.json');
  fs.writeFileSync(examsFile, JSON.stringify({
    T1: {
      title: 'Test exam', startUrl: 'https://exam.test/', allow: [{ host: 'exam.test', ports: [443] }],
      durationMinutes: 30, exitCode: 'BYE', students: ['s1', 'S2'],
    },
  }));
  const srv = createServer({ port: 0, dataDir: path.join(tmp, 'data'), examsFile, adminPassword: 'pw' });
  const port = await srv.ready;
  t.after(async () => { await srv.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

  const base = `http://127.0.0.1:${port}`;
  const admin = { authorization: 'Basic ' + Buffer.from('admin:pw').toString('base64') };
  const post = (p, body, headers = {}) => fetch(base + p, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  });

  // --- start: validation
  assert.equal((await post('/api/session/start', { examCode: 'NOPE', studentId: 's1', studentName: 'A', consent: true })).status, 404);
  assert.equal((await post('/api/session/start', { examCode: 'T1', studentId: 's1', studentName: 'A', consent: false })).status, 400);
  assert.equal((await post('/api/session/start', { examCode: 'T1', studentId: 'zzz', studentName: 'A', consent: true })).status, 403);

  // --- start: success + signature verifies with the public key
  const r = await post('/api/session/start', {
    examCode: 't1', studentId: 's1', studentName: 'Asha', consent: true,
    device: { hostname: 'lab-pc-07', ips: ['10.0.0.7'], platform: 'linux' },
  });
  assert.equal(r.status, 200);
  const start = await r.json();
  const pub = crypto.createPublicKey(srv.keys.publicPem);
  assert.ok(crypto.verify(null, Buffer.from(start.policy), pub, Buffer.from(start.signature, 'base64')), 'signature valid');
  assert.ok(!crypto.verify(null, Buffer.from(start.policy + ' '), pub, Buffer.from(start.signature, 'base64')), 'tampered policy rejected');
  const policy = JSON.parse(start.policy);
  assert.equal(policy.sessionId, start.sessionId);
  assert.equal(policy.allow[0].host, 'exam.test');
  assert.equal(policy.settings.allowClipboard, false);
  assert.ok(policy.endsAt > Date.now());
  const auth = { authorization: 'Bearer ' + start.token };

  // --- heartbeat auth
  assert.equal((await post(`/api/session/${start.sessionId}/heartbeat`, {})).status, 401);
  const hb = await (await post(`/api/session/${start.sessionId}/heartbeat`, { state: { focused: true, url: 'https://exam.test/q1' } }, auth)).json();
  assert.equal(hb.ok, true);

  // --- alert with screenshot
  const ar = await post('/api/alerts', {
    sessionId: start.sessionId, type: 'FOCUS_LOST', severity: 'high', detail: 'lost focus <script>alert(1)</script>',
    ts: new Date().toISOString(), url: 'https://exam.test/q1', context: { hostname: 'lab-pc-07' },
    log: [{ t: 'now', type: 'X', detail: 'y' }],
    screenshots: [{ label: 'screen 1', data: FAKE_JPEG }, { label: 'evil', data: Buffer.from('not an image').toString('base64') }],
  }, auth);
  assert.equal(ar.status, 200);
  assert.equal((await post('/api/alerts', { sessionId: start.sessionId, type: 'bad type!' }, auth)).status, 400);
  assert.equal((await post('/api/alerts', { sessionId: 'other', type: 'FOCUS_LOST' }, auth)).status, 403);

  // --- admin views
  assert.equal((await fetch(base + '/api/admin/sessions')).status, 401);
  const sessions = await (await fetch(base + '/api/admin/sessions', { headers: admin })).json();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].alertCount, 1);
  assert.equal(sessions[0].highCount, 1);
  assert.equal(sessions[0].status, 'online');
  const alerts = await (await fetch(base + `/api/admin/alerts?sessionId=${start.sessionId}`, { headers: admin })).json();
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].shots.length, 1, 'non-image screenshot dropped');
  const shot = await fetch(base + '/api/admin/shots/' + alerts[0].shots[0].file, { headers: admin });
  assert.equal(shot.status, 200);
  assert.equal((await fetch(base + '/api/admin/shots/..%2Fsessions.json', { headers: admin })).status >= 400, true);
  const csv = await (await fetch(base + '/api/admin/export.csv', { headers: admin })).text();
  assert.match(csv, /FOCUS_LOST/);
  const html = await (await fetch(base + '/admin/', { headers: admin })).text();
  assert.match(html, /Exam Monitor/);

  // --- relaunch keeps the original end time and flags the duplicate
  const r2 = await (await post('/api/session/start', { examCode: 'T1', studentId: 'S1', studentName: 'Asha', consent: true })).json();
  assert.equal(JSON.parse(r2.policy).endsAt, policy.endsAt);
  const all = await (await fetch(base + '/api/admin/alerts', { headers: admin })).json();
  assert.ok(all.some((a) => a.type === 'DUPLICATE_LOGIN'));

  // --- remote terminate reaches the client via heartbeat
  const term = await post(`/api/admin/sessions/${r2.sessionId}/terminate`, { reason: 'Stop now' }, admin);
  assert.equal(term.status, 200);
  const auth2 = { authorization: 'Bearer ' + r2.token };
  const hb2 = await (await post(`/api/session/${r2.sessionId}/heartbeat`, {}, auth2)).json();
  assert.equal(hb2.terminate, true);
  assert.equal(hb2.reason, 'Stop now');

  // --- exit code: the first session was replaced (ended), so use a fresh student
  const r3 = await (await post('/api/session/start', { examCode: 'T1', studentId: 'S2', studentName: 'Ravi', consent: true })).json();
  const auth3 = { authorization: 'Bearer ' + r3.token };
  assert.equal((await post(`/api/session/${r3.sessionId}/exit`, { code: 'wrong' }, auth3)).status, 403);
  assert.equal((await post(`/api/session/${r3.sessionId}/exit`, { code: 'BYE' }, auth3)).status, 200);
});
