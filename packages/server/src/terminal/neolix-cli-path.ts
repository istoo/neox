import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve as resolvePath } from "node:path";

// Where the Neolix CLI lives, for the PATH entry and NEOLIX_HOOK_CLI every terminal gets. Kept
// apart from terminal.ts so the daemon can resolve it without loading node-pty.

const require = createRequire(import.meta.url);
const NEOLIX_CLI_BIN_ENTRY = "@neolix/cli/bin/neolix";

export function resolveExternalProcessPath(filePath: string): string {
  return filePath.replace(/\.asar(?=[/\\]|$)/, ".asar.unpacked");
}

export function resolveNeolixCliBinDir(): string | null {
  const cliExecutable = resolveNeolixCliExecutablePath();
  return cliExecutable ? dirname(cliExecutable) : null;
}

export function resolveNeolixCliExecutablePath(): string | null {
  const configuredCli = process.env.NEOLIX_CLI?.trim();
  if (configuredCli) {
    return resolvePath(configuredCli);
  }

  const cliEntrypoint = resolveNeolixCliBinEntrypoint();
  if (!cliEntrypoint) {
    return null;
  }

  const externalCliEntrypoint = resolveExternalProcessPath(cliEntrypoint);
  const npmBinDir = findNpmBinDir(dirname(externalCliEntrypoint));
  if (npmBinDir) {
    const shim = resolveNeolixCliShim(npmBinDir);
    if (shim) {
      return shim;
    }
  }

  return externalCliEntrypoint;
}

function resolveNeolixCliBinEntrypoint(): string | null {
  try {
    return require.resolve(NEOLIX_CLI_BIN_ENTRY);
  } catch {
    return null;
  }
}

function findNpmBinDir(startPath: string): string | null {
  let current = startPath;
  while (true) {
    const candidate = join(current, "node_modules", ".bin");
    if (hasNeolixCliShim(candidate)) {
      return candidate;
    }

    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function hasNeolixCliShim(binDir: string): boolean {
  return resolveNeolixCliShim(binDir) !== null;
}

function resolveNeolixCliShim(binDir: string): string | null {
  for (const name of neolixCliShimNames()) {
    const candidate = join(binDir, name);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function neolixCliShimNames(): string[] {
  return process.platform === "win32" ? ["neolix.cmd", "neolix.exe", "neolix"] : ["neolix"];
}
