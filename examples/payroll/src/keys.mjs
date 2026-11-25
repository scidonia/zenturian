// Ed25519 signing keys, admission tokens and constant-time comparison.
//
// The auth server mints its signing keypair at start. Proxies receive only the
// public key. Admission tokens are compared in constant time and never written
// to the repository or printed.

import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
  timingSafeEqual,
  verify,
} from 'node:crypto';

export function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

export function generateSigningKeys() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { publicKey, privateKey };
}

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

export function signEd25519(privateKey, text) {
  return sign(null, Buffer.from(text, 'utf8'), privateKey);
}

export function verifyEd25519(publicKey, text, signature) {
  if (!Buffer.isBuffer(signature) || signature.length === 0) {
    return false;
  }
  return verify(null, Buffer.from(text, 'utf8'), publicKey, signature);
}

// Comparing digests keeps the comparison constant time even when the presented
// value has a different length from the expected token.
export function timingSafeTextEqual(presented, expected) {
  if (typeof presented !== 'string' || typeof expected !== 'string') {
    return false;
  }
  const presentedDigest = createHash('sha256').update(presented, 'utf8').digest();
  const expectedDigest = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(presentedDigest, expectedDigest);
}

export function toBase64Url(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

export function fromBase64Url(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return null;
  }
  try {
    return Buffer.from(text, 'base64url');
  } catch {
    return null;
  }
}
