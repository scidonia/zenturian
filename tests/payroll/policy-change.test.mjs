// Policy change: promotion, hash-addressed policy bytes, permits issued across
// a promotion, and the release decision each policy version makes.
//
// The harness assembles the whole system with `startAll` from
// `examples/payroll/src/demo.mjs`: every service binds 127.0.0.1:0 and each
// scenario starts and closes its own system. Date-sensitive scenarios inject the
// epoch second for 2026-11-15T00:00:00Z; the expiry scenario moves a mutable
// injected clock to 2026-12-01T00:00:00Z, and the pending-release scenario acts
// through the coordinator's documented `onBeforeCommit` seam, inside the commit
// lock. The salary detector below is a single function: it must find the
// released amounts on a release view (the affirmative control) and must find
// none in the audit serialization. Nothing here contacts a network service, a
// model, a real clock or the filesystem.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import fixture from '../../examples/payroll/fixture.mjs';
import { startAll } from '../../examples/payroll/src/demo.mjs';
import { requestJson } from '../../examples/payroll/src/http.mjs';
import { diffEffectiveDecisions, policyHash } from '../../examples/payroll/src/policy.mjs';
import { policyV1 } from '../../examples/payroll/src/policy-v1.mjs';
import { policyV2 } from '../../examples/payroll/src/policy-v2.mjs';

const FIXED_EPOCH = Math.floor(Date.parse('2026-11-15T00:00:00Z') / 1000);
const EXPIRED_EPOCH = Math.floor(Date.parse('2026-12-01T00:00:00Z') / 1000);
const SNAPSHOT_ID = 'snap-north-bristol-2026-10';
const APPROVER = 'policy-owner';
const BRISTOL_ROW_IDS = ['L1', 'L2'];
const ADMIN_HEADER = 'x-zenturian-admin';
const ADMISSION_HEADER = 'x-zenturian-admission';
const PERMIT_HEADER = 'x-zenturian-permit';

function fixedClock() {
  return () => FIXED_EPOCH;
}

function formatPence(pence) {
  return `${Math.floor(pence / 100)}.${String(pence % 100).padStart(2, '0')}`;
}

const bristolRows = BRISTOL_ROW_IDS.map(
  (id) => fixture.ledgerRows.find((row) => row.id === id),
);
const expectedRows = bristolRows.map((row) => ({
  employeeRef: row.employeeRef,
  grossPay: formatPence(row.grossPayPence),
}));
const amountLiterals = expectedRows.map((row) => row.grossPay);

const salaryDetector = (text) => amountLiterals.filter((literal) => text.includes(literal));

async function begin(t, options = {}) {
  const system = await startAll(options);
  t.after(() => system.close());
  return system;
}

function devHeaders(principal) {
  return { authorization: `Bearer dev:${principal}` };
}

function openUrl(portalUrl, reportId) {
  return `${portalUrl}/v1/reports/${encodeURIComponent(reportId)}/open`;
}

async function prepareReport(portalUrl) {
  const response = await requestJson(`${portalUrl}/v1/reports`, {
    method: 'POST',
    headers: devHeaders('nora'),
    body: { tenant: 'north', shop: 'north/bristol', period: '2026-10' },
  });
  assert.equal(response.status, 200, 'preparation should succeed');
  assert.equal(typeof response.body?.reportId, 'string', 'preparation should return a report id');
  return response.body.reportId;
}

function openReport(system, reportId, principal) {
  return requestJson(openUrl(system.urls.portal, reportId), {
    headers: devHeaders(principal),
  });
}

function promote(system, policy, approver = APPROVER) {
  return requestJson(`${system.urls.auth}/v1/promote`, {
    method: 'POST',
    headers: { [ADMIN_HEADER]: system.adminToken },
    body: { policy, approver },
  });
}

function readAudit(system) {
  return requestJson(`${system.urls.auth}/v1/audit`, {
    headers: { [ADMIN_HEADER]: system.adminToken },
  });
}

function readActivePolicy(system) {
  return requestJson(`${system.urls.auth}/v1/policy/active`);
}

function assertRefused(response, label) {
  assert.equal(response.status, 403, `${label} should be refused`);
  assert.equal(response.body?.error?.code, 'release_refused', `${label} refusal code`);
  assert.deepEqual(response.body.rows, [], `${label} must carry no rows`);
  assert.equal(response.headers['cache-control'], 'no-store', `${label} must not be cached`);
  assert.deepEqual(salaryDetector(JSON.stringify(response.body)), [], `${label} must carry no amount`);
}

