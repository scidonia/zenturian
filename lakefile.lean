import Lake
open System Lake DSL

package zenturian where
  version := v!"0.1.0"
  description := "Zenturian's Lean enforcement stack, served on LeanIn"
  license := "Apache-2.0"
  /- LeanIn needs 4.35 (`Std.WP` appears there), and this package binds LeanIn's declarations directly, so the
  toolchain is not a preference: it is the one the dependency is built with. -/
  fixedToolchain := true

/-- LeanIn is the only Lean dependency, and it is a path requirement over the vendored tree: the build host has
no route to a forge, so nothing may be fetched at build time. `vendor/VENDOR.md` records the pin. -/
require leanin from "vendor/leanin"

lean_lib Zenturian where
  globs := #[.one `Zenturian, .submodules `Zenturian]

/-- The socket shim: the vendored `c/netuv.c` compiled into **this** package's build directory, so the executable
links a library it built rather than reaching into the dependency's `.lake`. Mirrors LeanIn's own pattern. -/
extern_lib netuv pkg := do
  let srcJob ← inputFile (pkg.dir / "vendor" / "leanin" / "c" / "netuv.c") true
  let oJob ← buildO (pkg.buildDir / "c" / "netuv.o") srcJob
    #["-fPIC", s!"-I{← getLeanIncludeDir}"] #["-O2"]
  buildStaticLib (pkg.buildDir / "lib" / nameToStaticLib "netuv") #[oJob]

/-- The shim Lake just built, and the `libuv` it wraps (a system dependency of the dev shell). -/
def netuvLinkArgs : Array String := #["-L", ".lake/build/lib", "-lnetuv", "-luv"]

@[default_target]
lean_exe zenturianLean where
  root := `Zenturian.App.Main
  moreLinkArgs := netuvLinkArgs
