import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { GATEWAY_PROVIDER_PRESETS } from "@neolix/protocol/gateway-presets";
import { BUILTIN_PROVIDER_IDS } from "@neolix/protocol/provider-manifest";

import { writePrivateFileAtomic } from "../private-files.js";

/**
 * Neolix's daily anonymous usage ping. Off unless the user opts in under
 * Settings › Privacy; DO_NOT_TRACK and NEOLIX_NO_TELEMETRY force it off.
 * It sends a random id made on this computer, the daemon version and the
 * system, plus, when the user shares usage too, the built-in names of the
 * agents, providers and models in use. Never prompts, files, paths,
 * accounts, keys, costs, or errors.
 */

const POSTHOG_KEY = "phc_nyDyYyrUTRGvNq5U7FBesCyM2j4GdKeqGp8ko7DBerTC";
const POSTHOG_ENDPOINT = "https://us.i.posthog.com/batch/";
const REQUEST_TIMEOUT_MS = 20_000;
const HOUR_MS = 60 * 60 * 1000;
const ID_FILENAME = "telemetry-id";
const SENT_FILENAME = "telemetry-sent";
const MAX_PER_KIND = 50;

export interface TelemetryConfig {
  enabled?: boolean;
  shareUsage?: boolean;
  decidedAt?: string;
}

/** One gateway provider, as much as the ping needs to name it. */
export interface TelemetryProvider {
  preset?: string;
  baseUrl?: string;
  models?: readonly string[];
}

/** The in-memory/config snapshot the ping reads. */
export interface TelemetryUsageSnapshot {
  /** Agent provider ids, as this daemon registered them. */
  agents: readonly string[];
  /** Gateway providers that are on. */
  providers: readonly TelemetryProvider[];
  /** Routing groups the models page shows. */
  groups: number;
}

export interface TelemetryServiceOptions {
  neolixHome: string;
  version: string;
  config: () => TelemetryConfig;
  usage: () => TelemetryUsageSnapshot;
  logger?: {
    child(bindings: Record<string, unknown>): TelemetryServiceOptions["logger"];
    debug(...args: unknown[]): void;
    warn(...args: unknown[]): void;
  };
  env?: NodeJS.ProcessEnv;
  endpoint?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  intervalMs?: number;
}

interface TelemetryLogger {
  debug(...args: unknown[]): void;
  warn(...args: unknown[]): void;
}

export interface NormalizedUsage {
  agents: string[];
  providers: string[];
  models: string[];
  groups: number;
}

const KNOWN_PRESET_IDS = new Set(GATEWAY_PROVIDER_PRESETS.map((preset) => preset.id));
const PRESET_MODELS = new Map(
  GATEWAY_PROVIDER_PRESETS.filter((preset) => preset.models !== undefined).map((preset) => [
    preset.id,
    new Set(preset.models),
  ]),
);
const BUILTIN_AGENT_IDS = new Set<string>(BUILTIN_PROVIDER_IDS);

/** An agent as the ping names it: its built-in id without a profile or WSL suffix. */
export function normalizeAgentId(id: string): string {
  const withoutWsl = id.split("@wsl:")[0] ?? id;
  const base = withoutWsl.split("#")[0] ?? withoutWsl;
  return BUILTIN_AGENT_IDS.has(base) ? base : "plugin";
}

/** A gateway provider as the ping names it: a known preset's id, or nothing the user typed. */
export function normalizeProviderId(provider: TelemetryProvider): string {
  if ((provider.baseUrl ?? "").startsWith("plugin://")) {
    return "plugin";
  }
  const preset = (provider.preset ?? "").trim().toLowerCase();
  return KNOWN_PRESET_IDS.has(preset) ? preset : "custom";
}

function modelLabels(provider: TelemetryProvider): string[] {
  const label = normalizeProviderId(provider);
  if (label === "custom" || label === "plugin") {
    return [label];
  }
  const known = PRESET_MODELS.get(label);
  return (provider.models ?? []).map((model) =>
    known && !known.has(model) ? `${label}/other` : `${label}/${model}`,
  );
}

function uniqueCapped(values: Iterable<string>, seen: Set<string>): string[] {
  for (const value of values) {
    if (seen.size >= MAX_PER_KIND) break;
    if (value.length > 0) seen.add(value);
  }
  return [...seen];
}

export function normalizeUsage(snapshot: TelemetryUsageSnapshot): NormalizedUsage {
  const agentSeen = new Set<string>();
  for (const agent of snapshot.agents) {
    agentSeen.add(normalizeAgentId(agent));
  }
  const agents = uniqueCapped(agentSeen, new Set<string>());

  const providerSeen = new Set<string>();
  const modelSeen = new Set<string>();
  for (const provider of snapshot.providers) {
    if (providerSeen.size >= MAX_PER_KIND && modelSeen.size >= MAX_PER_KIND) break;
    providerSeen.add(normalizeProviderId(provider));
    for (const model of modelLabels(provider)) {
      if (modelSeen.size >= MAX_PER_KIND) break;
      modelSeen.add(model);
    }
  }
  return {
    agents,
    providers: uniqueCapped(providerSeen, new Set<string>()),
    models: uniqueCapped(modelSeen, new Set<string>()),
    groups: snapshot.groups,
  };
}

function osName(platform: NodeJS.Platform = process.platform): string {
  switch (platform) {
    case "darwin":
      return "Mac OS X";
    case "win32":
      return "Windows";
    case "linux":
      return "Linux";
    default:
      return platform;
  }
}

