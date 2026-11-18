import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";
import { isMainModule } from "./is-main-module.mjs";

const DEFAULT_TEMPLATE_PATH = fileURLToPath(
  new URL("./install-macos.sh.template", import.meta.url),
);

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-beta\.\d+)?$/;
const TAG_PATTERN = /^v\d+\.\d+\.\d+(?:-beta\.\d+)?$/;
// SHA-512 是 64 字节，base64 编码后为 88 个字符，以 "==" 结尾。
const SHA512_BASE64_PATTERN = /^[A-Za-z0-9+/]{86}==$/;

function assertVersion(version) {
  if (typeof version !== "string" || !VERSION_PATTERN.test(version)) {
    throw new Error(`expected a release version like 0.17.0 or 0.17.0-beta.1, got ${version}`);
  }
}

export function macInstallerAssetNames(version) {
  assertVersion(version);
  return {
    arm64: `Neox-${version}-arm64.zip`,
    x64: `Neox-${version}-x64.zip`,
  };
}

function sha512ToHex(value, label) {
  if (typeof value !== "string" || !SHA512_BASE64_PATTERN.test(value)) {
    throw new Error(
      `${label}: expected a base64-encoded SHA-512 value (88 characters ending in ==)`,
    );
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.length !== 64 || bytes.toString("base64") !== value) {
    throw new Error(`${label}: SHA-512 value is not canonical base64`);
  }
  return bytes.toString("hex");
}

function findSingleFile(files, assetName, label) {
  const matches = files.filter((file) => file && file.url === assetName);
  if (matches.length !== 1) {
    throw new Error(
      `${label}: expected exactly one manifest entry for ${assetName}, found ${matches.length}`,
    );
  }
  return matches[0];
}

export function renderMacInstaller({
  manifestPath,
  channel,
  tag,
  version,
  templatePath = DEFAULT_TEMPLATE_PATH,
}) {
  if (channel !== "latest" && channel !== "beta") {
    throw new Error(`expected channel "latest" or "beta", got ${channel}`);
  }
  assertVersion(version);

  const isBetaVersion = version.includes("-beta.");
  if ((channel === "beta") !== isBetaVersion) {
    throw new Error(`channel ${channel} does not match version ${version}`);
  }
  if (typeof tag !== "string" || !TAG_PATTERN.test(tag) || tag !== `v${version}`) {
    throw new Error(`expected tag v${version}, got ${tag}`);
  }

  const manifest = load(fs.readFileSync(manifestPath, "utf8")) ?? {};
  if (manifest.version !== version) {
    throw new Error(
      `${manifestPath}: manifest version is ${manifest.version}, expected ${version}`,
    );
  }
  if (!Array.isArray(manifest.files)) {
    throw new Error(`${manifestPath}: manifest has no files list`);
  }

  const assets = macInstallerAssetNames(version);
  const arm64 = findSingleFile(manifest.files, assets.arm64, manifestPath);
  const x64 = findSingleFile(manifest.files, assets.x64, manifestPath);

  const replacements = {
    __NEOX_VERSION__: version,
    __NEOX_TAG__: tag,
    __NEOX_CHANNEL__: channel,
    __NEOX_APP_NAME__: channel === "beta" ? "Neox Beta.app" : "Neox.app",
    __NEOX_ARM64_ASSET__: assets.arm64,
    __NEOX_ARM64_SHA512__: sha512ToHex(arm64.sha512, `${manifestPath}: ${assets.arm64}`),
    __NEOX_X64_ASSET__: assets.x64,
    __NEOX_X64_SHA512__: sha512ToHex(x64.sha512, `${manifestPath}: ${assets.x64}`),
  };

  let script = fs.readFileSync(templatePath, "utf8");
  for (const [token, value] of Object.entries(replacements)) {
    if (!script.includes(token)) {
      throw new Error(`${templatePath}: missing template token ${token}`);
    }
    script = script.split(token).join(value);
  }
  if (script.includes("__NEOX_")) {
    throw new Error(`${templatePath}: unreplaced template token remains`);
  }
  if (!script.endsWith("\n")) {
    script += "\n";
  }

  return script;
}

export function writeMacInstaller(options) {
  const script = renderMacInstaller(options);
  fs.writeFileSync(options.outputPath, script, { mode: 0o755 });
  fs.chmodSync(options.outputPath, 0o755);
  return options.outputPath;
}

function parseArgs(argv) {
  const options = { channel: undefined, manifestPath: undefined, outputPath: undefined };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--manifest":
        options.manifestPath = argv[++index];
        break;
      case "--channel":
        options.channel = argv[++index];
        break;
      case "--tag":
        options.tag = argv[++index];
        break;
      case "--version":
        options.version = argv[++index];
        break;
      case "--output":
        options.outputPath = argv[++index];
        break;
      case "--template":
        options.templatePath = argv[++index];
        break;
      case "--help":
      case "-h":
        usage(0);
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (
    !options.manifestPath ||
    !options.channel ||
    !options.tag ||
    !options.version ||
    !options.outputPath
  ) {
    usage(1);
  }

  return options;
}

function usage(code) {
  process.stderr.write(
    "Usage: node scripts/generate-install-sh.mjs --manifest <mac.yml> --channel <latest|beta> " +
      "--tag <vX.Y.Z> --version <X.Y.Z> --output <install.sh>\n",
  );
  process.exit(code);
}

if (isMainModule(import.meta.url)) {
  try {
    writeMacInstaller(parseArgs(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
