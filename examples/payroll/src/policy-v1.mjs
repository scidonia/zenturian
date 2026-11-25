// Immutable policy value: version 1.
//
// The rules allow the gateway to read assignments, ledger rows and snapshots and
// to store report metadata. The release rule permits only an active `manager` of
// the report's tenant and shop at commit.

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

export const policyV1 = deepFreeze({
  version: 'v1',
  rules: [
    {
      id: 'directory.assignments',
      caller: 'gateway',
      audience: 'directory',
      op: 'assignments',
      resourceType: 'shop',
    },
    {
      id: 'directory.principal',
      caller: 'gateway',
      audience: 'directory',
      op: 'principal',
      resourceType: 'assignment',
    },
    {
      id: 'directory.replace-assignment',
      caller: 'gateway',
      audience: 'directory',
      op: 'replace-assignment',
      resourceType: 'assignment',
    },
    {
      id: 'ledger.snapshot',
      caller: 'gateway',
      audience: 'ledger',
      op: 'snapshot',
      resourceType: 'shop',
    },
    {
      id: 'ledger.rows',
      caller: 'gateway',
      audience: 'ledger',
      op: 'rows',
      resourceType: 'ledger-scope',
    },
    {
      id: 'reporting.store',
      caller: 'gateway',
      audience: 'reporting',
      op: 'store',
      resourceType: 'report',
    },
  ],
  release: {
    version: 'v1',
    requiredRole: 'manager',
  },
});
