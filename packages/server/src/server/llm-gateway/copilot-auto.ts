import { copilotApiHeaders, copilotBaseOf } from "./copilot-signin.js";
import { errorMessage, isRecord, readJson } from "./oauth.js";
import { fetchThroughProxy } from "./proxy-fetch.js";

/**
 * Copilot's Auto: the model Copilot picks for the account
 * (`provider/copilot_auto.go:1-40`). Neolix asks `POST {api}/auto` with the
 * turn's prompt first, at Copilot Chat's API version; when that doesn't
 * answer, `POST {api}/models/session` with `auto_mode`. The pick is kept
 * for an hour per account. A model Copilot lists but refuses is reported,
 * so the caller can ask Auto again rather than send it again: refused
 * models are kept out per account for six hours, and a session token
 * Copilot no longer honours is let go (`provider/copilot_refused.go`).
 */

export const COPILOT_AUTO = "auto";

/** The version `/auto` takes; another is 404 (`copilot_auto.go:48`). */
const AUTO_VERSION = "2026-08-01";
/** The version `/models/session` takes (`copilot_auto.go:44`). */
const SESSION_VERSION = "2025-10-01";
/** How long an Auto pick is used (`copilot_auto.go:53`). */
const AUTO_REUSE_MS = 60 * 60_000;

export interface CopilotAutoPick {
  /** The model the requests go as. */
  model: string;
  /** The session token, sent as `Copilot-Session-Token`; null for a fallback. */
  sessionToken: string | null;
  via: "auto" | "models-session" | "fallback";
  /** Epoch ms. */
  expiresAt: number;
  /** Why `/auto`'s pick wasn't taken, when it wasn't. */
  skipped?: string;
  /** The endpoints the model's list names, when it names any. */
  endpoints?: string[];
}

export interface CopilotAutoOptions {
  fetchImpl?: typeof fetch;
  proxy?: string;
  now?: () => number;
}

/** The account a pick or a refusal belongs to: its host and GitHub token. */
export interface CopilotAccountRef {
  githubToken: string;
  host: string;
}

const picks = new Map<string, CopilotAutoPick>();

/** How long a model Copilot refused stays left out (`copilot_refused.go:21`). */
const REFUSED_FOR_MS = 6 * 60 * 60_000;

/** By account: model → when Copilot refused it. */
const refused = new Map<string, Map<string, number>>();

/** Forgets every Auto pick and refusal; a test, or a sign-out. */
export function clearCopilotAutoPicks(): void {
  picks.clear();
  refused.clear();
}

function pickKey(githubToken: string, host: string): string {
  return `${host}\u0000${githubToken}`;
}

/**
 * Notes that Copilot refused model for the account, as a 400
 * `model_not_supported` does (`copilot_refused.go:76-81`). The account's
 * Auto pick is let go when it was that model, so the next ask picks
 * another.
 */
export function markRefused(account: CopilotAccountRef, model: string, now = Date.now()): void {
  if (model === "" || model === COPILOT_AUTO) {
    return;
  }
  const key = pickKey(account.githubToken, account.host);
  const models = refused.get(key) ?? new Map<string, number>();
  models.set(model, now);
  refused.set(key, models);
  const kept = picks.get(key);
  if (kept?.model === model) {
    picks.delete(key);
  }
}

/** Whether the account was refused model lately (`copilot_refused.go:95-100`). */
export function isRefused(account: CopilotAccountRef, model: string, now = Date.now()): boolean {
  const at = refused.get(pickKey(account.githubToken, account.host))?.get(model);
  return at !== undefined && now - at < REFUSED_FOR_MS;
}

/**
 * Lets go of the pick Copilot said its session token no longer holds
 * ("Requested model not available for session"), so the next ask is made
 * with a session read anew (`copilot_refused.go:44-53`).
 */
export function invalidateSession(account: CopilotAccountRef): void {
  picks.delete(pickKey(account.githubToken, account.host));
}

/**
 * The model Copilot picks for the account, asked again after an hour or
 * when `fresh` is set (`copilot_auto.go:150-...`).
 */
