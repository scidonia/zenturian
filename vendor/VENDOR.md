# Vendored LeanIn

`vendor/leanin` is a filtered copy of the LeanIn source tree at one pinned commit.
It is vendored rather than fetched because the build host has no route to a forge:
Lake cannot resolve a git requirement there, so the only Lean dependency this
project has is a path requirement over these bytes.

| | |
| --- | --- |
| Repository | `https://github.com/scidonia/leanin` |
| Pin | `ffe3a0af70d4dee440ac1a61e23398276a5392b6` |
| Lean toolchain | `leanprover/lean4:v4.35.0` (from the pinned `lean-toolchain`) |
| Licence | Apache License 2.0 (`LICENSE`, `NOTICE`) |

## The filter

`git archive <pin>` restricted to these paths:

```
LeanIn.lean
LeanIn
c/netuv.c
lakefile.lean
lean-toolchain
flake.nix
flake.lock
LICENSE
NOTICE
```

`LeanIn` is the library's whole module tree, including the HTTP/1.1 driver, the
runtime and the scheduler this project binds. `c/netuv.c` is the socket shim;
this project compiles it into its own `.lake/build/lib` through the `extern_lib`
in its `lakefile.lean`, so no dependency build directory is referenced and
`libuv` stays a dev-shell package.

The two flake files travel as the pinned input record — the revision of nixpkgs
the source was built against. This repository's own `flake.nix` reproduces the
`v4.35.0` binary-release derivation rather than importing them.

Everything else in the LeanIn checkout — tests, benchmark harnesses, the example
executables, documentation, CI configuration — is not copied. Nothing here is
edited by hand: the vendored tree is byte-identical to the pin.

## Re-syncing

```bash
# any LeanIn checkout that contains the pin — it may be ahead of it
scripts/sync-vendor.sh ../leanin
```

The script requires the pinned commit to exist in the checkout (`git cat-file -e
<pin>^{commit}`), extracts with `git archive <pin> -- <filtered paths>`, fails if a
filtered path is missing, and replaces `vendor/leanin`'s contents. A checkout ahead
of the pin is fine; one that does not contain it is refused. The script rewrites no
file, opens no network and needs no compiler. An upstream bump is a change to the
pin in this file, in `scripts/sync-vendor.sh`, and a re-read of the declarations
this project binds — not a silent follow of LeanIn `main`.
