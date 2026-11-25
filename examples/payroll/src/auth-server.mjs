// Auth server: the broker prototype.
//
// It owns the Ed25519 signing key, decides a canonical call against the active
// policy, issues a short-lived single-use permit bound to that call's digest, and
// serves policy bytes by hash so a proxy can verify what it evaluates. It also
// promotes a validated policy value, storing its bytes by hash and recording the
// approval, and owns the hash-chained audit log, which records scope and
// principal metadata but never a gross-pay or bank value.
//
// The signing key and the admission tokens never leave this process; proxies get
// only the public key.

import { randomUUID } from 'node:crypto';

import {
  AUDIT_DOMAIN,
  CanonicalError,
  POLICY_DOMAIN,
  callDigest,
  canonicalCall,
  canonicalPermitBody,
  permitSigningBytes,
  sha256Hex,
  zcanon,
} from './canonical.mjs';
import {
  createServiceServer,
  HttpError,
  readJsonBody,
  sendJson,
} from './http.mjs';
import {
  generateSigningKeys,
  nowSeconds,
  randomToken,
  signEd25519,
  toBase64Url,
  timingSafeTextEqual,
} from './keys.mjs';
import {
  decideCall,
  freezePolicy,
  permitTtlSeconds,
  policyBytes,
  policyHash,
} from './policy.mjs';
import { policyV1 } from './policy-v1.mjs';

const AUDIT_TYPES = new Set(['call', 'release', 'promotion']);
const AUDIT_VERDICTS = new Set(['allow', 'refuse']);
const AUDIT_STRING_FIELDS = [
  'subject',
  'recipient',
  'reportId',
  'policyHash',
  'commitPolicyHash',
  'previousPolicyHash',
  'approver',
  'snapshotId',
  'viewId',
  'reason',
  'audience',
  'op',
  'nonce',
];
const AUDIT_INTEGER_FIELDS = ['directoryVersion', 'commitDirectoryVersion', 'rowCount'];
const AUDIT_FIELDS = new Set([
  'type',
  'requestId',
  'caller',
  'verdict',
  'rowIds',
  ...AUDIT_STRING_FIELDS,
  ...AUDIT_INTEGER_FIELDS,
]);
const HEX_DIGEST = /^[0-9a-f]{64}$/;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function invalidAudit(message) {
  return new HttpError(400, 'invalid_audit_entry', message);
}

// The audit body is an allowlist, not a filter: a field the log does not name is
// refused, so an amount or bank value cannot be smuggled into a record.
function normalizeAuditEntry(input) {
  if (!isPlainObject(input)) {
    throw invalidAudit('audit entry must be an object');
  }
  const extra = Object.keys(input).filter((key) => !AUDIT_FIELDS.has(key));
  if (extra.length > 0) {
    throw invalidAudit(`audit entry may not carry: ${extra.join(', ')}`);
  }
  if (!AUDIT_TYPES.has(input.type)) {
    throw invalidAudit(`audit entry type must be one of ${[...AUDIT_TYPES].join(', ')}`);
  }
  for (const field of ['requestId', 'caller']) {
    if (typeof input[field] !== 'string' || input[field].length === 0) {
      throw invalidAudit(`audit entry ${field} must be a non-empty string`);
    }
  }
  if (!AUDIT_VERDICTS.has(input.verdict)) {
    throw invalidAudit(`audit entry verdict must be one of ${[...AUDIT_VERDICTS].join(', ')}`);
  }

  const entry = {
    type: input.type,
    requestId: input.requestId,
    caller: input.caller,
    verdict: input.verdict,
  };

  for (const field of AUDIT_STRING_FIELDS) {
    const value = input[field];
    if (value === undefined) {
      continue;
    }
    if (typeof value !== 'string' || value.length === 0) {
      throw invalidAudit(`audit entry ${field} must be a non-empty string`);
    }
    if (
      (
        field === 'policyHash'
        || field === 'commitPolicyHash'
        || field === 'previousPolicyHash'
      )
      && !HEX_DIGEST.test(value)
    ) {
      throw invalidAudit(`audit entry ${field} must be a SHA-256 hex digest`);
    }
    entry[field] = value;
  }

  for (const field of AUDIT_INTEGER_FIELDS) {
    const value = input[field];
    if (value === undefined) {
      continue;
    }
    if (!Number.isSafeInteger(value) || value < 0) {
      throw invalidAudit(`audit entry ${field} must be a non-negative integer`);
    }
    entry[field] = value;
  }

  if (input.rowIds !== undefined) {
    if (
      !Array.isArray(input.rowIds)
      || input.rowIds.some((rowId) => typeof rowId !== 'string' || rowId.length === 0)
    ) {
      throw invalidAudit('audit entry rowIds must be an array of non-empty strings');
    }
    entry.rowIds = [...input.rowIds];
  }

  return entry;
}