export async function copilotAutoPick(
  input: {
    githubToken: string;
    host: string;
    /** The turn's prompt, which `/auto` picks from. */
    prompt?: string;
    /** The model to stand in when Copilot gives no pick (`AutoFallback`). */
    fallbackModel?: string;
    fresh?: boolean;
  } & CopilotAutoOptions,
): Promise<CopilotAutoPick | { error: string }> {
  const now = input.now?.() ?? Date.now();
  const key = pickKey(input.githubToken, input.host);
  const kept = picks.get(key);
  if (
    input.fresh !== true &&
    kept !== undefined &&
    kept.expiresAt - now > 60_000 &&
    !isRefused(input, kept.model, now)
  ) {
    return kept;
  }
  const api = copilotBaseOf(input.host);
  const headers = {
    ...copilotApiHeaders(),
    authorization: `Bearer ${input.githubToken}`,
    "content-type": "application/json",
    accept: "application/json",
  };
  const viaAuto = await postAuto({ ...input, now }, `${api}/auto`, headers);
  if ("pick" in viaAuto) {
    picks.set(key, viaAuto.pick);
    return viaAuto.pick;
  }
  const viaSession = await postSession({ ...input, now }, `${api}/models/session`, headers);
  if ("pick" in viaSession) {
    const pick = { ...viaSession.pick, skipped: viaAuto.error };
    picks.set(key, pick);
    return pick;
  }
  if (
    input.fallbackModel !== undefined &&
    input.fallbackModel !== "" &&
    !isRefused(input, input.fallbackModel, now)
  ) {
    const pick: CopilotAutoPick = {
      model: input.fallbackModel,
      sessionToken: null,
      via: "fallback",
      expiresAt: now + AUTO_REUSE_MS,
      skipped: viaAuto.error,
    };
    picks.set(key, pick);
    return pick;
  }
  return { error: viaSession.error };
}

interface PickRequest {
  fetchImpl?: typeof fetch;
  proxy?: string;
  githubToken: string;
  host: string;
  now: number;
}

async function postAuto(
  input: PickRequest & { prompt?: string },
  url: string,
  headers: Record<string, string>,
): Promise<{ pick: CopilotAutoPick } | { error: string }> {
  const answer = await postJson(
    input,
    url,
    { prompt: input.prompt ?? "" },
    {
      ...headers,
      "X-GitHub-Api-Version": AUTO_VERSION,
    },
  );
  if ("error" in answer) {
    return answer;
  }
  const pick = pickOf(answer.body, "auto", input.now);
  if (pick === null) {
    return { error: "Copilot's /auto gave no model" };
  }
  if (isRefused(input, pick.model, input.now)) {
    return { error: `Copilot picked ${pick.model}, which the account was refused` };
  }
  return { pick };
}

async function postSession(
  input: PickRequest,
  url: string,
  headers: Record<string, string>,
): Promise<{ pick: CopilotAutoPick } | { error: string }> {
  const answer = await postJson(
    input,
    url,
    { auto_mode: { model_hints: [COPILOT_AUTO] } },
    { ...headers, "X-GitHub-Api-Version": SESSION_VERSION },
  );
  if ("error" in answer) {
    return answer;
  }
  const pick = pickOf(answer.body, "models-session", input.now);
  if (pick !== null && !isRefused(input, pick.model, input.now)) {
    return { pick };
  }
  const first = firstAvailableModel(answer.body, input, input.now);
  if (first === "") {
    return { error: "Copilot's /models/session gave no model the account can use" };
  }
  const token = typeof answer.body.session_token === "string" ? answer.body.session_token : null;
  return {
    pick: {
      model: first,
      sessionToken: token,
      via: "models-session",
      expiresAt: input.now + AUTO_REUSE_MS,
    },
  };
}

function pickOf(
  body: Record<string, unknown>,
  via: "auto" | "models-session",
  now: number,
): CopilotAutoPick | null {
  const model = selectedModel(body.selected_model);
  if (model === "") {
    return null;
  }
  const token = typeof body.session_token === "string" ? body.session_token : null;
  const expires =
    typeof body.expires_at === "number" && body.expires_at > 0
      ? Math.min(body.expires_at * 1000, now + AUTO_REUSE_MS)
      : now + AUTO_REUSE_MS;
  const endpoints = selectedEndpoints(body.selected_model);
  return {
    model,
    sessionToken: token,
    via,
    expiresAt: expires,
    ...(endpoints === undefined ? {} : { endpoints }),
  };
}

function selectedModel(selected: unknown): string {
  if (typeof selected === "string") {
    return selected;
  }
  return isRecord(selected) && typeof selected.id === "string" ? selected.id : "";
}

/** The endpoints the pick's own entry names (`copilot_auto.go:313-317`). */
function selectedEndpoints(selected: unknown): string[] | undefined {
  if (!isRecord(selected) || !Array.isArray(selected.supported_endpoints)) {
    return undefined;
  }
  const endpoints = selected.supported_endpoints.filter(
    (endpoint): endpoint is string => typeof endpoint === "string",
  );
  return endpoints.length > 0 ? endpoints : undefined;
}

