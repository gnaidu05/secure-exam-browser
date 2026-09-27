'use strict';
// Central server: ONE running process, ONE URL, serving MANY institutes.
// A super-admin creates each institute here; each institute gets its own signing key
// (so each institute's exam browser installer embeds a DIFFERENT public key — one
// institute's server can never sign policies for another's) and its own dashboard at
// /i/<slug>/admin/, with its own login, own exams.json, own sessions/alerts/screenshots.
//
// Run this INSTEAD of server.js when one server should host several institutes.
// Use server.js when it's just one institute on its own server.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const express = require('express');
const { createTenant } = require('./lib/tenant');
const { Institutes } = require('./lib/institutes');
const { loadSettingsFile } = require('./lib/settings-file');
const { exeBaseDir } = require('./lib/exe-dir');

const baseDir = exeBaseDir(__dirname);
if (require.main === module) loadSettingsFile(path.join(baseDir, 'central-settings.txt'));

const safeEq = (a, b) => {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
};
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

function createCentralServer(opts = {}) {
  const port = opts.port ?? Number(process.env.PORT || 8443);
  const dataDir = path.resolve(opts.dataDir || process.env.DATA_DIR || path.join(baseDir, 'central-data'));
  const superUser = opts.superUser || process.env.SUPER_ADMIN_USER || 'super';
  let superPassword = opts.superPassword || process.env.SUPER_ADMIN_PASSWORD;
  let generatedPassword = false;
  if (!superPassword) { superPassword = crypto.randomBytes(9).toString('base64url'); generatedPassword = true; }

  const institutes = new Institutes(dataDir);
  const tenants = new Map(); // slug -> tenant (lazily created, cached for the life of the process)

  function getTenant(slug) {
    const inst = institutes.get(slug);
    if (!inst || inst.disabled) return null;
    if (tenants.has(slug)) return tenants.get(slug);
    const dir = institutes.instituteDir(slug);
    const tenant = createTenant({
      dataDir: path.join(dir, 'data'),
      examsFile: path.join(dir, 'exams.json'),
      publicDir: path.join(baseDir, 'public'),
      checkAdmin: (user, pass) => institutes.checkAdmin(slug, user, pass),
    });
    tenants.set(slug, tenant);
    return tenant;
  }

  function superAuth(req, res, next) {
    const [scheme, b64] = (req.headers.authorization || '').split(' ');
    if (scheme === 'Basic' && b64) {
      const decoded = Buffer.from(b64, 'base64').toString('utf8');
      const i = decoded.indexOf(':');
      if (i >= 0 && safeEq(decoded.slice(0, i), superUser) && safeEq(decoded.slice(i + 1), superPassword)) return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="Platform admin", charset="UTF-8"');
    res.status(401).send('Authentication required');
  }

  const app = express();
  app.disable('x-powered-by');
  if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY);
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'no-referrer');
    next();
  });

  const publicView = (i) => ({ slug: i.slug, name: i.name, adminUser: i.adminUser, createdAt: i.createdAt, disabled: !!i.disabled });

  // ===== Super-admin: manage institutes =====================================
  app.get('/', (req, res) => res.redirect('/super/'));
  app.use('/super', superAuth, express.static(path.join(baseDir, 'public-super')));

  app.get('/super/api/institutes', superAuth, (req, res) => res.json(institutes.all().map(publicView)));

  app.post('/super/api/institutes', superAuth, express.json({ limit: '10kb' }), (req, res) => {
    const b = req.body || {};
    const name = str(b.name, 100).trim();
    if (!name) return res.status(400).json({ error: 'name_required', message: 'Institute name is required.' });
    let created;
    try {
      created = institutes.create({ name, adminUser: str(b.adminUser, 64).trim() || 'admin', slug: b.slug ? str(b.slug, 40) : undefined });
    } catch (e) {
      if (e.message === 'slug_taken') return res.status(409).json({ error: 'slug_taken', message: 'That institute code is already used. Try another name or code.' });
      throw e;
    }
    const { institute, adminPassword } = created;
    res.json({
      ...publicView(institute), adminPassword,
      dashboardUrl: `${req.protocol}://${req.get('host')}/i/${institute.slug}/admin/`,
      apiBaseUrl: `${req.protocol}://${req.get('host')}/i/${institute.slug}`,
      note: 'Save this password now - it will not be shown again. Reset it any time from this page if it is lost.',
    });
  });

  app.post('/super/api/institutes/:slug/reset-password', superAuth, (req, res) => {
    const pw = institutes.resetPassword(req.params.slug);
    if (!pw) return res.status(404).json({ error: 'not_found' });
    res.json({ adminPassword: pw });
  });

  app.post('/super/api/institutes/:slug/disable', superAuth, express.json({ limit: '2kb' }), (req, res) => {
    const ok = institutes.setDisabled(req.params.slug, req.body?.disabled !== false);
    if (!ok) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true });
  });

  app.get('/super/api/institutes/:slug/public-key', superAuth, (req, res) => {
    const inst = institutes.get(req.params.slug);
    if (!inst) return res.status(404).json({ error: 'not_found' });
    const tenant = getTenant(req.params.slug);
    res.set('Content-Type', 'application/x-pem-file');
    res.set('Content-Disposition', `attachment; filename="${req.params.slug}-public-key.pem"`);
    res.send(tenant.keys.publicPem);
  });

  // ===== Institute traffic: /i/<slug>/... (client API + that institute's dashboard) =====
  app.use('/i/:slug', (req, res, next) => {
    const tenant = getTenant(req.params.slug);
    if (!tenant) return res.status(404).send('Unknown or disabled institute code in URL.');
    tenant.router(req, res, next);
  });

  let server;
  const tlsKey = process.env.TLS_KEY, tlsCert = process.env.TLS_CERT;
  if (tlsKey && tlsCert) server = https.createServer({ key: fs.readFileSync(tlsKey), cert: fs.readFileSync(tlsCert) }, app);
  else server = http.createServer(app);

  const ready = new Promise((resolve) => server.listen(port, () => resolve(server.address().port)));
  const close = () => new Promise((resolve) => {
    for (const t of tenants.values()) t.close();
    server.close(() => resolve());
    server.closeAllConnections?.();
  });

  return { app, server, institutes, getTenant, ready, close, superUser, superPassword, generatedPassword, tls: !!(tlsKey && tlsCert) };
}

