// Launch configuration is the daemon's, not the bridge's. Synara's provider-instance model
// (binary path, environment, home folder, enabled) is a view over the daemon's
// `agents.providers` entries: the bridge writes the daemon config and derives the settings
// view back from it. Only presentation fields (accent colour, terminal alias) stay local.
import type {
  ProviderInstanceConfig,
  ProviderInstanceConfigMap,
  ProviderKind,
} from "@synara/contracts";

/** Synara driver -> the Neox provider a default instance configures. */
export const DRIVER_TO_DAEMON_PROVIDER: Record<string, string> = {
  claudeAgent: "claude",
  codex: "codex",
  copilot: "copilot",
  opencode: "opencode",
  pi: "pi",
  omp: "omp",
  antigravity: "antigravity",
  cursor: "cursor",
  grok: "grok",
  droid: "droid",
  devin: "devin",
};

const DAEMON_PROVIDER_TO_DRIVER: Record<string, ProviderKind> = {
  claude: "claudeAgent",
  codex: "codex",
  copilot: "claudeAgent",
  opencode: "opencode",
  pi: "pi",
  omp: "omp",
  antigravity: "antigravity",
  cursor: "cursor",
  grok: "grok",
  droid: "droid",
  devin: "devin",
  "neolix-gateway": "claudeAgent",
};

/** Providers registered by the daemon that do not map 1:1 to a Synara driver default. */
const NATIVE_PROVIDER_IDS = new Set(["copilot", "neolix-gateway"]);

/** Providers a custom (derived) entry may extend. The daemon rejects anything else. */
const EXTENDABLE_PROVIDERS = new Set(["claude", "codex", "copilot", "opencode", "pi", "omp"]);

const HOME_ENV: Record<string, string> = {
  claudeAgent: "CLAUDE_CONFIG_DIR",
  codex: "CODEX_HOME",
  pi: "PI_CODING_AGENT_DIR",
  omp: "PI_CODING_AGENT_DIR",
  cursor: "CURSOR_CONFIG_DIR",
  grok: "GROK_HOME",
};

/** The binary each provider launches when no override is configured. */
const DEFAULT_BINARY: Record<string, string> = {
  claudeAgent: "claude",
  codex: "codex",
  copilot: "copilot",
  opencode: "opencode",
  pi: "pi",
  omp: "omp",
  antigravity: "agy",
  cursor: "cursor-agent",
  grok: "grok",
  droid: "droid",
  devin: "devin",
};

const OPENCODE_URL_ENV = "NEOLIX_OPENCODE_SERVER_URL";
const OPENCODE_PASSWORD_ENV = "NEOLIX_OPENCODE_SERVER_PASSWORD";

/**
 * Drivers the daemon does not run until its config turns them on: Oh My Pi ships disabled,
 * Cursor is an ACP provider registered only from config, and Grok, Droid and Devin have no
 * daemon provider at all. Their settings start disabled; a daemon entry turns them on.
 */
export const OPT_IN_DRIVERS: ReadonlySet<string> = new Set([
  "omp",
  "cursor",
  "grok",
  "droid",
  "devin",
]);

/**
 * Cursor is not a built-in daemon provider: the daemon registers it from an `acp` entry with
 * a launch command, so every write carries both or the entry is silently ignored.
 */
function shapeCursorOverride(
  override: Record<string, unknown>,
  current: Record<string, unknown> | undefined,
): void {
  override.extends = "acp";
  if (override.label === undefined) override.label = nonEmpty(current?.label) ?? "Cursor";
  const binary =
    (Array.isArray(override.command) ? commandPath(override.command) : "") ||
    commandPath(current?.command) ||
    DEFAULT_BINARY.cursor;
  override.command = [binary, "acp"];
}

/** The daemon's provider id regex: lowercase, letter first, then letters, digits, dashes. */
export function daemonProviderIdForInstanceId(instanceId: string): string {
  const direct = DRIVER_TO_DAEMON_PROVIDER[instanceId];
  if (direct) return direct;
  const slug = instanceId
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  const prefixed = /^[a-z]/.test(slug) ? slug : `p-${slug}`;
  return prefixed.slice(0, 64).replace(/-+$/g, "");
}

