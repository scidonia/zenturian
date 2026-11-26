#!/usr/bin/env bash
# N1: the health probe and the no-match control.
#
# Starts `zenturianLean health` on an OS-chosen loopback port, reads the address it
# prints, and checks both responses over HTTP/1.1. The body is parsed as JSON and
# compared as an object, never as text. One marker detector is applied to both
# responses, so its absence on the 404 is controlled by its presence on the 200.
# The server is stopped with SIGTERM, whose default disposition ends the process.

set -u -o pipefail

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
bin=${ZENTURIAN_LEAN_BIN:-"$root/.lake/build/bin/zenturianLean"}
work=$(mktemp -d)
server_pid=
watchdog_pid=

cleanup() {
  if [[ -n $watchdog_pid ]] && kill -0 "$watchdog_pid" 2>/dev/null; then
    kill -KILL "$watchdog_pid" 2>/dev/null || true
  fi
  if [[ -n $server_pid ]] && kill -0 "$server_pid" 2>/dev/null; then
    kill -KILL "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  rm -rf -- "$work"
}
trap cleanup EXIT

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  if [[ -s $work/server.err ]]; then
    printf -- '--- server stderr ---\n' >&2
    cat "$work/server.err" >&2
  fi
  exit 1
}

[[ -x $bin ]] || fail "server binary is not executable: $bin (build it with 'nix develop -c lake build')"

# Both capture files exist before the child starts, so the first read cannot race
# the background redirection.
: >"$work/server.out"
: >"$work/server.err"
"$bin" health >"$work/server.out" 2>"$work/server.err" &
server_pid=$!

# The port is the OS's choice; the address is whatever the server reports.
addr=
for ((attempt = 0; attempt < 300; attempt++)); do
  output=$(<"$work/server.out")
  if [[ $output == *"listening on "* ]]; then
    line=${output#*listening on }
    line=${line%%$'\n'*}
    addr=$line
    break
  fi
  kill -0 "$server_pid" 2>/dev/null || fail "server exited before printing its address"
  sleep 0.1
done
[[ -n $addr ]] ||
  fail "server did not print 'listening on <addr>' within 30s"
[[ $addr =~ ^127\.0\.0\.1:([0-9]+)$ ]] ||
  fail "unexpected listen address: '$addr'"
port=${BASH_REMATCH[1]}
((port > 0)) || fail "server reported port 0: '$addr'"
printf 'server  %s (pid %s)\n' "$addr" "$server_pid"

request() { # target prefix
  curl --silent --show-error --http1.1 --max-time 10 \
    --dump-header "$2.headers" --output "$2.body" --write-out '%{http_code}' \
    "http://$addr$1"
}

header_value() { # prefix name
  local text line value
  text=$(<"$1.headers")
  while IFS= read -r line; do
    line=${line%$'\r'}
    if [[ ${line,,} == "$2:"* ]]; then
      value=${line#*:}
      value=${value#"${value%%[![:space:]]*}"}
      printf '%s' "$value"
      return 0
    fi
  done <<<"$text"
  return 1
}

health_marker_present() { # prefix
  local text
  text=$(<"$1.headers")$'\n'$(<"$1.body")
  [[ $text == *zenturian-lean* || $text == *'"status":"ok"'* ]]
}

# --- GET /health ---
status=$(request /health "$work/health") || fail "curl failed for GET /health"
printf 'GET /health  %s\n' "$status"
[[ $status == 200 ]] || fail "GET /health: expected status 200, observed $status"

content_type=$(header_value "$work/health" content-type) ||
  fail "GET /health: response has no content-type header"
[[ $content_type == 'application/json; charset=utf-8' ]] ||
  fail "GET /health: expected content-type 'application/json; charset=utf-8', observed '$content_type'"

printf 'body  %s\n' "$(<"$work/health.body")"
node -e '
const { readFileSync } = require("node:fs");
const raw = readFileSync(process.argv[1], "utf8");
let body;
try { body = JSON.parse(raw); } catch (error) {
  process.stderr.write(`GET /health: body is not JSON: ${JSON.stringify(raw)}\n`);
  process.exit(1);
}
const expected = { service: "zenturian-lean", status: "ok" };
if (body === null || typeof body !== "object" || Array.isArray(body)) {
  process.stderr.write(`GET /health: body is not a JSON object: ${JSON.stringify(raw)}\n`);
  process.exit(1);
}
const keys = Object.keys(body).sort();
const wanted = Object.keys(expected).sort();
if (JSON.stringify(keys) !== JSON.stringify(wanted)) {
  process.stderr.write(`GET /health: expected exactly fields ${JSON.stringify(wanted)}, observed ${JSON.stringify(keys)}\n`);
  process.exit(1);
}
for (const key of wanted) {
  if (body[key] !== expected[key]) {
    process.stderr.write(`GET /health: field ${key}: expected ${JSON.stringify(expected[key])}, observed ${JSON.stringify(body[key])}\n`);
    process.exit(1);
  }
}
' "$work/health.body" ||
  fail "GET /health: parsed body is not exactly {\"service\":\"zenturian-lean\",\"status\":\"ok\"}"

health_marker_present "$work/health" ||
  fail "GET /health: the marker detector found no health marker (the /nope absence check would be uncontrolled)"

# --- GET /nope: the same detector must report the marker absent ---
status=$(request /nope "$work/nope") || fail "curl failed for GET /nope"
printf 'GET /nope  %s\n' "$status"
[[ $status == 404 ]] || fail "GET /nope: expected status 404, observed $status"
if health_marker_present "$work/nope"; then
  fail "GET /nope: health marker present; body: $(<"$work/nope.body")"
fi

# --- SIGTERM: the default disposition ends the process; a watchdog bounds the wait ---
kill -TERM "$server_pid" || fail "could not send SIGTERM to pid $server_pid"
(sleep 10; kill -KILL "$server_pid" 2>/dev/null) &
watchdog_pid=$!
wait "$server_pid"
server_status=$?
kill "$watchdog_pid" 2>/dev/null || true
wait "$watchdog_pid" 2>/dev/null || true
watchdog_pid=
server_pid=
((server_status == 0 || server_status == 143)) ||
  fail "server exited with status $server_status after SIGTERM (expected 0, or 143 for the signal's default disposition)"
printf 'server  exited after SIGTERM (status %s)\n' "$server_status"
printf 'PASS: /health 200 with the exact parsed body; /nope 404 without the marker\n'
