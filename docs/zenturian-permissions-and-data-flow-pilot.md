# Zenturian — designing enforceable permissions and data flows

**Proposed design and pilot demonstration · Scidonia · 25 November 2026**

A client should be able to tell Scidonia who may obtain which information, explore what their rule means in difficult cases, and recognise that rule in the behaviour of the delivered system. Zenturian uses Lean to connect those three activities. The client reviews the rule in business language. The consultant gives it an executable meaning. Lean checks a theorem about the calls and disclosures that the model of the deployment permits.

This document proposes a first implementation against Zenturian revision `3064956`. The repository contains an implementation plan and theorem sketches. The proofs, runtime and demonstration described below are deliverables to build.

## 1. What the client can buy

For a named workflow, Scidonia and the client agree on the principals, operations, data items, permitted recipients and delivery channels. Scidonia delivers the approved policy, a mediated implementation, and evidence connecting its observed behaviour to the policy. The agreement identifies which services supply the underlying facts and which parts of the deployed system the client must trust.

Three questions recur on every engagement.

| Client question | Decision the system makes | Example |
|---|---|---|
| Who may ask for this operation? | Authenticate the human and calling service. Check their authority for the operation, tenant and resource. | A payroll preparer may prepare a Bristol report. |
| Which component may receive which information? | Check each hop and construct the smallest view required for its job. | The reporting service receives an opaque report reference and a status. The ledger retains the salary rows. |
| To whom may the result be released, and when? | Bind the projected result to an authenticated recipient and evaluate the release rule at a specified event. | The current Bristol manager may open the report even if someone else prepared it. |

A rule about downstream use requires an identifiable enforcement point. For example, “only release payroll to the manager’s payroll portal” can govern a delivery channel. “The manager will only use the information for payroll” also depends on what happens after receipt. The consultant records that distinction when agreeing the scope.

## 2. From a workshop to an approved policy

The first workshop needs a payroll owner, a Scidonia consultant, and someone who can identify the actual data sources and delivery paths. Start with one real decision: “Yesterday I prepared a report for Alice. Today Ben runs the shop. Who can open it?” Ask the owner for their answer before running either candidate policy.

| Step | Work in the session | Evidence retained |
|---|---|---|
| Establish the vocabulary | Distinguish preparer, reader, employee, shop charged and employee’s current shop. Identify who maintains each fact. | Glossary, source systems and rule owner |
| Resolve the disputed cases | Ask about a manager transfer, a temporary appointment and a payroll correction. Keep the owner’s expected outcomes independently of the policy implementation. | Named examples with expected decisions and reasons |
| Formalise the rule | The consultant translates the decisions into a typed policy and a client-specific property. AI may propose wording, cases and drafts. | Source passage, approved interpretation, Lean predicates and examples |
| Inspect the consequences | Run the examples against the policy. Show a witness when two interpretations disagree. Read a plain-language rendering derived from the policy using the agreed glossary. | Actual decisions, differences and unresolved questions |
| Promote and revisit | The business owner approves the interpretation. Scidonia checks the property against the deployment configuration. A rule change repeats the comparison against the previous version. | Approved policy hash, covered channels, proof results and change record |

An ambiguity that changes a release decision needs an owner decision or an explicit refusal for the affected case. The workshop can finish with a narrower, enforceable rule. Retain the outstanding case so a later policy change can address it.

## 3. Pilot contract — opening a shop payroll report

**The agreed v1 rule.** A payroll preparer may prepare a report for an assigned shop and closed pay period. At release, the authenticated reader must be the active manager of that shop in the same tenant. Each released row must come from the agreed ledger snapshot for that tenant, shop and period. The reader may see the employee reference and gross pay in GBP. Bank details, addresses and arbitrary comments have no place in the released view.

**Meaning of release.** The pilot supports one authenticated portal response. Preparation creates an opaque reference. Each open, including a repeat open, makes a fresh release decision. A release takes effect when the trusted gateway commits the authorised view for writing to that reader’s session. A directory update ordered before that event affects the decision. An update ordered afterwards governs the next open. The portal uses a no-store response and has no download, email or shared-link route in the pilot. A copy already received remains with its recipient.