function assertReleased(response, label) {
  assert.equal(response.status, 200, `${label} should be released`);
  assert.deepEqual(response.body.rows, expectedRows, `${label} should carry the two Bristol rows`);
  for (const row of response.body.rows) {
    assert.deepEqual(Object.keys(row), ['employeeRef', 'grossPay'], `${label} row shape`);
  }
  assert.equal(response.headers['cache-control'], 'no-store', `${label} must not be cached`);
}

function decodePermit(permit) {
  return JSON.parse(Buffer.from(permit, 'base64url').toString('utf8'));
}

function snapshotCall() {
  return {
    v: 1,
    caller: 'gateway',
    audience: 'ledger',
    subject: 'alice',
    onBehalfOf: 'alice',
    tenant: 'north',
    op: 'snapshot',
    resource: { type: 'shop', id: 'north/bristol' },
    args: { tenant: 'north', shop: 'north/bristol', period: '2026-10' },
  };
}

function decideSnapshot(system, call) {
  return requestJson(`${system.urls.auth}/v1/decide`, {
    method: 'POST',
    headers: { [ADMISSION_HEADER]: system.tokens.gateway },
    body: call,
  });
}

function ledgerCount(system) {
  return system.ledger.invocations?.rpc ?? 0;
}

test('K1 Dana is refused under v1 and receives the two Bristol rows after v2 is promoted', async (t) => {
  const system = await begin(t, { clock: fixedClock() });
  const reportId = await prepareReport(system.urls.portal);

  const refused = await openReport(system, reportId, 'dana');
  assertRefused(refused, 'Dana under v1');
  assert.deepEqual(salaryDetector(JSON.stringify(refused.body)), [], 'the v1 refusal carries no amount');

  const promotion = await promote(system, policyV2);
  assert.equal(promotion.status, 200, 'the promotion should be accepted');
  const promotedHash = promotion.body.hash;

  const released = await openReport(system, reportId, 'dana');
  assertReleased(released, 'Dana under v2');
  assert.equal(released.body.reportId, reportId, 'the release names the prepared report');
  assert.equal(
    salaryDetector(JSON.stringify(released.body)).length,
    amountLiterals.length,
    'the detector finds both amounts on the release view',
  );

  const audit = await readAudit(system);
  assert.equal(audit.status, 200, 'the audit should be readable');
  const releases = audit.body.entries.filter((entry) => (
    entry.type === 'release'
    && entry.reportId === reportId
    && entry.verdict === 'allow'
  ));
  assert.equal(releases.length, 1, 'exactly one allow release entry for the report');
  const entry = releases[0];
  assert.equal(entry.policyHash, promotedHash, 'the release names the promoted policy');
  assert.deepEqual(entry.rowIds, BRISTOL_ROW_IDS);
  assert.equal(entry.rowCount, 2);
  assert.equal(Object.hasOwn(entry, 'grossPay'), false, 'the entry carries no amount field');
  assert.deepEqual(salaryDetector(JSON.stringify(audit.body.entries)), []);
});

test('K2 a promotion records the approver, timestamp and both policy hashes', async (t) => {
  const system = await begin(t, { clock: fixedClock() });

  const active = await readActivePolicy(system);
  assert.equal(active.status, 200);
  const beforeHash = active.body.hash;

  const promotion = await promote(system, policyV2);
  assert.equal(promotion.status, 200, 'the promotion should be accepted');
  assert.equal(promotion.body.previousHash, beforeHash, 'the promotion names the policy it replaced');
  assert.equal(promotion.body.hash, policyHash(policyV2), 'the promotion hashes the promoted value');
  assert.equal(promotion.body.approver, APPROVER);
  assert.equal(promotion.body.promotedAt, FIXED_EPOCH, 'the promotion uses the injected clock');
  assert.ok(Number.isSafeInteger(promotion.body.audit.seq), 'the promotion names a safe sequence');
  assert.match(promotion.body.audit.digest, /^[0-9a-f]{64}$/);

  const audit = await readAudit(system);
  assert.equal(audit.status, 200);
  const promotions = audit.body.entries.filter((entry) => entry.type === 'promotion');
  assert.equal(promotions.length, 1, 'exactly one promotion is recorded');
  const entry = promotions[0];
  assert.equal(entry.verdict, 'allow');
  assert.equal(entry.caller, 'gateway');
  assert.equal(entry.policyHash, promotion.body.hash);
  assert.equal(entry.previousPolicyHash, beforeHash, 'the entry records the replaced hash');
  assert.equal(entry.approver, APPROVER);
  assert.equal(entry.ts, promotion.body.promotedAt);
  assert.equal(entry.reason, 'policy_promoted');
  assert.equal(entry.seq, promotion.body.audit.seq);
  assert.equal(entry.digest, promotion.body.audit.digest);
  assert.equal(audit.body.verify.ok, true);
});

