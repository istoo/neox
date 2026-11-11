import { promises as fs, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * myna's Omarchy bar widget (magpie/internal/omarchy/widget.go): Neolix's
 * icon in Omarchy's own bar, put in only when the user asks for it. Omarchy
 * keeps third-party widgets under ~/.config/omarchy/plugins/<id>/, then
 * reloads them with `omarchy-shell shell rescanPlugins` and enables them
 * with `omarchy plugin enable`.
 */
export const OMARCHY_WIDGET_ID = "istoo.neox";

export interface OmarchyWidgetOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  platform?: NodeJS.Platform;
  /** Runs a command; injectable so tests never touch the desktop. */
  run?: (file: string, args: readonly string[]) => Promise<void>;
}

const manifest = {
  schemaVersion: 1,
  id: OMARCHY_WIDGET_ID,
  name: "Neox",
  version: "1.0.0",
  author: "Neox",
  license: "Apache-2.0",
  description: "Neox's icon in the bar: a click opens Neox.",
  kinds: ["bar-widget"],
  entryPoints: { barWidget: "Widget.qml" },
  barWidget: {
    displayName: "Neox",
    description: "Open Neox from the bar.",
    category: "AI",
    aliases: ["neox"],
    allowMultiple: false,
    defaultSection: "right",
  },
};

function widgetQml(execPath: string): string {
  return `import QtQuick
import Quickshell
import qs.Commons
import qs.Ui

// Neolix's icon in Omarchy's bar, put there by Neolix (Settings → Omarchy).
// A click opens Neolix, starting it if it isn't running.
BarWidget {
  id: root
  moduleName: "${OMARCHY_WIDGET_ID}"

  // written in by Neolix when it puts the widget here
  readonly property string neox: ${JSON.stringify(execPath)}

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: String.fromCodePoint(0xf018d) // nf-md-console
    tooltipText: "Neox"
    onPressed: function() {
      Quickshell.execDetached([root.neox])
    }
  }
}
`;
}

function configHome(options: OmarchyWidgetOptions): string {
  const env = options.env ?? process.env;
  return env.XDG_CONFIG_HOME?.trim() || path.join(options.homeDir ?? os.homedir(), ".config");
}

export function omarchyWidgetDir(options: OmarchyWidgetOptions = {}): string {
  return path.join(configHome(options), "omarchy", "plugins", OMARCHY_WIDGET_ID);
}

/** Whether this machine runs Omarchy: the current theme is the reliable mark. */
export function isOmarchy(options: OmarchyWidgetOptions = {}): boolean {
  const env = options.env ?? process.env;
  const forced = env.NEOLIX_OMARCHY;
  if (forced === "1") return true;
  if (forced === "0") return false;
  if ((options.platform ?? process.platform) !== "linux") return false;
  const state =
    env.XDG_STATE_HOME?.trim() || path.join(options.homeDir ?? os.homedir(), ".local", "state");
  try {
    return statSync(path.join(state, "omarchy", "current", "theme", "colors.toml")).isFile();
  } catch {
    return false;
  }
}

export function isOmarchyWidgetInstalled(options: OmarchyWidgetOptions = {}): boolean {
  try {
    return statSync(path.join(omarchyWidgetDir(options), "manifest.json")).isFile();
  } catch {
    return false;
  }
}

async function defaultRun(file: string, args: readonly string[]): Promise<void> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  await promisify(execFile)(file, [...args], { timeout: 10_000 });
}

/**
 * Puts the widget in the bar (or brings it up to date), running execPath.
 * Enabling again is what has the shell reload files it already had.
 */
export async function addOmarchyWidget(
  execPath: string,
  options: OmarchyWidgetOptions = {},
): Promise<void> {
  const dir = omarchyWidgetDir(options);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await fs.writeFile(path.join(dir, "Widget.qml"), widgetQml(execPath));
  const run = options.run ?? defaultRun;
  await run("omarchy-shell", ["shell", "rescanPlugins"]);
  await run("omarchy", ["plugin", "disable", OMARCHY_WIDGET_ID]).catch(() => undefined);
  await run("omarchy", ["plugin", "enable", OMARCHY_WIDGET_ID]);
}

/** Takes it out of the bar again. */
export async function removeOmarchyWidget(options: OmarchyWidgetOptions = {}): Promise<void> {
  const run = options.run ?? defaultRun;
  await run("omarchy", ["plugin", "disable", OMARCHY_WIDGET_ID]).catch(() => undefined);
  await fs.rm(omarchyWidgetDir(options), { recursive: true, force: true });
  await run("omarchy-shell", ["shell", "rescanPlugins"]);
}