| Fact | Authority and binding | Time semantics |
|---|---|---|
| Identity and tenant | Identity adapter binds the authenticated session to a principal and tenant. The request body cannot choose the reader. | Session must be valid at release. |
| Preparer and manager assignments | Directory records explicitly name the principal, role, tenant and shop. | Preparation uses the assignment at prepare time. Reading uses the assignment at release. |
| Report scope | Trusted service records tenant, shop, period and immutable ledger snapshot against an opaque report ID. | Fixed at preparation. The report ID conveys no permission to open it. |
| Row ownership and amounts | Ledger snapshot supplies row ID, tenant, charged shop, pay period, employee reference and gross pay. | Use the shop charged in the selected period, including for employees who later transferred. |
| Output fields | The approved manager view defines the serialised field set. | Use the policy active at release. |

A compromised reporting component can mislabel a Cardiff row as Bristol. A check against a label supplied by that same component cannot establish which shop incurred the cost. In this pilot the trusted projector reads the authoritative ledger values by scope, and the reporting component supplies neither the row labels nor the amounts. Correctness of ledger entries and directory assignments is an explicit client dependency.

## 4. Enforcement design

1. **Prepare.** The preparer authenticates at the edge. The reporting service submits tenant-scoped report metadata through its Lean proxy. Its permission is limited to preparing reports on behalf of that preparer. The broker certifies the exact operation and scope. The trusted service records the report reference after checking the assignment and closed period.
2. **Open.** The reader presents the reference at the portal. The edge derives identity from the session. The callee proxy verifies the broker permit against the intended operation, recipient, audience, tenant, report reference and policy version. A forwarded service identity carries only the rights required for this hop.
3. **Project and release.** The release gateway resolves the report scope, obtains the pinned ledger rows and constructs the manager view through a typed projector. It checks every row before committing any response bytes. Missing facts, a malformed row, or a single scope mismatch refuse the entire release. Only the trusted release path and the authenticated reader receive salary data.
4. **Record.** A restricted audit record links the request, principal and recipient, report reference, effective policy, fact versions, view, decision and reason. Record the release commitment before sending. A distinct transport outcome records whether the write completed. Audit entries exclude salary values and bank details. An authorised reviewer can reproduce the decision using the retained, access-controlled snapshots.

**Ordering for the pilot.** Use one authoritative release coordinator on one host. Directory changes, active-policy changes and release commitments pass through the same serialised state transition. Revalidate the session, the effective facts and policy version at commitment. If a version changed while rows were being prepared, retry under the new version or refuse. An unexpired broker permit alone cannot authorise release after a manager change. A production directory that delivers asynchronous updates needs a separately agreed freshness bound or a different integration to preserve this promise.

The deployer must ensure that a component can reach only its proxy, that the ledger accepts only its admitted caller, and that the gateway controls every salary-bearing output covered by the claim. Check those properties on the installed pilot. Treat the identity adapter, authoritative stores, Lean runtime and I/O shell, cryptography, and host isolation as named dependencies of the guarantee.

## 5. What to prove in Lean

Prove the reusable enforcement result once, then instantiate it with a theorem that the payroll owner can recognise. Phrase the latter over the actual release event and the values committed to the reader. This schematic statement fixes the intended meaning before choosing Lean representations.

```text
For every reachable release event e under payroll policy v1:
  e.recipient is the authenticated reader of e.session
  and is the manager of (e.tenant, e.shop) at e.commit
  and e.view is exactly the projection of the ledger rows
      for (e.tenant, e.shop, e.period, e.snapshot)
      onto (employee reference, gross pay in GBP).
```

Define row equality as multiset equality, using a stable row ID internally. This checks completeness and duplicated rows as well as confidentiality. Define the wire encoder for the view and check the bytes handed to the trusted shell against it. The proof then has a specific interface to the running system.

| Obligation | Pilot acceptance criterion |
|---|---|
| Decision soundness | An accepted derivation establishes a positive permission and the absence of any applicable overriding block on the same fact snapshot. For the finite pilot policy, evaluate the entire blocking stratum. |
| Recipient and data-flow safety | Induct over prepare, relay, open, update and release steps. Show that salary-bearing deliveries use the declared view, recipient and approved path. Include intermediate recipients in the event model. |
| Positive behaviour | For the named healthy fixture with valid facts and working services, the eligible reader gets the expected nonempty report. Show this in the executable model and through the portal. |
| Release and audit correspondence | For every release commitment there exists a matching recorded decision. Replay the integration trace and compare the captured portal response with the expected encoded view. |
| Change control | Check v1 and v2 separately and compare the decisions they produce. Recheck pending opens against the active version. A policy change produces a new certificate and owner approval. |

