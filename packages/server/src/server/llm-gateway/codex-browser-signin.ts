import { createServer } from "node:http";
import { CODEX_CLIENT_ID, CODEX_TOKEN_URL } from "./codex-user-data.js";
import type { CodexDevicePoll, CodexDeviceTokens, CodexSignInOptions } from "./codex-signin.js";
import { pkcePair, randomToken } from "./oauth.js";

/**
 * ChatGPT's browser sign-in, as Codex CLI does it (`provider/signin.go:330-373`):
 * PKCE, the browser sent back to port 1455 on this machine. When that port
 * can't be had (Windows reserves it, or another program holds it) the page
 * the browser ends on still has the code in its address, and pasting the
 * address finishes the sign-in (`signin.go:357-360`, #1782).
 */
const CODEX_ISSUER = "https://auth.openai.com";
const CODEX_AUTHORIZE_URL = `${CODEX_ISSUER}/oauth/authorize`;
/** myna's `signin.go:45`. */
const CODEX_SCOPES =
  "openid profile email offline_access api.connectors.read api.connectors.invoke";
/** OpenAI sends the browser back only to this port (`signin.go:41-42`). */
export const CODEX_CALLBACK_PORT = 1455;
export const CODEX_CALLBACK_PATH = "/auth/callback";

export interface CodexBrowserFlow {
  /** The page to open. */
  url: string;
  redirectUri: string;
  state: string;
  verifier: string;
  /** Why the callback port couldn't be opened; the address is pasted then. */
  blocked?: "reserved" | "busy";
  /** The query the browser came back with; never rejects. */
  callback: Promise<URLSearchParams>;
  /** Lets the port go; a sign-in that finished or was given up calls it. */
  close(): void;
}

export interface CodexBrowserOptions extends CodexSignInOptions {
  /** False in tests: nothing listens, and the address is pasted. */
  listen?: boolean;
  port?: number;
}

/** Opens the browser sign-in: a PKCE pair, the page, and the callback port. */
export async function startCodexBrowserSignIn(
  options: CodexBrowserOptions = {},
): Promise<{ flow: CodexBrowserFlow } | { error: string }> {
  const issuer = options.issuer ?? CODEX_ISSUER;
  const redirectUri = `http://localhost:${options.port ?? CODEX_CALLBACK_PORT}${CODEX_CALLBACK_PATH}`;
  const { verifier, challenge } = pkcePair();
  const state = randomToken(24);
  const opened = await openCallback(options.listen !== false);
  const url = authorizeUrl({
    issuer: options.issuer === undefined ? CODEX_AUTHORIZE_URL : `${issuer}/oauth/authorize`,
    redirectUri,
    challenge,
    state,
  });
  return {
    flow: {
      url,
      redirectUri,
      state,
      verifier,
      ...(opened.blocked === undefined ? {} : { blocked: opened.blocked }),
      callback: opened.callback,
      close: opened.close,
    },
  };
}

function authorizeUrl(input: {
  issuer: string;
  redirectUri: string;
  challenge: string;
  state: string;
}): string {
  const query = new URLSearchParams({
    response_type: "code",
    client_id: CODEX_CLIENT_ID,
    redirect_uri: input.redirectUri,
    scope: CODEX_SCOPES,
    code_challenge: input.challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state: input.state,
    originator: "codex_cli_rs",
  });
  return `${input.issuer}?${query.toString()}`;
}

/**
 * Finishes with the address the browser ended on (or its query): checks
 * the state is this sign-in's, then exchanges the code with the verifier.
 */
