/**
 * The windows a ChatGPT account's backend reports as it answers: the
 * `x-codex-primary-*` and `x-codex-secondary-*` headers, and the
 * `codex.rate_limits` event ahead of a streamed reply. myna reads both and
 * keeps them as the account's usage (`gateway/codex_limits.go`), so a
 * window that is spent rests the account from the next turn on.
 */
export interface CodexLimit {
  usedPercent: number;
  windowMinutes: number;
  /** Epoch ms; null when the backend said nothing of it. */
  resetAt: number | null;
}

const LIMITS_SCAN = 64 << 10;

/** The windows the response headers tell; one without a length is left out. */
export function parseCodexLimitHeaders(headers: Headers, now = Date.now()): CodexLimit[] {
  const limits: CodexLimit[] = [];
  for (const which of ["primary", "secondary"]) {
    const prefix = `x-codex-${which}-`;
    const used = Number(headers.get(`${prefix}used-percent`));
    const minutes = Number(headers.get(`${prefix}window-minutes`));
    if (!Number.isFinite(used) || !Number.isFinite(minutes) || minutes <= 0) {
      continue;
    }
    limits.push({
      usedPercent: used,
      windowMinutes: minutes,
      resetAt: resetOf(headers, prefix, now),
    });
  }
  return limits;
}

function resetOf(headers: Headers, prefix: string, now: number): number | null {
  const at = Number(headers.get(`${prefix}reset-at`));
  if (Number.isFinite(at) && at > 0) {
    return at * 1000;
  }
  const after = Number(headers.get(`${prefix}reset-after-seconds`));
  return Number.isFinite(after) && after > 0 ? now + after * 1000 : null;
}

/**
 * The windows a `codex.rate_limits` event tells, from the first bytes of a
 * streamed reply. Null for another event, or a limit that is a model's own
 * allowance rather than the account's (`metered_limit_name`).
 */
export function parseCodexLimitEvent(chunk: string, now = Date.now()): CodexLimit[] | null {
  const at = chunk.indexOf("codex.rate_limits");
  if (at < 0) {
    return null;
  }
  const line =
    chunk
      .slice(at)
      .split("\n")
      .find((entry) => entry.includes("{")) ?? "";
  const start = line.indexOf("{");
  if (start < 0) {
    return null;
  }
  let event: unknown;
  try {
    event = JSON.parse(line.slice(start));
  } catch {
    return null;
  }
  if (!isRecord(event) || event.type !== "codex.rate_limits" || !isRecord(event.rate_limits)) {
    return null;
  }
  const metered = String(event.metered_limit_name ?? "")
    .trim()
    .toLowerCase()
    .replaceAll("-", "_");
  if (metered.length > 0 && metered !== "codex") {
    return null;
  }
  const limits: CodexLimit[] = [];
  for (const which of ["primary", "secondary"] as const) {
    const limit = limitOf(event.rate_limits[which], now);
    if (limit !== null) {
      limits.push(limit);
    }
  }
  return limits.length === 0 ? null : limits;
}

/** One window of a `codex.rate_limits` event, or null when it says too little. */
function limitOf(value: unknown, now: number): CodexLimit | null {
  if (!isRecord(value)) {
    return null;
  }
  const used = value.used_percent;
  const minutes = value.window_minutes;
  if (typeof used !== "number" || typeof minutes !== "number" || minutes <= 0) {
    return null;
  }
  return {
    usedPercent: used,
    windowMinutes: minutes,
    resetAt: resetAtOf(value.reset_at, value.reset_after_seconds, now),
  };
}

function resetAtOf(at: unknown, after: unknown, now: number): number | null {
  if (typeof at === "number" && at > 0) {
    return at * 1000;
  }
  if (typeof after === "number" && after > 0) {
    return now + after * 1000;
  }
  return null;
}

/** How many bytes of a reply the event is looked for in. */
export const CODEX_LIMITS_SCAN = LIMITS_SCAN;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const limitsByAccount = new Map<string, CodexLimit[]>();

/** Codex's own sign-in has no store id; its windows are kept under this key. */
export const CODEX_OWN_LIMIT_KEY = "codex-own";

/**
 * The one key an account's windows are written and read under: its store
 * id (`neolix:<chatgpt account id>`), which is also the `codexAccountId`
 * a gateway account names. Codex's own sign-in is `CODEX_OWN_LIMIT_KEY`.
 */
export function codexLimitKeyOf(account: { id: string }): string {
  return account.id;
}

/** Keeps what the backend said of an account, for routing and the status page. */
export function noteCodexLimits(accountId: string, limits: readonly CodexLimit[]): void {
  if (accountId.length === 0 || limits.length === 0) {
    return;
  }
  limitsByAccount.set(accountId, [...limits]);
}

/** What was last heard of an account, under `codexLimitKeyOf`'s key; empty when nothing was. */
export function codexLimitsOf(accountId: string): readonly CodexLimit[] {
  return limitsByAccount.get(accountId) ?? [];
}

/** Forgets every account's windows; tests use it between cases. */
export function clearCodexLimits(): void {
  limitsByAccount.clear();
}
