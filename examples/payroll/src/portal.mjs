// Portal: the development edge and release gateway.
//
// The dev bearer names a principal from a server-side map. Preparation checks the
// principal's preparer assignment and the closed period through the coordinator.
// Opening a report resolves the reader from the session only: any `reader`,
// `subject` or `tenant` field on the request body is ignored. A release response
// is never cacheable and a refusal carries no salary row.

import fixture from '../fixture.mjs';
import {
  createServiceServer,
  HttpError,
  readJsonBody,
  requireString,
  sendJson,
} from './http.mjs';
import { ReleaseRefused } from './coordinator.mjs';

function authenticate(req, principalById) {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
    return null;
  }
  const token = header.slice('Bearer '.length);
  if (!token.startsWith('dev:')) {
    return null;
  }
  const principal = token.slice('dev:'.length);
  return principalById.has(principal) ? principal : null;
}

// The open route also accepts POST so a caller can demonstrate that a body field
// such as `reader` is ignored. The body is read and discarded, never interpreted.
async function discardBody(req, limit = 64 * 1024) {
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      req.destroy();
      return;
    }
  }
}

function sendRefusal(res, status, reportId, code, reason) {
  res.setHeader('cache-control', 'no-store');
  sendJson(res, status, {
    reportId,
    rows: [],
    error: { code, message: reason },
  });
}

export async function createServer({
  coordinator,
  principals = fixture.principals,
} = {}) {
  if (
    coordinator === undefined
    || typeof coordinator.prepare !== 'function'
    || typeof coordinator.open !== 'function'
  ) {
    throw new TypeError('portal requires the release coordinator');
  }

  const principalById = new Map(principals.map((record) => [record.id, record]));

  return createServiceServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');

    if (req.method === 'POST' && url.pathname === '/v1/reports') {
      const principal = authenticate(req, principalById);
      if (principal === null) {
        throw new HttpError(401, 'unauthenticated', 'a valid dev bearer is required');
      }

      const body = await readJsonBody(req);
      const tenant = requireString(body, 'tenant');
      const shop = requireString(body, 'shop');
      const period = requireString(body, 'period');

      const reportId = await coordinator.prepare({ principal, tenant, shop, period });
      sendJson(res, 200, { reportId });
      return;
    }

    const openMatch = req.method === 'GET' || req.method === 'POST'
      ? url.pathname.match(/^\/v1\/reports\/([^/]+)\/open$/)
      : null;
    if (openMatch !== null) {
      res.setHeader('cache-control', 'no-store');

      const principal = authenticate(req, principalById);
      if (principal === null) {
        throw new HttpError(401, 'unauthenticated', 'a valid dev bearer is required');
      }

      if (req.method === 'POST') {
        await discardBody(req);
      }

      const reportId = decodeURIComponent(openMatch[1]);
      try {
        const released = await coordinator.open({ principal, reportId });
        sendJson(res, 200, { reportId: released.reportId, rows: released.rows });
      } catch (error) {
        if (error instanceof ReleaseRefused) {
          sendRefusal(res, error.status, reportId, error.code, error.reason);
          return;
        }
        throw error;
      }
      return;
    }

    throw new HttpError(404, 'not_found', 'unknown route');
  });
}
