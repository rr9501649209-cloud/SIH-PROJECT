// backend/scripts/generate-keys.js
// Run once. In real deployment this key pair belongs to the State Legal
// Metrology Department / DoCA and lives in a KMS or HSM, never a plain file.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const keysDir = path.join(__dirname, '..', 'keys');
fs.mkdirSync(keysDir, { recursive: true });

const privPath = path.join(keysDir, 'authority-private.pem');
const pubPath = path.join(keysDir, 'authority-public.pem');

if (fs.existsSync(privPath) && fs.existsSync(pubPath)) {
  console.log('Authority keys already exist — leaving them untouched.');
  process.exit(0);
}

const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', {
  namedCurve: 'prime256v1',
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

fs.writeFileSync(privPath, privateKey, { mode: 0o600 });
fs.writeFileSync(pubPath, publicKey);
console.log('Authority key pair generated:', keysDir);
