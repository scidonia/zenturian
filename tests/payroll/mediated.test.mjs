// Mediated payroll release: recipient, authoritative row scope, fact
// revalidation and the audit record.
//
// Every scenario drives the system through its loopback HTTP surfaces only. The
// harness selects the assembly by capability: on a tree with the auth server the
// system is assembled by `startAll`; on the earlier direct baseline only the four
// baseline services exist. Scenarios whose subject is the mediated path report
// prerequisite-blocked on the direct baseline instead of pretending to run.

import test from 'node:test';
import assert from 'node:assert/strict';

import fixture from '../../examples/payroll/fixture.mjs';
import { requestJson } from '../../examples/payroll/src/http.mjs';

const FIXED_EPOCH = Math.floor(Date.parse('2026-11-15T00:00:00Z') / 1000);
const SRC = new URL('../../examples/payroll/src/', import.meta.url);

function fixedClock() {
  return () => FIXED_EPOCH;
}

function formatPence(pence) {
  return `${Math.floor(pence / 100)}.${String(pence % 100).padStart(2, '0')}`;
}

const bristolRowIds = ['L1', 'L2'];
const bristolRows = bristolRowIds.map((id) => fixture.ledgerRows.find((row) => row.id === id));
const expectedRows = bristolRows.map((row) => ({
  employeeRef: row.employeeRef,
  grossPay: formatPence(row.grossPayPence),
}));
const amountLiterals = expectedRows.map((row) => row.grossPay);
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

