// Server-level reads the front end makes before it renders anything: who the host is, its
// configuration, settings, and provider availability. Values come from Neox where it has an
// equivalent and from Synara's own defaults otherwise.
import * as os from "node:os";
import {
  DEFAULT_SERVER_SETTINGS_VIEW,
  type ExecutionEnvironmentDescriptor,
  type ResolvedKeybindingsConfig,
  type ServerConfig,
  type ServerConfigIssue,
  type ServerProviderStatus,
  type ServerRuntimeStatus,
  type ServerSettingsView,
} from "@synara/contracts";

import { DEFAULT_RESOLVED_KEYBINDINGS } from "./keybindings.ts";
import { defaultModelId } from "./providerRpc.ts";
import { bridgeError } from "./rpcErrors.ts";
import type { DaemonClient } from "./neolix.ts";
import { deriveProviderSettingsFromDaemon, OPT_IN_DRIVERS } from "./providerConfig.ts";
import {
  driverForProvider,
  instanceIdForProvider,
  providerInstanceConfigs,
  type ProviderDirectory,
} from "./providers.ts";

const PROVIDER_LABEL: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  copilot: "GitHub Copilot",
  opencode: "OpenCode",
  pi: "Pi",
  antigravity: "Antigravity",
  "neolix-gateway": "Neox Gateway",
};

function platformOs(): ExecutionEnvironmentDescriptor["platform"]["os"] {
  switch (process.platform) {
    case "darwin":
      return "darwin";
    case "linux":
      return "linux";
    case "win32":
      return "windows";
    default:
      return "unknown";
  }
}

function platformArch(): ExecutionEnvironmentDescriptor["platform"]["arch"] {
  return process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : "other";
}

/**
 * A daemon's stable identity. `serverId` survives port changes and reconnects, unlike the
 * endpoint the bridge dials; the endpoint is only a transport address.
 */
export function environmentIdFor(client: DaemonClient, fallback: string): string {
  const serverId = client.getLastServerInfoMessage()?.serverId?.trim();
  return serverId && serverId.length > 0 ? serverId : fallback;
}

/** The pre-0.16.5 scope key, derived from the address. Read only to migrate stored state. */
export function legacyEnvironmentId(daemonHost: string): string {
  return `neolix-${daemonHost.replace(/[^A-Za-z0-9]/g, "-")}`;
}

/** The release channel a version string belongs to; null when the version says nothing. */
export function channelFromVersion(
  version: string | null | undefined,
): ExecutionEnvironmentDescriptor["channel"] | null {
  const trimmed = version?.trim() ?? "";
  if (!trimmed) return null;
  // A version that is not semver says nothing about the channel; only a parseable release
  // with no pre-release suffix is stable.
  const match = /^\d+\.\d+\.\d+(?:-([0-9A-Za-z.-]+))?$/.exec(trimmed);
  if (!match) return null;
  const prerelease = match[1]?.toLowerCase();
  if (!prerelease) return "stable";
  if (prerelease.startsWith("beta")) return "beta";
  if (prerelease.startsWith("canary")) return "canary";
  if (prerelease.startsWith("dev")) return "dev";
  return null;
}

function featureEnabled(features: unknown, name: string): boolean {
  return (
    typeof features === "object" &&
    features !== null &&
    (features as Record<string, unknown>)[name] === true
  );
}

export interface EnvironmentDescriptorInput {
  readonly environmentId: string;
  /** The daemon's own version from `server_info`; null before it arrives. */
  readonly serverVersion?: string | null | undefined;
  /** `server_info.features`, the daemon's capability flags. */
  readonly features?: unknown;
  readonly label?: string | undefined;
  readonly hostname?: string | null | undefined;
  readonly platform?: ExecutionEnvironmentDescriptor["platform"] | undefined;
}

export function environmentDescriptor(
  input: EnvironmentDescriptorInput,
): ExecutionEnvironmentDescriptor {
  const version = input.serverVersion?.trim() || null;
  const channel = channelFromVersion(version);
  // The bridge holds the outbound host sessions, so remote surfaces are real. Neox has no
  // account directory behind repository identity, and a daemon that cannot list or route
  // hosts cannot offer remote connections at all.
  const remoteConnections =
    featureEnabled(input.features, "connectedHosts") &&
    featureEnabled(input.features, "hostMultiplexing");
  return {
    environmentId: input.environmentId as ExecutionEnvironmentDescriptor["environmentId"],
    ...(channel ? { channel } : {}),
    label: input.label?.trim() || input.hostname?.trim() || os.hostname() || "Neox",
    platform: input.platform ?? { os: platformOs(), arch: platformArch() },
    // A daemon that has not sent server_info yet has no version to report; "unknown" is
    // honest, where the previous bridge build string was not.
    serverVersion: version ?? "unknown",
    capabilities: { repositoryIdentity: false, remoteConnections, remoteResources: true },
  } as ExecutionEnvironmentDescriptor;
}

