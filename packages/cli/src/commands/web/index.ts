import { spawn } from "node:child_process";
import { Command } from "commander";
import { connectToDaemon } from "../../utils/client.js";
import { addLocalDaemonOptions, withGlobalOptions } from "../../utils/command-options.js";
import type { CommandOptions } from "../../output/index.js";

/**
 * `neolix web [--addr host:port] [--lan] [--no-open] [--gateway]
 * [--tls-cert <file> --tls-key <file>]` — myna's web (web_cli.go:27): the
 * daemon's page in a browser. The page and its settings are the daemon's
 * (web-page.ts); this asks it for them and opens the link.
 */

interface WebOptions extends CommandOptions {
  addr?: string;
  lan?: boolean;
  open?: boolean;
  gateway?: boolean;
  tlsCert?: string;
  tlsKey?: string;
}

function openInBrowser(link: string): void {
  let command: string[] = ["xdg-open", link];
  if (process.platform === "darwin") {
    command = ["open", link];
  } else if (process.platform === "win32") {
    command = ["cmd", "/c", "start", "", link];
  }
  const [exe, ...args] = command as [string, ...string[]];
  const child = spawn(exe, args, { detached: true, stdio: "ignore" });
  child.unref();
}

function portOf(addr: string): number | undefined {
  const match = /:(\d+)$/.exec(addr.trim());
  if (match === null) {
    return undefined;
  }
  const port = Number(match[1]);
  return Number.isInteger(port) ? port : undefined;
}

export async function runWebCommand(options: WebOptions): Promise<void> {
  if ((options.tlsCert === undefined) !== (options.tlsKey === undefined)) {
    throw new Error("a certificate and its key go together: --tls-cert and --tls-key");
  }
  const client = await connectToDaemon({ target: options.daemonTarget });
  try {
    const port = options.addr === undefined ? undefined : portOf(options.addr);
    const result = await client.setWebPage({
      mode: options.lan === true ? "lan" : "local",
      ...(options.addr === undefined ? {} : { addr: options.addr }),
      ...(port === undefined ? {} : { port }),
      ...(options.tlsCert === undefined ? {} : { tlsCert: options.tlsCert }),
      ...(options.tlsKey === undefined ? {} : { tlsKey: options.tlsKey }),
      // myna's WebGateway flag lives as long as the server does; here that
      // is the daemon's web page, so it is kept until it is turned off.
      ...(options.gateway === true ? { gateway: true } : {}),
    });
    if (result.error !== undefined) {
      throw new Error(result.error);
    }
    const page = result.page ?? (await client.getWebPage());
    if (page.error !== null) {
      throw new Error(page.error);
    }
    if (page.link === null) {
      throw new Error("the page has no link yet: give it a key in the app once");
    }
    console.log("● the daemon serves this page:", page.link);
    if (page.network.length > 0) {
      for (const link of page.network) {
        console.log(`  ${link}`);
      }
    }
    if (options.open !== false) {
      openInBrowser(page.link);
    }
  } finally {
    client.close();
  }
}

export function createWebCommand(): Command {
  const command = new Command("web")
    .description("serve the web page from the daemon and open its link")
    .option("--addr <host:port>", "the address the page listens on")
    .option("--lan", "serve it to other computers on this network")
    .option("--no-open", "do not open a browser")
    .option("--gateway", "accepted for myna's command; the page has one mode")
    .option("--tls-cert <file>", "serve the page over HTTPS with this certificate")
    .option("--tls-key <file>", "the certificate's key");
  addLocalDaemonOptions(command);
  command.action(
    withGlobalOptions(async (options: WebOptions) => {
      await runWebCommand(options);
    }),
  );
  return command;
}
