'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const { app, BrowserWindow, WebContentsView, ipcMain, screen, clipboard, Menu, net, dialog } = require('electron');
const { createMatcher } = require('./whitelist');
const { evaluateKey } = require('./input-rules');
const { Reporter, captureScreens } = require('./reporter');
const { startMonitors } = require('./monitors');

// SEB_DEV=1 (unpackaged only) relaxes kiosk/always-on-top/devtools so you can develop without locking yourself in.
const DEV = !app.isPackaged && process.env.SEB_DEV === '1';
const BAR_H = 44;
const VERSION = app.getVersion();

// Chromium switches must be set before ready.
if (process.platform === 'linux') app.commandLine.appendSwitch('ozone-platform', 'x11'); // reliable screen capture (Xorg / XWayland)
app.commandLine.appendSwitch('disable-features', 'Translate,MediaRouter,AutofillServerCommunication,OptimizationHints');
app.commandLine.appendSwitch('disable-background-networking');

const SEVERITY = {
  BLOCKED_DOMAIN: 'medium', BLOCKED_PORT: 'medium', POPUP_BLOCKED: 'medium', DOWNLOAD_BLOCKED: 'medium',
  CLOSE_ATTEMPT: 'medium', WINDOWS_KEY: 'medium', CLIPBOARD_ATTEMPT: 'medium', BLOCKED_SUBRESOURCE: 'low',
  SHORTCUT_BLOCKED: 'low', FOCUS_LOST: 'high', MINIMIZED: 'high', FULLSCREEN_EXIT: 'high', PRINTSCREEN: 'high',
  DEVTOOLS_ATTEMPT: 'high', MULTI_MONITOR: 'high', BLOCKED_PROCESS: 'high', PERMISSION_DENIED: 'low',
  ENV_WARNING: 'low', FOCUS_RESTORED: 'low', PAGE_CRASH: 'medium',
};
const WARN_TEXT = {
  BLOCKED_DOMAIN: 'That site is not allowed.', BLOCKED_PORT: 'That address is not allowed.',
  POPUP_BLOCKED: 'New windows are not allowed.', DOWNLOAD_BLOCKED: 'Downloads are not allowed.',
  CLOSE_ATTEMPT: 'You cannot close the exam window.', WINDOWS_KEY: 'Do not use the Windows/Super key.',
  CLIPBOARD_ATTEMPT: 'Copy and paste are disabled.', SHORTCUT_BLOCKED: 'That shortcut is disabled.',
  FOCUS_LOST: 'Stay on the exam window.', MINIMIZED: 'Stay on the exam window.',
  FULLSCREEN_EXIT: 'The exam must stay fullscreen.', PRINTSCREEN: 'Screenshots are not allowed.',
  DEVTOOLS_ATTEMPT: 'Developer tools are disabled.', MULTI_MONITOR: 'Disconnect the extra display.',
  BLOCKED_PROCESS: 'Close prohibited programs.', PAGE_CRASH: 'The page crashed and was reloaded.',
};
// Types sent by the exam page's preload that we accept (anything else is ignored).
const PAGE_EVENT_TYPES = new Set(['CLIPBOARD_ATTEMPT', 'CONTEXT_MENU', 'DRAG_DROP']);
const LOG_ONLY = new Set(['CONTEXT_MENU', 'DRAG_DROP', 'BLOCKED_SUBRESOURCE', 'PERMISSION_DENIED']);

