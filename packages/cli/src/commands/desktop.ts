import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Command } from "commander";
import { launchDesktop, findDesktopApp } from "./open.js";

/**
 * myna's `tray`, `panel`, `autostart` and `update` (internal/cli/main.go:46-49,
 * 162-171) run in the app's own binary. Neolix's CLI launches the desktop app
 * with control arguments instead; Electron's single-instance lock relays them
 * to a running instance, and the app answers through a reply file so a
 * detached launch can still print its result.
 */

/** The desktop's own login-launch argument (system/autostart.ts HIDDEN_ARG). */
export const DESKTOP_HIDDEN_ARG = "--hidden";
/** The desktop's quick-panel argument (system/cli-control.ts PANEL_ARG). */
export const DESKTOP_PANEL_ARG = "--panel";

export interface CliControlReply {
  ok: boolean;
  message: string;
}

export interface ReplyReaderDeps {
  readFile(filePath: string, encoding: "utf8"): Promise<string>;
  now(): number;
  sleep(ms: number): Promise<void>;
}

const REPLY_POLL_MS = 100;
const DEFAULT_REPLY_TIMEOUT_MS = 30_000;
const UPDATE_CHECK_TIMEOUT_MS = 120_000;
const UPDATE_INSTALL_TIMEOUT_MS = 10 * 60_000;

function runsDesktop(): void {
  if (process.env.NEOLIX_DESKTOP_CLI === "1") {
    throw new Error("Cannot open Neox Desktop while running in desktop CLI passthrough mode.");
  }
}

/** `neolix` with no command: the app's window (myna cli/main.go:46). */
export function runAppLaunch(): void {
  runsDesktop();
  launchDesktop([]);
}

/**
 * Whether this login can open the desktop app: a headless server (SSH, or
 * Linux with no DISPLAY/WAYLAND_DISPLAY) has no window to open, and a machine
 * without the app has nothing to open. Both keep `neolix` on onboarding.
 */
export function hasGraphicalSession(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (env.SSH_CONNECTION !== undefined || env.SSH_TTY !== undefined) {
    return false;
  }
  if (platform === "linux") {
    return Boolean(env.DISPLAY?.trim() || env.WAYLAND_DISPLAY?.trim());
  }
  return true;
}

export function shouldOpenDesktopApp(
  options: {
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    installed?: boolean;
  } = {},
): boolean {
  const env = options.env ?? process.env;
  // Test seam, and a way for a script to keep the terminal path on a desktop.
  if (env.NEOLIX_NO_DESKTOP === "1") {
    return false;
  }
  const installed = options.installed ?? findDesktopApp() !== null;
  return installed && hasGraphicalSession(env, options.platform ?? process.platform);
}

export function createTrayCommand(): Command {
  return new Command("tray").description("Start Neox in the tray only (no window)").action(() => {
    runsDesktop();
    launchDesktop([DESKTOP_HIDDEN_ARG]);
  });
}

export function createPanelCommand(): Command {
  return new Command("panel")
    .description("Open Neox's quick panel, or close it if it is open")
    .action(() => {
      runsDesktop();
      launchDesktop([DESKTOP_PANEL_ARG]);
    });
}

/** Reads the app's answer; null when the timeout passes without one. */
export async function waitForDesktopReply(
  replyPath: string,
  timeoutMs: number,
  deps: ReplyReaderDeps = {
    readFile: fs.readFile,
    now: Date.now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  },
): Promise<CliControlReply | null> {
  const deadline = deps.now() + timeoutMs;
  while (deps.now() < deadline) {
    const text = await deps.readFile(replyPath, "utf8").catch(() => null);
    if (text !== null) {
      try {
        const parsed = JSON.parse(text) as { ok?: unknown; message?: unknown };
        if (typeof parsed.ok === "boolean") {
          return {
            ok: parsed.ok,
            message: typeof parsed.message === "string" ? parsed.message : "",
          };
        }
      } catch {
        // Mid-write; the app renames into place, so this is transient.
      }
    }
    await deps.sleep(REPLY_POLL_MS);
  }
  return null;
}

async function sendDesktopControl(
  args: string[],
  timeoutMs: number,
): Promise<CliControlReply | null> {
  runsDesktop();
  const replyPath = path.join(tmpdir(), `neolix-cli-${randomUUID()}.json`);
  launchDesktop([...args, `--neolix-cli-reply=${replyPath}`]);
  try {
    return await waitForDesktopReply(replyPath, timeoutMs);
  } finally {
    await fs.rm(replyPath, { force: true });
    await fs.rm(`${replyPath}.tmp`, { force: true });
  }
}

