/**
 * certificate-engine.js
 *
 * Core of PS26036's most differentiating requirement: a QR-coded digital
 * verification certificate that cannot be forged or reassigned to a
 * different instrument by simply photocopying the sticker.
 *
 * Design choice: the QR does NOT just encode a link to a database row
 * (a photocopied sticker would still "work" in that design). Instead the
 * QR encodes the certificate DATA itself plus a digital signature, signed
 * by the issuing authority's private key. Any verifier — a citizen's
 * phone, an offline field app, or a public web page — can check
 * authenticity purely by checking the signature against the authority's
 * PUBLIC key. No network call is required for the basic authenticity
 * check, only for a live revocation/expiry refresh. This is what makes
 * verification work in low-connectivity areas (mandis, highway
 * weighbridges) and is the reason this is a proof-of-concept on its own
 * before anything else gets built.
 *
 * In production:
 *  - The private key belongs to the State Legal Metrology Department (or
 *    a central DoCA authority) and lives in a KMS/HSM, never on a server
 *    disk. Key rotation is supported via `signingKeyId` in the Certificate
 *    model so old certificates remain verifiable after rotation.
 *  - ECDSA P-256 is used because its signatures are short (~70 bytes),
 *    keeping the QR payload small enough to scan reliably on cheap
 *    field-condition phone cameras even at a high error-correction level.
 */

const crypto = require('crypto');

const TOKEN_VERSION = 'LM1';

function generateAuthorityKeys() {
  return crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}

// Fixed field order, pipe-delimited. Deliberately NOT JSON — JSON key
// names cost bytes in the QR for no benefit, since both sides already
// agree on the schema via TOKEN_VERSION.
function canonicalPayload(cert) {
  return [
    cert.certId,
    cert.instrumentSerial,
    cert.instrumentType,
    cert.verifiedDate,
    cert.expiryDate,
    cert.officerId,
  ].join('|');
}

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64');
}

function issueCertificate(cert, privateKeyPem) {
  const payloadStr = canonicalPayload(cert);
  const signer = crypto.createSign('SHA256');
  signer.update(payloadStr);
  signer.end();
  const signature = signer.sign(privateKeyPem);
  return `${TOKEN_VERSION}.${base64url(Buffer.from(payloadStr, 'utf8'))}.${base64url(signature)}`;
}

function verifyCertificate(token, publicKeyPem) {
  const parts = String(token).split('.');
  if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) {
    return { valid: false, reason: 'Malformed token — not a recognised certificate format' };
  }

  const payloadStr = fromBase64url(parts[1]).toString('utf8');
  const signature = fromBase64url(parts[2]);

  const verifier = crypto.createVerify('SHA256');
  verifier.update(payloadStr);
  verifier.end();

  let sigOk;
  try {
    sigOk = verifier.verify(publicKeyPem, signature);
  } catch {
    sigOk = false;
  }

  if (!sigOk) {
    return { valid: false, reason: 'Signature mismatch — token has been altered or was not issued by this authority' };
  }

  const [certId, instrumentSerial, instrumentType, verifiedDate, expiryDate, officerId] = payloadStr.split('|');
  const expired = new Date() > new Date(expiryDate);

  return {
    valid: !expired,
    reason: expired ? 'Signature is authentic but the certificate has expired' : 'Authentic and current',
    payload: { certId, instrumentSerial, instrumentType, verifiedDate, expiryDate, officerId },
  };
}

module.exports = { generateAuthorityKeys, issueCertificate, verifyCertificate, canonicalPayload };
