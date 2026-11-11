import { Command } from "commander";
import type { DaemonClient } from "@neolix/client/internal/daemon-client";
import { connectToDaemon } from "../../utils/client.js";
import {
  addDaemonHostOption,
  addJsonOption,
  withGlobalOptions,
} from "../../utils/command-options.js";

interface GatewayAgentsOptions {
  daemonTarget?: Parameters<typeof connectToDaemon>[0]["target"];
  wire?: string;
  model?: string;
  gatewayUrl?: string;
  gatewayKey?: string;
  json?: boolean;
}

/**
 * `neolix gateway agents` — the third-party agents running plugins offer to
 * wire to the gateway (myna's `magpie.agent`). Listing needs a running
 * daemon; `--wire` writes the agent's own config file.
 */
export function createGatewayCommand(): Command {
  const gateway = new Command("gateway").description("The local model gateway");
  addDaemonHostOption(gateway);

  const agents = addDaemonHostOption(
    addJsonOption(
      gateway
        .command("agents")
        .description("List or wire the agent integrations plugins offer")
        .option("--wire <plugin>/<id>", "Write this integration's config")
        .option("--model <model>", "The model the agent should default to")
        .option(
          "--gateway-url <url>",
          "The gateway's OpenAI-compatible base (default 127.0.0.1:6868)",
        )
        .option("--gateway-key <key>", "The gateway key to give the agent"),
    ),
  );

  agents.action(
    withGlobalOptions(async (options: GatewayAgentsOptions) => {
      try {
        await runAgents(options);
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      }
    }),
  );

  return gateway;
}

async function runAgents(options: GatewayAgentsOptions): Promise<void> {
  if (options.daemonTarget === undefined) throw new Error("no daemon target selected");
  const client = await connectToDaemon({ target: options.daemonTarget });
  try {
    if (options.wire === undefined) {
      await listAgents(client, options);
      return;
    }
    await wireAgent(client, options);
  } finally {
    client.close();
  }
}

async function listAgents(client: DaemonClient, options: GatewayAgentsOptions): Promise<void> {
  const payload = await client.getGatewayAgentIntegrations();
  if (options.json === true) {
    console.log(JSON.stringify(payload.integrations, null, 2));
    return;
  }
  if (payload.integrations.length === 0) {
    console.log("No agent integrations are running.");
    return;
  }
  for (const integration of payload.integrations) {
    const target = `${integration.pluginId}/${integration.id}`;
    const format = integration.format ?? "(from extension)";
    console.log(`${target}  ${integration.label}`);
    console.log(`  config: ${integration.config}  format: ${format}`);
    console.log(`  model:  ${integration.model ?? "(none)"}`);
  }
}

async function wireAgent(client: DaemonClient, options: GatewayAgentsOptions): Promise<void> {
  const wire = options.wire as string;
  const slash = wire.indexOf("/");
  if (slash <= 0 || slash === wire.length - 1) {
    throw new Error("--wire takes <pluginId>/<integrationId>");
  }
  if (options.model === undefined || options.model.trim() === "") {
    throw new Error("pass the model the agent should use: --model provider/model");
  }
  const written = await client.wireGatewayAgentIntegration({
    pluginId: wire.slice(0, slash),
    integrationId: wire.slice(slash + 1),
    model: options.model.trim(),
    gateway: {
      v1: options.gatewayUrl ?? "http://127.0.0.1:6868/v1",
      key: options.gatewayKey ?? "",
    },
  });
  console.log(`Wired ${wire} → ${written.path}`);
  if (written.keys.length > 0) console.log(`Keys: ${written.keys.join(", ")}`);
}
