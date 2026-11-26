{
  description = "zenturian — the Lean enforcement stack served on LeanIn";

  # One input. The revision is the one LeanIn's own flake.lock records, so the
  # vendored tree and this shell are built from the same nixpkgs.
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { nixpkgs, ... }:
    let
      systems = [ "x86_64-linux" ];
      forEachSystem = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
      # The vendored LeanIn tree carries its own flake files as the pinned input
      # record; this derivation reproduces the toolchain it names rather than
      # importing them. `v4.35.0` is the official binary release, not a source
      # build: the nixpkgs derivation on this line is a release candidate, and
      # building the final tag from source would cost an hour on first use.
      lean4Derivation = pkgs: pkgs.stdenv.mkDerivation {
        pname = "lean4";
        version = "4.35.0";
        src = pkgs.fetchurl {
          url = "https://releases.lean-lang.org/lean4/v4.35.0/lean-4.35.0-linux.tar.zst";
          hash = "sha256-colZekRUMkbJInuMrlAXZ+CVzhf21Ei5X8So3Jcmj20=";
        };
        nativeBuildInputs = [ pkgs.autoPatchelfHook pkgs.zstd ];
        buildInputs = [ pkgs.stdenv.cc.cc.lib pkgs.zlib ];
        sourceRoot = "lean-4.35.0-linux";
        unpackPhase = ''
          tar --zstd -xf $src
        '';
        dontStrip = true;
        installPhase = ''
          mkdir -p $out
          cp -a ./. $out/
        '';
      };
    in
    {
      packages = forEachSystem (pkgs: {
        lean4 = lean4Derivation pkgs;
        default = lean4Derivation pkgs;
      });

      devShells = forEachSystem (pkgs: {
        default = pkgs.mkShell {
          name = "zenturian";
          packages = [
            (lean4Derivation pkgs)
            pkgs.libuv
            pkgs.libuv.dev
            pkgs.libsodium
            pkgs.libsodium.dev
            pkgs.curl
            pkgs.nodejs_22
            pkgs.git
            pkgs.zstd
            pkgs.coreutils
            pkgs.binutils
          ];
          # LeanIn's `leanc` defaults to the toolchain's bundled `clang`, whose links target the
          # generic `/lib64` loader — absent on NixOS, where that path is a stub. Point it at the
          # shell's `cc` (the Nix gcc wrapper) so an executable links against the store's loader.
          # The absolute store path, not a PATH lookup: the compiler that links a native binary is
          # not something a caller's PATH should be able to change.
          LEAN_CC = "${pkgs.stdenv.cc}/bin/cc";
          shellHook = ''
            # A Lean executable carries `libleanshared.so` as a NEEDED entry; the toolchain keeps it
            # in `lib/lean`, which `nix develop` does not add for us. Exported here so the built
            # binary runs directly, without a `lake env` wrapper.
            export LD_LIBRARY_PATH="${lean4Derivation pkgs}/lib/lean:${pkgs.libuv}/lib''${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
          '';
        };
      });
    };
}
