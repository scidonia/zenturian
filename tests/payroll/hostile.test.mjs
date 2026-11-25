// Hostile payroll release: direct access, admission misuse, permit misuse and
// policy replacement.
//
// Every scenario drives the system through its loopback HTTP surfaces only. The
// harness selects the assembly by capability: on a tree with the auth server the
// system is assembled by `startAll`; on the earlier direct baseline only the four
// baseline services exist. Scenarios whose subject is the proxy, the broker or a
// forward-secret check the baseline lacks report prerequisite-blocked instead of
// pretending to run.

import test from 'node:test';
import assert from 'node:assert/strict';

import fixture from '../../examples/payroll/fixture.mjs';
import { requestJson } from '../../examples/payroll/src/http.mjs';

const FIXED_EPOCH = Math.floor(Date.parse('2026-11-15T00:00:00Z') / 1000);
const SRC = new URL('../../examples/payroll/src/', import.meta.url);

function fixedClock() {
  return () => FIXED_EPOCH;
}

const bristolSnapshotId = fixture.snapshots.find((snapshot) => (
  snapshot.tenant === 'north'
  && snapshot.shop === 'north/bristol'
  && snapshot.period === '2026-10'
)).id;

async function startSystem(options = {}) {
  let hasBroker = false;
  try {
    await import(new URL('auth-server.mjs', SRC));
    hasBroker = true;
  } catch (error) {
    if (error?.code !== 'ERR_MODULE_NOT_FOUND') {
      throw error;
    }
  }

  if (hasBroker) {
    const { startAll } = await import(new URL('demo.mjs', SRC));
    const system = await startAll(options);
    return { ...system, mediated: true };
  }

  const { createServer: createDirectory } = await import(new URL('directory.mjs', SRC));
  const { createServer: createLedger } = await import(new URL('ledger.mjs', SRC));
  const { createServer: createReporting } = await import(new URL('reporting.mjs', SRC));
  const { createServer: createPortal } = await import(new URL('portal.mjs', SRC));

  const dateClock = options.clock === undefined
    ? () => new Date()
    : () => new Date(options.clock() * 1000);

  const directory = await createDirectory({ clock: dateClock });
  const ledger = await createLedger();
  const reporting = await createReporting({ ledgerUrl: ledger.url });
  const portal = await createPortal({
    directoryUrl: directory.url,
    reportingUrl: reporting.url,
    clock: dateClock,
  });
  const services = [directory, ledger, reporting, portal];

  return {
    mediated: false,
    urls: {
      directory: directory.url,
      ledger: ledger.url,
      reporting: reporting.url,
      portal: portal.url,
    },
    tokens: {},
    forwardSecrets: {},
    directory,
    ledger,
    reporting,
    portal,
    async close() {
      await Promise.all(services.map((service) => service.close()));
    },
  };
}

async function begin(t, options = {}) {
  const system = await startSystem(options);
  t.after(() => system.close());
  return system;
}

function requireMediated(system, t, reason) {
  if (system.mediated) {
    return true;
  }
  t.skip(`prerequisite-blocked: ${reason}`);
  return false;
}

function devHeaders(principal) {
  return { authorization: `Bearer dev:${principal}` };
}

async function prepareReport(portalUrl, principal = 'nora') {
  const response = await requestJson(`${portalUrl}/v1/reports`, {
    method: 'POST',
    headers: devHeaders(principal),
    body: { tenant: 'north', shop: 'north/bristol', period: '2026-10' },
  });
  assert.equal(response.status, 200, 'preparation should succeed');
  assert.equal(typeof response.body?.reportId, 'string', 'preparation should return a report id');
  return response.body.reportId;
}

function snapshotCall(subject = 'alice') {
  return {
    v: 1,
    caller: 'gateway',
    audience: 'ledger',
    subject,
    onBehalfOf: subject,
    tenant: 'north',
    op: 'snapshot',
    resource: { type: 'shop', id: 'north/bristol' },
    args: { tenant: 'north', shop: 'north/bristol', period: '2026-10' },
  };
}