export async function completeCodexBrowserSignIn(
  flow: Pick<CodexBrowserFlow, "redirectUri" | "state" | "verifier">,
  raw: string,
  options: CodexSignInOptions = {},
): Promise<CodexDevicePoll> {
  const params = queryOf(raw);
  if (params === null) {
    return { state: "error", error: "That address is not the one the browser ended on" };
  }
  const refused = params.get("error");
  if (refused !== null) {
    const description = params.get("error_description");
    return { state: "error", error: description ?? refused };
  }
  if (params.get("state") !== flow.state) {
    return { state: "error", error: "This address belongs to another sign-in; start again" };
  }
  const code = params.get("code");
  if (code === null || code.length === 0) {
    return { state: "error", error: "The address has no sign-in code" };
  }
  return exchangeCode(code, flow, options);
}

/** A pasted address, or something that only holds its query. */
function queryOf(raw: string): URLSearchParams | null {
  const text = raw.trim();
  if (text.length === 0) {
    return null;
  }
  try {
    return new URL(text).searchParams;
  } catch {
    return new URLSearchParams(text.replace(/^[?#]/, ""));
  }
}

async function exchangeCode(
  code: string,
  flow: Pick<CodexBrowserFlow, "redirectUri" | "verifier">,
  options: CodexSignInOptions,
): Promise<CodexDevicePoll> {
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: flow.redirectUri,
    client_id: CODEX_CLIENT_ID,
    code_verifier: flow.verifier,
  });
  let answer: Response;
  try {
    answer = await (options.fetchImpl ?? fetch)(options.tokenUrl ?? CODEX_TOKEN_URL, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
        originator: "codex_cli_rs",
      },
      body: form.toString(),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    return {
      state: "error",
      error: `Couldn't exchange the code: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!answer.ok) {
    return { state: "error", error: `ChatGPT refused the code exchange (${answer.status})` };
  }
  let body: unknown;
  try {
    body = await answer.json();
  } catch {
    return { state: "error", error: "ChatGPT sent no access token" };
  }
  if (!isRecord(body) || typeof body.access_token !== "string") {
    return { state: "error", error: "ChatGPT sent no access token" };
  }
  const idToken = typeof body.id_token === "string" ? body.id_token : null;
  return {
    state: "done",
    tokens: {
      idToken,
      accessToken: body.access_token,
      refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : null,
      accountId: accountIdOf(idToken),
    } satisfies CodexDeviceTokens,
  };
}

interface OpenedCallback {
  callback: Promise<URLSearchParams>;
  blocked?: "reserved" | "busy";
  close(): void;
}

function openCallback(enabled: boolean): Promise<OpenedCallback> {
  if (!enabled) {
    return Promise.resolve({
      callback: new Promise<URLSearchParams>(() => undefined),
      close: () => undefined,
    });
  }
  return new Promise<OpenedCallback>((resolve) => {
    let settle: (params: URLSearchParams) => void = () => undefined;
    const callback = new Promise<URLSearchParams>((done) => {
      settle = done;
    });
    const server = createServer((request, response) => {
      const address = request.url ?? "";
      if (!address.startsWith(CODEX_CALLBACK_PATH)) {
        response.writeHead(404).end();
        return;
      }
      settle(new URL(address, "http://localhost").searchParams);
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<p>Signed in. You can close this page and return to Neox.</p>");
      close();
    });
    const close = (): void => {
      if (server.listening) {
        server.close();
      }
    };
    server.once("error", (error: NodeJS.ErrnoException) => {
      const blocked = process.platform === "win32" && error.code === "EACCES" ? "reserved" : "busy";
      resolve({
        callback,
        blocked,
        close: () => undefined,
      });
    });
    server.listen(CODEX_CALLBACK_PORT, "127.0.0.1", () => {
      resolve({ callback, close });
    });
  });
}

function accountIdOf(idToken: string | null): string | null {
  if (idToken === null) {
    return null;
  }
  const claims = claimsOf(idToken);
  const auth = claims["https://api.openai.com/auth"];
  if (!isRecord(auth)) {
    return null;
  }
  return typeof auth.chatgpt_account_id === "string" ? auth.chatgpt_account_id : null;
}

function claimsOf(token: string): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length < 2 || parts[1] === undefined) {
    return {};
  }
  try {
    const value: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
