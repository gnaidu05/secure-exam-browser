'use strict';
// Run the browser in developer mode (windowed, no kiosk lock, no always-on-top) on any OS.
const { spawn } = require('child_process');
const electron = require('electron');

const child = spawn(electron, ['.'], {
  stdio: 'inherit',
  env: { ...process.env, SEB_DEV: '1' },
  cwd: require('path').join(__dirname, '..'),
});
child.on('exit', (code) => process.exit(code ?? 0));
