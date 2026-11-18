import { configurationEnvironment } from "./config-environment.js";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveNeolixNodeEnv } from "./neolix-env.js";
import { z } from "zod";
import { expandTilde } from "../utils/path.js";

import type { NeolixDaemonConfig } from "./bootstrap.js";
import {
  loadPersistedConfig,
  LogFormatSchema,
  LogLevelSchema,
  type PersistedConfig,
} from "./persisted-config.js";
import type { AgentProvider } from "./agent/agent-sdk-types.js";
import type {
  AgentProviderRuntimeSettingsMap,
  ProviderOverride,
} from "./agent/provider-launch-config.js";
import { ProviderOverrideSchema } from "./agent/provider-launch-config.js";
import { AgentProviderSchema } from "@neolix/protocol/provider-manifest";
import { hashDaemonPassword } from "./auth.js";
import { resolveSpeechConfig } from "./speech/speech-config-resolver.js";
import { readSpeechSettings } from "./speech/speech-settings.js";
import { mergeHostnames, parseHostnamesEnv, type HostnamesConfig } from "./hostnames.js";
import { resolveGitProcessPolicy } from "../utils/git-process-scheduler.js";
import { resolveListenAddress } from "./listen-address.js";
import { webAppCandidates } from "./web-app-paths.js";

export {
  loadPersistedConfig,
  readPersistedConfig,
  savePersistedConfig,
  getPersistedConfigValue,
  editPersistedConfig,
  type PersistedConfig,
} from "./persisted-config.js";

const DEFAULT_TRUSTED_PROXIES = ["loopback"];

interface ResolveBundledWebUiDistDirInput {
  moduleUrl?: string | URL;
  resourcesPath?: string;
}

export function resolveBundledWebUiDistDir(input: ResolveBundledWebUiDistDirInput = {}): string {
  const moduleUrl = input.moduleUrl ?? import.meta.url;
  const moduleDir = path.dirname(fileURLToPath(moduleUrl));

  if (path.basename(moduleDir) === "server" && path.basename(path.dirname(moduleDir)) === "src") {
    return path.resolve(moduleDir, "..", "..", "dist", "server", "web-app", "web");
  }

  if (
    path.basename(moduleDir) === "server" &&
    path.basename(path.dirname(moduleDir)) === "server" &&
    path.basename(path.dirname(path.dirname(moduleDir))) === "dist"
  ) {
    const packagedDistDir = input.resourcesPath
      ? path.join(input.resourcesPath, "desktop-web", "web")
      : null;

    if (packagedDistDir && existsSync(packagedDistDir)) {
      return packagedDistDir;
    }

    return path.resolve(moduleDir, "..", "web-app", "web");
  }

  return path.resolve(moduleDir, "web-app", "web");
}

const processResourcesPath = "resourcesPath" in process ? process.resourcesPath : undefined;
const BUNDLED_WEB_UI_DIST_DIR = resolveBundledWebUiDistDir({
  resourcesPath: typeof processResourcesPath === "string" ? processResourcesPath : undefined,
});

function parseBooleanEnv(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return undefined;
}

function normalizeLogEnv(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return value.trim().toLowerCase();
}

function resolveGitProcessConfig(
  env: NodeJS.ProcessEnv,
  persisted: ReturnType<typeof loadPersistedConfig>,
): NonNullable<NeolixDaemonConfig["git"]> {
  return resolveGitProcessPolicy({
    env,
    persisted: persisted.daemon?.git,
  });
}

export type CliConfigOverrides = Partial<{
  listen: string;
  relayEnabled: boolean;
  relayUseTls: boolean;
  mcpEnabled: boolean;
  mcpInjectIntoAgents: boolean;
  webUiEnabled: boolean;
  hostnames: HostnamesConfig;
}>;

type TrustedProxiesConfig = true | string[];

