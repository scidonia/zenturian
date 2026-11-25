# Payroll release contract — mediated path

These are the behaviour checks for the mediated payroll release. Each check drives
the assembled system only through its loopback HTTP surfaces and reads parsed JSON
responses; none reaches into a component's internals. A check starts its own system
on `127.0.0.1:0` and closes it when the check finishes.

The same checks run against two trees. On the tree with the auth server, the system
is assembled by `startAll` from `examples/payroll/src/demo.mjs`. On the direct
baseline only `directory`, `ledger`, `reporting` and `portal` exist, and the harness
assembles those four. Date-sensitive checks inject the fixed epoch second for
`2026-11-15T00:00:00Z`; H8 advances a mutable clock past the permit lifetime.

Fixture bindings: `L1` and `L2` are the two authoritative `north/bristol` October
rows (`E101` at 310000 pence, `E102` at 285000 pence). `L3` is the authoritative
`north/cardiff` October row (`E103` at 302000 pence) and must never appear in a
Bristol release. Amounts are rendered by the same pence formatter the portal uses.

## Mediated release

### M1

**Actor.** Alice, an active `manager` for `north/bristol`.

**Boundary.** Portal `POST /v1/reports` as Nora prepares the report; portal
`GET /v1/reports/<id>/open` as Alice releases it.

**Observable outcome.** `200`; `cache-control: no-store`; `rows` is exactly the two
authoritative Bristol October rows `E101 3100.00` and `E102 2850.00`, each row
carrying only `employeeRef` and `grossPay`; `E103` and `E104` are absent.

**Expected failure without the mediated path.** The direct baseline returns three
rows for the tenant and period (`L1`, `L2`, `L3`), so the row-set assertion fails.

**Positive control.** The same preparation and open, proving the route is live and
the expected pair is reachable.

### M2

**Actor.** Nora, `payroll-preparer` for `north/bristol`, opening the report she
prepared.

**Boundary.** Portal `POST /v1/reports`, then `GET /v1/reports/<id>/open` as Nora.

**Observable outcome.** `403` with error code `release_refused`; `rows` is `[]`;
`cache-control: no-store`; the serialized body contains neither amount literal.

**Expected failure without the mediated path.** The direct baseline answers `200`
with rows, so the status assertion fails first.

**Positive control.** Alice's `GET /v1/reports/<id>/open` on the same report returns
`200` with the two Bristol rows; see M1.

### M3

**Actor.** Nora, posting a body that names Alice as the reader.

**Boundary.** Portal `POST /v1/reports/<id>/open` with the JSON body
`{"reader":"alice"}` and Nora's bearer.

**Observable outcome.** `403` `release_refused`, `rows: []`, `no-store`, no amount
literal. The positive control posts `{"reader":"nora"}` with Alice's bearer and
expects `200` with the two Bristol rows, proving the verb is live and the body is
ignored in both directions.

**Expected failure without the mediated path.** The direct baseline has no `POST`
open route, so the check cannot run there. The expected failure appears when the
open route takes `body.reader` as the principal: Alice's control then selects Nora
and is refused too, failing the control's `200` assertion.

**Positive control.** Alice's body-selected open returns the two rows.

### M4

**Actor.** Cara, `manager` for `north/cardiff`, and Sam, `manager` for
`south/bristol`.

**Boundary.** `GET /v1/reports/<id>/open` for each.

**Observable outcome.** Each is `403` `release_refused` with `rows: []`,
`no-store`, and no amount literal. The positive control is Alice's open returning
`200` with the two Bristol rows.

**Expected failure without the mediated path.** The direct baseline returns `200`
with rows to both, so Cara's status assertion fails first.

**Positive control.** Alice's open on the same report returns the two rows.

### M5

**Actor.** Alice, opening a report whose ledger read supplies the Bristol snapshot
carrying the authoritative Cardiff row.

**Boundary.** `GET /v1/reports/<id>/open`, in a system whose `ledgerRead` returns
snapshot `snap-north-bristol-2026-10` with `rowIds ["L1","L2","L3"]` and the three
authoritative fixture rows, `L3` charged to `north/cardiff`.

