// Generic proxy and the gateway's mediated client.
//
// A proxy is the only address a component has. It verifies, in order: body cap and
// content type, the caller's admission token, the permit signature, permit expiry
// and single use, the policy fetched by the signed hash, the call digest and
// bound context, and its own policy evaluation. Only then does it forward to the
// component with the forward secret, check the response shape, append an audit
// entry, and respond. A failure before the forward never invokes the component,
// and an audit failure refuses the response.

import { request as httpRequest } from 'node:http';
import { randomUUID } from 'node:crypto';

import {
  CanonicalError,
  POLICY_DOMAIN,
  callDigest,
  canonicalCall,
  canonicalPermitBody,
  permitSigningBytes,
  sha256Hex,
} from './canonical.mjs';
import {
  createServiceServer,
  HttpError,
  MAX_BODY_BYTES,
  requestJson,
  sendJson,
} from './http.mjs';
import {
  fromBase64Url,
  nowSeconds,
  timingSafeTextEqual,
  verifyEd25519,
} from './keys.mjs';
import { decideCall } from './policy.mjs';

export const ADMISSION_HEADER = 'x-zenturian-admission';
export const PERMIT_HEADER = 'x-zenturian-permit';
export const FORWARD_HEADER = 'x-zenturian-forward';
export const ADMIN_HEADER = 'x-zenturian-admin';

const HEX_DIGEST = /^[0-9a-f]{64}$/;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// The body is read and capped before the admission token is examined, so an
// oversized or wrongly typed body is refused at the transport edge.
async function readCappedBody(req) {
  const contentType = req.headers['content-type'] ?? '';
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw new HttpError(415, 'unsupported_media_type', 'content-type must be application/json');
  }

  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new HttpError(413, 'body_too_large', `request body exceeds ${MAX_BODY_BYTES} bytes`);
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new HttpError(413, 'body_too_large', `request body exceeds ${MAX_BODY_BYTES} bytes`);
    }
    chunks.push(chunk);
  }
  if (size === 0) {
    throw new HttpError(400, 'invalid_json', 'request body is required');
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseJsonObject(text, status, code, message) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new HttpError(status, code, message);
  }
  if (!isPlainObject(value)) {
    throw new HttpError(status, code, message);
  }
  return value;
}

function resolveCaller(presented, callers) {
  for (const [token, component] of Object.entries(callers)) {
    if (timingSafeTextEqual(presented, token)) {
      return component;
    }
  }
  return null;
}

function fetchText(url, timeoutMs = 5000) {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      method: 'GET',
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      headers: { connection: 'close' },
      agent: false,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          text: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`request to ${url} timed out after ${timeoutMs}ms`));
    });
    req.on('error', reject);
    req.end();
  });
}

async function fetchPolicy(authServerUrl, hash) {
  if (typeof hash !== 'string' || !HEX_DIGEST.test(hash)) {
    throw new HttpError(403, 'unknown_policy', 'the permit does not name a policy digest');
  }
  let response;
  try {
    response = await fetchText(`${authServerUrl}/v1/policy/${hash}`);
  } catch (error) {
    throw new HttpError(502, 'policy_unavailable', `policy fetch failed: ${error.message}`);
  }
  if (response.status !== 200) {
    throw new HttpError(403, 'unknown_policy', `policy ${hash} is not active`);
  }
  if (sha256Hex(response.text) !== hash) {
    throw new HttpError(502, 'policy_hash_mismatch', 'policy bytes do not match the signed hash');
  }
  if (!response.text.startsWith(POLICY_DOMAIN)) {
    throw new HttpError(502, 'policy_malformed', 'policy bytes lack the policy domain prefix');
  }
  let policy;
  try {
    policy = JSON.parse(response.text.slice(POLICY_DOMAIN.length));
  } catch {
    throw new HttpError(502, 'policy_malformed', 'policy bytes are not a JSON value');
  }
  return policy;
}

async function appendAudit(authServerUrl, adminToken, entry) {
  let response;
  try {
    response = await requestJson(`${authServerUrl}/v1/audit`, {
      method: 'POST',
      headers: { [ADMIN_HEADER]: adminToken },
      body: entry,
    });
  } catch (error) {
    throw new HttpError(502, 'audit_unavailable', `audit append failed: ${error.message}`);
  }
  if (response.status !== 200) {
    throw new HttpError(502, 'audit_unavailable', `audit append failed with status ${response.status}`);
  }
}

