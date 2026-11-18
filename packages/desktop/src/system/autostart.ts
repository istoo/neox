import path from "node:path";

/**
 * myna's autostart (magpie/internal/autostart/autostart.go:41): whether the
 * app opens at login is the system's own record, not ours — so the setting
 * mirrors it instead of the other way round. At login the app opens in the
 * tray with no window ({@link HIDDEN_ARG}), because the daemon every agent
 * talks to has to be there from the start.
 */
export const HIDDEN_ARG = "--hidden";

// Existing installs already have this entry; a new name would read as "off" and add a second one.
export const LINUX_AUTOSTART_FILENAME = "neolix.desktop";

export type AutostartState = "off" | "on" | "allow";

export interface LoginItemSettings {
  openAtLogin: boolean;
  /** macOS: "not-registered" | "enabled" | "requires-approval" | "not-found". */
  status?: string;
  /** Windows: whether the registered command points at this executable. */
  executableWillLaunchAtLogin?: boolean;
}

export interface AutostartFileSystem {
  readFile(filePath: string, encoding: "utf8"): Promise<string>;
  writeFile(filePath: string, data: string, encoding: "utf8"): Promise<void>;
  mkdir(dirPath: string, options: { recursive: true }): Promise<unknown>;
  rm(filePath: string, options: { force: true }): Promise<void>;
}

export interface AutostartHost {
  platform: NodeJS.Platform;
  execPath: string;
  env: NodeJS.ProcessEnv;
  fs: AutostartFileSystem;
  getLoginItemSettings(): LoginItemSettings;
  setLoginItemSettings(settings: {
    openAtLogin: boolean;
    openAsHidden?: boolean;
    args?: string[];
    path?: string;
  }): void;
}

/** `$XDG_CONFIG_HOME/autostart`, as the XDG spec and every desktop read it. */
export function linuxAutostartPath(env: NodeJS.ProcessEnv): string {
  const home = env.HOME ?? "";
  const configHome = env.XDG_CONFIG_HOME?.trim() || path.posix.join(home, ".config");
  return path.posix.join(configHome, "autostart", LINUX_AUTOSTART_FILENAME);
}

/** Quotes one Exec argument the way the Desktop Entry spec asks. */
function execWord(word: string): string {
  const escaped = word
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/`/g, "\\`")
    .replace(/\$/g, "\\$")
    .replace(/%/g, "%%");
  return `"${escaped}"`;
}

export function linuxDesktopEntry(execPath: string): string {
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Name=Neox",
    "Comment=Your development environment, in your pocket",
    `Exec=${execWord(execPath)} ${HIDDEN_ARG}`,
    "Terminal=false",
    "X-GNOME-Autostart-enabled=true",
    "",
  ].join("\n");
}

function readEntryValue(entry: string, key: string): string | null {
  for (const line of entry.split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator < 0) {
      continue;
    }
    if (line.slice(0, separator).trim() === key) {
      return line.slice(separator + 1).trim();
    }
  }
  return null;
}

/** The executable a Linux entry's Exec line starts, unquoted. */
export function execPathFromEntry(entry: string): string | null {
  const exec = readEntryValue(entry, "Exec");
  if (!exec) {
    return null;
  }
  if (exec.startsWith('"')) {
    let value = "";
    for (let index = 1; index < exec.length; index += 1) {
      const char = exec[index];
      if (char === "\\" && index + 1 < exec.length) {
        const next = exec[index + 1];
        value += next === "%" ? "%" : next;
        index += 1;
        continue;
      }
      if (char === '"') {
        return value || null;
      }
      value += char;
    }
    return null;
  }
  const [word = ""] = exec.split(/\s+/);
  return word || null;
}

/** Rewrites only the Exec line, so a Hidden=true the user chose stays. */
export function replaceExecLine(entry: string, execPath: string): string {
  const line = `Exec=${execWord(execPath)} ${HIDDEN_ARG}`;
  const lines = entry.split(/\r?\n/);
  let replaced = false;
  const next = lines.map((current) => {
    if (!replaced && current.startsWith("Exec=")) {
      replaced = true;
      return line;
    }
    return current;
  });
  if (!replaced) {
    next.splice(Math.max(0, next.length - 1), 0, line);
  }
  return next.join("\n");
}

async function readLinuxEntry(host: AutostartHost): Promise<string | null> {
  try {
    return await host.fs.readFile(linuxAutostartPath(host.env), "utf8");
  } catch {
    return null;
  }
}

/** Whether the system says the app opens at login. */
export async function getAutostartState(host: AutostartHost): Promise<AutostartState> {
  if (host.platform === "linux") {
    const entry = await readLinuxEntry(host);
    if (entry === null) {
      return "off";
    }
    if (readEntryValue(entry, "Hidden") === "true") {
      return "off";
    }
    if (readEntryValue(entry, "X-GNOME-Autostart-enabled") === "false") {
      return "off";
    }
    return "on";
  }

  const settings = host.getLoginItemSettings();
  if (!settings.openAtLogin) {
    return "off";
  }
  // macOS: the login item exists but the user switched it off under
  // System Settings › General › Login Items, where it must be allowed again.
  if (settings.status === "requires-approval") {
    return "allow";
  }
  return "on";
}

/**
 * Turns opening at login on or off. Hidden start means no window: the tray
 * alone, as myna's `tray` argument does.
 */
export async function setAutostart(host: AutostartHost, enabled: boolean): Promise<void> {
  if (host.platform === "linux") {
    const filePath = linuxAutostartPath(host.env);
    if (!enabled) {
      await host.fs.rm(filePath, { force: true });
      return;
    }
    await host.fs.mkdir(path.posix.dirname(filePath), { recursive: true });
    await host.fs.writeFile(filePath, linuxDesktopEntry(host.execPath), "utf8");
    return;
  }

  if (host.platform === "darwin") {
    host.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: enabled });
    return;
  }

  if (host.platform === "win32") {
    host.setLoginItemSettings(
      enabled ? { openAtLogin: true, args: [HIDDEN_ARG] } : { openAtLogin: false },
    );
  }
}

/**
 * Brings the system's record up to date after the executable moved, without
 * changing whether it is on. A record the user disabled stays disabled.
 */
export async function refreshAutostart(host: AutostartHost): Promise<void> {
  if (host.platform === "linux") {
    const entry = await readLinuxEntry(host);
    if (entry === null) {
      return;
    }
    const registered = execPathFromEntry(entry);
    if (
      registered !== null &&
      path.posix.resolve(registered) === path.posix.resolve(host.execPath)
    ) {
      return;
    }
    await host.fs.writeFile(
      linuxAutostartPath(host.env),
      replaceExecLine(entry, host.execPath),
      "utf8",
    );
    return;
  }

  if (host.platform === "win32") {
    const settings = host.getLoginItemSettings();
    if (settings.openAtLogin && settings.executableWillLaunchAtLogin === false) {
      host.setLoginItemSettings({
        openAtLogin: true,
        path: host.execPath,
        args: [HIDDEN_ARG],
      });
    }
  }
}

/** Whether this launch is the login one, which shows the tray only. */
export function launchedHidden(input: {
  platform: NodeJS.Platform;
  argv: readonly string[];
  loginItem: LoginItemSettings & { wasOpenedAsHidden?: boolean; wasOpenedAtLogin?: boolean };
}): boolean {
  if (input.argv.includes(HIDDEN_ARG)) {
    return true;
  }
  if (input.platform === "darwin") {
    return input.loginItem.wasOpenedAsHidden === true && input.loginItem.wasOpenedAtLogin === true;
  }
  return false;
}