function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function forcedOff(env: NodeJS.ProcessEnv): boolean {
  const doNotTrack = env.DO_NOT_TRACK;
  if (
    doNotTrack !== undefined &&
    doNotTrack !== "" &&
    doNotTrack !== "0" &&
    doNotTrack !== "false"
  ) {
    return true;
  }
  const noTelemetry = env.NEOLIX_NO_TELEMETRY;
  return (
    noTelemetry !== undefined &&
    noTelemetry !== "" &&
    noTelemetry !== "0" &&
    noTelemetry !== "false"
  );
}

export class TelemetryService {
  private readonly neolixHome: string;
  private readonly version: string;
  private readonly readConfig: () => TelemetryConfig;
  private readonly readUsage: () => TelemetryUsageSnapshot;
  private readonly env: NodeJS.ProcessEnv;
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly intervalMs: number;
  private readonly logger: TelemetryLogger | undefined;
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private requestAbort: AbortController | null = null;

  constructor(options: TelemetryServiceOptions) {
    this.neolixHome = options.neolixHome;
    this.version = options.version;
    this.readConfig = options.config;
    this.readUsage = options.usage;
    this.env = options.env ?? process.env;
    this.endpoint = options.endpoint ?? POSTHOG_ENDPOINT;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.intervalMs = options.intervalMs ?? HOUR_MS;
    this.logger = options.logger
      ? {
          debug: (...args) => options.logger?.debug(...args),
          warn: (...args) => options.logger?.warn(...args),
        }
      : undefined;
  }

  /** Starts the hourly check. Never blocks the daemon: the first send is asynchronous. */
  start(): void {
    if (this.timer !== null || !this.enabled()) {
      return;
    }
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref?.();
    void this.tick();
  }

  /** Re-reads the setting after a config change and starts or stops the check. */
  refresh(): void {
    if (!this.enabled()) {
      this.stop();
      return;
    }
    if (this.timer === null) {
      this.start();
    }
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.requestAbort?.abort();
    this.requestAbort = null;
  }

  /** Stops the timer and waits for the request in flight, if any. */
  async stopAndDrain(): Promise<void> {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.inFlight?.catch(() => undefined);
  }

  private enabled(): boolean {
    return this.readConfig().enabled === true && !forcedOff(this.env);
  }

  private tick(): Promise<void> {
    if (this.inFlight !== null) {
      return this.inFlight;
    }
    this.inFlight = this.sendIfDue()
      .then(
        () => undefined,
        (error) => {
          this.logger?.debug({ err: error }, "Telemetry send failed; retrying next hour");
        },
      )
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  /**
   * Sends today's ping unless it already went or the user turned sharing
   * off. Returns whether a request was made and answered 2xx.
   */
  async sendIfDue(): Promise<boolean> {
    if (!this.enabled()) {
      return false;
    }
    const now = this.now();
    const day = utcDay(now);
    if ((await this.readSentDay()) === day) {
      return false;
    }

    const id = await this.getOrCreateId();
    const config = this.readConfig();
    const usage = config.shareUsage === true ? normalizeUsage(this.readUsage()) : null;
    const timestamp = now.toISOString();

    const event = (name: string, properties: Record<string, unknown>) => ({
      event: name,
      distinct_id: id,
      timestamp,
      properties: {
        ...properties,
        $process_person_profile: false,
        distinct_id: id,
      },
    });

    const active: Record<string, unknown> = {
      version: this.version,
      kind: "daemon",
      $os: osName(),
      arch: process.arch,
    };
    const batch: ReturnType<typeof event>[] = [];
    if (usage !== null) {
      active.agents = usage.agents.length;
      active.providers = usage.providers.length;
      active.models = usage.models.length;
      active.groups = usage.groups;
      for (const [kind, ids] of [
        ["agent", usage.agents],
        ["provider", usage.providers],
        ["model", usage.models],
      ] as const) {
        for (const value of ids) {
          batch.push(event("neolix uses", { kind, id: value }));
        }
      }
    }
    batch.unshift(event("neolix active", active));

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    timeout.unref?.();
    this.requestAbort = controller;
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: POSTHOG_KEY, batch }),
        signal: controller.signal,
      });
      if (!response.ok) {
        this.logger?.debug({ status: response.status }, "Telemetry endpoint refused the ping");
        return false;
      }
    } finally {
      clearTimeout(timeout);
      if (this.requestAbort === controller) {
        this.requestAbort = null;
      }
    }
    await writePrivateFileAtomic(path.join(this.neolixHome, SENT_FILENAME), `${day}\n`);
    return true;
  }

  private async readSentDay(): Promise<string | null> {
    try {
      const raw = await readFile(path.join(this.neolixHome, SENT_FILENAME), "utf8");
      return raw.trim() || null;
    } catch {
      return null;
    }
  }

  /** This computer's ping id, made up the first time: random, tied to nothing. */
  private async getOrCreateId(): Promise<string> {
    const idPath = path.join(this.neolixHome, ID_FILENAME);
    try {
      const existing = (await readFile(idPath, "utf8")).trim();
      if (/^[0-9a-f]{32}$/.test(existing)) {
        return existing;
      }
    } catch {
      // Missing or unreadable: make a new one below.
    }
    const id = randomBytes(16).toString("hex");
    await writePrivateFileAtomic(idPath, `${id}\n`);
    return id;
  }
}
