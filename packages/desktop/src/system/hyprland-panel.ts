import { connect } from "node:net";
import path from "node:path";

/**
 * myna's omarchy/hypr.go: a Wayland window cannot place itself, so a tray
 * panel asks Hyprland for a window rule under the clicked icon, and closes
 * on a click outside it. Omarchy follows the mouse for focus, so losing it
 * can't say "clicked outside" — a non-consuming left-click bind announces
 * every click instead.
 */
export const PANEL_GAP = 6;

export interface HyprMonitor {
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
  transform: number;
  /** left, top, right, bottom */
  reserved: [number, number, number, number];
}

/** The monitor's size in layout coordinates, the ones windows are placed in. */
export function monitorSize(monitor: HyprMonitor): { width: number; height: number } {
  const scale = monitor.scale > 0 ? monitor.scale : 1;
  let width = Math.round(monitor.width / scale);
  let height = Math.round(monitor.height / scale);
  if (monitor.transform % 2 === 1) {
    [width, height] = [height, width];
  }
  return { width, height };
}

export interface PanelPlacement {
  monitor: string;
  x: number;
  y: number;
  maxHeight: number;
}

/** Under the bar, its middle at the cursor, kept inside the monitor it clicks on. */
export function panelAt(
  width: number,
  cursorX: number,
  cursorY: number,
  monitors: readonly HyprMonitor[],
): PanelPlacement | null {
  for (const monitor of monitors) {
    const size = monitorSize(monitor);
    if (
      cursorX < monitor.x ||
      cursorX >= monitor.x + size.width ||
      cursorY < monitor.y ||
      cursorY >= monitor.y + size.height
    ) {
      continue;
    }
    const left = monitor.reserved[0] + PANEL_GAP;
    const right = size.width - monitor.reserved[2] - PANEL_GAP;
    const x = Math.max(left, Math.min(right - width, cursorX - monitor.x - Math.round(width / 2)));
    const y = monitor.reserved[1] + PANEL_GAP;
    return {
      monitor: monitor.name,
      x,
      y,
      maxHeight: size.height - monitor.reserved[3] - PANEL_GAP - y,
    };
  }
  return null;
}

/** A click is outside when it is off the panel and not on the bar above it. */
export function isClickOutside(
  cursor: { x: number; y: number },
  panel: { at: [number, number]; size: [number, number] },
): boolean {
  const [x, y] = [cursor.x, cursor.y];
  const [atX, atY] = panel.at;
  const [width, height] = panel.size;
  if (y < atY - PANEL_GAP) {
    return false;
  }
  return x < atX || x >= atX + width || y < atY || y >= atY + height;
}

export type HyprRunner = (args: readonly string[]) => Promise<string>;

export function isHyprland(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean {
  return platform === "linux" && Boolean(env.HYPRLAND_INSTANCE_SIGNATURE);
}

interface HyprClient {
  title?: string;
  at?: [number, number];
  size?: [number, number];
}

async function hyprJson<T>(run: HyprRunner, query: string): Promise<T | null> {
  try {
    return JSON.parse(await run(["-j", query])) as T;
  } catch {
    return null;
  }
}

/** Where a panel width wide goes, from Hyprland's cursor and monitors. */
export async function currentPanelPlacement(
  width: number,
  run: HyprRunner,
): Promise<PanelPlacement | null> {
  const cursor = await hyprJson<{ x?: number; y?: number }>(run, "cursorpos");
  if (!cursor || typeof cursor.x !== "number" || typeof cursor.y !== "number") {
    return null;
  }
  const monitors = await hyprJson<HyprMonitor[]>(run, "monitors");
  if (!monitors) {
    return null;
  }
  return panelAt(width, cursor.x, cursor.y, monitors);
}

function regexpQuote(value: string): string {
  let out = "";
  for (const character of value) {
    if (!/[A-Za-z0-9 _-]/.test(character)) {
      out += "\\";
    }
    out += character;
  }
  return out;
}

/** Pins the titled window to the monitor under the click, at x,y from its corner. */
export async function placePanelWindow(
  run: HyprRunner,
  title: string,
  placement: PanelPlacement,
): Promise<void> {
  const monitor = placement.monitor === "" ? "" : `monitor = "${placement.monitor}", `;
  const rule =
    `hl.window_rule({ name = "neolix-panel", match = { title = "${regexpQuote(`^${title}$`)}" }, ` +
    `tag = "-default-opacity", float = true, pin = true, border_size = 0, no_shadow = true, ` +
    `opacity = "1 1", no_anim = true, ${monitor}move = { ${placement.x}, ${placement.y} } })`;
  await run(["eval", rule]).catch(() => undefined);
}

/** Whether the pointer is off the panel (and not on the bar), after a click. */
export async function clickedOutside(run: HyprRunner, title: string): Promise<boolean> {
  const cursor = await hyprJson<{ x?: number; y?: number }>(run, "cursorpos");
  const clients = await hyprJson<HyprClient[]>(run, "clients");
  if (!cursor || typeof cursor.x !== "number" || typeof cursor.y !== "number" || !clients) {
    return false;
  }
  const panel = clients.find((client) => client.title === title);
  if (!panel?.at || !panel.size) {
    return false;
  }
  return isClickOutside({ x: cursor.x, y: cursor.y }, { at: panel.at, size: panel.size });
}

/** Has Hyprland announce every left click, letting it through. */
export async function reportClicks(run: HyprRunner): Promise<void> {
  await run([
    "eval",
    `if neolix_panel_click then neolix_panel_click:remove() end neolix_panel_click = hl.bind("mouse:272", function() hl.dispatch(hl.dsp.event("neolix-panel-click")) end, { non_consuming = true })`,
  ]).catch(() => undefined);
}

/**
 * Hyprland keeps a bind registered after the process that made it dies, so a
 * crash leaves the non-consuming click bind behind. Startup removes it before
 * this run installs its own; a Hyprland without `unbind` just ignores the eval.
 */
export async function clearPanelClicks(run: HyprRunner): Promise<void> {
  await run(["eval", `if hl.unbind then hl.unbind("mouse:272") end`]).catch(() => undefined);
}

/** Takes the bind away again. */
export async function stopReportingClicks(run: HyprRunner): Promise<void> {
  await run([
    "eval",
    `if neolix_panel_click then neolix_panel_click:remove() neolix_panel_click = nil end`,
  ]).catch(() => undefined);
}

/**
 * Calls onClick for each announced click, following Hyprland's event socket
 * and reconnecting when Hyprland restarts. Returns a stop function.
 */
export function watchClicks(env: NodeJS.ProcessEnv, onClick: () => void): () => void {
  const runtimeDir = env.XDG_RUNTIME_DIR ?? "/run/user/0";
  const signature = env.HYPRLAND_INSTANCE_SIGNATURE ?? "";
  const socketPath = path.join(runtimeDir, "hypr", signature, ".socket2.sock");
  let stopped = false;
  let socket: ReturnType<typeof connect> | null = null;
  let reconnect: ReturnType<typeof setTimeout> | null = null;

  const open = (): void => {
    if (stopped) return;
    socket = connect(socketPath);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line === "custom>>neolix-panel-click") {
          onClick();
        }
        index = buffer.indexOf("\n");
      }
    });
    socket.on("error", () => undefined);
    socket.on("close", () => {
      socket = null;
      if (!stopped) {
        reconnect = setTimeout(open, 2_000);
      }
    });
  };
  open();

  return () => {
    stopped = true;
    if (reconnect) clearTimeout(reconnect);
    socket?.destroy();
    socket = null;
  };
}
