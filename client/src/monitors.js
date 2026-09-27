'use strict';
// Background watchers: window focus / fullscreen, extra displays, banned processes, clipboard.
//
// ctx = {
//   win, dev, isActive(), settings(), blockedProcesses(),
//   raise(type, detail, opts), log(type, detail)
// }

const { screen, clipboard } = require('electron');
const { execFile } = require('child_process');

function listProcesses() {
  return new Promise((resolve) => {
    const done = (err, out) => {
      if (err || !out) return resolve([]);
      const names = [];
      if (process.platform === 'win32') {
        for (const line of out.split(/\r?\n/)) {
          const m = /^"([^"]+)"/.exec(line);
          if (m) names.push(m[1]);
        }
      } else {
        for (const line of out.split('\n')) if (line.trim()) names.push(line.trim());
      }
      resolve(names.map((n) => n.split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, '')));
    };
    if (process.platform === 'win32') execFile('tasklist', ['/FO', 'CSV', '/NH'], { timeout: 8000, windowsHide: true, maxBuffer: 8e6 }, done);
    else execFile('ps', ['-eo', 'comm='], { timeout: 8000, maxBuffer: 8e6 }, done);
  });
}

function startMonitors(ctx) {
  const { win } = ctx;
  const timers = [];

  // ---- focus + fullscreen + displays (250 ms tick) -------------------------
  let lostAt = null;
  let alerted = false;
  timers.push(setInterval(() => {
    if (!ctx.isActive() || win.isDestroyed()) return;
    const s = ctx.settings();
    const now = Date.now();

    const focusOk = win.isFocused() && !win.isMinimized() && win.isVisible();
    if (!focusOk) {
      if (lostAt === null) {
        lostAt = now; alerted = false;
        ctx.log('FOCUS_LOST_START', win.isMinimized() ? 'window minimized' : 'another window took focus');
      } else if (!alerted && now - lostAt >= s.focusGraceMs) {
        alerted = true;
        ctx.raise(win.isMinimized() ? 'MINIMIZED' : 'FOCUS_LOST', 'Exam window lost focus (Alt+Tab, another app, or minimize).');
      }
      if (!ctx.dev) { // fight to get the foreground back
        try { if (win.isMinimized()) win.restore(); win.show(); win.focus(); win.moveTop(); } catch { /* ignore */ }
      }
    } else if (lostAt !== null) {
      const secs = ((now - lostAt) / 1000).toFixed(1);
      ctx.log('FOCUS_RESTORED', `after ${secs}s`);
      if (alerted) ctx.raise('FOCUS_RESTORED', `Focus returned after ${secs}s away.`, { screenshot: false, severity: 'low' });
      lostAt = null; alerted = false;
    }

    if (!ctx.dev && !(win.isKiosk() || win.isFullScreen())) {
      ctx.raise('FULLSCREEN_EXIT', 'Exam window left fullscreen.');
      try { win.setKiosk(true); win.setFullScreen(true); } catch { /* ignore */ }
    }

    const n = screen.getAllDisplays().length;
    if (n > 1 && !s.allowMultipleDisplays) {
      ctx.raise('MULTI_MONITOR', `${n} displays connected.`, { cooldownMs: 5 * 60000 });
    }
  }, 250));

  // ---- banned processes ------------------------------------------------------
  let procTimer = null;
  const scheduleProc = () => {
    const secs = Math.max(5, ctx.settings().processCheckSeconds || 20);
    procTimer = setTimeout(async () => {
      if (ctx.isActive()) {
        const banned = new Set((ctx.blockedProcesses() || []).map((p) => String(p).toLowerCase()));
        if (banned.size) {
          const running = await listProcesses();
          for (const name of new Set(running)) {
            if (banned.has(name)) ctx.raise('BLOCKED_PROCESS', `Prohibited program running: ${name}`, { key: name, cooldownMs: 5 * 60000 });
          }
        }
      }
      scheduleProc();
    }, secs * 1000);
  };
  scheduleProc();

  // ---- clipboard scrub ---------------------------------------------------------
  timers.push(setInterval(() => {
    if (!ctx.isActive() || ctx.settings().allowClipboard) return;
    try { clipboard.clear(); } catch { /* ignore */ }
  }, 1500));

  return () => { timers.forEach(clearInterval); clearTimeout(procTimer); };
}

module.exports = { startMonitors, listProcesses };