function resolveLogConfigFromEnv(
  env: NodeJS.ProcessEnv,
  persisted: PersistedConfig,
): PersistedConfig["log"] {
  const level = parseLogLevelEnv(env.NEOLIX_LOG_LEVEL ?? env.NEOLIX_LOG);
  const format = parseLogFormatEnv(env.NEOLIX_LOG_FORMAT);
  const console = resolveConsoleLogConfigFromEnv(env, persisted.log?.console);
  const file = resolveFileLogConfigFromEnv(env, persisted.log?.file);

  if (level === undefined && format === undefined && !console && !file) {
    return persisted.log;
  }

  return {
    ...persisted.log,
    ...(level !== undefined ? { level } : {}),
    ...(format !== undefined ? { format } : {}),
    ...(console ? { console } : {}),
    ...(file ? { file } : {}),
  };
}

function resolveConsoleLogConfigFromEnv(
  env: NodeJS.ProcessEnv,
  persisted: NonNullable<PersistedConfig["log"]>["console"],
): NonNullable<PersistedConfig["log"]>["console"] {
  const level = parseLogLevelEnv(env.NEOLIX_LOG_CONSOLE_LEVEL);
  const format = parseLogFormatEnv(env.NEOLIX_LOG_CONSOLE_FORMAT);
  if (level === undefined && format === undefined) return undefined;
  return {
    ...persisted,
    ...(level !== undefined ? { level } : {}),
    ...(format !== undefined ? { format } : {}),
  };
}

function resolveFileLogConfigFromEnv(
  env: NodeJS.ProcessEnv,
  persisted: NonNullable<PersistedConfig["log"]>["file"],
): NonNullable<PersistedConfig["log"]>["file"] {
  const level = parseLogLevelEnv(env.NEOLIX_LOG_FILE_LEVEL);
  const filePath = nonEmptyEnv(env.NEOLIX_LOG_FILE_PATH);
  const maxSize = nonEmptyEnv(env.NEOLIX_LOG_FILE_ROTATE_SIZE);
  const maxFiles = parsePositiveIntegerEnv(env.NEOLIX_LOG_FILE_ROTATE_COUNT);
  const hasRotateOverride = maxSize !== undefined || maxFiles !== undefined;
  if (level === undefined && filePath === undefined && !hasRotateOverride) return undefined;
  return {
    ...persisted,
    ...(level !== undefined ? { level } : {}),
    ...(filePath !== undefined ? { path: filePath } : {}),
    ...(hasRotateOverride
      ? {
          rotate: {
            ...persisted?.rotate,
            ...(maxSize !== undefined ? { maxSize } : {}),
            ...(maxFiles !== undefined ? { maxFiles } : {}),
          },
        }
      : {}),
  };
}

function parseLogLevelEnv(value: string | undefined): z.infer<typeof LogLevelSchema> | undefined {
  const parsed = LogLevelSchema.safeParse(normalizeLogEnv(value));
  return parsed.success ? parsed.data : undefined;
}

function parseLogFormatEnv(value: string | undefined): z.infer<typeof LogFormatSchema> | undefined {
  const parsed = LogFormatSchema.safeParse(normalizeLogEnv(value));
  return parsed.success ? parsed.data : undefined;
}

function nonEmptyEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parsePositiveIntegerEnv(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

const OptionalVoiceLlmProviderSchema = z
  .union([z.string(), z.null(), z.undefined()])
  .transform((value): string | null =>
    typeof value === "string" ? value.trim().toLowerCase() : null,
  )
  .pipe(z.union([AgentProviderSchema, z.null()]));

function parseOptionalVoiceLlmProvider(value: unknown): AgentProvider | null {
  const parsed = OptionalVoiceLlmProviderSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function extractProviderOverrides(
  providers: Record<string, unknown> | undefined,
): Record<string, ProviderOverride> | undefined {
  if (!providers) {
    return undefined;
  }

  const providerOverrides = Object.entries(providers).flatMap(([providerId, provider]) => {
    const parsed = ProviderOverrideSchema.safeParse(provider);
    return parsed.success ? [[providerId, parsed.data] as const] : [];
  });

  return providerOverrides.length > 0 ? Object.fromEntries(providerOverrides) : undefined;
}

function extractAgentProviderSettings(
  providerOverrides: Record<string, ProviderOverride> | undefined,
): AgentProviderRuntimeSettingsMap | undefined {
  if (!providerOverrides) {
    return undefined;
  }

  const runtimeSettings = Object.entries(providerOverrides).flatMap(([providerId, provider]) => {
    const parsedProviderId = AgentProviderSchema.safeParse(providerId);
    if (!parsedProviderId.success || (!provider.command && !provider.env)) {
      return [];
    }

    return [
      [
        parsedProviderId.data,
        {
          command: provider.command
            ? {
                mode: "replace" as const,
                argv: provider.command,
              }
            : undefined,
          env: provider.env,
        },
      ] as const,
    ];
  });

  return runtimeSettings.length > 0
    ? (Object.fromEntries(runtimeSettings) as AgentProviderRuntimeSettingsMap)
    : undefined;
}

interface ResolveRelayInput {
  env: NodeJS.ProcessEnv;
  persisted: PersistedConfig;
  cliRelayEnabled: boolean | undefined;
  cliRelayUseTls: boolean | undefined;
  enabledFallback: boolean;
}

interface ResolvedRelay {
  enabled: boolean;
  enabledMutable: boolean;
  requireProtectedSecurity: boolean;
  endpoint: string;
  publicEndpoint: string;
  useTls: boolean;
  publicUseTls: boolean;
}

interface ResolvedServiceProxy {
  publicBaseUrl: string | null;
  standaloneListen: string | null;
}

function resolveTlsFromEnv(
  envValue: string | undefined,
  persistedValue: boolean | undefined,
  fallback: boolean,
): boolean {
  if (envValue !== undefined) {
    return parseBooleanEnv(envValue) ?? false;
  }
  return persistedValue ?? fallback;
}

function resolveRelayEndpoints(input: ResolveRelayInput): {
  endpoint: string;
  publicEndpoint: string;
} {
  const endpoint = input.env.NEOLIX_RELAY_ENDPOINT ?? input.persisted.daemon?.relay?.endpoint ?? "";
  const publicEndpoint =
    input.env.NEOLIX_RELAY_PUBLIC_ENDPOINT ??
    input.persisted.daemon?.relay?.publicEndpoint ??
    endpoint;
  return { endpoint, publicEndpoint };
}

function resolveRelayConfig(input: ResolveRelayInput): ResolvedRelay {
  const { endpoint, publicEndpoint } = resolveRelayEndpoints(input);
  const environmentEnabled = parseBooleanEnv(input.env.NEOLIX_RELAY_ENABLED);
  // COMPAT(relayOptInDefault): daemons whose startup config omitted this field
  // retain relay-on removal semantics until 2027-01-31. Modern homes use false.
  // No endpoint is configured by default, so relay stays off until the user
  // supplies one.
  const enabled =
    endpoint.length > 0 &&
    (input.cliRelayEnabled ??
      environmentEnabled ??
      input.persisted.daemon?.relay?.enabled ??
      input.enabledFallback);
  const useTls =
    input.cliRelayUseTls ??
    resolveTlsFromEnv(input.env.NEOLIX_RELAY_USE_TLS, input.persisted.daemon?.relay?.useTls, true);
  const publicUseTls = resolveTlsFromEnv(
    input.env.NEOLIX_RELAY_PUBLIC_USE_TLS,
    input.persisted.daemon?.relay?.publicUseTls,
    useTls,
  );
  return {
    enabled,
    enabledMutable: input.cliRelayEnabled === undefined && environmentEnabled === undefined,
    requireProtectedSecurity: input.persisted.daemon?.relay?.requireProtectedSecurity ?? false,
    endpoint,
    publicEndpoint,
    useTls,
    publicUseTls,
  };
}

interface ResolvedVoiceLlm {
  provider: AgentProvider | null;
  providerExplicit: boolean;
  model: string | null;
}

function resolveServiceProxyPublicBaseUrl(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  try {
    return new URL(value).toString().replace(/\/$/, "");
  } catch {
    throw new Error(`Invalid NEOLIX_SERVICE_PROXY_PUBLIC_BASE_URL: ${value}`);
  }
}

function resolveServiceProxyConfig(
  env: NodeJS.ProcessEnv,
  persisted: ReturnType<typeof loadPersistedConfig>,
): ResolvedServiceProxy {
  const enabledShim =
    parseBooleanEnv(env.NEOLIX_SERVICE_PROXY_ENABLED) ?? persisted.daemon?.serviceProxy?.enabled;
  // COMPAT(serviceProxyEnabled): added 2026-06-02, remove after 2026-12-02.
  // `enabled=false` used to disable the separate service proxy listener. Localhost
  // service proxying is now always enabled; this only suppresses optional layers.
  const optionalLayersEnabled = enabledShim !== false;
  const publicBaseUrl = optionalLayersEnabled
    ? resolveServiceProxyPublicBaseUrl(
        env.NEOLIX_SERVICE_PROXY_PUBLIC_BASE_URL ??
          persisted.daemon?.serviceProxy?.publicBaseUrl ??
          null,
      )
    : null;
  const standaloneListen = optionalLayersEnabled
    ? (env.NEOLIX_SERVICE_PROXY_LISTEN ?? persisted.daemon?.serviceProxy?.listen ?? null)
    : null;

  return { publicBaseUrl, standaloneListen };
}

interface ResolvedWebUi {
  enabled: boolean;
  distDir: string | null;
}

function resolveWebUiConfig(
  neolixHome: string,
  env: NodeJS.ProcessEnv,
  cli: CliConfigOverrides | undefined,
  persisted: ReturnType<typeof loadPersistedConfig>,
): ResolvedWebUi {
  const enabled =
    cli?.webUiEnabled ??
    parseBooleanEnv(env.NEOLIX_WEB_UI_ENABLED) ??
    persisted.features?.webUi?.enabled ??
    false;
  const rawDistDir = env.NEOLIX_WEB_UI_DIST_DIR ?? persisted.features?.webUi?.distDir;
  const trimmedDistDir = rawDistDir?.trim();
  const distDir = trimmedDistDir
    ? path.resolve(path.isAbsolute(trimmedDistDir) ? trimmedDistDir : neolixHome, trimmedDistDir)
    : BUNDLED_WEB_UI_DIST_DIR;
  return {
    enabled,
    distDir,
  };
}

function resolveVoiceLlmConfig(
  env: NodeJS.ProcessEnv,
  persisted: ReturnType<typeof loadPersistedConfig>,
): ResolvedVoiceLlm {
  const envVoiceLlmProvider = parseOptionalVoiceLlmProvider(env.NEOLIX_VOICE_LLM_PROVIDER);
  const persistedVoiceLlmProvider = parseOptionalVoiceLlmProvider(
    persisted.features?.voiceMode?.llm?.provider,
  );
  return {
    provider: envVoiceLlmProvider ?? persistedVoiceLlmProvider ?? null,
    providerExplicit: envVoiceLlmProvider !== null || persistedVoiceLlmProvider !== null,
    model: persisted.features?.voiceMode?.llm?.model ?? null,
  };
}

function resolveCorsAllowedOrigins(
  env: NodeJS.ProcessEnv,
  persisted: ReturnType<typeof loadPersistedConfig>,
): string[] {
  const envCorsOrigins = env.NEOLIX_CORS_ORIGINS
    ? env.NEOLIX_CORS_ORIGINS.split(",").map((s) => s.trim())
    : [];
  const persistedCorsOrigins = persisted.daemon?.cors?.allowedOrigins ?? [];
  return Array.from(
    new Set([...persistedCorsOrigins, ...envCorsOrigins].filter((s) => s.length > 0)),
  );
}

function parseTrustedProxiesEnv(value: string | undefined): TrustedProxiesConfig | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  const normalized = trimmed.toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return [];
  }

  return trimmed
    .split(",")
    .map((proxy) => proxy.trim())
    .filter((proxy) => proxy.length > 0);
}