module.exports = { createCentralServer };

function localIPv4s() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const n of list || []) if (!n.internal && (n.family === 'IPv4' || n.family === 4)) out.push(n.address);
  }
  return out;
}

if (require.main === module) {
  const srv = createCentralServer();
  srv.ready.then((port) => {
    const scheme = srv.tls ? 'https' : 'http';
    const line = '='.repeat(66);
    console.log('\n' + line);
    console.log('  SECURE EXAM BROWSER - central server (multiple institutes)');
    console.log(line);
    console.log(`\n  Platform admin page (create an institute, get its key + password):\n`);
    console.log(`      ${scheme}://localhost:${port}/super/          (on this computer)`);
    for (const ip of localIPv4s()) console.log(`      ${scheme}://${ip}:${port}/super/    (from other computers on this network)`);
    console.log(`\n  Platform admin login`);
    console.log(`      Username: ${srv.superUser}`);
    console.log(`      Password: ${srv.superPassword}${srv.generatedPassword ? '   (auto-generated - set SUPER_ADMIN_PASSWORD in central-settings.txt to choose your own)' : ''}`);
    console.log(`\n  Each institute you create gets its own URL: ${scheme}://<this-host>:${port}/i/<institute-code>/`);
    console.log(`  and its own dashboard, login, signing key and exams - separate from every other institute.`);
    if (!srv.tls) {
      console.log(`\n  NOTE: running without HTTPS. Fine for a LAN test; for real exams over the internet,`);
      console.log(`  set TLS_KEY / TLS_CERT in central-settings.txt or put this behind a reverse proxy.`);
    }
    console.log('\n  Leave this window open. Press Ctrl+C to stop the server.');
    console.log(line + '\n');
  });
  const stop = () => srv.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
