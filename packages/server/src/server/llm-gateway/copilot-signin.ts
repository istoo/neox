import { errorMessage, isRecord, readJson } from "./oauth.js";
import { fetchThroughProxy } from "./proxy-fetch.js";
import type { CopilotAccount } from "./subscription-store.js";
import { subscriptionAccountId } from "./subscription-store.js";

/**
 * Signing in to a Copilot account: GitHub's device code, under the OAuth
 * app Copilot's editors sign in with (`provider/copilot_signin.go:36-38`).
 * An enterprise on GitHub Enterprise Cloud with data residency signs in
 * at its own `<name>.ghe.com` (`provider/copilot_ghe.go`).
 */

const CLIENT_ID = "Iv1.b507a08c87ecfe98";
const GITHUB_DEVICE_URL = "https://github.com/login/device/code";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL = "https://api.github.com/user";
const COPILOT_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token";
const COPILOT_USER_URL = "https://api.github.com/copilot_internal/user";
const COPILOT_BASE = "https://api.githubcopilot.com";

/** The editors' headers (`provider/account.go:1284-1290`). */
export const COPILOT_EDITOR_HEADERS: Readonly<Record<string, string>> = {
  "Editor-Version": "vscode/1.140.0",
  "Editor-Plugin-Version": "copilot-chat/0.68.0",
  "Copilot-Integration-Id": "vscode-chat",
  "User-Agent": "GitHubCopilotChat/0.68.0",
};

/**
 * What Copilot's API wants on every request: the editors' headers and its
 * API version (`account.go:1292-1305`). Without the version Copilot reads
 * Auto's session token as a hand-picked model.
 */
export function copilotApiHeaders(): Record<string, string> {
  return { ...COPILOT_EDITOR_HEADERS, "X-GitHub-Api-Version": "2026-01-09" };
}

/** Copilot's plan ids as the app names them (`copilot_accounts.go:344-348`). */
const PLAN_NAMES: Readonly<Record<string, string>> = {
  free: "Free",
  individual: "Pro",
  individual_pro: "Pro+",
  individual_max: "Max",
  individual_edu: "Education",
  business: "Business",
  enterprise: "Enterprise",
};

const GHE_NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** Where a Copilot account signs in: "" for github.com, "<name>.ghe.com". */
export function copilotHostOf(input: string): { host: string } | { error: string } {
  let name = input.trim().toLowerCase();
  if (name.includes("://")) {
    try {
      const url = new URL(name);
      if (url.protocol !== "https:" && url.protocol !== "http:") {
        return { error: `not a GitHub host: ${input.trim()}` };
      }
      if (url.username !== "" || url.port !== "" || (url.pathname !== "" && url.pathname !== "/")) {
        return { error: `not a GitHub host: ${input.trim()}` };
      }
      if (url.search !== "" || url.hash !== "") {
        return { error: `not a GitHub host: ${input.trim()}` };
      }
      name = url.hostname;
    } catch {
      return { error: `not a GitHub host: ${input.trim()}` };
    }
  }
  name = name.replace(/\/+$/, "");
  if (name === "" || name === "github.com" || name === "www.github.com") {
    return { host: "" };
  }
  const suffix = ".ghe.com";
  if (name.endsWith(suffix) && GHE_NAME.test(name.slice(0, -suffix.length))) {
    return { host: name };
  }
  return {
    error: `Copilot signs in on github.com or an enterprise's <name>.ghe.com, not ${input.trim()}`,
  };
}

/** A GitHub login on a host, as the account list names it (`copilot_accounts.go:34-44`). */
export function copilotAccountName(login: string, host: string): string {
  return host === "" || login === "" ? login : `${login}@${host}`;
}

function origin(host: string, sub: string): string {
  return sub === "" ? `https://${host}` : `https://${sub}.${host}`;
}

function deviceUrl(host: string): string {
  return host === "" ? GITHUB_DEVICE_URL : `${origin(host, "")}/login/device/code`;
}

function tokenUrl(host: string): string {
  return host === "" ? GITHUB_TOKEN_URL : `${origin(host, "")}/login/oauth/access_token`;
}

function userUrl(host: string): string {
  return host === "" ? GITHUB_USER_URL : `${origin(host, "api")}/user`;
}

function copilotUserUrl(host: string): string {
  return host === "" ? COPILOT_USER_URL : `${origin(host, "api")}/copilot_internal/user`;
}

