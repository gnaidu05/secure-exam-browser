'use strict';
// The central server's registry of institutes: institutes.json is the list (slug, name,
// admin username + hashed password, timestamps); each institute's actual exam data
// (keys, exams.json, sessions, alerts, screenshots) lives in its own folder under
// <dataDir>/institutes/<slug>/, created lazily the first time that institute is used.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const passwords = require('./passwords');

const RESERVED_SLUGS = new Set(['super', 'api', 'admin', 'i', 'config', 'data', 'static', 'assets']);

function slugify(name) {
  return String(name).toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'institute';
}

class Institutes {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'institutes.json');
    fs.mkdirSync(dataDir, { recursive: true });
    this.list = this._load();
  }

  _load() {
    try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { return []; }
  }

  _save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.list, null, 2));
    fs.renameSync(tmp, this.file);
  }

  all() { return this.list; }
  get(slug) { return this.list.find((i) => i.slug === slug); }

  uniqueSlug(base) {
    let slug = slugify(base);
    if (RESERVED_SLUGS.has(slug)) slug = slug + '-institute';
    let candidate = slug, n = 2;
    while (this.get(candidate)) candidate = `${slug}-${n++}`;
    return candidate;
  }

  /** Creates the registry entry and returns { institute, adminPassword } (plaintext password, shown once). */
  create({ name, adminUser = 'admin', slug }) {
    const finalSlug = slug ? slugify(slug) : this.uniqueSlug(name);
    if (RESERVED_SLUGS.has(finalSlug) || this.get(finalSlug)) throw new Error('slug_taken');
    const adminPassword = crypto.randomBytes(9).toString('base64url');
    const institute = {
      id: crypto.randomUUID(), slug: finalSlug, name: String(name).slice(0, 100).trim() || finalSlug,
      adminUser: String(adminUser).slice(0, 64).trim() || 'admin',
      adminPasswordHash: passwords.hash(adminPassword),
      createdAt: Date.now(), disabled: false,
    };
    this.list.push(institute);
    this._save();
    return { institute, adminPassword };
  }

  resetPassword(slug) {
    const inst = this.get(slug);
    if (!inst) return null;
    const adminPassword = crypto.randomBytes(9).toString('base64url');
    inst.adminPasswordHash = passwords.hash(adminPassword);
    this._save();
    return adminPassword;
  }

  setDisabled(slug, disabled) {
    const inst = this.get(slug);
    if (!inst) return false;
    inst.disabled = !!disabled;
    this._save();
    return true;
  }

  checkAdmin(slug, user, pass) {
    const inst = this.get(slug);
    if (!inst || inst.disabled) return false;
    return safeStrEq(user, inst.adminUser) && passwords.verify(pass, inst.adminPasswordHash);
  }

  instituteDir(slug) { return path.join(this.dataDir, 'institutes', slug); }
}

function safeStrEq(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

module.exports = { Institutes, slugify };
