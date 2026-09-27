'use strict';
// Ed25519 key handling. The server signs every policy it hands to a client;
// the client ships with the matching public key and refuses unsigned or
// tampered policies (so a fake server cannot loosen the whitelist).

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function ensureKeys(dataDir) {
  const keyDir = path.join(dataDir, 'keys');
  fs.mkdirSync(keyDir, { recursive: true });
  const privPath = path.join(keyDir, 'private.pem');
  const pubPath = path.join(keyDir, 'public.pem');

  if (!fs.existsSync(privPath)) {
    const { privateKey } = crypto.generateKeyPairSync('ed25519');
    fs.writeFileSync(privPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  }
  const privateKey = crypto.createPrivateKey(fs.readFileSync(privPath));
  const publicPem = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' });
  fs.writeFileSync(pubPath, publicPem);
  return { privateKey, publicPem, pubPath };
}

function sign(privateKey, text) {
  return crypto.sign(null, Buffer.from(text, 'utf8'), privateKey).toString('base64');
}

module.exports = { ensureKeys, sign };