function resolveTrustedProxiesConfig(
  env: NodeJS.ProcessEnv,
  persisted: ReturnType<typeof loadPersistedConfig>,
): TrustedProxiesConfig {
  return (
    parseTrustedProxiesEnv(env.NEOLIX_TRUSTED_PROXIES) ??
    persisted.daemon?.trustedProxies ??
    DEFAULT_TRUSTED_PROXIES
  );
}

function resolveAuthConfig(
  env: NodeJS.ProcessEnv,
  persisted: ReturnType<typeof loadPersistedConfig>,
): NeolixDaemonConfig["auth"] {
  const envPassword = env.NEOLIX_PASSWORD?.trim();
  if (envPassword) {
    return { password: hashDaemonPassword(envPassword) };
  }
  return persisted.daemon?.auth?.password
    ? { password: persisted.daemon.auth.password }
    : undefined;
}

function resolveWorktreesRoot(
  neolixHome: string,
  persisted: ReturnType<typeof loadPersistedConfig>,
): string | undefined {
  const configuredRoot = persisted.worktrees?.root?.trim();
  if (!configuredRoot) {
    return undefined;
  }

  const expandedRoot = expandTilde(configuredRoot);
  return path.isAbsolute(expandedRoot)
    ? path.resolve(expandedRoot)
    : path.resolve(neolixHome, expandedRoot);
}