const state = {
  cfg: null,
  win: null,
  view: null,
  session: null,          // { id, token, examCode, studentId, studentName }
  policy: null,
  matcher: null,
  reporter: null,
  log: [],
  lastRaised: new Map(),
  seenBlockedHosts: new Set(),
  timers: [],
  stopMonitors: null,
  skewMs: 0,
  endsAt: null,
  online: true,
  allowQuit: false,
  ending: false,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const truncate = (s, n = 300) => (String(s).length > n ? String(s).slice(0, n) + '…' : String(s));
const serverNow = () => Date.now() + state.skewMs;
const settings = () => state.policy?.settings || {
  allowClipboard: false, focusGraceMs: 800, alertCooldownMs: 5000, processCheckSeconds: 20, allowMultipleDisplays: false,
};
const sendUi = (msg) => { if (state.win && !state.win.isDestroyed()) state.win.webContents.send('ui', msg); };

function loadConfig() {
  // In an installed build the config is fixed inside the app package; SEB_CONFIG only works in unpackaged dev mode.
  const dir = DEV && process.env.SEB_CONFIG ? path.dirname(process.env.SEB_CONFIG) : path.join(__dirname, '..', 'config');

  const configPath = path.join(dir, 'config.json');
  const keyPath = path.join(dir, 'public-key.pem');
  if (!fs.existsSync(configPath) || !fs.existsSync(keyPath)) {
    throw new Error(
      `This copy of the browser was built without its server settings (missing ${path.basename(fs.existsSync(configPath) ? keyPath : configPath)}).\n\n` +
      'Whoever built this installer needs to put your exam server\'s address in client/config/config.json ' +
      'and its signing key in client/config/public-key.pem, then rebuild. See the project README, ' +
      '"Build the installers".'
    );
  }
  const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const publicKey = crypto.createPublicKey(fs.readFileSync(keyPath));
  const u = new URL(cfg.serverUrl);
  const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !isLocal && !cfg.allowInsecureServer) {
    throw new Error('serverUrl must use https:// (or set "allowInsecureServer": true for a trusted private network).');
  }
  return { serverUrl: cfg.serverUrl.replace(/\/+$/, ''), publicKey };
}

function deviceInfo() {
  const ips = [];
  const macs = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const n of list || []) {
      if (n.internal) continue;
      if ((n.family === 'IPv4' || n.family === 4) && n.address) ips.push(n.address);
      if (n.mac && n.mac !== '00:00:00:00:00:00') macs.push(n.mac);
    }
  }
  let username = '';
  try { username = os.userInfo().username; } catch { /* ignore */ }
  return {
    hostname: os.hostname(), username, platform: process.platform, arch: process.arch, osRelease: os.release(),
    appVersion: VERSION, sessionType: process.env.XDG_SESSION_TYPE || '', ips, macs: [...new Set(macs)],
    displays: screen.getAllDisplays().length,
  };
}

function currentUrl() {
  try { return state.view && !state.view.webContents.isDestroyed() ? state.view.webContents.getURL() : ''; } catch { return ''; }
}

function logEvent(type, detail = '') {
  state.log.push({ t: new Date().toISOString(), type, detail: truncate(detail, 300) });
  if (state.log.length > 200) state.log.splice(0, state.log.length - 200);
}

// ---------------------------------------------------------------------------
// Violation pipeline: log -> (cooldown) -> warn student -> screenshot -> outbox -> server
// ---------------------------------------------------------------------------
async function raise(type, detail = '', opts = {}) {
  logEvent(type, detail);
  if (!state.session || state.ending || LOG_ONLY.has(type)) return;

  const s = settings();
  const key = type + '|' + (opts.key || '');
  const cooldown = opts.cooldownMs ?? s.alertCooldownMs ?? 5000;
  const now = Date.now();
  const last = state.lastRaised.get(key);
  if (last && now - last < cooldown) return;
  state.lastRaised.set(key, now);

  if (s.showWarnings && WARN_TEXT[type] && opts.silent !== true) sendUi({ kind: 'warn', text: WARN_TEXT[type], reported: true });

  const severity = opts.severity || SEVERITY[type] || 'medium';
  const screenshots = opts.screenshot === false
    ? []
    : await captureScreens(state.view, { quality: s.screenshotQuality, maxWidth: s.screenshotMaxWidth });

  if (!state.session) return; // session ended while capturing
  state.reporter.enqueue(state.session.token, {
    sessionId: state.session.id,
    type,
    severity,
    detail: truncate(detail, 1500),
    ts: new Date().toISOString(),
    url: currentUrl(),
    context: {
      ...deviceInfo(),
      focused: !!state.win && !state.win.isDestroyed() && state.win.isFocused(),
      studentId: state.session.studentId,
      examCode: state.session.examCode,
      displayDetails: screen.getAllDisplays().map((d) => ({ id: d.id, w: d.size.width, h: d.size.height, scale: d.scaleFactor, primary: d.id === screen.getPrimaryDisplay().id })),
      uptimeSec: Math.round(process.uptime()),
    },
    log: state.log.slice(-40),
    screenshots,
  });
}

