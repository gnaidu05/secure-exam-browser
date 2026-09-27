'use strict';
// Domain + port + scheme whitelist. Pure logic (no Electron), so it is unit-tested.
//
// A rule looks like: { host: "exam.college.edu", ports: [443], schemes: ["https","wss"] }
//   host     exact host, or "*.domain" for any subdomain (NOT the bare domain: add it separately)
//   ports    allowed ports (default [443])
//   schemes  allowed schemes (default ["https","wss"]). Write ["http","ws"] to allow plain HTTP.
//
// Everything not matched by a rule is denied, including file:, ftp:, chrome-extension:, view-source:, etc.

const DEFAULT_PORT = { 'http:': 80, 'https:': 443, 'ws:': 80, 'wss:': 443 };

function normHost(h) {
  try { return new URL('https://' + String(h).trim()).hostname; } catch { return ''; }
}

function compile(allow) {
  const rules = [];
  for (const r of Array.isArray(allow) ? allow : []) {
    if (!r || typeof r.host !== 'string') continue;
    const raw = r.host.trim().toLowerCase();
    const wildcard = raw.startsWith('*.');
    const host = normHost(wildcard ? raw.slice(2) : raw);
    if (!host) continue;
    const ports = (Array.isArray(r.ports) && r.ports.length ? r.ports : [443]).map(Number).filter((p) => p > 0 && p < 65536);
    const schemes = (Array.isArray(r.schemes) && r.schemes.length ? r.schemes : ['https', 'wss']).map((s) => String(s).toLowerCase().replace(/:$/, '') + ':');
    rules.push({ host, wildcard, ports: new Set(ports), schemes: new Set(schemes) });
  }
  return rules;
}

const allow = (extra = {}) => ({ allowed: true, category: 'ok', reason: 'allowed', ...extra });
const deny = (category, reason, extra = {}) => ({ allowed: false, category, reason, ...extra });

function createMatcher(allowList) {
  const rules = compile(allowList);

  function checkHttpLike(u) {
    const host = u.hostname.replace(/\.+$/, ''); // "exam.edu." is the same DNS name as "exam.edu"
    const scheme = u.protocol;
    const port = u.port ? Number(u.port) : DEFAULT_PORT[scheme];
    const hostRules = rules.filter((r) => (r.wildcard ? host.endsWith('.' + r.host) : host === r.host));
    const info = { host, port, scheme };
    if (!hostRules.length) return deny('domain', `domain not whitelisted (${host})`, info);
    const schemeRules = hostRules.filter((r) => r.schemes.has(scheme));
    if (!schemeRules.length) return deny('scheme', `${scheme.slice(0, -1)} not allowed for ${host}`, info);
    if (!schemeRules.some((r) => r.ports.has(port))) return deny('port', `port ${port} not whitelisted for ${host}`, info);
    return allow(info);
  }

  // opts.isFrame: true for top-level/iframe navigations (data: and blob: are refused there).
  function check(rawUrl, opts = {}) {
    let u;
    try { u = new URL(rawUrl); } catch { return deny('invalid', 'unparseable URL'); }

    switch (u.protocol) {
      case 'http:': case 'https:': case 'ws:': case 'wss:':
        return checkHttpLike(u);
      case 'about:':
        return u.href === 'about:blank' ? allow() : deny('protocol', `blocked: ${u.href}`);
      case 'data:':
        return opts.isFrame ? deny('protocol', 'data: URLs are not allowed as pages') : allow();
      case 'blob:': {
        if (opts.isFrame) return deny('protocol', 'blob: URLs are not allowed as pages');
        let inner;
        try { inner = new URL(u.origin); } catch { return deny('protocol', 'opaque blob origin'); }
        return checkHttpLike(inner);
      }
      default:
        return deny('protocol', `protocol ${u.protocol} is not allowed`);
    }
  }

  return { check, ruleCount: rules.length };
}

module.exports = { createMatcher };
