'use strict';
// End-to-end smoke test: real Electron app + real admin server + local "exam site".
// Run headless with:  xvfb-run -a -s "-screen 0 1280x800x24" node scripts/smoke.js
// (needs `npm install` in both server/ and client/). Drives the app over the Chrome DevTools
// protocol (dev mode only) and checks what arrives at the admin server.

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createServer } = require('../../server/server');

const CDP_PORT = 9333;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, extra = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  -- ' + extra : ''}`); };

async function waitFor(fn, ms, what) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timeout waiting for ' + what);
    await sleep(250);
  }
}

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
  };
  const opened = new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  return {
    async send(method, params = {}) {
      await opened;
      return new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
    },
    async eval(expression, userGesture = true) {
      const r = await this.send('Runtime.evaluate', { expression, userGesture, awaitPromise: true, returnByValue: true });
      return r.result?.result?.value;
    },
    close: () => ws.close(),
  };
}

const targets = async () => (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'seb-smoke-'));

  // --- local exam site (two ports: 1 whitelisted, 1 not) ---------------------------------
  let examPort, otherPort;
  const examSite = http.createServer((req, res) => {
    if (req.url === '/file.bin') { res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename=x.bin' }); return res.end('xx'); }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><title>Smoke exam</title><h1>Question 1</h1><input id=q>
      <a id=dl href="/file.bin" download>download</a>
      <img src="http://localhost:${examPort}/tracker.png">`);
  });
  const otherSite = http.createServer((req, res) => res.end('other port'));
  await new Promise((r) => examSite.listen(0, '127.0.0.1', r));
  await new Promise((r) => otherSite.listen(0, '127.0.0.1', r));
  examPort = examSite.address().port; otherPort = otherSite.address().port;

  // --- admin server --------------------------------------------------------------------
  const examsFile = path.join(tmp, 'exams.json');
  fs.writeFileSync(examsFile, JSON.stringify({
    SMOKE: {
      title: 'Smoke Test Exam', startUrl: `http://127.0.0.1:${examPort}/`,
      allow: [{ host: '127.0.0.1', ports: [examPort], schemes: ['http'] }],
      durationMinutes: 30, exitCode: 'OK',
      settings: { heartbeatSeconds: 5, focusGraceMs: 60000, alertCooldownMs: 300, processCheckSeconds: 600 },
      blockedProcesses: [],
    },
  }));
  const srv = createServer({ port: 0, dataDir: path.join(tmp, 'data'), examsFile, adminPassword: 'x' });
  const srvPort = await srv.ready;

  // --- client config for dev mode ---------------------------------------------------------
  const cfgDir = path.join(tmp, 'cfg');
  fs.mkdirSync(cfgDir);
  fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({ serverUrl: `http://127.0.0.1:${srvPort}` }));
  fs.writeFileSync(path.join(cfgDir, 'public-key.pem'), srv.keys.publicPem);

  const appDir = path.join(__dirname, '..');
  const electronBin = require('electron');
  const app = spawn(electronBin, [appDir, '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${path.join(tmp, 'ud')}`], {
    env: { ...process.env, SEB_DEV: '1', SEB_CONFIG: path.join(cfgDir, 'config.json') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let appLog = '';
  app.stdout.on('data', (d) => { appLog += d; });
  app.stderr.on('data', (d) => { appLog += d; });
  let exited = false;
  app.on('exit', () => { exited = true; });

  const cleanup = async (code) => {
    if (!exited) app.kill('SIGKILL');
    examSite.close(); otherSite.close();
    await srv.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    process.exit(code);
  };

  try {
    // --- 1. shell page loads ----------------------------------------------------------------
    const shell = await waitFor(async () => (await targets().catch(() => [])).find((t) => t.url.includes('shell/index.html')), 30000, 'shell page');
    const sh = cdp(shell.webSocketDebuggerUrl);
    await waitFor(() => sh.eval('!!window.seb'), 10000, 'preload bridge');
    check('shell page + preload bridge load', true);

    // --- 2. login errors + success -------------------------------------------------------
    const fill = (code) => sh.eval(`(async () => {
      document.getElementById('examCode').value = ${JSON.stringify(code)};
      document.getElementById('studentId').value = 'S100';
      document.getElementById('studentName').value = 'Smoke Tester';
      document.getElementById('consent').checked = true;
      document.getElementById('loginForm').requestSubmit();
      await new Promise(r => setTimeout(r, 1500));
      return document.getElementById('error').textContent;
    })()`);
    const err = await fill('WRONG');
    check('unknown exam code is rejected with a message', /Unknown exam/i.test(err), err);
    await fill('SMOKE');

    const session = await waitFor(() => [...srv.store.sessions.values()][0], 15000, 'session on server');
    check('session created on admin server', session.studentId === 'S100' && session.examCode === 'SMOKE');
    check('device details captured', !!session.device?.hostname && Array.isArray(session.device?.ips));

    // --- 3. exam page loads (whitelisted) ---------------------------------------------------
    const examT = await waitFor(async () => (await targets()).find((t) => t.url.startsWith(`http://127.0.0.1:${examPort}`)), 20000, 'exam page');
    check('whitelisted exam page loads in the exam view', true, examT.url);
    const page = cdp(examT.webSocketDebuggerUrl);
    await waitFor(() => page.eval('document.readyState === "complete"'), 10000, 'exam page ready');
    check('user agent tagged', /SecureExamBrowser\//.test(await page.eval('navigator.userAgent')));

    const alerts = () => srv.store.alerts.filter((a) => a.sessionId === session.id);
    const has = (type) => alerts().some((a) => a.type === type);
    const wait = (type, ms = 20000) => waitFor(() => has(type), ms, type + ' alert').then(() => true, () => false);

    // --- 4. violations --------------------------------------------------------------------
    await page.eval(`location.href = 'http://localhost:${examPort}/'`);
    check('blocked DOMAIN navigation -> alert', await wait('BLOCKED_DOMAIN'));
    await sleep(500);

    await page.eval(`location.href = 'http://127.0.0.1:${otherPort}/'`);
    check('blocked PORT navigation -> alert', await wait('BLOCKED_PORT'));
    await sleep(500);

    const stillThere = (await targets()).some((t) => t.url.startsWith(`http://127.0.0.1:${examPort}`));
    check('exam page stays on the whitelisted URL after blocked navigation', stillThere);

    await page.eval(`window.open('https://evil.example/', '_blank')`);
    check('popup to a non-whitelisted site -> alert', await wait('POPUP_BLOCKED'));

    await page.eval(`document.getElementById('dl').click()`);
    check('download attempt -> alert', await wait('DOWNLOAD_BLOCKED'));

    await page.eval(`document.getElementById('q').focus(); document.getElementById('q').value='abc'; document.getElementById('q').select(); document.execCommand('copy')`);
    check('copy inside the page -> alert', await wait('CLIPBOARD_ATTEMPT'));

    // Real X11 key events (CDP key injection bypasses Electron's before-input-event, so use XTEST).
    const xkey = (combo) => new Promise((r) => spawn('python3', [path.join(__dirname, 'xkey.py'), combo], { stdio: 'ignore' }).on('exit', r));
    await xkey('F12');
    check('F12 key (real key event) -> DEVTOOLS_ATTEMPT alert', await wait('DEVTOOLS_ATTEMPT', 8000));
    await xkey('ctrl+shift+i');
    await xkey('alt+Tab');
    check('Alt+Tab (real key event) -> SHORTCUT_BLOCKED alert', await wait('SHORTCUT_BLOCKED', 8000));
    await sleep(400);
    const clipBefore = alerts().filter((a) => a.type === 'CLIPBOARD_ATTEMPT').length;
    await xkey('ctrl+c');
    check('Ctrl+C (real key event) -> a NEW CLIPBOARD_ATTEMPT alert',
      await waitFor(() => alerts().filter((a) => a.type === 'CLIPBOARD_ATTEMPT').length > clipBefore, 8000, 'ctrl+c alert').then(() => true, () => false));

    check('blocked image/script subresource does NOT raise an alert', !alerts().some((a) => /tracker\.png/.test(a.detail)));

    // --- 5. evidence quality ----------------------------------------------------------------
    const dom = alerts().find((a) => a.type === 'BLOCKED_DOMAIN');
    check('alert carries screenshots', dom?.shots?.length > 0, `${dom?.shots?.length} shot(s): ${dom?.shots?.map((s) => s.label).join(' | ')}`);
    const files = (dom?.shots || []).map((s) => path.join(srv.store.shotDir, s.file));
    check('screenshot files are real images on disk', files.length > 0 && files.every((f) => fs.statSync(f).size > 500));
    check('alert carries session context + event log', dom?.context?.hostname && dom?.context?.studentId === 'S100' && dom?.log?.length > 0);
    console.log('   alert types received:', [...new Set(alerts().map((a) => a.type))].join(', '));

    // --- 6. heartbeat + remote terminate ------------------------------------------------------
    await waitFor(() => srv.store.sessions.get(session.id).lastState, 15000, 'heartbeat');
    check('heartbeat reaches the server', true);
    srv.store.sessions.get(session.id).terminate = { reason: 'Smoke test over' };
    await waitFor(() => exited, 30000, 'app to quit after admin terminate').then(
      () => check('admin "end session" closes the browser', true),
      () => check('admin "end session" closes the browser', false),
    );
  } catch (e) {
    check('smoke run completed without exception', false, e.message);
    console.log('--- app log (tail) ---\n' + appLog.split('\n').slice(-25).join('\n'));
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  await cleanup(failed ? 1 : 0);
})();
