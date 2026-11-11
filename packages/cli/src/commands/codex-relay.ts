import { Command } from "commander";
import { join } from "node:path";
import type { Logger } from "pino";
import { runCodexRelay } from "@neolix/server";
import { resolveNeolixHome } from "@neolix/server/daemon-control";
import { accountDiscoveryOn, GatewayConfigStore } from "@neolix/server/gateway-config";

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child: () => silentLogger,
} as unknown as Logger;

/** Whether the gateway may read Codex's own sign-in, as the daemon's config says. */
async function accountDiscovery(): Promise<boolean> {
  const store = new GatewayConfigStore({ neolixHome: resolveNeolixHome(), logger: silentLogger });
  await store.start();
  try {
    return accountDiscoveryOn(store.get());
  } finally {
    store.dispose();
  }
}

/**
 * `neolix codex-relay --addr host:port --pids 1,2`: the small process the
 * daemon starts when it quits, holding the port Codex threads were
 * started on and passing their turns to ChatGPT on Codex's own sign-in
 * (myna's `codexrelay.Main`, `internal/codexrelay/relay.go:100-140`).
 */
export function codexRelayCommand(): Command {
  return new Command("codex-relay")
    .description("Hold the gateway's port for open Codex threads after the daemon stops")
    .requiredOption("--addr <host:port>", "the address the gateway was serving on")
    .requiredOption("--pids <ids>", "the Codex processes the relay is for, comma separated")
    .option("--state <path>", "where the relay writes its state")
    .action(async (options: { addr: string; pids: string; state?: string }) => {
      const pids = options.pids
        .split(",")
        .map((value) => Number(value.trim()))
        .filter((value) => Number.isInteger(value) && value > 0);
      if (pids.length === 0) {
        throw new Error("codex-relay needs the Codex processes it is for");
      }
      const handle = await runCodexRelay({
        addr: options.addr,
        pids,
        statePath: options.state ?? join(resolveNeolixHome(), "gateway", "codex-relay.json"),
        signIn: { discovery: await accountDiscovery() },
      });
      await handle.done;
    });
}
