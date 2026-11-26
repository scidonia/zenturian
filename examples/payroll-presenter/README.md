# Payroll presenter

A local page for walking through the payroll example one click at a time. It imports the example and calls it. Nothing under `examples/payroll` is changed, and the terminal demo is still:

```bash
node examples/payroll/src/demo.mjs
```

The page is a viewer for that model. It does not add a release rule, a second policy, or a path around the portal.

## Requirements and command

Node.js 20 or newer. There is nothing to install.

From the repository root:

```bash
node examples/payroll-presenter/src/server.mjs
```

The same command is `npm start` from `examples/payroll-presenter`. The process listens on `http://127.0.0.1:4173` and prints that address. Stop it with Ctrl-C. That closes the in-memory payroll model.

The model starts as the terminal demo does: 15 November 2026, policy v1, and the fixture assignments. Nora is selected. Choose another person before preparing or opening if you want that session.

## What the page calls

Every control waits for the running model. Salary amounts appear only when an open response from the portal contains them. The browser is not given bearer tokens, the admin token, forward secrets, or component URLs.

The page groups the same actions into three steps. Step 1 selects the person and states what opening the report does for them. Step 2 prepares and opens the North Bristol October report. Step 3 changes one fact at a time: the policy, who manages Bristol, the date, or a snapshot that includes a Cardiff row. The result card states what that click showed.

| Control | What it calls |
|---|---|
| A person | Stores that person as the session for the next prepare or open. |
| Prepare the report | `POST /v1/reports` on the portal as the signed-in person, for North / Bristol / October 2026. Nora is the preparer. Anyone else receives the portal's refusal. |
| Open the report | `GET /v1/reports/:id/open` as the signed-in person. |
| Ask to open as Alice, while signed in as Nora | `POST` the same open route as Nora with `{ "reader": "alice" }`. The portal discards the body and still treats Nora as the recipient. |
| Use policy v1 / v2 | `coordinator.promotePolicy` with the example's `policyV1` or `policyV2`, approver `policy-owner`. v1 allows the active manager. v2 also allows an active acting manager. |
| Transfer Bristol management to Ben | The two `coordinator.replaceAssignment` calls from the terminal demo. Alice's management ends 2026-11-14. Ben's management starts 2026-11-01. |
| Restore Alice and Ben | `replaceAssignment` again, with Alice's and Ben's North/Bristol records from `fixture.mjs`. |
| 15 November 2026 / 1 December 2026 | Moves the clock that was passed to `startAll`. Dana's acting appointment runs from 2026-11-01 through 2026-11-30, so 1 December is after it. |
| Open Alice against the mixed snapshot | A second, short-lived `startAll` whose ledger read returns rows L1, L2, and L3. Nora prepares and Alice opens. The main model is left as it was. |
| Reset to the opening fixture | Closes the model and calls `startAll` again. The report reference, clock, policy, and assignments return to the opening state. The selected person stays. |

After a transfer, a policy change, or a date change, open the report again. The next open is decided against the facts at that moment.

The assignment list is read from the directory with the forward secret the example already created for this process. Active or inactive uses the example's `isActive` at the presenter clock.

The record lists release and promotion entries from the broker audit: verdict, reason, row count, directory version, and the first 12 characters of the policy hash. It checks the chain and runs the terminal demo's salary detector (`3100.00`, `2850.00`, `310000`, `285000`, `302000`) over the audit serialization. The same detector is run over the last non-empty release view, so a successful open can show that the amounts are on that view and absent from the audit.

## Layout

`src/server.mjs` is the loopback server. It also serves [assets/logo.svg](../../assets/logo.svg) at `/logo.svg`. `public/index.html`, `public/app.css`, and `public/app.js` are the page. The page is four columns up to 1920px wide: the people, the report, the demonstrations, and the current roles with the audit. `package.json` marks the folder as an ES module and lists no dependencies.

The example's own description, acts, and limits are in [examples/payroll/README.md](../payroll/README.md).

## Limits

This is the executable JavaScript model, reached through its existing portal and coordinator. A refusal shown here returned no salary rows from that model. The page does not prove certification, host isolation, or confidentiality. Those limits are the ones stated in the payroll example.
