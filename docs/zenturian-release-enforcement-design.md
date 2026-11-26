# Zenturian release enforcement

**Design review and implementation proposal · Scidonia · 26 November 2026**  
**Reviewed baseline** `scidonia/zenturian` at `cf8abe1`  
**Proposed milestone** One payroll release governed by an executable Lean policy, demonstrated through the existing presenter.

## Design decision

Let the client change **which fields a recipient may see** as part of the same policy that grants access. Use this as the first test of Zenturian as a consulting product. The payroll owner should be able to say, “An acting manager may check who is on the report. Only the permanent manager may see what they earn.” A Scidonia consultant should be able to implement that change by editing a policy value. The presenter should show Dana receiving employee references, Ben receiving references and pay, and the decision evidence explaining both outcomes.

The current pilot is ready for a workshop. Its live behaviour invites a business owner to settle real questions about entitlement, timing and disclosure. The next milestone should connect those decisions to one Lean definition used by the running system. Keep the JavaScript portal, directory, ledger and presenter for this increment.

## What the review established

I ran the terminal payroll demonstration and the repository’s 28 automated checks at the reviewed revision. All 28 passed with zero skips. The demo returned the two expected Bristol salaries to an entitled manager, refused the mixed-scope release, and produced a verifiable in-memory audit chain. The repository describes its Lean port as in progress. Its deployment theorem remains a specification.

| Area | Behaviour at the reviewed revision | Design consequence |
|---|---|---|
| Release time | The coordinator re-reads directory facts and policy before committing. A transfer can prevent a pending release to the former manager. | Preserve an explicit commit event and define entitlement at that event. |
| Policy and views | The release evaluator branches on v1 and v2. The coordinator separately constructs a fixed employee-reference-and-pay view. Presenter explanations contain fixture-specific text. | Put the selected view in the policy decision and derive the explanation from that decision’s evidence. |
| Refusals | A mixed-snapshot response returns zero salary rows, but its public reason identifies the out-of-scope row as L3. | Give refusals an explicit public view and keep diagnostic detail in the restricted trace. |
| Audit ordering | The proxy calls the component before it appends the call outcome. The theorem design requires a successful append before forwarding. | Record permission to invoke before crossing the component boundary. Record the outcome as a separate event. |

