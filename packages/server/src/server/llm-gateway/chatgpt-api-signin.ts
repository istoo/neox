import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  claimString,
  errorMessage,
  isRecord,
  jwtClaims,
  oauthErrorOf,
  readJson,
  uuidUrn,
} from "./oauth.js";
import { fetchThroughProxy } from "./proxy-fetch.js";
import type { ChatGptApiAccount } from "./subscription-store.js";
import { subscriptionAccountId } from "./subscription-store.js";

/**
 * OpenAI's Sign in with ChatGPT, which lets an app on the user's machine
 * use a ChatGPT plan through OpenAI's own API (`provider/chatgpt_api.go`).
 * The sign-in registers Neolix with OpenAI on the way (a public client, no
 * secret): the browser's callback carries the client id OpenAI issued,
 * which the code, every refresh and the sign-out go with.
 */

const DEFAULT_ISSUER = "https://auth.openai.com";
const DEFAULT_API = "https://api.openai.com/v1";
const DYNAMIC_CLIENT = "dynamic_agent_client";
const AGENT_NAME = "neolix";
const DIRECT_SCOPE = "chatgpt.tokens.use.direct";
const SCOPES = `openid profile email offline_access resource.invoke ${DIRECT_SCOPE}`;
/** A token this close to expiring is refreshed before a request uses it. */
const REFRESH_MARGIN_MS = 3 * 60_000;
const HOST_FILE = "chatgpt-api-host";

/** Refusals of a refresh token that will never work again (`chatgpt_api.go:392-393`). */
const DEAD_REFRESH_CODES = new Set([
  "invalid_grant",
  "invalid_refresh_token",
  "token_expired",
  "refresh_token_expired",
  "refresh_token_invalidated",
  "refresh_token_reused",
]);

export interface ChatGptApiOptions {
  fetchImpl?: typeof fetch;
  /** The proxy the sign-in and its refreshes go through. */
  proxy?: string;
  issuer?: string;
  api?: string;
  now?: () => number;
}

export interface ChatGptApiStart {
  url: string;
  state: string;
  verifier: string;
  redirectUri: string;
  nonce: string;
  hostId: string;
  /** Sent to OpenAI; the callback names the client it issues instead. */
  clientId: string;
}

/**
 * This machine's id for OpenAI, made once and kept (myna keeps it in its
 * config directory, `chatgpt_api.go:164-186`).
 */