interface NeolixProviderEntry {
  readonly provider: string;
  readonly available: boolean;
  readonly error: string | null;
}

/**
 * Display names the daemon reports for providers outside {@link PROVIDER_LABEL} (plugin and
 * custom providers), per daemon connection. Fetched only when an unnamed provider appears.
 */
const daemonProviderLabels = new WeakMap<DaemonClient, Map<string, string>>();

async function rememberDaemonLabels(
  client: DaemonClient,
  providers: readonly string[],
): Promise<Map<string, string>> {
  const labels = daemonProviderLabels.get(client) ?? new Map<string, string>();
  daemonProviderLabels.set(client, labels);
  if (providers.every((provider) => PROVIDER_LABEL[provider] || labels.has(provider))) {
    return labels;
  }
  try {
    const snapshot = await client.getProvidersSnapshot();
    for (const entry of snapshot.entries) {
      const label = entry.label?.trim();
      if (label) labels.set(entry.provider, label);
    }
  } catch {
    // Names are cosmetic: without the snapshot the provider id stands in.
  }
  // Ask once per provider: one the daemon gave no name keeps its id instead of re-asking.
  for (const provider of providers) {
    if (!PROVIDER_LABEL[provider] && !labels.has(provider)) labels.set(provider, provider);
  }
  return labels;
}

async function listProviders(
  client: DaemonClient,
  directory: ProviderDirectory,
): Promise<{
  readonly entries: NeolixProviderEntry[];
  readonly label: (provider: string) => string;
}> {
  const { providers } = await client.listAvailableProviders();
  const entries = providers as NeolixProviderEntry[];
  directory.update(entries.map((entry) => entry.provider));
  const labels = await rememberDaemonLabels(
    client,
    entries.map((entry) => entry.provider),
  );
  return {
    entries,
    label: (provider) => PROVIDER_LABEL[provider] ?? labels.get(provider) ?? provider,
  };
}

export async function providerStatuses(
  client: DaemonClient,
  directory: ProviderDirectory,
): Promise<ServerProviderStatus[]> {
  const checkedAt = new Date().toISOString();
  const { entries, label } = await listProviders(client, directory);
  return entries.map((entry) => {
    const driver = driverForProvider(entry.provider);
    return {
      provider: driver,
      instanceId: instanceIdForProvider(entry.provider),
      driver,
      displayName: label(entry.provider),
      enabled: true,
      status: entry.available ? "ready" : "error",
      available: entry.available,
      ...(entry.error ? { message: entry.error } : {}),
      authStatus: entry.available ? "authenticated" : "unknown",
      checkedAt,
    } as ServerProviderStatus;
  });
}

export interface KeybindingsConfigSource {
  readonly path: string;
  readonly resolved: ResolvedKeybindingsConfig;
  readonly issues: readonly ServerConfigIssue[];
}

export interface HostPaths {
  /** The host's working directory: the daemon's home folder, or this machine's for the controller. */
  readonly cwd: string;
  /** The host's home folder when it reports one. */
  readonly homeDir?: string | undefined;
  /** The daemon's worktree base; `<home>/worktrees` unless the daemon configured one. */
  readonly worktreesDir: string;
}

export interface ServerConfigPaths extends HostPaths {
  readonly keybindings: KeybindingsConfigSource;
}

export async function serverConfig(
  client: DaemonClient,
  directory: ProviderDirectory,
  paths: ServerConfigPaths,
): Promise<ServerConfig> {
  return {
    cwd: paths.cwd,
    ...(paths.homeDir ? { homeDir: paths.homeDir } : {}),
    worktreesDir: paths.worktreesDir,
    // Bridge-local: the shortcut editor writes this file through the bridge, so the path is
    // the bridge's own, not a synthesized `~/.neox` on the control machine.
    keybindingsConfigPath: paths.keybindings.path,
    keybindings: paths.keybindings.resolved,
    defaultKeybindings: DEFAULT_RESOLVED_KEYBINDINGS,
    issues: [...paths.keybindings.issues],
    providers: await providerStatuses(client, directory),
    availableEditors: [],
  } as ServerConfig;
}

/**
 * Synara's defaults plus one provider instance per Neox provider that is not a driver's
 * default (the gateway); without the entry the front end cannot resolve those threads'
 * instance and falls back to another provider's models.
 */
const defaultModels = new Map<string, Promise<string | null>>();