function rowsCall() {
  return {
    v: 1,
    caller: 'gateway',
    audience: 'ledger',
    subject: 'alice',
    onBehalfOf: 'alice',
    tenant: 'north',
    op: 'rows',
    resource: { type: 'ledger-scope', id: bristolSnapshotId },
    args: {
      tenant: 'north',
      shop: 'north/bristol',
      period: '2026-10',
      snapshotId: bristolSnapshotId,
    },
  };
}

function ledgerCount(system) {
  return system.ledger.invocations?.rpc ?? 0;
}

async function decideAs(system, token, call) {
  return requestJson(`${system.urls.auth}/v1/decide`, {
    method: 'POST',
    headers: { 'x-zenturian-admission': token },
    body: call,
  });
}

async function present(system, proxyUrl, admissionToken, permit, call) {
  return requestJson(`${proxyUrl}/v1/call`, {
    method: 'POST',
    headers: {
      'x-zenturian-admission': admissionToken,
      'x-zenturian-permit': permit,
    },
    body: call,
  });
}

test('H1 the ledger proxy refuses a call with no admission token', async (t) => {
  const system = await begin(t, { clock: fixedClock() });
  if (!requireMediated(system, t, 'the ledger proxy does not exist')) {
    return;
  }
  const call = snapshotCall();
  const before = ledgerCount(system);

  const refused = await requestJson(`${system.urls.ledgerProxy}/v1/call`, {
    method: 'POST',
    body: call,
  });
  assert.equal(refused.status, 401);
  assert.equal(refused.body?.error?.code, 'unauthenticated');
  assert.equal(ledgerCount(system), before);

  const { createGatewayClient } = await import(new URL('proxy.mjs', SRC));
  const gateway = createGatewayClient({
    admissionToken: system.tokens.gateway,
    authServerUrl: system.urls.auth,
  });
  const allowed = await gateway.call(system.urls.ledgerProxy, {
    audience: 'ledger',
    subject: 'alice',
    onBehalfOf: 'alice',
    tenant: 'north',
    op: 'snapshot',
    resource: { type: 'shop', id: 'north/bristol' },
    args: { tenant: 'north', shop: 'north/bristol', period: '2026-10' },
  });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.body.snapshot.id, bristolSnapshotId);
  assert.equal(ledgerCount(system), before + 1);
});

test('H2 another component\'s admission token does not open the ledger proxy', async (t) => {
  const system = await begin(t, { clock: fixedClock() });
  if (!requireMediated(system, t, 'the ledger proxy does not exist')) {
    return;
  }
  const call = snapshotCall();
  const before = ledgerCount(system);

  const refused = await requestJson(`${system.urls.ledgerProxy}/v1/call`, {
    method: 'POST',
    headers: { 'x-zenturian-admission': system.tokens.reporting },
    body: call,
  });
  assert.equal(refused.status, 401);
  assert.equal(refused.body?.error?.code, 'unauthenticated');
  assert.equal(ledgerCount(system), before);

  const { createGatewayClient } = await import(new URL('proxy.mjs', SRC));
  const gateway = createGatewayClient({
    admissionToken: system.tokens.gateway,
    authServerUrl: system.urls.auth,
  });
  const allowed = await gateway.call(system.urls.ledgerProxy, {
    audience: 'ledger',
    subject: 'alice',
    onBehalfOf: 'alice',
    tenant: 'north',
    op: 'snapshot',
    resource: { type: 'shop', id: 'north/bristol' },
    args: { tenant: 'north', shop: 'north/bristol', period: '2026-10' },
  });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.body.snapshot.id, bristolSnapshotId);
  assert.equal(ledgerCount(system), before + 1);
});