The Lean theorem quantifies over traces of the model under its assumptions. Integration evidence tests the binding from model events to the real gateway and deployment. For the pilot the disclosure theorem covers exact recipients, rows, fields and routes. A later tender pilot could add a separate theorem about what a recipient can reconstruct across several individually permitted releases.

## 6. Demonstration script

Use synthetic data. Tenant North has Bristol and Cardiff shops. Nora prepares Bristol payroll. Alice manages Bristol, Ben is her designated successor, Cara manages Cardiff, and Dana has a recorded, time-limited acting assignment for Bristol. Tenant South has a different shop also called Bristol. The fixture includes the following ledger rows for the same closed October period.

| Internal row | Tenant | Charged shop | Employee reference | Gross pay |
|---|---|---|---|---:|
| L1 | North | Bristol | E101 | £3,100 |
| L2 | North | Bristol | E102 | £2,850 |
| L3 | North | Cardiff | E103 | £3,020 |
| L4 | South | Bristol | E104 | £3,275 |

E102 now works in Cardiff. Their October row belongs in Bristol’s report. Give the presenter separate authenticated sessions and display the client rule, scenario result and a restricted audit view alongside the portal. The following are expected outcomes for the proposed demonstration.

| Act | Presenter action | What the audience should observe |
|---|---|---|
| 1. Establish the intended flow | Nora prepares North/Bristol/October. She then opens the report herself. | Preparation succeeds and returns a reference. Her open is refused. Her session receives no salary rows. |
| 2. Show a useful release | Alice opens the same reference. | Her response contains exactly E101/£3,100 and E102/£2,850. The reporter’s response contains only metadata. The trace identifies the source snapshot and manager view. |
| 3. Change one fact | Pause a second open by Alice just before commitment. Transfer Bristol management to Ben and resume the open. Ben opens the same report. | Alice’s pending release is refused with zero salary bytes sent. Ben gets the two expected rows. The audit distinguishes the earlier and later directory versions. |
| 4. Exercise the boundaries | Cara opens the reference. A South/Bristol manager also tries. In a test fixture, supply L3 among the rows presented to the trusted scope check. | Both readers are refused. The mixed-row response is refused in full before any row is sent. The restricted trace distinguishes recipient refusal from scope mismatch. |
| 5. Change the rule | Dana opens the report under v1. The owner then approves v2 allowing an active, explicitly appointed acting manager for the same tenant and shop. Publish v2 and repeat. | Dana moves from refusal to receipt of the same two rows. Ben stays permitted. Alice, Cara and the South manager stay refused. When Dana’s assignment expires, a fresh open is refused. |
| 6. Hand the evidence to the owner | Select Dana’s before-and-after decisions. | The owner can identify the changed clause, who approved it, the effective assignment, and exactly which fields Dana was allowed to receive. The audit screen itself exposes no salary figures. |

For the policy comparison, enumerate the principals, shops and assignment states in the fixture, then display every changed decision. Label that result as fixture coverage. For a general change claim, prove separately that any newly permitted recipient must have an active acting assignment for the same tenant and shop and that the released view remains identical.

## 7. Build order and completion gate

| Increment | Deliverable | Gate |
|---|---|---|
| Workshop and executable model | Glossary, owner-labelled cases, finite policy, directory transitions, ledger fixture and a simple policy explorer | Owner settles the transfer case and can identify what changes for Dana under v2. |
| Lean proof | Verified decision checker, payroll release theorem and successful example | Proofs compile without placeholders. Removing the recipient check or changing the charged-shop filter breaks the relevant proof or counterexample test. |
| Deployed path | Single-host broker, proxies, trusted gateway, directory/ledger adapters and authenticated portal | The same cases run through the normal portal. Captured responses match the authorised view, scope failures emit zero salary bytes, and direct component access is blocked. |
| Client acceptance | Live policy change, restricted decision traces, evidence tied to the deployed manifest and a signed scope statement | The owner can explain one allow, one refusal and one changed decision. Scidonia can reproduce each from the approved policy and authoritative facts. |

Build the workshop and payroll flow before expanding client SDKs, dashboards or inference analysis. The pilot succeeds when a business owner can change a rule in a meaningful way, predict who will gain access, and see that precise change enforced on a real delivery path.

### Repository references

- [Zenturian implementation plan at the reviewed revision](https://github.com/scidonia/zenturian/blob/3064956a5761324864a99731730cc212d2f4220e/PLAN.md)
- [Deployment theorem, trust boundary and certification design](https://github.com/scidonia/zenturian/blob/3064956a5761324864a99731730cc212d2f4220e/docs/theorem.md)
