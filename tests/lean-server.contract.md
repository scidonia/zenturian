# Lean server contract — the health probe

The Lean server is checked the way a client meets it: over its loopback HTTP socket,
with the JSON response parsed rather than compared as text. A check starts its own
`zenturianLean` process (`health`, default port `0`), reads the
`listening on 127.0.0.1:<port>` line the server prints, and sends every request to
that address. Nothing imports or calls Lean code, and no request leaves loopback.
The process is stopped with `SIGTERM` when the check finishes.

## Health probe

### N1

**Actor.** An unauthenticated loopback client: `curl` speaking HTTP/1.1, with no
admission token, permit or admin header.

**Boundary.** `GET /health` and `GET /nope` at the socket address the server prints
for `zenturianLean health` on port `0`.

**Observable outcome.** For `GET /health`: status exactly `200`; `content-type`
exactly `application/json; charset=utf-8`; the response body parsed as JSON equals
exactly `{"service":"zenturian-lean","status":"ok"}` — those two fields, those values,
and no others.

**Control.** The health marker is `zenturian-lean` or `"status":"ok"` in either the
headers or the body, and one detector is used for both responses. It reports the
marker present on the `/health` response and absent on the `/nope` response in the
same run; the absence finding is only accepted together with that affirmative one.
`GET /nope` returns status exactly `404`, and neither its headers nor its body carries
the health marker.

**Expected failure without the health route.** With the `/health` entry and its
handler absent from the route table, `GET /health` reaches the table's no-match branch
and answers `404` with the `not_found` body, so the status assertion fails on its own
check and the exact-body comparison behind it cannot pass. No other route exists and no
other behaviour is involved; a missing route answers `404` deterministically.

**Process and transport.** No mock. The subject is a real child process on a real
loopback socket, so routing, framing and the no-match branch are the server's own; a
fake transport would not exercise them.