function reportReply(reply: CliControlReply | null, missingMessage: string): void {
  if (reply === null) {
    process.stderr.write(`${missingMessage}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${reply.message}\n`);
  if (!reply.ok) {
    process.exitCode = 1;
  }
}

export function buildAutostartArgs(value: "on" | "off" | "status"): string[] {
  return [`--neolix-cli-autostart=${value}`];
}

export function buildUpdateArgs(input: {
  check: boolean;
  proxy?: string;
  mirror?: string;
}): string[] {
  // myna's `--mirror off` means "this run goes to GitHub", not a URL.
  const mirror = input.mirror === "off" || input.mirror === "none" ? undefined : input.mirror;
  return [
    `--neolix-cli-update=${input.check ? "check" : "install"}`,
    ...(input.proxy === undefined ? [] : [`--neolix-cli-update-proxy=${input.proxy}`]),
    ...(mirror === undefined ? [] : [`--neolix-cli-mirror=${mirror}`]),
  ];
}

export function buildUpdateMirrorArgs(prefix: string): string[] {
  return [`--neolix-cli-update-mirror=${prefix}`];
}

export function buildUpdateChannelArgs(channel: "stable" | "beta" | ""): string[] {
  return [`--neolix-cli-update-channel=${channel}`];
}

export function buildUpdateAutoArgs(tokens: readonly string[]): string[] {
  return [`--neolix-cli-update-auto=${tokens.join(",")}`];
}

export function createAutostartCommand(): Command {
  return new Command("autostart")
    .description("Open Neox at login, in the tray, or say whether it does")
    .argument("[state]", "on or off; with none, prints the current state")
    .action(async (state?: string) => {
      if (state !== undefined && state !== "on" && state !== "off") {
        throw new Error("usage: neox autostart [on|off]");
      }
      const reply = await sendDesktopControl(
        buildAutostartArgs(state ?? "status"),
        DEFAULT_REPLY_TIMEOUT_MS,
      );
      reportReply(reply, "Neox did not answer; is the desktop app installed?");
    });
}

function validateUpdateAutoToken(token: string): void {
  if (["on", "off", "download", "notify", "30m", "1h", "6h", "24h"].includes(token)) {
    return;
  }
  throw new Error(
    `neox update auto takes on, off, download, notify or how often (30m, 1h, 6h or 24h), not "${token}"`,
  );
}

export function createUpdateCommand(): Command {
  const update = new Command("update")
    .description("Install the newest Neox release, or check whether there is one")
    .argument("[mode]", "check: only say whether a newer version is out")
    .option("--proxy <url>", "an http(s):// or socks5:// proxy for this check")
    .option("--mirror <prefix>", "a GitHub download mirror for this check")
    .action(async (mode: string | undefined, options: { proxy?: string; mirror?: string }) => {
      if (mode !== undefined && mode !== "check") {
        throw new Error("usage: neox update [check] [--proxy <url>] [--mirror <prefix>]");
      }
      const check = mode === "check";
      const reply = await sendDesktopControl(
        buildUpdateArgs({ check, ...options }),
        check ? UPDATE_CHECK_TIMEOUT_MS : UPDATE_INSTALL_TIMEOUT_MS,
      );
      if (!check && reply === null) {
        process.stdout.write("Neox is updating; it may already have restarted.\n");
        return;
      }
      reportReply(reply, "Neox did not answer; is the desktop app installed?");
    });

  update
    .command("mirror")
    .description("The GitHub mirror every update is downloaded through")
    .argument("[prefix]", "a URL prefix, off, or none; with none, prints the current mirror")
    .action(async (prefix?: string) => {
      const reply = await sendDesktopControl(
        buildUpdateMirrorArgs(prefix?.trim() ?? ""),
        DEFAULT_REPLY_TIMEOUT_MS,
      );
      reportReply(reply, "Neox did not answer; is the desktop app installed?");
    });

  update
    .command("channel")
    .description("Which versions updates offer")
    .argument("[channel]", "stable or beta; with none, prints the current channel")
    .action(async (channel?: string) => {
      if (channel !== undefined && channel !== "stable" && channel !== "beta") {
        throw new Error("usage: neox update channel [stable|beta]");
      }
      const reply = await sendDesktopControl(
        buildUpdateChannelArgs(channel ?? ""),
        DEFAULT_REPLY_TIMEOUT_MS,
      );
      reportReply(reply, "Neox did not answer; is the desktop app installed?");
    });

  update
    .command("auto")
    .description("Whether Neox looks for updates by itself, how often, and what it does")
    .argument("[settings...]", "on|off, download|notify, 30m|1h|6h|24h")
    .action(async (settings: string[] | undefined) => {
      const tokens = (settings ?? []).map((token) => token.toLowerCase());
      tokens.forEach(validateUpdateAutoToken);
      const reply = await sendDesktopControl(buildUpdateAutoArgs(tokens), DEFAULT_REPLY_TIMEOUT_MS);
      reportReply(reply, "Neox did not answer; is the desktop app installed?");
    });

  return update;
}
