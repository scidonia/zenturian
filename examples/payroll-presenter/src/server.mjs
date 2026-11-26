// Local presenter for the payroll example.
//
// This process imports the example and calls it. It does not modify the example.
// The browser receives the portal's release result and a redacted audit view.
// Tokens, forward secrets, and component URLs stay in this process.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import fixture from '../../payroll/fixture.mjs';
import { startAll } from '../../payroll/src/demo.mjs';
import { isActive } from '../../payroll/src/directory.mjs';
import { HttpError, requestJson } from '../../payroll/src/http.mjs';
import { policyV1 } from '../../payroll/src/policy-v1.mjs';
import { policyV2 } from '../../payroll/src/policy-v2.mjs';

const HOST = '127.0.0.1';
const PORT = 4173;
const OPENING_DAY = '2026-11-15';
const EXPIRY_DAY = '2026-12-01';
const DAYS = {
  [OPENING_DAY]: Math.floor(Date.parse('2026-11-15T00:00:00Z') / 1000),
  [EXPIRY_DAY]: Math.floor(Date.parse('2026-12-01T00:00:00Z') / 1000),
};
const REPORT = { tenant: 'north', shop: 'north/bristol', period: '2026-10' };
const SALARY_LIKE = ['3100.00', '2850.00', '310000', '285000', '302000'];
const PRINCIPAL_IDS = new Set(fixture.principals.map((record) => record.id));
const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '../public');
const LOGO_FILE = join(dirname(fileURLToPath(import.meta.url)), '../../../assets/logo.svg');
const FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/fonts/manrope-latin.woff2': ['fonts/manrope-latin.woff2', 'font/woff2'],
};

let system;
let now = DAYS[OPENING_DAY];
let day = OPENING_DAY;
let principal = 'nora';
let reportId = null;
let last = null;
let mixedOutcome = null;
let lastReleaseText = null;
let gate = Promise.resolve();

function exclusive(action) {
  const run = gate.then(action, action);
  gate = run.then(() => {}, () => {});
  return run;
}

function containsSalary(text) {
  return SALARY_LIKE.some((value) => text.includes(value));
}

function fixtureAssignment(id) {
  const assignment = fixture.assignments.find((record) => (
    record.principal === id
    && record.tenant === REPORT.tenant
    && record.shop === REPORT.shop
  ));
  if (assignment === undefined) {
    throw new Error(`fixture has no ${REPORT.shop} assignment for ${id}`);
  }
  return assignment;
}

function emptyOutcome(kind, note, actor = null) {
  return {
    kind,
    actor,
    bodyReader: null,
    status: null,
    noStore: null,
    reportId: null,
    rows: null,
    error: null,
    note,
  };
}

function portalOutcome(kind, response, actor, bodyReader = null) {
  const body = response.body && typeof response.body === 'object' ? response.body : {};
  const error = body.error && typeof body.error.code === 'string'
    ? { code: body.error.code, message: typeof body.error.message === 'string' ? body.error.message : '' }
    : null;
  const rows = Array.isArray(body.rows)
    ? body.rows.map((row) => ({
      employeeRef: typeof row?.employeeRef === 'string' ? row.employeeRef : '',
      grossPay: typeof row?.grossPay === 'string' ? row.grossPay : '',
    }))
    : null;
  return {
    kind,
    actor,
    bodyReader,
    status: response.status,
    noStore: response.headers['cache-control'] === 'no-store',
    reportId: typeof body.reportId === 'string' ? body.reportId : null,
    rows,
    error,
    note: null,
  };
}

function failureOutcome(kind, error) {
  return {
    kind,
    actor: principal,
    bodyReader: null,
    status: error instanceof HttpError ? error.status : null,
    noStore: null,
    reportId,
    rows: null,
    error: {
      code: error instanceof HttpError ? error.code : 'presenter_error',
      message: error instanceof HttpError ? error.message : 'The presenter could not complete that action.',
    },
    note: null,
  };
}