test('H3 the ledger refuses a direct call without its forward secret', async (t) => {
  const system = await begin(t, { clock: fixedClock() });
  const before = ledgerCount(system);

  const refused = await requestJson(`${system.urls.ledger}/rpc`, {
    method: 'POST',
    body: { op: 'rows', args: { tenant: 'north', period: '2026-10' } },
  });
  assert.equal(refused.status, 401);
  assert.equal(refused.body?.error?.code, 'forward_secret_required');
  assert.equal(ledgerCount(system), before);

  const allowed = await requestJson(`${system.urls.ledger}/rpc`, {
    method: 'POST',
    headers: { 'x-zenturian-forward': system.forwardSecrets.ledger ?? '' },
    body: {
      op: 'snapshot',
      args: { tenant: 'north', shop: 'north/bristol', period: '2026-10' },
    },
  });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.body?.snapshot?.id, bristolSnapshotId);
});

test('H4 reporting cannot obtain a permit for a ledger call', async (t) => {
  const system = await begin(t, { clock: fixedClock() });
  if (!requireMediated(system, t, 'the broker and the ledger proxy do not exist')) {
    return;
  }
  const call = { ...rowsCall(), caller: 'reporting' };
  const before = ledgerCount(system);

  const refused = await decideAs(system, system.tokens.reporting, call);
  assert.equal(refused.status, 403);
  assert.equal(refused.body?.error?.code, 'denied');
  assert.equal(ledgerCount(system), before);

  const control = { ...call, caller: 'gateway' };
  const decided = await decideAs(system, system.tokens.gateway, control);
  assert.equal(decided.status, 200);
  assert.equal(typeof decided.body?.permit, 'string');
  assert.ok(decided.body.permit.length > 0);

  const forwarded = await present(
    system,
    system.urls.ledgerProxy,
    system.tokens.gateway,
    decided.body.permit,
    control,
  );
  assert.equal(forwarded.status, 200);
  assert.ok(Array.isArray(forwarded.body.rows));
  assert.ok(forwarded.body.rows.length > 0);
  assert.equal(ledgerCount(system), before + 1);
});

test('H5 a permit for the directory is refused at the ledger proxy', async (t) => {
  const system = await begin(t, { clock: fixedClock() });
  if (!requireMediated(system, t, 'the proxies do not exist')) {
    return;
  }
  const call = {
    v: 1,
    caller: 'gateway',
    audience: 'directory',
    subject: 'alice',
    onBehalfOf: 'alice',
    tenant: 'north',
    op: 'assignments',
    resource: { type: 'shop', id: 'north/bristol' },
    args: { tenant: 'north', shop: 'north/bristol' },
  };

  const decided = await decideAs(system, system.tokens.gateway, call);
  assert.equal(decided.status, 200);
  assert.equal(typeof decided.body?.permit, 'string');

  const before = ledgerCount(system);
  const refused = await present(
    system,
    system.urls.ledgerProxy,
    system.tokens.gateway,
    decided.body.permit,
    call,
  );
  assert.equal(refused.status, 403);
  assert.equal(refused.body?.error?.code, 'audience_mismatch');
  assert.equal(ledgerCount(system), before);

  const control = await present(
    system,
    system.urls.directoryProxy,
    system.tokens.gateway,
    decided.body.permit,
    call,
  );
  assert.equal(control.status, 200);
  assert.ok(Array.isArray(control.body.assignments));
  assert.ok(control.body.assignments.length > 0);
});

test('H6 a call changed after its permit is refused', async (t) => {
  const system = await begin(t, { clock: fixedClock() });
  if (!requireMediated(system, t, 'the ledger proxy does not exist')) {
    return;
  }
  const call = snapshotCall();
  const decided = await decideAs(system, system.tokens.gateway, call);
  assert.equal(decided.status, 200);

  const tampered = { ...call, args: { ...call.args, period: '2026-09' } };
  const before = ledgerCount(system);
  const refused = await present(
    system,
    system.urls.ledgerProxy,
    system.tokens.gateway,
    decided.body.permit,
    tampered,
  );
  assert.equal(refused.status, 403);
  assert.equal(refused.body?.error?.code, 'digest_mismatch');
  assert.equal(ledgerCount(system), before);

  const fresh = await decideAs(system, system.tokens.gateway, call);
  assert.equal(fresh.status, 200);
  const control = await present(
    system,
    system.urls.ledgerProxy,
    system.tokens.gateway,
    fresh.body.permit,
    call,
  );
  assert.equal(control.status, 200);
  assert.equal(control.body.snapshot.id, bristolSnapshotId);
});

