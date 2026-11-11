import type { DaemonClient } from "@neolix/client/internal/daemon-client";
import type { AgentConnectSnapshot } from "@neolix/protocol/agent-connect";
import type { ExternalSession, UsageReportEntry } from "@neolix/protocol/messages";
import type {
  GatewayConfigWire,
  GatewayGroupWire,
  GatewayProviderWire,
  GatewayUsageReportWire,
} from "@neolix/protocol/gateway";
import type {
  LibraryDiscoverView,
  LibraryRtkStatus,
  LibrarySnapshot,
} from "@neolix/protocol/library";
import { connectToDaemon, type ConnectOptions } from "../../utils/client.js";
import { selectDaemonTarget, describeDaemonTarget } from "../../utils/daemon-target.js";
import type { UsagePeriod } from "./format.js";

/**
 * The daemon side of `neolix tui`: every page's data comes from an existing
 * RPC, through the same connect path the CLI's other commands use. Nothing
 * here reads files on its own.
 */

export interface TuiOptions {
  home?: string;
  host?: string;
  /** --no-color, from the CLI's global options. */
  color?: boolean;
  daemonTarget?: ConnectOptions["target"];
}

export interface TuiConnection {
  client: DaemonClient;
  target: string;
  close(): Promise<void>;
}

export function tuiTarget(options: TuiOptions): ConnectOptions["target"] {
  return options.daemonTarget ?? selectDaemonTarget({ home: options.home, host: options.host });
}

export function describeTarget(options: TuiOptions): string {
  return describeDaemonTarget(tuiTarget(options));
}

export async function connectTui(options: TuiOptions): Promise<TuiConnection> {
  const target = tuiTarget(options);
  const client = await connectToDaemon({ target });
  // The first connection fails fast (the retry screen handles it); once the
  // TUI is up, a drop reconnects in the background.
  client.setReconnectEnabled(true);
  return {
    client,
    target: describeDaemonTarget(target),
    close: async () => {
      await client.close().catch(() => undefined);
    },
  };
}

export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    return String(error.message);
  }
  return String(error);
}

export interface AgentsData {
  snapshot: AgentConnectSnapshot;
}

/** The wire config with its two lists made definite, as the daemon sends them. */
export type TuiProvider = GatewayProviderWire & {
  /** Older wire schema: the routing fallbacks, which the server does hold. */
  fallback?: string[];
  /** One address per API (myna's own provider); the server holds these. */
  wires?: Partial<Record<TuiWire, string>>;
};

export type TuiWire = "anthropic" | "openai" | "openai-responses" | "gemini";

export type TuiGroup = GatewayGroupWire & {
  /** Routing-group fields the v0.15 wire type leaves out. */
  manual?: boolean;
  affinity?: "auto" | "session" | "turn" | "off" | "strict";
  family?: string;
  patience?: number;
  unlists?: boolean;
};

export type TuiGatewayConfig = GatewayConfigWire & {
  providers: TuiProvider[];
  groups: TuiGroup[];
};

export function normalizeConfig(config: GatewayConfigWire): TuiGatewayConfig {
  return {
    ...config,
    providers: (config.providers ?? []) as TuiProvider[],
    groups: (config.groups ?? []) as TuiGroup[],
  };
}

export async function loadAgents(client: DaemonClient): Promise<AgentsData> {
  const { snapshot } = await client.getAgentConnect();
  if (snapshot.error !== null) {
    throw new Error(snapshot.error);
  }
  return { snapshot };
}

export interface ProvidersData {
  config: TuiGatewayConfig;
  agents: AgentConnectSnapshot | null;
  balances: Record<string, string>;
}

export async function loadProviders(
  client: DaemonClient,
  balances: Record<string, string> = {},
): Promise<ProvidersData> {
  const { config } = await client.getGatewayConfig();
  return { config: normalizeConfig(config), agents: null, balances };
}

/** Which agents use the gateway's models; slower than the provider list. */
export async function loadProviderAgents(
  client: DaemonClient,
): Promise<AgentConnectSnapshot | null> {
  try {
    return (await client.getAgentConnect()).snapshot;
  } catch {
    return null;
  }
}