**Observable outcome.** `409` `row_scope_mismatch`, `rows: []`, `no-store`, no
amount literal. The supplied rows are asserted equal to the authoritative fixture
rows and the supplied snapshot scope equal to the report scope, so the refusal is
the projector's row-scope check rather than an unavailable source. The positive
control is a default system's Alice open returning `200` with the two rows.

**Expected failure without the mediated path.** The direct baseline has no
coordinator, so the check cannot run there. The expected failure appears when the
coordinator's `row.shop !== report.shop` comparison is removed: the Cardiff row
passes scope and Alice receives three rows.

**Positive control.** A default system's Alice open returns exactly the two Bristol
rows.

### M6

**Actor.** Alice releasing the report, then an audit reader holding the broker's
admin token.

**Boundary.** `GET /v1/reports/<id>/open`, then auth server `GET /v1/audit` with the
admin header.

**Observable outcome.** The audit chain verifies (`verify.ok === true`). Exactly one
release entry names the report: `verdict: "allow"`, `rowIds` exactly `["L1","L2"]`,
`rowCount: 2`, `subject` and `recipient` `"alice"`, `snapshotId` the report's
snapshot, `policyHash` the active 64-character lower-case hex digest, integer
`directoryVersion`, non-empty string `viewId`, and no `grossPay` key. The same
amount detector finds both literals on the release view text and none in
`JSON.stringify(entries)`.

**Expected failure without the mediated path.** The direct baseline has no broker
audit log, so the check cannot run there. The expected failure appears when
`rowIds` and `rowCount` are omitted from the release entry: the record-shape
assertion fails. The absence half is not produced by removing a check; its detector
control runs in the same pass.

**Positive control.** The detector returns both amount literals on the release view
text.

### M7

**Actor.** Alice opening the report while her Bristol manager assignment ends
`2026-11-14`, then Ben opening it after his Bristol manager assignment begins
`2026-11-01`. The directory transfer runs once, inside the open's commit hook.

**Boundary.** `GET /v1/reports/<id>/open` as Alice, then as Ben, then auth server
`GET /v1/audit` with the admin header.

**Observable outcome.** Alice is refused `409` with error code `release_refused`,
message `directory_changed`, `rows: []`, `no-store`, and no amount literal. Ben
receives `200` with exactly the two Bristol rows and `no-store`. The audit holds
Alice's `verdict: "refuse"`, `reason: "directory_changed"` entry and Ben's
`verdict: "allow"` entry for the same report; both carry integer directory
versions with `refusal.directoryVersion !== allow.directoryVersion` and
`refusal.commitDirectoryVersion === allow.directoryVersion`.

**Expected failure without the mediated path.** The direct baseline has no
coordinator, so the check cannot run there. The expected failure appears when the
commit-time assignment-version comparison is removed: Alice's commit proceeds with
her pre-transfer view and returns `200`.

**Positive control.** Ben's open after the transfer returns the two rows, and the
audit's version relation ties the refusal to the committed version.

## Direct access and permit misuse

### H1

**Actor.** An unauthenticated loopback caller.

**Boundary.** Ledger proxy `POST /v1/call` with a canonical gateway-to-ledger
`snapshot` call and neither an admission nor a permit header.

**Observable outcome.** `401` `unauthenticated`; the ledger invocation counter does
not move. The positive control is the same call through `createGatewayClient`,
which returns `200` with snapshot `snap-north-bristol-2026-10` and moves the counter
by one.

**Expected failure without the mediated path.** The direct baseline has no ledger
proxy, so the check cannot run there. The expected failure appears when admission
resolution defaults to `gateway` for an unmatched token: the refused call reaches
`permit_required` (`401`) instead of `unauthenticated` (`401`).

**Positive control.** The gateway client's call returns the Bristol snapshot.

### H2

**Actor.** A caller holding reporting's admission token.

**Boundary.** Ledger proxy `POST /v1/call` with the same call and only reporting's
token.

**Observable outcome.** `401` `unauthenticated`; the ledger invocation counter does
not move. The positive control is the gateway client's call succeeding.

