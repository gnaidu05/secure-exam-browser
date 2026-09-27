'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCentralServer } = require('../central');

test('multi-institute central server keeps institutes fully separate', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'central-e2e-'));
  const srv = createCentralServer({ port: 0, dataDir: tmp, superPassword: 'super-pw' });
  const port = await srv.ready;
  t.after(async () => { await srv.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

  const base = `http://127.0.0.1:${port}`;
  const superAuth = { authorization: 'Basic ' + Buffer.from('super:super-pw').toString('base64') };
  const post = (p, body, headers = {}) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const get = (p, headers = {}) => fetch(base + p, { headers });

  // --- super admin page requires auth
  assert.equal((await get('/super/api/institutes')).status, 401);
  assert.equal((await get('/super/', superAuth)).status, 200);

  // --- create two institutes
  const a = await (await post('/super/api/institutes', { name: 'Alpha College' }, superAuth)).json();
  const b = await (await post('/super/api/institutes', { name: 'Beta Institute' }, superAuth)).json();
  assert.equal(a.slug, 'alpha-college');
  assert.equal(b.slug, 'beta-institute');
  assert.ok(a.adminPassword && b.adminPassword && a.adminPassword !== b.adminPassword);
  assert.match(a.dashboardUrl, /\/i\/alpha-college\/admin\/$/);

  // --- creating another institute with the same name auto-picks a fresh code (no clash)...
  const aAgain = await (await post('/super/api/institutes', { name: 'Alpha College' }, superAuth)).json();
  assert.notEqual(aAgain.slug, a.slug);
  // ...but an explicit, already-used code is rejected outright
  assert.equal((await post('/super/api/institutes', { name: 'Something Else', slug: a.slug }, superAuth)).status, 409);

  // --- each institute gets its OWN signing key
  const keyA = await (await get(`/super/api/institutes/${a.slug}/public-key`, superAuth)).text();
  const keyB = await (await get(`/super/api/institutes/${b.slug}/public-key`, superAuth)).text();
  assert.ok(keyA.includes('BEGIN PUBLIC KEY') && keyB.includes('BEGIN PUBLIC KEY'));
  assert.notEqual(keyA, keyB);

  // --- unknown institute code 404s, doesn't leak into another institute's data
  assert.equal((await get('/i/does-not-exist/api/health')).status, 404);

  // --- institute A: sign in and receive a policy signed with A's key, not B's
  const authA = { authorization: 'Basic ' + Buffer.from(`${a.adminUser}:${a.adminPassword}`).toString('base64') };
  const authB = { authorization: 'Basic ' + Buffer.from(`${b.adminUser}:${b.adminPassword}`).toString('base64') };

  const startRes = await post(`/i/${a.slug}/api/session/start`, {
    examCode: 'DEMO101', studentId: 'S1', studentName: 'Asha', consent: true, device: { hostname: 'pc1' },
  });
  assert.equal(startRes.status, 200);
  const start = await startRes.json();
  const pubA = crypto.createPublicKey(keyA);
  const pubB = crypto.createPublicKey(keyB);
  assert.ok(crypto.verify(null, Buffer.from(start.policy), pubA, Buffer.from(start.signature, 'base64')), 'signed with institute A key');
  assert.ok(!crypto.verify(null, Buffer.from(start.policy), pubB, Buffer.from(start.signature, 'base64')), 'NOT valid under institute B key');

  // --- institute A's admin login does NOT work on institute B's dashboard, and vice versa
  assert.equal((await get(`/i/${a.slug}/api/admin/sessions`, authA)).status, 200);
  assert.equal((await get(`/i/${a.slug}/api/admin/sessions`, authB)).status, 401);
  assert.equal((await get(`/i/${b.slug}/api/admin/sessions`, authB)).status, 200);
  assert.equal((await get(`/i/${b.slug}/api/admin/sessions`, authA)).status, 401);

  // --- institute A's session/alerts are invisible from institute B's dashboard
  const sessionsOnA = await (await get(`/i/${a.slug}/api/admin/sessions`, authA)).json();
  const sessionsOnB = await (await get(`/i/${b.slug}/api/admin/sessions`, authB)).json();
  assert.equal(sessionsOnA.length, 1);
  assert.equal(sessionsOnB.length, 0);

  // --- password reset invalidates the old password
  const resetRes = await post(`/super/api/institutes/${a.slug}/reset-password`, {}, superAuth);
  const { adminPassword: newPw } = await resetRes.json();
  assert.notEqual(newPw, a.adminPassword);
  assert.equal((await get(`/i/${a.slug}/api/admin/sessions`, authA)).status, 401, 'old password now rejected');
  const authA2 = { authorization: 'Basic ' + Buffer.from(`${a.adminUser}:${newPw}`).toString('base64') };
  assert.equal((await get(`/i/${a.slug}/api/admin/sessions`, authA2)).status, 200, 'new password works');

  // --- disabling an institute blocks both the client API and the dashboard
  await post(`/super/api/institutes/${b.slug}/disable`, { disabled: true }, superAuth);
  assert.equal((await get(`/i/${b.slug}/api/admin/sessions`, authB)).status, 404);
  assert.equal((await post(`/i/${b.slug}/api/session/start`, { examCode: 'DEMO101', studentId: 'X', studentName: 'Y', consent: true })).status, 404);
  await post(`/super/api/institutes/${b.slug}/disable`, { disabled: false }, superAuth);
  assert.equal((await get(`/i/${b.slug}/api/admin/sessions`, authB)).status, 200, 're-enabled');

  // --- each institute auto-seeds its own demo exam config on first use
  const examsA = await (await get(`/i/${a.slug}/api/admin/exams`, authA2)).json();
  assert.ok(examsA.some((x) => x.code === 'DEMO101'));
});
