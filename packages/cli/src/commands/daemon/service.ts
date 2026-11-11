import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Installing `neolix daemon` as a service of the user's, myna's
 * internal/daemon: a launch agent on macOS (launchd.go) and a systemd
 * --user unit on Linux (systemd.go). Windows has none, as myna has none
 * (daemon.go:66-75): the desktop app's autostart is that machine's way.
 *
 * Everything here builds the file and the commands; only the CLI command
 * runs them, when the user asked for it.
 */

// Installed-service identifiers. Neox has not shipped yet, so there are no
// pre-rename services on disk to stay compatible with.
export const SERVICE_LABEL = "com.neolix.serve";
export const SERVICE_NAME = "neolix";

export interface ServiceSpec {
  platform: NodeJS.Platform;
  home: string;
  /** XDG_CONFIG_HOME, for the systemd unit. */
  xdgConfigHome?: string;
  /** The program the service runs, and its arguments. */
  exe: string;
  args: string[];
  /** `KEY=value` pairs written into the service. */
  env: string[];
}

export interface ServicePlan {
  file: string;
  contents: string;
  /** Commands to run after the file is written, each as argv. */
  commands: string[][];
  logs: string;
}

export function unsupportedService(platform: NodeJS.Platform): Error {
  return new Error(
    platform === "win32"
      ? "no service installer on Windows: open Neox at login, with its daemon (the desktop app's launch at login), or run `neox daemon install` inside WSL"
      : `no service installer on ${platform}: run \`neox daemon run\` under the system's own service manager`,
  );
}

export function launchAgentFile(home: string): string {
  return path.join(home, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
}

export function launchAgentLog(home: string): string {
  return path.join(home, "Library", "Logs", SERVICE_NAME, "serve.log");
}

export function systemdUnitFile(spec: Pick<ServiceSpec, "home" | "xdgConfigHome">): string {
  const dir = spec.xdgConfigHome ?? path.join(spec.home, ".config");
  return path.join(dir, "systemd", "user", `${SERVICE_NAME}.service`);
}

function xml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** myna's plist (launchd.go:34-66), with this program's label. */
export function launchAgentPlist(spec: ServiceSpec): string {
  const s = (value: string): string => `<string>${xml(value)}</string>`;
  const args = [spec.exe, ...spec.args].map(s).join("");
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    "<!-- Written by neox daemon install; neox daemon uninstall removes it. -->",
    '<plist version="1.0">',
    "<dict>",
    `\t<key>Label</key>${s(SERVICE_LABEL)}`,
    `\t<key>ProgramArguments</key><array>${args}</array>`,
    "\t<key>RunAtLoad</key><true/>",
    "\t<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>",
    "\t<key>ThrottleInterval</key><integer>5</integer>",
    "\t<key>ProcessType</key><string>Background</string>",
    `\t<key>StandardOutPath</key>${s(launchAgentLog(spec.home))}`,
    `\t<key>StandardErrorPath</key>${s(launchAgentLog(spec.home))}`,
  ];
  if (spec.env.length > 0) {
    lines.push("\t<key>EnvironmentVariables</key>", "\t<dict>");
    for (const pair of spec.env) {
      const at = pair.indexOf("=");
      lines.push(`\t\t<key>${xml(pair.slice(0, at))}</key>${s(pair.slice(at + 1))}`);
    }
    lines.push("\t</dict>");
  }
  lines.push("</dict>", "</plist>", "");
  return lines.join("\n");
}

/** myna's unitQuote (systemd.go:49-53). */
export function unitQuote(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/%/g, "%%")
    .replace(/\n/g, " ");
  return `"${escaped}"`;
}

/** myna's unitText (systemd.go:31-47). */
export function systemdUnit(spec: ServiceSpec): string {
  const lines = [
    "# Written by `neox daemon install`; `neox daemon uninstall` removes it.",
    "[Unit]",
    "Description=Neox daemon",
    "Wants=network-online.target",
    "After=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${[spec.exe, ...spec.args].map(unitQuote).join(" ")}`,
    "Restart=on-failure",
    "RestartSec=5",
  ];
  for (const pair of spec.env) {
    lines.push(`Environment=${unitQuote(pair)}`);
  }
  lines.push("", "[Install]", "WantedBy=default.target", "");
  return lines.join("\n");
}