/** Listing models starts the provider CLI, so the default is read once per bridge process. */
function cachedDefaultModel(client: DaemonClient, neolixProvider: string): Promise<string | null> {
  let pending = defaultModels.get(neolixProvider);
  if (!pending) {
    pending = defaultModelId(client, neolixProvider).catch(() => {
      defaultModels.delete(neolixProvider);
      return null;
    });
    defaultModels.set(neolixProvider, pending);
  }
  return pending;
}

export async function serverSettings(
  client: DaemonClient,
  directory: ProviderDirectory,
): Promise<ServerSettingsView> {
  // Provider launch config lives in the daemon's `agents.providers`; the settings view is
  // derived from it so this front end edits the same entries the daemon launches with.
  const [{ entries, label }, daemonConfig] = await Promise.all([
    listProviders(client, directory),
    client
      .getDaemonConfig()
      .then((result) => result.config as Record<string, unknown>)
      .catch(() => null),
  ]);
  const derived = deriveProviderSettingsFromDaemon(
    daemonConfig?.providers as Record<string, unknown> | undefined,
  );
  // New chats start on Claude, Neox's primary provider, rather than Synara's Codex default.
  const claude = entries.find((entry) => entry.provider === "claude" && entry.available);
  const instanceId = claude ? instanceIdForProvider(claude.provider) : null;
  // The daemon marks its default model; without it the picker would start on whichever model
  // the front end ranks first, which for ids outside its catalog is an arbitrary one.
  const model = claude ? await cachedDefaultModel(client, claude.provider) : null;
  const providers = { ...DEFAULT_SERVER_SETTINGS_VIEW.providers };
  // Synara enables every driver by default; the daemon runs these only once its config says
  // so, and without a status the settings row would sit on "checking" forever.
  for (const driver of OPT_IN_DRIVERS) {
    if (driver in providers) {
      providers[driver as keyof typeof providers] = {
        ...providers[driver as keyof typeof providers],
        enabled: false,
      } as never;
    }
  }
  for (const [driver, settings] of Object.entries(derived.providers)) {
    if (driver in providers) {
      providers[driver as keyof typeof providers] = {
        ...providers[driver as keyof typeof providers],
        ...(settings as object),
      } as never;
    }
  }
  return {
    ...DEFAULT_SERVER_SETTINGS_VIEW,
    providers,
    providerInstances: {
      ...providerInstanceConfigs(entries, label),
      ...derived.providerInstances,
    },
    newThreadDefaults: {
      ...DEFAULT_SERVER_SETTINGS_VIEW.newThreadDefaults,
      // Least privilege: a new chat asks before edits and commands until the user picks a
      // broader mode, which the saved settings then keep (Synara ships full access).
      runtimeMode: "approval-required",
      ...(instanceId
        ? {
            activeProvider: instanceId,
            modelSelectionByProvider: model
              ? { [instanceId]: { provider: driverForProvider("claude"), instanceId, model } }
              : {},
          }
        : {}),
    },
  } as ServerSettingsView;
}

/**
 * The daemon's real event-loop window. The capability is advertised only when the daemon
 * serves the metrics RPC, so an older host's client takes its update-server path; a direct
 * call here fails with the same instruction rather than inventing zeros.
 */
export async function runtimeStatus(client: DaemonClient): Promise<ServerRuntimeStatus> {
  if (client.getLastServerInfoMessage()?.features?.daemonRuntimeStatus !== true) {
    throw bridgeError("host.update-required", "Update the host to read runtime status.");
  }
  const status = await client.getDaemonRuntimeStatus();
  return {
    available: true,
    sampleWindowMs: status.sampleWindowMs,
    sampleCount: status.sampleCount,
    delayP50Ms: status.delayP50Ms,
    delayP99Ms: status.delayP99Ms,
    delayMaxMs: status.delayMaxMs,
    utilization: status.utilization,
    stallWindowCount: status.stallWindowCount,
    maxStallMs: status.maxStallMs,
    lastStall: status.lastStall,
  } as ServerRuntimeStatus;
}

/**
 * The daemon's resolved worktree base, including a custom `worktrees.root`. Older daemons
 * only ever had the documented default, so that is the one answer they can give.
 */
export async function worktreesDirFor(client: DaemonClient, fallbackDir: string): Promise<string> {
  // COMPAT(daemonWorktreesRoot): added in v0.17.0, remove after 2027-05-14 once the daemon
  // floor serves `daemon.get_status.worktreesRoot`.
  if (client.getLastServerInfoMessage()?.features?.daemonWorktreesRoot !== true) return fallbackDir;
  const status = await client.getDaemonStatus();
  const root = status.worktreesRoot?.trim();
  return root && root.length > 0 ? root : fallbackDir;
}
