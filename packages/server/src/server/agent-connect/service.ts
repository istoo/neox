import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  AgentConnectDrift,
  AgentConnectEntry,
  AgentConnectLibrary,
  AgentConnectModel,
  AgentConnectPluginProvider,
  AgentConnectProfile,
  AgentConnectSetup,
  AgentConnectSnapshot,
} from "@neolix/protocol/agent-connect";
import { writeJsonFileAtomic } from "../atomic-file.js";
import { listGatewayModels } from "../llm-gateway/catalog.js";
import type { GatewayConfig } from "../llm-gateway/config.js";
import { loadSubscriptionAccount, subscriptionAuth } from "../llm-gateway/subscription-auth.js";
import { setHiddenModels, type VisibilityRecords } from "../llm-gateway/visibility.js";
import type { LibraryService } from "../library/index.js";
import {
  AGENT_CONNECT_DRIVERS,
  AGENT_CONNECT_UNSUPPORTED,
  type AgentConnectDriver,
  type AgentConnectFieldSetting,
  type AgentPrefKey,
  type AgentConnectUndo,
  type ConnectCodexSettings,
  type ConnectEnvironment,
  type ConnectReadResult,
  type ExternalAgentField,
  type ExternalAgentInfo,
} from "./drivers.js";
import { EXTERNAL_AGENT_DRIVERS } from "./external/drivers.js";
import type { StaleCopy, StaleKind } from "./stale-copies.js";
import { discoverWslRows, parseWslProvider, type WslDeps, type WslRow } from "./external/wsl.js";
import { createScienceKeeper, type ScienceRun } from "./external/claude-science.js";
import { writeSystemCredential } from "./credential.js";
import { runProcess } from "./process-run.js";

export interface AgentConnectServiceOptions {
  neolixHome: string;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  /** The gateway config as the daemon holds it; empty when the gateway is not running. */
  gatewayConfig: () => GatewayConfig;
  /** `http://host:port`, or null when the gateway has no TCP listener. */
  gatewayBaseUrl: () => string | null;
  /** Plugins that contribute agent providers, for the 「More in Plugins」 row. */
  pluginProviders?: () => AgentConnectPluginProvider[];
  drivers?: AgentConnectDriver[];
  /** Writes a secret to the OS credential store, for agents that keep their key there. */
  writeCredential?: (url: string, key: string) => Promise<void>;
  platform?: NodeJS.Platform;
  /** Runs a host command; injectable so tests never touch the system. */
  run?: (command: string, args: string[], input?: string) => Promise<string>;
  /** Whether agents inside WSL distros are looked for (Settings' noWslAgents, inverse). */
  wslEnabled?: () => boolean;
  /** The distro probe, injectable so tests never touch wsl.exe. */
  wslDiscover?: (baseUrl: string, deps?: WslDeps) => Promise<WslRow[]>;
  /** Starts the daemon keeper at daemon start-up (myna's KeepClaudeScience). */
  startScienceKeeper?: boolean;
  /** Reads each agent CLI's version by running it (myna's cliTag); off in tests unless injected. */
  probeVersions?: boolean;
  /** Runs with an environment, injectable for the keeper's tests. */
  runWithEnv?: ScienceRun;
  /**
   * The library's own service, for a profile to save and restore who its
   * servers, skills, hooks and instructions went to (myna's library.Snapshot).
   */
  library?: () => LibraryService | null;
  /**
   * Writes an agent-wide preference Neolix keeps for an agent (myna's own
   * settings, like Codex's subagent model); `undefined` takes it out.
   */
  writeAgentPref?: (key: AgentPrefKey, value: string | undefined) => Promise<void>;
  /**
   * Writes which models an agent is shown into the gateway config, where
   * `neox visible` keeps them (myna's Settings). Without it a write stays
   * in this service's own state (COMPAT(agentVisibilityInState)).
   */
  writeVisibility?: (agent: string, records: VisibilityRecords) => Promise<void>;
  /**
   * Watches the gateway config; a change rewrites the agents' own lists at
   * once (myna's SetVisible syncing them). One subscription per daemon
   * home, owned by the shared service.
   */
  watchGatewayConfig?: (listener: () => void) => () => void;
}

/** What Neolix last wrote for an agent, to tell an edited config from an old one. */
interface AgentConnectApplied {
  baseUrl: string;
  model: string | null;
}

interface ConnectStateFile {
  version: 1;
  undo: Record<string, AgentConnectUndo>;
  profiles: AgentConnectProfile[];
  applied: Record<string, AgentConnectApplied>;
  /** A harness agent Neolix connected along with the agent that runs it. */
  joined: Record<string, string>;
  /** The gateway model ids each agent's config was last written with. */
  catalogs: Record<string, string>;
  /** The gateway model ids each agent's own list leaves out (myna's HiddenModels). */
  hiddenModels: Record<string, string[]>;
  order: string[];
  hidden: string[];
}

const EMPTY_STATE: ConnectStateFile = {
  version: 1,
  undo: {},
  profiles: [],
  applied: {},
  joined: {},
  catalogs: {},
  hiddenModels: {},
  order: [],
  hidden: [],
};

/** An agent's own environment inside a WSL distro: Linux paths, a UNC home, the distro's gateway address. */
function applyWsl(environment: ConnectEnvironment, row: WslRow): void {
  environment.homeDir = row.uncHome;
  environment.platform = "linux";
  environment.baseUrl = row.baseUrl;
  environment.wsl = { distro: row.distro, home: row.home };
  if (row.variant !== undefined) environment.variant = row.variant;
  else delete environment.variant;
}

/** The gateway's chat models as one string, for noticing a catalog change. */
function catalogOf(models: AgentConnectModel[]): string {
  return JSON.stringify(models.map((entry) => entry.id));
}

/** JSON with object keys in a fixed order, for comparing two snapshots of a setup. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Codex's AGENT_PREFS settings as the drivers read them. */
function codexSettings(config: GatewayConfig): ConnectCodexSettings {
  const openAiModels = listGatewayModels(config)
    .filter((model) => {
      if (model.owned_by === "openai" || model.owned_by === "codex") return true;
      const provider = config.providers.find((entry) => entry.id === model.owned_by);
      return provider?.accounts.some((account) => account.agent === "chatgpt-api") === true;
    })
    .map((model) => model.id);
  return {
    agentsV1: config.codexAgentsV1 === true,
    subagentModel: config.codexSubagentModel?.trim() ?? "",
    autoReview: config.codexAutoReview?.trim() ?? "",
    fullContext: config.fullContext === true,
    compactAt: config.compactAt ?? 0,
    asyncCompact: config.codexAsyncCompact === true,
    asyncCompactPercent: config.codexAsyncCompactPercent ?? 0,
    memories: config.codexMemories?.trim() ?? "",
    login: config.codexLogin?.trim() ?? "",
    openAiModels,
  };
}

/** CLIs that take the gateway from their environment, so a launch command is all Neolix can offer. */
const LAUNCH_ONLY_PROVIDERS = ["antigravity"] as const;

/** The core drivers whose own model lists Neolix writes and a visibility change rewrites. */
const REFRESHES_MODEL_LISTS = new Set(["codex", "opencode", "pi"]);

/**
 * Reads and writes the agent-side configs that point an installed agent at
 * Neolix's gateway. Every write keeps what it replaced so disconnecting puts
 * the user's file back; nothing is written outside the daemon host.
 */
