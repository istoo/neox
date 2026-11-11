import type { Command } from "commander";
import { createAgentCommands } from "./agent.js";
import { createAgentsCommand } from "./list.js";
import { createModelsCommand } from "./models.js";
import { createProfileCommands } from "./profiles.js";
import { createVisibleCommand } from "./visible.js";

/**
 * myna's agent-facing commands (internal/cli/main.go:57-70, 92-94, 159):
 * `agents`, `visible`, the profiles and one command per agent. Kept in their
 * own factory so cli.ts registers them in one loop.
 */
export function createAgentSettingsCommands(): Command[] {
  return [
    createAgentsCommand(),
    createModelsCommand(),
    createVisibleCommand(),
    ...createProfileCommands(),
    ...createAgentCommands(),
  ];
}
