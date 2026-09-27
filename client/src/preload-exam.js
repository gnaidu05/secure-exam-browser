'use strict';
// Runs inside the exam page (sandboxed, isolated world). It exposes nothing to the page;
// it only blocks in-page clipboard/context-menu/drag-drop and tells the main process.
const { ipcRenderer } = require('electron');

const allowClipboard = process.argv.includes('--seb-allow-clipboard=1');
const report = (type, detail) => { try { ipcRenderer.send('exam:event', { type, detail }); } catch { /* ignore */ } };

if (!allowClipboard) {
  for (const name of ['copy', 'cut', 'paste']) {
    window.addEventListener(name, (e) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      report('CLIPBOARD_ATTEMPT', name);
    }, true);
  }
}

window.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  report('CONTEXT_MENU', 'right-click');
}, true);

for (const name of ['dragstart', 'drop']) {
  window.addEventListener(name, (e) => {
    e.preventDefault();
    report('DRAG_DROP', name);
  }, true);
}
