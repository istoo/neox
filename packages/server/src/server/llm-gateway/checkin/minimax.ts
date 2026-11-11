import { createHash } from "node:crypto";
import { authNumber, authString, providerOfKey, readPluginAuth } from "./store.js";
import { renewOnce, tokenStale, writeAuthTokens, type RefreshedTokens } from "./oauth.js";
import { CheckinHttpError, failedResult, type CheckinResult } from "./state.js";

/**
 * MiniMax Code's daily check-in (签到), ported from myna's
 * `internal/provider/minimax_checkin.go`. The panel is asked first, and
 * today's claimed only while it is claimable. Requests carry the page's own
 * signature (`x-timestamp`, `x-signature`), though MiniMax doesn't check it
 * now.
 *
 * Accounts come from myna's plugin sign-ins `minimax-code` (China) and
 * `minimax-code-global` (international). Neolix sends the entry's access
 * token as a bearer and renews it through the plugin's OAuth refresh grant
 * when it is about to end, writing the result back where myna's file still
 * holds the spent token.
 */

export const MINIMAX_VENDOR = "minimax";
export const MINIMAX_CHINA_ID = "minimax-code";
export const MINIMAX_GLOBAL_ID = "minimax-code-global";

/** The page's signing secret, as myna's `miniMaxSignSecret` has it. */
export const MINIMAX_SIGN_SECRET = "I*7Cf%WZ#S&%1RlZJ&C2";

const MINIMAX_CHECKIN_URLS: Record<MinimaxSite, string> = {
  [MINIMAX_CHINA_ID]: "https://agent.minimax.cn/minimax-cloud/api/v1/signin",
  [MINIMAX_GLOBAL_ID]: "https://agent.minimax.io/minimax-cloud/api/v1/signin",
};

/** The day's time zone the panel is asked for (myna hardcodes the escaped form). */
const MINIMAX_TIMEZONE = "Asia%2FShanghai";

export type MinimaxSite = "minimax-code" | "minimax-code-global";

export interface MinimaxAccount {
  /** Its entry in the check-in file: `<site>|<uid>`. */
  key: string;
  user: string;
  uid: string;
  access: string;
  site: MinimaxSite;
  /** Its key in myna's plugin-auth.json, for writing a renewal back. */
  authKey: string;
  refresh?: string;
  expires?: number;
}

export interface MinimaxRequestOptions {
  account: MinimaxAccount;
  /** myna's plugin-auth.json, where a renewal is written back. */
  authPath?: string;
  /** The sign-in API root, for tests; the site's otherwise. */
  baseUrl?: string;
  /** The OAuth root a renewal is asked at, for tests; the site's otherwise. */
  accountUrl?: string;
  fetch?: typeof fetch;
  now?: () => Date;
  signal?: AbortSignal;
}

/** A day of the check-in panel, by its status. */
const MM_DAY_CLAIMED = 3;
const MM_DAY_DISABLED = 4;

interface MinimaxDay {
  dayNo: number;
  points: number;
  status: number;
  isToday: boolean;
}

