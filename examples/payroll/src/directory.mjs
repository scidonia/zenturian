// Authoritative directory service.
//
// It exposes only POST /rpc, and only to its own proxy: every call must carry the
// per-component forward secret. The directory is authoritative for principal
// assignments and for an employee's current shop; every response carries the
// assignment version so a release commit can detect a change made while it was
// preparing.

import fixture from '../fixture.mjs';
import {
  createServiceServer,
  HttpError,
  readJsonBody,
  requireString,
  sendJson,
} from './http.mjs';
import { nowSeconds, timingSafeTextEqual } from './keys.mjs';

function assignmentDay(at) {
  if (at instanceof Date) {
    return at.toISOString().slice(0, 10);
  }
  if (typeof at === 'number') {
    return new Date(at * 1000).toISOString().slice(0, 10);
  }
  return String(at).slice(0, 10);
}

export function isActive(assignment, at = nowSeconds()) {
  const day = assignmentDay(at);
  if (assignment.from !== null && day < assignment.from) {
    return false;
  }
  if (assignment.to !== null && day > assignment.to) {
    return false;
  }
  return true;
}

function optionalString(container, field) {
  const value = container[field];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string' || value.length === 0) {
    throw new HttpError(400, 'invalid_args', `args.${field} must be a string or null`);
  }
  return value;
}

export async function createServer({
  principals = fixture.principals,
  assignments = fixture.assignments,
  forwardSecret,
  clock = nowSeconds,
} = {}) {
  if (typeof forwardSecret !== 'string' || forwardSecret.length === 0) {
    throw new TypeError('directory requires a forwardSecret');
  }

  const principalById = new Map(principals.map((record) => [record.id, record]));
  const records = assignments.map((assignment) => ({ ...assignment }));
  const invocations = { rpc: 0 };
  let version = 1;

  const service = await createServiceServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method !== 'POST' || url.pathname !== '/rpc') {
      throw new HttpError(404, 'not_found', 'unknown route');
    }
    if (!timingSafeTextEqual(req.headers['x-zenturian-forward'], forwardSecret)) {
      throw new HttpError(401, 'forward_secret_required', 'the directory accepts calls only from its proxy');
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
      case 'assignments': {
        const tenant = requireString(callArgs, 'tenant');
        const shop = callArgs.shop === undefined
          ? null
          : requireString(callArgs, 'shop');
        const selected = records.filter((assignment) => (
          assignment.tenant === tenant
          && (shop === null || assignment.shop === shop)
        ));
        sendJson(res, 200, { version, assignments: selected });
        return;
      }

      case 'principal': {
        const principal = requireString(callArgs, 'principal');
        const record = principalById.get(principal);
        if (record === undefined) {
          throw new HttpError(404, 'unknown_principal', `unknown principal ${principal}`);
        }
        const active = records.find((assignment) => (
          assignment.principal === principal && isActive(assignment, clock())
        ));
        sendJson(res, 200, {
          version,
          principal,
          tenant: record.tenant,
          currentShop: active === undefined ? null : active.shop,
        });
        return;
      }

      case 'replace-assignment': {
        const principal = requireString(callArgs, 'principal');
        const role = requireString(callArgs, 'role');
        const tenant = requireString(callArgs, 'tenant');
        const shop = requireString(callArgs, 'shop');
        const from = requireString(callArgs, 'from');
        const to = optionalString(callArgs, 'to');

        for (let index = records.length - 1; index >= 0; index -= 1) {
          const existing = records[index];
          if (
            existing.principal === principal
            && existing.tenant === tenant
            && existing.shop === shop
          ) {
            records.splice(index, 1);
          }
        }
        records.push({ principal, role, tenant, shop, from, to });
        version += 1;
        sendJson(res, 200, { version });
        return;
      }

      default:
        throw new HttpError(400, 'unknown_op', `unknown directory op ${op}`);
    }
  });

  return Object.assign(service, {
    invocations,
    version: () => version,
  });
}
