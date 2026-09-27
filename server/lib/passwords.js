'use strict';
// scrypt password hashing for institute admin accounts stored in institutes.json.
// (The single-institute server.js still just compares plaintext from settings.txt/env —
// there's nothing to persist there. This is only needed once passwords live on disk.)
const crypto = require('crypto');

function hash(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(password), salt, 64);
  return `scrypt:${salt.toString('hex')}:${key.toString('hex')}`;
}

function verify(password, stored) {
  if (typeof stored !== 'string') return false;
  const [scheme, saltHex, keyHex] = stored.split(':');
  if (scheme !== 'scrypt' || !saltHex || !keyHex) return false;
  try {
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(keyHex, 'hex');
    const actual = crypto.scryptSync(String(password), salt, expected.length);
    return crypto.timingSafeEqual(actual, expected);
  } catch { return false; }
}

module.exports = { hash, verify };
