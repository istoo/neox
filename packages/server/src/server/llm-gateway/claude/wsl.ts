import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  findWslTool,
  windowsToWslPath,
  type WslrunDeps,
  type WslTool,
} from "../../wslrun/wslrun.js";
import type { ClaudeLaunch } from "./cli.js";
import { claudeProjectName } from "./sessions.js";

export interface ClaudeWslLaunchDeps extends WslrunDeps {
  /** Finds Claude Code's command in a running distro, injectable. */
  find?: typeof findWslTool;
}

/**
 * A run of a Claude Code installed only in a WSL distro: `wsl.exe` starts
 * it (myna's wslrun.Command), the folder and the config folder are spelt
 * as the distro spells them, and Claude Code's variables are handed to it
 * through WSLENV, which Windows' environment does not cross otherwise.
 */
export async function claudeWslLaunch(
  launch: ClaudeLaunch,
  deps: ClaudeWslLaunchDeps = {},
): Promise<ClaudeLaunch> {
  const tool = await (deps.find ?? findWslTool)("claude", deps);
  if (tool === null) {
    return launch;
  }
  const cwd = windowsToWslPath(launch.cwd);
  const configDir =
    launch.env.CLAUDE_CONFIG_DIR === undefined || launch.env.CLAUDE_CONFIG_DIR === ""
      ? path.posix.join(tool.home, ".claude")
      : windowsToWslPath(launch.env.CLAUDE_CONFIG_DIR);
  const env: Record<string, string> = { ...launch.env, CLAUDE_CONFIG_DIR: configDir };
  if (env.BUN_OPTIONS !== undefined) {
    env.BUN_OPTIONS = wslBunOptions(env.BUN_OPTIONS);
  }
  env.WSLENV = wslEnv(env.WSLENV, [
    "CLAUDE_CONFIG_DIR",
    "NEOLIX_CLAUDE_TAP",
    "BUN_OPTIONS",
    "NEOLIX_CLAUDE_GUARD",
    "TERM",
  ]);
  // Claude Code writes its sessions in the distro's own folder; Windows
  // reads and writes them through the distro's share, as myna does, so a
  // replayed or cut transcript is made where Claude Code will find it.
  const projects = wslUncPath(tool.distro, path.posix.join(configDir, "projects"));
  return {
    ...launch,
    binary: "wsl.exe",
    args: ["-d", tool.distro, "--exec", tool.path, ...launch.args],
    cwd,
    env,
    sessionDirs: [path.win32.join(projects, claudeProjectName(cwd))],
    wsl: { distro: tool.distro, home: tool.home, projects },
  };
}

/** A distro's folder as Windows reads it: \\wsl.localhost\<distro>\home\me\… */
export function wslUncPath(distro: string, wslPath: string): string {
  return `\\\\wsl.localhost\\${distro}${wslPath.replaceAll("/", "\\")}`;
}

/** The tap's preload path as the distro spells it. */
function wslBunOptions(options: string): string {
  return options.replace(/(--preload\s+)(\S+)/, (_match, flag: string, file: string) => {
    return `${flag}${windowsToWslPath(file)}`;
  });
}

/** WSLENV, adding names Windows' environment must cross, paths marked /p. */
function wslEnv(current: string | undefined, names: readonly string[]): string {
  const parts = (current ?? "").split(":").filter((part) => part !== "");
  const known = new Set(parts.map((part) => part.split("/")[0]));
  for (const name of names) {
    if (known.has(name)) {
      continue;
    }
    parts.push(name === "CLAUDE_CONFIG_DIR" || name === "NEOLIX_CLAUDE_TAP" ? `${name}/p` : name);
  }
  return parts.join(":");
}

/**
 * The shell that reads a session's transcript inside its distro, where
 * Windows can't: $1 is the session id. It prints "ready" once it knows
 * how much of a resumed session's file is there, then what is written
 * after, until its standard input ends.
 */
