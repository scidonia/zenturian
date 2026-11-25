// Trusted projector and release coordinator.
//
// The coordinator owns the report registry. It reads authoritative assignment
// facts and ledger rows only through the mediated directory and ledger proxies,
// validates every returned row against the recorded scope and snapshot, builds the
// two-field manager view itself, and commits under a serialized lock that
// re-reads the assignment version and the active policy hash. Any mismatch
// refuses the whole release with zero salary bytes.

import { randomUUID } from 'node:crypto';

import fixture from '../fixture.mjs';
import { HttpError, requestJson } from './http.mjs';
import { isActive } from './directory.mjs';
import { nowSeconds } from './keys.mjs';
import { evaluateRelease } from './policy.mjs';
import { ADMIN_HEADER } from './proxy.mjs';

export function formatPence(pence) {
  if (!Number.isSafeInteger(pence) || pence < 0) {
    throw new HttpError(
      502,
      'invalid_ledger_row',
      'ledger amount must be a non-negative integer of pence',
    );
  }
  const pounds = Math.floor(pence / 100);
  const remainder = String(pence % 100).padStart(2, '0');
  return `${pounds}.${remainder}`;
}

// A refusal carries a reason and never a view. The portal turns it into a
// response with an empty row list.
export class ReleaseRefused extends HttpError {
  constructor(status, code, reason) {
    super(status, code, reason);
    this.name = 'ReleaseRefused';
    this.reason = reason;
  }
}

