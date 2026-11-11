import { rename, writeFile } from "node:fs/promises";

/**
 * Commands the CLI hands to the desktop app (myna's cli/main.go runs the
 * same binary, so `myna tray|panel|autostart|update` are arguments to the
 * app). Neolix ships the desktop separately from `neolix`, so the CLI launches
 * it with these arguments; Electron's single-instance lock relays them when
 * an instance is already running. The app answers through a reply file the
 * CLI polls, which is how a detached launch can still print a result.
 */

/** Starts in the menu bar only; the login record's own argument. */
export { HIDDEN_ARG } from "./autostart.js";

/** Opens the quick panel instead of the main window. */
export const PANEL_ARG = "--panel";

const REPLY_ARG = "--neolix-cli-reply=";
const AUTOSTART_ARG = "--neolix-cli-autostart=";
const UPDATE_ARG = "--neolix-cli-update=";
const UPDATE_PROXY_ARG = "--neolix-cli-update-proxy=";
const UPDATE_MIRROR_ARG = "--neolix-cli-update-mirror=";
const UPDATE_RUN_MIRROR_ARG = "--neolix-cli-mirror=";
const UPDATE_CHANNEL_ARG = "--neolix-cli-update-channel=";
const UPDATE_AUTO_ARG = "--neolix-cli-update-auto=";

export type CliControlAction =
  | { kind: "autostart"; value: "on" | "off" | "status" }
  | { kind: "update"; check: boolean; proxy?: string; mirror?: string }
  /** A null prefix asks for the current mirror. */
  | { kind: "update-mirror"; prefix: string | null }
  /** A null channel asks for the current channel. */
  | { kind: "update-channel"; channel: "stable" | "beta" | null }
  /** No tokens asks for the current policy. */
  | { kind: "update-auto"; tokens: string[] };

export interface CliControlRequest {
  action: CliControlAction;
  replyPath: string;
}

export interface CliControlReply {
  ok: boolean;
  message: string;
  /** The updater owns the quit; the app must not exit before it installs. */
  keepRunning?: boolean;
}

interface ControlParseState {
  replyPath: string | null;
  action: CliControlAction | null;
  proxy?: string;
  mirror?: string;
}

interface ControlFlag {
  prefix: string;
  apply(raw: string, state: ControlParseState): void;
}

function autostartFlag(raw: string, state: ControlParseState): void {
  state.action =
    raw === "on" || raw === "off" || raw === "status" ? { kind: "autostart", value: raw } : null;
}

function updateFlag(raw: string, state: ControlParseState): void {
  state.action =
    raw === "check" || raw === "install" ? { kind: "update", check: raw === "check" } : null;
}

function mirrorFlag(raw: string, state: ControlParseState): void {
  state.action = { kind: "update-mirror", prefix: raw === "" ? null : raw };
}

function channelFlag(raw: string, state: ControlParseState): void {
  if (raw === "stable" || raw === "beta") {
    state.action = { kind: "update-channel", channel: raw };
  } else if (raw === "") {
    state.action = { kind: "update-channel", channel: null };
  } else {
    state.action = null;
  }
}

function autoFlag(raw: string, state: ControlParseState): void {
  const tokens = raw
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token !== "");
  state.action = { kind: "update-auto", tokens };
}

const CONTROL_FLAGS: readonly ControlFlag[] = [
  {
    prefix: REPLY_ARG,
    apply: (raw, state) => {
      state.replyPath = raw;
    },
  },
  { prefix: AUTOSTART_ARG, apply: autostartFlag },
  { prefix: UPDATE_ARG, apply: updateFlag },
  {
    prefix: UPDATE_PROXY_ARG,
    apply: (raw, state) => {
      state.proxy = raw;
    },
  },
  { prefix: UPDATE_MIRROR_ARG, apply: mirrorFlag },
  {
    prefix: UPDATE_RUN_MIRROR_ARG,
    apply: (raw, state) => {
      state.mirror = raw;
    },
  },
  { prefix: UPDATE_CHANNEL_ARG, apply: channelFlag },
  { prefix: UPDATE_AUTO_ARG, apply: autoFlag },
];

/** Reads the CLI's control flags; null when this launch is not one of them. */
export function parseCliControlRequest(argv: readonly string[]): CliControlRequest | null {
  const state: ControlParseState = { replyPath: null, action: null };
  for (const arg of argv) {
    const flag = CONTROL_FLAGS.find((candidate) => arg.startsWith(candidate.prefix));
    if (flag === undefined) {
      continue;
    }
    flag.apply(arg.slice(flag.prefix.length), state);
  }
  if (state.replyPath === null || state.action === null) {
    return null;
  }
  const { action } = state;
  if (action.kind === "update") {
    return {
      action: {
        ...action,
        ...(state.proxy === undefined ? {} : { proxy: state.proxy }),
        ...(state.mirror === undefined ? {} : { mirror: state.mirror }),
      },
      replyPath: state.replyPath,
    };
  }
  return { action, replyPath: state.replyPath };
}

export function hasPanelArg(argv: readonly string[]): boolean {
  return argv.includes(PANEL_ARG);
}

/** Writes the answer atomically so the CLI never reads a half-written file. */
export async function writeCliControlReply(
  replyPath: string,
  reply: CliControlReply,
): Promise<void> {
  const temporary = `${replyPath}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(reply), "utf8");
    await rename(temporary, replyPath);
  } catch {
    // The CLI may have gone; nothing else to do.
  }
}
