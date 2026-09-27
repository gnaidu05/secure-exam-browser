'use strict';
// Single-institute admin server: one exam institute, one running process.
// (For a platform that hosts many institutes on one server with one shared URL,
// each institute getting its own signing key and its own dashboard login,
// run central.js instead — see README "Central server for multiple institutes".)

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const express = require('express');
const { createTenant, DEFAULT_SETTINGS, DEFAULT_BLOCKED_PROCESSES } = require('./lib/tenant');
const { loadSettingsFile } = require('./lib/settings-file');
const { exeBaseDir } = require('./lib/exe-dir');

// When built into a standalone executable (see README, "Run the server with no installation"),
// everything the admin needs to touch — settings.txt, config/exams.json, data/ — lives next to
// the .exe/binary, not inside it, so editing them never requires rebuilding. In normal
// `node server.js` dev use, that "next to the executable" folder is just this server/ directory.
const baseDir = exeBaseDir(__dirname);
if (require.main === module) loadSettingsFile(path.join(baseDir, 'settings.txt'));

const safeEq = (a, b) => {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
};

function createServer(opts = {}) {
  const port = opts.port ?? Number(process.env.PORT || 8443);
  const dataDir = opts.dataDir || process.env.DATA_DIR || path.join(baseDir, 'data');
  const examsFile = opts.examsFile || process.env.EXAMS_FILE || path.join(baseDir, 'config', 'exams.json');
  const adminUser = opts.adminUser || process.env.ADMIN_USER || 'admin';
  let adminPassword = opts.adminPassword || process.env.ADMIN_PASSWORD;
  let generatedPassword = false;
  if (!adminPassword) {
    adminPassword = crypto.randomBytes(9).toString('base64url');
    generatedPassword = true;
  }

  const tenant = createTenant({
    dataDir, examsFile, publicDir: path.join(baseDir, 'public'),
    checkAdmin: (user, pass) => safeEq(user, adminUser) && safeEq(pass, adminPassword),
  });

  const app = express();
  app.disable('x-powered-by');
  if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY);
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'no-referrer');
    next();
  });
  app.use('/', tenant.router);

  let server;
  const tlsKey = process.env.TLS_KEY, tlsCert = process.env.TLS_CERT;
  if (tlsKey && tlsCert) server = https.createServer({ key: fs.readFileSync(tlsKey), cert: fs.readFileSync(tlsCert) }, app);
  else server = http.createServer(app);

  const ready = new Promise((resolve) => server.listen(port, () => resolve(server.address().port)));
  const close = () => new Promise((resolve) => {
    tenant.close();
    server.close(() => resolve());
    server.closeAllConnections?.();
  });

  return {
    app, server, store: tenant.store, ready, close, keys: tenant.keys,
    adminUser, adminPassword, generatedPassword, tls: !!(tlsKey && tlsCert),
  };
}

module.exports = { createServer, DEFAULT_SETTINGS, DEFAULT_BLOCKED_PROCESSES };

function localIPv4s() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const n of list || []) if (!n.internal && (n.family === 'IPv4' || n.family === 4)) out.push(n.address);
  }
  return out;
}

if (require.main === module) {
  const srv = createServer();
  srv.ready.then((port) => {
    const scheme = srv.tls ? 'https' : 'http';
    const line = '='.repeat(66);
    console.log('\n' + line);
    console.log('  SECURE EXAM BROWSER - admin server is running');
    console.log(line);
    console.log(`\n  Open the dashboard in a web browser:\n`);
    console.log(`      ${scheme}://localhost:${port}/admin/          (on this computer)`);
    for (const ip of localIPv4s()) console.log(`      ${scheme}://${ip}:${port}/admin/    (from other computers on this network)`);
    console.log(`\n  Dashboard login`);
    console.log(`      Username: ${srv.adminUser}`);
    console.log(`      Password: ${srv.adminPassword}${srv.generatedPassword ? '   (auto-generated - set ADMIN_PASSWORD in settings.txt to choose your own)' : ''}`);
    console.log(`\n  Files you can edit with Notepad (restart this program after changing them):`);
    console.log(`      settings.txt          server password, port, HTTPS certificate`);
    console.log(`      config/exams.json     exam codes, allowed websites, duration, exit code`);
    console.log(`\n  Give this file to whoever installs the exam browser on student PCs:`);
    console.log(`      ${srv.keys.pubPath}`);
    if (!srv.tls) {
      console.log(`\n  NOTE: running without HTTPS. Fine for a school LAN test; for a real exam over`);
      console.log(`  the internet, set TLS_KEY / TLS_CERT in settings.txt or put this behind a`);
      console.log(`  reverse proxy that provides HTTPS.`);
    }
    console.log('\n  Running MULTIPLE institutes off one server? Use central.js instead - see README.');
    console.log('\n  Leave this window open during the exam. Press Ctrl+C to stop the server.');
    console.log(line + '\n');
  });
  const stop = () => srv.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
