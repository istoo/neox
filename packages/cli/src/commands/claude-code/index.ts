import { Command } from "commander";
import { connectToDaemon, type ConnectOptions } from "../../utils/client.js";
import { addLocalDaemonOptions, withGlobalOptions } from "../../utils/command-options.js";

/**
 * `neolix claude-code install|remove`: myna's `claude-code_cli.go`, where the
 * subscription is served by driving the real Claude Code. Neolix's daemon
 * already has the install catalog (`agent.install.list`) and runs one
 * command on this computer; the CLI asks it for that entry rather than
 * carrying a command of its own. `remove` runs the vendor's uninstall line
 * from the same entry.
 */

interface Options {
  home?: string;
  yes?: boolean;
  daemonTarget?: ConnectOptions["target"];
}

function print(line: string): void {
  process.stdout.write(`${line}\n`);
}

function fail(error: unknown): void {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

async function confirm(command: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    return false;
  }
  const { createInterface } = await import("node:readline/promises");
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await readline.question(`Run this command? ${command} [y/N] `))
      .trim()
      .toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    readline.close();
  }
}

async function install(options: Options): Promise<void> {
  if (options.daemonTarget === undefined) {
    throw new Error("no daemon target selected");
  }
  const client = await connectToDaemon({ target: options.daemonTarget });
  try {
    const { entries } = await client.listAgentInstalls();
    const entry = entries.find((candidate) => candidate.provider === "claude");
    if (entry === undefined) {
      throw new Error("this host offers no Claude Code install");
    }
    const chosen = entry.commands[0];
    if (chosen === undefined) {
      print(entry.url ?? entry.description);
      return;
    }
    print(`${entry.name}: ${chosen.command}`);
    if (options.yes !== true && !(await confirm(chosen.command))) {
      throw new Error("install canceled: pass --yes to run it without asking");
    }
    const result = await client.runAgentInstall({
      provider: entry.provider,
      commandId: chosen.id,
    });
    if (result.output !== "") {
      print(result.output.trimEnd());
    }
    if (!result.ok) {
      throw new Error(result.error ?? `the install exited with ${result.exitCode ?? "an error"}`);
    }
    print("✓ Claude Code installed");
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function remove(options: Options): Promise<void> {
  if (options.daemonTarget === undefined) {
    throw new Error("no daemon target selected");
  }
  const client = await connectToDaemon({ target: options.daemonTarget });
  try {
    const { entries } = await client.listAgentInstalls();
    const entry = entries.find((candidate) => candidate.provider === "claude");
    if (entry === undefined) {
      throw new Error("this host offers no Claude Code uninstall");
    }
    if (entry.installed !== true) {
      // The user's own installer made this copy, and only its installer may
      // remove it; the documented lines are shown for reference.
      print("This Claude Code was not installed by Neox. Remove it with your own installer.");
      for (const command of entry.uninstallCommands ?? []) {
        print(`  ${command.command}`);
      }
      throw new Error("nothing was removed");
    }
    const chosen = entry.uninstallCommands?.[0];
    if (chosen === undefined) {
      throw new Error(
        "this host has no uninstall command for Claude Code: remove it with the installer you used, or remove Neox with neox uninstall",
      );
    }
    print(`uninstall ${entry.name}: ${chosen.command}`);
    if (options.yes !== true && !(await confirm(chosen.command))) {
      throw new Error("remove canceled: pass --yes to run it without asking");
    }
    const result = await client.uninstallAgent({
      provider: entry.provider,
      commandId: chosen.id,
    });
    if (result.output !== "") {
      print(result.output.trimEnd());
    }
    if (!result.ok) {
      throw new Error(result.error ?? `the uninstall exited with ${result.exitCode ?? "an error"}`);
    }
    print("✓ Claude Code removed");
  } finally {
    await client.close().catch(() => undefined);
  }
}

export function createClaudeCodeCommand(): Command {
  const claudeCode = new Command("claude-code").description(
    "Install the Claude Code a Claude subscription is served with",
  );
  addLocalDaemonOptions(claudeCode);

  addLocalDaemonOptions(
    claudeCode
      .command("install")
      .description("Install Claude Code on this computer")
      .option("-y, --yes", "Run the installer without asking"),
  ).action(
    withGlobalOptions(async (options: Options) => {
      try {
        await install(options);
      } catch (error) {
        fail(error);
      }
    }),
  );

  addLocalDaemonOptions(
    claudeCode
      .command("remove")
      .description("Remove Claude Code from this computer")
      .option("-y, --yes", "Run the uninstaller without asking"),
  ).action(
    withGlobalOptions(async (options: Options) => {
      try {
        await remove(options);
      } catch (error) {
        fail(error);
      }
    }),
  );

  return claudeCode;
}