test('K3 policy bytes are served only under the active hash', async (t) => {
  const system = await begin(t, { clock: fixedClock() });

  const active = await readActivePolicy(system);
  assert.equal(active.status, 200);
  const v1Hash = active.body.hash;

  const servedV1 = await requestJson(`${system.urls.auth}/v1/policy/${v1Hash}`);
  assert.equal(servedV1.status, 200, 'the active v1 bytes are served');
  assert.equal(typeof servedV1.body, 'string');
  assert.equal(
    createHash('sha256').update(Buffer.from(servedV1.body, 'utf8')).digest('hex'),
    v1Hash,
    'the served bytes hash to the hash that names them',
  );
  assert.ok(servedV1.body.startsWith('zenturian.policy.v1\n'));

  const promotion = await promote(system, policyV2);
  assert.equal(promotion.status, 200);
  const v2Hash = promotion.body.hash;

  const retiredV1 = await requestJson(`${system.urls.auth}/v1/policy/${v1Hash}`);
  assert.equal(retiredV1.status, 404, 'the retired hash is no longer served');
  assert.equal(retiredV1.body?.error?.code, 'unknown_policy');

  const servedV2 = await requestJson(`${system.urls.auth}/v1/policy/${v2Hash}`);
  assert.equal(servedV2.status, 200, 'the promoted bytes are served');
  assert.equal(
    createHash('sha256').update(Buffer.from(servedV2.body, 'utf8')).digest('hex'),
    v2Hash,
    'the promoted bytes hash to the promoted hash',
  );

  const activeAfter = await readActivePolicy(system);
  assert.equal(activeAfter.body.hash, v2Hash, 'the active hash is the promoted hash');
});

test('K4 a permit names the active policy hash', async (t) => {
  const system = await begin(t, { clock: fixedClock() });
  const call = snapshotCall();

  const active = await readActivePolicy(system);
  assert.equal(active.status, 200);
  const v1Hash = active.body.hash;

  const decidedUnderV1 = await decideSnapshot(system, call);
  assert.equal(decidedUnderV1.status, 200);
  const permitUnderV1 = decodePermit(decidedUnderV1.body.permit);
  assert.equal(permitUnderV1.body.policyHash, v1Hash, 'the permit names the active v1 policy');

  const promotion = await promote(system, policyV2);
  assert.equal(promotion.status, 200);
  const v2Hash = promotion.body.hash;

  const decidedUnderV2 = await decideSnapshot(system, call);
  assert.equal(decidedUnderV2.status, 200);
  const permitUnderV2 = decodePermit(decidedUnderV2.body.permit);
  assert.equal(permitUnderV2.body.policyHash, v2Hash, 'the permit names the promoted policy');
  assert.equal(permitUnderV2.body.callDigest, decidedUnderV2.body.callDigest);

  const before = ledgerCount(system);
  const presented = await requestJson(`${system.urls.ledgerProxy}/v1/call`, {
    method: 'POST',
    headers: {
      [ADMISSION_HEADER]: system.tokens.gateway,
      [PERMIT_HEADER]: decidedUnderV2.body.permit,
    },
    body: call,
  });
  assert.equal(presented.status, 200, 'the ledger proxy accepts the permit');
  assert.equal(presented.body.snapshot.id, SNAPSHOT_ID);
  assert.equal(ledgerCount(system), before + 1, 'the permit drove one ledger invocation');
});

