// Startable payroll system and mediated demonstration.
//
// `startAll` assembles the directory, ledger and reporting components with their
// proxies, the auth server, the serialized coordinator and the portal, all on
// ephemeral loopback ports, and returns a handle that closes them. Tests use the
// same entry point.
//
// Running this file drives the mediated acts: Nora prepares, Nora's own open is
// refused, Alice receives exactly the Bristol October rows, Cara and the South
// manager are refused, a supplied mixed snapshot releases nothing, and the audit
// chain is shown without any salary value. The policy act then refuses Dana
// under v1, promotes v2, releases the same two rows to her, shows the manager
// transfer moving Bristol management from Alice to Ben, and refuses Dana after
// her acting assignment expires.

import { pathToFileURL } from 'node:url';

import fixture from '../fixture.mjs';
import { createAuthServer } from './auth-server.mjs';
import { verifyCanonicalVectors } from './canonical.mjs';
import { createCoordinator } from './coordinator.mjs';
import { createServer as createDirectoryServer } from './directory.mjs';
import { requestJson } from './http.mjs';
import { nowSeconds, randomToken } from './keys.mjs';
import { createServer as createLedgerServer } from './ledger.mjs';
import { policyHash } from './policy.mjs';
import { policyV1 } from './policy-v1.mjs';
import { policyV2 } from './policy-v2.mjs';
import { createServer as createPortalServer } from './portal.mjs';
import {
  ADMISSION_HEADER,
  createGatewayClient,
  createProxy,
} from './proxy.mjs';
import { createServer as createReportingServer } from './reporting.mjs';

export async function startAll({
  clock = nowSeconds,
  periods = fixture.periods,
  principals = fixture.principals,
  initialPolicy = policyV1,
  onBeforeCommit,
  ledgerRead,
} = {}) {
  const tokens = {
    gateway: randomToken(),
    reporting: randomToken(),
    ledger: randomToken(),
    directory: randomToken(),
  };
  const adminToken = randomToken();
  const forwardSecrets = {
    directory: randomToken(),
    ledger: randomToken(),
    reporting: randomToken(),
  };

  const auth = await createAuthServer({
    admissionTokens: tokens,
    adminToken,
    clock,
    initialPolicy,
  });

  const directory = await createDirectoryServer({
    principals,
    forwardSecret: forwardSecrets.directory,
    clock,
  });
  const ledger = await createLedgerServer({ forwardSecret: forwardSecrets.ledger });
  const reporting = await createReportingServer({ forwardSecret: forwardSecrets.reporting });

  const proxyBase = {
    publicKey: auth.publicKey,
    authServerUrl: auth.url,
    callers: { [tokens.gateway]: 'gateway' },
    adminToken,
    clock,
  };
  const directoryProxy = await createProxy({
    name: 'directory',
    componentUrl: directory.url,
    forwardSecret: forwardSecrets.directory,
    ...proxyBase,
  });
  const ledgerProxy = await createProxy({
    name: 'ledger',
    componentUrl: ledger.url,
    forwardSecret: forwardSecrets.ledger,
    ...proxyBase,
  });
  const reportingProxy = await createProxy({
    name: 'reporting',
    componentUrl: reporting.url,
    forwardSecret: forwardSecrets.reporting,
    ...proxyBase,
  });

  const gateway = createGatewayClient({
    admissionToken: tokens.gateway,
    authServerUrl: auth.url,
  });

  const coordinator = createCoordinator({
    gateway,
    urls: {
      directoryProxy: directoryProxy.url,
      ledgerProxy: ledgerProxy.url,
      reportingProxy: reportingProxy.url,
    },
    adminToken,
    authServerUrl: auth.url,
    periods,
    clock,
    onBeforeCommit,
    ledgerRead,
  });

  const portal = await createPortalServer({ coordinator, principals });

  const services = [
    auth,
    directory,
    ledger,
    reporting,
    directoryProxy,
    ledgerProxy,
    reportingProxy,
    portal,
  ];

  return {
    urls: {
      auth: auth.url,
      directory: directory.url,
      ledger: ledger.url,
      reporting: reporting.url,
      directoryProxy: directoryProxy.url,
      ledgerProxy: ledgerProxy.url,
      reportingProxy: reportingProxy.url,
      portal: portal.url,
    },
    tokens,
    adminToken,
    forwardSecrets,
    publicKey: auth.publicKey,
    policy: initialPolicy,
    policyHash: policyHash(initialPolicy),
    auth,
    directory,
    ledger,
    reporting,
    directoryProxy,
    ledgerProxy,
    reportingProxy,
    portal,
    coordinator,
    clock,
    async close() {
      await Promise.all(services.map((service) => service.close()));
    },
  };
}

