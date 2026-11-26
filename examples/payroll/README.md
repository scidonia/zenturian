# Payroll pilot — executable JavaScript model

This directory is a runnable model of the Zenturian payroll release pilot. Nora prepares a
North/Bristol October payroll report; the broker and proxies mediate every component call; and
the trusted release coordinator releases only the two authoritative Bristol rows to the current
Bristol manager, as `{employeeRef, grossPay}`.

Only the mediated path exists. The earlier direct baseline, where the portal read salary rows
without a proxy or broker, was retired when mediation landed; this example has no salary-bearing
bypass route.

## Requirements and commands

Node.js 20 or newer, with no third-party dependency. The example and the tests use only Node's
built-in modules (`http`, `crypto`, `fs` and the `test` runner), so there is nothing to install
and no build or compile step.

From the repository root:

```bash
node --version
node examples/payroll/src/demo.mjs
node --test tests/payroll/*.test.mjs
node examples/payroll-presenter/src/server.mjs
```

The demo starts each service on an ephemeral loopback port, runs the acts below, prints the audit
summary and closes the system. No environment variable is required. The test command runs the
three checked-in contract files together; each can also be run on its own.

The last command starts the presenter and prints a local page, `http://127.0.0.1:4173`. Use it to
work through the same scenarios one step at a time: choose a person, prepare and open the report,
then change the policy, the Bristol manager, the date, or the snapshot and open the report again.
Stop it with Ctrl-C. How the page calls this model is described in
[examples/payroll-presenter/README.md](../payroll-presenter/README.md).

## Fixture

`fixture.mjs` holds the synthetic data. The ledger is authoritative for the shop charged in a pay
period and for gross pay; the directory is authoritative for principal assignments and for an
employee's current shop.

- Tenants **North** and **South**, with shops `north/bristol`, `north/cardiff` and
  `south/bristol`.
- **Nora** is the `payroll-preparer` for `north/bristol`. **Alice** is its `manager`, **Ben** its
  `designated-successor`, and **Cara** manages `north/cardiff`. **Dana** holds a time-limited
  `acting-manager` appointment for `north/bristol` from `2026-11-01` to `2026-11-30`. **Sam**
  manages `south/bristol`.
- The closed October 2026 period has ledger rows `L1`–`L4`: `L1` and `L2` charged to
  `north/bristol`, `L3` to `north/cardiff`, `L4` to `south/bristol`.
- **E102** now works in Cardiff, so the directory places E102 in `north/cardiff`. Their October
  row `L2` stays charged to `north/bristol` and belongs in the Bristol report. Using the current
  shop instead of the charged shop would move the row out of the report.

## Demonstration acts

`src/demo.mjs` drives the pilot's six acts through the portal's HTTP routes; its console labels
them in its own order, with the policy change last.

1. **Establish the intended flow.** Nora prepares North/Bristol/October and receives an opaque
   report reference. Opening that reference as Nora is refused with `release_refused` and zero
   rows.
2. **Show a useful release.** Alice, the active Bristol manager, opens the same reference and
   receives exactly `E101 3100.00` and `E102 2850.00`, with no Cardiff or South row. A POST body
   naming Alice as `reader` while Nora's session is used is still refused; the portal derives the
   reader from the session and ignores the body.
3. **Change one fact.** Bristol management is transferred to Ben (Alice ends `2026-11-14`, Ben
   starts `2026-11-01`). Alice is then refused, Ben receives the two rows, and Cara and Sam stay
   refused. The tests also pause a release before commit and transfer management underneath it;
   that release is refused.
4. **Exercise the boundaries.** Cara (Cardiff) and Sam (South/Bristol) are refused. The demo also
   shows a direct ledger call without the forward secret refused, reporting's admission token
   refused at the ledger proxy, and reporting denied a ledger permit by the broker. A second
   system whose ledger read supplies `L1`, `L2` and `L3` under the Bristol snapshot refuses
   Alice's release with `row_scope_mismatch` and zero rows: the coordinator checks row scope
   before committing any salary bytes.
5. **Change the rule.** Dana is refused under policy v1. The coordinator then promotes v2, which
   adds an active, explicitly appointed `acting-manager` for the same tenant and shop, and Dana
   receives the same two rows. After Dana's appointment expires, a fresh open is refused again.
6. **Hand over the evidence.** The demo prints the hash-chained audit verification and the
   release and promotion records, and checks with an affirmative detector control that the
   released amounts appear on the release view but nowhere in the audit serialization.

The fixture diff between v1 and v2 enumerates every fixture principal at every shop across three
assignment states and labels itself as fixture coverage, not a general claim about the rule
change.

## Audit view

The broker keeps a hash-chained, in-memory audit log. Every entry records its type (`call`,
`release` or `promotion`), a request id, the caller, a verdict, and the chain envelope of
sequence number, previous hash and timestamp. A call entry carries the audience, operation,
subject, policy hash and permit nonce. A release entry carries the subject, recipient, report
reference, policy hash, directory version and snapshot, and once the report rows are validated a
view id, row ids and row count; a refusal over a directory change also records the committed
version, and an allow after a policy change at commit records both policy hashes. A promotion
entry carries the approver and the previous and new policy hashes. A `reason` is present on call
and release refusals, on every promotion, and on a release allowed after revalidating its policy
at commit; an ordinary allowed call or release has none. Release and refusal records contain no
gross-pay, bank or other salary value. A refusal returns zero rows.

