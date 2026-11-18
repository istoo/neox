{
  lib,
  stdenv,
  pkgs,
  bun ? pkgs.callPackage ./bun-bin.nix { },
  cacert,
  # Overridable so scripts/update-nix.sh can build once with a deliberately
  # wrong hash and read the real one from the mismatch error.
  outputHash ? lib.fileContents ./desktop-web-deps.hash,
}:

# Fixed-output derivation for packages/desktop-web's Bun dependencies. The Bun
# workspace keeps its own lockfile and is not part of the npm workspace, so
# buildNpmPackage's npmDeps does not cover it.
#
# `--os=* --cpu=*` installs every platform's optional native package, making the
# output identical no matter which supported system builds it. That keeps a
# single hash, like nix/npm-deps.hash.
stdenv.mkDerivation {
  pname = "neolix-desktop-web-deps";
  version = bun.version;

  src = lib.cleanSourceWith {
    src = ../packages/desktop-web;
    filter = path: type: let
      relPath = lib.removePrefix (toString ../packages/desktop-web) path;
    in
      type == "directory"
      || relPath == "/package.json"
      || relPath == "/bun.lock"
      || relPath == "/bunfig.toml"
      || lib.hasPrefix "/patches/" relPath
      || builtins.match "/(apps|packages)/[^/]+/package\\.json" relPath != null;
  };

  nativeBuildInputs = [
    bun
    cacert
  ];

  outputHashMode = "recursive";
  outputHashAlgo = "sha256";
  inherit outputHash;

  # Fixed-output derivations run with network access; pass proxy settings
  # through so installs work behind a mirror.
  impureEnvVars = lib.fetchers.proxyImpureEnvVars;

  dontConfigure = true;
  dontBuild = true;
  # fixupPhase's autoPatchelf/patchShebangs would rewrite interpreters inside
  # these third-party packages to /nix/store paths. Fixed-output derivations
  # may not contain store references, and the consuming build runs fixup on the
  # files it actually ships. Keep the install byte-identical to the registry
  # tarballs.
  dontFixup = true;

  installPhase = ''
    runHook preInstall

    export HOME="$TMPDIR"
    export BUN_INSTALL_CACHE_DIR="$TMPDIR/bun-cache"
    export SSL_CERT_FILE="${cacert}/etc/ssl/certs/ca-bundle.crt"
    export NIX_SSL_CERT_FILE="$SSL_CERT_FILE"

    # The repository's bunfig.toml selects the isolated linker for development,
    # but its node_modules/.bun hoist links pick between duplicate package
    # versions in an order that varies between runs. Hoisted output is
    # identical across repeated runs and across platforms, which a fixed-output
    # hash requires.
    bun install \
      --frozen-lockfile \
      --ignore-scripts \
      --linker=hoisted \
      --cpu='*' \
      --os='*' \
      --no-progress

    # vite.config.ts builds its monaco-vim alias from an explicit
    # apps/web/node_modules/monaco-vim path. The hoisted linker creates no
    # per-workspace node_modules, so recreate that one path.
    mkdir -p apps/web/node_modules
    ln -sfn ../../../node_modules/monaco-vim apps/web/node_modules/monaco-vim

    # Copy the hoisted root node_modules. Workspace symlinks inside it are
    # relative; the build copies this tree back over the source tree, where
    # they resolve to the real workspace directories.
    mkdir -p "$out"
    find . -type d -name node_modules -prune -print | while IFS= read -r dir; do
      mkdir -p "$out/$(dirname "$dir")"
      cp -a "$dir" "$out/$dir"
    done

    absolute_link="$(find "$out" -type l -lname '/*' -print -quit)"
    if [ -n "$absolute_link" ]; then
      echo "desktop-web dependencies contain an absolute symlink: $absolute_link" >&2
      exit 1
    fi

    runHook postInstall
  '';

  meta = {
    description = "Bun dependencies for the Neolix desktop web workspace";
    platforms = lib.platforms.linux ++ lib.platforms.darwin;
  };
}