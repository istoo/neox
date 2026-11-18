import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  macInstallerAssetNames,
  renderMacInstaller,
  writeMacInstaller,
} from "./generate-install-sh.mjs";

const generatorPath = fileURLToPath(new URL("./generate-install-sh.mjs", import.meta.url));

const VERSION = "0.17.0-beta.1";
const STABLE_VERSION = "0.16.5";
const ARM64_SHA_BASE64 = Buffer.alloc(64, 0x11).toString("base64");
const X64_SHA_BASE64 = Buffer.alloc(64, 0x22).toString("base64");
const ARM64_SHA_HEX = Buffer.alloc(64, 0x11).toString("hex");
const X64_SHA_HEX = Buffer.alloc(64, 0x22).toString("hex");

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function manifestYaml({
  version = VERSION,
  arm64Sha = ARM64_SHA_BASE64,
  x64Sha = X64_SHA_BASE64,
  includeX64 = true,
} = {}) {
  const assets = macInstallerAssetNames(version);
  const lines = [
    `version: ${version}`,
    "files:",
    `  - url: ${assets.arm64}`,
    `    sha512: ${arm64Sha}`,
    "    size: 228579704",
    `  - url: ${assets.arm64}.blockmap`,
    "    sha512: AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
    "    size: 1",
  ];
  if (includeX64) {
    lines.push(`  - url: ${assets.x64}`, `    sha512: ${x64Sha}`, "    size: 238302710");
  }
  lines.push(`path: ${assets.arm64}`, `sha512: ${arm64Sha}`, "");
  return lines.join("\n");
}

function writeManifest(dir, options) {
  const manifestPath = path.join(dir, "beta-mac.yml");
  fs.writeFileSync(manifestPath, manifestYaml(options));
  return manifestPath;
}

function writeExecutable(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, { mode: 0o755 });
  fs.chmodSync(filePath, 0o755);
}

function createMockBin(binDir, { system, machine, sha512 }) {
  writeExecutable(
    path.join(binDir, "uname"),
    `#!/bin/sh
case "\${1:-}" in
  -s) printf '%s\\n' '${system}' ;;
  -m) printf '%s\\n' '${machine}' ;;
  *) printf '%s\\n' '${system}' ;;
esac
`,
  );

  writeExecutable(
    path.join(binDir, "curl"),
    `#!/bin/sh
if [ -n "\${MOCK_CURL_LOG:-}" ]; then
  printf '%s\\n' "$*" > "$MOCK_CURL_LOG"
fi
out=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o|--output) out=$2; shift 2 ;;
    *) shift ;;
  esac
done
printf '%s' 'mock neox archive' > "$out"
`,
  );

  writeExecutable(
    path.join(binDir, "shasum"),
    `#!/bin/sh
last=''
for arg in "$@"; do last=$arg; done
printf '%s  %s\\n' '${sha512}' "$last"
`,
  );

  writeExecutable(
    path.join(binDir, "ditto"),
    `#!/bin/sh
if [ "\${1:-}" = "-x" ]; then
  dest=$4
  mkdir -p "$dest/Neox.app/Contents/MacOS"
  printf '#!/bin/sh\\n' > "$dest/Neox.app/Contents/MacOS/Neox"
  chmod +x "$dest/Neox.app/Contents/MacOS/Neox"
  exit 0
fi
if [ "\${MOCK_DITTO_SIGNAL:-}" = "TERM" ]; then
  kill -TERM "$PPID"
  exit 143
fi
if [ "\${MOCK_DITTO_FAIL:-}" = "1" ]; then
  exit 1
fi
src=$1
dest=$2
mkdir -p "$dest"
cp -R "$src"/. "$dest"/
`,
  );
}

function setup({
  system = "Darwin",
  machine = "arm64",
  sha512 = ARM64_SHA_HEX,
  version = VERSION,
  channel = "beta",
  tag = `v${version}`,
} = {}) {
  const root = makeTempDir("neox-install-sh-test-");
  const home = path.join(root, "home");
  const tmpDir = path.join(root, "tmp");
  const binDir = path.join(root, "bin");
  fs.mkdirSync(home);
  fs.mkdirSync(tmpDir);
  const manifestPath = writeManifest(root, { version });
  const scriptPath = path.join(root, "install.sh");
  writeMacInstaller({
    manifestPath,
    channel,
    tag,
    version,
    outputPath: scriptPath,
  });
  createMockBin(binDir, { system, machine, sha512 });

  return {
    root,
    home,
    tmpDir,
    binDir,
    manifestPath,
    scriptPath,
    curlLog: path.join(root, "curl.log"),
  };
}

