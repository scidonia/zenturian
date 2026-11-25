// Reporting service.
//
// Reporting holds report metadata only: the report reference, its title and its
// status. It has no ledger address, no ledger client, and stores no rows, shops,
// periods or amounts. It exposes only POST /rpc, and only to its own proxy.

import {
  createServiceServer,
  HttpError,
  readJsonBody,
  requireString,
  sendJson,
} from './http.mjs';
import { timingSafeTextEqual } from './keys.mjs';

export async function createServer({ forwardSecret } = {}) {
  if (typeof forwardSecret !== 'string' || forwardSecret.length === 0) {
    throw new TypeError('reporting requires a forwardSecret');
  }

  const reports = new Map();
  const invocations = { rpc: 0 };

  const service = await createServiceServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method !== 'POST' || url.pathname !== '/rpc') {
      throw new HttpError(404, 'not_found', 'unknown route');
    }
    if (!timingSafeTextEqual(req.headers['x-zenturian-forward'], forwardSecret)) {
      throw new HttpError(401, 'forward_secret_required', 'reporting accepts calls only from its proxy');
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
      case 'store': {
        const reportId = requireString(callArgs, 'reportId');
        const title = requireString(callArgs, 'title');
        const status = requireString(callArgs, 'status');
        reports.set(reportId, { reportId, title, status });
        sendJson(res, 200, { ok: true });
        return;
      }

      default:
        throw new HttpError(400, 'unknown_op', `unknown reporting op ${op}`);
    }
  });

  return Object.assign(service, { invocations });
}
