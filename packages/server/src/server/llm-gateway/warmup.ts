import type { Logger } from "pino";
import { accountKey } from "./accounts.js";
import {
  isProviderEnabled,
  providerAccounts,
  type GatewayAccount,
  type GatewayConfig,
  type GatewayProvider,
} from "./config.js";
import { buildUpstreamHeaders } from "./upstream.js";
import { familyOf, warmAtsFor } from "./warm-at.js";
import { shouldWarm, warmAtTime, type WarmWindow } from "./warm-windows.js";

const WINDOW_MS = 5 * 60 * 60_000;
const TICK_MS = 10 * 60_000;

/**
 * How often a provider's accounts are warmed when no subscription windows
 * were read: its subscription's setting (codexWarmup/claudeWarmup) where it
 * is one, the 5-hour window otherwise. 0 says never.
 */
function cadenceFor(provider: GatewayProvider, config: GatewayConfig | undefined): number {
  const family = familyOf(provider);
  if (family === null || config === undefined) {
    return WINDOW_MS;
  }
  const plan = family === "codex" ? config.codexWarmup : config.claudeWarmup;
  // "week" waits for the account's real weekly window (warm-windows.ts), so
  // without a reading there is no cadence to guess it from.
  return plan === "all" ? WINDOW_MS : 0;
}

/**
 * Sends one tiny request per account per quota window, so the window starts
 * at a known time instead of on the first real turn. Opt-in per account:
 * every warm-up spends the account's own allowance.
 */
export async function warmAccount(input: {
  provider: GatewayProvider;
  account: GatewayAccount;
  logger: Logger;
  fetchImpl?: typeof fetch;
}): Promise<number> {
  const model = input.provider.models[0]?.id;
  if (model === undefined) {
    return 0;
  }
  const request = warmupRequest(input.provider, model, input.account);
  const fetchImpl = input.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(request.url, {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal: AbortSignal.timeout(30_000),
    });
    await response.body?.cancel();
    input.logger.info(
      { provider: input.provider.id, account: input.account.id, status: response.status },
      "Warmed a quota window",
    );
    return response.status;
  } catch (error) {
    input.logger.warn(
      { err: error, provider: input.provider.id, account: input.account.id },
      "Cannot warm a quota window",
    );
    return 0;
  }
}

interface WarmupRequest {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

export function warmupRequest(
  provider: GatewayProvider,
  model: string,
  account: GatewayAccount,
  incomingHeaders: Record<string, string> = {},
): WarmupRequest {
  const base = account.baseUrl ?? provider.baseUrl;
  const headers = buildUpstreamHeaders(provider, account, incomingHeaders);
  if (provider.protocol === "anthropic") {
    return {
      url: join(base, "/v1/messages"),
      headers,
      body: { model, max_tokens: 1, messages: [{ role: "user", content: "ping" }] },
    };
  }
  if (provider.protocol === "openai") {
    return {
      url: join(base, "/v1/chat/completions"),
      headers,
      body: { model, max_tokens: 1, messages: [{ role: "user", content: "ping" }] },
    };
  }
  if (provider.protocol === "openai-responses") {
    return {
      url: join(base, "/v1/responses"),
      headers,
      body: { model, input: "ping", max_output_tokens: 16 },
    };
  }
  return {
    url: join(base, `/v1beta/models/${encodeURIComponent(model)}:generateContent`),
    headers,
    body: {
      contents: [{ role: "user", parts: [{ text: "ping" }] }],
      generationConfig: { maxOutputTokens: 1 },
    },
  };
}

function join(baseUrl: string, requestPath: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  for (const version of ["/v1beta", "/v1"]) {
    if (base.endsWith(version) && requestPath.startsWith(`${version}/`)) {
      return `${base}${requestPath.slice(version.length)}`;
    }
  }
  return `${base}${requestPath}`;
}

export class WarmupScheduler {
  private readonly options: {
    providers: () => GatewayProvider[];
    logger: Logger;
    now?: () => number;
    /** The gateway config, for the subscription warm-up settings. */
    config?: () => GatewayConfig;
    /**
     * An account's subscription windows, as the usage sources read them;
     * undefined when no reading names it. Without one, the scheduled warm-up
     * falls back to a fixed cadence.
     */
    windows?: (
      provider: GatewayProvider,
      account: GatewayAccount,
    ) => Promise<readonly WarmWindow[] | undefined> | readonly WarmWindow[] | undefined;
  };

