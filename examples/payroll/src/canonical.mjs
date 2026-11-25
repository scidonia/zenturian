// Canonical encoding and call digests for the mediated payroll path.
//
// `zcanon.v1` is the versioned stand-in for the future Lean encoder: object keys
// sort by UTF-8 code unit, numbers are safe integers rendered in decimal, strings
// use JSON escaping, and no whitespace is emitted.
//
// A component never computes a digest. The auth server builds the permit from the
// digest, and the verifying proxy recomputes it from the same canonical call
// value. The checked-in vectors under `test-vectors/canonical-v1.json` are the
// contract with the Lean implementation of the same encoding.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const CALL_DIGEST_DOMAIN = 'zenturian.call.v1\n';
export const PERMIT_DOMAIN = 'zenturian.permit.v1\n';
export const POLICY_DOMAIN = 'zenturian.policy.v1\n';
export const AUDIT_DOMAIN = 'zenturian.audit.v1\n';

export const CANONICAL_VECTORS_URL = new URL(
  '../test-vectors/canonical-v1.json',
  import.meta.url,
);

export class CanonicalError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CanonicalError';
  }
}

const CALL_FIELDS = [
  'v',
  'caller',
  'audience',
  'subject',
  'onBehalfOf',
  'tenant',
  'op',
  'resource',
  'args',
];

const PERMIT_FIELDS = [
  'v',
  'policyHash',
  'callDigest',
  'caller',
  'audience',
  'subject',
  'onBehalfOf',
  'tenant',
  'issuedAt',
  'expiresAt',
  'nonce',
  'decision',
];

const HEX_DIGEST = /^[0-9a-f]{64}$/;