function resolveComponent(presented, admissionTokens) {
  for (const [component, token] of Object.entries(admissionTokens)) {
    if (timingSafeTextEqual(presented, token)) {
      return component;
    }
  }
  return null;
}

export async function createAuthServer({
  admissionTokens,
  adminToken,
  clock = nowSeconds,
  initialPolicy = policyV1,
} = {}) {
  if (!isPlainObject(admissionTokens) || Object.keys(admissionTokens).length === 0) {
    throw new TypeError('auth server requires admission tokens');
  }
  for (const [component, token] of Object.entries(admissionTokens)) {
    if (typeof token !== 'string' || token.length === 0) {
      throw new TypeError(`auth server admission token for ${component} must be a string`);
    }
  }
  if (typeof adminToken !== 'string' || adminToken.length === 0) {
    throw new TypeError('auth server requires an admin token');
  }

  const { publicKey, privateKey } = generateSigningKeys();

  const policies = new Map();
  let activeHash;
  let activePolicy;
  const activate = (policy) => {
    const hash = policyHash(policy);
    // The served bytes include the domain prefix, so a proxy's
    // `sha256(bytes) === policyHash` check and the pinned hash agree.
    const bytes = `${POLICY_DOMAIN}${policyBytes(policy)}`;
    policies.set(hash, bytes);
    activeHash = hash;
    activePolicy = policy;
    return hash;
  };
  activeHash = activate(freezePolicy(initialPolicy));

  const entries = [];
  let head = '0'.repeat(64);

  const appendEntry = (fields) => {
    const entry = { seq: entries.length + 1, prevHash: head, ts: clock(), ...fields };
    const digest = sha256Hex(`${AUDIT_DOMAIN}${zcanon(entry)}`);
    entries.push({ ...entry, digest });
    head = digest;
    return { seq: entry.seq, digest, ts: entry.ts };
  };

  const verifyAuditChain = () => {
    let previous = '0'.repeat(64);
    for (let index = 0; index < entries.length; index += 1) {
      const { digest, ...body } = entries[index];
      if (
        body.seq !== index + 1
        || body.prevHash !== previous
        || sha256Hex(`${AUDIT_DOMAIN}${zcanon(body)}`) !== digest
      ) {
        return { ok: false, count: entries.length, brokenAt: index + 1 };
      }
      previous = digest;
    }
    return { ok: true, count: entries.length, head: previous };
  };

  const requireAdmin = (req) => {
    if (!timingSafeTextEqual(req.headers['x-zenturian-admin'], adminToken)) {
      throw new HttpError(401, 'admin_required', 'this route requires the broker admin token');
    }
  };

  const service = await createServiceServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');

    if (req.method === 'GET' && url.pathname === '/v1/policy/active') {
      sendJson(res, 200, { hash: activeHash, policy: activePolicy });
      return;
    }

    const policyMatch = req.method === 'GET'
      ? url.pathname.match(/^\/v1\/policy\/([0-9a-f]{64})$/)
      : null;
    if (policyMatch !== null) {
      const hash = policyMatch[1];
      if (hash !== activeHash) {
        throw new HttpError(404, 'unknown_policy', `policy ${hash} is not active`);
      }
      const bytes = policies.get(hash);
      res.writeHead(200, {
        'content-type': 'text/plain; charset=utf-8',
        'content-length': Buffer.byteLength(bytes),
      });
      res.end(bytes);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/v1/decide') {
      const component = resolveComponent(req.headers['x-zenturian-admission'], admissionTokens);
      if (component === null) {
        throw new HttpError(401, 'unauthenticated', 'a valid admission token is required');
      }

      const request = await readJsonBody(req);
      let call;
      try {
        call = canonicalCall(request);
      } catch (error) {
        if (error instanceof CanonicalError) {
          throw new HttpError(400, 'invalid_call', error.message);
        }
        throw error;
      }

      if (call.caller !== component) {
        throw new HttpError(
          403,
          'caller_mismatch',
          `the admission token belongs to ${component}, not ${call.caller}`,
        );
      }

      const decision = decideCall(activePolicy, call);
      if (decision.verdict !== 'allow') {
        throw new HttpError(
          403,
          'denied',
          `no policy rule allows ${call.caller} to call ${call.audience}.${call.op}`,
        );
      }

      const issuedAt = clock();
      const digest = callDigest(call);
      const body = canonicalPermitBody({
        v: 1,
        policyHash: activeHash,
        callDigest: digest,
        caller: call.caller,
        audience: call.audience,
        subject: call.subject,
        onBehalfOf: call.onBehalfOf,
        tenant: call.tenant,
        issuedAt,
        expiresAt: issuedAt + permitTtlSeconds(call.op),
        nonce: randomToken(16),
        decision: { verdict: 'allow', ruleId: decision.ruleId },
      });
      const signature = signEd25519(privateKey, permitSigningBytes(body));
      const permit = toBase64Url(
        Buffer.from(zcanon({ body, sig: toBase64Url(signature) }), 'utf8'),
      );

      sendJson(res, 200, {
        permit,
        callDigest: digest,
        policyHash: activeHash,
        expiresAt: body.expiresAt,
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/v1/promote') {
      requireAdmin(req);
      const request = await readJsonBody(req);
      const extra = Object.keys(request).filter(
        (key) => key !== 'policy' && key !== 'approver',
      );
      if (extra.length > 0) {
        throw new HttpError(
          400,
          'invalid_promotion',
          `promotion request may not carry: ${extra.join(', ')}`,
        );
      }
      if (typeof request.approver !== 'string' || request.approver.length === 0) {
        throw new HttpError(400, 'invalid_promotion', 'promotion approver must be a non-empty string');
      }

      let policy;
      try {
        policy = freezePolicy(request.policy);
      } catch (error) {
        if (error instanceof TypeError) {
          throw new HttpError(400, 'invalid_policy', error.message);
        }
        throw error;
      }

      const previousHash = activeHash;
      const hash = activate(policy);
      const appended = appendEntry({
        type: 'promotion',
        requestId: randomUUID(),
        caller: 'gateway',
        verdict: 'allow',
        policyHash: hash,
        previousPolicyHash: previousHash,
        approver: request.approver,
        reason: previousHash === hash ? 'policy_repromoted' : 'policy_promoted',
      });

      sendJson(res, 200, {
        hash,
        previousHash,
        approver: request.approver,
        promotedAt: appended.ts,
        audit: { seq: appended.seq, digest: appended.digest },
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/v1/audit') {
      requireAdmin(req);
      const request = await readJsonBody(req);
      const entry = normalizeAuditEntry(request);
      const appended = appendEntry(entry);
      sendJson(res, 200, appended);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/v1/audit') {
      requireAdmin(req);
      sendJson(res, 200, { entries, verify: verifyAuditChain() });
      return;
    }

    throw new HttpError(404, 'not_found', 'unknown route');
  });

  return Object.assign(service, {
    publicKey,
    admissionTokens,
    adminToken,
    audit: {
      entries: () => entries.map((entry) => (
        entry.rowIds === undefined
          ? { ...entry }
          : { ...entry, rowIds: [...entry.rowIds] }
      )),
      verify: verifyAuditChain,
    },
    policy: () => ({ hash: activeHash, policy: activePolicy }),
  });
}
