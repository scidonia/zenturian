// Immutable policy value: version 2.
//
// The call rules are the v1 rules. The release rule additionally permits an
// active, explicitly appointed `acting-manager` of the report's tenant and shop
// at commit. The released view is unchanged: one { employeeRef, grossPay } row
// per ledger row, in snapshot order.

import { policyV1 } from './policy-v1.mjs';

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

export const policyV2 = deepFreeze({
  version: 'v2',
  rules: policyV1.rules,
  release: {
    version: 'v2',
    requiredRole: 'manager',
    actingRole: 'acting-manager',
  },
});
