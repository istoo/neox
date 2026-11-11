import { authString, authNumber, providerOfKey, readPluginAuth } from "./store.js";
import { renewOnce, tokenStale, writeAuthTokens, type RefreshedTokens } from "./oauth.js";
import { CheckinHttpError, failedResult, type CheckinResult } from "./state.js";

/**
 * WorkBuddy's daily check-in (签到), ported from myna's
 * `internal/provider/workbuddy_checkin.go`. While the event runs, a
 * WorkBuddy (China) account gets a few credits a day for pressing 签到;
 * the gateway asks the event's status and claims when today's isn't in yet.
 *
 * Accounts come from myna's plugin sign-ins: `workbuddy` keeps the China
 * build's. myna checks in only that build; `workbuddy-ai`, the
 * international one, ships with the event off and is not part of a run.
 *
 * myna sends through the plugin's fetch, which renews and signs the request
 * as the account. Neolix sends the auth entry's access token as a bearer,
 * renewing it through the plugin's own refresh endpoint when it is about to
 * end and writing the result back where myna's file still holds the spent
 * token. A 401 is told apart exactly as myna does before asking the user to
 * act.
 */

export const WORKBUDDY_VENDOR = "workbuddy";
export const WORKBUDDY_BASE_URL = "https://copilot.tencent.com";
export const WORKBUDDY_USER_AGENT = "WorkBuddy/5.9.3";

export interface WorkbuddyAccount {
  /** Its entry in the check-in file: `workbuddy|<uid>`. */
  key: string;
  user: string;
  uid: string;
  access: string;
  /** The domain its sign-in gave, sent as X-Domain; the API's host otherwise. */
  domain?: string;
  /** The enterprise the account belongs to, sent as X-Enterprise-Id. */
  enterpriseId?: string;
  /** Its key in myna's plugin-auth.json, for writing a renewal back. */
  authKey: string;
  refresh?: string;
  expires?: number;
  refreshExpiresAt?: number;
}

export interface WorkbuddyRequestOptions {
  account: WorkbuddyAccount;
  /** myna's plugin-auth.json, where a renewal is written back. */
  authPath?: string;
  /** The API root, for tests; `https://copilot.tencent.com` otherwise. */
  baseUrl?: string;
  fetch?: typeof fetch;
  now?: () => Date;
  signal?: AbortSignal;
}

interface WorkbuddyStatus {
  active: boolean;
  today_checked_in: boolean;
  streak_days: number;
  daily_credit: number;
  today_credit: number;
}

interface WorkbuddyClaim {
  credit: number;
  streak_days: number;
  message: string;
}

/** WorkBuddy's business answers, the codes its claim refuses with. */
const WB_ALREADY = 1001;
const WB_INELIGIBLE = 1002;
const WB_ENDED = 1003;

