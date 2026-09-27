'use strict';
// Where settings.txt / config / data should live: next to the packaged executable when running
// as one (pkg, or Node's built-in "Single Executable Application"), otherwise this source folder.
const path = require('path');

function isSea() {
  try { return require('node:sea').isSea(); } catch { return false; }
}

function exeBaseDir(devDir) {
  if (process.pkg || isSea()) return path.dirname(process.execPath);
  return devDir;
}

module.exports = { exeBaseDir, isSea };
