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

export function environmentDescriptor(
  serverId: string,
  options: { readonly label?: string | undefined } = {},
): ExecutionEnvironmentDescriptor {
  return {
    environmentId: serverId as ExecutionEnvironmentDescriptor["environmentId"],
    channel: "dev",
    label: options.label?.trim() || os.hostname() || "Neox",
    platform: { os: platformOs(), arch: platformArch() },
    serverVersion: "neolix-bridge-0.0.0",
    // The bridge is the shell that holds the outbound sessions, so the front end may
    // offer its native multi-host surfaces. There is no account directory behind them.
    capabilities: { repositoryIdentity: false, remoteConnections: true, remoteResources: true },
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

export async function serverConfig(
  client: DaemonClient,
  directory: ProviderDirectory,
  cwd: string,
  keybindings?: KeybindingsConfigSource,
): Promise<ServerConfig> {
  return {
    cwd,
    homeDir: os.homedir(),
    worktreesDir: `${os.homedir()}/.neox/worktrees`,
    keybindingsConfigPath: keybindings?.path ?? `${os.homedir()}/.neox/keybindings.json`,
    keybindings: keybindings?.resolved ?? DEFAULT_RESOLVED_KEYBINDINGS,
    defaultKeybindings: DEFAULT_RESOLVED_KEYBINDINGS,
    issues: keybindings ? [...keybindings.issues] : [],
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

export function runtimeStatus(): ServerRuntimeStatus {
  return {
    available: true,
    sampleWindowMs: 0,
    sampleCount: 0,
    delayP50Ms: 0,
    delayP99Ms: 0,
    delayMaxMs: 0,
    utilization: 0,
    stallWindowCount: 0,
    maxStallMs: 0,
    lastStall: null,
  } as ServerRuntimeStatus;
}
