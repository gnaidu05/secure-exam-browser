'use strict';
// Screen capture + reliable alert delivery.
// Alerts are written to an on-disk outbox first, then sent; if the network is
// down they are retried with backoff (and survive an app restart).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { desktopCapturer, screen, net } = require('electron');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Grab every physical screen plus the exam view itself. Never throws. */
async function captureScreens(examView, { quality = 65, maxWidth = 1920 } = {}) {
  const shots = [];
  try {
    const displays = screen.getAllDisplays();
    let w = 0, h = 0;
    for (const d of displays) {
      w = Math.max(w, Math.round(d.size.width * d.scaleFactor));
      h = Math.max(h, Math.round(d.size.height * d.scaleFactor));
    }
    const scale = w > maxWidth ? maxWidth / w : 1;
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) },
    });
    sources.forEach((s, i) => {
      if (s.thumbnail.isEmpty()) return;
      const size = s.thumbnail.getSize();
      shots.push({ label: `${s.name || 'screen ' + (i + 1)} (${size.width}x${size.height})`, data: s.thumbnail.toJPEG(quality).toString('base64') });
    });
  } catch { /* screen capture can fail (permissions, Wayland); fall through to the window grab */ }

  try {
    if (examView && !examView.webContents.isDestroyed()) {
      const img = await examView.webContents.capturePage();
      if (!img.isEmpty()) shots.push({ label: 'exam window', data: img.toJPEG(quality).toString('base64') });
    }
  } catch { /* ignore */ }
  return shots;
}

class Reporter {
  constructor({ serverUrl, outboxDir }) {
    this.serverUrl = serverUrl;
    this.outbox = outboxDir;
    fs.mkdirSync(this.outbox, { recursive: true });
    this.busy = false;
    this.delay = 2000;
    this.retryTimer = null;
    this.stopped = false;
  }

  enqueue(token, alert) {
    const file = path.join(this.outbox, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.json`);
    fs.writeFileSync(file, JSON.stringify({ token, alert }));
    this.kick();
  }

  pending() {
    try { return fs.readdirSync(this.outbox).filter((f) => f.endsWith('.json')).length; } catch { return 0; }
  }

  kick() {
    if (this.busy || this.stopped) return;
    this.busy = true;
    this._run().catch(() => {}).finally(() => { this.busy = false; });
  }

  async _run() {
    for (;;) {
      const files = fs.readdirSync(this.outbox).filter((f) => f.endsWith('.json')).sort();
      if (!files.length) { this.delay = 2000; return; }
      const file = path.join(this.outbox, files[0]);
      let item;
      try { item = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { fs.rmSync(file, { force: true }); continue; }

      try {
        const res = await net.fetch(`${this.serverUrl}/api/alerts`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${item.token}` },
          body: JSON.stringify(item.alert),
          signal: AbortSignal.timeout(30000),
        });
        if (res.ok) { fs.rmSync(file, { force: true }); this.delay = 2000; continue; }
        if (res.status === 413 && item.alert.screenshots?.length) { // too big: keep the alert, drop the images
          item.alert.screenshots = [];
          item.alert.detail = (item.alert.detail || '') + ' [screenshots dropped: too large]';
          fs.writeFileSync(file, JSON.stringify(item));
          continue;
        }
        if (res.status >= 400 && res.status < 500) { fs.rmSync(file, { force: true }); continue; } // will never succeed
        throw new Error('HTTP ' + res.status);
      } catch {
        clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => this.kick(), this.delay);
        this.delay = Math.min(this.delay * 2, 30000);
        return;
      }
    }
  }

  /** Try to flush the outbox before quitting. */
  async drain(maxMs = 6000) {
    const end = Date.now() + maxMs;
    while (this.pending() > 0 && Date.now() < end) {
      this.kick();
      await sleep(250);
    }
  }

  stop() { this.stopped = true; clearTimeout(this.retryTimer); }
}

module.exports = { Reporter, captureScreens };