function resolveAppendSystemPrompt(persisted: ReturnType<typeof loadPersistedConfig>): string {
  return persisted.daemon?.appendSystemPrompt ?? "";
}

function resolveUsageEnabled(persisted: ReturnType<typeof loadPersistedConfig>): boolean {
  return persisted.daemon?.usage?.enabled !== false;
}

function resolveBrowserToolsEnabled(persisted: ReturnType<typeof loadPersistedConfig>): boolean {
  return persisted.daemon?.browserTools?.enabled ?? false;
}

/**
 * Both profile lists stay `undefined` when absent rather than defaulting to an
 * empty array: for terminal profiles that is what selects the built-in
 * defaults, so an empty array has to keep meaning "the user removed them all".
 */
function resolveProfileLists(persisted: ReturnType<typeof loadPersistedConfig>) {
  return {
    terminalProfiles: persisted.daemon?.terminalProfiles,
    agentProfiles: persisted.daemon?.agentProfiles,
  };
}

function resolveStaticLoadConfigSettings(
  env: NodeJS.ProcessEnv,
  cli: CliConfigOverrides | undefined,
  persisted: ReturnType<typeof loadPersistedConfig>,
) {
  return {
    mcpEnabled: cli?.mcpEnabled ?? persisted.daemon?.mcp?.enabled ?? true,
    mcpInjectIntoAgents:
      cli?.mcpInjectIntoAgents ?? persisted.daemon?.mcp?.injectIntoAgents ?? false,
    usageEnabled: resolveUsageEnabled(persisted),
    usageAlertPercent: persisted.usageAlertPercent,
    balanceAlert: persisted.balanceAlert,
    sessionTerminal: persisted.sessionTerminal,
    telemetry: persisted.daemon?.telemetry,
    browserToolsEnabled: resolveBrowserToolsEnabled(persisted),
    autoArchiveAfterMerge: persisted.daemon?.autoArchiveAfterMerge ?? false,
    appendSystemPrompt: resolveAppendSystemPrompt(persisted),
    ...resolveProfileLists(persisted),
    hostnames: mergeHostnames([
      persisted.daemon?.hostnames,
      parseHostnamesEnv(env.NEOLIX_HOSTNAMES ?? env.NEOLIX_ALLOWED_HOSTS),
      cli?.hostnames,
    ]),
    trustedProxies: resolveTrustedProxiesConfig(env, persisted),
    appBaseUrl: env.NEOLIX_APP_BASE_URL ?? persisted.app?.baseUrl ?? "",
  };
}

interface ResolveConfigFromPersistedOptions {
  env?: NodeJS.ProcessEnv;
  cli?: CliConfigOverrides;
  relayEnabledFallback?: boolean;
}

// Startup values, including authentication, never enter runtime settings resolution.
export type ResolvedDaemonSettings = Pick<
  NeolixDaemonConfig,
  | "corsAllowedOrigins"
  | "hostnames"
  | "trustedProxies"
  | "mcpEnabled"
  | "mcpInjectIntoAgents"
  | "usageEnabled"
  | "usageAlertPercent"
  | "balanceAlert"
  | "sessionTerminal"
  | "telemetry"
  | "browserToolsEnabled"
  | "git"
  | "autoArchiveAfterMerge"
  | "enableTerminalAgentHooks"
  | "appendSystemPrompt"
  | "terminalProfiles"
  | "agentProfiles"
  | "skillSelection"
  | "pluginsEnabled"
  | "plugins"
  | "builtinFeatures"
  | "builtinFeatureConfig"
  | "relayEnabled"
  | "relayRequireProtectedSecurity"
  | "relayEndpoint"
  | "appBaseUrl"
  | "idleRuntimeCleanup"
  | "resumeOnStartup"
  | "resumePrompt"
  | "providerCatalogRefreshTimeoutMs"
  | "metadataGeneration"
  | "providerOverrides"
