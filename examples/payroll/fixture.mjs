// Synthetic payroll fixture for the Zenturian pilot.
//
// The ledger is authoritative for the shop charged in a pay period and for the
// amount. The directory is authoritative for principal assignments and for an
// employee's current shop. E102 transferred to Cardiff after October, so the
// directory places them in north/cardiff while October row L2 stays charged to
// north/bristol.

export const tenants = [
  { id: 'north', name: 'North' },
  { id: 'south', name: 'South' },
];

export const shops = [
  { id: 'north/bristol', tenant: 'north', name: 'Bristol' },
  { id: 'north/cardiff', tenant: 'north', name: 'Cardiff' },
  { id: 'south/bristol', tenant: 'south', name: 'Bristol' },
];

export const principals = [
  { id: 'nora', name: 'Nora', tenant: 'north' },
  { id: 'alice', name: 'Alice', tenant: 'north' },
  { id: 'ben', name: 'Ben', tenant: 'north' },
  { id: 'cara', name: 'Cara', tenant: 'north' },
  { id: 'dana', name: 'Dana', tenant: 'north' },
  { id: 'sam', name: 'Sam', tenant: 'south' },
];

export const assignments = [
  {
    principal: 'nora',
    role: 'payroll-preparer',
    tenant: 'north',
    shop: 'north/bristol',
    from: '2025-01-01',
    to: null,
  },
  {
    principal: 'alice',
    role: 'manager',
    tenant: 'north',
    shop: 'north/bristol',
    from: '2026-01-01',
    to: null,
  },
  {
    principal: 'ben',
    role: 'designated-successor',
    tenant: 'north',
    shop: 'north/bristol',
    from: '2026-01-01',
    to: null,
  },
  {
    principal: 'cara',
    role: 'manager',
    tenant: 'north',
    shop: 'north/cardiff',
    from: '2025-06-01',
    to: null,
  },
  {
    principal: 'dana',
    role: 'acting-manager',
    tenant: 'north',
    shop: 'north/bristol',
    from: '2026-11-01',
    to: '2026-11-30',
  },
  {
    principal: 'sam',
    role: 'manager',
    tenant: 'south',
    shop: 'south/bristol',
    from: '2024-01-01',
    to: null,
  },
];

export const employees = [
  { employeeRef: 'E101', tenant: 'north', currentShop: 'north/bristol' },
  { employeeRef: 'E102', tenant: 'north', currentShop: 'north/cardiff' },
  { employeeRef: 'E103', tenant: 'north', currentShop: 'north/cardiff' },
  { employeeRef: 'E104', tenant: 'south', currentShop: 'south/bristol' },
];

export const periods = [
  { id: '2026-10', status: 'closed' },
];

export const ledgerRows = [
  {
    id: 'L1',
    tenant: 'north',
    shop: 'north/bristol',
    period: '2026-10',
    employeeRef: 'E101',
    grossPayPence: 310000,
  },
  {
    id: 'L2',
    tenant: 'north',
    shop: 'north/bristol',
    period: '2026-10',
    employeeRef: 'E102',
    grossPayPence: 285000,
  },
  {
    id: 'L3',
    tenant: 'north',
    shop: 'north/cardiff',
    period: '2026-10',
    employeeRef: 'E103',
    grossPayPence: 302000,
  },
  {
    id: 'L4',
    tenant: 'south',
    shop: 'south/bristol',
    period: '2026-10',
    employeeRef: 'E104',
    grossPayPence: 327500,
  },
];

export const snapshots = [
  {
    id: 'snap-north-bristol-2026-10',
    tenant: 'north',
    shop: 'north/bristol',
    period: '2026-10',
    rowIds: ['L1', 'L2'],
  },
  {
    id: 'snap-north-cardiff-2026-10',
    tenant: 'north',
    shop: 'north/cardiff',
    period: '2026-10',
    rowIds: ['L3'],
  },
  {
    id: 'snap-south-bristol-2026-10',
    tenant: 'south',
    shop: 'south/bristol',
    period: '2026-10',
    rowIds: ['L4'],
  },
];

const fixture = {
  tenants,
  shops,
  principals,
  assignments,
  employees,
  periods,
  ledgerRows,
  snapshots,
};

export default fixture;
