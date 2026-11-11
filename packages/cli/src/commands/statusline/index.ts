import { Command } from "commander";
import type { DaemonClient } from "@neolix/client/internal/daemon-client";
import type { GatewayQuotaAccountWire } from "@neolix/protocol/gateway";
import { connectToDaemon, type ConnectOptions } from "../../utils/client.js";
import { addDaemonHostOption, withGlobalOptions } from "../../utils/command-options.js";

/**
 * `neolix statusline` — myna's `myna statusline` (internal/cli/statusline_cli.go):
 * one line for Claude Code's status line, from what the running gateway has
 * already read. It asks no vendor, and prints nothing when the gateway can't
 * be asked.
 *
 * myna reads its own `/v1/myna/quotas?kept=1` and `/v1/myna/route?session=`;
 * Neolix asks the daemon's `gateway.quota.get` and `gateway.route_events.get`
 * RPCs instead.
 */

interface StatuslineClient {
  getLastServerInfoMessage(): {
    features?: { gatewayQuotas?: boolean; gatewayDiagnostics?: boolean };
  } | null;
  getGatewayQuota: DaemonClient["getGatewayQuota"];
  getGatewayRouteEvents: DaemonClient["getGatewayRouteEvents"];
  close: DaemonClient["close"];
}
type ConnectStatusline = (options: ConnectOptions) => Promise<StatuslineClient>;

/** myna bounds the ask so Claude Code isn't kept waiting. */
const STATUSLINE_WAIT_MS = 1_000;

export interface StatuslineInput {
  model?: string;
  accounts: GatewayQuotaAccountWire[];
  only: string[];
  now: number;
  /** The account that answered the newest route, as `provider/account`. */
  lastServedKey?: string;
  /** Accounts that answered through the gateway lately, as `provider/account`. */
  servedKeys?: ReadonlySet<string>;
}

function accountKey(account: GatewayQuotaAccountWire): string {
  return `${account.provider}/${account.account}`;
}

function matchesName(account: GatewayQuotaAccountWire, names: string[]): boolean {
  const values = new Set(
    [
      account.provider,
      account.providerLabel,
      account.account,
      account.accountLabel,
      accountKey(account),
      `${account.providerLabel}/${account.accountLabel}`,
    ].map((value) => value.toLowerCase()),
  );
  return names.some((name) => values.has(name.trim().toLowerCase()));
}

/** A window's name and use, myna's StatuslineCard. */
function windowText(window: GatewayQuotaAccountWire["windows"][number], now: number): string {
  let name = window.id;
  if (window.id === "tokens5h") {
    name = "5h";
  } else if (window.id === "tokens7d") {
    name = "7d";
  }
  if (window.resetsAt !== null && window.resetsAt <= now) {
    return `${name} 0%`;
  }
  if (window.usedPercent === null) {
    return `${name} -`;
  }
  return `${name} ${Math.round(window.usedPercent)}%`;
}

function cardText(account: GatewayQuotaAccountWire, now: number, last: boolean): string {
  const name = `${account.providerLabel} ${account.accountLabel}${last ? "*" : ""}`;
  return [name, ...account.windows.map((window) => windowText(window, now))].join(" ");
}

/** The line, without the model, when there is nothing else to say. */
export function statuslineText(input: StatuslineInput): string {
  const parts: string[] = [];
  if (input.model !== undefined && input.model.length > 0) {
    parts.push(`→ ${input.model}`);
  }
  const withWindows = input.accounts.filter((account) => account.windows.length > 0);
  const named =
    input.only.length > 0
      ? withWindows.filter((account) => matchesName(account, input.only))
      : withWindows;
  let shown = named;
  if (input.only.length === 0 && input.servedKeys !== undefined && input.servedKeys.size > 0) {
    const served = named.filter((account) => input.servedKeys?.has(accountKey(account)) === true);
    if (served.length > 0) {
      shown = served;
    }
  }
  for (const account of shown) {
    parts.push(cardText(account, input.now, accountKey(account) === input.lastServedKey));
  }
  return parts.join(" | ");
}

