{
  lib,
  stdenv,
  fetchurl,
  unzip,
  autoPatchelfHook,
  glibc,
  zlib,
  ...
}:

# Bun from the upstream release, not nixpkgs. `packages/desktop-web/bun.lock`
# uses lockfile format 3, which nixpkgs' bun (1.3.x, pinned by flake.lock) cannot
# read. Pin the runtime here instead of adding a second nixpkgs input: the
# desktop-web build only needs bun itself, and the release zip is a small,
# immutable download.
let
  version = "1.4.3";

  sources = {
    x86_64-linux = {
      asset = "linux-x64";
      hash = "sha256-PnMFKNiXdfA/h/BcBnh8TfQJnQo38/JS57gpyyOBbhg=";
    };
    aarch64-linux = {
      asset = "linux-aarch64";
      hash = "sha256-76mBPaXtckI7+Ef5FujSxHwNd2rdlyNUAmp14Q2pqiE=";
    };
    x86_64-darwin = {
      asset = "darwin-x64";
      hash = "sha256-YmYOZDjrhyJ4h3rMp34RUtXQMTJN82jUqBtCghFInS0=";
    };
    aarch64-darwin = {
      asset = "darwin-aarch64";
      hash = "sha256-gK/UwGm0am+o8+xSC+vHUKeEPkqNW5WD0prUNsAKNAM=";
    };
  };

  system = stdenv.hostPlatform.system;
  source =
    sources.${system}
      or (throw "nix/bun-bin.nix: no Bun ${version} release for ${system}");
in
stdenv.mkDerivation {
  pname = "bun";
  inherit version;

  src = fetchurl {
    url = "https://github.com/oven-sh/bun/releases/download/bun-v${version}/bun-${source.asset}.zip";
    inherit (source) hash;
  };

  nativeBuildInputs = [ unzip ] ++ lib.optionals stdenv.hostPlatform.isLinux [ autoPatchelfHook ];
  buildInputs = lib.optionals stdenv.hostPlatform.isLinux [
    glibc
    zlib
    stdenv.cc.cc.lib
  ];

  dontConfigure = true;
  dontBuild = true;
  dontStrip = true;

  installPhase = ''
    runHook preInstall
    install -Dm755 bun $out/bin/bun
    runHook postInstall
  '';

  meta = {
    description = "Fast JavaScript runtime and package manager";
    homepage = "https://bun.sh";
    license = lib.licenses.mit;
    mainProgram = "bun";
    platforms = builtins.attrNames sources;
  };
}