test('H7 a permit signed by another key is refused', async (t) => {
  const system = await begin(t, { clock: fixedClock() });
  if (!requireMediated(system, t, 'the ledger proxy does not exist')) {
    return;
  }
  const call = snapshotCall();
  const canonical = await import(new URL('canonical.mjs', SRC));
  const keys = await import(new URL('keys.mjs', SRC));
  const attacker = keys.generateSigningKeys();

  const body = canonical.canonicalPermitBody({
    v: 1,
    policyHash: system.policyHash,
    callDigest: canonical.callDigest(call),
    caller: 'gateway',
    audience: 'ledger',
    subject: 'alice',
    onBehalfOf: 'alice',
    tenant: 'north',
    issuedAt: FIXED_EPOCH,
    expiresAt: FIXED_EPOCH + 30,
    nonce: keys.randomToken(16),
    decision: { verdict: 'allow', ruleId: 'ledger.snapshot' },
  });
  const signature = keys.signEd25519(attacker.privateKey, canonical.permitSigningBytes(body));
  const forged = keys.toBase64Url(Buffer.from(canonical.zcanon({
    body,
    sig: keys.toBase64Url(signature),
  }), 'utf8'));

  const before = ledgerCount(system);
  const refused = await present(
    system,
    system.urls.ledgerProxy,
    system.tokens.gateway,
    forged,
    call,
  );
  assert.equal(refused.status, 403);
  assert.equal(refused.body?.error?.code, 'invalid_permit');
  assert.equal(ledgerCount(system), before);

  const decided = await decideAs(system, system.tokens.gateway, call);
  assert.equal(decided.status, 200);
  const control = await present(
    system,
    system.urls.ledgerProxy,
    system.tokens.gateway,
    decided.body.permit,
    call,
  );
  assert.equal(control.status, 200);
  assert.equal(control.body.snapshot.id, bristolSnapshotId);
});

test('H8 an expired permit is refused', async (t) => {
  let now = FIXED_EPOCH;
  const system = await begin(t, { clock: () => now });
  if (!requireMediated(system, t, 'the ledger proxy does not exist')) {
    return;
  }
  const call = snapshotCall();
  const decided = await decideAs(system, system.tokens.gateway, call);
  assert.equal(decided.status, 200);

  const control = await present(
    system,
    system.urls.ledgerProxy,
    system.tokens.gateway,
    decided.body.permit,
    call,
  );
  assert.equal(control.status, 200);
  assert.equal(control.body.snapshot.id, bristolSnapshotId);
  const used = ledgerCount(system);
  assert.equal(used, 1);

  now = FIXED_EPOCH + 31;
  const refused = await present(
    system,
    system.urls.ledgerProxy,
    system.tokens.gateway,
    decided.body.permit,
    call,
  );
  assert.equal(refused.status, 403);
  assert.equal(refused.body?.error?.code, 'permit_expired');
  assert.equal(ledgerCount(system), used);
});

test('H9 a permit cannot be replayed', async (t) => {
  const system = await begin(t, { clock: fixedClock() });
  if (!requireMediated(system, t, 'the ledger proxy does not exist')) {
    return;
  }
  const call = snapshotCall();
  const decided = await decideAs(system, system.tokens.gateway, call);
  assert.equal(decided.status, 200);

  const first = await present(
    system,
    system.urls.ledgerProxy,
    system.tokens.gateway,
    decided.body.permit,
    call,
  );
  assert.equal(first.status, 200);
  assert.equal(ledgerCount(system), 1);

  const second = await present(
    system,
    system.urls.ledgerProxy,
    system.tokens.gateway,
    decided.body.permit,
    call,
  );
  assert.equal(second.status, 409);
  assert.equal(second.body?.error?.code, 'replayed');
  assert.equal(ledgerCount(system), 1);
});