async function portalRequest(target, method, path, person, body) {
  return requestJson(`${target.urls.portal}${path}`, {
    method,
    headers: { authorization: `Bearer dev:${person}` },
    body,
  });
}

async function readAssignments() {
  const collected = [];
  let version = null;
  for (const shop of fixture.shops) {
    const response = await requestJson(`${system.urls.directory}/rpc`, {
      method: 'POST',
      headers: { 'x-zenturian-forward': system.forwardSecrets.directory },
      body: { op: 'assignments', args: { tenant: shop.tenant, shop: shop.id } },
    });
    if (response.status !== 200 || !Array.isArray(response.body?.assignments)) {
      throw new HttpError(
        502,
        'directory_unavailable',
        `directory assignments failed with status ${response.status}`,
      );
    }
    version = response.body.version;
    for (const assignment of response.body.assignments) {
      collected.push({
        principal: assignment.principal,
        role: assignment.role,
        tenant: assignment.tenant,
        shop: assignment.shop,
        from: assignment.from,
        to: assignment.to,
        active: isActive(assignment, now),
      });
    }
  }
  return { version, assignments: collected };
}

function projectRecord(entry) {
  return {
    seq: entry.seq,
    type: entry.type,
    verdict: entry.verdict,
    reason: entry.reason ?? null,
    rowCount: entry.rowCount ?? null,
    directoryVersion: entry.directoryVersion ?? null,
    policyPrefix: typeof entry.policyHash === 'string' ? entry.policyHash.slice(0, 12) : null,
    previousPolicyPrefix: typeof entry.previousPolicyHash === 'string'
      ? entry.previousPolicyHash.slice(0, 12)
      : null,
    approver: entry.approver ?? null,
    person: entry.recipient ?? entry.subject ?? null,
  };
}

async function snapshot() {
  const policyState = system.auth.policy();
  const directory = await readAssignments();
  const entries = system.auth.audit.entries();
  const verify = system.auth.audit.verify();
  const records = entries
    .filter((entry) => entry.type === 'release' || entry.type === 'promotion')
    .map(projectRecord)
    .sort((left, right) => right.seq - left.seq);
  return {
    session: { principal },
    asOf: day,
    policy: {
      version: policyState.policy.version,
      hashPrefix: policyState.hash.slice(0, 12),
    },
    directoryVersion: directory.version,
    reportId,
    people: fixture.principals.map((record) => ({
      id: record.id,
      name: record.name,
      tenant: record.tenant,
    })),
    shops: fixture.shops.map((shop) => ({
      id: shop.id,
      tenant: shop.tenant,
      name: shop.name,
    })),
    assignments: directory.assignments,
    last,
    mixed: mixedOutcome,
    audit: {
      ok: verify.ok,
      count: verify.count,
      brokenAt: verify.brokenAt ?? null,
      headPrefix: typeof verify.head === 'string' ? verify.head.slice(0, 12) : null,
      releaseCount: entries.filter((entry) => entry.type === 'release').length,
      promotionCount: entries.filter((entry) => entry.type === 'promotion').length,
      salaryValuesPresent: containsSalary(JSON.stringify(entries)),
      releaseViewDetector: lastReleaseText === null ? null : containsSalary(lastReleaseText),
      records,
    },
  };
}

function rememberRelease(outcome) {
  if (Array.isArray(outcome.rows) && outcome.rows.length > 0 && outcome.error === null) {
    lastReleaseText = JSON.stringify(outcome.rows);
  }
}

async function prepare() {
  const response = await portalRequest(system, 'POST', '/v1/reports', principal, REPORT);
  last = portalOutcome('prepare', response, principal);
  if (response.status === 200 && typeof response.body?.reportId === 'string') {
    reportId = response.body.reportId;
    last.reportId = reportId;
  }
}

async function openReport() {
  if (reportId === null) {
    last = {
      ...emptyOutcome('open', null, principal),
      error: { code: 'report_not_prepared', message: 'Prepare the report first.' },
    };
    return;
  }
  const response = await portalRequest(
    system,
    'GET',
    `/v1/reports/${encodeURIComponent(reportId)}/open`,
    principal,
  );
  last = portalOutcome('open', response, principal);
  rememberRelease(last);
}

