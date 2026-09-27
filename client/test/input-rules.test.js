'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateKey } = require('../src/input-rules');

const key = (o) => ({ type: 'keyDown', key: '', code: '', control: false, alt: false, shift: false, meta: false, ...o });
const ev = (o, opts = {}) => evaluateKey(key(o), { platform: 'linux', ...opts });

test('devtools shortcuts', () => {
  assert.equal(ev({ key: 'F12' }).type, 'DEVTOOLS_ATTEMPT');
  assert.equal(ev({ key: 'I', code: 'KeyI', control: true, shift: true }).type, 'DEVTOOLS_ATTEMPT');
  assert.equal(ev({ key: 'j', code: 'KeyJ', control: true, shift: true }).type, 'DEVTOOLS_ATTEMPT');
  assert.equal(ev({ key: 'ˆ', code: 'KeyI', meta: true, alt: true }).type, 'DEVTOOLS_ATTEMPT'); // macOS Cmd+Opt+I
  assert.equal(ev({ key: 'c', code: 'KeyC', control: true, shift: true }).type, 'DEVTOOLS_ATTEMPT');
});

test('clipboard shortcuts blocked unless allowed', () => {
  for (const c of ['c', 'x', 'v']) {
    assert.equal(ev({ key: c, code: 'Key' + c.toUpperCase(), control: true }).type, 'CLIPBOARD_ATTEMPT');
    assert.equal(ev({ key: c, code: 'Key' + c.toUpperCase(), meta: true }).type, 'CLIPBOARD_ATTEMPT');
    assert.equal(ev({ key: c, code: 'Key' + c.toUpperCase(), control: true }, { allowClipboard: true }), null);
  }
  assert.equal(ev({ key: 'Insert', control: true }).type, 'CLIPBOARD_ATTEMPT');
  assert.equal(ev({ key: 'Insert', shift: true }).type, 'CLIPBOARD_ATTEMPT');
});

test('works on non-QWERTY layouts (physical key code)', () => {
  assert.equal(ev({ key: 'ç', code: 'KeyC', control: true }).type, 'CLIPBOARD_ATTEMPT');
});

test('print screen on keyup and keydown', () => {
  assert.equal(evaluateKey({ type: 'keyUp', key: 'PrintScreen', code: 'PrintScreen' }).type, 'PRINTSCREEN');
  assert.equal(ev({ key: 'PrintScreen', code: 'PrintScreen' }).type, 'PRINTSCREEN');
});

test('window switching and system keys', () => {
  assert.equal(ev({ key: 'Tab', alt: true }).type, 'SHORTCUT_BLOCKED');
  assert.equal(ev({ key: 'F4', alt: true }).type, 'SHORTCUT_BLOCKED');
  assert.equal(ev({ key: 'F11' }).type, 'SHORTCUT_BLOCKED');
  assert.equal(ev({ key: 'Meta', meta: true }).type, 'WINDOWS_KEY');
  assert.equal(ev({ key: 'Meta', meta: true }, { platform: 'darwin' }), null); // Cmd alone is normal on macOS
});

test('browser-UI shortcuts', () => {
  for (const c of ['u', 's', 'p', 'n', 't', 'w', 'o']) {
    assert.equal(ev({ key: c, code: 'Key' + c.toUpperCase(), control: true }).type, 'SHORTCUT_BLOCKED', c);
  }
});

test('normal typing and harmless shortcuts pass', () => {
  assert.equal(ev({ key: 'a', code: 'KeyA' }), null);
  assert.equal(ev({ key: 'A', code: 'KeyA', shift: true }), null);
  assert.equal(ev({ key: 'a', code: 'KeyA', control: true }), null); // select all
  assert.equal(ev({ key: 'z', code: 'KeyZ', control: true }), null); // undo
  assert.equal(ev({ key: 'F5' }), null);
  assert.equal(ev({ key: 'Tab' }), null);
  assert.equal(ev({ key: 'Enter' }), null);
  assert.equal(evaluateKey({ type: 'keyUp', key: 'c', code: 'KeyC', control: true }), null);
});

test('label is readable', () => {
  assert.equal(ev({ key: 'I', code: 'KeyI', control: true, shift: true }).label, 'Ctrl+Shift+I');
  assert.equal(ev({ key: 'F12' }).label, 'F12');
  assert.equal(ev({ key: 'Meta', meta: true }).label, 'Windows/Super key');
});