function driverForDaemonProvider(providerId: string, extendsId?: string): ProviderKind {
  return knownDriverForDaemonProvider(providerId, extendsId) ?? "claudeAgent";
}

/**
 * The driver a provider really is, if any. Unknown providers (plugin providers included) run
 * under the Claude driver, which is how the bridge already renders the Neox gateway, but they
 * are not Claude: their instances carry `config.ownIdentity` (see `providerInstanceConfigs`).
 */
function knownDriverForDaemonProvider(
  providerId: string,
  extendsId?: string,
): ProviderKind | undefined {
  if (BORROWS_CLAUDE_DRIVER.has(providerId)) return undefined;
  const direct = DAEMON_PROVIDER_TO_DRIVER[providerId];
  if (direct) return direct;
  return extendsId ? DAEMON_PROVIDER_TO_DRIVER[extendsId] : undefined;
}

/** Listed in {@link DAEMON_PROVIDER_TO_DRIVER} only so they run; they are not Claude. */
const BORROWS_CLAUDE_DRIVER: ReadonlySet<string> = new Set(["copilot"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function trimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function nonEmpty(value: unknown): string | undefined {
  const text = trimmed(value);
  return text.length > 0 ? text : undefined;
}

function commandPath(value: unknown): string {
  if (!Array.isArray(value)) return "";
  const first = value.find((entry) => typeof entry === "string" && entry.trim().length > 0);
  return typeof first === "string" ? first.trim() : "";
}

function envRecord(value: unknown): Record<string, string> {
  const env: Record<string, string> = {};
  if (!isRecord(value)) return env;
  for (const [name, raw] of Object.entries(value)) {
    if (typeof raw === "string") env[name] = raw;
  }
  return env;
}

function materializeEnvironment(
  config: ProviderInstanceConfig,
  currentEnv: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const variable of config.environment ?? []) {
    const name = trimmed(variable.name);
    if (!name) continue;
    if (variable.valueRedacted === true) {
      // The client never receives the secret, only the marker. Reuse the daemon's copy when
      // the instance is written back, or an unrelated edit would delete the credential.
      if (currentEnv[name] !== undefined) env[name] = currentEnv[name];
      continue;
    }
    env[name] = variable.value ?? "";
  }
  return env;
}

function additionalModels(value: unknown): Array<{ id: string; label: string }> | undefined {
  if (!Array.isArray(value)) return undefined;
  const models = value.flatMap((entry) => {
    if (typeof entry === "string") {
      const id = entry.trim();
      return id ? [{ id, label: id }] : [];
    }
    if (!isRecord(entry)) return [];
    const id = nonEmpty(entry.id);
    if (!id) return [];
    return [{ id, label: nonEmpty(entry.label) ?? id }];
  });
  return models.length > 0 ? models : undefined;
}

/**
 * `customModels` → the daemon's `additionalModels`. An emptied list must clear the daemon's
 * copy, or the last custom model can never be removed; it is only sent when there is something
 * to clear, so saving an untouched provider does not write an empty entry into config.json.
 */
function additionalModelsOverride(
  value: unknown,
  current: Record<string, unknown> | undefined,
): Array<{ id: string; label: string }> | undefined {
  const models = additionalModels(value);
  if (models) return models;
  const hasCurrent =
    Array.isArray(current?.additionalModels) && current.additionalModels.length > 0;
  return Array.isArray(value) && hasCurrent ? [] : undefined;
}

function commandOverride(driver: string, rawValue: unknown): string[] | undefined {
  if (!isRecord(rawValue) || rawValue.binaryPath === undefined) return undefined;
  const binaryPath = nonEmpty(rawValue.binaryPath);
  if (binaryPath) return [binaryPath];
  // An explicitly cleared path restores the provider's default binary. Without this the
  // daemon's shallow merge would keep the previous override forever.
  const fallback = DEFAULT_BINARY[driver];
  return fallback ? [fallback] : undefined;
}

export interface DaemonProviderPatch {
  readonly providers: Record<string, Record<string, unknown>>;
  /** Derived provider ids the patch no longer contains; the daemon removes their overrides. */
  readonly removeProviders?: readonly string[];
}

function launchOverrideForInstance(
  instanceId: string,
  config: ProviderInstanceConfig,
  currentProviders?: Record<string, unknown>,
): Record<string, unknown> | null {
  const driver = config.driver;
  const providerId = daemonProviderIdForInstanceId(instanceId);
  const baseProviderId = DRIVER_TO_DAEMON_PROVIDER[driver];
  const isDefaultInstance = providerId === baseProviderId || NATIVE_PROVIDER_IDS.has(instanceId);
  if (!isDefaultInstance) {
    // A derived daemon provider needs a base to inherit from. Plugin providers that are
    // not in the daemon's extendable set cannot host extra accounts through config.
    if (!baseProviderId || !EXTENDABLE_PROVIDERS.has(baseProviderId)) return null;
  }

  const raw = isRecord(config.config) ? config.config : {};
  const current = isRecord(currentProviders?.[providerId]) ? currentProviders[providerId] : {};
  const currentEnv = envRecord(current.env);
  const explicitEnvironment = materializeEnvironment(config, currentEnv);
  const hasLaunchConfig =
    Boolean(
      nonEmpty(raw.binaryPath) ??
      nonEmpty(raw.homePath) ??
      nonEmpty(raw.configDir) ??
      nonEmpty(raw.agentDir) ??
      nonEmpty(raw.profileDir),
    ) ||
    Object.keys(explicitEnvironment).length > 0 ||
    (additionalModels(raw.customModels)?.length ?? 0) > 0 ||
    (driver === "opencode" &&
      Boolean(
        nonEmpty(raw.serverUrl) ??
        nonEmpty(raw.serverPassword) ??
        (raw.serverPasswordRedacted === true ? currentEnv[OPENCODE_PASSWORD_ENV] : undefined),
      ));
  if (!isDefaultInstance && !hasLaunchConfig) {
    // Catalog entries for plugin providers carry no launch config. Deriving them would
    // shadow the provider the plugin registered, so only real accounts are written.
    return null;
  }
  if (NATIVE_PROVIDER_IDS.has(instanceId) && !hasLaunchConfig) {
    // A catalog row for a daemon-native provider (the gateway, Copilot) needs no override;
    // only an explicit disable is worth writing.
    return config.enabled === false ? { enabled: false } : null;
  }

  const override: Record<string, unknown> = {};
  if (!isDefaultInstance) {
    override.extends = baseProviderId;
    override.label = nonEmpty(config.displayName) ?? instanceId;
  } else if (nonEmpty(config.displayName)) {
    override.label = nonEmpty(config.displayName);
  }
  if (config.enabled !== undefined) override.enabled = config.enabled !== false;

  const command = commandOverride(driver, raw);
  if (command) override.command = command;

  const hasExplicitEnvironment = config.environment !== undefined;
  const env = { ...explicitEnvironment };
  const homeEnv = HOME_ENV[driver];
  const home =
    nonEmpty(raw.homePath) ??
    nonEmpty(raw.configDir) ??
    nonEmpty(raw.agentDir) ??
    nonEmpty(raw.profileDir);
  const homeCleared =
    raw.homePath === "" || raw.configDir === "" || raw.agentDir === "" || raw.profileDir === "";
  if (homeEnv) {
    if (home) env[homeEnv] = home;
    else if (homeCleared) delete env[homeEnv];
    // The default account's home lives in the provider settings, not in this instance, so
    // keep the daemon's value when this patch only carries the environment list.
    else if (currentEnv[homeEnv] !== undefined) env[homeEnv] = currentEnv[homeEnv];
  }
  if (driver === "opencode") {
    const serverUrl = nonEmpty(raw.serverUrl);
    if (serverUrl) env[OPENCODE_URL_ENV] = serverUrl;
    else if (raw.serverUrl === "") delete env[OPENCODE_URL_ENV];
    else if (currentEnv[OPENCODE_URL_ENV] !== undefined) {
      env[OPENCODE_URL_ENV] = currentEnv[OPENCODE_URL_ENV];
    }
    const serverPassword =
      raw.serverPasswordRedacted === true
        ? currentEnv[OPENCODE_PASSWORD_ENV]
        : nonEmpty(raw.serverPassword);
    if (serverPassword) env[OPENCODE_PASSWORD_ENV] = serverPassword;
    else if (raw.serverPassword === "" && raw.serverPasswordRedacted !== true) {
      delete env[OPENCODE_PASSWORD_ENV];
    }
  }
  const models = additionalModelsOverride(raw.customModels, current);
  if (models) override.additionalModels = models;

  // Sending the whole env map replaces the daemon's copy, so clearing the last variable
  // (or the home folder) actually removes it instead of leaving a stale value behind.
  if (Object.keys(env).length > 0 || hasExplicitEnvironment) override.env = env;

  // Once an entry exists with no launch fields it still records enabled/label; that is
  // deliberate: a disabled account must stay disabled without a local copy of its config.
  if (isDefaultInstance && driver === "cursor" && Object.keys(override).length > 0) {
    shapeCursorOverride(override, current);
  }
  if (!isDefaultInstance || Object.keys(override).length > 0) return override;
  return null;
}

/**
 * Translates a `providerInstances` patch into daemon provider overrides. Every entry is
 * written, because the web sends the whole map; entries the daemon cannot host (extra
 * accounts of plugin providers) are skipped and keep only local presentation fields.
 */
export function providerInstancesToDaemonPatch(
  instances: ProviderInstanceConfigMap | undefined,
  currentProviders?: Record<string, unknown>,
): DaemonProviderPatch | null {
  if (instances === undefined) return null;
  const providers: Record<string, Record<string, unknown>> = {};
  for (const [instanceId, config] of Object.entries(instances)) {
    const override = launchOverrideForInstance(instanceId, config, currentProviders);
    if (override) providers[daemonProviderIdForInstanceId(instanceId)] = override;
  }
  // Deleting an account only drops it from this map; without a matching removal the daemon
  // keeps its `extends` entry and the next settings read derives the account right back.
  // Default drivers are exempt (their ids are configuration, not accounts).
  const presentIds = new Set(
    Object.keys(instances).map((instanceId) => daemonProviderIdForInstanceId(instanceId)),
  );
  const defaultIds = new Set(Object.values(DRIVER_TO_DAEMON_PROVIDER));
  const removeProviders = Object.entries(currentProviders ?? {})
    .filter(
      ([providerId, rawValue]) =>
        !presentIds.has(providerId) &&
        !defaultIds.has(providerId) &&
        !NATIVE_PROVIDER_IDS.has(providerId) &&
        isRecord(rawValue) &&
        typeof rawValue.extends === "string",
    )
    .map(([providerId]) => providerId);
  if (Object.keys(providers).length === 0 && removeProviders.length === 0) return null;
  return {
    providers,
    ...(removeProviders.length > 0 ? { removeProviders } : {}),
  };
}

/**
 * Default-account fields (`settings.providers.<driver>`) map onto the same daemon entries.
 * Only fields with a daemon effect are translated; presentation-only fields stay local.
 */
export function providerSettingsToDaemonPatch(
  providers: Record<string, unknown> | undefined,
  currentProviders?: Record<string, unknown>,
): DaemonProviderPatch | null {
  if (!providers) return null;
  const patch: Record<string, Record<string, unknown>> = {};
  for (const [driver, rawValue] of Object.entries(providers)) {
    if (!isRecord(rawValue)) continue;
    const providerId = DRIVER_TO_DAEMON_PROVIDER[driver] ?? driver;
    const override: Record<string, unknown> = {};
    const command = commandOverride(driver, rawValue);
    if (command) override.command = command;
    // The daemon replaces a provider's whole `env` map with the patch's. Build the new map
    // from the current one so clearing a field removes it without dropping other variables.
    const current = isRecord(currentProviders?.[providerId])
      ? currentProviders[providerId]
      : undefined;
    const env = envRecord(current?.env);
    let envTouched = false;
    const homeEnv = HOME_ENV[driver];
    if (homeEnv && (rawValue.homePath !== undefined || rawValue.agentDir !== undefined)) {
      envTouched = true;
      const home = nonEmpty(rawValue.homePath) ?? nonEmpty(rawValue.agentDir);
      if (home) env[homeEnv] = home;
      else delete env[homeEnv];
    }
    if (driver === "opencode") {
      for (const [key, name] of [
        ["serverUrl", OPENCODE_URL_ENV],
        ["serverPassword", OPENCODE_PASSWORD_ENV],
      ] as const) {
        if (rawValue[key] === undefined) continue;
        envTouched = true;
        const value = nonEmpty(rawValue[key]);
        if (value) env[name] = value;
        else delete env[name];
      }
    }
    if (envTouched) override.env = env;
    if (rawValue.enabled !== undefined) override.enabled = rawValue.enabled !== false;
    const models = additionalModelsOverride(rawValue.customModels, current);
    if (models) override.additionalModels = models;
    if (driver === "cursor" && Object.keys(override).length > 0) {
      shapeCursorOverride(override, current);
    }
    if (Object.keys(override).length > 0) patch[providerId] = override;
  }
  return Object.keys(patch).length > 0 ? { providers: patch } : null;
}

function environmentVariables(
  env: Record<string, string>,
  excluded: ReadonlySet<string>,
): Array<{ name: string; value: string; sensitive: boolean }> {
  return Object.entries(env)
    .filter(([name]) => !excluded.has(name))
    .map(([name, value]) => ({
      name,
      value,
      sensitive: /KEY|TOKEN|SECRET|PASSWORD/i.test(name),
    }));
}

export interface DerivedProviderSettings {
  readonly providers: Record<string, Record<string, unknown>>;
  readonly providerInstances: ProviderInstanceConfigMap;
}

/**
 * The settings view of the daemon's provider overrides. Default providers become
 * `settings.providers` fields; everything else becomes an explicit provider instance so the
 * front end can list it and external configuration stays editable.
 */
export function deriveProviderSettingsFromDaemon(
  overrides: Record<string, unknown> | undefined,
): DerivedProviderSettings {
  const providers: Record<string, Record<string, unknown>> = {};
  const providerInstances: Record<string, ProviderInstanceConfig> = {};
  if (!overrides) return { providers, providerInstances };

  for (const [providerId, rawValue] of Object.entries(overrides)) {
    if (!isRecord(rawValue)) continue;
    const driver = driverForDaemonProvider(providerId, nonEmpty(rawValue.extends));
    const env = envRecord(rawValue.env);
    const command = commandPath(rawValue.command);
    const defaultInstance = DRIVER_TO_DAEMON_PROVIDER[driver] === providerId;

    if (defaultInstance) {
      const settings: Record<string, unknown> = {};
      if (command) settings.binaryPath = command;
      const homeEnv = HOME_ENV[driver];
      if (homeEnv && env[homeEnv]) {
        if (driver === "pi" || driver === "omp") settings.agentDir = env[homeEnv];
        else settings.homePath = env[homeEnv];
      }
      if (driver === "opencode") {
        if (env[OPENCODE_URL_ENV]) settings.serverUrl = env[OPENCODE_URL_ENV];
        if (env[OPENCODE_PASSWORD_ENV]) settings.serverPassword = env[OPENCODE_PASSWORD_ENV];
      }
      if (rawValue.enabled !== undefined) settings.enabled = rawValue.enabled !== false;
      // The daemon registers Cursor only from an `acp` entry, so that entry means enabled; an
      // entry without it (written by an older bridge) never ran. Oh My Pi stays on the
      // daemon's disabled default unless the entry says otherwise.
      if (driver === "cursor") {
        settings.enabled = rawValue.extends === "acp" && rawValue.enabled !== false;
      }
      const models = Array.isArray(rawValue.additionalModels)
        ? rawValue.additionalModels
            .map((entry) =>
              typeof entry === "string"
                ? entry
                : isRecord(entry) && typeof entry.id === "string"
                  ? entry.id
                  : null,
            )
            .filter((entry): entry is string => Boolean(entry))
        : [];
      if (models.length > 0) settings.customModels = models;
      if (Object.keys(settings).length > 0) providers[driver] = settings;
      // Environment variables with no dedicated settings field still need a view, or the
      // default account's editor would silently drop them on the next save.
      const leftover = environmentVariables(
        env,
        new Set(
          [homeEnv, OPENCODE_URL_ENV, OPENCODE_PASSWORD_ENV].filter((name): name is string =>
            Boolean(name),
          ),
        ),
      );
      if (leftover.length > 0) {
        providerInstances[driver] = { driver, environment: leftover };
      }
      continue;
    }

    const config: Record<string, unknown> = {};
    if (!knownDriverForDaemonProvider(providerId, nonEmpty(rawValue.extends))) {
      config.ownIdentity = true;
    }
    if (command) config.binaryPath = command;
    const homeEnv = HOME_ENV[driver];
    if (homeEnv && env[homeEnv]) {
      if (driver === "claudeAgent") config.configDir = env[homeEnv];
      else if (driver === "codex") config.homePath = env[homeEnv];
      else if (driver === "pi" || driver === "omp") config.agentDir = env[homeEnv];
      else config.profileDir = env[homeEnv];
    }
    if (driver === "opencode") {
      if (env[OPENCODE_URL_ENV]) config.serverUrl = env[OPENCODE_URL_ENV];
      if (env[OPENCODE_PASSWORD_ENV]) config.serverPassword = env[OPENCODE_PASSWORD_ENV];
    }
    const models = additionalModels(rawValue.additionalModels);
    if (models) config.customModels = models.map((model) => model.id);

    const environment = environmentVariables(
      env,
      new Set(
        [homeEnv, OPENCODE_URL_ENV, OPENCODE_PASSWORD_ENV].filter((name): name is string =>
          Boolean(name),
        ),
      ),
    );

    const displayName = nonEmpty(rawValue.label);
    const instance: ProviderInstanceConfig = {
      driver,
      enabled: rawValue.enabled !== false,
      config,
      ...(displayName ? { displayName } : {}),
      ...(environment.length > 0 ? { environment } : {}),
    };
    providerInstances[providerId] = instance;
  }
  return { providers, providerInstances };
}

/** Launch fields with no daemon equivalent, kept in the bridge-local settings file. */
export function localProviderSettingsPatch(
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const local: Record<string, unknown> = { ...patch };
  if (isRecord(patch.providers)) {
    const providers: Record<string, Record<string, unknown>> = {};
    for (const [driver, rawValue] of Object.entries(patch.providers)) {
      if (!isRecord(rawValue)) continue;
      const presentation: Record<string, unknown> = {};
      for (const key of [
        "enableArtifacts",
        "confirmColdCacheResume",
        "experimentalWebSockets",
        "apiEndpoint",
        "launchArgs",
        "accounts",
        "selectedAccountId",
      ]) {
        if (rawValue[key] !== undefined) presentation[key] = rawValue[key];
      }
      if (Object.keys(presentation).length > 0) providers[driver] = presentation;
    }
    if (Object.keys(providers).length > 0) local.providers = providers;
    else delete local.providers;
  }
  if (isRecord(patch.providerInstances)) {
    const instances: Record<string, unknown> = {};
    for (const [instanceId, rawValue] of Object.entries(patch.providerInstances)) {
      if (!isRecord(rawValue)) continue;
      const presentation: Record<string, unknown> = {};
      for (const key of ["driver", "accentColor", "displayName"]) {
        if (rawValue[key] !== undefined) presentation[key] = rawValue[key];
      }
      if (Object.keys(presentation).length > 0) instances[instanceId] = presentation;
    }
    if (Object.keys(instances).length > 0) local.providerInstances = instances;
    else delete local.providerInstances;
  }
  return local;
}

export function daemonPatchForSettingsPatch(
  patch: Record<string, unknown>,
  currentProviders?: Record<string, unknown>,
): DaemonProviderPatch | null {
  const fromInstances = providerInstancesToDaemonPatch(
    patch.providerInstances as ProviderInstanceConfigMap | undefined,
    currentProviders,
  );
  const fromProviders = providerSettingsToDaemonPatch(
    patch.providers as Record<string, unknown> | undefined,
    currentProviders,
  );
  if (!fromInstances && !fromProviders) return null;
  const removeProviders = [
    ...(fromProviders?.removeProviders ?? []),
    ...(fromInstances?.removeProviders ?? []),
  ];
  return {
    providers: {
      ...fromProviders?.providers,
      ...fromInstances?.providers,
    },
    ...(removeProviders.length > 0 ? { removeProviders } : {}),
  };
}

export function touchesProviderSettings(patch: Record<string, unknown>): boolean {
  return patch.providers !== undefined || patch.providerInstances !== undefined;
}
