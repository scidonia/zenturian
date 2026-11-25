// Policy value helpers, call decisions, release rules and the fixture diff.
//
// A policy is plain immutable data: `policy-v1.mjs` and `policy-v2.mjs` export
// the immutable values, the auth server stores and serves their canonical bytes
// by hash, and a proxy re-evaluates the call against the bytes its permit names.
//
// The release rule is evaluated by the trusted coordinator from the policy value
// and authoritative assignment facts. v1 permits an active manager of the
// report's tenant and shop. v2 additionally permits an active, explicitly
// appointed acting-manager of the same tenant and shop. An unknown release
// version is refused rather than guessed.

import { POLICY_DOMAIN, sha256Hex, zcanon } from './canonical.mjs';
import { isActive } from './directory.mjs';
import fixture from '../fixture.mjs';
import { policyV1 } from './policy-v1.mjs';
import { policyV2 } from './policy-v2.mjs';

export const PERMIT_TTL_SECONDS = 30;
export const RELEASE_PERMIT_TTL_SECONDS = 5;

const RELEASE_SENSITIVE_OPS = new Set(['rows']);

const POLICY_FIELDS = ['version', 'rules', 'release'];
const RULE_FIELDS = ['id', 'caller', 'audience', 'op', 'resourceType'];
const RELEASE_FIELDS = ['version', 'requiredRole', 'actingRole'];

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requirePolicyString(container, field, label) {
  const value = container[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label}.${field} must be a non-empty string`);
  }
  return value;
}

function rejectExtraFields(value, allowed, label) {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length > 0) {
    throw new TypeError(`${label} has unknown fields: ${extra.join(', ')}`);
  }
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const nested of Object.values(value)) {
    deepFreeze(nested);
  }
  return value;
}

// Validates the small policy shape the auth server may promote. A value with an
// unknown field, rule shape or release version is refused rather than hashed and
// activated, so a malformed policy cannot become the active bytes.
export function validatePolicy(policy) {
  if (!isPlainObject(policy)) {
    throw new TypeError('policy must be a plain object');
  }
  rejectExtraFields(policy, POLICY_FIELDS, 'policy');
  requirePolicyString(policy, 'version', 'policy');

  if (!Array.isArray(policy.rules) || policy.rules.length === 0) {
    throw new TypeError('policy.rules must be a non-empty array');
  }
  for (const rule of policy.rules) {
    if (!isPlainObject(rule)) {
      throw new TypeError('policy.rules entries must be plain objects');
    }
    rejectExtraFields(rule, RULE_FIELDS, 'policy rule');
    for (const field of ['id', 'caller', 'audience', 'op']) {
      requirePolicyString(rule, field, `policy rule ${rule.id ?? '?'}`);
    }
    if (rule.resourceType !== undefined) {
      requirePolicyString(rule, 'resourceType', `policy rule ${rule.id}`);
    }
  }

  if (!isPlainObject(policy.release)) {
    throw new TypeError('policy.release must be a plain object');
  }
  rejectExtraFields(policy.release, RELEASE_FIELDS, 'policy release');
  requirePolicyString(policy.release, 'version', 'policy release');
  requirePolicyString(policy.release, 'requiredRole', 'policy release');
  if (policy.release.version !== policy.version) {
    throw new TypeError('policy.release.version must match policy.version');
  }

  if (policy.release.version === 'v1') {
    if (policy.release.actingRole !== undefined) {
      throw new TypeError('a v1 policy release does not carry an actingRole');
    }
  } else if (policy.release.version === 'v2') {
    requirePolicyString(policy.release, 'actingRole', 'policy release');
  } else {
    throw new TypeError(`unsupported release policy version ${policy.release.version}`);
  }

  return policy;
}

export function freezePolicy(policy) {
  validatePolicy(policy);
  return deepFreeze(policy);
}

export function policyBytes(policy) {
  return zcanon(policy);
}

export function policyHash(policy) {
  return sha256Hex(`${POLICY_DOMAIN}${policyBytes(policy)}`);
}

export function permitTtlSeconds(op) {
  return RELEASE_SENSITIVE_OPS.has(op)
    ? RELEASE_PERMIT_TTL_SECONDS
    : PERMIT_TTL_SECONDS;
}

// Default deny: a call is allowed only by an explicit rule for its caller,
// audience and operation. The returned rule id is what a proxy re-checks against
// the signed permit.
export function decideCall(policy, call) {
  const rules = Array.isArray(policy?.rules) ? policy.rules : [];
  for (const rule of rules) {
    if (
      rule.caller === call.caller
      && rule.audience === call.audience
      && rule.op === call.op
      && (rule.resourceType === undefined || rule.resourceType === call.resource.type)
    ) {
      return { verdict: 'allow', ruleId: rule.id };
    }
  }
  return { verdict: 'deny', ruleId: null, reason: 'no_matching_rule' };
}

function hasActiveAssignment(assignments, principal, tenant, shop, role, at) {
  return assignments.some((assignment) => (
    assignment.principal === principal
    && assignment.role === role
    && assignment.tenant === tenant
    && assignment.shop === shop
    && isActive(assignment, at)
  ));
}

export function evaluateRelease(policy, { principal, tenant, shop, assignments, at }) {
  const release = policy?.release;
  if (release?.version === 'v1') {
    const matched = hasActiveAssignment(
      assignments,
      principal,
      tenant,
      shop,
      release.requiredRole,
      at,
    );
    return matched
      ? { verdict: 'allow', ruleId: 'release.v1.manager' }
      : {
        verdict: 'deny',
        ruleId: 'release.v1.manager',
        reason: 'recipient_not_permitted',
      };
  }
  if (release?.version === 'v2') {
    if (hasActiveAssignment(assignments, principal, tenant, shop, release.requiredRole, at)) {
      return { verdict: 'allow', ruleId: 'release.v2.manager' };
    }
    if (hasActiveAssignment(assignments, principal, tenant, shop, release.actingRole, at)) {
      return { verdict: 'allow', ruleId: 'release.v2.acting-manager' };
    }
    return {
      verdict: 'deny',
      ruleId: 'release.v2.manager-or-acting-manager',
      reason: 'recipient_not_permitted',
    };
  }
  return {
    verdict: 'deny',
    ruleId: null,
    reason: 'unknown_release_rule',
  };
}

function epochSeconds(iso) {
  return Math.floor(Date.parse(iso) / 1000);
}

// The fixture's assignment states: before the acting appointment, while it is
// active, and after it has expired.
export const FIXTURE_DECISION_STATES = Object.freeze([
  Object.freeze({ label: 'before-acting-assignment', at: epochSeconds('2026-10-15T00:00:00Z') }),
  Object.freeze({ label: 'acting-assignment-active', at: epochSeconds('2026-11-15T00:00:00Z') }),
  Object.freeze({ label: 'after-assignment-expiry', at: epochSeconds('2026-12-15T00:00:00Z') }),
]);

// Enumerates every fixture principal at every fixture shop for each fixture
// assignment state and reports the effective decision under two policies. The
// result labels itself as fixture coverage: it is a finite sample of the
// fixture, not a general claim about the policy change.
export function diffEffectiveDecisions({
  fixtureData = fixture,
  from = policyV1,
  to = policyV2,
  states = FIXTURE_DECISION_STATES,
} = {}) {
  const decisions = [];
  for (const state of states) {
    for (const principal of fixtureData.principals) {
      for (const shop of fixtureData.shops) {
        const context = {
          principal: principal.id,
          tenant: shop.tenant,
          shop: shop.id,
          assignments: fixtureData.assignments,
          at: state.at,
        };
        const before = evaluateRelease(from, context);
        const after = evaluateRelease(to, context);
        decisions.push({
          principal: principal.id,
          tenant: shop.tenant,
          shop: shop.id,
          state: state.label,
          at: state.at,
          from: before,
          to: after,
          changed: before.verdict !== after.verdict,
        });
      }
    }
  }

  const changes = decisions.filter((decision) => decision.changed);
  return {
    label: 'fixture coverage',
    coverage: 'fixture',
    fixture: 'examples/payroll/fixture.mjs',
    from: { version: from.version, hash: policyHash(from) },
    to: { version: to.version, hash: policyHash(to) },
    states: states.map((state) => ({ ...state })),
    decisions,
    changes,
    changedCount: changes.length,
  };
}