async function forwardCall(componentUrl, forwardSecret, call) {
  let response;
  try {
    response = await requestJson(`${componentUrl}/rpc`, {
      method: 'POST',
      headers: { [FORWARD_HEADER]: forwardSecret },
      body: { op: call.op, args: call.args },
    });
  } catch (error) {
    throw new HttpError(502, 'component_unavailable', `forward failed: ${error.message}`);
  }
  return response;
}

function parsePermit(header, publicKey) {
  if (typeof header !== 'string' || header.length === 0) {
    throw new HttpError(401, 'permit_required', 'a permit is required');
  }
  const buffer = fromBase64Url(header);
  if (buffer === null) {
    throw new HttpError(403, 'invalid_permit', 'permit is not base64url');
  }
  const parsed = parseJsonObject(
    buffer.toString('utf8'),
    403,
    'invalid_permit',
    'permit must be a JSON object',
  );
  if (parsed.body === undefined || typeof parsed.sig !== 'string') {
    throw new HttpError(403, 'invalid_permit', 'permit requires body and sig');
  }

  let body;
  try {
    body = canonicalPermitBody(parsed.body);
  } catch (error) {
    if (error instanceof CanonicalError) {
      throw new HttpError(403, 'invalid_permit', error.message);
    }
    throw error;
  }

  const signature = fromBase64Url(parsed.sig);
  if (
    signature === null
    || !verifyEd25519(publicKey, permitSigningBytes(body), signature)
  ) {
    throw new HttpError(403, 'invalid_permit', 'permit signature does not verify');
  }
  return body;
}

export async function createProxy({
  name,
  componentUrl,
  publicKey,
  authServerUrl,
  callers,
  forwardSecret,
  adminToken,
  clock = nowSeconds,
} = {}) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new TypeError('proxy requires a name');
  }
  if (typeof componentUrl !== 'string' || componentUrl.length === 0) {
    throw new TypeError(`${name} proxy requires a componentUrl`);
  }
  if (publicKey === undefined || publicKey === null) {
    throw new TypeError(`${name} proxy requires the auth server public key`);
  }
  if (typeof authServerUrl !== 'string' || authServerUrl.length === 0) {
    throw new TypeError(`${name} proxy requires an authServerUrl`);
  }
  if (!isPlainObject(callers)) {
    throw new TypeError(`${name} proxy requires a caller token map`);
  }
  if (typeof forwardSecret !== 'string' || forwardSecret.length === 0) {
    throw new TypeError(`${name} proxy requires a forward secret`);
  }
  if (typeof adminToken !== 'string' || adminToken.length === 0) {
    throw new TypeError(`${name} proxy requires an admin token`);
  }

  const usedNonces = new Map();

  const service = await createServiceServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method !== 'POST' || url.pathname !== '/v1/call') {
      throw new HttpError(404, 'not_found', 'unknown route');
    }

    // 1. body cap and content type
    const text = await readCappedBody(req);

    // 2. admission token
    const caller = resolveCaller(req.headers[ADMISSION_HEADER], callers);
    if (caller === null) {
      throw new HttpError(401, 'unauthenticated', 'a valid admission token is required');
    }

    // 3. parse and validate the canonical call
    const parsed = parseJsonObject(
      text,
      400,
      'invalid_call',
      'call must be a JSON object',
    );
    let call;
    try {
      call = canonicalCall(parsed);
    } catch (error) {
      if (error instanceof CanonicalError) {
        throw new HttpError(400, 'invalid_call', error.message);
      }
      throw error;
    }

    // 4. permit signature
    const permit = parsePermit(req.headers[PERMIT_HEADER], publicKey);

    // 5. expiry and single-use nonce
    const now = clock();
    if (permit.issuedAt > now) {
      throw new HttpError(403, 'permit_not_yet_valid', 'permit is not yet valid');
    }
    if (now >= permit.expiresAt) {
      throw new HttpError(403, 'permit_expired', 'permit has expired');
    }
    for (const [nonce, expiresAt] of usedNonces) {
      if (expiresAt <= now) {
        usedNonces.delete(nonce);
      }
    }
    if (usedNonces.has(permit.nonce)) {
      throw new HttpError(409, 'replayed', 'permit nonce has already been used');
    }
    usedNonces.set(permit.nonce, permit.expiresAt);

    // 6. policy fetched by the signed hash, verified against that hash
    const policy = await fetchPolicy(authServerUrl, permit.policyHash);

    // 7. recomputed digest and explicit context comparison
    let digest;
    try {
      digest = callDigest(call);
    } catch (error) {
      if (error instanceof CanonicalError) {
        throw new HttpError(400, 'invalid_call', error.message);
      }
      throw error;
    }
    if (digest !== permit.callDigest) {
      throw new HttpError(403, 'digest_mismatch', 'the permit does not bind this call');
    }
    if (permit.caller !== caller || permit.caller !== call.caller) {
      throw new HttpError(403, 'caller_mismatch', 'the permit caller does not match the admission token');
    }
    if (permit.audience !== name || permit.audience !== call.audience) {
      throw new HttpError(403, 'audience_mismatch', `the permit is not for the ${name} proxy`);
    }
    if (
      permit.subject !== call.subject
      || permit.onBehalfOf !== call.onBehalfOf
      || permit.tenant !== call.tenant
    ) {
      throw new HttpError(403, 'context_mismatch', 'the permit context does not match the call');
    }

    // 8. local policy evaluation must match the signed rule
    const decision = decideCall(policy, call);
    if (
      decision.verdict !== 'allow'
      || decision.ruleId !== permit.decision.ruleId
    ) {
      throw new HttpError(403, 'policy_mismatch', 'the local policy decision does not match the permit');
    }

    // 9. forward to the component
    const upstream = await forwardCall(componentUrl, forwardSecret, call);

    // 10. response shape
    if (upstream.body !== null && typeof upstream.body !== 'object') {
      await appendAudit(authServerUrl, adminToken, {
        type: 'call',
        requestId: randomUUID(),
        caller: permit.caller,
        audience: name,
        subject: permit.subject,
        op: call.op,
        policyHash: permit.policyHash,
        nonce: permit.nonce,
        verdict: 'refuse',
        reason: 'invalid_component_response',
      });
      throw new HttpError(502, 'invalid_component_response', 'component response is not a JSON object');
    }

    // 11. audit before responding
    const allowed = upstream.status === 200;
    const entry = {
      type: 'call',
      requestId: randomUUID(),
      caller: permit.caller,
      audience: name,
      subject: permit.subject,
      op: call.op,
      policyHash: permit.policyHash,
      nonce: permit.nonce,
      verdict: allowed ? 'allow' : 'refuse',
    };
    if (!allowed) {
      entry.reason = `component_status_${upstream.status}`;
    }
    await appendAudit(authServerUrl, adminToken, entry);

    // 12. respond with the captured component response
    sendJson(res, upstream.status, upstream.body);
  });

  return service;
}

