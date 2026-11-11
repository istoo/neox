import { Command } from "commander";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stopDaemonInstance } from "@neolix/server/daemon-control";
import {
  describeUninstallReport,
  libraryKeepPath,
  resolveNeolixDataDirectories,
  resolveNeolixHome,
  runUninstall,
  uninstallFailed,
  type UninstallAgent,
} from "@neolix/server";
import { connectToDaemon } from "../utils/client.js";
import type { CommandOptions } from "../output/index.js";
import { addDaemonHostOption, withGlobalOptions } from "../utils/command-options.js";

/**
 * myna's `myna uninstall` (internal/uninstall/uninstall.go:275 Run): put the
 * agents back, turn off opening at login, stop the service, then delete
 * Neolix's own folder. Every phase asks first unless --yes is given.
 */
export function createUninstallCommand(): Command {
  return addDaemonHostOption(
    new Command("uninstall")
      .description("Disconnect every agent, turn off opening at login, and delete Neox's data")
      .option("--yes", "Do not ask for confirmation")
      .option("--keep-data", "Leave Neox's data folder in place")
      .option(
        "--data-after <pid>",
        "Wait for this process to exit, then delete Neox's data (used by the desktop app)",
      )
      .action(withGlobalOptions(runUninstallCommand)),
  );
}

async function ask(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

function autostartEntryPath(env: NodeJS.ProcessEnv): string {
  const configHome = env.XDG_CONFIG_HOME?.trim() || path.join(homedir(), ".config");
  // Same file the desktop app writes (desktop/src/system/autostart.ts LINUX_AUTOSTART_FILENAME).
  return path.join(configHome, "autostart", "neolix.desktop");
}

async function disableAutostart(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): Promise<void> {
  if (platform === "linux") {
    await fs.rm(autostartEntryPath(env), { force: true });
    return;
  }
  throw new Error("Turn off Open at login in Neox's settings before uninstalling on this platform");
}

async function waitForExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function runUninstallCommand(
  options: CommandOptions & {
    yes?: boolean;
    keepData?: boolean;
    dataAfter?: string;
  },
): Promise<void> {
  const env = process.env;
  const neolixHome = resolveNeolixHome(env);
  const dataDirectories = resolveNeolixDataDirectories({ neolixHome, homeDir: homedir() });

  // The desktop app's half: its own process is exiting, and the folder it
  // holds open can go once it has (myna's AfterExit).
  if (options.dataAfter !== undefined) {
    const pid = Number.parseInt(options.dataAfter, 10);
    if (!Number.isInteger(pid) || pid <= 0) {
      throw new Error("--data-after needs a process id");
    }
    await waitForExit(pid, 60_000);
    const keep = await libraryKeepPath(neolixHome);
    const report = await runUninstall({
      dataDirectories,
      listAgents: async () => [],
      disconnectAgent: async () => undefined,
      disableAutostart: async () => undefined,
      ...(keep ? { keepPaths: [keep] } : {}),
    });
    process.stdout.write(`${describeUninstallReport(report).join("\n")}\n`);
    return;
  }

  if (dataDirectories.length === 0) {
    throw new Error(
      `Neox's data folder (${neolixHome}) is not one this command may delete; check NEOLIX_HOME`,
    );
  }

  if (!options.yes) {
    const confirmed = await ask(
      `Uninstall Neox? This disconnects its agents, turns off opening at login, and deletes ${dataDirectories.join(", ")}.`,
    );
    if (!confirmed) {
      process.stdout.write("Cancelled.\n");
      return;
    }
  }

  const target = options.daemonTarget;
  let client: Awaited<ReturnType<typeof connectToDaemon>> | null = null;
  let agents: UninstallAgent[] = [];
  try {
    client = await connectToDaemon({ target, timeout: 3_000 });
    const payload = await client.getAgentConnect();
    agents = payload.snapshot.entries
      .filter((entry) => entry.connected)
      .map((entry) => ({ provider: entry.provider, label: entry.name ?? entry.provider }));
  } catch {
    // A daemon that isn't running has no agent to disconnect through it.
  }

  if (agents.length > 0 && !options.yes) {
    const confirmed = await ask(
      `Disconnect ${agents.map((agent) => agent.label).join(", ")} and put their configs back?`,
    );
    if (!confirmed) {
      agents = [];
    }
  }

  const connectedClient = client;
  const disconnectClient = connectedClient;
  const keep = options.keepData ? null : await libraryKeepPath(neolixHome);
  const report = await runUninstall({
    dataDirectories: options.keepData ? [] : dataDirectories,
    listAgents: async () => agents,
    disconnectAgent: async (agent) => {
      if (!disconnectClient) {
        throw new Error("The daemon is not running, so its config could not be put back");
      }
      await disconnectClient.setAgentConnect({ provider: agent.provider, connected: false });
    },
    disableAutostart: () => disableAutostart(env, process.platform),
    beforeRemoveData: async () => {
      if (target.kind !== "instance") {
        throw new Error("A remote daemon's data is not on this machine");
      }
      await stopDaemonInstance(target.home, {
        timeoutMs: 15_000,
        killTimeoutMs: 3_000,
        keepTerminals: false,
        requestShutdown: async (instance) => {
          const shutdownClient = await connectToDaemon({
            target,
            timeout: 5_000,
            instance: instance ?? undefined,
          });
          try {
            await shutdownClient.shutdownServer({ timeout: 5_000, keepTerminals: false });
          } finally {
            await shutdownClient.close();
          }
        },
      });
    },
    ...(keep ? { keepPaths: [keep] } : {}),
  });

  if (connectedClient) {
    await connectedClient.close().catch(() => undefined);
  }

  process.stdout.write(`${describeUninstallReport(report).join("\n")}\n`);
  if (uninstallFailed(report)) {
    process.exitCode = 1;
  }
}