Implementation evidence: [release evaluator](https://github.com/scidonia/zenturian/blob/cf8abe15aaf7e1c356be312cbebcadba58250a95/examples/payroll/src/policy.mjs#L129-L191), [coordinator](https://github.com/scidonia/zenturian/blob/cf8abe15aaf7e1c356be312cbebcadba58250a95/examples/payroll/src/coordinator.mjs#L320-L546), [presenter explanations](https://github.com/scidonia/zenturian/blob/cf8abe15aaf7e1c356be312cbebcadba58250a95/examples/payroll-presenter/public/app.js#L139-L180), [proxy forwarding and audit](https://github.com/scidonia/zenturian/blob/cf8abe15aaf7e1c356be312cbebcadba58250a95/examples/payroll/src/proxy.mjs#L349-L385), [deployment theorem design](https://github.com/scidonia/zenturian/blob/cf8abe15aaf7e1c356be312cbebcadba58250a95/docs/theorem.md#3-invariant-and-theorem).

## 1. Make the approved policy select the view

Introduce two typed payroll views. The **roster** contains the employee reference. The **payroll** view contains the employee reference and gross pay in GBP. Each has one constructor and wire encoder. The release evaluator returns either a refusal or a grant naming a view and the clause that justified it.

| Approved policy | Active manager | Active acting manager | Preparer without either role |
|---|---|---|---|
| v1, existing | Payroll | Refused | Refused |
| v2, existing | Payroll | Payroll | Refused |
| v3, proposed | Payroll | Roster | Refused |

All grants require the same tenant and charged shop. Assignment validity is evaluated at commitment. For this proposed pilot, a person holding both eligible roles receives the payroll view on the strength of their active manager assignment. Put that case to the owner explicitly and retain their answer. The policy schema should make rule precedence reviewable before promotion.

The consultant authors v3 using the existing vocabulary of roles, scope, active assignments and named views. A policy version identifies the approved content. The evaluator interprets that content with the same semantics across all three versions. The proof obligation for a new view is concentrated in its constructor and encoder. A later client can reuse an existing view by selecting it in a policy clause.

**Workshop output.** Before evaluation, ask the owner to predict what Dana and Ben each receive. Show their predictions alongside the policy comparison. A comparison must detect a change in disclosed fields even when the access decision remains “allow”. Generate the explanation from the effective policy hash, matched clause, assignment, view and decision time. A reviewer should be able to explain yesterday’s release after today’s policy or directory has changed.

## 2. Make release one checked transition

Use a small pure Lean function to decide the release and construct its public response. Its inputs include the approved policy, authenticated recipient, report scope, immutable ledger snapshot, effective directory facts and commit time. The existing coordinator owns I/O and the ordering of management transfers, policy promotion and release commitments.

The current coordinator constructs its fixed view **before** the final policy recheck. That order matters as soon as v3 can narrow a view. Dana could qualify under both versions while her permitted fields change between the initial check and commitment. Rechecking only her eligibility would leave the old salary-bearing payload ready to send. Make the final decision select the encoder. Projection may use prevalidated immutable rows, but the committed bytes must correspond to the view authorised by the final decision.

| Release step | Required behaviour |
|---|---|
| Resolve | Bind recipient to the authenticated session. Resolve the report’s tenant, charged shop, period and pinned snapshot. |
| Validate data | Obtain authoritative ledger rows. Check snapshot identity, membership, scope, multiplicity and value shape. Refuse the entire response on a mismatch. |
| Commit | Under the coordinator’s ordering discipline, check the effective directory facts, policy and time. Select the view, encode the response and record the commitment. Refuse if the required decision or recording step cannot complete. |
| Deliver | The trusted shell writes the committed bytes to the bound session. A write failure may leave the transport outcome unknown. Retain that distinction in the audit. |

**Payroll theorem to prove.** For every successful release commitment in a reachable model state, the recipient is the authenticated reader, the effective policy grants that recipient the selected view, and the response bytes encode exactly the authorised projection of the pinned ledger rows. Preserve row multiplicity. Prove a positive example in which the eligible acting manager receives the expected nonempty roster.

**Refusal contract.** For scope and entitlement refusals on report open, return an agreed status, fixed public refusal code and opaque support reference. Keep row IDs, source-system errors and failing predicates in the access-controlled trace. Check the whole public response, including headers and body. As a concrete test, vary the offending internal row ID and compare the public responses modulo the fresh support reference. The same fixture should yield distinguishable diagnostics for an authorised reviewer.

This theorem is relative to the facts supplied by the authoritative ledger and directory. The Lean core establishes a property of its output and modelled transitions. Socket-level conformance checks exercise the trusted shell’s use of that output. Host isolation, production identity, durable logging and control of other delivery routes remain deployment dependencies.

## 3. Align the audit with the effects it describes

Give each invocation a stable attempt ID. Record an authorised intent before forwarding, then record the observed outcome under the same ID. Use separate records for the release commitment and the transport outcome. Restrict access to diagnostic fields and exclude pay values from these records.

| Failure point | Required result |
|---|---|
| Recording the authorised intent fails | The component invocation count stays unchanged. |
| Intent is recorded and the component call times out | The intent survives with an unknown outcome. An operator can reconcile it by attempt ID. Automatic retries of an operation with side effects require an idempotency contract. |
| The component responds and recording its outcome fails | Preserve the intent and surface the incomplete audit. The system cannot infer that the component did nothing. |
| Recording the release commitment fails | Send zero payroll or roster bytes. |
| The connection fails after commitment | Retain the commitment and record the observed transport result where possible. A commitment does not establish receipt. |

State the trace property in event order: every forward has a matching **earlier** recorded authorisation for that attempt and call digest. Every write of protected bytes has a matching earlier commitment for the recipient and view. An in-memory append suffices to exercise ordering in the pilot. Crash-survival claims require durable storage and recovery evidence.

## 4. Pilot demonstration and acceptance

Use the current Bristol October fixture. Nora prepares the report, Ben holds the active Bristol manager assignment after the transfer, and Dana has an active acting assignment. The expected roster contains E101 and E102. The expected payroll adds £3,100 and £2,850 respectively.

| Act | Action through the existing presenter or test harness | Acceptance evidence |
|---|---|---|
| Establish the baseline | Run the existing suite and reproduce the v1 and v2 flows. | All 28 baseline checks pass. The eligible manager receives the two fixture salaries. |
| Approve the business change | Compare v2 and v3, record the owner’s predictions, promote v3 and open as Dana and Ben. | Dana receives exactly two employee references. Gross pay is absent from the raw HTTP payload. Ben receives the full payroll view. The traces identify different authorising clauses. |
| Change the policy mid-open | Begin Dana’s open under v2 and promote v3 before commitment. | The committed response contains the roster only. The decision record identifies v3 and explains the change of view. |
| Change the facts | Expire Dana’s acting assignment and run the existing manager-transfer scenario. | A fresh open by Dana is refused. A former manager’s pending open releases zero protected rows. |
| Inspect a refusal | Present a mixed-scope snapshot. Inspect the portal response and the operator trace as their respective readers. | The public response contains no row identifier or salary. The operator can resolve the opaque reference to the offending row and failed predicate. |
| Interrupt the audit | Simulate the failures in §3 at their respective boundaries. | Invocation counts, sent bytes and retained records agree with the failure table. |

**Completion gate.** The presenter must use the Lean decision and encoded response on its normal open-report path. The owner must be able to explain the v2-to-v3 field change using the evidence from that actual decision. Keep the existing JavaScript behaviour as a regression baseline for the agreed cases. Where the review found a discrepancy, the approved contract and new acceptance cases define the target.

The result would give Scidonia a concrete answer when a client asks, “How do I know the change I approved governs what Dana sees?” The owner can point to the clause, see its exact effect on the response, and identify the theorem that connects them.