// The gateway's only way to reach a component: obtain a permit for the exact
// canonical call, then present it with the admission token at that component's
// proxy. The gateway never computes a digest or addresses a component.
export function createGatewayClient({ admissionToken, authServerUrl } = {}) {
  if (typeof admissionToken !== 'string' || admissionToken.length === 0) {
    throw new TypeError('gateway client requires an admission token');
  }
  if (typeof authServerUrl !== 'string' || authServerUrl.length === 0) {
    throw new TypeError('gateway client requires an authServerUrl');
  }

  return {
    async call(proxyUrl, fields) {
      if (typeof proxyUrl !== 'string' || proxyUrl.length === 0) {
        throw new TypeError('gateway call requires a proxy URL');
      }
      const call = canonicalCall({
        v: 1,
        caller: 'gateway',
        audience: fields.audience,
        subject: fields.subject,
        onBehalfOf: fields.onBehalfOf,
        tenant: fields.tenant,
        op: fields.op,
        resource: fields.resource,
        args: fields.args,
      });

      let decided;
      try {
        decided = await requestJson(`${authServerUrl}/v1/decide`, {
          method: 'POST',
          headers: { [ADMISSION_HEADER]: admissionToken },
          body: call,
        });
      } catch (error) {
        throw new HttpError(502, 'broker_unavailable', `permit request failed: ${error.message}`);
      }
      if (decided.status !== 200 || typeof decided.body?.permit !== 'string') {
        return { stage: 'decide', status: decided.status, body: decided.body };
      }

      let response;
      try {
        response = await requestJson(`${proxyUrl}/v1/call`, {
          method: 'POST',
          headers: {
            [ADMISSION_HEADER]: admissionToken,
            [PERMIT_HEADER]: decided.body.permit,
          },
          body: call,
        });
      } catch (error) {
        throw new HttpError(502, 'proxy_unavailable', `mediated call failed: ${error.message}`);
      }
      return {
        stage: 'call',
        status: response.status,
        body: response.body,
        headers: response.headers,
      };
    },
  };
}