async function openReport(portalUrl, reportId, principal, body) {
  return requestJson(`${portalUrl}/v1/reports/${reportId}/open`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer dev:${principal}` },
    body,
  });
}

function reportOpen(label, response) {
  const noStore = response.headers['cache-control'] === 'no-store';
  if (response.status === 200) {
    console.log(`${label}: HTTP 200 rows=${response.body.rows.length} no-store=${noStore}`);
    for (const row of response.body.rows) {
      console.log(`  ${row.employeeRef} GBP ${row.grossPay}`);
    }
    return;
  }
  const error = response.body?.error ?? {};
  const rowCount = Array.isArray(response.body?.rows) ? response.body.rows.length : 'absent';
  console.log(
    `${label}: HTTP ${response.status} ${error.code ?? ''} reason=${error.message ?? ''} rows=${rowCount} no-store=${noStore}`,
  );
}

function formatPence(pence) {
  return `${Math.floor(pence / 100)}.${String(pence % 100).padStart(2, '0')}`;
}

function requireRefusal(label, response) {
  const rows = Array.isArray(response.body?.rows) ? response.body.rows : null;
  if (response.status !== 403 || response.body?.error?.code !== 'release_refused' || rows?.length !== 0) {
    throw new Error(`${label} should be refused with zero rows, got HTTP ${response.status}`);
  }
}

function requireRelease(label, response, expectedRows) {
  if (response.status !== 200 || JSON.stringify(response.body?.rows) !== JSON.stringify(expectedRows)) {
    throw new Error(`${label} should release the expected rows, got HTTP ${response.status}`);
  }
}

function reportAudit(auth, releaseViewText) {
  const entries = auth.audit.entries();
  const releases = entries.filter((entry) => entry.type === 'release');
  const promotions = entries.filter((entry) => entry.type === 'promotion');
  console.log(
    `Audit: ${entries.length} entries, ${releases.length} release records, `
    + `${promotions.length} promotion records`,
  );
  for (const entry of promotions) {
    console.log(
      `  #${entry.seq} promotion approver=${entry.approver} at=${entry.ts} `
      + `policy=${entry.previousPolicyHash} -> ${entry.policyHash}`,
    );
  }
  for (const entry of releases) {
    console.log(
      `  #${entry.seq} ${entry.verdict} reason=${entry.reason ?? 'released'} `
      + `rows=${entry.rowCount} dirVersion=${entry.directoryVersion} `
      + `policy=${entry.policyHash.slice(0, 12)}…`,
    );
  }
  const verify = auth.audit.verify();
  const salaryLike = ['3100.00', '2850.00', '310000', '285000', '302000'];
  const detector = (text) => salaryLike.filter((value) => text.includes(value));
  const inAudit = detector(JSON.stringify(entries));
  const inView = detector(releaseViewText);
  console.log(
    `Audit chain: ok=${verify.ok} entries=${verify.count} head=${verify.head ?? ''} `
    + `salary values present=${inAudit.length > 0} `
    + `(detector control on the release view=${inView.length > 0})`,
  );
}