>;

export function resolveConfigFromPersisted(
  neolixHome: string,
  persisted: PersistedConfig,
  options?: ResolveConfigFromPersistedOptions,
): NeolixDaemonConfig {
  const env = configurationEnvironment(options?.env ?? process.env);
  const cli = options?.cli;
  const relayEnabledFallback =
    options?.relayEnabledFallback ?? persisted.daemon?.relay?.enabled === undefined;
  const { overrideControlledPaths, ...settings } = resolveReloadableConfig(persisted, options);
  const relay = resolveRelayConfig({
    env,
    persisted,
    cliRelayEnabled: cli?.relayEnabled,
    cliRelayUseTls: cli?.relayUseTls,
    enabledFallback: relayEnabledFallback,
  });
  const { openai, speech } = resolveSpeechConfig({ neolixHome, env, persisted });
  const voiceLlm = resolveVoiceLlmConfig(env, persisted);
  return {
    ...settings,
    listen: resolveListenAddress(env, persisted, cli?.listen),
    neolixHome,
    desktopManaged: env.NEOLIX_DESKTOP_MANAGED === "1",
    worktreesRoot: resolveWorktreesRoot(neolixHome, persisted),
    pluginRegistries: persisted.pluginRegistries,
    pluginRegistryUrl: env.NEOLIX_PLUGIN_REGISTRY,
    mcpDebug: env.MCP_DEBUG === "1",
    isDev: resolveNeolixNodeEnv(env) === "development",
    agentStoragePath: path.join(neolixHome, "agents"),
    staticDir: "public",
    agentClients: {},
    relayEnabledMutable: relay.enabledMutable,
    relayEndpoint: relay.endpoint,
    relayPublicEndpoint: relay.publicEndpoint,
    relayUseTls: relay.useTls,
    relayPublicUseTls: relay.publicUseTls,
    serviceProxy: resolveServiceProxyConfig(env, persisted),
    webUi: resolveWebUiConfig(neolixHome, env, cli, persisted),
    // `NEOLIX_WEB_APP=0` keeps the desktop web app off this port.
    webApp:
      parseBooleanEnv(env.NEOLIX_WEB_APP) === false
        ? null
        : webAppCandidates({
            env,
            ...(typeof processResourcesPath === "string"
              ? { resourcesPath: processResourcesPath }
              : {}),
          }),
    auth: resolveAuthConfig(env, persisted),
    openai,
    speech,
    voiceLlmProvider: voiceLlm.provider,
    voiceLlmProviderExplicit: voiceLlm.providerExplicit,
    voiceLlmModel: voiceLlm.model,
    agentProviderSettings: extractAgentProviderSettings(settings.providerOverrides),
    log: resolveLogConfigFromEnv(env, persisted),
    configReload: {
      env: { ...env },
      cli: cli ? { ...cli } : undefined,
      overrideControlledPaths,
      relayEnabledFallback,
      startupPersisted: persisted,
    },
  };
}