export async function loadOrCreateChatGptHostId(gatewayDir: string): Promise<string> {
  const file = join(gatewayDir, HOST_FILE);
  try {
    const text = (await readFile(file, "utf8")).trim();
    if (text.startsWith("urn:uuid:")) {
      return text;
    }
  } catch {
    // no id yet
  }
  const id = uuidUrn();
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${id}\n`, { mode: 0o600 });
  return id;
}

/** OpenAI's authorize page, as myna builds it (`chatgpt_api.go:195-211`). */
export function startChatGptApiSignIn(input: {
  redirectUri: string;
  hostId: string;
  state: string;
  verifier: string;
  challenge: string;
  nonce: string;
  options?: ChatGptApiOptions;
}): ChatGptApiStart {
  const issuer = (input.options?.issuer ?? DEFAULT_ISSUER).replace(/\/+$/, "");
  const query = new URLSearchParams({
    client_id: DYNAMIC_CLIENT,
    agent_name_hint: AGENT_NAME,
    ext_agent_host_id: input.hostId,
    response_type: "code",
    redirect_uri: input.redirectUri,
    resource: input.options?.api ?? DEFAULT_API,
    scope: SCOPES,
    state: input.state,
    nonce: input.nonce,
    code_challenge: input.challenge,
    code_challenge_method: "S256",
  });
  return {
    url: `${issuer}/api/accounts/authorize?${query.toString()}`,
    state: input.state,
    verifier: input.verifier,
    redirectUri: input.redirectUri,
    nonce: input.nonce,
    hostId: input.hostId,
    clientId: DYNAMIC_CLIENT,
  };
}

export interface ChatGptApiCompleteInput extends ChatGptApiOptions {
  code: string;
  /** The client id OpenAI issued, from the callback's query. */
  clientId: string;
  verifier: string;
  redirectUri: string;
  nonce: string;
  hostId: string;
  addedAt?: number;
}

/** Trades a sign-in's code for the account (`chatgpt_api.go:224-270`). */
export async function completeChatGptApiSignIn(
  input: ChatGptApiCompleteInput,
): Promise<{ account: ChatGptApiAccount } | { error: string }> {
  if (input.clientId.trim() === "") {
    return {
      error:
        "ChatGPT sign-in: OpenAI didn't finish registering Neox (no client id came back); start it again",
    };
  }
  if (input.code.trim() === "") {
    return { error: "ChatGPT sign-in: the page came back without a code" };
  }
  const tokens = await postToken(input, {
    grant_type: "authorization_code",
    client_id: input.clientId,
    code: input.code,
    code_verifier: input.verifier,
    redirect_uri: input.redirectUri,
    resource: input.api ?? DEFAULT_API,
  });
  if ("error" in tokens) {
    return { error: `ChatGPT sign-in: ${tokens.error}` };
  }
  if (tokens.tokens.idToken === null) {
    return { error: "ChatGPT sign-in: OpenAI sent no ID token" };
  }
  const claims = jwtClaims(tokens.tokens.idToken);
  const check = checkIdToken(claims, input.clientId, input.nonce, input.issuer ?? DEFAULT_ISSUER);
  if (check !== null) {
    return { error: `ChatGPT sign-in: ${check}` };
  }
  if (!tokens.tokens.scopes.includes(DIRECT_SCOPE)) {
    return {
      error:
        "ChatGPT sign-in: OpenAI didn't grant the use of the subscription through its API (chatgpt.tokens.use.direct): this ChatGPT account may not be eligible",
    };
  }
  const user = claimString(claims, "email") || claimString(claims, "sub");
  if (user === "") {
    return { error: "ChatGPT sign-in: OpenAI didn't say which account signed in" };
  }
  const now = input.now?.() ?? Date.now();
  return {
    account: {
      agent: "chatgpt-api",
      id: subscriptionAccountId("chatgpt-api", user),
      user,
      plan: planOf(tokens.tokens.idToken, tokens.tokens.accessToken),
      addedAt: input.addedAt ?? now,
      lapsed: null,
      clientId: input.clientId,
      hostId: input.hostId,
      idToken: tokens.tokens.idToken,
      accessToken: tokens.tokens.accessToken,
      refreshToken: tokens.tokens.refreshToken,
      expiresAt: tokens.tokens.expiresAt,
      scopes: tokens.tokens.scopes,
    },
  };
}

export interface ChatGptApiRefresh {
  account: ChatGptApiAccount;
  /** True when the tokens were renewed. */
  refreshed: boolean;
}

/**
 * A live access token for the account (`chatgpt_api.go:749-...`). A
 * refusal that will never mend marks the account lapsed, with why.
 */
export async function refreshChatGptApiAccount(
  account: ChatGptApiAccount,
  options: ChatGptApiOptions = {},
): Promise<ChatGptApiRefresh | { error: string; lapsed?: string }> {
  const now = options.now?.() ?? Date.now();
  if (account.lapsed !== null) {
    return { error: account.lapsed, lapsed: account.lapsed };
  }
  if (account.expiresAt - now > REFRESH_MARGIN_MS) {
    return { account, refreshed: false };
  }
  const tokens = await postToken(options, {
    grant_type: "refresh_token",
    client_id: account.clientId,
    refresh_token: account.refreshToken,
    resource: options.api ?? DEFAULT_API,
  });
  if ("error" in tokens) {
    if (tokens.code !== "" && DEAD_REFRESH_CODES.has(tokens.code)) {
      const lapsed = `${account.user}'s ChatGPT sign-in has expired — sign in again`;
      return { error: lapsed, lapsed };
    }
    if (tokens.code === "invalid_client") {
      return {
        error: `ChatGPT: OpenAI no longer knows the client Neox registered for ${account.user} — sign in again`,
      };
    }
    return { error: `ChatGPT token refresh: ${tokens.error}` };
  }
  return {
    account: {
      ...account,
      accessToken: tokens.tokens.accessToken,
      refreshToken: tokens.tokens.refreshToken,
      idToken: tokens.tokens.idToken ?? account.idToken,
      expiresAt: tokens.tokens.expiresAt,
      scopes: tokens.tokens.scopes.length > 0 ? tokens.tokens.scopes : account.scopes,
      plan:
        planOf(tokens.tokens.idToken ?? account.idToken, tokens.tokens.accessToken) ?? account.plan,
      lapsed: null,
    },
    refreshed: true,
  };
}