test('H10 an inactive policy hash is not served', async (t) => {
  const system = await begin(t, { clock: fixedClock() });
  if (!requireMediated(system, t, 'the broker policy route does not exist')) {
    return;
  }
  const { createHash } = await import('node:crypto');
  const inactiveHash = createHash('sha256').update('inactive-policy').digest('hex');

  const refused = await requestJson(`${system.urls.auth}/v1/policy/${inactiveHash}`);
  assert.equal(refused.status, 404);
  assert.equal(refused.body?.error?.code, 'unknown_policy');

  const control = await requestJson(`${system.urls.auth}/v1/policy/${system.policyHash}`);
  assert.equal(control.status, 200);
  assert.equal(typeof control.body, 'string');
  const digest = createHash('sha256').update(Buffer.from(control.body, 'utf8')).digest('hex');
  assert.equal(digest, system.policyHash);
  assert.ok(control.body.startsWith('zenturian.policy.v1\n'));
});

test('H11 direct component calls need the forward secret', async (t) => {
  const system = await begin(t, { clock: fixedClock() });
  const reportId = await prepareReport(system.urls.portal);

  const before = {
    reporting: system.reporting.invocations?.rpc ?? 0,
    directory: system.directory.invocations?.rpc ?? 0,
    ledger: ledgerCount(system),
  };
  const counts = () => ({
    reporting: system.reporting.invocations?.rpc ?? 0,
    directory: system.directory.invocations?.rpc ?? 0,
    ledger: ledgerCount(system),
  });

  const reportingRefused = await requestJson(`${system.urls.reporting}/rpc`, {
    method: 'POST',
    body: { op: 'get', args: { reportId } },
  });
  assert.equal(reportingRefused.status, 401);
  assert.equal(reportingRefused.body?.error?.code, 'forward_secret_required');
  assert.deepEqual(counts(), before);

  const directoryRefused = await requestJson(`${system.urls.directory}/rpc`, {
    method: 'POST',
    body: { op: 'principal', args: { principal: 'alice' } },
  });
  assert.equal(directoryRefused.status, 401);
  assert.equal(directoryRefused.body?.error?.code, 'forward_secret_required');
  assert.deepEqual(counts(), before);

  const ledgerRefused = await requestJson(`${system.urls.ledger}/rpc`, {
    method: 'POST',
    body: {
      op: 'rows',
      args: { tenant: 'north', shop: 'north/bristol', period: '2026-10' },
    },
  });
  assert.equal(ledgerRefused.status, 401);
  assert.equal(ledgerRefused.body?.error?.code, 'forward_secret_required');
  assert.deepEqual(counts(), before);

  const reportingControl = await requestJson(`${system.urls.reporting}/rpc`, {
    method: 'POST',
    headers: { 'x-zenturian-forward': system.forwardSecrets.reporting ?? '' },
    body: {
      op: 'store',
      args: { reportId: `${reportId}-control`, title: 'H11 control', status: 'prepared' },
    },
  });
  assert.equal(reportingControl.status, 200);
  assert.deepEqual(reportingControl.body, { ok: true });

  const directoryControl = await requestJson(`${system.urls.directory}/rpc`, {
    method: 'POST',
    headers: { 'x-zenturian-forward': system.forwardSecrets.directory ?? '' },
    body: { op: 'principal', args: { principal: 'alice' } },
  });
  assert.equal(directoryControl.status, 200);

  const ledgerControl = await requestJson(`${system.urls.ledger}/rpc`, {
    method: 'POST',
    headers: { 'x-zenturian-forward': system.forwardSecrets.ledger ?? '' },
    body: {
      op: 'snapshot',
      args: { tenant: 'north', shop: 'north/bristol', period: '2026-10' },
    },
  });
  assert.equal(ledgerControl.status, 200);
  assert.equal(ledgerControl.body?.snapshot?.id, bristolSnapshotId);
});

