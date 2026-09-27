'use strict';
// Loads an optional plain-text settings file (KEY=VALUE per line, # comments allowed)
// so a non-technical admin can configure the server with Notepad instead of environment
// variables. Values already set in process.env win (so power users can still override
// with real env vars); this only fills in what is missing.

const fs = require('fs');

function loadSettingsFile(filePath) {
  let text;
  try { text = fs.readFileSync(filePath, 'utf8'); } catch { return false; }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && !(key in process.env)) process.env[key] = value;
  }
  return true;
}

module.exports = { loadSettingsFile };
