import { Command } from "commander";
import { addDaemonHostOption, withGlobalOptions } from "../../utils/command-options.js";
import type { CommandOptions } from "../../output/index.js";
import { runTui } from "./run.js";
import type { TuiOptions } from "./data.js";

/** `neolix tui`: the terminal interface, on the daemon's own data. */
export function createTuiCommand(): Command {
  const command = addDaemonHostOption(
    new Command("tui").description(
      "Open Neox's terminal interface: agents, providers, routing, usage, sessions, library",
    ),
  );
  command.action(
    withGlobalOptions(async (options: CommandOptions & TuiOptions) => {
      process.exitCode = await runTui(options);
    }),
  );
  return command;
}