// ---------------------------------------------------------------------------
// Input guard (keyboard)
// ---------------------------------------------------------------------------
function attachInputGuard(wc) {
  wc.on('before-input-event', (event, input) => {
    if (!state.session) return;
    const hit = evaluateKey(input, { allowClipboard: settings().allowClipboard, platform: process.platform });
    if (!hit) return;
    event.preventDefault();
    if (hit.type === 'CLIPBOARD_ATTEMPT' || hit.type === 'PRINTSCREEN') {
      try { clipboard.clear(); } catch { /* ignore */ }
    }
    raise(hit.type, `Key combination: ${hit.label}`, { key: hit.label });
  });
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------
function createMainWindow() {
  const win = new BrowserWindow({
    show: false,
    frame: DEV,
    fullscreen: !DEV,
    kiosk: !DEV,
    alwaysOnTop: !DEV,
    autoHideMenuBar: true,
    backgroundColor: '#0b1020',
    width: 1200,
    height: 800,
    title: 'Secure Exam Browser',
    webPreferences: {
      preload: path.join(__dirname, 'preload-shell.js'),
      partition: 'shell',
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      devTools: DEV,
      spellcheck: false,
    },
  });
  state.win = win;
  if (!DEV) {
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setContentProtection(true); // other apps (screen share, recorders) capture nothing of this window
  }
  win.setMenuBarVisibility(false);

  // The shell only ever shows local files: block every network request from it.
  const shellSession = win.webContents.session;
  shellSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, cb) => {
    cb({ cancel: !(details.url.startsWith('file://') || details.url.startsWith('devtools://')) });
  });
  shellSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  shellSession.setPermissionCheckHandler(() => false);

  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  attachInputGuard(win.webContents);

  win.on('close', (e) => {
    if (state.session && !state.allowQuit) {
      e.preventDefault();
      raise('CLOSE_ATTEMPT', 'Window close requested (Alt+F4 or system menu).');
    }
  });
  win.on('resize', layoutView);
  win.on('enter-full-screen', layoutView);
  win.on('leave-full-screen', layoutView);

  win.once('ready-to-show', () => { win.show(); win.focus(); });
  win.loadFile(path.join(__dirname, 'shell', 'index.html'));
}

function layoutView() {
  if (!state.view || !state.win || state.win.isDestroyed()) return;
  const [w, h] = state.win.getContentSize();
  state.view.setBounds({ x: 0, y: BAR_H, width: w, height: Math.max(0, h - BAR_H) });
}