/** Reads the sign-ins of both builds from myna's plugin-auth.json. */
export async function loadWorkbuddyAccounts(input: {
  authPath: string;
}): Promise<WorkbuddyAccount[]> {
  const auths = await readPluginAuth(input.authPath);
  const out: WorkbuddyAccount[] = [];
  const seen = new Set<string>();
  for (const [authKey, auth] of Object.entries(auths)) {
    const provider = providerOfKey(authKey);
    if (provider !== "workbuddy") {
      continue;
    }
    const uid = authString(auth, "uid");
    if (uid === "") continue;
    const key = `${WORKBUDDY_VENDOR}|${uid}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const name = authString(auth, "accountId");
    const domain = authString(auth, "domain");
    const enterpriseId = authString(auth, "enterpriseId");
    const refresh = authString(auth, "refresh");
    const expires = authNumber(auth, "expires");
    const refreshExpiresAt = authNumber(auth, "refreshExpiresAt");
    out.push({
      key,
      user: name !== "" ? name : uid,
      uid,
      access: authString(auth, "access"),
      authKey,
      ...(domain !== "" ? { domain } : {}),
      ...(enterpriseId !== "" ? { enterpriseId } : {}),
      ...(refresh !== "" ? { refresh } : {}),
      ...(expires !== undefined ? { expires } : {}),
      ...(refreshExpiresAt !== undefined ? { refreshExpiresAt } : {}),
    });
  }
  return out;
}

/**
 * Checks one account in for the day as WorkBuddy's 签到 does: the event's
 * status first, and a claim only while it runs and today's isn't in.
 */
export async function checkWorkbuddy(options: WorkbuddyRequestOptions): Promise<CheckinResult> {
  const account = await freshWorkbuddy(options);
  const baseUrl = options.baseUrl ?? WORKBUDDY_BASE_URL;
  const context: WorkbuddyCallContext = {
    baseUrl,
    headers: workbuddyHeaders(account, baseUrl),
    fetch: options.fetch ?? globalThis.fetch,
    signal: options.signal,
  };

  let status: WorkbuddyStatus;
  try {
    status = asStatus(await call(context, "/v2/billing/meter/checkin-activity-status"));
  } catch (error) {
    return unauthorizedOrRefused(context, error);
  }
  if (!status.active) {
    return { outcome: "inactive" };
  }
  if (status.today_checked_in) {
    // The plugin's own reading: a day already in says the credit only when
    // the vendor gave one, and the streak only when there is one.
    const credit = status.today_credit > 0 ? status.today_credit : status.daily_credit;
    return {
      outcome: "done",
      ...(credit > 0 ? { credit } : {}),
      ...(status.streak_days > 0 ? { streak: status.streak_days } : {}),
    };
  }

  let claim: WorkbuddyClaim;
  try {
    claim = asClaim(await call(context, "/v2/billing/meter/daily-checkin"));
  } catch (error) {
    const answer = await unauthorizedOrRefused(context, error);
    if (answer.outcome === "done" && status.streak_days !== 0) {
      answer.streak = status.streak_days;
    }
    return answer;
  }
  return {
    outcome: "claimed",
    credit: claim.credit,
    streak: claim.streak_days,
    msg: claim.message,
  };
}

/**
 * The account with an access token that isn't about to end, renewed as the
 * plugin's fetch renews one. A renewal that fails leaves the token there is,
 * and the vendor's 401 is told apart as myna does.
 */
async function freshWorkbuddy(options: WorkbuddyRequestOptions): Promise<WorkbuddyAccount> {
  const account = options.account;
  if (!tokenStale(account.expires)) {
    return account;
  }
  if (
    account.refresh === undefined ||
    account.refresh === "" ||
    (account.refreshExpiresAt !== undefined && Date.now() >= account.refreshExpiresAt)
  ) {
    return account;
  }
  const tokens = await renewOnce(`workbuddy:${account.authKey}`, () =>
    refreshWorkbuddyTokens(options),
  );
  if (tokens === null) {
    return account;
  }
  if (options.authPath !== undefined) {
    // Only where myna's file still holds the token this renewal spent;
    // another renewal's result is left alone.
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

/** The plugin's `/v2/plugin/auth/token/refresh`: the tokens it gave, or null. */
async function refreshWorkbuddyTokens(
  options: WorkbuddyRequestOptions,
): Promise<RefreshedTokens | null> {
  const account = options.account;
  const baseUrl = options.baseUrl ?? WORKBUDDY_BASE_URL;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": WORKBUDDY_USER_AGENT,
    "X-Refresh-Token": account.refresh ?? "",
    "X-Auth-Refresh-Source": "plugin",
    "X-Domain": account.domain ?? new URL(baseUrl).host,
  };
  if (account.enterpriseId !== undefined && account.enterpriseId !== "") {
    headers["X-Enterprise-Id"] = account.enterpriseId;
    headers["X-Tenant-Id"] = account.enterpriseId;
  }
  try {
    const response = await (options.fetch ?? globalThis.fetch)(
      `${baseUrl}/v2/plugin/auth/token/refresh`,
      {
        method: "POST",
        headers,
        body: "{}",
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
    );
    const text = await response.text();
    if (!response.ok) {
      return null;
    }
    const parsed = parseRefresh(text);
    return parsed === null ? null : refreshedWorkbuddy(parsed);
  } catch {
    return null;
  }
}

/** A refresh answer's JSON body, or null when it isn't one. */
function parseRefresh(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** The tokens a `/v2/plugin/auth/token/refresh` answer carries, or null. */
function refreshedWorkbuddy(parsed: Record<string, unknown>): RefreshedTokens | null {
  if (typeof parsed.code === "number" && parsed.code !== 0) {
    return null;
  }
  const data = asObject(parsed.data);
  const access = typeof data.accessToken === "string" ? data.accessToken : "";
  if (access === "") {
    return null;
  }
  const refresh = typeof data.refreshToken === "string" ? data.refreshToken : "";
  const expiresAt = typeof data.expiresAt === "number" ? data.expiresAt : 0;
  const expiresIn = typeof data.expiresIn === "number" ? data.expiresIn : 0;
  let expires = 0;
  if (expiresAt > 0) {
    expires = expiresAt;
  } else if (expiresIn > 0) {
    expires = Date.now() + expiresIn * 1000;
  }
  return {
    access,
    ...(refresh === "" ? {} : { refresh }),
    ...(expires > 0 ? { expires } : {}),
  };
}

interface WorkbuddyCallContext {
  baseUrl: string;
  headers: Record<string, string>;
  fetch: typeof fetch;
  signal?: AbortSignal;
}

/**
 * The headers the plugin's meter call sends (its `meterAsked`): the client's
 * own, so WorkBuddy counts the press under a client, and the enterprise's,
 * for an account signed in to one.
 */
function workbuddyHeaders(account: WorkbuddyAccount, baseUrl: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": WORKBUDDY_USER_AGENT,
    Authorization: `Bearer ${account.access}`,
    "X-User-Id": account.uid,
    "X-Domain": account.domain ?? new URL(baseUrl).host,
    "X-Product": "SaaS",
    "X-IDE-Type": "WorkBuddy",
  };
  if (account.enterpriseId !== undefined && account.enterpriseId !== "") {
    headers["X-Enterprise-Id"] = account.enterpriseId;
    headers["X-Tenant-Id"] = account.enterpriseId;
  }
  return headers;
}

/** A business error, whose code lets us tell a "come back" answer from a refusal. */
class WorkbuddyApiError extends Error {
  constructor(
    public readonly code: number,
    message: string,
  ) {
    super(message !== "" ? message : `error ${code}`);
    this.name = "WorkbuddyApiError";
  }
}

/**
 * Calls one of WorkBuddy's billing rows and gives its `data`. An error
 * status with the vendor's own `code`/`msg` is a business error; a bare
 * one is a status error (a 401 from its gateway is an HTML page).
 */
async function call(context: WorkbuddyCallContext, pathname: string): Promise<unknown> {
  const response = await context.fetch(`${context.baseUrl}${pathname}`, {
    method: "POST",
    headers: context.headers,
    body: "{}",
    signal: context.signal,
  });
  const text = await response.text();
  let envelope: Record<string, unknown> | undefined;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      envelope = parsed as Record<string, unknown>;
    }
  } catch {
    envelope = undefined;
  }
  const code = numberOrZero(envelope?.code);
  const msg = typeof envelope?.msg === "string" ? envelope.msg : "";
  if (!response.ok) {
    if (code !== 0) throw new WorkbuddyApiError(code, msg);
    if (msg !== "") throw new WorkbuddyApiError(response.status, msg);
    throw new CheckinHttpError(`HTTP ${response.status}`, response.status);
  }
  if (code !== 0) throw new WorkbuddyApiError(code, msg);
  return envelope?.data;
}

/**
 * A 401 is told apart at once: the account's credits are read with the same
 * headers. When they read, the sign-in is good and only the check-in
 * refuses us (it takes WorkBuddy's own app, with its device token); when
 * they don't, the sign-in itself is refused.
 */
async function unauthorizedOrRefused(
  context: WorkbuddyCallContext,
  error: unknown,
): Promise<CheckinResult> {
  if (!isUnauthorized(error)) {
    return refused(error);
  }
  try {
    await call(context, "/billing/meter/get-user-resource-summary");
  } catch {
    return {
      outcome: "failed",
      msg: "WorkBuddy refused this account's sign-in (401 Unauthorized); sign in to it again",
    };
  }
  return {
    outcome: "own-app",
    msg: "WorkBuddy answered the check-in 401 Unauthorized while this account's credits read fine: its check-in takes WorkBuddy's own app",
  };
}

function isUnauthorized(error: unknown): boolean {
  return (
    (error instanceof CheckinHttpError && error.status === 401) ||
    (error instanceof WorkbuddyApiError && error.code === 401)
  );
}

/** One of the vendor's answers for the day, or a failure to try again. */
function refused(error: unknown): CheckinResult {
  if (error instanceof WorkbuddyApiError) {
    switch (error.code) {
      case WB_ALREADY:
        return { outcome: "done", msg: error.message };
      case WB_INELIGIBLE:
        return { outcome: "ineligible", msg: error.message };
      case WB_ENDED:
        return { outcome: "inactive", msg: error.message };
    }
  }
  return failedResult(error);
}

function asStatus(data: unknown): WorkbuddyStatus {
  const entry = asObject(data);
  return {
    active: entry.active === true,
    today_checked_in: entry.today_checked_in === true,
    streak_days: numberOrZero(entry.streak_days),
    daily_credit: numberOrZero(entry.daily_credit),
    today_credit: numberOrZero(entry.today_credit),
  };
}

function asClaim(data: unknown): WorkbuddyClaim {
  const entry = asObject(data);
  return {
    credit: numberOrZero(entry.credit),
    streak_days: numberOrZero(entry.streak_days),
    message: typeof entry.message === "string" ? entry.message : "",
  };
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** WorkBuddy's numbers come as numbers or strings of them. */
function numberOrZero(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}
