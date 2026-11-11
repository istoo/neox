import { spawn } from "node:child_process";
// `list()` is synchronous (the RPC answers with it), so the small install
// ledger is read and written synchronously with it.
// oxlint-disable-next-line neolix/no-sync-io
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  AgentInstallCommand,
  AgentInstallEntry,
  AgentInstallRunResult,
  AgentInstallUninstallResult,
} from "@neolix/protocol/agent-install";
import {
  AGENT_INSTALL_CATALOG,
  commandsForPlatform,
  installEntriesForPlatform,
  uninstallCommandsForPlatform,
  type AgentInstallCatalogEntry,
} from "./catalog.js";

export interface AgentInstallServiceOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Where the command runs; the daemon's working directory by default. */
  cwd?: string;
  /** The longest a single install may run. */
  timeoutMs?: number;
  catalog?: AgentInstallCatalogEntry[];
  /**
   * Where the installs Neolix ran are recorded (`$NEOLIX_HOME/gateway/
   * agent-installs.json` in the daemon). Only a recorded install may be
   * uninstalled: one the user made with their own installer is theirs.
   */
  stateFile?: string;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_OUTPUT_CHARS = 200_000;
const KILL_GRACE_MS = 2_000;

export interface ShellRunResult {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
}

/**
 * Runs one fixed install line on the daemon host. The caller has already
 * confirmed it; a timeout terminates the whole process tree.
 */
export function runShellCommand(input: {
  command: string;
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
  cwd?: string;
}): Promise<ShellRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.command, {
      shell: true,
      env: input.env,
      cwd: input.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      // A group of its own, so a timed-out installer's children stop too.
      detached: process.platform !== "win32",
    });
    let output = "";
    let truncated = false;
    let timedOut = false;
    let killTimer: NodeJS.Timeout | null = null;
    const append = (chunk: Buffer | string): void => {
      if (truncated) return;
      output += chunk.toString();
      if (output.length > MAX_OUTPUT_CHARS) {
        output = `${output.slice(0, MAX_OUTPUT_CHARS)}\n[output truncated]`;
        truncated = true;
      }
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    const timeout = setTimeout(() => {
      timedOut = true;
      stop(child);
      killTimer = setTimeout(() => {
        stop(child, "SIGKILL");
      }, KILL_GRACE_MS);
    }, input.timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timeout);
      if (killTimer !== null) clearTimeout(killTimer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (killTimer !== null) clearTimeout(killTimer);
      resolve({ exitCode: code, output, timedOut });
    });
  });
}

function stop(child: ReturnType<typeof spawn>, signal: NodeJS.Signals = "SIGTERM"): void {
  try {
    if (process.platform !== "win32" && child.pid !== undefined) {
      process.kill(-child.pid, signal);
      return;
    }
  } catch {
    // The process already left; fall through to the direct signal.
  }
  child.kill(signal);
}

export class AgentInstallService {
  private readonly platform: NodeJS.Platform;
  private readonly env: NodeJS.ProcessEnv;
  private readonly cwd: string | undefined;
  private readonly timeoutMs: number;
  private readonly catalog: AgentInstallCatalogEntry[];
  /** Where installs this daemon ran are recorded; absent means none are. */
  private readonly stateFile: string | undefined;
  /** The provider whose command is running now, null when idle. */
  private running: string | null = null;

  constructor(options: AgentInstallServiceOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.env = options.env ?? process.env;
    this.cwd = options.cwd;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.catalog = options.catalog ?? AGENT_INSTALL_CATALOG;
    this.stateFile = options.stateFile;
  }

  public list(): AgentInstallEntry[] {
    const installed = this.installed();
    const entries: AgentInstallEntry[] = [];
    for (const entry of installEntriesForPlatform(this.catalog, this.platform)) {
      entries.push(installed[entry.provider] === undefined ? entry : { ...entry, installed: true });
    }
    return entries;
  }

  public async run(input: {
    provider: string;
    commandId: string;
    timeoutMs?: number;
  }): Promise<AgentInstallRunResult> {
    const entry = this.catalog.find((candidate) => candidate.provider === input.provider);
    if (entry === undefined) {
      return failed(input.provider, "This agent has no known install command.");
    }
    const command = commandsForPlatform(entry, this.platform).find(
      (candidate) => candidate.id === input.commandId,
    );
    if (command === undefined) {
      return failed(input.provider, "That install command is not offered on this host.");
    }
    const executed = await this.execute(entry.provider, command, input.timeoutMs, "installer");
    if (executed.ok) {
      this.remember(entry.provider, command.id);
    }
    return { requestId: "", provider: entry.provider, ...executed };
  }

