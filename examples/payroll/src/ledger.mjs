// Authoritative ledger service.
//
// It exposes only POST /rpc, and only to its own proxy: every call must carry the
// per-component forward secret. The ledger is authoritative for the shop charged
// in a pay period, for the amount, and for snapshot membership. A snapshot is
// resolved by tenant, shop and period; its rows are returned in snapshot order.

import fixture from '../fixture.mjs';
import {
  createServiceServer,
  HttpError,
  readJsonBody,
  requireString,
  sendJson,
} from './http.mjs';
import { timingSafeTextEqual } from './keys.mjs';

function publicSnapshot(snapshot) {
  return {
    id: snapshot.id,
    tenant: snapshot.tenant,
    shop: snapshot.shop,
    period: snapshot.period,
    rowIds: [...snapshot.rowIds],
  };
}

export async function createServer({
  rows = fixture.ledgerRows,
  snapshots = fixture.snapshots,
  forwardSecret,
} = {}) {
  if (typeof forwardSecret !== 'string' || forwardSecret.length === 0) {
    throw new TypeError('ledger requires a forwardSecret');
  }

  const rowById = new Map(rows.map((row) => [row.id, row]));
  const invocations = { rpc: 0 };

  const findSnapshot = (tenant, shop, period) => snapshots.find((candidate) => (
    candidate.tenant === tenant
    && candidate.shop === shop
    && candidate.period === period
  ));

  const service = await createServiceServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method !== 'POST' || url.pathname !== '/rpc') {
      throw new HttpError(404, 'not_found', 'unknown route');
    }
    if (!timingSafeTextEqual(req.headers['x-zenturian-forward'], forwardSecret)) {
      throw new HttpError(401, 'forward_secret_required', 'the ledger accepts calls only from its proxy');
    }
    invocations.rpc += 1;

    const request = await readJsonBody(req);
    const { op, args } = request;
    if (typeof op !== 'string') {
      throw new HttpError(400, 'invalid_request', 'rpc body requires an op string');
    }
    if (args !== undefined && (args === null || typeof args !== 'object' || Array.isArray(args))) {
      throw new HttpError(400, 'invalid_request', 'rpc args must be an object');
    }
    const callArgs = args ?? {};

    switch (op) {
      case 'snapshot': {
        const tenant = requireString(callArgs, 'tenant');
        const shop = requireString(callArgs, 'shop');
        const period = requireString(callArgs, 'period');
        const snapshot = findSnapshot(tenant, shop, period);
        if (snapshot === undefined) {
          throw new HttpError(
            404,
            'unknown_snapshot',
            `no closed snapshot for ${tenant}/${shop} ${period}`,
          );
        }
        sendJson(res, 200, { snapshot: publicSnapshot(snapshot) });
        return;
      }

      case 'rows': {
        const tenant = requireString(callArgs, 'tenant');
        const shop = requireString(callArgs, 'shop');
        const period = requireString(callArgs, 'period');
        const snapshotId = requireString(callArgs, 'snapshotId');

        const snapshot = snapshots.find((candidate) => candidate.id === snapshotId);
        if (
          snapshot === undefined
          || snapshot.tenant !== tenant
          || snapshot.shop !== shop
          || snapshot.period !== period
        ) {
          throw new HttpError(
            404,
            'unknown_snapshot',
            `snapshot ${snapshotId} does not belong to ${tenant}/${shop} ${period}`,
          );
        }

        const selected = [];
        for (const rowId of snapshot.rowIds) {
          const row = rowById.get(rowId);
          if (row === undefined) {
            throw new HttpError(
              500,
              'snapshot_incomplete',
              `snapshot ${snapshotId} references unknown row ${rowId}`,
            );
          }
          selected.push({ ...row });
        }
        sendJson(res, 200, { snapshot: publicSnapshot(snapshot), rows: selected });
        return;
      }

      default:
        throw new HttpError(400, 'unknown_op', `unknown ledger op ${op}`);
    }
  });

  return Object.assign(service, { invocations });
}
