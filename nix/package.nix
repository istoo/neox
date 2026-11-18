{
  lib,
  stdenv,
  pkgs,
  buildNpmPackage,
  nodejs_22,
  python3,
  makeWrapper,
  autoPatchelfHook,
  # node-pty needs libuv headers on Linux
  libuv,
  # Exposed so downstream flakes that follow a different nixpkgs revision
  # (where `fetchNpmDeps` may produce a different hash for the same lockfile)
  # can override via `.override { npmDepsHash = "sha256-..."; }` without
  # `overrideAttrs` gymnastics — `npmDepsHash` is destructured from
  # `buildNpmPackage`'s args, so `overrideAttrs` cannot reach it.
  #
  # The default is read from a sidecar file so the CI auto-updater can replace
  # the hash with a single file write instead of a sed against this source.
  npmDepsHash ? lib.fileContents ./npm-deps.hash,
  # desktop-web is a separate Bun workspace. Its node_modules come from a
  # fixed-output derivation (nix/desktop-web-deps.nix); bun itself is pinned
  # to the release whose lockfile format matches bun.lock.
  bun ? pkgs.callPackage ./bun-bin.nix { },
  desktopWebDeps ? pkgs.callPackage ./desktop-web-deps.nix { inherit bun; },
}:

buildNpmPackage rec {
  pname = "neolix";
  version = (builtins.fromJSON (builtins.readFile ../package.json)).version;

  src = lib.cleanSourceWith {
    src = ./..;
    filter = path: type:
      let
        baseName = builtins.baseNameOf path;
        relPath = lib.removePrefix (toString ./..) path;
      in
      # Exclude non-daemon workspace contents (keep package.json for workspace resolution)
      !(lib.hasPrefix "/packages/website/src" relPath)
      && !(lib.hasPrefix "/packages/website/public" relPath)
      && !(lib.hasPrefix "/packages/desktop/src" relPath)
      && !(lib.hasPrefix "/packages/desktop/src-tauri" relPath)
      # Documentation, CI definitions and agent/editor configuration. None of
      # these reach the build. Excluding them here also matters for the desktop
      # derivation, which inherits this package's npmDeps: leaving them in makes
      # a docs-only commit produce a new npm-deps .drv, and so a new desktop
      # .drv, and so a full rebuild for a byte-identical result.
      && !(lib.hasPrefix "/docs" relPath)
      && !(lib.hasPrefix "/.github" relPath)
      && !(lib.hasPrefix "/.agents" relPath)
      && !(lib.hasPrefix "/.claude" relPath)
      && !(lib.hasPrefix "/.codex" relPath)
      && !(lib.hasPrefix "/docker" relPath)
      # Top-level prose only (README, CHANGELOG, AGENTS...). Deeper markdown is
      # not necessarily documentation: skills/*/SKILL.md is a runtime file the
      # daemon's trace script copies into the output. The changelog is prose
      # too, but apps/web imports it at build time for the what's-new screen.
      && (
        builtins.match "/[^/]+\\.md" relPath == null
        || relPath == "/CHANGELOG.md"
        || relPath == "/CHANGELOG.zh-CN.md"
      )
      # Exclude test fixtures and debug files
      && !(lib.hasSuffix ".test.ts" baseName)
      && !(lib.hasSuffix ".e2e.test.ts" baseName)
      && baseName != "node_modules"
      && baseName != ".git"
      && baseName != ".neox"
      && baseName != ".DS_Store";
  };

  nodejs = nodejs_22;

  # Default hash lives in nix/npm-deps.hash (see arg default above).
  # CI auto-updates that file when package-lock.json changes (see .github/workflows/).
  inherit npmDepsHash;

  # Prevent onnxruntime-node's install script from running during automatic
  # npm rebuild (it tries to download from api.nuget.org, which fails in the sandbox).
  # We manually rebuild only node-pty in buildPhase.
  npmRebuildFlags = [ "--ignore-scripts" ];

  nativeBuildInputs = [
    python3 # for node-gyp (node-pty compilation)
    makeWrapper
    bun # builds the desktop web app below
  ] ++ lib.optionals stdenv.hostPlatform.isLinux [
    autoPatchelfHook
  ];

  buildInputs = lib.optionals stdenv.hostPlatform.isLinux [
    libuv
    stdenv.cc.cc.lib # libstdc++ for sherpa-onnx prebuilt binaries
  ];

  # sharp installs its musl variants next to the glibc ones. They are never
  # loaded on glibc, and their libc has no Nix equivalent to point at.
  autoPatchelfIgnoreMissingDeps = [ "libc.musl-*" ];

  # Don't use the default npm build hook — we need a custom build sequence
  dontNpmBuild = true;

  env = {
    # The server tsc build and the web app's Vite build outgrow Node's default
    # old-space limit. Match docker/base/Dockerfile's limit.
    NODE_OPTIONS = "--max-old-space-size=2560";
  };

  buildPhase = ''
    runHook preBuild

    # Rebuild only node-pty (native addon for terminal emulation). The sherpa
    # speech runtime ships prebuilt platform packages and is copied into the
    # daemon closure by scripts/trace-daemon.mjs.
    npm rebuild node-pty

    # Bun workspace dependencies are not part of npmDeps. The fixed-output
    # derivation provides the hoisted node_modules tree in one copy.
    cp -a ${desktopWebDeps}/. packages/desktop-web/
    # Store-path copies are read-only; npm/Bun build scripts write caches and
    # generated files under node_modules.
    chmod -R u+w packages/desktop-web/node_modules packages/desktop-web/apps

    # Build all server packages in dependency order (defined in package.json)
    npm run build:server

    # The web client the daemon serves on its own port. Writes embed.js and the
    # page to packages/server/dist/server/web-app.
    node scripts/build-daemon-web-app.mjs

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    # Compute the daemon's runtime closure by static module-graph tracing
    # (@vercel/nft from supervisor-entrypoint.js, cli/dist/index.js, and the
    # forked terminal/speech worker processes) plus an explicit list of non-JS
    # assets read at runtime. The trace script is the single source of
    # truth for what the daemon needs at $out — auditable in plain JS, no
    # npm hoisting / .bin / workspace-symlink footguns.
    mkdir -p $out/lib/neolix
    node scripts/trace-daemon.mjs > daemon-files.txt

    while IFS= read -r path; do
      [ -z "$path" ] && continue
      mkdir -p "$out/lib/neolix/$(dirname "$path")"
      cp -a "$path" "$out/lib/neolix/$path"
    done < daemon-files.txt

    # nft reaches the web app only through dynamic imports and filesystem
    # lookups, so its trace omits these files. Copy the built artifact as one
    # tree; web-app.ts resolves it beside the server package at runtime.
    web_app=packages/server/dist/server/web-app
    if [ ! -f "$web_app/embed.js" ] || [ ! -f "$web_app/web/index.html" ]; then
      echo "daemon web app was not built ($web_app)" >&2
      exit 1
    fi
    mkdir -p "$out/lib/neolix/packages/server/dist/server"
    rm -rf "$out/lib/neolix/packages/server/dist/server/web-app"
    cp -a "$web_app" "$out/lib/neolix/packages/server/dist/server/"
    test -f "$out/lib/neolix/packages/server/dist/server/web-app/embed.js"
    test -f "$out/lib/neolix/packages/server/dist/server/web-app/web/index.html"

    # Shell hooks invoke the retained CLI bin directly, without a system Node.
    patchShebangs --build "$out/lib/neolix"

    # Root package.json lets node resolve the workspace layout when the
    # CLI/server bin starts from $out.
    cp package.json $out/lib/neolix/

    # Create wrapper for the server entry point (for systemd / direct use)
    mkdir -p $out/bin
    # Keep Neolix's runtime mode separate from NODE_ENV, which belongs to spawned agents.
    makeWrapper ${nodejs}/bin/node $out/bin/neolix-server \
      --add-flags "$out/lib/neolix/packages/server/dist/scripts/supervisor-entrypoint.js" \
      --set NEOLIX_NODE_ENV production

    # Create wrapper for the CLI
    makeWrapper ${nodejs}/bin/node $out/bin/neolix \
      --add-flags "$out/lib/neolix/packages/cli/dist/index.js" \
      --set NODE_PATH "$out/lib/neolix/node_modules"

    runHook postInstall
  '';

  meta = {
    description = "Self-hosted daemon for Claude Code, Codex, and OpenCode";
    homepage = "https://github.com/istoo/neox";
    license = lib.licenses.asl20;
    mainProgram = "neolix";
    platforms = lib.platforms.linux ++ lib.platforms.darwin;
  };
}