**Expected failure without the mediated path.** The direct baseline has no ledger
proxy, so the check cannot run there. The expected failure is the same
admission-resolution removal as H1.

**Positive control.** The gateway client's call returns the Bristol snapshot.

### H3

**Actor.** A direct loopback caller.

**Boundary.** Ledger `POST /rpc` with `{"op":"rows","args":{"tenant":"north","period":"2026-10"}}`
and no forward header.

**Observable outcome.** `401` `forward_secret_required`; the ledger invocation
counter does not move. The positive control presents the ledger forward secret with
`{"op":"snapshot","args":{"tenant":"north","shop":"north/bristol","period":"2026-10"}}`
and expects `200` with the snapshot id.

**Expected failure without the mediated path.** The direct baseline answers `200`
with rows because it has no forward-secret check, so the status assertion fails.

**Positive control.** The forward-secret snapshot call returns the Bristol
snapshot id.

### H4

**Actor.** Reporting, holding only its own admission token.

**Boundary.** Auth server `POST /v1/decide` with
`caller: "reporting"`, `audience: "ledger"`, `op: "rows"`.

**Observable outcome.** `403` `denied`; the ledger invocation counter does not move.
The positive control repeats the call with gateway's token, receives `200` and a
non-empty permit, and presents that permit at the ledger proxy for `200` with rows
and a counter of one.

**Expected failure without the mediated path.** The direct baseline has no broker,
so the check cannot run there. The expected failure appears when the broker's
policy decision no longer refuses: without a signed rule the permit cannot be
minted, so the route answers `500` rather than `200`, which fails the refusal's
`403 denied` assertion.

**Positive control.** Gateway's token yields a permit that releases rows once.

### H5

**Actor.** A caller holding a valid permit issued for `directory`.

**Boundary.** Ledger proxy `POST /v1/call` with the directory `assignments` call and
its permit.

**Observable outcome.** `403` `audience_mismatch`; the ledger invocation counter
does not move. The positive control presents the same permit and call at the
directory proxy and receives `200` with a non-empty `assignments` array; each proxy
tracks its own single-use nonces, so the directory proxy accepts the permit the
ledger proxy refused.

**Expected failure without the mediated path.** The direct baseline has no proxies,
so the check cannot run there. The expected failure appears when the proxy's
audience comparison is removed: the directory call is forwarded to the ledger,
which answers `400` and moves the counter.

**Positive control.** The permit and call at the directory proxy return assignments.

### H6

**Actor.** A caller changing the call after its permit was issued.

**Boundary.** Ledger proxy `POST /v1/call` with a valid ledger permit and
`args.period: "2026-09"`.

**Observable outcome.** `403` `digest_mismatch`; the ledger invocation counter does
not move. The positive control obtains a fresh permit for the unmodified call and
receives `200` with the snapshot id.

**Expected failure without the mediated path.** The direct baseline has no ledger
proxy, so the check cannot run there. The expected failure appears when the proxy's
digest comparison is removed: the tampered call is forwarded and the ledger answers
`404` for the unknown period.

**Positive control.** A new permit for the unmodified call releases the snapshot.

### H7

**Actor.** A caller forging a permit.

**Boundary.** Ledger proxy `POST /v1/call` with a structurally valid permit signed
by an attacker-held Ed25519 key.

**Observable outcome.** `403` `invalid_permit`; the ledger invocation counter does
not move. The positive control is the broker's honest permit for the same call
returning `200`.

**Expected failure without the mediated path.** The direct baseline has no ledger
proxy, so the check cannot run there. The expected failure appears when the proxy's
signature verification is removed: the attacker-signed permit is accepted and the
call is forwarded.

**Positive control.** The broker's permit releases the snapshot.

### H8

**Actor.** A caller presenting an expired permit.

**Boundary.** Ledger proxy `POST /v1/call` after the injected clock advances 31
seconds past a permit issued for the 30-second `snapshot` lifetime.

**Observable outcome.** `403` `permit_expired`; the ledger invocation counter stays
at the control's one. The positive control presents the same permit before the
advance and receives `200`.

**Expected failure without the mediated path.** The direct baseline has no ledger
proxy, so the check cannot run there. The expected failure appears when the proxy's
expiry comparison is removed: the expired permit is accepted and the call is
forwarded.