async function openWithBodyReader() {
  if (reportId === null) {
    last = {
      ...emptyOutcome('body', null, 'nora'),
      bodyReader: 'alice',
      error: { code: 'report_not_prepared', message: 'Prepare the report first.' },
    };
    return;
  }
  const response = await portalRequest(
    system,
    'POST',
    `/v1/reports/${encodeURIComponent(reportId)}/open`,
    'nora',
    { reader: 'alice' },
  );
  last = portalOutcome('body', response, 'nora', 'alice');
  rememberRelease(last);
}

async function promote(version) {
  const policy = version === 'v2' ? policyV2 : policyV1;
  const promotion = await system.coordinator.promotePolicy(policy, 'policy-owner');
  const same = promotion.previousHash === promotion.hash;
  last = emptyOutcome(
    'policy',
    same
      ? `Policy ${version} was promoted again by policy-owner.`
      : `Policy-owner promoted ${version}. ${promotion.previousHash.slice(0, 12)} → ${promotion.hash.slice(0, 12)}.`,
  );
}

async function transferManagement() {
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
  last = emptyOutcome(
    'transfer',
    'Bristol management for Alice ends 2026-11-14. Bristol management for Ben starts 2026-11-01.',
  );
}

async function restoreAssignments() {
  for (const id of ['alice', 'ben']) {
    await system.coordinator.replaceAssignment({ ...fixtureAssignment(id) });
  }
  last = emptyOutcome(
    'restore',
    'Alice is the Bristol manager again. Ben is the designated successor again.',
  );
}

function setClock(nextDay) {
  day = nextDay;
  now = DAYS[nextDay];
  last = emptyOutcome('clock', `The model clock is ${nextDay}.`);
}

async function openMixed() {
  const mixed = await startAll({
    clock: () => now,
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
  try {
    const prepared = await portalRequest(mixed, 'POST', '/v1/reports', 'nora', REPORT);
    if (prepared.status !== 200 || typeof prepared.body?.reportId !== 'string') {
      mixedOutcome = portalOutcome('mixed', prepared, 'nora');
      last = mixedOutcome;
      return;
    }
    const opened = await portalRequest(
      mixed,
      'GET',
      `/v1/reports/${encodeURIComponent(prepared.body.reportId)}/open`,
      'alice',
    );
    mixedOutcome = portalOutcome('mixed', opened, 'alice');
    last = mixedOutcome;
  } finally {
    await mixed.close();
  }
}

async function reset() {
  const previous = system;
  now = DAYS[OPENING_DAY];
  day = OPENING_DAY;
  reportId = null;
  lastReleaseText = null;
  mixedOutcome = null;
  principal = 'nora';
  system = await startAll({ clock: () => now });
  await previous.close().catch((error) => {
    console.error(error);
  });
  last = null;
}

function requirePrincipal(body) {
  const id = body?.principal;
  if (typeof id !== 'string' || !PRINCIPAL_IDS.has(id)) {
    throw new HttpError(400, 'unknown_principal', 'principal must be one of the fixture people');
  }
  return id;
}

function requireVersion(body) {
  const version = body?.version;
  if (version !== 'v1' && version !== 'v2') {
    throw new HttpError(400, 'unknown_policy', 'version must be v1 or v2');
  }
  return version;
}

function requireDay(body) {
  const next = body?.day;
  if (next !== OPENING_DAY && next !== EXPIRY_DAY) {
    throw new HttpError(400, 'unknown_day', 'day must be 2026-11-15 or 2026-12-01');
  }
  return next;
}

async function runAction(name, body) {
  try {
    if (name === 'session') {
      principal = requirePrincipal(body);
    } else if (name === 'prepare') {
      await prepare();
    } else if (name === 'open') {
      await openReport();
    } else if (name === 'body') {
      await openWithBodyReader();
    } else if (name === 'policy') {
      await promote(requireVersion(body));
    } else if (name === 'transfer') {
      await transferManagement();
    } else if (name === 'restore') {
      await restoreAssignments();
    } else if (name === 'clock') {
      setClock(requireDay(body));
    } else if (name === 'mixed') {
      await openMixed();
    } else if (name === 'reset') {
      await reset();
    } else {
      throw new HttpError(404, 'not_found', 'unknown action');
    }
  } catch (error) {
    if (!(error instanceof HttpError) || error.status >= 500) {
      console.error(error);
    }
    last = failureOutcome(name, error);
  }
  return snapshot();
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(payload);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16 * 1024) {
      throw new HttpError(413, 'body_too_large', 'request body exceeds 16KB');
    }
    chunks.push(chunk);
  }
  if (size === 0) {
    return {};
  }
  const contentType = req.headers['content-type'] ?? '';
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw new HttpError(415, 'unsupported_media_type', 'content-type must be application/json');
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new HttpError(400, 'invalid_json', 'request body must be a JSON object');
    }
    return value;
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }
    throw new HttpError(400, 'invalid_json', 'request body must be valid JSON');
  }
}

