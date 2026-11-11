import { CODEX_CLIENT_ID, CODEX_TOKEN_URL } from "./codex-user-data.js";

/**
 * A ChatGPT sign-in of Neolix's own, by device code, as myna does it
 * (`provider/codex_device_signin.go`): ask for a code, the user enters it
 * on ChatGPT's device page in any browser, and the poll says when it is
 * entered. Nothing comes back to localhost, so this works on a server.
 */
const CODEX_ISSUER = "https://auth.openai.com";

export interface CodexDeviceStart {
  /** The page the user enters the code on. */
  url: string;
  userCode: string;
  deviceAuthId: string;
  /** How often to ask, at least. */
  intervalMs: number;
}

export interface CodexDeviceTokens {
  idToken: string | null;
  accessToken: string;
  refreshToken: string | null;
  accountId: string | null;
}

export type CodexDevicePoll =
  | { state: "waiting" }
  | { state: "done"; tokens: CodexDeviceTokens }
  | { state: "error"; error: string };

export interface CodexSignInOptions {
  fetchImpl?: typeof fetch;
  issuer?: string;
  tokenUrl?: string;
}

/** Asks ChatGPT for a device code and tells where the user enters it. */
export async function startCodexDeviceSignIn(
  options: CodexSignInOptions = {},
): Promise<{ start: CodexDeviceStart } | { error: string }> {
  const issuer = options.issuer ?? CODEX_ISSUER;
  let answer: Response;
  try {
    answer = await codexPost(
      options,
      `${issuer}/api/accounts/deviceauth/usercode`,
      { client_id: CODEX_CLIENT_ID },
      false,
    );
  } catch (error) {
    return { error: `Couldn't reach ChatGPT for a sign-in code: ${errorMessage(error)}` };
  }
  if (answer.status === 404) {
    return {
      error: "ChatGPT doesn't take a device code for this sign-in now; use the browser sign-in",
    };
  }
  if (!answer.ok) {
    return { error: `ChatGPT gave no sign-in code (${answer.status})` };
  }
  const body = await readJson(answer);
  if (!isRecord(body)) {
    return { error: "ChatGPT's sign-in code didn't read" };
  }
  const id = typeof body.device_auth_id === "string" ? body.device_auth_id : "";
  let code = typeof body.user_code === "string" ? body.user_code : "";
  if (code.length === 0) {
    code = typeof body.usercode === "string" ? body.usercode : "";
  }
  if (id.length === 0 || code.length === 0) {
    return { error: "ChatGPT gave no sign-in code" };
  }
  return {
    start: {
      url: `${issuer}/codex/device`,
      userCode: code,
      deviceAuthId: id,
      intervalMs: intervalOf(body.interval),
    },
  };
}

/** Asks once whether the code was entered; a refused poll is still waiting. */
export async function pollCodexDeviceSignIn(
  start: Pick<CodexDeviceStart, "deviceAuthId" | "userCode">,
  options: CodexSignInOptions = {},
): Promise<CodexDevicePoll> {
  const issuer = options.issuer ?? CODEX_ISSUER;
  let answer: Response;
  try {
    answer = await codexPost(
      options,
      `${issuer}/api/accounts/deviceauth/token`,
      { device_auth_id: start.deviceAuthId, user_code: start.userCode },
      false,
    );
  } catch (error) {
    return { state: "error", error: `Couldn't ask ChatGPT: ${errorMessage(error)}` };
  }
  if (answer.status === 403 || answer.status === 404) {
    return { state: "waiting" };
  }
  if (!answer.ok) {
    return { state: "error", error: `ChatGPT refused the sign-in (${answer.status})` };
  }
  const body = await readJson(answer);
  if (
    !isRecord(body) ||
    typeof body.authorization_code !== "string" ||
    typeof body.code_verifier !== "string"
  ) {
    return { state: "error", error: "ChatGPT finished the sign-in but sent no code" };
  }
  return exchangeCode(body.authorization_code, body.code_verifier, options);
}

async function exchangeCode(
  code: string,
  verifier: string,
  options: CodexSignInOptions,
): Promise<CodexDevicePoll> {
  const issuer = options.issuer ?? CODEX_ISSUER;
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: `${issuer}/deviceauth/callback`,
    client_id: CODEX_CLIENT_ID,
    code_verifier: verifier,
  });
  let answer: Response;
  try {
    answer = await (options.fetchImpl ?? fetch)(options.tokenUrl ?? CODEX_TOKEN_URL, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: form.toString(),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    return { state: "error", error: `Couldn't exchange the code: ${errorMessage(error)}` };
  }
  if (!answer.ok) {
    return { state: "error", error: `ChatGPT refused the code exchange (${answer.status})` };
  }
  const body = await readJson(answer);
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
    },
  };
}

async function codexPost(
  options: CodexSignInOptions,
  url: string,
  body: unknown,
  form: boolean,
): Promise<Response> {
  return (options.fetchImpl ?? fetch)(url, {
    method: "POST",
    headers: form
      ? { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }
      : {
          "content-type": "application/json",
          accept: "application/json",
          originator: "codex_cli_rs",
        },
    body: form ? String(body) : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
}

async function readJson(answer: Response): Promise<unknown> {
  try {
    return await answer.json();
  } catch {
    return null;
  }
}

function intervalOf(value: unknown): number {
  const seconds = secondsOf(value);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 5_000;
}

function secondsOf(value: unknown): number {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    return Number(value);
  }
  return Number.NaN;
}

/** The ChatGPT account id an ID token names, if it names one. */
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