test('K5 v2 keeps the other principals\' release decisions', async (t) => {
  const system = await begin(t, { clock: fixedClock() });
  const reportId = await prepareReport(system.urls.portal);

  assertReleased(await openReport(system, reportId, 'alice'), 'Alice under v1');
  assertRefused(await openReport(system, reportId, 'cara'), 'Cara under v1');
  assertRefused(await openReport(system, reportId, 'sam'), 'Sam under v1');
  assertRefused(await openReport(system, reportId, 'ben'), 'Ben under v1');

  const promotion = await promote(system, policyV2);
  assert.equal(promotion.status, 200);

  assertReleased(await openReport(system, reportId, 'alice'), 'Alice under v2');
  assertRefused(await openReport(system, reportId, 'cara'), 'Cara under v2');
  assertRefused(await openReport(system, reportId, 'sam'), 'Sam under v2');
  assertRefused(await openReport(system, reportId, 'ben'), 'Ben under v2');

  await system.coordinator.replaceAssignment({
    principal: 'alice',
    role: 'manager',
    tenant: 'north',
    shop: 'north/bristol',
    from: '2026-01-01',
    to: '2026-11-14',
  });
  await system.coordinator.replaceAssignment({
    principal: 'ben',
    role: 'manager',
    tenant: 'north',
    shop: 'north/bristol',
    from: '2026-11-01',
    to: null,
  });

  assertRefused(await openReport(system, reportId, 'alice'), 'Alice after the transfer');
  assertReleased(await openReport(system, reportId, 'ben'), 'Ben after the transfer');
  assertRefused(await openReport(system, reportId, 'cara'), 'Cara after the transfer');
  assertRefused(await openReport(system, reportId, 'sam'), 'Sam after the transfer');
});

test('K6 an expired acting assignment is refused under v2', async (t) => {
  let now = FIXED_EPOCH;
  const system = await begin(t, { clock: () => now });
  const reportId = await prepareReport(system.urls.portal);

  const promotion = await promote(system, policyV2);
  assert.equal(promotion.status, 200);

  assertReleased(await openReport(system, reportId, 'dana'), 'Dana under an active v2 policy');

  now = EXPIRED_EPOCH;

  assertRefused(await openReport(system, reportId, 'dana'), 'Dana after her assignment ends');
});

test('K7 a pending release revalidates against the policy at commit', async (t) => {
  let promoted = false;
  const allowedSystem = await begin(t, {
    clock: fixedClock(),
    onBeforeCommit: async ({ principal, promotePolicy }) => {
      if (principal !== 'alice' || promoted) {
        return;
      }
      promoted = true;
      await promotePolicy(policyV2, APPROVER);
    },
  });
  const allowedReportId = await prepareReport(allowedSystem.urls.portal);

  const v1Active = await readActivePolicy(allowedSystem);
  assert.equal(v1Active.status, 200);
  const v1Hash = v1Active.body.hash;

  const alice = await openReport(allowedSystem, allowedReportId, 'alice');
  assertReleased(alice, 'Alice across the promotion');

  const v2Active = await readActivePolicy(allowedSystem);
  assert.equal(v2Active.status, 200);
  const v2Hash = v2Active.body.hash;
  assert.notEqual(v2Hash, v1Hash);

  const allowedAudit = await readAudit(allowedSystem);
  assert.equal(allowedAudit.status, 200);
  const allowEntry = allowedAudit.body.entries.find((entry) => (
    entry.type === 'release'
    && entry.subject === 'alice'
    && entry.reportId === allowedReportId
  ));
  assert.ok(allowEntry !== undefined, 'the allowed release is recorded');
  assert.equal(allowEntry.verdict, 'allow');
  assert.equal(allowEntry.policyHash, v1Hash, 'the entry names the policy of the first decision');
  assert.equal(allowEntry.commitPolicyHash, v2Hash, 'the entry names the policy at commit');
  assert.equal(allowEntry.reason, 'policy_revalidated');
  assert.deepEqual(allowEntry.rowIds, BRISTOL_ROW_IDS);
  assert.equal(allowEntry.rowCount, 2);

  let reverted = false;
  const deniedSystem = await begin(t, {
    clock: fixedClock(),
    initialPolicy: policyV2,
    onBeforeCommit: async ({ principal, promotePolicy }) => {
      if (principal !== 'dana' || reverted) {
        return;
      }
      reverted = true;
      await promotePolicy(policyV1, APPROVER);
    },
  });
  const deniedReportId = await prepareReport(deniedSystem.urls.portal);

  const v2Initial = await readActivePolicy(deniedSystem);
  assert.equal(v2Initial.status, 200);
  const initialHash = v2Initial.body.hash;

  const control = await openReport(deniedSystem, deniedReportId, 'alice');
  assertReleased(control, 'Alice under the initial v2 policy');
  assert.equal(
    salaryDetector(JSON.stringify(control.body)).length,
    amountLiterals.length,
    'the detector finds both amounts on the control view',
  );

  const dana = await openReport(deniedSystem, deniedReportId, 'dana');
  assertRefused(dana, 'Dana across the reversion');

  const commitActive = await readActivePolicy(deniedSystem);
  assert.equal(commitActive.status, 200);
  const commitHash = commitActive.body.hash;
  assert.equal(commitHash, policyHash(policyV1), 'the commit policy is v1');
  assert.notEqual(commitHash, initialHash);

  const deniedAudit = await readAudit(deniedSystem);
  assert.equal(deniedAudit.status, 200);
  const refuseEntry = deniedAudit.body.entries.find((entry) => (
    entry.type === 'release'
    && entry.subject === 'dana'
    && entry.reportId === deniedReportId
  ));
  assert.ok(refuseEntry !== undefined, 'the refusal is recorded');
  assert.equal(refuseEntry.verdict, 'refuse');
  assert.equal(refuseEntry.policyHash, commitHash, 'the refusal names the commit policy');
  assert.notEqual(refuseEntry.policyHash, initialHash, 'the refusal is not the initial policy');
  assert.equal(refuseEntry.reason, 'recipient_not_permitted');
  assert.deepEqual(salaryDetector(JSON.stringify(deniedAudit.body.entries)), []);
});