function copilotTokenUrl(host: string): string {
  return host === "" ? COPILOT_TOKEN_URL : `${origin(host, "api")}/copilot_internal/v2/token`;
}

/** The Copilot API an account on a host is served at (`copilot_ghe.go:110-...`). */
export function copilotBaseOf(host: string): string {
  return host === "" ? COPILOT_BASE : `https://copilot-api.${host}`;
}

export interface CopilotOptions {
  fetchImpl?: typeof fetch;
  /** The proxy the sign-in and its token trades go through. */
  proxy?: string;
  now?: () => number;
}

export interface CopilotDeviceStart {
  url: string;
  code: string;
  deviceCode: string;
  intervalMs: number;
  /** Set when GitHub asked to slow down after the first poll. */
  expiresInMs: number;
}

export type CopilotDevicePoll =
  | { state: "waiting"; intervalMs?: number }
  | { state: "done"; githubToken: string }
  | { state: "error"; error: string };

/** Asks GitHub for a device code (`copilot_signin.go:59-90`). */
export async function startCopilotDeviceSignIn(
  input: { host: string } & CopilotOptions,
): Promise<{ start: CopilotDeviceStart } | { error: string }> {
  let response: Response;
  try {
    response = await fetchThroughProxy(input.proxy, input.fetchImpl)(deviceUrl(input.host), {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: new URLSearchParams({ client_id: CLIENT_ID, scope: "read:user" }).toString(),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    return { error: `couldn't reach GitHub: ${errorMessage(error)}` };
  }
  const body = await readJson(response);
  if (!response.ok) {
    return { error: `GitHub gave no sign-in code (${response.status})` };
  }
  if (!isRecord(body)) {
    return { error: "GitHub's sign-in code didn't read" };
  }
  const deviceCode = typeof body.device_code === "string" ? body.device_code : "";
  const code = typeof body.user_code === "string" ? body.user_code : "";
  const page = typeof body.verification_uri === "string" ? body.verification_uri : "";
  const interval = typeof body.interval === "number" ? body.interval : 5;
  const expiresIn = typeof body.expires_in === "number" ? body.expires_in : 900;
  if (deviceCode === "" || code === "") {
    return { error: "GitHub gave no sign-in code" };
  }
  return {
    start: {
      url: page !== "" ? page : hostDevicePage(input.host),
      code,
      deviceCode,
      intervalMs: Math.max(interval, 0) * 1000,
      expiresInMs: Math.max(expiresIn, 60) * 1000,
    },
  };
}

function hostDevicePage(host: string): string {
  return host === "" ? "https://github.com/login/device" : `${origin(host, "")}/login/device`;
}

/** Asks once whether the code was entered (`copilot_signin.go:96-160`). */
export async function pollCopilotDeviceSignIn(
  input: { host: string; deviceCode: string } & CopilotOptions,
): Promise<CopilotDevicePoll> {
  let response: Response;
  try {
    response = await fetchThroughProxy(input.proxy, input.fetchImpl)(tokenUrl(input.host), {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        device_code: input.deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }).toString(),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    return { state: "error", error: `couldn't ask GitHub for the token: ${errorMessage(error)}` };
  }
  const body = await readJson(response);
  if (!isRecord(body)) {
    return { state: "error", error: `GitHub answered the sign-in unreadably (${response.status})` };
  }
  const refusal = typeof body.error === "string" ? body.error : "";
  if (refusal === "authorization_pending") {
    return { state: "waiting" };
  }
  if (refusal === "slow_down") {
    return { state: "waiting", intervalMs: 5_000 };
  }
  if (refusal === "expired_token") {
    return { state: "error", error: "the code expired; start again" };
  }
  if (refusal === "access_denied") {
    return { state: "error", error: "the sign-in was declined on GitHub" };
  }
  if (refusal !== "") {
    const description = typeof body.error_description === "string" ? body.error_description : "";
    return { state: "error", error: `GitHub: ${refusal} ${description}`.trim() };
  }
  const githubToken = typeof body.access_token === "string" ? body.access_token : "";
  if (githubToken === "") {
    return { state: "error", error: `GitHub sent no token (${response.status})` };
  }
  return { state: "done", githubToken };
}

/**
 * Whose GitHub account the token is and which Copilot plan it has
 * (`copilot_accounts.go:352-...`). No plan, no Copilot.
 */
export async function completeCopilotSignIn(
  input: { githubToken: string; host: string; addedAt?: number } & CopilotOptions,
): Promise<{ account: CopilotAccount } | { error: string }> {
  const who = await getJson(input, userUrl(input.host), input.githubToken);
  if ("error" in who) {
    return { error: `GitHub didn't say whose account this is: ${who.error}` };
  }
  const login = typeof who.body.login === "string" ? who.body.login : "";
  if (login === "") {
    return { error: "GitHub didn't say whose account this is" };
  }
  const entitlement = await getJson(input, copilotUserUrl(input.host), input.githubToken);
  if ("error" in entitlement) {
    if (entitlement.status === 401 || entitlement.status === 403 || entitlement.status === 404) {
      return { error: `${login} has no Copilot subscription` };
    }
    return { error: `Copilot: ${entitlement.error}` };
  }
  const plan = planLabel(entitlement.body);
  const user = copilotAccountName(login, input.host);
  return {
    account: {
      agent: "copilot",
      id: subscriptionAccountId("copilot", login, input.host),
      user,
      plan,
      addedAt: input.addedAt ?? input.now?.() ?? Date.now(),
      lapsed: null,
      githubToken: input.githubToken,
      host: input.host,
    },
  };
}

export interface CopilotSession {
  token: string;
  /** Epoch ms. */
  expiresAt: number;
  /** The API the session names, else the host's default. */
  apiBase: string;
}

/**
 * Trades the GitHub token for a short-lived Copilot session token
 * (`account.go:1617-...`).
 */
export async function copilotSessionToken(
  input: { githubToken: string; host: string } & CopilotOptions,
): Promise<{ session: CopilotSession } | { error: string }> {
  let response: Response;
  try {
    response = await fetchThroughProxy(input.proxy, input.fetchImpl)(copilotTokenUrl(input.host), {
      method: "GET",
      headers: { accept: "application/json", ...COPILOT_EDITOR_HEADERS },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    return { error: `couldn't reach Copilot: ${errorMessage(error)}` };
  }
  const body = await readJson(response);
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      return { error: "Copilot refused the sign-in; sign in again" };
    }
    return { error: `Copilot gave no session token (${response.status})` };
  }
  if (!isRecord(body)) {
    return { error: "Copilot's session answer didn't read" };
  }
  const token = typeof body.token === "string" ? body.token : "";
  if (token === "") {
    return { error: "Copilot gave no session token" };
  }
  const expiresAt =
    typeof body.expires_at === "number" && body.expires_at > 0
      ? body.expires_at * 1000
      : (input.now?.() ?? Date.now()) + 25 * 60_000;
  const endpoints = isRecord(body.endpoints) ? body.endpoints : {};
  const api = typeof endpoints.api === "string" ? endpoints.api.replace(/\/+$/, "") : "";
  return {
    session: { token, expiresAt, apiBase: api !== "" ? api : copilotBaseOf(input.host) },
  };
}

function planLabel(body: Record<string, unknown>): string | null {
  const sku = typeof body.access_type_sku === "string" ? body.access_type_sku : "";
  if (sku === "free_educational_quota") {
    return "Education";
  }
  if (sku === "free_limited_copilot") {
    return "Free";
  }
  const plan = typeof body.copilot_plan === "string" ? body.copilot_plan.toLowerCase() : "";
  if (PLAN_NAMES[plan] !== undefined) {
    return PLAN_NAMES[plan] ?? null;
  }
  return plan === "" ? null : plan.charAt(0).toUpperCase() + plan.slice(1);
}

async function getJson(
  options: CopilotOptions,
  url: string,
  token: string,
): Promise<{ body: Record<string, unknown>; status: number } | { error: string; status: number }> {
  let response: Response;
  try {
    response = await fetchThroughProxy(options.proxy, options.fetchImpl)(url, {
      method: "GET",
      headers: { authorization: `token ${token}`, accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    return { error: errorMessage(error), status: 0 };
  }
  const body = await readJson(response);
  if (!response.ok) {
    return {
      error:
        isRecord(body) && typeof body.message === "string" ? body.message : `(${response.status})`,
      status: response.status,
    };
  }
  if (!isRecord(body)) {
    return { error: "the answer didn't read", status: response.status };
  }
  return { body, status: response.status };
}
