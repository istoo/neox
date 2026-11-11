import { promises as fs } from "node:fs";
import { app } from "electron";
import log from "electron-log/main";
import { resolveCliInstallSourcePath } from "./path.js";
import { getBundledCliShimPath, getCliTargetPath, getLocalBinDir } from "./paths.js";
import { ensurePathInShellRc } from "./shell-rc.js";

interface InstallStatus {
  installed: boolean;
}

async function pathOrSymlinkExists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

function resolveInstallSourcePath(shimPath: string): string {
  return resolveCliInstallSourcePath({
    platform: process.platform,
    isPackaged: app.isPackaged,
    executablePath: app.getPath("exe"),
    shimPath,
    appImagePath: process.env.APPIMAGE,
  });
}

// A thin .cmd trampoline that delegates to the bundled shim. Only the app install path is baked
// in — internal details (asar layout, entrypoint scripts) live in the bundled shim and update with
// the app.
function buildCmdTrampoline(shimPath: string): string {
  return [
    "@echo off",
    `set "BUNDLED_CLI=${shimPath}"`,
    `if not exist "%BUNDLED_CLI%" (`,
    `  echo Neox CLI not found at %BUNDLED_CLI% — is Neox installed? 1>&2`,
    `  exit /b 1`,
    `)`,
    `call "%BUNDLED_CLI%" %*`,
    `exit /b %errorlevel%`,
  ].join("\r\n");
}

async function installAt(targetPath: string, shimPath: string): Promise<void> {
  if (await pathOrSymlinkExists(targetPath)) {
    await fs.unlink(targetPath);
  }
  if (process.platform === "win32") {
    await fs.writeFile(targetPath, buildCmdTrampoline(shimPath), "utf-8");
  } else {
    await fs.symlink(resolveInstallSourcePath(shimPath), targetPath);
  }
}

export async function installCli(): Promise<InstallStatus> {
  const shimPath = getBundledCliShimPath();

  await fs.mkdir(getLocalBinDir(), { recursive: true });
  // COMPAT(neolix-cli): neox is the command now; keep installing neolix so
  // existing scripts and docs keep working.
  await installAt(getCliTargetPath("neolix"), shimPath);
  await installAt(getCliTargetPath("neox"), shimPath);

  const { shellUpdated } = await ensurePathInShellRc();
  if (shellUpdated) {
    log.info("[integrations] Updated shell rc with ~/.local/bin PATH");
  }

  return getCliInstallStatus();
}

/**
 * Removes the CLI only when the file at the target is the one this app installs, so a `neolix` the
 * user put there some other way survives. The shell rc PATH line stays: it is harmless and other
 * tools in ~/.local/bin rely on it.
 */
export async function uninstallCli(): Promise<InstallStatus> {
  for (const name of ["neolix", "neox"] as const) {
    const targetPath = getCliTargetPath(name);
    if (await isOwnInstall(targetPath)) {
      await fs.unlink(targetPath);
    } else if (await pathOrSymlinkExists(targetPath)) {
      log.warn("[integrations] Left a neolix or neox CLI this app did not install", { targetPath });
    }
  }
  return getCliInstallStatus();
}

async function isOwnInstall(targetPath: string): Promise<boolean> {
  const shimPath = getBundledCliShimPath();
  try {
    if (process.platform === "win32") {
      return (await fs.readFile(targetPath, "utf-8")) === buildCmdTrampoline(shimPath);
    }
    return (await fs.readlink(targetPath)) === resolveInstallSourcePath(shimPath);
  } catch {
    return false;
  }
}

export async function getCliInstallStatus(): Promise<InstallStatus> {
  const targetPath = getCliTargetPath();
  return { installed: await pathOrSymlinkExists(targetPath) };
}