function createExamView(policy) {
  const s = policy.settings;
  const view = new WebContentsView({
    webPreferences: {
      partition: `exam-${policy.sessionId}`, // no "persist:" prefix => in-memory, wiped when the session ends
      preload: path.join(__dirname, 'preload-exam.js'),
      additionalArguments: [`--seb-allow-clipboard=${s.allowClipboard ? 1 : 0}`],
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      devTools: DEV,
      spellcheck: false,
      navigateOnDragDrop: false,
    },
  });
  state.view = view;
  state.win.contentView.addChildView(view);
  layoutView();

  const wc = view.webContents;
  const ses = wc.session;
  wc.setUserAgent(`${wc.getUserAgent()} SecureExamBrowser/${VERSION}`);
  ses.setSpellCheckerEnabled(false);

  // ---- The whitelist: every request, every resource type, redirects included ----
  ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, cb) => {
    const isFrame = details.resourceType === 'mainFrame' || details.resourceType === 'subFrame';
    const verdict = state.matcher.check(details.url, { isFrame });
    if (verdict.allowed) return cb({});
    cb({ cancel: true });

    const type = verdict.category === 'port' ? 'BLOCKED_PORT' : 'BLOCKED_DOMAIN';
    const detail = `${verdict.reason}: ${truncate(details.url, 200)}`;
    if (isFrame || s.strictSubresources) {
      raise(type, detail, { key: `${verdict.host || ''}:${verdict.port || ''}` });
    } else {
      const k = `${verdict.host || verdict.category}:${verdict.port || ''}`;
      if (!state.seenBlockedHosts.has(k)) { state.seenBlockedHosts.add(k); logEvent('BLOCKED_SUBRESOURCE', `${details.resourceType} ${detail}`); }
    }
  });

  // Cancel top-level / iframe navigations (and redirects) BEFORE they commit, so a stray click on an
  // external link leaves the student's current exam page untouched instead of replacing it with an
  // error page. The webRequest filter above stays as the hard backstop for everything else.
  const guardNavigation = (details, extraUrl) => {
    const url = details?.url ?? extraUrl;
    if (!url) return;
    const v = state.matcher.check(url, { isFrame: true });
    if (v.allowed) return;
    details.preventDefault();
    raise(v.category === 'port' ? 'BLOCKED_PORT' : 'BLOCKED_DOMAIN', `${v.reason}: ${truncate(url, 200)}`, { key: `${v.host || ''}:${v.port || ''}` });
  };
  wc.on('will-frame-navigate', guardNavigation);
  wc.on('will-redirect', guardNavigation);

  ses.setPermissionRequestHandler((_wc, permission, cb) => {
    const ok = (s.allowedPermissions || []).includes(permission);
    if (!ok) logEvent('PERMISSION_DENIED', permission);
    cb(ok);
  });
  ses.setPermissionCheckHandler((_wc, permission) => (s.allowedPermissions || []).includes(permission));
  ses.setDevicePermissionHandler(() => false);

  ses.on('will-download', (event, item) => {
    event.preventDefault();
    raise('DOWNLOAD_BLOCKED', `Download attempt: ${truncate(item.getFilename?.() || '', 100)} from ${truncate(item.getURL?.() || '', 200)}`);
  });

  wc.setWindowOpenHandler(({ url }) => {
    const v = state.matcher.check(url, { isFrame: true });
    if (v.allowed && s.openAllowedPopupsInPlace) {
      setImmediate(() => { if (!wc.isDestroyed()) wc.loadURL(url); });
      return { action: 'deny' };
    }
    raise('POPUP_BLOCKED', `New window blocked: ${truncate(url, 200)}`, { key: url });
    return { action: 'deny' };
  });

  wc.on('devtools-opened', () => { wc.closeDevTools(); raise('DEVTOOLS_ATTEMPT', 'DevTools opened'); });
  wc.on('will-attach-webview', (e) => e.preventDefault());
  wc.on('render-process-gone', (_e, d) => {
    raise('PAGE_CRASH', `Renderer gone: ${d.reason}`, { screenshot: false });
    setTimeout(() => { if (!wc.isDestroyed() && state.policy) wc.loadURL(state.policy.startUrl); }, 1000);
  });
  wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (isMainFrame && code !== -3 /* ERR_ABORTED */) {
      sendUi({ kind: 'warn', text: code === -20 ? 'That page is blocked.' : `Page failed to load (${desc}).` });
    }
  });
  attachInputGuard(wc);

  wc.loadURL(policy.startUrl);
  wc.focus();
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------
async function startSession(data) {
  if (state.session) return { ok: false, error: 'A session is already running.' };
  const examCode = String(data?.examCode || '').trim();
  const studentId = String(data?.studentId || '').trim();
  const studentName = String(data?.studentName || '').trim();
  if (!examCode || !studentId || !studentName) return { ok: false, error: 'Please fill in every field.' };
  if (data?.consent !== true) return { ok: false, error: 'You must accept the monitoring notice.' };

  let resp;
  try {
    const res = await net.fetch(`${state.cfg.serverUrl}/api/session/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ examCode, studentId, studentName, consent: true, device: deviceInfo() }),
      signal: AbortSignal.timeout(15000),
    });
    resp = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: resp.message || `Server refused the request (${res.status}).` };
  } catch {
    return { ok: false, error: 'Cannot reach the exam server. Check the network connection and try again.' };
  }

  // The policy must be signed by the admin server's key; otherwise refuse to run.
  let policy;
  try {
    const valid = crypto.verify(null, Buffer.from(resp.policy, 'utf8'), state.cfg.publicKey, Buffer.from(resp.signature, 'base64'));
    if (!valid) throw new Error('bad signature');
    policy = JSON.parse(resp.policy);
    if (policy.sessionId !== resp.sessionId) throw new Error('session mismatch');
  } catch {
    return { ok: false, error: 'Security check failed: the exam policy is not signed by your institution\'s server.' };
  }

  const matcher = createMatcher(policy.allow);
  if (!matcher.ruleCount) return { ok: false, error: 'The exam has no whitelisted sites configured. Contact your invigilator.' };
  if (!matcher.check(policy.startUrl, { isFrame: true }).allowed) {
    return { ok: false, error: 'The exam start page is not on its own whitelist. Contact your invigilator.' };
  }

  state.skewMs = (Number(resp.serverTime) || Date.now()) - Date.now();
  state.policy = policy;
  state.matcher = matcher;
  state.endsAt = policy.endsAt || null;
  state.session = { id: resp.sessionId, token: resp.token, examCode: policy.examCode, studentId, studentName };
  state.log = [];
  state.lastRaised.clear();
  state.reporter = new Reporter({ serverUrl: state.cfg.serverUrl, outboxDir: path.join(app.getPath('userData'), 'outbox') });
  state.reporter.kick(); // deliver anything left from a previous run

  createExamView(policy);
  logEvent('SESSION_START', `${studentId} / ${examCode}`);

  // Environment notes go to the admin as a low-severity alert.
  if (process.platform === 'linux' && process.env.XDG_SESSION_TYPE === 'wayland') {
    raise('ENV_WARNING', 'Wayland session: full-screen capture may be blank. Use "Ubuntu on Xorg" for reliable evidence.', { screenshot: false });
  }

  state.stopMonitors = startMonitors({
    win: state.win, dev: DEV,
    isActive: () => !!state.session && !state.ending,
    settings, blockedProcesses: () => state.policy?.blockedProcesses,
    raise: (t, d, o) => raise(t, d, o), log: logEvent,
  });
  state.timers.push(setInterval(heartbeat, Math.max(5, settings().heartbeatSeconds || 15) * 1000));
  state.timers.push(setInterval(tick, 1000));
  heartbeat();

  return { ok: true, title: policy.title, endsAt: state.endsAt, skewMs: state.skewMs, studentName };
}

async function heartbeat() {
  if (!state.session || state.ending) return;
  try {
    const res = await net.fetch(`${state.cfg.serverUrl}/api/session/${state.session.id}/heartbeat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${state.session.token}` },
      body: JSON.stringify({ state: { focused: !!state.win?.isFocused(), url: currentUrl(), displays: screen.getAllDisplays().length } }),
      signal: AbortSignal.timeout(8000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error('HTTP ' + res.status);
    if (!state.online) { state.online = true; sendUi({ kind: 'status', online: true }); }
    if (body.terminate || body.ended) endSession(body.reason || 'Your session has been ended by the invigilator.', 'terminated');
  } catch {
    if (state.online) { state.online = false; sendUi({ kind: 'status', online: false }); logEvent('SERVER_UNREACHABLE', 'heartbeat failed'); }
  }
}

function tick() {
  if (state.endsAt && serverNow() >= state.endsAt) endSession('Time is up. Your exam has ended.', 'time_up');
}

async function endSession(message, reason) {
  if (state.ending) return;
  state.ending = true;
  logEvent('SESSION_END', reason);
  state.stopMonitors?.();
  state.timers.forEach(clearInterval);
  state.timers = [];
  if (state.view) {
    try { state.view.setVisible(false); } catch { /* ignore */ }
    try { state.win.contentView.removeChildView(state.view); state.view.webContents.close(); } catch { /* ignore */ }
    state.view = null;
  }
  sendUi({ kind: 'ended', text: message });
  await state.reporter?.drain(6000);
  state.reporter?.stop();
  setTimeout(() => { state.allowQuit = true; app.quit(); }, message ? 2500 : 0);
}

// ---------------------------------------------------------------------------
// IPC (shell UI -> main). Only the shell window may call these.
// ---------------------------------------------------------------------------
const fromShell = (e) => state.win && !state.win.isDestroyed() && e.sender === state.win.webContents;
const guard = (fn) => (e, ...args) => { if (!fromShell(e)) throw new Error('forbidden'); return fn(e, ...args); };

ipcMain.handle('app:info', guard(() => ({
  version: VERSION, platform: process.platform, dev: DEV,
  wayland: process.platform === 'linux' && process.env.XDG_SESSION_TYPE === 'wayland',
  displays: screen.getAllDisplays().length,
})));
ipcMain.handle('session:start', guard((_e, data) => startSession(data)));
ipcMain.handle('app:quit', guard(() => { if (!state.session) { state.allowQuit = true; app.quit(); } }));

ipcMain.handle('session:promptExit', guard(() => {
  if (state.view) state.view.setVisible(false);
  return true;
}));
ipcMain.handle('session:cancelExit', guard(() => {
  if (state.view) { state.view.setVisible(true); layoutView(); state.view.webContents.focus(); }
  return true;
}));
ipcMain.handle('session:exit', guard(async (_e, code) => {
  if (!state.session) return { ok: false, error: 'No session.' };
  try {
    const res = await net.fetch(`${state.cfg.serverUrl}/api/session/${state.session.id}/exit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${state.session.token}` },
      body: JSON.stringify({ code: String(code || '').slice(0, 100) }),
      signal: AbortSignal.timeout(10000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: body.message || 'Incorrect exit code.' };
  } catch {
    return { ok: false, error: 'Cannot reach the server. Ask your invigilator to end the session.' };
  }
  endSession('Exam submitted. You may now leave.', 'completed');
  return { ok: true };
}));

ipcMain.handle('nav', guard((_e, cmd) => {
  const wc = state.view?.webContents;
  if (!wc || wc.isDestroyed()) return;
  const h = wc.navigationHistory;
  if (cmd === 'back') { if (h ? h.canGoBack() : wc.canGoBack()) (h ? h.goBack() : wc.goBack()); }
  else if (cmd === 'forward') { if (h ? h.canGoForward() : wc.canGoForward()) (h ? h.goForward() : wc.goForward()); }
  else if (cmd === 'reload') wc.reload();
  else if (cmd === 'home' && state.policy) wc.loadURL(state.policy.startUrl);
}));

// Events reported by the exam page's preload (copy/paste/context-menu attempts).
ipcMain.on('exam:event', (e, msg) => {
  if (!state.view || e.sender !== state.view.webContents) return;
  const type = String(msg?.type || '');
  if (!PAGE_EVENT_TYPES.has(type)) return;
  raise(type, `In-page ${truncate(msg?.detail || '', 60)}`, { key: type });
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
if (!app.requestSingleInstanceLock()) app.quit();

app.on('second-instance', () => { if (state.win) { state.win.show(); state.win.focus(); } });

// Belt and braces: no webview tags or extra windows anywhere.
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-attach-webview', (ev) => ev.preventDefault());
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  try {
    state.cfg = loadConfig();
  } catch (err) {
    dialog.showErrorBox('Secure Exam Browser', `Configuration error: ${err.message}\n\nContact your administrator.`);
    app.quit();
    return;
  }
  createMainWindow();
});

app.on('window-all-closed', () => app.quit());