interface TokenSet {
  accessToken: string;
  refreshToken: string;
  idToken: string | null;
  expiresAt: number;
  scopes: string[];
}

async function postToken(
  options: ChatGptApiOptions,
  form: Record<string, string>,
): Promise<{ tokens: TokenSet } | { error: string; code: string }> {
  const issuer = (options.issuer ?? DEFAULT_ISSUER).replace(/\/+$/, "");
  let response: Response;
  try {
    response = await fetchThroughProxy(options.proxy, options.fetchImpl)(
      `${issuer}/api/accounts/oauth/token`,
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body: new URLSearchParams(form).toString(),
        signal: AbortSignal.timeout(30_000),
      },
    );
  } catch (error) {
    return { error: `couldn't reach OpenAI: ${errorMessage(error)}`, code: "" };
  }
  const body = await readJson(response);
  if (!response.ok) {
    const refusal = oauthErrorOf(body, response.status);
    return {
      error: refusal.message !== "" ? refusal.message : `OpenAI refused (${response.status})`,
      code: refusal.code,
    };
  }
  if (!isRecord(body)) {
    return { error: "OpenAI's token answer didn't read", code: "" };
  }
  const accessToken = typeof body.access_token === "string" ? body.access_token : "";
  const refreshToken = typeof body.refresh_token === "string" ? body.refresh_token : "";
  const expiresIn = typeof body.expires_in === "number" ? body.expires_in : 0;
  if (accessToken === "" || refreshToken === "" || expiresIn <= 0) {
    return { error: "OpenAI sent no usable token", code: "" };
  }
  const now = options.now?.() ?? Date.now();
  return {
    tokens: {
      accessToken,
      refreshToken,
      idToken: typeof body.id_token === "string" ? body.id_token : null,
      expiresAt: now + expiresIn * 1000,
      scopes: typeof body.scope === "string" ? body.scope.split(/\s+/).filter(Boolean) : [],
    },
  };
}

function checkIdToken(
  claims: Record<string, unknown> | null,
  clientId: string,
  nonce: string,
  issuer: string,
): string | null {
  if (claims === null) {
    return "OpenAI sent an unreadable ID token";
  }
  const from = claimString(claims, "iss").replace(/\/+$/, "");
  if (from !== issuer.replace(/\/+$/, "")) {
    return `the ID token is from "${from}", not OpenAI`;
  }
  const audience = claims["aud"];
  const forUs =
    audience === clientId ||
    (Array.isArray(audience) && audience.some((entry) => entry === clientId));
  if (!forUs) {
    return "the ID token is for another app";
  }
  if (claimString(claims, "nonce") !== nonce) {
    return "the ID token isn't this sign-in's";
  }
  const exp = typeof claims["exp"] === "number" ? claims["exp"] : 0;
  if (exp > 0 && exp * 1000 < Date.now() - 60_000) {
    return "the ID token has expired";
  }
  return null;
}

/** The ChatGPT plan a token names (`chatgpt_api.go:301-308`). */
function planOf(idToken: string | null, accessToken: string): string | null {
  for (const token of [idToken, accessToken]) {
    const plan = claimString(jwtClaims(token), "https://api.openai.com/auth", "chatgpt_plan_type");
    if (plan !== "") {
      return plan;
    }
  }
  return null;
}
