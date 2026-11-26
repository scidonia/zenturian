#!/usr/bin/env bash
# Rebuild `vendor/leanin` from the pinned LeanIn checkout.
#
# The build host has no route to a forge, so Lake may not fetch a git dependency:
# the tree this repository compiles against lives in `vendor/leanin`, extracted
# from one commit of a local LeanIn checkout. This script is the only writer of
# that tree. It rewrites no file, opens no network and needs no compiler.
#
#   scripts/sync-vendor.sh [leanin-checkout]
#
# The checkout defaults to `$LEANIN_SRC`, then to `<repo>/../leanin`. It may be
# ahead of the pin; what it must do is contain the pinned commit, because that is
# the commit archived. A checkout without it is refused rather than silently
# vendoring a different revision.

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
pin="ffe3a0af70d4dee440ac1a61e23398276a5392b6"
src="${1:-${LEANIN_SRC:-$root/../leanin}}"
dest="$root/vendor/leanin"

# The filter: the library root, its sources, the socket shim, the package's two
# build-input records, and the licence. `vendor/VENDOR.md` states it too.
paths=(
  LeanIn.lean
  LeanIn
  c/netuv.c
  lakefile.lean
  lean-toolchain
  flake.nix
  flake.lock
  LICENSE
  NOTICE
)

die() {
  printf 'sync-vendor: %s\n' "$*" >&2
  exit 1
}

[ -d "$src" ] || die "$src is not a directory"
git -C "$src" rev-parse --git-dir >/dev/null 2>&1 || die "$src is not a git checkout"

git -C "$src" cat-file -e "$pin^{commit}" 2>/dev/null \
  || die "$src does not contain the pin $pin"

for path in "${paths[@]}"; do
  git -C "$src" cat-file -e "$pin:$path" 2>/dev/null || die "the pin has no $path"
done

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

git -C "$src" archive "$pin" -- "${paths[@]}" | tar -x -C "$tmp"

for path in "${paths[@]}"; do
  [ -e "$tmp/$path" ] || die "the extraction is missing $path"
done

mkdir -p "$dest"
find "$dest" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
cp -a "$tmp/." "$dest/"

printf 'sync-vendor: vendor/leanin is LeanIn %s (%s filtered paths)\n' "$pin" "${#paths[@]}"