/** Reads MiniMax Code's sign-ins on both sites from myna's plugin-auth.json. */
export async function loadMinimaxAccounts(input: { authPath: string }): Promise<MinimaxAccount[]> {
  const auths = await readPluginAuth(input.authPath);
  const out: MinimaxAccount[] = [];
  const seen = new Set<string>();
  for (const [authKey, auth] of Object.entries(auths)) {
    const provider = providerOfKey(authKey);
    if (provider !== MINIMAX_CHINA_ID && provider !== MINIMAX_GLOBAL_ID) {
      continue;
    }
    const uid = authString(auth, "realUserID") || authString(auth, "uid");
    if (uid === "") continue;
    const key = `${provider}|${uid}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const name = authString(auth, "accountId");
    const refresh = authString(auth, "refresh");
    const expires = authNumber(auth, "expires");
    out.push({
      key,
      user: name !== "" ? name : uid,
      uid,
      access: authString(auth, "access"),
      site: provider,
      authKey,
      ...(refresh === "" ? {} : { refresh }),
      ...(expires === undefined ? {} : { expires }),
    });
  }
  return out;
}

/**
 * Checks one account in for the day as MiniMax Code's page does: the panel
 * first, and a claim only while today's is claimable. The streak is today's
 * day of the week's panel.
 */
export async function checkMinimax(options: MinimaxRequestOptions): Promise<CheckinResult> {
  const account = await freshMinimax(options);
  const context: MinimaxCallContext = {
    baseUrl: options.baseUrl ?? MINIMAX_CHECKIN_URLS[account.site],
    access: account.access,
    fetch: options.fetch ?? globalThis.fetch,
    now: options.now ?? (() => new Date()),
    signal: options.signal,
  };

  let status: Record<string, unknown>;
  try {
    status = asObject(await call(context, "GET", "/status", ""));
  } catch (error) {
    return failedResult(error);
  }
  const statusBase = asBase(status);
  if (statusBase.code !== 0) {
    return {
      outcome: "failed",
      msg: `code ${statusBase.code}: ${statusBase.msg}`,
    };
  }

  const data = asObject(status.data);
  const days = Array.isArray(data.days) ? data.days : [];
  const today = days.map(asDay).find((day) => day.isToday);
  if (today === undefined) {
    return { outcome: "inactive" };
  }
  if (today.status === MM_DAY_CLAIMED) {
    return { outcome: "done", credit: today.points, streak: today.dayNo };
  }
  if (today.status === MM_DAY_DISABLED) {
    return {
      outcome: "ineligible",
      msg: "today's check-in is closed for this account",
    };
  }

  let claim: Record<string, unknown>;
  try {
    claim = asObject(await call(context, "POST", "/claim", "{}"));
  } catch (error) {
    return failedResult(error);
  }
  const claimBase = asBase(claim);
  if (claimBase.code !== 0) {
    return {
      outcome: "failed",
      msg: `code ${claimBase.code}: ${claimBase.msg}`,
    };
  }
  const claimed = asObject(claim.data);
  const day = numberOrZero(claimed.day_no) || today.dayNo;
  const credit = numberOrZero(claimed.points) || today.points;
  switch (numberOrZero(claimed.claim_result)) {
    case 1:
      return { outcome: "claimed", credit, streak: day };
    case 2:
      return { outcome: "done", credit, streak: day };
    default:
      return {
        outcome: "failed",
        msg: `claim_result ${numberOrZero(claimed.claim_result)}`,
      };
  }
}

/** The OAuth host each site's renewal is asked at (the plugin's `site.account`). */
const MINIMAX_ACCOUNT_URLS: Record<MinimaxSite, string> = {
  [MINIMAX_CHINA_ID]: "https://account.minimax.cn",
  [MINIMAX_GLOBAL_ID]: "https://account.minimax.io",
};

/**
 * The account with an access token that isn't about to end, renewed as the
 * plugin's fetch renews one. A renewal that fails leaves the token there is.
 */
async function freshMinimax(options: MinimaxRequestOptions): Promise<MinimaxAccount> {
  const account = options.account;
  if (!tokenStale(account.expires)) {
    return account;
  }
  if (account.refresh === undefined || account.refresh === "") {
    return account;
  }
  const tokens = await renewOnce(`minimax:${account.authKey}`, () => refreshMinimaxTokens(options));
  if (tokens === null) {
    return account;
  }
  if (options.authPath !== undefined) {
    await writeAuthTokens({
      authPath: options.authPath,
      authKey: account.authKey,
      expectedAccess: account.access,
      tokens,
    });
  }
  return {
    ...account,
    access: tokens.access,
    ...(tokens.refresh === undefined ? {} : { refresh: tokens.refresh }),
    ...(tokens.expires === undefined ? {} : { expires: tokens.expires }),
  };
}

/** The plugin's `/oauth2/token` refresh grant: the tokens it gave, or null. */
async function refreshMinimaxTokens(
  options: MinimaxRequestOptions,
): Promise<RefreshedTokens | null> {
  const account = options.account;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: account.refresh ?? "",
    client_id: "mcode-public",
    scope: "agent.default",
    audience: "agent-backend",
  });
  try {
    const response = await (options.fetch ?? globalThis.fetch)(
      `${options.accountUrl ?? MINIMAX_ACCOUNT_URLS[account.site]}/oauth2/token`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: body.toString(),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
    );
    if (!response.ok) {
      return null;
    }
    const parsed = (await response.json()) as Record<string, unknown>;
    const access = typeof parsed.access_token === "string" ? parsed.access_token : "";
    if (access === "") {
      return null;
    }
    const refresh = typeof parsed.refresh_token === "string" ? parsed.refresh_token : "";
    const expiresIn = typeof parsed.expires_in === "number" ? parsed.expires_in : 0;
    return {
      access,
      ...(refresh === "" ? {} : { refresh }),
      ...(expiresIn > 0 ? { expires: Date.now() + expiresIn * 1000 } : {}),
    };
  } catch {
    return null;
  }
}

interface MinimaxCallContext {
  baseUrl: string;
  access: string;
  fetch: typeof fetch;
  now: () => Date;
  signal?: AbortSignal;
}

/**
 * Asks the check-in's path as the account, signed as MiniMax Code's page
 * signs it. A 401 or the sign-in header's `expired` asks the user to sign
 * in again; the vendor's own `base_resp` error is kept with its code.
 */
async function call(
  context: MinimaxCallContext,
  method: "GET" | "POST",
  pathname: string,
  body: string,
): Promise<unknown> {
  const timestamp = Math.floor(context.now().getTime() / 1000).toString();
  const signature = createHash("md5")
    .update(`${timestamp}${MINIMAX_SIGN_SECRET}${body}`)
    .digest("hex");
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
    Authorization: `Bearer ${context.access}`,
    "x-timestamp": timestamp,
    "x-signature": signature,
  };
  const response = await context.fetch(
    `${context.baseUrl}${pathname}?timezone_id=${MINIMAX_TIMEZONE}`,
    {
      method,
      headers,
      ...(method === "POST" ? { body } : {}),
      signal: context.signal,
    },
  );
  const text = await response.text();
  const expired = response.headers.get("x-magpie-sign-in")?.toLowerCase() === "expired";
  if (expired || response.status === 401) {
    throw new Error("MiniMax Code's sign-in has expired — sign in again");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    parsed = undefined;
  }
  if (!response.ok) {
    const base = asBase(asObject(parsed));
    if (base.code !== 0) {
      throw new Error(`code ${base.code}: ${base.msg}`);
    }
    throw new CheckinHttpError(`HTTP ${response.status}`, response.status);
  }
  if (parsed === undefined) {
    throw new CheckinHttpError(`HTTP ${response.status}: answer doesn't parse`, response.status);
  }
  return parsed;
}

function asBase(value: Record<string, unknown>): { code: number; msg: string } {
  const base = asObject(value.base_resp);
  return {
    code: numberOrZero(base.status_code),
    msg: typeof base.status_msg === "string" ? base.status_msg : "",
  };
}

function asDay(value: unknown): MinimaxDay {
  const entry = asObject(value);
  return {
    dayNo: numberOrZero(entry.day_no),
    points: numberOrZero(entry.points),
    status: numberOrZero(entry.status),
    isToday: entry.is_today === true,
  };
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function numberOrZero(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}