The coordinator serializes directory changes, policy promotion and release commitment, and
revalidates the active policy hash and assignment version at commit. A directory change during
preparation therefore refuses the release rather than releasing rows under stale facts, and the
refusal records both the version seen while preparing and the committed version. A policy change
is re-evaluated at commit: the release records both hashes when it is still allowed, and is
refused with zero rows when it is not.

## Prototype limits

The JavaScript proxies, auth server and canonical encoder are an executable model of the Lean
boundary. They demonstrate the protocol shape and the release ordering. The model **does not prove**
Lean soundness, OS isolation, protocol refinement or salary confidentiality, and it is not the
final security boundary.

- There is no Lean theorem here: no decision-checker soundness, deployment-safety or
  canonical-injectivity result, and no kernel-checked derivation. The proxy re-evaluates the
  policy locally instead of checking one.
- There is no OS isolation. Admission tokens and the signing key live in one process family, so
  a host-level attacker or a process that reads memory can bypass the boundary. Deployment
  isolation is a later, tested property.
- There is no refinement or conformance proof between these JavaScript servers and the Lean
  LeanIO/LeanIn implementation; that binding is tested later, not proved.
- Salary confidentiality is claimed only within the modelled release path: a refused recipient
  receives zero salary bytes and a mixed-scope snapshot releases nothing. The model does not
  cover a compromised host, a recipient retaining or leaking what it legitimately received,
  timing or traffic analysis, free-text or side channels, or a lying authoritative source.
- The audit is in memory and hash-chained for demonstration; append-only storage, anchoring and
  tamper detection are not established, and the process can truncate the chain.
- The JavaScript canonical encoder and call digest are a versioned stand-in (`zcanon.v1`), not a
  proved injective encoding. The checked-in vectors are the contract with a future Lean encoder,
  not a proof.
- Ed25519, SHA-256 and the Node runtime are trusted assumptions. The dev bearer
  `dev:<principal>` is a non-production authentication stand-in resolved from a fixed map.
- Enforcing the wrong rule faithfully is still wrong: policy fidelity to the business rule is
  not established here. The fixture and its ledger and directory facts are synthetic and
  authoritative by assumption.

## Migration seam

The permanent seam is the wire protocol and the permit, not the JavaScript process:

- Components receive calls at their own internal `POST /rpc` with `{op, args}` and a
  per-component forward secret. Components call other components only through a proxy's
  `POST /v1/call` with `{op, args}` in a call envelope, an admission token and a signed permit
  header.
- The canonical call is encoded by `zcanon.v1`, whose pinned encodings and digests live in
  `test-vectors/canonical-v1.json`. The permit body, policy domain separator and audit domain
  are the versioned shapes in `src/canonical.mjs`.
- The permit carries the call digest, caller, audience, subject, tenant, policy hash, issue and
  expiry times and nonce, signed by the broker with Ed25519. A proxy fetches policy bytes by
  their hash from the broker and checks the signature, expiry, single use, policy and digest.
- The released manager view has exactly two fields, `employeeRef` and `grossPay` in GBP.

A Lean proxy and broker replace `src/proxy.mjs` and `src/auth-server.mjs` and implement the same
`POST /v1/call` envelope, `zcanon.v1` digests, signed permit body, policy-hash fetch and view
field set. Component code, the gateway's call sites, the report registry shape and the audit
record fields remain unchanged across that replacement. The JavaScript implementation then
serves as a conformance oracle for the Lean trace tests.

## Layout

```text
examples/payroll/
  fixture.mjs                 synthetic tenants, shops, principals, assignments, ledger rows
  package.json                ESM marker, Node >=20, no dependencies
  src/
    demo.mjs                  startAll assembly and the demonstration acts
    http.mjs                  loopback JSON server and client helpers
    keys.mjs                  Ed25519 keys, admission tokens, constant-time comparison
    canonical.mjs             zcanon.v1 encoder, digests, permit body
    policy.mjs                policy validation, call decisions, release rules, fixture diff
    policy-v1.mjs             v1: active manager of the report's tenant and shop
    policy-v2.mjs             v2: adds an active appointed acting-manager
    directory.mjs             authoritative assignments and current shop
    ledger.mjs                authoritative rows and snapshots
    reporting.mjs             report metadata only
    auth-server.mjs           broker: decisions, permits, policy bytes, audit chain
    proxy.mjs                 admission, permit verification, policy fetch, forwarding
    coordinator.mjs           trusted projector, release commitment, serialized revalidation
    portal.mjs                development edge; reader derived from the session
  test-vectors/
    canonical-v1.json         pinned zcanon.v1 encodings and zenturian.call.v1 digests
```

The behaviour contracts live outside the example, at the repository root:

- `tests/payroll.contract.md` — the scenario text for the mediated release and hostile paths.
- `tests/payroll/mediated.test.mjs` — release recipient, row scope, fact revalidation and audit.
- `tests/payroll/hostile.test.mjs` — direct access, admission and permit misuse.
- `tests/payroll/policy-change.test.mjs` — promotion, policy-hash serving, acting manager,
  manager transfer and expiry.