/** What `neolix daemon install` writes and runs, per platform. */
export function installPlan(spec: ServiceSpec): ServicePlan {
  if (spec.platform === "darwin") {
    const uid = typeof process.getuid === "function" ? process.getuid() : 501;
    const domain = `gui/${uid}`;
    return {
      file: launchAgentFile(spec.home),
      contents: launchAgentPlist(spec),
      commands: [
        ["launchctl", "bootout", `${domain}/${SERVICE_LABEL}`],
        ["launchctl", "bootstrap", domain, launchAgentFile(spec.home)],
      ],
      logs: `tail -f ${JSON.stringify(launchAgentLog(spec.home))}`,
    };
  }
  if (spec.platform === "linux") {
    return {
      file: systemdUnitFile(spec),
      contents: systemdUnit(spec),
      commands: [
        ["systemctl", "--user", "daemon-reload"],
        ["systemctl", "--user", "enable", `${SERVICE_NAME}.service`],
        ["systemctl", "--user", "restart", `${SERVICE_NAME}.service`],
      ],
      logs: `journalctl --user -u ${SERVICE_NAME} -f`,
    };
  }
  throw unsupportedService(spec.platform);
}

/** What `neolix daemon uninstall` runs and removes. */
export function uninstallPlan(spec: ServiceSpec): { file: string; commands: string[][] } {
  if (spec.platform === "darwin") {
    const uid = typeof process.getuid === "function" ? process.getuid() : 501;
    return {
      file: launchAgentFile(spec.home),
      commands: [["launchctl", "bootout", `gui/${uid}/${SERVICE_LABEL}`]],
    };
  }
  if (spec.platform === "linux") {
    return {
      file: systemdUnitFile(spec),
      commands: [
        ["systemctl", "--user", "disable", "--now", `${SERVICE_NAME}.service`],
        ["systemctl", "--user", "daemon-reload"],
      ],
    };
  }
  throw unsupportedService(spec.platform);
}

/** What `neolix daemon status` asks the system, and how it reads it. */
export function statusCommands(platform: NodeJS.Platform): string[][] {
  if (platform === "darwin") {
    const uid = typeof process.getuid === "function" ? process.getuid() : 501;
    return [["launchctl", "print", `gui/${uid}/${SERVICE_LABEL}`]];
  }
  if (platform === "linux") {
    return [
      [
        "systemctl",
        "--user",
        "show",
        `${SERVICE_NAME}.service`,
        "--property=ActiveState,SubState,MainPID,UnitFileState",
      ],
    ];
  }
  return [];
}

/** The service file's own path on this platform, installed or not. */
export function serviceFile(
  spec: Pick<ServiceSpec, "platform" | "home" | "xdgConfigHome">,
): string {
  if (spec.platform === "darwin") return launchAgentFile(spec.home);
  if (spec.platform === "linux") return systemdUnitFile(spec);
  throw unsupportedService(spec.platform);
}

export function serviceInstalled(
  spec: Pick<ServiceSpec, "platform" | "home" | "xdgConfigHome">,
): boolean {
  try {
    statSync(serviceFile(spec));
    return true;
  } catch {
    return false;
  }
}

/** Writes the service file, 0600 as myna writes its private file. */
export function writeServiceFile(plan: ServicePlan, home: string): void {
  if (plan.file.startsWith(path.join(home, "Library"))) {
    mkdirSync(path.dirname(launchAgentLog(home)), { recursive: true, mode: 0o700 });
    // launchd opens StandardOutPath itself with the user's umask; made here
    // first, it writes into a 0600 file (myna #4133).
    writeFileSync(launchAgentLog(home), "", { flag: "a", mode: 0o600 });
  }
  mkdirSync(path.dirname(plan.file), { recursive: true });
  writeFileSync(plan.file, plan.contents, { mode: 0o600 });
  chmodSync(plan.file, 0o600);
}

export function removeServiceFile(file: string): void {
  rmSync(file, { force: true });
}

/** The daemon.log a service writes, when it is the daemon's own. */
export function readServiceFile(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}