  /**
   * Undoes an install Neolix made, with the vendor's own uninstall line. A
   * copy Neolix did not install is the user's, and is left alone. The first
   * line is the default; a client names another only when the entry has more.
   */
  public async uninstall(input: {
    provider: string;
    commandId?: string;
    timeoutMs?: number;
  }): Promise<AgentInstallUninstallResult> {
    const entry = this.catalog.find((candidate) => candidate.provider === input.provider);
    if (entry === undefined) {
      return failedUninstall(input.provider, "This agent has no known uninstall command.");
    }
    if (this.stateFile !== undefined && this.installed()[entry.provider] === undefined) {
      const own = uninstallCommandsForPlatform(entry, this.platform)[0];
      return failedUninstall(
        entry.provider,
        "Neox did not install this copy; uninstall it with your own installer." +
          (own === undefined ? "" : ` The vendor's uninstall command is: ${own.command}`),
      );
    }
    const commands = uninstallCommandsForPlatform(entry, this.platform);
    const command =
      input.commandId === undefined
        ? commands[0]
        : commands.find((candidate) => candidate.id === input.commandId);
    if (command === undefined) {
      return failedUninstall(entry.provider, "That uninstall command is not offered on this host.");
    }
    const executed = await this.execute(entry.provider, command, input.timeoutMs, "uninstaller");
    if (executed.ok) {
      this.forget(entry.provider);
    }
    return { requestId: "", provider: entry.provider, ...executed };
  }

  /** Records this daemon's installs, by provider. */
  private installed(): Record<string, InstalledRecord> {
    if (this.stateFile === undefined) {
      return {};
    }
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.stateFile, "utf8"));
      return typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, InstalledRecord>)
        : {};
    } catch {
      return {};
    }
  }

  private remember(provider: string, commandId: string): void {
    if (this.stateFile === undefined) {
      return;
    }
    writeInstalled(this.stateFile, {
      ...this.installed(),
      [provider]: { commandId, at: Date.now() },
    });
  }

  private forget(provider: string): void {
    if (this.stateFile === undefined) {
      return;
    }
    const records = this.installed();
    if (records[provider] === undefined) {
      return;
    }
    delete records[provider];
    writeInstalled(this.stateFile, records);
  }

  /**
   * Runs one fixed line. Two installers writing the same global prefix at
   * once is how a machine ends up with half a CLI; the daemon runs one at a
   * time, install or uninstall.
   */
  private async execute(
    provider: string,
    command: AgentInstallCommand,
    requestedTimeoutMs: number | undefined,
    noun: "installer" | "uninstaller",
  ): Promise<{ ok: boolean; exitCode: number | null; output: string; error: string | null }> {
    if (this.running !== null) {
      return {
        ok: false,
        exitCode: null,
        output: "",
        error: `An install of ${this.running} is already running on this host.`,
      };
    }
    this.running = provider;
    const timeoutMs = Math.min(requestedTimeoutMs ?? this.timeoutMs, this.timeoutMs);
    try {
      const result = await runShellCommand({
        command: command.command,
        timeoutMs,
        env: this.env,
        ...(this.cwd === undefined ? {} : { cwd: this.cwd }),
      });
      if (result.timedOut) {
        return {
          ok: false,
          exitCode: result.exitCode,
          output: result.output,
          error: `The ${noun} did not finish within ${Math.round(timeoutMs / 1000)}s.`,
        };
      }
      return {
        ok: result.exitCode === 0,
        exitCode: result.exitCode,
        output: result.output,
        error:
          result.exitCode === 0
            ? null
            : `The ${noun} exited with code ${result.exitCode ?? "unknown"}.`,
      };
    } catch (cause) {
      return {
        ok: false,
        exitCode: null,
        output: "",
        error: cause instanceof Error ? cause.message : String(cause),
      };
    } finally {
      this.running = null;
    }
  }
}

function failed(provider: string, error: string): AgentInstallRunResult {
  return {
    requestId: "",
    provider,
    ok: false,
    exitCode: null,
    output: "",
    error,
  };
}

function failedUninstall(provider: string, error: string): AgentInstallUninstallResult {
  return {
    requestId: "",
    provider,
    ok: false,
    exitCode: null,
    output: "",
    error,
  };
}

/** One install Neolix ran: the line, and when. */
interface InstalledRecord {
  commandId: string;
  at: number;
}

function writeInstalled(file: string, records: Record<string, InstalledRecord>): void {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(temp, JSON.stringify(records), { mode: 0o600 });
  try {
    renameSync(temp, file);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      // The temp file is already gone; the rename's error is what matters.
    }
    throw error;
  }
}

export function createAgentInstallService(
  options: AgentInstallServiceOptions = {},
): AgentInstallService {
  return new AgentInstallService(options);
}

const sharedServices = new Map<string, AgentInstallService>();

/**
 * One service per daemon home: the mutex has to cover every client session,
 * or two of them can run installers at once.
 */
export function sharedAgentInstallService(
  neolixHome: string,
  options: AgentInstallServiceOptions = {},
): AgentInstallService {
  const existing = sharedServices.get(neolixHome);
  if (existing) return existing;
  const created = new AgentInstallService({
    ...options,
    stateFile: options.stateFile ?? join(neolixHome, "gateway", "agent-installs.json"),
  });
  sharedServices.set(neolixHome, created);
  return created;
}
