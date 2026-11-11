import { Command } from "commander";
import { AGENT_PROVIDER_IDS } from "@neolix/protocol/provider-manifest";
import { runLsCommand } from "./ls.js";
import { runModelsCommand } from "./models.js";
import { runDiagnosticCommand } from "./diagnostic.js";
import { withOutput, type CommandOptions } from "../../output/index.js";
import {
  addJsonAndDaemonHostOptions,
  addLocalDaemonOptions,
  withGlobalOptions,
} from "../../utils/command-options.js";
import {
  addGatewayProviderCommands,
  runModelsCommand as runGatewayModelsCommand,
} from "./gateway-commands.js";
import { hasGatewayProvider, withGatewayStore, type StoreOptions } from "./gateway-store.js";
import { runImportCommand } from "./import-link.js";

export {
  createPresetsCommand,
  createProvidersCommand,
  PROVIDER_USAGE,
} from "./gateway-commands.js";

/**
 * `neolix provider`: myna's gateway providers (`internal/cli/providers_cli.go`)
 * under the same verb tree, beside the agent-provider commands this CLI had
 * (ls, diagnostic, and models for an agent's provider). `provider <id>`
 * shows a gateway provider; `neolix providers` lists them.
 */

async function isGatewayProvider(ref: string, options: StoreOptions): Promise<boolean> {
  try {
    return await withGatewayStore(options, async (store) => hasGatewayProvider(store.get(), ref));
  } catch {
    return false;
  }
}

interface ModelsOptions {
  gateway?: boolean;
  agent?: boolean;
}

function sayError(message: string): void {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

/**
 * `provider models` names two things: a gateway provider whose picks myna's
 * ids edit, and an agent provider whose list the daemon reports. An id both
 * names ("codex" can be added to the gateway too) is refused rather than
 * guessed; --gateway and --agent say which was meant.
 */
async function dispatchModels(
  name: string,
  models: string[],
  options: ModelsOptions,
  command: Command,
  agentModels: (name: string, options: CommandOptions, command: Command) => Promise<void>,
): Promise<void> {
  const merged = command.optsWithGlobals() as StoreOptions;
  const gateway = await isGatewayProvider(name, merged);
  const agent = (AGENT_PROVIDER_IDS as readonly string[]).includes(name.trim().toLowerCase());
  if (options.gateway === true && options.agent === true) {
    sayError("Say one of --gateway or --agent, not both.");
    return;
  }
  if (options.agent === true) {
    if (models.length > 0) {
      sayError("An agent provider's models take no ids; ids pick a gateway provider's models.");
      return;
    }
    await agentModels(name, merged as CommandOptions, command);
    return;
  }
  if (options.gateway === true) {
    if (!gateway) {
      sayError(`no gateway provider "${name}" — neox providers lists them`);
      return;
    }
  } else if (gateway && agent) {
    sayError(
      `"${name}" is both a gateway provider and an agent provider: say --gateway or --agent.`,
    );
    return;
  } else if (models.length === 0 && !gateway) {
    await agentModels(name, merged as CommandOptions, command);
    return;
  }
  try {
    const lines = await runGatewayModelsCommand(name, models, merged);
    for (const line of lines) {
      process.stdout.write(`${line}\n`);
    }
  } catch (error) {
    sayError(
      typeof error === "object" && error !== null && "message" in error
        ? String(error.message)
        : String(error),
    );
  }
}

export function createProviderCommand(): Command {
  const provider = new Command("provider").description("Manage gateway providers");

  addJsonAndDaemonHostOptions(
    provider.command("ls").description("List available agent providers and status"),
  ).action(withOutput(runLsCommand));

  const agentModels = withOutput(runModelsCommand);
  addJsonAndDaemonHostOptions(
    provider
      .command("models")
      .description(
        "List models for a gateway provider (with ids, pick from its list) or an agent provider",
      )
      .argument("<provider>", "Gateway provider id, or agent provider (claude, codex, opencode)")
      .argument("[models...]", "Gateway provider only: ids, +id, -id, all, none or best")
      .option("--thinking", "Include thinking option IDs for each model (agent providers)")
      .option(
        "--gateway",
        "Treat <provider> as a gateway provider, even if an agent shares its name",
      )
      .option("--agent", "Treat <provider> as an agent provider, even if the gateway has its name"),
  ).action((name: string, models: string[], options: ModelsOptions, command: Command) =>
    dispatchModels(name, models, options, command, agentModels),
  );

  addJsonAndDaemonHostOptions(
    provider
      .command("diagnostic")
      .description("Show provider installation, environment, and availability diagnostics")
      .argument("<provider>", "Provider name"),
  ).action(withOutput(runDiagnosticCommand));

  addGatewayProviderCommands(provider);

  addLocalDaemonOptions(
    provider
      .command("import")
      .description("Add the provider a neolix:// or myna:// import link describes")
      .argument("<link>", "neolix://import?… or myna://import?…")
      .option("-y, --yes", "Add it without asking"),
  ).action(
    withGlobalOptions(async (link: string, options: { yes?: boolean }, command: Command) => {
      try {
        const merged = command.optsWithGlobals() as StoreOptions & { yes?: boolean };
        const lines = await runImportCommand([link], { ...merged, yes: options.yes === true });
        for (const line of lines) {
          process.stdout.write(`${line}\n`);
        }
      } catch (error) {
        sayError(
          typeof error === "object" && error !== null && "message" in error
            ? String(error.message)
            : String(error),
        );
      }
    }),
  );

  return provider;
}
