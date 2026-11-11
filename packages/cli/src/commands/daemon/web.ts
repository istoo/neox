import { Command } from "commander";
import type { DaemonWebPage } from "@neolix/protocol/messages";
import { connectToDaemon } from "../../utils/client.js";
import { addLocalDaemonOptions, withGlobalOptions } from "../../utils/command-options.js";
import type { CommandOptions } from "../../output/index.js";

/**
 * `neolix daemon web [on|off]` — myna's daemon web (daemon_cli.go:161): the
 * web page this daemon serves to a browser, and its link. The page itself is
 * the daemon's (web-page.ts); this only asks it on or off.
 */

function printPage(page: DaemonWebPage): void {
  if (page.error !== null) {
    console.log(`not served: ${page.error}`);
    return;
  }
  if (page.mode === "off" || !page.serving) {
    console.log("off · the daemon serves no web page");
    return;
  }
  console.log(`${page.mode} · ${page.link ?? "no link yet"}`);
  for (const link of page.network) {
    console.log(`  ${link}`);
  }
}

interface DaemonWebOptions extends CommandOptions {
  lan?: boolean;
  addr?: string;
}

async function daemonWebAction(
  asked: string | undefined,
  options: DaemonWebOptions,
): Promise<void> {
  const client = await connectToDaemon({ target: options.daemonTarget });
  try {
    if (asked === undefined) {
      printPage(await client.getWebPage());
      return;
    }
    if (asked !== "on" && asked !== "off") {
      throw new Error(`neox daemon web on|off, not ${JSON.stringify(asked)}`);
    }
    let mode: "off" | "local" | "lan" = "local";
    if (asked === "off") {
      mode = "off";
    } else if (options.lan === true) {
      mode = "lan";
    }
    const port = portOf(options.addr);
    const result = await client.setWebPage({
      mode,
      ...(port === undefined ? {} : { port }),
    });
    if (result.error !== undefined) {
      throw new Error(result.error);
    }
    if (result.page !== null) {
      printPage(result.page);
    }
  } finally {
    client.close();
  }
}

/** The port of --addr host:port, as the daemon takes it. */
function portOf(addr: string | undefined): number | undefined {
  if (addr === undefined || addr.trim() === "") {
    return undefined;
  }
  const match = /(?:^|:)(\d+)$/.exec(addr.trim());
  const port = match === null ? Number.NaN : Number(match[1]);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`--addr is a host and a port, as 127.0.0.1:3430, not ${JSON.stringify(addr)}`);
  }
  return port;
}

export function daemonWebCommand(): Command {
  const command = new Command("web")
    .description("the web page this daemon serves: on, off, or its link")
    .argument("[on|off]")
    .option("--lan", "serve it to other computers on this network")
    .option("--addr <host:port>", "the page's address and port");
  addLocalDaemonOptions(command);
  command.action(
    withGlobalOptions(async (asked: string | undefined, options: DaemonWebOptions) => {
      await daemonWebAction(asked, options);
    }),
  );
  return command;
}