function runInstaller(context, extraEnv = {}) {
  return spawnSync("sh", [context.scriptPath], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${context.binDir}:/usr/bin:/bin`,
      HOME: context.home,
      TMPDIR: context.tmpDir,
      MOCK_CURL_LOG: context.curlLog,
      ...extraEnv,
    },
  });
}

function cleanup(context) {
  fs.rmSync(context.root, { recursive: true, force: true });
}

test("renders a beta installer bound to the exact release and both ZIP checksums", () => {
  const root = makeTempDir("neox-install-render-");
  try {
    const manifestPath = writeManifest(root);
    const script = renderMacInstaller({
      manifestPath,
      channel: "beta",
      tag: `v${VERSION}`,
      version: VERSION,
    });

    assert.match(script, /^NEOX_VERSION='0\.17\.0-beta\.1'$/m);
    assert.match(script, /^NEOX_TAG='v0\.17\.0-beta\.1'$/m);
    assert.match(script, /^NEOX_CHANNEL='beta'$/m);
    assert.match(script, /^APP_NAME='Neox Beta\.app'$/m);
    assert.match(script, /^ARM64_ASSET='Neox-0\.17\.0-beta\.1-arm64\.zip'$/m);
    assert.match(script, new RegExp(`^ARM64_SHA512='${ARM64_SHA_HEX}'$`, "m"));
    assert.match(script, /^X64_ASSET='Neox-0\.17\.0-beta\.1-x64\.zip'$/m);
    assert.match(script, new RegExp(`^X64_SHA512='${X64_SHA_HEX}'$`, "m"));
    assert.doesNotMatch(script, /releases\/latest/);
    assert.match(script, /^main "\$@"$/m);
    assert.doesNotMatch(script, /^\s*open\s/m);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("renders a stable installer that targets Neox.app", () => {
  const root = makeTempDir("neox-install-stable-");
  try {
    const manifestPath = writeManifest(root, { version: STABLE_VERSION });
    const script = renderMacInstaller({
      manifestPath,
      channel: "latest",
      tag: `v${STABLE_VERSION}`,
      version: STABLE_VERSION,
    });

    assert.match(script, /^APP_NAME='Neox\.app'$/m);
    assert.match(script, /^NEOX_TAG='v0\.16\.5'$/m);
    assert.doesNotMatch(script, /Neox Beta\.app/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("CLI writes an executable version-bound installer", () => {
  const root = makeTempDir("neox-install-cli-");
  try {
    const manifestPath = writeManifest(root);
    const outputPath = path.join(root, "install.sh");
    const result = spawnSync(
      process.execPath,
      [
        generatorPath,
        "--manifest",
        manifestPath,
        "--channel",
        "beta",
        "--tag",
        `v${VERSION}`,
        "--version",
        VERSION,
        "--output",
        outputPath,
      ],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.statSync(outputPath).mode & 0o111, 0o111);
    assert.match(fs.readFileSync(outputPath, "utf8"), /NEOX_VERSION='0\.17\.0-beta\.1'/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a manifest with a different version", () => {
  const root = makeTempDir("neox-install-version-");
  try {
    const manifestPath = writeManifest(root, { version: "0.17.0-beta.2" });
    assert.throws(
      () =>
        renderMacInstaller({
          manifestPath,
          channel: "beta",
          tag: `v${VERSION}`,
          version: VERSION,
        }),
      /manifest version is 0\.17\.0-beta\.2, expected 0\.17\.0-beta\.1/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a manifest without both architecture ZIPs", () => {
  const root = makeTempDir("neox-install-assets-");
  try {
    const manifestPath = writeManifest(root, { includeX64: false });
    assert.throws(
      () =>
        renderMacInstaller({
          manifestPath,
          channel: "beta",
          tag: `v${VERSION}`,
          version: VERSION,
        }),
      /expected exactly one manifest entry for Neox-0\.17\.0-beta\.1-x64\.zip, found 0/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rejects duplicate or malformed SHA-512 values", () => {
  const root = makeTempDir("neox-install-sha-");
  try {
    const duplicatePath = writeManifest(root);
    const duplicate = fs
      .readFileSync(duplicatePath, "utf8")
      .replace(
        `  - url: Neox-0.17.0-beta.1-arm64.zip\n    sha512: ${ARM64_SHA_BASE64}`,
        `  - url: Neox-0.17.0-beta.1-arm64.zip\n    sha512: ${ARM64_SHA_BASE64}\n  - url: Neox-0.17.0-beta.1-arm64.zip\n    sha512: ${ARM64_SHA_BASE64}`,
      );
    fs.writeFileSync(duplicatePath, duplicate);
    assert.throws(
      () =>
        renderMacInstaller({
          manifestPath: duplicatePath,
          channel: "beta",
          tag: `v${VERSION}`,
          version: VERSION,
        }),
      /expected exactly one manifest entry for Neox-0\.17\.0-beta\.1-arm64\.zip, found 2/,
    );

    const malformedPath = writeManifest(root, { arm64Sha: "not-a-sha512" });
    assert.throws(
      () =>
        renderMacInstaller({
          manifestPath: malformedPath,
          channel: "beta",
          tag: `v${VERSION}`,
          version: VERSION,
        }),
      /expected a base64-encoded SHA-512/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a tag, channel, or version that is not bound to the manifest", () => {
  const root = makeTempDir("neox-install-tag-");
  try {
    const manifestPath = writeManifest(root);
    assert.throws(
      () =>
        renderMacInstaller({
          manifestPath,
          channel: "beta",
          tag: "v0.17.0-beta.2",
          version: VERSION,
        }),
      /expected tag v0\.17\.0-beta\.1, got v0\.17\.0-beta\.2/,
    );
    assert.throws(
      () =>
        renderMacInstaller({
          manifestPath,
          channel: "latest",
          tag: `v${VERSION}`,
          version: VERSION,
        }),
      /channel latest does not match version 0\.17\.0-beta\.1/,
    );
    assert.throws(
      () =>
        renderMacInstaller({
          manifestPath,
          channel: "beta",
          tag: `v${VERSION}`,
          version: "0.17.0-beta.1'; rm -rf /",
        }),
      /expected a release version/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("installs the arm64 beta into ~/Applications and cleans its temp directory", () => {
  const context = setup({ machine: "arm64", sha512: ARM64_SHA_HEX });
  try {
    const syntax = spawnSync("sh", ["-n", context.scriptPath], { encoding: "utf8" });
    assert.equal(syntax.status, 0, syntax.stderr);

    const result = runInstaller(context);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const appPath = path.join(context.home, "Applications", "Neox Beta.app");
    assert.ok(fs.existsSync(path.join(appPath, "Contents", "MacOS", "Neox")));
    assert.match(fs.readFileSync(context.curlLog, "utf8"), /Neox-0\.17\.0-beta\.1-arm64\.zip/);
    assert.deepEqual(fs.readdirSync(context.tmpDir), []);
    assert.match(result.stdout, /已安装 Neox 0\.17\.0-beta\.1/);
  } finally {
    cleanup(context);
  }
});

test("selects the x86_64 ZIP and its checksum on an Intel Mac", () => {
  const context = setup({ machine: "x86_64", sha512: X64_SHA_HEX });
  try {
    const result = runInstaller(context);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(fs.readFileSync(context.curlLog, "utf8"), /Neox-0\.17\.0-beta\.1-x64\.zip/);
    assert.ok(
      fs.existsSync(
        path.join(context.home, "Applications", "Neox Beta.app", "Contents", "MacOS", "Neox"),
      ),
    );
  } finally {
    cleanup(context);
  }
});

test("refuses to install over an existing target, including a symlink", () => {
  const context = setup({ machine: "arm64", sha512: ARM64_SHA_HEX });
  try {
    const applications = path.join(context.home, "Applications");
    fs.mkdirSync(applications);
    const target = path.join(applications, "Neox Beta.app");
    const original = path.join(context.home, "old.app");
    fs.mkdirSync(original);
    fs.symlinkSync(original, target);

    const result = runInstaller(context);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /已存在/);
    assert.equal(fs.readlinkSync(target), original);
    assert.ok(!fs.existsSync(context.curlLog));
  } finally {
    cleanup(context);
  }
});

test("removes its reserved app directory when interrupted during copy", () => {
  const context = setup({ machine: "arm64", sha512: ARM64_SHA_HEX });
  try {
    const target = path.join(context.home, "Applications", "Neox Beta.app");
    const interrupted = runInstaller(context, { MOCK_DITTO_SIGNAL: "TERM" });
    assert.notEqual(interrupted.status, 0);
    assert.ok(!fs.existsSync(target));
    assert.deepEqual(fs.readdirSync(context.tmpDir), []);

    const retry = runInstaller(context);
    assert.equal(retry.status, 0, `${retry.stdout}\n${retry.stderr}`);
    assert.ok(fs.existsSync(path.join(target, "Contents", "MacOS", "Neox")));
  } finally {
    cleanup(context);
  }
});

test("aborts without installing when the SHA-512 check fails", () => {
  const context = setup({ machine: "arm64", sha512: "0".repeat(128) });
  try {
    const result = runInstaller(context);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /SHA-512 校验失败/);
    assert.ok(!fs.existsSync(path.join(context.home, "Applications")));
    assert.deepEqual(fs.readdirSync(context.tmpDir), []);
  } finally {
    cleanup(context);
  }
});

test("reports a readable Chinese error on non-macOS systems", () => {
  const context = setup({ system: "Linux", machine: "x86_64" });
  try {
    const result = runInstaller(context);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /只支持 macOS，当前系统是 Linux。/);
    assert.ok(!fs.existsSync(context.curlLog));
  } finally {
    cleanup(context);
  }
});

test("rejects unsupported Mac CPU architectures before downloading", () => {
  const context = setup({ machine: "ppc64" });
  try {
    const result = runInstaller(context);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /不支持的 CPU 架构：ppc64/);
    assert.ok(!fs.existsSync(context.curlLog));
  } finally {
    cleanup(context);
  }
});