export function resolveReloadableConfig(
  persisted: PersistedConfig,
  options?: ResolveConfigFromPersistedOptions,
): ResolvedDaemonSettings & { overrideControlledPaths: string[] } {
  const env = configurationEnvironment(options?.env ?? process.env);
  const cli = options?.cli;
  const relay = resolveRelayConfig({
    env,
    persisted,
    cliRelayEnabled: cli?.relayEnabled,
    cliRelayUseTls: cli?.relayUseTls,
    enabledFallback:
      options?.relayEnabledFallback ?? persisted.daemon?.relay?.enabled === undefined,
  });
  return {
    ...resolveStaticLoadConfigSettings(env, cli, persisted),
    corsAllowedOrigins: resolveCorsAllowedOrigins(env, persisted),
    git: resolveGitProcessConfig(env, persisted),
    enableTerminalAgentHooks: persisted.daemon?.enableTerminalAgentHooks ?? false,
    skillSelection: persisted.agents?.skills?.selection,
    pluginsEnabled: persisted.pluginsEnabled ?? false,
    plugins: persisted.plugins,
    builtinFeatures: persisted.builtinFeatures,
    builtinFeatureConfig: persisted.builtinFeatureConfig,
    relayEnabled: relay.enabled,
    relayRequireProtectedSecurity: relay.requireProtectedSecurity,
    // createInitialRelayConfig treats an empty endpoint as "relay cannot run",
    // so a reload that drops it silently keeps the previous enabled state.
    relayEndpoint: relay.endpoint,
    idleRuntimeCleanup: persisted.agents?.idleRuntimeCleanup ?? true,
    ...resolveRestartRecoveryConfig(persisted.agents),
    providerCatalogRefreshTimeoutMs: persisted.agents?.catalogRefreshTimeoutMs,
    metadataGeneration: persisted.agents?.metadataGeneration,
    providerOverrides: extractProviderOverrides(
      persisted.agents?.providers as Record<string, unknown> | undefined,
    ),
    overrideControlledPaths: resolveOverrideControlledPaths(env, cli, persisted),
  };
}

export function loadConfig(
  neolixHome: string,
  options?: Omit<ResolveConfigFromPersistedOptions, "relayEnabledFallback">,
): NeolixDaemonConfig {
  const persisted = loadPersistedConfig(neolixHome);
  return resolveConfigFromPersisted(neolixHome, persisted, options);
}

function parsePositiveGitOverride(value: string | undefined): boolean {
  if (value === undefined) return false;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0;
}

function resolveOverrideControlledPaths(
  env: NodeJS.ProcessEnv,
  cli: CliConfigOverrides | undefined,
  persisted: PersistedConfig,
): string[] {
  return Array.from(
    new Set([
      ...resolveDaemonOverrideControlledPaths(env, cli),
      ...resolveLogOverrideControlledPaths(env),
      ...resolveSpeechOverrideControlledPaths(env, persisted),
    ]),
  ).sort();
}

function resolveDaemonOverrideControlledPaths(
  env: NodeJS.ProcessEnv,
  cli: CliConfigOverrides | undefined,
): string[] {
  return [
    ...resolveCoreDaemonOverridePaths(env, cli),
    ...resolveRelayOverridePaths(env, cli),
    ...resolveServiceAndWebUiOverridePaths(env, cli),
  ];
}

function resolveCoreDaemonOverridePaths(
  env: NodeJS.ProcessEnv,
  cli: CliConfigOverrides | undefined,
): string[] {
  const paths: string[] = [];
  if (cli?.listen !== undefined || env.NEOLIX_LISTEN !== undefined) {
    paths.push("daemon.listen", "daemon.port", "daemon.lan");
  }
  if (cli?.mcpEnabled !== undefined) paths.push("daemon.mcp.enabled");
  if (cli?.mcpInjectIntoAgents !== undefined) paths.push("daemon.mcp.injectIntoAgents");
  // Hostname sources append instead of replacing one another, so a launch value
  // does not prevent a persisted hostname edit from taking effect.
  if (parseTrustedProxiesEnv(env.NEOLIX_TRUSTED_PROXIES) !== undefined) {
    paths.push("daemon.trustedProxies");
  }
  if (parsePositiveGitOverride(env.NEOLIX_GIT_MAX_PROCESSES_PER_SECOND)) {
    paths.push("daemon.git.maxProcessesPerSecond");
  }
  if (
    parsePositiveGitOverride(env.NEOLIX_GIT_MAX_PROCESS_CONCURRENCY ?? env.NEOLIX_GIT_CONCURRENCY)
  ) {
    paths.push("daemon.git.maxProcessConcurrency");
  }
  if (env.NEOLIX_APP_BASE_URL !== undefined) paths.push("app.baseUrl");
  if (env.NEOLIX_PASSWORD?.trim()) paths.push("daemon.auth.password");
  return paths;
}