async function main() {
  const vectors = verifyCanonicalVectors();
  console.log(`Canonical vectors: ${vectors.count} verified against zcanon.v1`);

  let now = Math.floor(Date.parse('2026-11-15T00:00:00Z') / 1000);
  const system = await startAll({ clock: () => now });
  const expectedBristolRows = fixture.ledgerRows
    .filter((row) => (
      row.tenant === 'north'
      && row.shop === 'north/bristol'
      && row.period === '2026-10'
    ))
    .map((row) => ({ employeeRef: row.employeeRef, grossPay: formatPence(row.grossPayPence) }));
  let mixedSystem;
  try {
    const prepared = await requestJson(`${system.urls.portal}/v1/reports`, {
      method: 'POST',
      headers: { authorization: 'Bearer dev:nora' },
      body: { tenant: 'north', shop: 'north/bristol', period: '2026-10' },
    });
    if (prepared.status !== 200 || typeof prepared.body?.reportId !== 'string') {
      throw new Error(`preparation failed: HTTP ${prepared.status} ${JSON.stringify(prepared.body)}`);
    }
    const reportId = prepared.body.reportId;
    console.log(`Act 1 preparation: HTTP 200 reportId=${reportId}`);

    console.log('Act 2 Nora opening her own prepared report:');
    reportOpen('  Nora', await openReport(system.urls.portal, reportId, 'nora'));

    console.log('Act 3 Alice, the active Bristol manager:');
    const aliceRelease = await openReport(system.urls.portal, reportId, 'alice');
    reportOpen('  Alice', aliceRelease);

    console.log("Body-selected reader attempt (POST body reader=alice on Nora's session):");
    reportOpen(
      '  Nora as body-reader',
      await openReport(system.urls.portal, reportId, 'nora', { reader: 'alice' }),
    );

    console.log('Act 4 other managers:');
    reportOpen('  Cara', await openReport(system.urls.portal, reportId, 'cara'));
    reportOpen('  Sam', await openReport(system.urls.portal, reportId, 'sam'));

    const beforeDirect = system.ledger.invocations.rpc;
    const direct = await requestJson(`${system.urls.ledger}/rpc`, {
      method: 'POST',
      body: { op: 'rows', args: { tenant: 'north', period: '2026-10' } },
    });
    console.log(
      `Direct ledger /rpc without the forward secret: HTTP ${direct.status} `
      + `${direct.body?.error?.code ?? ''} (component invocations unchanged=${system.ledger.invocations.rpc === beforeDirect})`,
    );

    const reportingAtLedger = await requestJson(`${system.urls.ledgerProxy}/v1/call`, {
      method: 'POST',
      headers: { [ADMISSION_HEADER]: system.tokens.reporting },
      body: {
        v: 1,
        caller: 'reporting',
        audience: 'ledger',
        subject: 'nora',
        onBehalfOf: 'nora',
        tenant: 'north',
        op: 'rows',
        resource: { type: 'ledger-scope', id: 'snap-north-bristol-2026-10' },
        args: { tenant: 'north', shop: 'north/bristol', period: '2026-10', snapshotId: 'snap-north-bristol-2026-10' },
      },
    });
    console.log(
      `Reporting token at the ledger proxy: HTTP ${reportingAtLedger.status} `
      + `${reportingAtLedger.body?.error?.code ?? ''}`,
    );

    const brokerDenial = await requestJson(`${system.urls.auth}/v1/decide`, {
      method: 'POST',
      headers: { [ADMISSION_HEADER]: system.tokens.reporting },
      body: {
        v: 1,
        caller: 'reporting',
        audience: 'ledger',
        subject: 'nora',
        onBehalfOf: 'nora',
        tenant: 'north',
        op: 'rows',
        resource: { type: 'ledger-scope', id: 'snap-north-bristol-2026-10' },
        args: { tenant: 'north', shop: 'north/bristol', period: '2026-10', snapshotId: 'snap-north-bristol-2026-10' },
      },
    });
    console.log(
      `Reporting request for a ledger permit: HTTP ${brokerDenial.status} `
      + `${brokerDenial.body?.error?.code ?? ''}`,
    );

    console.log('Act 5 policy change: Dana under v1, then v2, then assignment expiry:');
    const danaUnderV1 = await openReport(system.urls.portal, reportId, 'dana');
    reportOpen('  Dana under v1', danaUnderV1);
    requireRefusal('Dana under v1', danaUnderV1);

    const promotion = await system.coordinator.promotePolicy(policyV2, 'policy-owner');
    console.log(
      `  Promotion approver=policy-owner at=${new Date(promotion.promotedAt * 1000).toISOString()} `
      + `policy=${promotion.previousHash} -> ${promotion.hash} `
      + `audit=#${promotion.audit.seq} ${promotion.audit.digest}`,
    );

    const danaUnderV2 = await openReport(system.urls.portal, reportId, 'dana');
    reportOpen('  Dana under v2', danaUnderV2);
    requireRelease('Dana under v2', danaUnderV2, expectedBristolRows);

    const benBefore = await openReport(system.urls.portal, reportId, 'ben');
    reportOpen('  Ben before the transfer', benBefore);
    requireRefusal('Ben before the transfer', benBefore);

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
    console.log('  Bristol manager transfer: Alice manager ends 2026-11-14, Ben manager starts 2026-11-01');

    const aliceAfter = await openReport(system.urls.portal, reportId, 'alice');
    reportOpen('  Alice after the transfer', aliceAfter);
    requireRefusal('Alice after the transfer', aliceAfter);
    const benAfter = await openReport(system.urls.portal, reportId, 'ben');
    reportOpen('  Ben after the transfer', benAfter);
    requireRelease('Ben after the transfer', benAfter, expectedBristolRows);
    const caraAfter = await openReport(system.urls.portal, reportId, 'cara');
    reportOpen('  Cara after the transfer', caraAfter);
    requireRefusal('Cara after the transfer', caraAfter);
    const samAfter = await openReport(system.urls.portal, reportId, 'sam');
    reportOpen('  Sam after the transfer', samAfter);
    requireRefusal('Sam after the transfer', samAfter);

    now = Math.floor(Date.parse('2026-12-01T00:00:00Z') / 1000);
    const danaExpired = await openReport(system.urls.portal, reportId, 'dana');
    reportOpen('  Dana after her assignment expires', danaExpired);
    requireRefusal('Dana after her assignment expires', danaExpired);

    mixedSystem = await startAll({
      ledgerRead: async () => ({
        snapshot: {
          id: 'snap-north-bristol-2026-10',
          tenant: 'north',
          shop: 'north/bristol',
          period: '2026-10',
          rowIds: ['L1', 'L2', 'L3'],
        },
        rows: fixture.ledgerRows.slice(0, 3),
      }),
    });
    const mixedPrepared = await requestJson(`${mixedSystem.urls.portal}/v1/reports`, {
      method: 'POST',
      headers: { authorization: 'Bearer dev:nora' },
      body: { tenant: 'north', shop: 'north/bristol', period: '2026-10' },
    });
    if (mixedPrepared.status !== 200) {
      throw new Error(`mixed preparation failed: HTTP ${mixedPrepared.status}`);
    }
    console.log('Projector check with a supplied mixed snapshot (L1, L2, L3):');
    reportOpen(
      '  Alice',
      await openReport(mixedSystem.urls.portal, mixedPrepared.body.reportId, 'alice'),
    );

    reportAudit(system.auth, JSON.stringify(aliceRelease.body));
  } finally {
    if (mixedSystem !== undefined) {
      await mixedSystem.close();
    }
    await system.close();
  }
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