type RouteEvents = Awaited<ReturnType<DaemonClient["getGatewayRouteEvents"]>>["routes"];

interface RouteReading {
  model?: string;
  lastServedKey?: string;
  servedKeys: Set<string>;
}

/** What the ring says: the session's model, who answered, and who answered lately. */
function readRoutes(routes: RouteEvents, sessionId: string | undefined): RouteReading {
  const servedKeys = new Set<string>();
  let lastServedKey: string | undefined;
  let model: string | undefined;
  for (const event of routes) {
    const route = event.route;
    for (const attempt of route.tries ?? []) {
      if (attempt.status === 200 && attempt.provider !== undefined && attempt.account) {
        servedKeys.add(`${attempt.provider}/${attempt.account}`);
      }
    }
    const answered = (route.tries ?? [])
      .toReversed()
      .find(
        (attempt) => attempt.status === 200 && attempt.provider !== undefined && attempt.account,
      );
    if (answered?.provider !== undefined && answered.account) {
      lastServedKey = `${answered.provider}/${answered.account}`;
    }
    if (sessionId !== undefined && route.session === sessionId) {
      const name = route.model ?? route.asked;
      if (name !== undefined) {
        model = name;
      }
    }
  }
  return {
    ...(model === undefined ? {} : { model }),
    ...(lastServedKey === undefined ? {} : { lastServedKey }),
    servedKeys,
  };
}

/** Claude Code's JSON on stdin carries the session whose latest route is shown. */
async function readSessionId(): Promise<string | undefined> {
  if (process.stdin.isTTY === true) {
    return undefined;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of process.stdin) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      chunks.push(buffer);
      size += buffer.length;
      if (size > 1 << 20) {
        break;
      }
    }
  } catch {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof parsed === "object" && parsed !== null && "session_id" in parsed) {
      const value = (parsed as { session_id?: unknown }).session_id;
      return typeof value === "string" ? value : undefined;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * The status line. An unreachable or too-old gateway prints nothing, as
 * myna's does; a missing route feed still leaves the windows.
 */
export async function runStatuslineCommand(
  only: string[],
  options: { daemonTarget: ConnectOptions["target"] },
  connect: ConnectStatusline = connectToDaemon,
  input: { sessionId?: string; now?: number } = {},
): Promise<string> {
  const now = input.now ?? Date.now();
  let client: StatuslineClient;
  try {
    client = await connect({ target: options.daemonTarget, timeout: STATUSLINE_WAIT_MS });
  } catch {
    return "";
  }
  try {
    const features = client.getLastServerInfoMessage()?.features;
    if (features?.gatewayQuotas !== true) {
      return "";
    }
    const { quota } = await client.getGatewayQuota({ historyDays: 1 });
    let reading: RouteReading = { servedKeys: new Set() };
    if (features.gatewayDiagnostics === true) {
      try {
        const { routes } = await client.getGatewayRouteEvents();
        reading = readRoutes(routes, input.sessionId);
      } catch {
        // The route feed is optional: the windows still show.
      }
    }
    return statuslineText({
      ...(reading.model === undefined ? {} : { model: reading.model }),
      accounts: quota.accounts,
      only,
      now,
      ...(reading.lastServedKey === undefined ? {} : { lastServedKey: reading.lastServedKey }),
      servedKeys: reading.servedKeys,
    });
  } catch {
    return "";
  } finally {
    await client.close().catch(() => {});
  }
}

export function createStatuslineCommand(): Command {
  const statusline = addDaemonHostOption(
    new Command("statusline")
      .description("One line for Claude Code's status line, from the gateway's readings")
      .argument("[names...]", "A provider, an account, or provider/account"),
  );
  statusline.action(
    withGlobalOptions(
      async (names: string[], options: { daemonTarget: ConnectOptions["target"] }) => {
        const sessionId = await readSessionId();
        const line = await runStatuslineCommand(
          names,
          options,
          connectToDaemon,
          sessionId === undefined ? {} : { sessionId },
        );
        if (line.length > 0) {
          process.stdout.write(`${line}\n`);
        }
      },
    ),
  );
  return statusline;
}
