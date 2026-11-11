import type { GatewayAccount, GatewayConfig, GatewayProvider } from "./config.js";

const CLOCK = /^(\d{1,2}):(\d{2})(?::\d{2})?$/;

/**
 * Reads a time of day the way myna's settings.Clock does: "6:00", "06:00"
 * and "21:30:00" all read, seconds dropped; anything else is null.
 */
export function clockOf(at: string): string | null {
  const match = CLOCK.exec(at.trim());
  if (match === null) {
    return null;
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) {
    return null;
  }
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/**
 * The times of day a warm-up starts a 5-hour window at, as kept: canonical,
 * once each, earliest first. myna's settings.clocks.
 */
export function normalizeWarmAts(ats: readonly string[]): string[] {
  const out = new Set<string>();
  for (const at of ats) {
    const clock = clockOf(at);
    if (clock !== null) {
      out.add(clock);
    }
  }
  return [...out].sort();
}

/**
 * An account's own time of day: a clock time, "off" for none, or "" to
 * follow its agent's list, myna's CodexWarmAtOf / ClaudeWarmAtOf.
 */
export function normalizeWarmAt(at: string | undefined): string {
  const trimmed = (at ?? "").trim();
  if (trimmed === "") {
    return "";
  }
  if (trimmed.toLowerCase() === "off") {
    return "off";
  }
  return clockOf(trimmed) ?? "";
}

/** The subscription a provider's accounts belong to, as myna tells its own. */
export function familyOf(provider: GatewayProvider): "codex" | "claude" | null {
  let host = "";
  try {
    host = new URL(provider.baseUrl).hostname.toLowerCase();
  } catch {
    host = "";
  }
  const name = `${provider.id.toLowerCase()} ${host}`;
  if (name.includes("claude") || name.includes("anthropic")) {
    return "claude";
  }
  if (name.includes("codex") || name.includes("chatgpt")) {
    return "codex";
  }
  return null;
}

/**
 * The times of day this account's 5-hour window is started at: its own time
 * when it has one, none when that is "off", its agent's list otherwise.
 */
export function warmAtsFor(
  provider: GatewayProvider,
  account: GatewayAccount,
  config: GatewayConfig,
): string[] {
  const own = normalizeWarmAt(account.warmAt);
  if (own === "off") {
    return [];
  }
  if (own !== "") {
    return [own];
  }
  const family = familyOf(provider);
  if (family === null) {
    return [];
  }
  return normalizeWarmAts(family === "codex" ? config.codexWarmAts : config.claudeWarmAts);
}

/** The config with one agent's warm-at list replaced, as the settings page saves it. */
export function withWarmAts(
  config: GatewayConfig,
  agent: "codex" | "claude",
  ats: readonly string[],
): GatewayConfig {
  return agent === "codex"
    ? { ...config, codexWarmAts: [...ats] }
    : { ...config, claudeWarmAts: [...ats] };
}

/**
 * The config with one account's own warm-at replaced, or null when no such
 * account is configured. An unknown provider or account is left alone.
 */
export function withAccountWarmAt(
  config: GatewayConfig,
  providerId: string,
  accountId: string,
  at: string,
): GatewayConfig | null {
  let found = false;
  const providers = config.providers.map((provider) => {
    if (provider.id !== providerId) {
      return provider;
    }
    const accounts = provider.accounts.map((account) => {
      if (account.id !== accountId) {
        return account;
      }
      found = true;
      return { ...account, warmAt: at };
    });
    return { ...provider, accounts };
  });
  return found ? { ...config, providers } : null;
}

/** Every warm-at kept canonical, as config writes and reads it. */
export function normalizeWarmAtConfig(config: GatewayConfig): GatewayConfig {
  return {
    ...config,
    codexWarmAts: normalizeWarmAts(config.codexWarmAts),
    claudeWarmAts: normalizeWarmAts(config.claudeWarmAts),
    providers: config.providers.map((provider) => ({
      ...provider,
      accounts: provider.accounts.map((account) => ({
        ...account,
        warmAt: normalizeWarmAt(account.warmAt),
      })),
    })),
  };
}