export const WSL_TRANSCRIPT_SCRIPT = `d="$HOME/.claude/projects"; s="$1"; n=0
for f in "$d"/*/"$s".jsonl; do [ -f "$f" ] && n=$(wc -c <"$f"); done
echo ready
( while :; do for f in "$d"/*/"$s".jsonl; do [ -f "$f" ] && exec tail -c +$((n+1)) -F "$f" 2>/dev/null; done; sleep 0.1; done ) &
cat >/dev/null; kill $! 2>/dev/null`;

const SESSION_ID = /^[0-9A-Za-z-]+$/;

export interface WslTranscript {
  /** The file of this machine's the distro's writes are copied to. */
  path: string;
  /** Resolves once the distro is reading; rejects when it can't. */
  ready: Promise<void>;
  /** Waits, once Claude Code ended, for the last of what it wrote. */
  settle(): Promise<void>;
  stop(): Promise<void>;
}

export interface StartWslTranscriptInput {
  distro: string;
  sid: string;
  /** A folder of this machine's for the copy; a temporary one by default. */
  dir?: string;
  spawnImpl?: typeof spawn;
}

/**
 * Reads session sid's transcript inside its WSL distro, copying it to a
 * file this machine reads as any transcript.
 */
export async function startWslTranscript(input: StartWslTranscriptInput): Promise<WslTranscript> {
  if (!SESSION_ID.test(input.sid)) {
    throw new Error(`a session id ${JSON.stringify(input.sid)}`);
  }
  const ownDir = input.dir === undefined;
  const dir = input.dir ?? (await mkdtemp(path.join(os.tmpdir(), "neolix-claude-wsl-")));
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${input.sid}.jsonl`);
  const child = (input.spawnImpl ?? spawn)(
    "wsl.exe",
    ["-d", input.distro, "--exec", "/bin/sh", "-c", WSL_TRANSCRIPT_SCRIPT, "sh", input.sid],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const copy = createWriteStream(file, { mode: 0o600 });
  let readyResolve: () => void = () => undefined;
  let readyReject: (error: Error) => void = () => undefined;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  let part = "";
  let settled = false;
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    if (settled) {
      copy.write(chunk);
      return;
    }
    part += chunk;
    const newline = part.indexOf("\n");
    if (newline < 0) {
      return;
    }
    const line = part.slice(0, newline).trim();
    const rest = part.slice(newline + 1);
    part = "";
    settled = true;
    if (line !== "ready") {
      readyReject(new Error(`the transcript's reader said ${JSON.stringify(line)}`));
      child.kill();
      return;
    }
    if (rest !== "") {
      copy.write(rest);
    }
    readyResolve();
  });
  child.stderr?.setEncoding("utf8");
  let stderr = "";
  child.stderr?.on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-2_000);
  });
  child.on("error", (error) => {
    readyReject(error);
  });
  child.on("close", (code) => {
    copy.end();
    if (!settled) {
      readyReject(new Error(`the transcript's reader ended (${code}): ${stderr.trim()}`));
    }
  });
  return {
    path: file,
    ready,
    settle: () => waitForCopy(file),
    stop: async () => {
      child.stdin?.end();
      if (child.exitCode === null && !child.killed) {
        await new Promise<void>((resolve) => {
          let done = false;
          const finish = (): void => {
            if (done) {
              return;
            }
            done = true;
            resolve();
          };
          const timer = setTimeout(() => {
            child.kill();
            finish();
          }, 5_000);
          child.once("close", () => {
            clearTimeout(timer);
            finish();
          });
        });
      }
      child.kill();
      copy.end();
      if (ownDir) {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  };
}

/** Waits until the copy hasn't grown for a moment, at most 3s. */
async function waitForCopy(file: string): Promise<void> {
  let size = -1;
  const until = Date.now() + 3_000;
  while (Date.now() < until) {
    const found = await stat(file).catch(() => null);
    if (found === null || found.size === size) {
      return;
    }
    size = found.size;
    await sleep(300);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type { ChildProcess, WslTool };