**Positive control.** The permit is accepted before the clock advance.

### H9

**Actor.** A caller replaying a used permit.

**Boundary.** Ledger proxy `POST /v1/call` twice with the identical permit and call.

**Observable outcome.** The first call returns `200` and moves the ledger counter to
one; the second returns `409` `replayed` and the counter stays one.

**Expected failure without the mediated path.** The direct baseline has no ledger
proxy, so the check cannot run there. The expected failure appears when the proxy's
used-nonce comparison is removed: the second call is accepted and the counter
reaches two.

**Positive control.** The first call returns `200`.

### H10

**Actor.** A policy reader.

**Boundary.** Auth server `GET /v1/policy/<hash>`.

**Observable outcome.** A 64-character lower-case hex hash that is not active
returns `404` `unknown_policy`. The positive control requests the active hash and
receives `200`; the body hashes with SHA-256 to that hash and begins with
`zenturian.policy.v1\n`.

**Expected failure without the mediated path.** The direct baseline has no policy
route, so the check cannot run there. The expected failure appears when the route
serves the active bytes for any 64-character hex hash: the inactive-hash request
returns `200` instead of `404`.

**Positive control.** The served active bytes hash to the requested hash.

### H11

**Actor.** A direct loopback caller after Nora prepares a report through the portal.

**Boundary.** Reporting, directory and ledger `POST /rpc` without the forward
header: reporting `{"op":"get","args":{"reportId":<prepared>}}`, directory
`{"op":"principal","args":{"principal":"alice"}}`, ledger
`{"op":"rows","args":{"tenant":"north","shop":"north/bristol","period":"2026-10"}}`.

**Observable outcome.** Each returns `401` `forward_secret_required` and leaves its
own invocation counter unchanged. The positive controls present the per-component
secrets: reporting `store` returns `200 {"ok":true}`, directory `principal` returns
`200`, and ledger `snapshot` returns `200` with the snapshot id.

**Expected failure without the mediated path.** The direct baseline has no
forward-secret check: reporting's `get` returns `200` with the stored salary rows
and directory and ledger answer `200`, so the reporting status assertion fails
first.

**Positive control.** Each component answers with its forward secret.

### H12

**Actor.** A caller holding reporting's forward secret.

**Boundary.** Reporting `POST /rpc` with `{"op":"prepare"}`, then `{"op":"get"}`,
then `{"op":"store"}`.

**Observable outcome.** `prepare` and `get` each return `400` `unknown_op`; `store`
returns `200 {"ok":true}`.

**Expected failure without the mediated path.** The direct baseline implements
`prepare` and `get`, so `prepare` returns `200` with the stored rows, and the
status assertion fails first.

**Positive control.** `store` succeeds and returns `{"ok":true}`.

### H13

**Actor.** A caller holding a permit issued under the then-active policy hash.

**Boundary.** Ledger proxy `POST /v1/call` with that permit and its exact canonical
gateway-to-ledger `snapshot` call, after the auth server's `POST /v1/promote`
retires the hash.

**Observable outcome.** `403` `unknown_policy`; the ledger invocation counter is
unchanged from before the stale presentation. The relation is bound through the
permits: the stale permit's decoded body names the hash `GET /v1/policy/active`
reported before the promotion, the promotion response's `previousHash` is that
same hash, and the fresh permit's decoded body names the promotion's `hash`. The
positive control obtains a fresh permit after the promotion and returns `200` with
`snapshot.id === "snap-north-bristol-2026-10"`, moving the counter by exactly one.

**Expected failure without the mediated path.** The direct baseline has no ledger
proxy or policy broker, so the check cannot run there. The expected failure appears
when the proxy's non-200 policy refusal is replaced with a fallback to
`GET /v1/policy/active` whose bytes are evaluated without the permit-hash
comparison: the stale permit is then accepted and the ledger invoked, so the stale
presentation returns `200` where `403` is asserted and the counter moves.

**Positive control.** The fresh promoted-hash permit returns the Bristol snapshot
and moves the ledger invocation counter by one.
