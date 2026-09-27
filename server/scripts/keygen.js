'use strict';
// Creates the policy-signing key pair (if missing) and prints where the public key is.
const path = require('path');
const { ensureKeys } = require('../lib/keys');

const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const { pubPath } = ensureKeys(dataDir);
console.log('Public key: ' + pubPath);
console.log('Copy it to client/config/public-key.pem before building the client.');
