import { readCodexSignIn, type CodexDiscoveryOptions } from "./codex-user-data.js";

/**
 * A Codex thread started while Neolix was its provider keeps sending its
 * own models to `/v1` after Codex is set back to ChatGPT (myna's
 * `codex_own_v1.go:21-105`). Such a model, which no Neolix provider or
 * group serves, goes on Codex's own ChatGPT sign-in to the ChatGPT
 * backend's `/responses`, as Codex's built-in provider would have sent it.
 */
export interface CodexOwnRequest {
  /** The model the request names. */
  model: string;
  /** The request came from this computer. */
  local: boolean;
  /** Its headers or session say it came from Codex. */
  fromCodex: boolean;
  /** One of Codex's hidden side calls a setting already answers. */
  sideCall: boolean;
  /** A Neolix provider, group or auto entry serves the model. */
  served: boolean;
  /** The model is switched off. */
  switchedOff: boolean;
  /** A Neolix key holds the request. */
  keyHeld: boolean;
  /** A Neolix account holds the request. */
  accountHeld: boolean;
}

export type CodexOwnRedirect =
  | { path: string; headers: Record<string, string> }
  | { why: string }
  | null;

export interface CodexOwnOptions {
  signIn?: CodexDiscoveryOptions;
  /** The ChatGPT backend's route, as Codex calls it. */
  backendPath?: string;
}

/**
 * Where the request goes instead, why it cannot (answered instead of the
 * bare 404), or null when this is not that case.
 */
export async function codexOwnRedirect(
  request: CodexOwnRequest,
  options: CodexOwnOptions = {},
): Promise<CodexOwnRedirect> {
  if (!isCodexOwnRequest(request)) {
    return null;
  }
  const signIn = await readCodexSignIn(options.signIn ?? {});
  if (!signIn.ok) {
    return { why: cannotSend(request.model, signIn.error) };
  }
  return {
    path: `${options.backendPath ?? "/backend-api/codex"}/responses`,
    headers: {
      authorization: `Bearer ${signIn.accessToken}`,
      ...(signIn.accountId === null ? {} : { "chatgpt-account-id": signIn.accountId }),
    },
  };
}

function isCodexOwnRequest(request: CodexOwnRequest): boolean {
  return (
    request.model.length > 0 &&
    !request.model.includes("/") &&
    request.local &&
    request.fromCodex &&
    !request.sideCall &&
    !request.served &&
    !request.switchedOff &&
    !request.keyHeld &&
    !request.accountHeld
  );
}

/** myna's words for a thread that cannot be sent on Codex's sign-in. */
function cannotSend(model: string, error: string): string {
  return (
    `"${model}" is one of Codex's own models, and this Codex thread was started while Neox was ` +
    `Codex's model provider, so it is still sent to Neox whatever Codex is set to now. ` +
    `No ChatGPT account in Neox serves it, and Neox can't send it on Codex's own ChatGPT ` +
    `sign-in: ${error}. Start a new thread in Codex for its own models, or add Codex's ` +
    `ChatGPT account in Neox (Providers)`
  );
}