test('K8 the fixture diff changes only Dana\'s decision', async (t) => {
  const system = await begin(t, { clock: fixedClock() });

  const active = await readActivePolicy(system);
  assert.equal(active.status, 200);
  const v1Hash = active.body.hash;

  const promotion = await promote(system, policyV2);
  assert.equal(promotion.status, 200);
  const v2Hash = promotion.body.hash;

  const result = diffEffectiveDecisions();

  assert.equal(result.label, 'fixture coverage');
  assert.equal(result.coverage, 'fixture');
  assert.equal(result.from.hash, v1Hash, 'the diff starts from the observed v1 policy');
  assert.equal(result.to.hash, v2Hash, 'the diff ends at the promoted v2 policy');
  assert.equal(
    result.decisions.length,
    fixture.principals.length * fixture.shops.length * result.states.length,
  );
  assert.equal(result.changedCount, 1, 'exactly one decision changes');
  assert.equal(result.changes.length, 1);

  const [change] = result.changes;
  assert.equal(change.principal, 'dana');
  assert.equal(change.tenant, 'north');
  assert.equal(change.shop, 'north/bristol');
  assert.equal(change.state, 'acting-assignment-active');
  assert.equal(change.from.verdict, 'deny');
  assert.equal(change.to.verdict, 'allow');

  for (const decision of result.decisions) {
    if (decision === change) {
      continue;
    }
    assert.equal(
      decision.changed,
      false,
      `${decision.principal} at ${decision.shop} in ${decision.state} should not change`,
    );
    assert.equal(decision.from.verdict, decision.to.verdict);
  }

  const stateLabels = result.states.map((state) => state.label);
  const decisionAt = (principal, shop, state) => {
    const decision = result.decisions.find((candidate) => (
      candidate.principal === principal
      && candidate.shop === shop
      && candidate.state === state
    ));
    assert.ok(decision, `a decision exists for ${principal} at ${shop} in ${state}`);
    return decision;
  };
  const assertVerdicts = (principal, shop, fromVerdict, toVerdict, states = stateLabels) => {
    for (const state of states) {
      const decision = decisionAt(principal, shop, state);
      assert.equal(
        decision.from.verdict,
        fromVerdict,
        `${principal} at ${shop} in ${state} starts ${fromVerdict}`,
      );
      assert.equal(
        decision.to.verdict,
        toVerdict,
        `${principal} at ${shop} in ${state} ends ${toVerdict}`,
      );
    }
  };

  assertVerdicts('alice', 'north/bristol', 'allow', 'allow');
  assertVerdicts('cara', 'north/cardiff', 'allow', 'allow');
  assertVerdicts('cara', 'north/bristol', 'deny', 'deny');
  assertVerdicts('sam', 'south/bristol', 'allow', 'allow');
  assertVerdicts('sam', 'north/bristol', 'deny', 'deny');
  assertVerdicts('nora', 'north/bristol', 'deny', 'deny');
  assertVerdicts('ben', 'north/bristol', 'deny', 'deny');
  assertVerdicts(
    'dana',
    'north/bristol',
    'deny',
    'deny',
    ['before-acting-assignment', 'after-assignment-expiry'],
  );
});
