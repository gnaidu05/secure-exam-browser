'use strict';
// Classifies keyboard input from Electron's before-input-event.
// Returns null (let it through) or { type, label } (block it and report).
// Pure logic, unit-tested.

const MODIFIER_KEYS = new Set(['Control', 'Alt', 'Shift', 'Meta']);

function label(input) {
  const parts = [];
  if (input.control) parts.push('Ctrl');
  if (input.alt) parts.push('Alt');
  if (input.shift) parts.push('Shift');
  if (input.meta && input.key !== 'Meta') parts.push('Meta');
  const key = String(input.key || '');
  if (!MODIFIER_KEYS.has(key)) parts.push(key.length === 1 ? key.toUpperCase() : key);
  else if (!parts.length) parts.push(key === 'Meta' ? 'Windows/Super key' : key);
  return parts.join('+');
}

// Ctrl/Cmd + <letter> combinations that open UI or leave the page.
const BLOCKED_MOD_LETTERS = ['u', 's', 'p', 'o', 'n', 't', 'w', 'd', 'h', 'j', 'l', 'q', 'm'];

function evaluateKey(input, opts = {}) {
  if (!input || (input.type !== 'keyDown' && input.type !== 'keyUp')) return null;
  const platform = opts.platform || process.platform;
  const allowClipboard = !!opts.allowClipboard;

  const key = String(input.key || '');
  const k = key.toLowerCase();
  const code = String(input.code || '');
  const down = input.type === 'keyDown';
  const mod = !!(input.control || input.meta);
  // Match on the produced character OR the physical key, so it works on non-QWERTY layouts.
  const is = (letter) => k === letter || code === 'Key' + letter.toUpperCase();
  const hit = (type) => ({ type, label: label(input) });

  // On Windows the OS only delivers key-UP for PrintScreen, so react to both.
  if (key === 'PrintScreen' || code === 'PrintScreen') return hit('PRINTSCREEN');
  if (!down) return null;

  if (key === 'F12') return hit('DEVTOOLS_ATTEMPT');
  if (mod && (input.shift || input.alt) && (is('i') || is('j') || is('c'))) return hit('DEVTOOLS_ATTEMPT');

  if (key === 'F11') return hit('SHORTCUT_BLOCKED');
  if (input.alt && (key === 'F4' || key === 'Tab' || key === 'Escape')) return hit('SHORTCUT_BLOCKED');
  if (key === 'Meta' && platform !== 'darwin') return hit('WINDOWS_KEY');

  if (!allowClipboard) {
    if (mod && (is('c') || is('x') || is('v') || key === 'Insert')) return hit('CLIPBOARD_ATTEMPT');
    if (input.shift && (key === 'Insert' || key === 'Delete')) return hit('CLIPBOARD_ATTEMPT');
  }

  if (mod && BLOCKED_MOD_LETTERS.some(is)) return hit('SHORTCUT_BLOCKED');
  return null;
}

module.exports = { evaluateKey, label };