function asRefusal(error) {
  if (error instanceof ReleaseRefused) {
    return error;
  }
  if (error instanceof HttpError) {
    return new ReleaseRefused(error.status, error.code, error.message);
  }
  return error;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function createCoordinator({
  gateway,
  urls,
  adminToken,
  authServerUrl,
  periods = fixture.periods,
  clock = nowSeconds,
  getActivePolicy,
  ledgerRead,
  onBeforeCommit,
} = {}) {
  if (gateway === undefined || typeof gateway.call !== 'function') {
    throw new TypeError('coordinator requires a gateway client');
  }
  if (!isPlainObject(urls) || typeof urls.directoryProxy !== 'string'
    || typeof urls.ledgerProxy !== 'string' || typeof urls.reportingProxy !== 'string') {
    throw new TypeError('coordinator requires the directory, ledger and reporting proxy URLs');
  }
  if (typeof adminToken !== 'string' || adminToken.length === 0) {
    throw new TypeError('coordinator requires the broker admin token');
  }
  if (typeof authServerUrl !== 'string' || authServerUrl.length === 0) {
    throw new TypeError('coordinator requires the auth server URL');
  }
  if (onBeforeCommit !== undefined && typeof onBeforeCommit !== 'function') {
    throw new TypeError('onBeforeCommit must be a function when provided');
  }

  const reports = new Map();

  let tail = Promise.resolve();
  const withLock = (work) => {
    const run = tail.then(work, work);
    tail = run.then(() => undefined, () => undefined);
    return run;
  };

  const activePolicy = getActivePolicy ?? (async () => {
    let response;
    try {
      response = await requestJson(`${authServerUrl}/v1/policy/active`, {
        headers: { [ADMIN_HEADER]: adminToken },
      });
    } catch (error) {
      throw new HttpError(502, 'policy_unavailable', `policy fetch failed: ${error.message}`);
    }
    if (
      response.status !== 200
      || typeof response.body?.hash !== 'string'
      || response.body.policy === undefined
    ) {
      throw new HttpError(502, 'policy_unavailable', 'the active policy could not be read');
    }
    return { hash: response.body.hash, policy: response.body.policy };
  });

  const applyPromotion = async (policy, approver) => {
    let response;
    try {
      response = await requestJson(`${authServerUrl}/v1/promote`, {
        method: 'POST',
        headers: { [ADMIN_HEADER]: adminToken },
        body: { policy, approver },
      });
    } catch (error) {
      throw new HttpError(
        502,
        'policy_promotion_failed',
        `policy promotion failed: ${error.message}`,
      );
    }
    if (response.status !== 200 || typeof response.body?.hash !== 'string') {
      throw new HttpError(
        502,
        'policy_promotion_failed',
        `policy promotion failed with status ${response.status}`,
      );
    }
    return response.body;
  };

  const readAssignments = async (principal, tenant, shop) => {
    const response = await gateway.call(urls.directoryProxy, {
      audience: 'directory',
      subject: principal,
      onBehalfOf: principal,
      tenant,
      op: 'assignments',
      resource: { type: 'shop', id: shop },
      args: { tenant, shop },
    });
    if (
      response.status !== 200
      || !isPlainObject(response.body)
      || !Array.isArray(response.body.assignments)
      || !Number.isSafeInteger(response.body.version)
    ) {
      throw new HttpError(
        502,
        'directory_unavailable',
        `directory assignments failed with status ${response.status}`,
      );
    }
    return { assignments: response.body.assignments, version: response.body.version };
  };

  const readSnapshot = async (principal, tenant, shop, period) => {
    const response = await gateway.call(urls.ledgerProxy, {
      audience: 'ledger',
      subject: principal,
      onBehalfOf: principal,
      tenant,
      op: 'snapshot',
      resource: { type: 'shop', id: shop },
      args: { tenant, shop, period },
    });
    if (response.status === 404) {
      throw new HttpError(409, 'unknown_snapshot', `no snapshot for ${tenant}/${shop} ${period}`);
    }
    if (
      response.status !== 200
      || !isPlainObject(response.body?.snapshot)
      || typeof response.body.snapshot.id !== 'string'
    ) {
      throw new HttpError(
        502,
        'ledger_unavailable',
        `ledger snapshot lookup failed with status ${response.status}`,
      );
    }
    return response.body.snapshot;
  };

  const readLedgerRows = ledgerRead ?? (async ({ principal, tenant, shop, period, snapshotId }) => {
    const response = await gateway.call(urls.ledgerProxy, {
      audience: 'ledger',
      subject: principal,
      onBehalfOf: principal,
      tenant,
      op: 'rows',
      resource: { type: 'ledger-scope', id: snapshotId },
      args: { tenant, shop, period, snapshotId },
    });
    if (response.status === 404) {
      throw new ReleaseRefused(409, 'snapshot_unknown', `snapshot ${snapshotId} is unknown`);
    }
    if (response.status !== 200 || !isPlainObject(response.body)) {
      throw new ReleaseRefused(
        502,
        'ledger_unavailable',
        `ledger rows failed with status ${response.status}`,
      );
    }
    return response.body;
  });

  const appendRelease = async (entry) => {
    let response;
    try {
      response = await requestJson(`${authServerUrl}/v1/audit`, {
        method: 'POST',
        headers: { [ADMIN_HEADER]: adminToken },
        body: { type: 'release', ...entry },
      });
    } catch (error) {
      throw new ReleaseRefused(502, 'audit_unavailable', `audit append failed: ${error.message}`);
    }
    if (response.status !== 200) {
      throw new ReleaseRefused(
        502,
        'audit_unavailable',
        `audit append failed with status ${response.status}`,
      );
    }
  };

  const readPrincipal = async (principal, tenant) => {
    const response = await gateway.call(urls.directoryProxy, {
      audience: 'directory',
      subject: principal,
      onBehalfOf: principal,
      tenant,
      op: 'principal',
      resource: { type: 'assignment', id: principal },
      args: { principal },
    });
    if (response.status !== 200 || !isPlainObject(response.body)) {
      throw new HttpError(
        502,
        'directory_unavailable',
        `directory principal lookup failed with status ${response.status}`,
      );
    }
    return response.body;
  };

  const prepare = async ({ principal, tenant, shop, period }) => {
    for (const [field, value] of Object.entries({ principal, tenant, shop, period })) {
      if (typeof value !== 'string' || value.length === 0) {
        throw new HttpError(400, 'invalid_args', `${field} must be a non-empty string`);
      }
    }

    const session = await readPrincipal(principal, tenant);
    if (session.tenant !== tenant) {
      throw new HttpError(403, 'tenant_mismatch', 'requested tenant does not match the session');
    }

    const periodRecord = periods.find((record) => record.id === period);
    if (periodRecord === undefined || periodRecord.status !== 'closed') {
      throw new HttpError(409, 'period_not_closed', `period ${period} is not closed`);
    }

    const { assignments } = await readAssignments(principal, tenant, shop);
    const now = clock();
    const canPrepare = assignments.some((assignment) => (
      assignment.principal === principal
      && assignment.role === 'payroll-preparer'
      && assignment.tenant === tenant
      && assignment.shop === shop
      && isActive(assignment, now)
    ));
    if (!canPrepare) {
      throw new HttpError(
        403,
        'preparer_not_assigned',
        'principal is not an active preparer for this shop',
      );
    }

    const snapshot = await readSnapshot(principal, tenant, shop, period);
    const reportId = randomUUID();
    const title = `${tenant}/${shop} payroll ${period}`;

    const stored = await gateway.call(urls.reportingProxy, {
      audience: 'reporting',
      subject: principal,
      onBehalfOf: principal,
      tenant,
      op: 'store',
      resource: { type: 'report', id: reportId },
      args: { reportId, title, status: 'prepared' },
    });
    if (stored.status !== 200) {
      throw new HttpError(
        502,
        'reporting_unavailable',
        `reporting store failed with status ${stored.status}`,
      );
    }

    reports.set(reportId, {
      reportId,
      tenant,
      shop,
      period,
      snapshotId: snapshot.id,
      preparedBy: principal,
      title,
      status: 'prepared',
    });
    return reportId;
  };

  // Every returned row is checked against the report's tenant, charged shop,
  // period and the snapshot's own membership and count. A single mismatch
  // refuses the whole release before a view is built.
  const validateRows = (report, ledgerBody) => {
    if (!isPlainObject(ledgerBody)) {
      throw new ReleaseRefused(502, 'ledger_unavailable', 'ledger response is not an object');
    }
    const { snapshot, rows } = ledgerBody;
    if (
      !isPlainObject(snapshot)
      || typeof snapshot.id !== 'string'
      || !Array.isArray(snapshot.rowIds)
    ) {
      throw new ReleaseRefused(409, 'snapshot_unknown', 'ledger did not report a snapshot');
    }
    if (snapshot.id !== report.snapshotId) {
      throw new ReleaseRefused(409, 'snapshot_mismatch', 'ledger returned a different snapshot');
    }
    if (
      snapshot.tenant !== report.tenant
      || snapshot.shop !== report.shop
      || snapshot.period !== report.period
    ) {
      throw new ReleaseRefused(409, 'snapshot_scope_mismatch', 'snapshot scope differs from the report');
    }
    if (!Array.isArray(rows) || rows.length !== snapshot.rowIds.length) {
      throw new ReleaseRefused(409, 'row_scope_mismatch', 'snapshot row count differs');
    }

    const byId = new Map();
    for (const row of rows) {
      if (
        !isPlainObject(row)
        || typeof row.id !== 'string'
        || typeof row.employeeRef !== 'string'
        || row.employeeRef.length === 0
      ) {
        throw new ReleaseRefused(409, 'row_scope_mismatch', 'ledger row is malformed');
      }
      if (
        row.tenant !== report.tenant
        || row.shop !== report.shop
        || row.period !== report.period
      ) {
        throw new ReleaseRefused(409, 'row_scope_mismatch', `row ${row.id} is outside the report scope`);
      }
      if (!snapshot.rowIds.includes(row.id)) {
        throw new ReleaseRefused(409, 'row_scope_mismatch', `row ${row.id} is not in the snapshot`);
      }
      if (byId.has(row.id)) {
        throw new ReleaseRefused(409, 'row_scope_mismatch', `row ${row.id} appears twice`);
      }
      if (!Number.isSafeInteger(row.grossPayPence) || row.grossPayPence < 0) {
        throw new ReleaseRefused(502, 'invalid_ledger_row', `row ${row.id} has no valid amount`);
      }
      byId.set(row.id, row);
    }
    for (const rowId of snapshot.rowIds) {
      if (!byId.has(rowId)) {
        throw new ReleaseRefused(409, 'row_scope_mismatch', `snapshot row ${rowId} is missing`);
      }
    }

    return snapshot.rowIds.map((rowId) => byId.get(rowId));
  };

  const applyAssignment = async ({ principal, role, tenant, shop, from, to = null }) => {
    const response = await gateway.call(urls.directoryProxy, {
      audience: 'directory',
      subject: principal,
      onBehalfOf: null,
      tenant,
      op: 'replace-assignment',
      resource: { type: 'assignment', id: principal },
      args: { principal, role, tenant, shop, from, to },
    });
    if (response.status !== 200 || !Number.isSafeInteger(response.body?.version)) {
      throw new HttpError(
        502,
        'directory_update_failed',
        `directory update failed with status ${response.status}`,
      );
    }
    return response.body;
  };

  const release = async ({ report, principal, requestId }) => {
    const now = clock();
    const policyState = await activePolicy();
    const before = await readAssignments(principal, report.tenant, report.shop);

    const firstDecision = evaluateRelease(policyState.policy, {
      principal,
      tenant: report.tenant,
      shop: report.shop,
      assignments: before.assignments,
      at: now,
    });
    if (firstDecision.verdict !== 'allow') {
      await appendRelease({
        requestId,
        caller: 'gateway',
        subject: principal,
        recipient: principal,
        reportId: report.reportId,
        policyHash: policyState.hash,
        directoryVersion: before.version,
        snapshotId: report.snapshotId,
        rowIds: [],
        rowCount: 0,
        verdict: 'refuse',
        reason: firstDecision.reason,
      });
      throw new ReleaseRefused(403, 'release_refused', firstDecision.reason);
    }

    let rows;
    try {
      const ledgerBody = await readLedgerRows({
        principal,
        tenant: report.tenant,
        shop: report.shop,
        period: report.period,
        snapshotId: report.snapshotId,
      });
      rows = validateRows(report, ledgerBody);
    } catch (error) {
      const refusal = asRefusal(error);
      if (!(refusal instanceof ReleaseRefused)) {
        throw refusal;
      }
      await appendRelease({
        requestId,
        caller: 'gateway',
        subject: principal,
        recipient: principal,
        reportId: report.reportId,
        policyHash: policyState.hash,
        directoryVersion: before.version,
        snapshotId: report.snapshotId,
        rowIds: [],
        rowCount: 0,
        verdict: 'refuse',
        reason: refusal.reason,
      });
      throw refusal;
    }

    const rowIds = rows.map((row) => row.id);
    const view = rows.map((row) => ({
      employeeRef: row.employeeRef,
      grossPay: formatPence(row.grossPayPence),
    }));
    const viewId = randomUUID();

    return withLock(async () => {
      // The hook runs inside the lock so a transfer or promotion is ordered
      // before the commit. It must mutate only through `applyAssignment` and
      // `promotePolicy`; the coordinator's own locked methods would deadlock
      // here.
      if (onBeforeCommit !== undefined) {
        await onBeforeCommit({
          report: { ...report },
          principal,
          applyAssignment,
          promotePolicy: applyPromotion,
        });
      }

      const after = await readAssignments(principal, report.tenant, report.shop);
      const commitPolicy = await activePolicy();

      const common = {
        requestId,
        caller: 'gateway',
        subject: principal,
        recipient: principal,
        reportId: report.reportId,
        directoryVersion: after.version,
        snapshotId: report.snapshotId,
        viewId,
        rowIds,
        rowCount: rows.length,
      };

      if (after.version !== before.version) {
        await appendRelease({
          ...common,
          directoryVersion: before.version,
          commitDirectoryVersion: after.version,
          policyHash: policyState.hash,
          verdict: 'refuse',
          reason: 'directory_changed',
        });
        throw new ReleaseRefused(409, 'release_refused', 'directory_changed');
      }

      const commitDecision = evaluateRelease(commitPolicy.policy, {
        principal,
        tenant: report.tenant,
        shop: report.shop,
        assignments: after.assignments,
        at: clock(),
      });
      if (commitDecision.verdict !== 'allow') {
        await appendRelease({
          ...common,
          policyHash: commitPolicy.hash,
          verdict: 'refuse',
          reason: commitDecision.reason,
        });
        throw new ReleaseRefused(403, 'release_refused', commitDecision.reason);
      }

      const entry = {
        ...common,
        policyHash: policyState.hash,
        verdict: 'allow',
      };
      if (commitPolicy.hash !== policyState.hash) {
        entry.commitPolicyHash = commitPolicy.hash;
        entry.reason = 'policy_revalidated';
      }
      await appendRelease(entry);

      return { reportId: report.reportId, rows: view };
    });
  };

  const open = async ({ principal, reportId }) => {
    const report = reports.get(reportId);
    if (report === undefined) {
      throw new ReleaseRefused(404, 'unknown_report', `unknown report ${reportId}`);
    }
    const requestId = randomUUID();
    try {
      return await release({ report, principal, requestId });
    } catch (error) {
      const refusal = asRefusal(error);
      if (refusal instanceof ReleaseRefused) {
        throw refusal;
      }
      throw error;
    }
  };

  const replaceAssignment = (fields) => withLock(() => applyAssignment(fields));
  const promotePolicy = (policy, approver) => withLock(
    () => applyPromotion(policy, approver),
  );

  return {
    prepare,
    open,
    replaceAssignment,
    promotePolicy,
  };
}