/** Which agents' models each provider serves, as the app's provider row says. */
export function agentsUsingProvider(
  agents: AgentConnectSnapshot | null,
  providerId: string,
): string[] {
  if (agents === null) return [];
  const out = new Set<string>();
  for (const entry of agents.entries) {
    if (!entry.connected) continue;
    const models = [entry.model, ...(entry.fields ?? []).map((field) => field.model)];
    const uses = models.some(
      (model) => model !== null && model !== undefined && model.startsWith(`${providerId}/`),
    );
    if (uses) out.add(entry.name ?? entry.provider);
  }
  return [...out];
}

export async function loadBalances(
  client: DaemonClient,
  config: TuiGatewayConfig,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  await Promise.all(
    config.providers.map(async (provider) => {
      if (provider.balanceUrl === undefined || provider.balanceUrl === "") return;
      try {
        const apiKey = provider.apiKey ?? provider.accounts?.[0]?.apiKey;
        const result = await client.getGatewayProviderBalance({
          balanceUrl: provider.balanceUrl,
          ...(provider.balancePath === undefined ? {} : { balancePath: provider.balancePath }),
          ...(apiKey === undefined ? {} : { apiKey }),
          baseUrls: [provider.baseUrl],
          ...(provider.balanceMethod === undefined ? {} : { method: provider.balanceMethod }),
          ...(provider.balanceToken === undefined ? {} : { token: provider.balanceToken }),
        });
        if (result.amount !== null) {
          out[provider.id] = result.amount;
        } else if (result.error !== undefined) {
          out[provider.id] = `balance: ${truncateNote(result.error)}`;
        }
      } catch (error) {
        out[provider.id] = `balance: ${truncateNote(errorText(error))}`;
      }
    }),
  );
  return out;
}

function truncateNote(value: string): string {
  const chars = Array.from(value);
  return chars.length > 60 ? `${chars.slice(0, 59).join("")}…` : value;
}

export interface GroupsData {
  config: TuiGatewayConfig;
}

export async function loadGroups(client: DaemonClient): Promise<GroupsData> {
  const { config } = await client.getGatewayConfig();
  return { config: normalizeConfig(config) };
}

/** One account a daily check-in reaches, flattened for the Usage page. */
export interface TuiCheckinAccount {
  by: string;
  key: string;
  user: string;
  on: boolean;
  again: boolean;
  outcome?: string;
  day?: string;
  at?: string;
  credit?: number;
  streak?: number;
  msg?: string;
  until?: string;
  offline?: boolean;
}

export interface UsageData {
  period: UsagePeriod;
  report: GatewayUsageReportWire | null;
  reports: UsageReportEntry[];
  reportsError: string | null;
  reportsLoading: boolean;
  agents: AgentConnectSnapshot | null;
  checkin: TuiCheckinAccount[];
}

/** The accounts' last check-ins; an older daemon or none signed in is empty. */
export async function loadCheckins(client: DaemonClient): Promise<TuiCheckinAccount[]> {
  try {
    const { accounts } = await client.getGatewayCheckin();
    const out: TuiCheckinAccount[] = [];
    for (const account of accounts) {
      const item: TuiCheckinAccount = {
        by: account.by,
        key: account.key,
        user: account.user,
        on: account.on,
        again: account.again === true,
      };
      const record = account.record;
      if (record !== undefined) {
        item.outcome = record.outcome;
        item.day = record.day;
        item.at = record.at;
        if (record.credit !== undefined) item.credit = record.credit;
        if (record.streak !== undefined) item.streak = record.streak;
        if (record.msg !== undefined) item.msg = record.msg;
        if (record.until !== undefined) item.until = record.until;
        if (record.offline !== undefined) item.offline = record.offline;
      }
      out.push(item);
    }
    return out;
  } catch {
    return [];
  }
}

export interface UsageTotalsData {
  period: UsagePeriod;
  report: GatewayUsageReportWire | null;
  agents: AgentConnectSnapshot | null;
}