export class AgentConnectService {
  private readonly statePath: string;
  private readonly homeDir: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly drivers: AgentConnectDriver[];
  private readonly options: AgentConnectServiceOptions;
  private wslCache: { at: number; baseUrl: string; rows: WslRow[] } | null = null;
  private scienceKeeperStop: (() => void) | null = null;
  private readonly versions = new Map<string, { at: number; version: string | null }>();
  private readonly stale = new Map<string, { at: number; copies: StaleCopy[] }>();
  private readonly listeners = new Set<(snapshot: AgentConnectSnapshot) => void>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: AgentConnectServiceOptions) {
    this.options = options;
    this.statePath = path.join(options.neolixHome, "agent-connect", "state.json");
    this.homeDir = options.homeDir ?? process.env.HOME ?? process.cwd();
    this.env = options.env ?? process.env;
    this.drivers = options.drivers ?? [...AGENT_CONNECT_DRIVERS, ...EXTERNAL_AGENT_DRIVERS];
  }

  public snapshot(): Promise<AgentConnectSnapshot> {
    return this.withLock(() => this.buildSnapshot(null));
  }

  /**
   * A gateway that moved (its port changed) takes the connected agents with
   * it, as myna's does. Only a config still on the address Neolix wrote is
   * moved: one the user or the agent changed itself is left alone. Runs once
   * per daemon, off a snapshot read rather than in its way.
   */
  public async followGatewayAddress(): Promise<string[]> {
    const gateway = this.gateway();
    if (gateway.baseUrl === null) return [];
    const state = await this.loadState();
    const moves: { provider: string; model?: string }[] = [];
    for (const [provider, applied] of Object.entries(state.applied)) {
      if (applied.baseUrl === gateway.baseUrl) continue;
      const resolved = await this.resolveProvider(provider, gateway);
      if (resolved === null) continue;
      const environment = this.environment(gateway);
      if (resolved.variant !== undefined) environment.variant = resolved.variant;
      if (resolved.wsl !== undefined) applyWsl(environment, resolved.wsl);
      let read: ConnectReadResult;
      try {
        read = await resolved.driver.read(environment);
      } catch {
        continue;
      }
      // Still the address Neolix wrote, though not the gateway's now: the
      // gateway moved under it. `read.connected` is false here for a driver
      // that compares against the gateway's current address.
      if (read.baseUrl === null || read.baseUrl !== applied.baseUrl) continue;
      const stillServed =
        read.model !== null && gateway.models.some((entry) => entry.id === read.model);
      moves.push({
        provider,
        ...(stillServed && read.model !== null ? { model: read.model } : {}),
      });
    }
    for (const move of moves) {
      const wired =
        move.model === undefined ? { connected: true } : { connected: true, model: move.model };
      await this.set({ provider: move.provider, ...wired });
    }
    return moves.map((move) => move.provider);
  }

  private followedGateway = false;

  /** Runs the move once per daemon, at start: a gateway port change restarts it. */
  public startGatewayFollow(): void {
    if (this.followedGateway) return;
    this.followedGateway = true;
    void this.followGatewayAddress().catch(() => undefined);
  }

  /** Every connected client hears about a write, as `gateway.config.changed` does. */
  public subscribe(listener: (snapshot: AgentConnectSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(snapshot: AgentConnectSnapshot): void {
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }

  public set(input: {
    provider: string;
    connected: boolean;
    model?: string;
    /** One of the entry's settings to write (myna's `myna <agent> <field>`). */
    field?: string;
    value?: string;
  }): Promise<AgentConnectSnapshot> {
    // A connect, a disconnect, or one field's write, each with its own
    // error path (myna's set, Unwire and Field.Set).
    // eslint-disable-next-line complexity
    return this.withLock(async (state) => {
      const gateway = this.gateway();
      const resolved = await this.resolveProvider(input.provider, gateway);
      if (resolved === null) {
        return this.buildSnapshot("This agent cannot be routed through Neox's gateway.", state);
      }
      const { driver } = resolved;
      if (driver.external?.noConnect === true) {
        return this.buildSnapshot(
          `${driver.external.name} uses its own models, so Neox cannot route it through the gateway.`,
          state,
        );
      }
      if (input.field !== undefined) {
        // One of the agent's own fields: a write to its own config, never
        // a reconnect (myna's `myna <agent> <field> <value>`).
        let fieldError: string | null = null;
        try {
          if (driver.setSetting === undefined) {
            throw new Error(
              `${driver.external?.name ?? driver.provider} has no field "${input.field}"`,
            );
          }
          const environment = this.environment(gateway);
          if (resolved.variant !== undefined) environment.variant = resolved.variant;
          if (resolved.wsl !== undefined) applyWsl(environment, resolved.wsl);
          await driver.setSetting(environment, input.field, input.value ?? "");
        } catch (cause) {
          fieldError = cause instanceof Error ? cause.message : String(cause);
        }
        const snapshot = await this.buildSnapshot(fieldError, state);
        if (fieldError === null) this.notify(snapshot);
        return snapshot;
      }
      let error: string | null = null;
      try {
        const environment = this.environment(gateway);
        if (resolved.variant !== undefined) environment.variant = resolved.variant;
        if (resolved.wsl !== undefined) applyWsl(environment, resolved.wsl);
        if (input.connected) {
          const harness = await this.joinHarness(driver, environment, gateway, state);
          try {
            await this.connectDriver(
              driver,
              environment,
              gateway,
              input.model,
              state,
              harness ?? undefined,
              input.provider,
            );
          } catch (cause) {
            if (harness !== null) await this.leaveHarness(driver, environment, state);
            throw cause;
          }
        } else {
          if (resolved.variant !== undefined || resolved.wsl !== undefined) {
            await this.disconnectDriver(driver, environment, state, input.provider);
          } else {
            await this.disconnectDriver(driver, environment, state);
            // A row whose settings are its fields (Aside's four roles) puts
            // each of them back too.
            await this.disconnectFields(driver, environment, state, input.provider);
            await this.leaveHarness(driver, environment, state);
          }
        }
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
      }
      if (error === null) {
        await this.saveState(state);
      }
      const snapshot = await this.buildSnapshot(error, state);
      if (error === null) {
        this.notify(snapshot);
      }
      return snapshot;
    });
  }

  /**
   * The catalog, the agent's visibility records and Codex's own settings:
   * any of them changing rewrites its config.
   */
  private catalogKey(providerId: string, models: AgentConnectModel[]): string {
    const catalog = catalogOf(models);
    const config = this.gateway().config;
    const key = providerId.trim().toLowerCase();
    const visibility = JSON.stringify({
      visible: config.visible?.[key],
      hidden: config.hiddenModels?.[key],
      picked: config.pickedModels?.[key],
    });
    return providerId === "codex"
      ? `${catalog}|${visibility}|${JSON.stringify(codexSettings(config))}`
      : `${catalog}|${visibility}`;
  }

  /**
   * Writes the gateway's catalog as it is now into the agents whose model
   * lists Neolix keeps (myna's SyncCatalog, which dsh's Sync runs as
   * dshSyncFresh). Only a config last written with another catalog is
   * touched, so a reader's own edits and an unchanged gateway stay as they
   * are.
   */
  public refreshModels(): Promise<void> {
    return this.withLock(async (state) => {
      const gateway = this.gateway();
      if (gateway.baseUrl === null || gateway.models.length === 0) return;
      const environment = this.environment(gateway);
      let changed = false;
      for (const driver of this.drivers) {
        // Codex's config carries its own settings too, and Pi's and
        // OpenCode's name the models they serve: a visibility change
        // rewrites them as a catalog change does.
        if (
          driver.external?.refreshModels !== true &&
          !REFRESHES_MODEL_LISTS.has(driver.provider)
        ) {
          continue;
        }
        const providerId = driver.provider;
        const catalog = this.catalogKey(providerId, gateway.models);
        if (state.undo[providerId] === undefined) continue;
        if (state.catalogs[providerId] === catalog) continue;
        try {
          const read = await driver.read(environment);
          if (!read.connected) continue;
          // The models this agent's visibility leaves out follow the
          // records in gateway.json, as a reconnect does (myna SyncCatalog).
          environment.hiddenModels = this.hiddenFor(providerId, state);
          const model = read.model ?? gateway.models[0]?.id ?? null;
          // The undo record stays the one the first connect made: a refresh
          // only rewrites the catalog, and disconnecting must still put
          // back what the reader had before it.
          await driver.connect(environment, model, state.undo[providerId]);
          state.applied[providerId] = { baseUrl: gateway.baseUrl, model };
          state.catalogs[providerId] = catalog;
          changed = true;
        } catch {
          // A file another program holds keeps its old catalog; the next
          // gateway change tries again.
        }
      }
      if (!changed) return;
      await this.saveState(state);
      this.notify(await this.buildSnapshot(null, state));
    });
  }

  /**
   * Starts the daemon keeper (myna's KeepClaudeScience): the daemon Neolix
   * started is started again when it isn't running, once at start-up and
   * every minute. The daemon's shutdown stops it.
   */
  public async startScienceKeeper(): Promise<void> {
    if (this.scienceKeeperStop !== null) return;
    const keeper = createScienceKeeper({
      environment: () => ({
        homeDir: this.options.homeDir ?? process.env.HOME ?? process.cwd(),
        platform: this.options.platform,
        env: this.options.env ?? process.env,
        ...(this.options.runWithEnv === undefined ? {} : { runWithEnv: this.options.runWithEnv }),
      }),
    });
    try {
      this.scienceKeeperStop = await keeper.start();
    } catch {
      // The daemon's own failure is logged by the keeper's tick.
    }
  }

  public stopScienceKeeper(): void {
    this.scienceKeeperStop?.();
    this.scienceKeeperStop = null;
  }

  private async connectDriver(
    driver: AgentConnectDriver,
    environment: ConnectEnvironment,
    gateway: {
      baseUrl: string | null;
      models: AgentConnectModel[];
    },
    requestedModel: string | undefined,
    state: ConnectStateFile,
    hint?: string,
    providerId: string = driver.provider,
  ): Promise<void> {
    if (gateway.baseUrl === null) {
      throw new Error("The gateway is not listening on a TCP port.");
    }
    const requested = requestedModel?.trim() ?? "";
    if (requested.length > 0 && !gateway.models.some((entry) => entry.id === requested)) {
      throw new Error(`The gateway does not serve ${requested}.`);
    }
    // Connecting without a model starts the agent on the gateway's first
    // one, as myna does; the picker can move it afterwards.
    const model = requested.length > 0 ? requested : (gateway.models[0]?.id ?? null);
    if (state.undo[providerId] === undefined) {
      await this.backupFile(providerId, driver.configPath(environment));
    }
    environment.hiddenModels = this.hiddenFor(providerId, state);
    state.undo[providerId] = await driver.connect(environment, model, state.undo[providerId], hint);
    state.applied[providerId] = { baseUrl: gateway.baseUrl, model };
    state.catalogs[providerId] = this.catalogKey(providerId, gateway.models);
  }

  /** A row's driver, by its id (`provider` or `provider#variant`). */
  private async resolveProvider(
    provider: string,
    gateway: { baseUrl: string | null; models: AgentConnectModel[]; apiKey: string },
  ): Promise<{ driver: AgentConnectDriver; variant?: string; wsl?: WslRow } | null> {
    const exact = this.drivers.find((entry) => entry.provider === provider);
    if (exact !== undefined) return { driver: exact };
    const wsl = parseWslProvider(provider);
    if (wsl !== null) {
      // a named profile's row is `omp#<name>@wsl:<distro>`: its driver is
      // the base id before the #
      const driver = this.drivers.find((entry) => entry.provider === wsl.driver.split("#")[0]);
      if (driver === undefined) return null;
      const row = (await this.wslRowsFor(gateway)).find((entry) => entry.provider === provider);
      return row === undefined ? null : { driver, wsl: row };
    }
    const cut = provider.indexOf("#");
    if (cut <= 0 || cut === provider.length - 1) return null;
    const driver = this.drivers.find((entry) => entry.provider === provider.slice(0, cut));
    if (driver === undefined) return null;
    return { driver, variant: provider.slice(cut + 1) };
  }

  /** The driver of a row's base provider id, without its variant or distro. */
  private driverFor(provider: string): AgentConnectDriver | undefined {
    const wsl = parseWslProvider(provider);
    const base = wsl !== null ? wsl.driver.split("#")[0] : provider.split("#")[0];
    return this.drivers.find((entry) => entry.provider === base);
  }

  /** The agents of the running WSL distros, probed at most once a minute. */
  private async wslRowsFor(gateway: { baseUrl: string | null }): Promise<WslRow[]> {
    if ((this.options.platform ?? process.platform) !== "win32") return [];
    if (this.options.wslEnabled?.() === false) return [];
    if (gateway.baseUrl === null) return [];
    const now = Date.now();
    const cached = this.wslCache;
    if (cached !== null && cached.baseUrl === gateway.baseUrl && now - cached.at < 60_000) {
      return cached.rows;
    }
    const rows = await (this.options.wslDiscover ?? discoverWslRows)(gateway.baseUrl, {
      platform: this.options.platform ?? process.platform,
      enabled: this.options.wslEnabled?.() !== false,
    }).catch(() => []);
    this.wslCache = { at: now, baseUrl: gateway.baseUrl, rows };
    return rows;
  }

  /** Reads which agents already point at the gateway, for a harness runner's pick. */
  private async connectedProviders(
    environment: ConnectEnvironment,
    except: string,
  ): Promise<Set<string>> {
    const out = new Set<string>();
    for (const candidate of this.drivers) {
      if (candidate.provider === except || candidate.external?.noConnect === true) continue;
      try {
        if ((await candidate.read(environment)).connected) out.add(candidate.provider);
      } catch {
        // A config that cannot be read counts as not connected.
      }
    }
    return out;
  }

  /**
   * myna's kiroCrewJoin (internal/agent/kirocrew.go): a harness runner keeps
   * its harness when Neolix can wire it, connecting that agent here and
   * remembering that this connect is what put it on; else the first
   * harness already on the gateway. Returns the backend Neolix wrote.
   */
  private async joinHarness(
    driver: AgentConnectDriver,
    environment: ConnectEnvironment,
    gateway: { baseUrl: string | null },
    state: ConnectStateFile,
  ): Promise<string | null> {
    const harness = driver.external?.harness;
    if (harness === undefined) return null;
    if (gateway.baseUrl === null) {
      throw new Error("The gateway is not listening on a TCP port.");
    }
    const connected = await this.connectedProviders(environment, driver.provider);
    const current = await harness.current(environment);
    const wanted = harness.backends.find((entry) => entry.backend === current);
    if (wanted !== undefined) {
      if (connected.has(wanted.agent)) return wanted.backend;
      const harnessDriver = this.drivers.find((entry) => entry.provider === wanted.agent);
      let detected = false;
      if (harnessDriver?.external !== undefined) {
        detected = await harnessDriver.external.detect(environment);
      } else if (harnessDriver !== undefined) {
        detected = await this.providerPresent(harnessDriver, environment);
      }
      if (harnessDriver !== undefined && detected) {
        state.undo[wanted.agent] = await harnessDriver.connect(
          environment,
          null,
          state.undo[wanted.agent],
        );
        state.applied[wanted.agent] = { baseUrl: gateway.baseUrl, model: null };
        state.joined[driver.provider] = wanted.agent;
        return wanted.backend;
      }
    }
    const first = harness.backends.find((entry) => connected.has(entry.agent));
    if (first === undefined) {
      throw new Error(
        `${driver.external?.name ?? driver.provider} runs another agent as its harness: connect ${harness.backends.map((entry) => entry.agent).join(", ")} to the gateway first.`,
      );
    }
    return first.backend;
  }

  /** Whether a Neolix provider has a config on this host to write. */
  private async providerPresent(
    driver: AgentConnectDriver,
    environment: ConnectEnvironment,
  ): Promise<boolean> {
    try {
      await fs.stat(driver.configPath(environment));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * myna's kiroCrewLeave: takes off the harness Neolix connected along with
   * its runner, and only that one — a harness the reader had on already, or
   * has since turned off, is theirs and stays as it is.
   */
  private async leaveHarness(
    driver: AgentConnectDriver,
    environment: ConnectEnvironment,
    state: ConnectStateFile,
  ): Promise<void> {
    const joined = state.joined[driver.provider];
    if (joined === undefined) return;
    delete state.joined[driver.provider];
    const harnessDriver = this.drivers.find((entry) => entry.provider === joined);
    if (harnessDriver === undefined) return;
    let connected = false;
    try {
      connected = (await harnessDriver.read(environment)).connected;
    } catch {
      connected = false;
    }
    if (!connected) return;
    await harnessDriver.disconnect(environment, state.undo[joined]);
    delete state.undo[joined];
    delete state.applied[joined];
  }

  private async disconnectDriver(
    driver: AgentConnectDriver,
    environment: ConnectEnvironment,
    state: ConnectStateFile,
    providerId: string = driver.provider,
  ): Promise<void> {
    await driver.disconnect(environment, state.undo[providerId]);
    delete state.undo[providerId];
    delete state.applied[providerId];
    delete state.catalogs[providerId];
    // The reader turned the harness off themselves: the runner no longer
    // owns that connect.
    for (const [owner, harness] of Object.entries(state.joined)) {
      if (harness === driver.provider) delete state.joined[owner];
    }
    // The shell function points at a gateway the agent no longer uses.
    const shell = driver.external?.shell;
    if (shell !== undefined && (await shell.installed(environment))) {
      await shell.remove(environment);
    }
  }

  /**
   * Puts back each field of a row whose settings are its fields (Aside's
   * four roles), one `provider#field` undo at a time.
   */
  private async disconnectFields(
    driver: AgentConnectDriver,
    environment: ConnectEnvironment,
    state: ConnectStateFile,
    provider: string,
  ): Promise<void> {
    if (driver.external?.fields === undefined) return;
    const fields = await driver.external.fields(environment).catch(() => []);
    for (const field of fields) {
      const fieldId = `${provider}#${field.id}`;
      if (state.undo[fieldId] === undefined) continue;
      await this.disconnectDriver(driver, { ...environment, variant: field.id }, state, fieldId);
    }
  }

  /**
   * Adds or removes Neolix's shell function for an agent, a separate action
   * from connecting it: the reader confirms it on its own row.
   */
  public setShellFunction(input: {
    provider: string;
    enabled: boolean;
  }): Promise<AgentConnectSnapshot> {
    return this.withLock(async (state) => {
      const driver = this.drivers.find((entry) => entry.provider === input.provider);
      const shell = driver?.external?.shell;
      if (!driver || !shell) {
        return this.buildSnapshot(`${input.provider} has no shell function to change.`, state);
      }
      const gateway = this.gateway();
      const environment = this.environment(gateway);
      let error: string | null = null;
      try {
        if (input.enabled) {
          const read = await driver.read(environment);
          await shell.install(environment, read.model ?? gateway.models[0]?.id ?? null);
        } else {
          await shell.remove(environment);
        }
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
      }
      const snapshot = await this.buildSnapshot(error, state);
      if (error === null) {
        this.notify(snapshot);
      }
      return snapshot;
    });
  }

  /**
   * Takes gateway entries out of one agent's own model list, or puts them
   * back (myna's HiddenModels and SetHiddenModels). A connected agent's
   * config is written again with the new list.
   */
  public setModels(input: { provider: string; hidden: string[] }): Promise<AgentConnectSnapshot> {
    return this.withLock(async (state) => {
      const gateway = this.gateway();
      const ids = new Set(gateway.models.map((entry) => entry.id));
      const hidden = uniqueStrings(input.hidden).filter((id) => ids.has(id));
      if (hidden.length === 0) {
        delete state.hiddenModels[input.provider];
      } else {
        state.hiddenModels[input.provider] = hidden;
      }
      // The gateway config is the page's and `neox visible`'s truth; the
      // state above stays for a host that predates it.
      if (this.options.writeVisibility !== undefined) {
        await this.options.writeVisibility(
          input.provider,
          setHiddenModels(gateway.config, input.provider, hidden),
        );
      }
      let error: string | null = null;
      const resolved = await this.resolveProvider(input.provider, gateway);
      if (
        resolved !== null &&
        state.undo[input.provider] !== undefined &&
        gateway.baseUrl !== null
      ) {
        try {
          const environment = this.environment(gateway);
          if (resolved.variant !== undefined) environment.variant = resolved.variant;
          if (resolved.wsl !== undefined) applyWsl(environment, resolved.wsl);
          environment.hiddenModels = hidden;
          const read = await resolved.driver.read(environment);
          if (read.connected) {
            await resolved.driver.connect(environment, read.model, state.undo[input.provider]);
            state.applied[input.provider] = { baseUrl: gateway.baseUrl, model: read.model };
            state.catalogs[input.provider] = this.catalogKey(input.provider, gateway.models);
          }
        } catch (cause) {
          error = cause instanceof Error ? cause.message : String(cause);
        }
      }
      await this.saveState(state);
      const snapshot = await this.buildSnapshot(error, state);
      if (error === null) {
        this.notify(snapshot);
      }
      return snapshot;
    });
  }

  /** Restarts one kind of copy still on its old list, on the reader's click (myna's Restart). */
  public restartStale(input: { provider: string; kind: StaleKind }): Promise<AgentConnectSnapshot> {
    return this.withLock(async (state) => {
      const gateway = this.gateway();
      const resolved = await this.resolveProvider(input.provider, gateway);
      let error: string | null = null;
      if (resolved === null || resolved.driver.restartStale === undefined) {
        error = "Neox cannot restart this agent's copies.";
      } else {
        try {
          const environment = this.environment(gateway);
          if (resolved.variant !== undefined) environment.variant = resolved.variant;
          if (resolved.wsl !== undefined) applyWsl(environment, resolved.wsl);
          const copies = await this.staleFor(resolved.driver, environment);
          const bundle = copies.find((copy) => copy.kind === input.kind)?.bundle;
          const restarted = await resolved.driver.restartStale(environment, input.kind, bundle);
          if (!restarted) {
            error = "Reopen that copy of the agent yourself: Neox cannot restart it.";
          }
          this.stale.delete(resolved.driver.provider);
        } catch (cause) {
          error = cause instanceof Error ? cause.message : String(cause);
        }
      }
      const snapshot = await this.buildSnapshot(error, state);
      if (error === null) this.notify(snapshot);
      return snapshot;
    });
  }

  /** The reader's order and hidden set; a pure Neolix preference, in the same file. */
  public setLayout(input: { order: string[]; hidden: string[] }): Promise<AgentConnectSnapshot> {
    return this.withLock(async (state) => {
      state.order = uniqueStrings(input.order);
      state.hidden = uniqueStrings(input.hidden);
      await this.saveState(state);
      const snapshot = await this.buildSnapshot(null, state);
      this.notify(snapshot);
      return snapshot;
    });
  }

  /**
   * Who the library gives its MCP servers, skills, hooks and instructions
   * to, as myna's profile holds the library's own snapshot. Read through
   * the library service, never from its files.
   */
  private async readLibraryProfile(): Promise<AgentConnectLibrary | undefined> {
    const library = this.options.library?.() ?? null;
    if (library === null) return undefined;
    let snapshot: Awaited<ReturnType<LibraryService["getSnapshot"]>>;
    try {
      snapshot = await library.getSnapshot();
    } catch {
      return undefined;
    }
    const assignments = (items: { name: string; agents: string[] }[]) =>
      Object.fromEntries(items.map((item) => [item.name, [...item.agents]]));
    return {
      mcp: assignments(snapshot.mcp),
      skills: assignments(snapshot.skills),
      hooks: assignments(snapshot.hooks),
      subagents: assignments(snapshot.subagents),
      instructions: snapshot.instructions.agents
        .filter((agent) => agent.on)
        .map((agent) => agent.agent),
      mcpHub: snapshot.mcpHub,
    };
  }

  /** Puts the library's assignments back through the same service. */
  private async restoreLibraryProfile(
    library: AgentConnectLibrary | undefined,
    failures: string[],
  ): Promise<boolean> {
    const service = this.options.library?.() ?? null;
    if (library === undefined || service === null) return false;
    const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));
    const each = async (
      entries: Record<string, string[]> | undefined,
      set: (name: string, agents: string[]) => Promise<unknown>,
      label: string,
    ) => {
      for (const [name, agents] of Object.entries(entries ?? {})) {
        try {
          await set(name, agents);
        } catch (cause) {
          failures.push(`${label} ${name}: ${message(cause)}`);
        }
      }
    };
    await each(library.mcp, (name, agents) => service.setMcpAgents(name, agents), "MCP server");
    await each(library.skills, (name, agents) => service.setSkillAgents(name, agents), "Skill");
    await each(library.hooks, (name, agents) => service.setHookAgents(name, agents), "Hook");
    await each(
      library.subagents,
      (name, agents) => service.setSubagentAgents(name, agents),
      "Subagent",
    );
    if (library.instructions !== undefined) {
      try {
        await service.saveInstructions({ agents: library.instructions });
      } catch (cause) {
        failures.push(`Instructions: ${message(cause)}`);
      }
    }
    if (library.mcpHub !== undefined) {
      try {
        await service.setMcpHub(library.mcpHub);
      } catch (cause) {
        failures.push(`MCP hub: ${message(cause)}`);
      }
    }
    return true;
  }

  public saveProfile(name: string): Promise<AgentConnectSnapshot> {
    return this.withLock(async (state) => {
      const trimmed = name.trim().slice(0, 80);
      if (trimmed.length === 0) {
        return this.buildSnapshot("A profile needs a name.", state);
      }
      const entries = await this.readEntries(this.environment(this.gateway()), state);
      const agents: Record<string, AgentConnectSetup> = {};
      for (const entry of entries) {
        if (!this.driverFor(entry.provider)) continue;
        agents[entry.provider] = { connected: entry.connected, model: entry.model };
        // A row's own fields (Aside's roles) are written as `provider#field`.
        for (const field of entry.fields ?? []) {
          agents[`${entry.provider}#${field.id}`] = {
            connected: field.model !== null,
            model: field.model,
          };
        }
      }
      const profile: AgentConnectProfile = { name: trimmed, savedAt: Date.now(), agents };
      const library = await this.readLibraryProfile();
      if (library !== undefined) profile.library = library;
      state.profiles = [...state.profiles.filter((entry) => entry.name !== trimmed), profile];
      await this.saveState(state);
      const snapshot = await this.buildSnapshot(null, state);
      this.notify(snapshot);
      return snapshot;
    });
  }

  public applyProfile(name: string): Promise<AgentConnectSnapshot> {
    return this.withLock(async (state) => {
      const profile = state.profiles.find((entry) => entry.name === name);
      if (!profile) {
        return this.buildSnapshot(`No profile named ${name}.`, state);
      }
      const gateway = this.gateway();
      const failures: string[] = [];
      let changed = false;
      // Every row the profile holds: an agent's, a QwenPaw agent's, one in
      // a WSL distro. One the host no longer offers is said, not skipped
      // silently.
      for (const [providerId, setup] of Object.entries(profile.agents)) {
        const resolved = await this.resolveProvider(providerId, gateway);
        if (resolved === null) {
          failures.push(`${providerId}: this host no longer has it`);
          continue;
        }
        try {
          const environment = this.environment(gateway);
          if (resolved.variant !== undefined) environment.variant = resolved.variant;
          if (resolved.wsl !== undefined) applyWsl(environment, resolved.wsl);
          if (setup.connected) {
            if (gateway.baseUrl === null) {
              throw new Error("the gateway is not listening on a TCP port");
            }
            // A model the gateway no longer serves falls back to its first,
            // so an old profile still restores a working agent.
            const model =
              setup.model !== null && gateway.models.some((entry) => entry.id === setup.model)
                ? setup.model
                : (gateway.models[0]?.id ?? null);
            environment.hiddenModels = this.hiddenFor(providerId, state);
            state.undo[providerId] = await resolved.driver.connect(
              environment,
              model,
              state.undo[providerId],
            );
            state.applied[providerId] = { baseUrl: gateway.baseUrl, model };
            state.catalogs[providerId] = this.catalogKey(providerId, gateway.models);
          } else if (state.undo[providerId] !== undefined) {
            await resolved.driver.disconnect(environment, state.undo[providerId]);
            delete state.undo[providerId];
            delete state.applied[providerId];
            delete state.catalogs[providerId];
          }
          changed = true;
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause);
          failures.push(`${providerId}: ${message}`);
        }
      }
      // A profile also puts the library's assignments back (who got which
      // MCP server, skill, hook and instructions).
      if (await this.restoreLibraryProfile(profile.library, failures)) changed = true;
      if (changed) {
        await this.saveState(state);
      }
      const snapshot = await this.buildSnapshot(
        failures.length === 0 ? null : failures.join("; "),
        state,
      );
      if (changed) {
        this.notify(snapshot);
      }
      return snapshot;
    });
  }

  /** Renames a saved profile, moving what it holds and keeping when it was saved. */
  public renameProfile(name: string, to: string): Promise<AgentConnectSnapshot> {
    return this.withLock(async (state) => {
      const from = name.trim();
      const target = to.trim().slice(0, 80);
      if (target.length === 0) {
        return this.buildSnapshot("A profile needs a name.", state);
      }
      const existing = state.profiles.find((entry) => entry.name === from);
      if (existing === undefined) {
        return this.buildSnapshot(`No profile named ${from}.`, state);
      }
      // A name that differs only in case is a rename too.
      state.profiles = [
        ...state.profiles.filter((entry) => entry.name !== from && entry.name !== target),
        { ...existing, name: target },
      ];
      await this.saveState(state);
      const snapshot = await this.buildSnapshot(null, state);
      this.notify(snapshot);
      return snapshot;
    });
  }

  public deleteProfile(name: string): Promise<AgentConnectSnapshot> {
    return this.withLock(async (state) => {
      state.profiles = state.profiles.filter((entry) => entry.name !== name);
      await this.saveState(state);
      const snapshot = await this.buildSnapshot(null, state);
      this.notify(snapshot);
      return snapshot;
    });
  }

  private gateway(): {
    config: GatewayConfig;
    baseUrl: string | null;
    models: AgentConnectModel[];
    apiKey: string;
  } {
    const config = this.options.gatewayConfig();
    return {
      config,
      baseUrl: this.options.gatewayBaseUrl(),
      // Chat models only: an image or video model has no session to start.
      models: listGatewayModels(config)
        .filter((entry) => entry.kind === undefined || entry.kind === "chat")
        .map((entry) => {
          const model: AgentConnectModel = { id: entry.id, label: entry.display_name };
          if (entry.context_window !== undefined) model.contextWindow = entry.context_window;
          if (entry.max_output_tokens !== undefined) {
            model.maxOutputTokens = entry.max_output_tokens;
          }
          if (entry.kind !== undefined) model.kind = entry.kind;
          if (entry.images !== undefined) model.images = entry.images;
          return model;
        }),
      apiKey: firstGatewayKey(config) ?? "neolix-local",
    };
  }

  /**
   * The Copilot account's session token and API, for reading its `/models`
   * list once: the account the gateway serves Copilot requests with, else
   * the user's own tool's sign-in. Read-only; the token goes to the driver
   * and is never stored or logged.
   */
  private async copilotModelsSource(): Promise<{ token: string; apiBase: string } | null> {
    try {
      const gatewayDir = path.join(this.options.neolixHome, "gateway");
      const xdg = this.env.XDG_CONFIG_HOME?.trim();
      const configDir =
        xdg !== undefined && xdg.length > 0 && path.isAbsolute(xdg)
          ? xdg
          : path.join(this.homeDir, ".config");
      const account = await loadSubscriptionAccount(gatewayDir, "copilot", "", {
        home: this.homeDir,
        configDir,
      });
      if (account === null) return null;
      const auth = await subscriptionAuth(account);
      if ("error" in auth || auth.baseUrl === undefined) return null;
      const header = auth.headers.authorization ?? "";
      const prefix = "Bearer ";
      if (!header.startsWith(prefix)) return null;
      return { token: header.slice(prefix.length), apiBase: auth.baseUrl };
    } catch {
      return null;
    }
  }

  private environment(gateway: {
    config: GatewayConfig;
    baseUrl: string | null;
    models: AgentConnectModel[];
    apiKey: string;
  }): ConnectEnvironment {
    return {
      homeDir: this.homeDir,
      env: this.env,
      baseUrl: gateway.baseUrl ?? "",
      apiKey: gateway.apiKey,
      models: gateway.models,
      gatewayImageModels: listGatewayModels(gateway.config)
        .filter((entry) => entry.kind === "image")
        .map((entry) => entry.id),
      codex: codexSettings(gateway.config),
      config: gateway.config,
      platform: this.options.platform ?? process.platform,
      neolixHome: this.options.neolixHome,
      copilotModels: () => this.copilotModelsSource(),
      run: this.options.run ?? runProcess,
      writeCredential:
        this.options.writeCredential ??
        ((url, key) =>
          writeSystemCredential(
            url,
            key,
            this.options.platform ?? process.platform,
            this.options.run ?? runProcess,
          )),
      ...(this.options.writeAgentPref === undefined
        ? {}
        : { writeAgentPref: this.options.writeAgentPref }),
    };
  }

  /**
   * Marks the profile the setup as it stands is (myna's profile inUse): its
   * switches, models and library assignments all match. Worked out here,
   * never stored with the profile.
   */
  private async profilesWithInUse(
    entries: AgentConnectEntry[],
    profiles: AgentConnectProfile[],
  ): Promise<AgentConnectProfile[]> {
    if (profiles.length === 0) return profiles;
    const current: Record<string, AgentConnectSetup> = {};
    for (const entry of entries) {
      if (!this.driverFor(entry.provider)) continue;
      current[entry.provider] = { connected: entry.connected, model: entry.model };
      for (const field of entry.fields ?? []) {
        current[`${entry.provider}#${field.id}`] = {
          connected: field.model !== null,
          model: field.model,
        };
      }
    }
    const needsLibrary = profiles.some((profile) => profile.library !== undefined);
    const library = needsLibrary ? await this.readLibraryProfile() : undefined;
    return profiles.map((profile) => {
      const agentsMatch = stableJson(profile.agents) === stableJson(current);
      const libraryMatch =
        profile.library === undefined || stableJson(profile.library) === stableJson(library);
      return agentsMatch && libraryMatch ? { ...profile, inUse: true } : profile;
    });
  }

  private async buildSnapshot(
    error: string | null,
    state?: ConnectStateFile,
  ): Promise<AgentConnectSnapshot> {
    const gateway = this.gateway();
    const resolved = state ?? (await this.loadState());
    const entries = await this.readEntries(this.environment(gateway), resolved);
    const unsupported: AgentConnectEntry[] = AGENT_CONNECT_UNSUPPORTED.map((provider) => ({
      provider,
      configPath: null,
      connected: false,
      model: null,
      modelCount: 0,
      reason: "unsupported" as const,
      drift: null,
    }));
    const launchOnly: AgentConnectEntry[] = LAUNCH_ONLY_PROVIDERS.map((provider) => ({
      provider,
      configPath: null,
      connected: false,
      model: null,
      modelCount: 0,
      reason: "unsupported" as const,
      drift: null,
      launchCommand: launchCommand(provider, gateway),
    }));
    const profiles = await this.profilesWithInUse(entries, resolved.profiles);
    return {
      gatewayBaseUrl: gateway.baseUrl,
      models: gateway.models,
      entries: [...entries, ...unsupported, ...launchOnly],
      profiles,
      order: resolved.order,
      hidden: resolved.hidden,
      pluginProviders: this.options.pluginProviders?.() ?? [],
      error,
    };
  }

  /**
   * A provider's CLI version through the same ten-minute cache the page
   * uses (myna's cliTag); null when that provider has no version probe.
   */
  public async cliVersionOf(provider: string): Promise<string | null> {
    const driver = this.drivers.find((entry) => entry.provider === provider);
    if (driver === undefined) {
      return null;
    }
    return this.cliVersionFor(driver, this.environment(this.gateway()));
  }

  /** The agent CLI's version, asked once every ten minutes (myna's cliTag). */
  private async cliVersionFor(
    driver: AgentConnectDriver,
    environment: ConnectEnvironment,
  ): Promise<string | null> {
    if (this.options.probeVersions !== true || driver.version === undefined) return null;
    const cached = this.versions.get(driver.provider);
    const now = Date.now();
    if (cached !== undefined && now - cached.at < 600_000) return cached.version;
    const version = await driver.version(environment).catch(() => null);
    this.versions.set(driver.provider, { at: now, version });
    return version;
  }

  /** Copies still running on their old list, asked every thirty seconds. */
  private async staleFor(
    driver: AgentConnectDriver,
    environment: ConnectEnvironment,
  ): Promise<StaleCopy[]> {
    if (driver.staleCopies === undefined) return [];
    const cached = this.stale.get(driver.provider);
    const now = Date.now();
    if (cached !== undefined && now - cached.at < 30_000) return cached.copies;
    const copies = await driver.staleCopies(environment).catch(() => []);
    this.stale.set(driver.provider, { at: now, copies });
    return copies;
  }

  /** The agent's own fields, when its driver has a config writer for them. */
  private async driverSettings(
    driver: AgentConnectDriver,
    environment: ConnectEnvironment,
  ): Promise<AgentConnectFieldSetting[]> {
    if (driver.settings === undefined) return [];
    return driver.settings(environment).catch(() => []);
  }

  /**
   * The gateway entries an agent's own list leaves out (myna's ModelOff):
   * what its visibility, its picks and its hidden models take out. Those
   * records live in gateway.json; the connect state's own list answers
   * only until a record is kept there (COMPAT(agentVisibilityInState)).
   */
  private hiddenFor(providerId: string, state: ConnectStateFile): string[] {
    const gateway = this.gateway();
    const key = providerId.trim().toLowerCase();
    const kept =
      gateway.config.visible?.[key] !== undefined ||
      gateway.config.hiddenModels?.[key] !== undefined ||
      gateway.config.pickedModels?.[key] !== undefined;
    if (!kept) return state.hiddenModels[providerId] ?? [];
    const shown = new Set(listGatewayModels(gateway.config, providerId).map((entry) => entry.id));
    return gateway.models.filter((entry) => !shown.has(entry.id)).map((entry) => entry.id);
  }

  /** The models a connected agent's own list carries, and the ones it leaves out. */
  private modelsView(
    providerId: string,
    state: ConnectStateFile,
    gateway: { models: AgentConnectModel[] },
  ): { listed: number; shown: number; hidden: string[] } {
    const hiddenSet = new Set(this.hiddenFor(providerId, state));
    const hidden = gateway.models
      .filter((entry) => hiddenSet.has(entry.id))
      .map((entry) => entry.id);
    return { listed: gateway.models.length, shown: gateway.models.length - hidden.length, hidden };
  }

  private async readEntries(
    environment: ConnectEnvironment,
    state: ConnectStateFile,
  ): Promise<AgentConnectEntry[]> {
    const gateway = this.gateway();
    const reason = gatewayReason(gateway.baseUrl, gateway.models.length);
    const providerEntries = await Promise.all(
      this.drivers
        .filter((driver) => driver.external === undefined)
        .map(async (driver): Promise<AgentConnectEntry> => {
          const configPath = driver.configPath(environment);
          const cliVersion = await this.cliVersionFor(driver, environment);
          try {
            const read = await driver.read(environment);
            const entry: AgentConnectEntry = {
              provider: driver.provider,
              configPath,
              connected: read.connected,
              model: read.model,
              modelCount: read.connected ? gateway.models.length : 0,
              reason,
              drift: driftFor(read, state.applied[driver.provider], gateway),
              launchCommand: null,
            };
            const settings = await this.driverSettings(driver, environment);
            if (settings.length > 0) entry.settings = settings;
            if (read.connected && driver.modelFilter === true) {
              entry.models = this.modelsView(driver.provider, state, gateway);
            }
            if (read.connected) {
              const staleCopies = await this.staleFor(driver, environment);
              if (staleCopies.length > 0) entry.staleCopies = staleCopies;
            }
            if (cliVersion !== null) entry.cliVersion = cliVersion;
            return entry;
          } catch {
            const entry: AgentConnectEntry = {
              provider: driver.provider,
              configPath,
              connected: false,
              model: null,
              modelCount: 0,
              reason,
              drift: null,
              launchCommand: null,
            };
            if (cliVersion !== null) entry.cliVersion = cliVersion;
            return entry;
          }
        }),
    );
    const externalEnvironment: ConnectEnvironment = {
      ...environment,
      connectedAgents: providerEntries
        .filter((entry) => entry.connected)
        .map((entry) => entry.provider),
    };
    const externalEntries = await this.readExternalEntries(externalEnvironment, state, reason);
    return [...providerEntries, ...externalEntries];
  }

  /** Agents Neolix does not provide but can point at its gateway, listed once the host has them. */
  private async readExternalEntries(
    environment: ConnectEnvironment,
    state: ConnectStateFile,
    reason: "gateway_unavailable" | "no_gateway_models" | null,
  ): Promise<AgentConnectEntry[]> {
    const gateway = this.gateway();
    const out: AgentConnectEntry[] = [];
    for (const driver of this.drivers) {
      const info = driver.external;
      if (info === undefined) continue;
      let detected = false;
      try {
        detected = await info.detect(environment);
      } catch {
        detected = false;
      }
      if (!detected) continue;
      let variants: { id: string; name: string }[] = [];
      if (info.variants !== undefined) {
        try {
          variants = await info.variants(environment);
        } catch {
          variants = [];
        }
      }
      for (const variant of [null, ...variants]) {
        out.push(
          await this.externalEntry(driver, info, variant, environment, state, reason, gateway),
        );
      }
    }
    for (const row of await this.wslRowsFor(gateway)) {
      const driver = this.drivers.find(
        (entry) => entry.provider === parseWslProvider(row.provider)?.driver.split("#")[0],
      );
      if (driver === undefined) continue;
      out.push(await this.wslEntry(driver, row, state, reason, gateway));
    }
    return out;
  }

  /** One agent inside a running WSL distro, its home a UNC path and its platform Linux. */
  private async wslEntry(
    driver: AgentConnectDriver,
    row: WslRow,
    state: ConnectStateFile,
    reason: "gateway_unavailable" | "no_gateway_models" | null,
    gateway: {
      config: GatewayConfig;
      baseUrl: string | null;
      models: AgentConnectModel[];
      apiKey: string;
    },
  ): Promise<AgentConnectEntry> {
    const scoped = this.environment(gateway);
    applyWsl(scoped, row);
    let read: { connected: boolean; model: string | null; baseUrl: string | null } = {
      connected: false,
      model: null,
      baseUrl: null,
    };
    try {
      read = await driver.read(scoped);
    } catch {
      read = { connected: false, model: null, baseUrl: null };
    }
    return {
      provider: row.provider,
      configPath: driver.configPath(scoped),
      connected: read.connected,
      model: read.model,
      modelCount: read.connected ? gateway.models.length : 0,
      ...(read.connected && driver.modelFilter === true
        ? { models: this.modelsView(row.provider, state, gateway) }
        : {}),
      reason,
      drift: driftFor(read, state.applied[row.provider], gateway),
      launchCommand: null,
      kind: "external",
      name: row.name,
      icon: row.icon,
    };
  }

  /** One row of an external agent, its host's own or one of its variants'. */
  private async externalEntry(
    driver: AgentConnectDriver,
    info: ExternalAgentInfo,
    variant: { id: string; name: string } | null,
    environment: ConnectEnvironment,
    state: ConnectStateFile,
    reason: "gateway_unavailable" | "no_gateway_models" | null,
    gateway: { baseUrl: string | null; models: AgentConnectModel[] },
  ): Promise<AgentConnectEntry> {
    const scoped = variant === null ? environment : { ...environment, variant: variant.id };
    const providerId = variant === null ? driver.provider : `${driver.provider}#${variant.id}`;
    const read = await this.readExternal(driver, info, scoped);
    const fields = variant === null ? await this.externalFields(info, environment) : [];
    const settings = await this.driverSettings(driver, scoped);
    // A row whose settings live in its fields (Aside's roles) has no undo of
    // its own: the first field's record says whether Neolix wrote it.
    const applied = this.appliedFor(providerId, driver.provider, fields, state);
    return {
      provider: providerId,
      configPath: driver.configPath(scoped),
      connected: read.connected,
      model: read.model,
      modelCount: read.connected ? gateway.models.length : 0,
      ...(settings.length === 0 ? {} : { settings }),
      ...(read.connected && driver.modelFilter === true
        ? { models: this.modelsView(providerId, state, gateway) }
        : {}),
      reason: info.noConnect === true ? "unsupported" : reason,
      drift: info.noConnect === true ? null : driftFor(read, applied, gateway),
      launchCommand: await this.externalLaunch(info, environment, variant, read, gateway),
      kind: "external",
      name: variant === null ? info.name : variant.name,
      icon: info.icon,
      ...(fields.length === 0
        ? {}
        : { fields: fields as NonNullable<AgentConnectEntry["fields"]> }),
      ...(variant !== null || info.shell === undefined
        ? {}
        : { shellInstalled: await info.shell.installed(environment) }),
      ...(variant !== null || info.importLink === undefined
        ? {}
        : { importLink: info.importLink(environment) ?? undefined }),
    };
  }

  private async externalLaunch(
    info: ExternalAgentInfo,
    environment: ConnectEnvironment,
    variant: { id: string; name: string } | null,
    read: { model: string | null },
    gateway: { models: AgentConnectModel[] },
  ): Promise<string | null> {
    if (variant !== null || info.launch === undefined) return null;
    return (await info.launch(environment, read.model ?? gateway.models[0]?.id ?? null)) ?? null;
  }

  /** What the agent's own config says, or nothing when it has no writer. */
  private async readExternal(
    driver: AgentConnectDriver,
    info: ExternalAgentInfo,
    environment: ConnectEnvironment,
  ): Promise<{ connected: boolean; model: string | null; baseUrl: string | null }> {
    if (info.noConnect === true) return { connected: false, model: null, baseUrl: null };
    try {
      return await driver.read(environment);
    } catch {
      return { connected: false, model: null, baseUrl: null };
    }
  }

  private async externalFields(
    info: ExternalAgentInfo,
    environment: ConnectEnvironment,
  ): Promise<ExternalAgentField[]> {
    if (info.fields === undefined) return [];
    try {
      return await info.fields(environment);
    } catch {
      return [];
    }
  }

  private appliedFor(
    providerId: string,
    baseProvider: string,
    fields: ExternalAgentField[],
    state: ConnectStateFile,
  ): AgentConnectApplied | undefined {
    const own = state.applied[providerId];
    if (own !== undefined) return own;
    const first = fields[0];
    return first === undefined ? undefined : state.applied[`${baseProvider}#${first.id}`];
  }

  /** A copy of the agent's config as it was before Neolix first wrote to it. */
  private async backupFile(provider: string, filePath: string): Promise<void> {
    try {
      await fs.stat(filePath);
    } catch {
      return;
    }
    const backupPath = path.join(
      this.options.neolixHome,
      "agent-connect",
      "backups",
      provider,
      path.basename(filePath),
    );
    await fs.mkdir(path.dirname(backupPath), { recursive: true });
    await fs.copyFile(filePath, backupPath);
  }

  private async loadState(): Promise<ConnectStateFile> {
    try {
      const raw = await fs.readFile(this.statePath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null) {
        return structuredClone(EMPTY_STATE);
      }
      const record = parsed as Partial<ConnectStateFile>;
      return {
        version: 1,
        undo: isRecord(record.undo) ? (record.undo as Record<string, AgentConnectUndo>) : {},
        profiles: Array.isArray(record.profiles) ? (record.profiles as AgentConnectProfile[]) : [],
        applied: isRecord(record.applied)
          ? (record.applied as Record<string, AgentConnectApplied>)
          : {},
        joined: isRecord(record.joined) ? (record.joined as Record<string, string>) : {},
        catalogs: isRecord(record.catalogs) ? (record.catalogs as Record<string, string>) : {},
        hiddenModels: isRecord(record.hiddenModels)
          ? Object.fromEntries(
              Object.entries(record.hiddenModels as Record<string, unknown>)
                .filter((entry): entry is [string, unknown[]] => Array.isArray(entry[1]))
                .map(([key, ids]) => [key, stringArray(ids)]),
            )
          : {},
        order: stringArray(record.order),
        hidden: stringArray(record.hidden),
      };
    } catch {
      return structuredClone(EMPTY_STATE);
    }
  }

  private async saveState(state: ConnectStateFile): Promise<void> {
    await writeJsonFileAtomic(this.statePath, state);
  }

  private withLock<T>(work: (state: ConnectStateFile) => Promise<T> | T): Promise<T> {
    const run = this.queue.then(async () => {
      const state = await this.loadState();
      return work(state);
    });
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

function gatewayReason(
  baseUrl: string | null,
  modelCount: number,
): "gateway_unavailable" | "no_gateway_models" | null {
  if (baseUrl === null) return "gateway_unavailable";
  if (modelCount === 0) return "no_gateway_models";
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

/**
 * Compares what Neolix last wrote with what the agent's config says now.
 * Only judged while the gateway has an address to compare against.
 */
function driftFor(
  read: { connected: boolean; model: string | null; baseUrl: string | null },
  applied: AgentConnectApplied | undefined,
  gateway: { baseUrl: string | null; models: AgentConnectModel[] },
): AgentConnectDrift | null {
  const expected = gateway.baseUrl;
  if (applied === undefined || expected === null) {
    return null;
  }
  if (!read.connected) {
    // Still the address Neolix wrote, but the gateway moved: reapply. Any
    // other address means the agent (or its user) rewired it.
    return read.baseUrl !== null && read.baseUrl === applied.baseUrl && read.baseUrl !== expected
      ? "stale"
      : "unwired";
  }
  if (read.baseUrl !== null && read.baseUrl !== expected) {
    return "stale";
  }
  if (read.model !== null && !gateway.models.some((model) => model.id === read.model)) {
    return "stale";
  }
  return null;
}

function shellQuote(value: string): string {
  return `'${value.split("'").join(`'\\''`)}'`;
}

/** myna's agy launch line: the Gemini variables, then the model. */
function launchCommand(
  provider: string,
  gateway: { baseUrl: string | null; apiKey: string; models: AgentConnectModel[] },
  platform: NodeJS.Platform = process.platform,
): string | null {
  const model = gateway.models[0]?.id;
  if (provider !== "antigravity" || gateway.baseUrl === null || model === undefined) {
    return null;
  }
  const key = shellQuote(gateway.apiKey);
  const baseUrl = shellQuote(gateway.baseUrl);
  const modelArg = shellQuote(model);
  if (platform === "win32") {
    return `$env:GEMINI_API_KEY=${key}; $env:GOOGLE_GEMINI_BASE_URL=${baseUrl}; agy --model ${modelArg}`;
  }
  return `GEMINI_API_KEY=${key} GOOGLE_GEMINI_BASE_URL=${baseUrl} agy --model ${modelArg}`;
}

function firstGatewayKey(config: GatewayConfig): string | null {
  for (const entry of config.keys) {
    if (typeof entry === "string" && entry.length > 0) {
      return entry;
    }
    if (typeof entry === "object" && entry !== null && "key" in entry) {
      const key = (entry as { key?: unknown }).key;
      if (typeof key === "string" && key.length > 0) {
        return key;
      }
    }
  }
  return null;
}

export function createAgentConnectService(
  options: AgentConnectServiceOptions,
): AgentConnectService {
  return new AgentConnectService(options);
}

const sharedServices = new Map<string, AgentConnectService>();
const sharedConfigSubscriptions = new Map<string, () => void>();

/**
 * One service per daemon home: every client session writes the same state
 * file and the same agent configs, so they must share one queue.
 */
export function sharedAgentConnectService(
  options: AgentConnectServiceOptions,
): AgentConnectService {
  const existing = sharedServices.get(options.neolixHome);
  if (existing) return existing;
  const created = createAgentConnectService(options);
  if (options.startScienceKeeper === true) void created.startScienceKeeper();
  created.startGatewayFollow();
  // One subscription per daemon home, not one per client session: a
  // gateway config change (a visibility edit, a provider moving) rewrites
  // the agents' own lists at once, as myna's SetVisible does.
  const stop = options.watchGatewayConfig?.(() => {
    void created.refreshModels().catch(() => undefined);
  });
  if (stop !== undefined) sharedConfigSubscriptions.set(options.neolixHome, stop);
  sharedServices.set(options.neolixHome, created);
  return created;
}

/** Ends the shared services and their config subscriptions (daemon shutdown, tests). */
export function disposeSharedAgentConnectServices(): void {
  for (const stop of sharedConfigSubscriptions.values()) stop();
  sharedConfigSubscriptions.clear();
  sharedServices.clear();
}