async function serveStatic(res, pathname) {
  if (pathname === '/logo.svg') {
    const payload = await readFile(LOGO_FILE);
    res.writeHead(200, {
      'content-type': 'image/svg+xml',
      'content-length': payload.length,
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
    });
    res.end(payload);
    return;
  }
  const file = FILES[pathname];
  if (file === undefined) {
    sendJson(res, 404, { error: { code: 'not_found', message: 'unknown page' } });
    return;
  }
  const payload = await readFile(join(PUBLIC_DIR, file[0]));
  res.writeHead(200, {
    'content-type': file[1],
    'content-length': payload.length,
    'cache-control': 'no-cache',
    'x-content-type-options': 'nosniff',
  });
  res.end(payload);
}

const ACTIONS = new Map([
  ['/api/session', 'session'],
  ['/api/prepare', 'prepare'],
  ['/api/open', 'open'],
  ['/api/open-body', 'body'],
  ['/api/policy', 'policy'],
  ['/api/transfer', 'transfer'],
  ['/api/restore', 'restore'],
  ['/api/clock', 'clock'],
  ['/api/mixed', 'mixed'],
  ['/api/reset', 'reset'],
]);

function handler(req, res) {
  const url = new URL(req.url, `http://${HOST}`);
  Promise.resolve()
    .then(async () => {
      if (req.method === 'GET' && url.pathname === '/api/state') {
        sendJson(res, 200, await exclusive(() => snapshot()));
        return;
      }
      if (req.method === 'GET') {
        await serveStatic(res, url.pathname);
        return;
      }
      const action = req.method === 'POST' ? ACTIONS.get(url.pathname) : undefined;
      if (action === undefined) {
        sendJson(res, 404, { error: { code: 'not_found', message: 'unknown route' } });
        return;
      }
      const body = await readBody(req);
      sendJson(res, 200, await exclusive(() => runAction(action, body)));
    })
    .catch((error) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const status = error instanceof HttpError ? error.status : 500;
      const code = error instanceof HttpError ? error.code : 'presenter_error';
      const message = error instanceof HttpError
        ? error.message
        : 'The presenter could not complete that action.';
      if (!(error instanceof HttpError)) {
        console.error(error);
      }
      sendJson(res, status, { error: { code, message } });
    });
}

async function main() {
  system = await startAll({ clock: () => now });
  const server = createServer(handler);
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(PORT, HOST, () => {
        server.removeAllListeners('error');
        resolve();
      });
    });
  } catch (error) {
    await system.close();
    throw error;
  }

  const shutdown = async () => {
    server.close();
    await system.close();
    process.exit(0);
  };
  process.on('SIGINT', () => {
    shutdown().catch((error) => {
      console.error(error);
      process.exit(1);
    });
  });
  process.on('SIGTERM', () => {
    shutdown().catch((error) => {
      console.error(error);
      process.exit(1);
    });
  });

  console.log(`Payroll presenter at http://${HOST}:${PORT}`);
  console.log('The payroll example is running in memory. Stop this process to close it.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
