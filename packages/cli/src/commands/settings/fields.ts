/**
 * `neolix settings` reads and writes this computer's config.json, the store
 * the daemon reads at start and Settings › Network edits — myna's
 * `myna settings` (internal/cli/settings_cli.go:16), which covers the settings
 * the window saves. Keys are the file's own paths. A set is written and read
 * back through the daemon's parser, which validates the whole file, so a value
 * that doesn't check out is rolled back.
 */

export type SettingType = "on|off" | "number" | "text" | "list" | "JSON";

export interface SettingField {
  key: string;
  type: SettingType;
  integer?: boolean;
  choices?: string[];
}

const LOG_LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"] as const;
const LOG_FORMATS = ["pretty", "json"] as const;

/**
 * Every scalar setting config.json holds, with the default the daemon applies
 * when the file doesn't set it. Nested collections the daemon takes whole
 * (profiles, providers, plugins) aren't rows here; edit those in the app.
 */
const UNSORTED: readonly SettingField[] = [
  { key: "app.baseUrl", type: "text" },
  { key: "agents.catalogRefreshTimeoutMs", type: "number", integer: true },
  { key: "agents.idleRuntimeCleanup", type: "on|off" },
  { key: "agents.resumeOnStartup", type: "on|off" },
  { key: "agents.resumePrompt", type: "text" },
  { key: "daemon.appendSystemPrompt", type: "text" },
  { key: "daemon.autoArchiveAfterMerge", type: "on|off" },
  { key: "daemon.browserTools.enabled", type: "on|off" },
  { key: "daemon.cors.allowedOrigins", type: "list" },
  { key: "daemon.enableTerminalAgentHooks", type: "on|off" },
  { key: "daemon.git.maxProcessConcurrency", type: "number", integer: true },
  { key: "daemon.git.maxProcessesPerSecond", type: "number", integer: true },
  { key: "daemon.hostnames", type: "JSON" },
  { key: "daemon.allowedHosts", type: "JSON" },
  { key: "daemon.lan", type: "on|off" },
  { key: "daemon.mcp.enabled", type: "on|off" },
  { key: "daemon.mcp.injectIntoAgents", type: "on|off" },
  { key: "daemon.noWslAgents", type: "on|off" },
  { key: "daemon.port", type: "number", integer: true },
  { key: "daemon.relay.enabled", type: "on|off" },
  { key: "daemon.relay.endpoint", type: "text" },
  { key: "daemon.relay.publicEndpoint", type: "text" },
  { key: "daemon.relay.publicUseTls", type: "on|off" },
  { key: "daemon.relay.requireProtectedSecurity", type: "on|off" },
  { key: "daemon.relay.useTls", type: "on|off" },
  { key: "daemon.serviceProxy.publicBaseUrl", type: "text" },
  { key: "daemon.telemetry.enabled", type: "on|off" },
  { key: "daemon.telemetry.shareUsage", type: "on|off" },
  { key: "daemon.trustedProxies", type: "JSON" },
  { key: "daemon.usage.enabled", type: "on|off" },
  { key: "features.webUi.distDir", type: "text" },
  { key: "features.webUi.enabled", type: "on|off" },
  { key: "log.console.format", type: "text", choices: [...LOG_FORMATS] },
  { key: "log.console.level", type: "text", choices: [...LOG_LEVELS] },
  { key: "log.format", type: "text", choices: [...LOG_FORMATS] },
  { key: "log.level", type: "text", choices: [...LOG_LEVELS] },
  { key: "pluginsEnabled", type: "on|off" },
  { key: "sessionTerminal", type: "text" },
];

const FIELDS: readonly SettingField[] = [...UNSORTED].sort((left, right) =>
  left.key.localeCompare(right.key),
);

/** The defaults the daemon applies to a field this file doesn't set. */
const DEFAULTS: Readonly<Record<string, unknown>> = {
  "daemon.port": 6868,
  "daemon.lan": false,
  "daemon.mcp.enabled": true,
  "daemon.mcp.injectIntoAgents": true,
  "daemon.usage.enabled": true,
  "daemon.telemetry.enabled": false,
  "daemon.telemetry.shareUsage": false,
  "daemon.browserTools.enabled": false,
  "daemon.relay.enabled": false,
  "daemon.relay.requireProtectedSecurity": false,
  "daemon.relay.endpoint": "",
  "daemon.trustedProxies": ["loopback"],
  "daemon.cors.allowedOrigins": [],
  "app.baseUrl": "",
  pluginsEnabled: true,
  sessionTerminal: "",
};

/** Every setting config.json holds, by its path in the file. */
export function settingsFields(): readonly SettingField[] {
  return FIELDS;
}

export function settingDefault(key: string): unknown {
  return DEFAULTS[key];
}

/** A value as list and get print it, as myna's shown does. */
export function shown(value: unknown): string {
  if (value === undefined || value === null) {
    return "-";
  }
  if (typeof value === "boolean") {
    return value ? "on" : "off";
  }
  if (typeof value === "string") {
    return value.length === 0 ? '""' : value;
  }
  if (typeof value === "number") {
    return String(value);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return "[]";
    }
    return value.every((entry) => typeof entry === "string")
      ? value.join(",")
      : JSON.stringify(value);
  }
  return JSON.stringify(value);
}

/** Text as the JSON a setting of this type is saved as, as myna's settingValue. */
export function settingValue(field: SettingField, text: string): unknown {
  const value = text.trim();
  switch (field.type) {
    case "on|off": {
      const lower = value.toLowerCase();
      if (["on", "true", "yes", "1"].includes(lower)) {
        return true;
      }
      if (["off", "false", "no", "0"].includes(lower)) {
        return false;
      }
      throw new Error(`${field.key} is on or off, not "${text}"`);
    }
    case "number": {
      const parsed = Number(value);
      if (value.length === 0 || !Number.isFinite(parsed)) {
        throw new Error(`${field.key} is a number, not "${text}"`);
      }
      if (field.integer === true && !Number.isInteger(parsed)) {
        throw new Error(`${field.key} is a whole number, not "${text}"`);
      }
      return parsed;
    }
    case "text": {
      if (field.choices !== undefined && !field.choices.includes(value)) {
        throw new Error(`${field.key} is ${field.choices.join("|")}, not "${text}"`);
      }
      return text;
    }
    case "list": {
      if (value.startsWith("[")) {
        const parsed: unknown = JSON.parse(value);
        if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
          throw new Error(`${field.key} is a list of words, as a or a,b or ["a","b"]`);
        }
        return parsed;
      }
      return value
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
    }
    default: {
      try {
        return JSON.parse(value);
      } catch (cause) {
        throw new Error(`${field.key} is JSON (${field.type}): ${String(cause)}`, { cause });
      }
    }
  }
}