  private readonly lastWarm = new Map<string, number>();
  /** When each account was last started for a time of day, as warmup_daily. */
  private readonly lastDaily = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;

  constructor(options: {
    providers: () => GatewayProvider[];
    logger: Logger;
    now?: () => number;
    config?: () => GatewayConfig;
    windows?: (
      provider: GatewayProvider,
      account: GatewayAccount,
    ) => Promise<readonly WarmWindow[] | undefined> | readonly WarmWindow[] | undefined;
  }) {
    this.options = options;
  }

  public start(): void {
    void this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, TICK_MS);
    this.timer.unref();
  }

  public dispose(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Warms one account now, as the settings page's Warm up button asks.
   * Returns the upstream's status, or null when the account is not in the
   * config any more. A failed warm is a status of 0, as `warmAccount` has it.
   */
  public async warmNow(
    providerId: string,
    accountId: string,
  ): Promise<{ status: number; at: number } | null> {
    for (const provider of this.options.providers()) {
      if (provider.id !== providerId) {
        continue;
      }
      for (const account of providerAccounts(provider)) {
        if (account.id !== accountId) {
          continue;
        }
        const status = await warmAccount({ provider, account, logger: this.options.logger });
        const at = (this.options.now ?? Date.now)();
        this.lastWarm.set(accountKey(provider, account), at);
        return { status, at };
      }
    }
    return null;
  }

  public async tick(): Promise<void> {
    const now = (this.options.now ?? Date.now)();
    const config = this.options.config?.();
    for (const provider of this.options.providers()) {
      if (!isProviderEnabled(provider)) {
        continue;
      }
      for (const account of providerAccounts(provider)) {
        if (!account.warmup || !account.enabled) {
          continue;
        }
        const key = accountKey(provider, account);
        const windows = await this.readWindows(provider, account);
        if (!this.dueNow({ provider, account, config, windows, now, key })) {
          continue;
        }
        this.lastWarm.set(key, now);
        await warmAccount({ provider, account, logger: this.options.logger });
      }
    }
  }

  private async readWindows(
    provider: GatewayProvider,
    account: GatewayAccount,
  ): Promise<readonly WarmWindow[] | undefined> {
    if (this.options.windows === undefined) {
      return undefined;
    }
    try {
      return await this.options.windows(provider, account);
    } catch (error) {
      this.options.logger.warn(
        { err: error, provider: provider.id, account: account.id },
        "Cannot read the account's subscription windows",
      );
      return undefined;
    }
  }

  /**
   * Whether this account is due a warm now: a time of day it hasn't had
   * today, with its 5-hour window not running; then the subscription's plan
   * against the windows it read (week/all) — or the fixed cadence when no
   * windows were read, as myna falls back for a vendor without readings.
   */
  private dueNow(input: {
    provider: GatewayProvider;
    account: GatewayAccount;
    config: GatewayConfig | undefined;
    windows: readonly WarmWindow[] | undefined;
    now: number;
    key: string;
  }): boolean {
    const { provider, account, config, windows, now, key } = input;
    const last = this.lastWarm.get(key) ?? 0;
    if (config !== undefined && windows !== undefined) {
      const times = warmAtsFor(provider, account, config);
      if (warmAtTime({ windows, times, now, lastDaily: this.lastDaily.get(key) ?? 0 })) {
        this.lastDaily.set(key, now);
        return true;
      }
    }
    const family = familyOf(provider);
    if (family !== null && config !== undefined && windows !== undefined) {
      const plan = family === "codex" ? config.codexWarmup : config.claudeWarmup;
      return shouldWarm({ windows, plan, now, lastWarm: last }).warm;
    }
    const cadence = cadenceFor(provider, config);
    return cadence > 0 && now - last >= cadence;
  }
}