function resolveRelayOverridePaths(
  env: NodeJS.ProcessEnv,
  cli: CliConfigOverrides | undefined,
): string[] {
  const paths: string[] = [];
  if (cli?.relayEnabled !== undefined || parseBooleanEnv(env.NEOLIX_RELAY_ENABLED) !== undefined) {
    paths.push("daemon.relay.enabled");
  }
  if (env.NEOLIX_RELAY_ENDPOINT !== undefined) paths.push("daemon.relay.endpoint");
  if (env.NEOLIX_RELAY_PUBLIC_ENDPOINT !== undefined) {
    paths.push("daemon.relay.publicEndpoint");
  }
  if (cli?.relayUseTls !== undefined || env.NEOLIX_RELAY_USE_TLS !== undefined) {
    paths.push("daemon.relay.useTls");
  }
  if (env.NEOLIX_RELAY_PUBLIC_USE_TLS !== undefined) {
    paths.push("daemon.relay.publicUseTls");
  }
  return paths;
}

function resolveServiceAndWebUiOverridePaths(
  env: NodeJS.ProcessEnv,
  cli: CliConfigOverrides | undefined,
): string[] {
  const paths: string[] = [];
  const serviceProxyEnabled = parseBooleanEnv(env.NEOLIX_SERVICE_PROXY_ENABLED);
  if (serviceProxyEnabled !== undefined) paths.push("daemon.serviceProxy.enabled");
  if (env.NEOLIX_SERVICE_PROXY_LISTEN !== undefined || serviceProxyEnabled === false) {
    paths.push("daemon.serviceProxy.listen");
  }
  if (env.NEOLIX_SERVICE_PROXY_PUBLIC_BASE_URL !== undefined || serviceProxyEnabled === false) {
    paths.push("daemon.serviceProxy.publicBaseUrl");
  }

  if (cli?.webUiEnabled !== undefined || parseBooleanEnv(env.NEOLIX_WEB_UI_ENABLED) !== undefined) {
    paths.push("features.webUi.enabled");
  }
  if (env.NEOLIX_WEB_UI_DIST_DIR !== undefined) paths.push("features.webUi.distDir");
  return paths;
}

function resolveLogOverrideControlledPaths(env: NodeJS.ProcessEnv): string[] {
  const paths: string[] = [];
  if (parseLogLevelEnv(env.NEOLIX_LOG_LEVEL ?? env.NEOLIX_LOG) !== undefined) {
    paths.push("log.level");
  }
  if (parseLogFormatEnv(env.NEOLIX_LOG_FORMAT) !== undefined) paths.push("log.format");
  if (parseLogLevelEnv(env.NEOLIX_LOG_CONSOLE_LEVEL) !== undefined) {
    paths.push("log.console.level");
  }
  if (parseLogFormatEnv(env.NEOLIX_LOG_CONSOLE_FORMAT) !== undefined) {
    paths.push("log.console.format");
  }
  if (parseLogLevelEnv(env.NEOLIX_LOG_FILE_LEVEL) !== undefined) paths.push("log.file.level");
  if (nonEmptyEnv(env.NEOLIX_LOG_FILE_PATH) !== undefined) paths.push("log.file.path");
  if (nonEmptyEnv(env.NEOLIX_LOG_FILE_ROTATE_SIZE) !== undefined) {
    paths.push("log.file.rotate.maxSize");
  }
  if (parsePositiveIntegerEnv(env.NEOLIX_LOG_FILE_ROTATE_COUNT) !== undefined) {
    paths.push("log.file.rotate.maxFiles");
  }
  return paths;
}

function resolveSpeechOverrideControlledPaths(
  env: NodeJS.ProcessEnv,
  persisted: PersistedConfig,
): string[] {
  const paths = Object.keys(readSpeechSettings(persisted, env).envOverrides);
  if (env.NEOLIX_VOICE_LLM_PROVIDER !== undefined) paths.push("features.voiceMode.llm.provider");
  if (env.NEOLIX_LOCAL_MODELS_DIR !== undefined) paths.push("providers.local.modelsDir");
  return paths;
}

function resolveRestartRecoveryConfig(agents: PersistedConfig["agents"]) {
  return {
    resumeOnStartup: agents?.resumeOnStartup ?? false,
    resumePrompt: agents?.resumePrompt ?? "Resume working.",
  };
}