/** The first model Copilot offers that the account wasn't lately refused. */
function firstAvailableModel(
  body: Record<string, unknown>,
  account: CopilotAccountRef,
  now: number,
): string {
  if (!Array.isArray(body.available_models)) {
    return "";
  }
  for (const entry of body.available_models) {
    let id = "";
    if (typeof entry === "string") {
      id = entry;
    } else if (isRecord(entry) && typeof entry.id === "string") {
      id = entry.id;
    }
    if (id !== "" && !isRefused(account, id, now)) {
      return id;
    }
  }
  return "";
}

async function postJson(
  input: { fetchImpl?: typeof fetch; proxy?: string },
  url: string,
  body: unknown,
  headers: Record<string, string>,
): Promise<{ body: Record<string, unknown> } | { error: string }> {
  let response: Response;
  try {
    response = await fetchThroughProxy(input.proxy, input.fetchImpl)(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    return { error: `couldn't reach Copilot: ${errorMessage(error)}` };
  }
  const answer = await readJson(response);
  if (!response.ok) {
    return { error: `Copilot refused the pick (${response.status})` };
  }
  if (!isRecord(answer)) {
    return { error: "Copilot's pick didn't read" };
  }
  return { body: answer };
}

/** Copilot saying the model isn't served on the endpoint it was sent to. */
const ENDPOINT_REFUSED = /unsupported_api_for_model|not accessible via the \/[a-z/]+ endpoint/i;
/** Copilot saying the plan doesn't have the model at all. */
const MODEL_NOT_SERVED = /"model_not_supported"|requested model is not supported/i;
/** Copilot saying the session token no longer holds its model. */
const SESSION_GONE = /not available for session/i;

/** Why Copilot refused a request, when the retry has an answer. */
export type CopilotRefusal = "endpoint" | "model" | "session";

export function copilotRefusal(status: number, body: string): CopilotRefusal | null {
  if (status !== 400 && status !== 404) {
    return null;
  }
  if (SESSION_GONE.test(body)) {
    return "session";
  }
  if (ENDPOINT_REFUSED.test(body)) {
    return "endpoint";
  }
  if (MODEL_NOT_SERVED.test(body)) {
    return "model";
  }
  return null;
}

export type CopilotProtocol = "openai-responses" | "openai" | "anthropic";

/**
 * The APIs a model's `supported_endpoints` name (`copilotAPIs`,
 * `catalog.EndpointAPIs`): `/chat/completions` is `openai`, `/responses`
 * is `openai-responses`, `/messages` is `anthropic`; a `/v1` prefix and a
 * trailing slash are ignored, and the ones Neolix doesn't speak (the
 * websocket API) are left out. A model listed with no endpoints at all is
 * served on chat completions alone.
 */
export function copilotApisOf(endpoints: readonly string[]): CopilotProtocol[] {
  if (endpoints.length === 0) {
    return ["openai"];
  }
  const out: CopilotProtocol[] = [];
  for (const endpoint of endpoints) {
    const api = copilotApiOfEndpoint(endpoint);
    if (api !== null && !out.includes(api)) {
      out.push(api);
    }
  }
  return out;
}

function copilotApiOfEndpoint(endpoint: string): CopilotProtocol | null {
  const path = `/${endpoint.replace(/\/+$/, "").replace(/^\/+/, "")}`;
  const bare = path.startsWith("/v1/") ? path.slice(3) : path;
  switch (bare) {
    case "/chat/completions":
      return "openai";
    case "/responses":
      return "openai-responses";
    case "/messages":
      return "anthropic";
    default:
      return null;
  }
}

/**
 * The endpoints left to try for a model, after the one it was sent to
 * refused it. The candidates are the model's own `supported_endpoints`
 * from Copilot's list, in the order the list gives them
 * (`provider/account.go:1654-1666`); the fixed order is the fallback only
 * when the list names none at all (`supported` undefined).
 */
export function copilotEndpointFallbacks(
  from: CopilotProtocol,
  supported?: readonly string[] | null,
): CopilotProtocol[] {
  const candidates: CopilotProtocol[] =
    supported === undefined || supported === null
      ? ["openai-responses", "openai", "anthropic"]
      : copilotApisOf(supported);
  return candidates.filter((protocol) => protocol !== from);
}