/** The usage page's totals: the gateway's ledger and the agent names beside it. */
export async function loadUsageTotals(
  client: DaemonClient,
  period: UsagePeriod,
): Promise<UsageTotalsData> {
  const [usage, agents] = await Promise.all([
    client
      .getGatewayUsage({
        period,
        timezoneOffsetMinutes: new Date().getTimezoneOffset(),
      })
      .catch((error: unknown) => {
        throw new Error(`gateway usage: ${errorText(error)}`);
      }),
    client
      .getAgentConnect()
      .then((payload) => payload.snapshot)
      .catch(() => null),
  ]);
  return { period, report: usage.report, agents };
}

export interface UsageReportsData {
  reports: UsageReportEntry[];
  reportsError: string | null;
}

/** The accounts' own allowances; the vendors are asked, so this is the slow half. */
export async function loadUsageReports(
  client: DaemonClient,
  refreshReports: boolean,
): Promise<UsageReportsData> {
  try {
    const payload = await client.listUsageReports(refreshReports ? { forceRefresh: true } : {});
    return { reports: payload.reports, reportsError: null };
  } catch (error) {
    return { reports: [], reportsError: errorText(error) };
  }
}

export interface SessionsData {
  sessions: ExternalSession[];
  names: Record<string, string>;
  activityDays: number | undefined;
  /** The same sessions with per-day activity, once the stats view asked for it. */
  activity?: ExternalSession[];
}

/**
 * The list RPC answers one agent at a time, as `neolix sessions` already reads
 * it: the first call names the agents, then each agent is asked in turn.
 */
export async function loadSessions(
  client: DaemonClient,
  activityDays: number | undefined,
): Promise<SessionsData> {
  const options = activityDays === undefined ? undefined : { activityDays };
  const first = await client.listExternalSessions(undefined, options);
  if (first.error !== null) {
    throw new Error(first.error);
  }
  const names: Record<string, string> = {};
  for (const entry of first.agents) {
    names[entry.agent] = entry.name;
  }
  const byAgent = new Map<string, ExternalSession[]>();
  if (first.agent.length > 0) {
    byAgent.set(first.agent, first.sessions);
  }
  for (const entry of first.agents) {
    if (byAgent.has(entry.agent)) continue;
    const page = await client.listExternalSessions(entry.agent, options);
    if (page.error !== null) {
      throw new Error(page.error);
    }
    byAgent.set(entry.agent, page.sessions);
  }
  const sessions = [...byAgent.values()]
    .flat()
    .sort((left, right) => right.last.localeCompare(left.last));
  return { sessions, names, activityDays };
}

export interface LibraryData {
  library: LibrarySnapshot;
  rtk: LibraryRtkStatus;
  /** What the agents have that the library doesn't; null when discovery failed. */
  discover: LibraryDiscoverView | null;
}

export async function loadLibrary(client: DaemonClient): Promise<LibraryData> {
  const [{ library }, { rtk }, discovered] = await Promise.all([
    client.getLibrary(),
    client.getLibraryRtk(),
    client.discoverLibrary().catch(() => null),
  ]);
  return { library, rtk, discover: discovered?.discover ?? null };
}

/** What `m` asks a provider for, as the provider editor's probe target. */
export function probeTarget(provider: GatewayProviderWire): {
  protocol: GatewayProviderWire["protocol"];
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  insecureTls?: boolean;
  modelsUrl?: string;
  providerId?: string;
} {
  const apiKey = provider.apiKey ?? provider.accounts?.[0]?.apiKey;
  return {
    protocol: provider.protocol,
    baseUrl: provider.baseUrl,
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(provider.headers === undefined ? {} : { headers: provider.headers }),
    ...(provider.insecureTls === undefined ? {} : { insecureTls: provider.insecureTls }),
    ...(provider.modelsUrl === undefined ? {} : { modelsUrl: provider.modelsUrl }),
    providerId: provider.id,
  };
}

/** Saves a whole gateway config back through the daemon. */
export async function saveGatewayConfig(
  client: DaemonClient,
  config: GatewayConfigWire,
): Promise<GatewayConfigWire> {
  const saved = await client.setGatewayConfig(config);
  return saved.config;
}