function byteCompare(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function encode(value, stack) {
  if (value === null) {
    return 'null';
  }

  const type = typeof value;
  if (type === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (type === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new CanonicalError(
        `zcanon.v1 encodes only safe integers, received ${String(value)}`,
      );
    }
    return String(value);
  }
  if (type === 'string') {
    return JSON.stringify(value);
  }
  if (type === 'undefined') {
    throw new CanonicalError('zcanon.v1 cannot encode undefined');
  }
  if (type === 'function' || type === 'symbol' || type === 'bigint') {
    throw new CanonicalError(`zcanon.v1 cannot encode a ${type}`);
  }

  if (stack.has(value)) {
    throw new CanonicalError('zcanon.v1 cannot encode a cyclic value');
  }
  stack.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => encode(item, stack)).join(',')}]`;
    }
    if (!isPlainObject(value)) {
      throw new CanonicalError('zcanon.v1 encodes only plain objects and arrays');
    }
    const keys = Object.keys(value).sort(byteCompare);
    const parts = keys.map(
      (key) => `${JSON.stringify(key)}:${encode(value[key], stack)}`,
    );
    return `{${parts.join(',')}}`;
  } finally {
    stack.delete(value);
  }
}

export function zcanon(value) {
  return encode(value, new Set());
}

export function sha256Hex(text) {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

function requireNonEmptyString(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new CanonicalError(`${field} must be a non-empty string`);
  }
}

function requireNoExtraFields(value, allowed, label) {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length > 0) {
    throw new CanonicalError(`${label} has unknown fields: ${extra.join(', ')}`);
  }
  const missing = allowed.filter((key) => !(key in value));
  if (missing.length > 0) {
    throw new CanonicalError(`${label} is missing fields: ${missing.join(', ')}`);
  }
}

function canonicalResource(resource) {
  if (!isPlainObject(resource)) {
    throw new CanonicalError('resource must be an object');
  }
  requireNoExtraFields(resource, ['type', 'id'], 'resource');
  requireNonEmptyString(resource.type, 'resource.type');
  requireNonEmptyString(resource.id, 'resource.id');
  return { type: resource.type, id: resource.id };
}

// The semantic call: exactly the fields the permit digest binds, in one shape,
// with unknown fields refused rather than silently dropped.
export function canonicalCall(input) {
  if (!isPlainObject(input)) {
    throw new CanonicalError('call must be an object');
  }
  requireNoExtraFields(input, CALL_FIELDS, 'call');
  if (input.v !== 1) {
    throw new CanonicalError('call.v must be 1');
  }
  for (const field of ['caller', 'audience', 'subject', 'tenant', 'op']) {
    requireNonEmptyString(input[field], `call.${field}`);
  }
  if (input.onBehalfOf !== null) {
    requireNonEmptyString(input.onBehalfOf, 'call.onBehalfOf');
  }
  if (!isPlainObject(input.args)) {
    throw new CanonicalError('call.args must be an object');
  }
  return {
    v: 1,
    caller: input.caller,
    audience: input.audience,
    subject: input.subject,
    onBehalfOf: input.onBehalfOf,
    tenant: input.tenant,
    op: input.op,
    resource: canonicalResource(input.resource),
    args: input.args,
  };
}

export function callDigest(input) {
  return sha256Hex(`${CALL_DIGEST_DOMAIN}${zcanon(canonicalCall(input))}`);
}

export function canonicalPermitBody(input) {
  if (!isPlainObject(input)) {
    throw new CanonicalError('permit body must be an object');
  }
  requireNoExtraFields(input, PERMIT_FIELDS, 'permit body');
  if (input.v !== 1) {
    throw new CanonicalError('permit body v must be 1');
  }
  for (const field of ['policyHash', 'callDigest']) {
    if (typeof input[field] !== 'string' || !HEX_DIGEST.test(input[field])) {
      throw new CanonicalError(`permit body ${field} must be a lower-case SHA-256 hex digest`);
    }
  }
  for (const field of ['caller', 'audience', 'subject', 'tenant', 'nonce']) {
    requireNonEmptyString(input[field], `permit body ${field}`);
  }
  if (input.onBehalfOf !== null) {
    requireNonEmptyString(input.onBehalfOf, 'permit body onBehalfOf');
  }
  for (const field of ['issuedAt', 'expiresAt']) {
    if (!Number.isSafeInteger(input[field])) {
      throw new CanonicalError(`permit body ${field} must be an integer epoch second`);
    }
  }
  if (input.expiresAt <= input.issuedAt) {
    throw new CanonicalError('permit body expiresAt must be after issuedAt');
  }
  if (!isPlainObject(input.decision)) {
    throw new CanonicalError('permit body decision must be an object');
  }
  requireNoExtraFields(input.decision, ['verdict', 'ruleId'], 'permit body decision');
  if (input.decision.verdict !== 'allow') {
    throw new CanonicalError('permit body decision.verdict must be allow');
  }
  requireNonEmptyString(input.decision.ruleId, 'permit body decision.ruleId');
  return {
    v: 1,
    policyHash: input.policyHash,
    callDigest: input.callDigest,
    caller: input.caller,
    audience: input.audience,
    subject: input.subject,
    onBehalfOf: input.onBehalfOf,
    tenant: input.tenant,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
    nonce: input.nonce,
    decision: { verdict: 'allow', ruleId: input.decision.ruleId },
  };
}

export function permitSigningBytes(input) {
  return `${PERMIT_DOMAIN}${zcanon(canonicalPermitBody(input))}`;
}

export function loadCanonicalVectors() {
  const document = JSON.parse(readFileSync(CANONICAL_VECTORS_URL, 'utf8'));
  if (!isPlainObject(document) || document.v !== 1) {
    throw new CanonicalError('canonical vector document must declare v: 1');
  }
  if (!Array.isArray(document.vectors) || document.vectors.length === 0) {
    throw new CanonicalError('canonical vector document must carry vectors');
  }
  return document.vectors;
}

// Reads the checked-in vectors and recomputes each one. A mismatch means the
// encoder and the pinned contract have diverged, so it fails loudly.
export function verifyCanonicalVectors() {
  const vectors = loadCanonicalVectors();
  for (const vector of vectors) {
    if (!isPlainObject(vector) || typeof vector.name !== 'string') {
      throw new CanonicalError('each canonical vector requires a name');
    }
    if ('call' in vector) {
      const encoded = zcanon(canonicalCall(vector.call));
      if (encoded !== vector.canonical) {
        throw new CanonicalError(
          `canonical vector ${vector.name}: call encoding differs from the pinned bytes`,
        );
      }
      const digest = callDigest(vector.call);
      if (digest !== vector.digest) {
        throw new CanonicalError(
          `canonical vector ${vector.name}: call digest differs from the pinned digest`,
        );
      }
      continue;
    }
    const encoded = zcanon(vector.input);
    if (encoded !== vector.canonical) {
      throw new CanonicalError(
        `canonical vector ${vector.name}: value encoding differs from the pinned bytes`,
      );
    }
  }
  return { count: vectors.length };
}