function openUrl(portalUrl, reportId) {
  return `${portalUrl}/v1/reports/${encodeURIComponent(reportId)}/open`;
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

function assertNoAmounts(body) {
  const text = JSON.stringify(body);
  for (const literal of amountLiterals) {
    assert.ok(
      !text.includes(literal),
      `a refusal must not carry the amount ${literal}`,
    );
  }
}

test('M1 Alice receives exactly the two Bristol October rows', async (t) => {
  const system = await begin(t, { clock: fixedClock() });
  const reportId = await prepareReport(system.urls.portal);

  const e102 = fixture.employees.find((employee) => employee.employeeRef === 'E102');
  assert.equal(e102.currentShop, 'north/cardiff');
  const l2 = fixture.ledgerRows.find((row) => row.id === 'L2');
  assert.equal(l2.employeeRef, 'E102');
  assert.equal(l2.tenant, 'north');
  assert.equal(l2.shop, 'north/bristol');
  assert.equal(l2.period, '2026-10');

  const response = await requestJson(openUrl(system.urls.portal, reportId), {
    headers: devHeaders('alice'),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(response.body.rows, expectedRows);
  for (const row of response.body.rows) {
    assert.deepEqual(Object.keys(row), ['employeeRef', 'grossPay']);
  }
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.body.reportId, reportId);
  const refs = response.body.rows.map((row) => row.employeeRef);
  assert.ok(!refs.includes('E103'), 'the Cardiff row must not be released');
  assert.ok(!refs.includes('E104'), 'the South row must not be released');
});

test('M2 Nora is refused the report she prepared', async (t) => {
  const system = await begin(t, { clock: fixedClock() });
  const reportId = await prepareReport(system.urls.portal);

  const response = await requestJson(openUrl(system.urls.portal, reportId), {
    headers: devHeaders('nora'),
  });

  assert.equal(response.status, 403);
  assert.equal(response.body?.error?.code, 'release_refused');
  assert.deepEqual(response.body.rows, []);
  assert.equal(response.headers['cache-control'], 'no-store');
  assertNoAmounts(response.body);
});

test('M3 a request body cannot select the reader', async (t) => {
  const system = await begin(t, { clock: fixedClock() });
  if (!requireMediated(system, t, 'the mediated portal POST open route does not exist')) {
    return;
  }
  const reportId = await prepareReport(system.urls.portal);

  const refused = await requestJson(openUrl(system.urls.portal, reportId), {
    method: 'POST',
    headers: devHeaders('nora'),
    body: { reader: 'alice' },
  });

  assert.equal(refused.status, 403);
  assert.equal(refused.body?.error?.code, 'release_refused');
  assert.deepEqual(refused.body.rows, []);
  assert.equal(refused.headers['cache-control'], 'no-store');
  assertNoAmounts(refused.body);

  const control = await requestJson(openUrl(system.urls.portal, reportId), {
    method: 'POST',
    headers: devHeaders('alice'),
    body: { reader: 'nora' },
  });
  assert.equal(control.status, 200);
  assert.deepEqual(control.body.rows, expectedRows);
  assert.equal(control.headers['cache-control'], 'no-store');
});

test('M4 a manager of another shop is refused', async (t) => {
  const system = await begin(t, { clock: fixedClock() });
  const reportId = await prepareReport(system.urls.portal);

  for (const principal of ['cara', 'sam']) {
    const response = await requestJson(openUrl(system.urls.portal, reportId), {
      headers: devHeaders(principal),
    });
    assert.equal(response.status, 403, `${principal} should be refused`);
    assert.equal(response.body?.error?.code, 'release_refused');
    assert.deepEqual(response.body.rows, []);
    assert.equal(response.headers['cache-control'], 'no-store');
    assertNoAmounts(response.body);
  }

  const control = await requestJson(openUrl(system.urls.portal, reportId), {
    headers: devHeaders('alice'),
  });
  assert.equal(control.status, 200);
  assert.deepEqual(control.body.rows, expectedRows);
});

test('M5 an authoritative row outside the charged shop refuses the release', async (t) => {
  const authority = ['L1', 'L2', 'L3'].map((id) => fixture.ledgerRows.find((row) => row.id === id));

  const mixedSnapshot = {
    id: bristolSnapshotId,
    tenant: 'north',
    shop: 'north/bristol',
    period: '2026-10',
    rowIds: ['L1', 'L2', 'L3'],
  };
  let reads = 0;
  let supplied;
  const ledgerRead = async () => {
    reads += 1;
    supplied = {
      snapshot: { ...mixedSnapshot, rowIds: [...mixedSnapshot.rowIds] },
      rows: structuredClone(authority),
    };
    return supplied;
  };

  const contaminated = await begin(t, { clock: fixedClock(), ledgerRead });
  if (!requireMediated(contaminated, t, 'the release coordinator and its row checks do not exist')) {
    return;
  }
  const contaminatedReport = await prepareReport(contaminated.urls.portal);

  const refused = await requestJson(
    openUrl(contaminated.urls.portal, contaminatedReport),
    { headers: devHeaders('alice') },
  );

  assert.equal(refused.status, 409);
  assert.equal(refused.body?.error?.code, 'row_scope_mismatch');
  assert.deepEqual(refused.body.rows, []);
  assert.equal(refused.headers['cache-control'], 'no-store');
  assertNoAmounts(refused.body);
  assert.equal(reads, 1, 'the refused release read the supplied rows');

  assert.ok(supplied !== undefined, 'the release read the injected ledger');
  assert.deepEqual(
    supplied.rows,
    ['L1', 'L2', 'L3'].map((id) => fixture.ledgerRows.find((row) => row.id === id)),
    'the supplied rows must be the authoritative fixture rows',
  );
  assert.deepEqual(supplied.snapshot.rowIds, ['L1', 'L2', 'L3']);
  assert.equal(supplied.rows[2].shop, 'north/cardiff');

  const clean = await begin(t, { clock: fixedClock() });
  const cleanReport = await prepareReport(clean.urls.portal);
  const control = await requestJson(openUrl(clean.urls.portal, cleanReport), {
    headers: devHeaders('alice'),
  });
  assert.equal(control.status, 200);
  assert.deepEqual(control.body.rows, expectedRows);
});

test('M6 the release is audited without salary values', async (t) => {
  const system = await begin(t, { clock: fixedClock() });
  if (!requireMediated(system, t, 'the broker audit log does not exist')) {
    return;
  }
  const reportId = await prepareReport(system.urls.portal);

  const released = await requestJson(openUrl(system.urls.portal, reportId), {
    headers: devHeaders('alice'),
  });
  assert.equal(released.status, 200);
  assert.deepEqual(released.body.rows, expectedRows);

  const audit = await requestJson(`${system.urls.auth}/v1/audit`, {
    headers: { 'x-zenturian-admin': system.adminToken },
  });
  assert.equal(audit.status, 200);
  assert.equal(audit.body.verify.ok, true);

  const releases = audit.body.entries.filter(
    (entry) => entry.type === 'release' && entry.reportId === reportId,
  );
  assert.equal(releases.length, 1, 'exactly one release entry for the report');
  const entry = releases[0];

  assert.equal(entry.verdict, 'allow');
  assert.equal(typeof entry.requestId, 'string');
  assert.ok(entry.requestId.length > 0, 'the release record names its request');
  assert.equal(entry.caller, 'gateway');
  assert.deepEqual(entry.rowIds, bristolRowIds);
  assert.equal(entry.rowCount, 2);
  assert.equal(entry.subject, 'alice');
  assert.equal(entry.recipient, 'alice');
  assert.equal(entry.snapshotId, bristolSnapshotId);
  assert.match(entry.policyHash, /^[0-9a-f]{64}$/);
  assert.equal(entry.policyHash, system.policyHash);
  assert.ok(Number.isInteger(entry.directoryVersion), 'directoryVersion is an integer');
  assert.equal(typeof entry.viewId, 'string');
  assert.ok(entry.viewId.length > 0, 'the release record names its view');
  assert.equal(Object.hasOwn(entry, 'grossPay'), false);

  const detector = (text) => amountLiterals.filter((literal) => text.includes(literal));
  assert.equal(
    detector(JSON.stringify(released.body.rows)).length,
    amountLiterals.length,
    'the detector finds the amounts on the release view',
  );
  assert.equal(detector(JSON.stringify(audit.body.entries)).length, 0);
});

test('M7 a directory change during the open refuses the release', async (t) => {
  let transferred = false;
  const onBeforeCommit = async ({ applyAssignment }) => {
    if (transferred) {
      return;
    }
    transferred = true;
    await applyAssignment({
      principal: 'alice',
      role: 'manager',
      tenant: 'north',
      shop: 'north/bristol',
      from: '2026-01-01',
      to: '2026-11-14',
    });
    await applyAssignment({
      principal: 'ben',
      role: 'manager',
      tenant: 'north',
      shop: 'north/bristol',
      from: '2026-11-01',
      to: null,
    });
  };

  const system = await begin(t, { clock: fixedClock(), onBeforeCommit });
  if (!requireMediated(system, t, 'the release coordinator and its commit revalidation do not exist')) {
    return;
  }
  const reportId = await prepareReport(system.urls.portal);

  const alice = await requestJson(openUrl(system.urls.portal, reportId), {
    headers: devHeaders('alice'),
  });
  assert.equal(alice.status, 409);
  assert.equal(alice.body?.error?.code, 'release_refused');
  assert.equal(alice.body?.error?.message, 'directory_changed');
  assert.deepEqual(alice.body.rows, []);
  assert.equal(alice.headers['cache-control'], 'no-store');
  assertNoAmounts(alice.body);

  const ben = await requestJson(openUrl(system.urls.portal, reportId), {
    headers: devHeaders('ben'),
  });
  assert.equal(ben.status, 200);
  assert.deepEqual(ben.body.rows, expectedRows);
  assert.equal(ben.headers['cache-control'], 'no-store');

  const audit = await requestJson(`${system.urls.auth}/v1/audit`, {
    headers: { 'x-zenturian-admin': system.adminToken },
  });
  assert.equal(audit.status, 200);
  const releases = audit.body.entries.filter(
    (entry) => entry.type === 'release' && entry.reportId === reportId,
  );
  const refusal = releases.find((entry) => entry.subject === 'alice' && entry.verdict === 'refuse');
  const allow = releases.find((entry) => entry.subject === 'ben' && entry.verdict === 'allow');
  assert.ok(refusal !== undefined, 'the refused release is audited');
  assert.ok(allow !== undefined, 'the later release is audited');
  assert.equal(refusal.reason, 'directory_changed');

  assert.ok(Number.isInteger(refusal.directoryVersion));
  assert.ok(Number.isInteger(refusal.commitDirectoryVersion));
  assert.ok(Number.isInteger(allow.directoryVersion));
  assert.notEqual(refusal.directoryVersion, allow.directoryVersion);
  assert.equal(refusal.commitDirectoryVersion, allow.directoryVersion);
});
