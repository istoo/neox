import { Command, Option } from "commander";
import { runMcpBridge } from "./bridge.js";
import { resolveGatewayTarget } from "./gateway.js";

/**
 * `neolix mcp <name>` — Neolix's MCP servers as a command an agent can start
 * (myna `myna mcp browser|search|vision|image`). The bridge speaks stdio to
 * the agent and HTTP to the daemon's gateway, so an agent that only knows
 * how to launch MCP servers as commands still gets Neolix's browser, web
 * search, image recognition and image generation.
 */
export function createMcpCommand(): Command {
  return new Command("mcp")
    .description(
      "Serve one of Neox's MCP servers on stdio, for an agent that launches MCP as a command",
    )
    .argument("<name>", "server: browser, search, vision or image, or a Library server's name")
    .option("--home <path>", "the Neox home whose daemon serves the server")
    .option("--gateway <url>", "the gateway's base URL (default: NEOLIX_GATEWAY, else the daemon)")
    .addOption(new Option("--key <key>", "the gateway key (default: NEOLIX_GATEWAY_KEY)"))
    .action(async (name: string, options: { home?: string; gateway?: string; key?: string }) => {
      try {
        const target = await resolveGatewayTarget({
          ...(options.home !== undefined ? { home: options.home } : {}),
          ...(options.gateway !== undefined ? { gateway: options.gateway } : {}),
          ...(options.key !== undefined ? { key: options.key } : {}),
        });
        await runMcpBridge(name, target, {
          input: process.stdin,
          output: process.stdout,
          error: process.stderr,
        });
      } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
      }
    });
}