test('H12 reporting has no prepare or get operation behind its proxy', async (t) => {
  const system = await begin(t, { clock: fixedClock() });
  const forward = { 'x-zenturian-forward': system.forwardSecrets.reporting ?? '' };
  const reportId = 'report-h12';

  const prepared = await requestJson(`${system.urls.reporting}/rpc`, {
    method: 'POST',
    headers: forward,
    body: {
      op: 'prepare',
      args: {
        reportId,
        title: 'H12 report',
        tenant: 'north',
        shop: 'north/bristol',
        period: '2026-10',
      },
    },
  });
  assert.equal(prepared.status, 400);
  assert.equal(prepared.body?.error?.code, 'unknown_op');

  const fetched = await requestJson(`${system.urls.reporting}/rpc`, {
    method: 'POST',
    headers: forward,
    body: { op: 'get', args: { reportId } },
  });
  assert.equal(fetched.status, 400);
  assert.equal(fetched.body?.error?.code, 'unknown_op');

  const stored = await requestJson(`${system.urls.reporting}/rpc`, {
    method: 'POST',
    headers: forward,
    body: { op: 'store', args: { reportId, title: 'H12 report', status: 'prepared' } },
  });
  assert.equal(stored.status, 200);
  assert.deepEqual(stored.body, { ok: true });
});

test('H13 a permit for a retired policy hash is refused', async (t) => {
  const system = await begin(t, { clock: fixedClock() });
  if (!requireMediated(system, t, 'the ledger proxy and policy broker do not exist')) {
    return;
  }
  const { policyV2 } = await import(new URL('policy-v2.mjs', SRC));
  const admin = { 'x-zenturian-admin': system.adminToken };

  const active = await requestJson(`${system.urls.auth}/v1/policy/active`);
  assert.equal(active.status, 200);
  const staleHash = active.body.hash;
  assert.match(staleHash, /^[0-9a-f]{64}$/);

  const call = snapshotCall();
  const decided = await decideAs(system, system.tokens.gateway, call);
  assert.equal(decided.status, 200);
  const staleBody = JSON.parse(
    Buffer.from(decided.body.permit, 'base64url').toString('utf8'),
  ).body;
  assert.equal(staleBody.policyHash, staleHash);

  const before = ledgerCount(system);

  const promoted = await requestJson(`${system.urls.auth}/v1/promote`, {
    method: 'POST',
    headers: admin,
    body: { policy: policyV2, approver: 'policy-owner' },
  });
  assert.equal(promoted.status, 200);
  assert.equal(promoted.body.previousHash, staleHash);
  assert.match(promoted.body.hash, /^[0-9a-f]{64}$/);
  assert.notEqual(promoted.body.hash, staleHash);

  const refused = await present(
    system,
    system.urls.ledgerProxy,
    system.tokens.gateway,
    decided.body.permit,
    call,
  );
  assert.equal(refused.status, 403);
  assert.equal(refused.body?.error?.code, 'unknown_policy');
  assert.equal(ledgerCount(system), before);

  const freshDecision = await decideAs(system, system.tokens.gateway, call);
  assert.equal(freshDecision.status, 200);
  const freshBody = JSON.parse(
    Buffer.from(freshDecision.body.permit, 'base64url').toString('utf8'),
  ).body;
  assert.equal(freshBody.policyHash, promoted.body.hash);

  const control = await present(
    system,
    system.urls.ledgerProxy,
    system.tokens.gateway,
    freshDecision.body.permit,
    call,
  );
  assert.equal(control.status, 200);
  assert.equal(control.body.snapshot.id, 'snap-north-bristol-2026-10');
  assert.equal(ledgerCount(system), before + 1);
});
