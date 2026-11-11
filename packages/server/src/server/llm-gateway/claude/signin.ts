/**
 * A Claude Code signed in to claude.ai sends its own sign-in as a key:
 * `Authorization: Bearer sk-ant-oat…`. Whatever the gateway answers it is
 * never about that sign-in, but about the credential the gateway used: a
 * 401, or a 403 saying the OAuth token was revoked, is told as the 502 it
 * is, in words that say whose credential was refused. Any error's
 * `x-api-key` is said as "API key", as myna's claude_signin.go does.
 */

/** Whether a request's key is a Claude sign-in: an Anthropic OAuth access token. */
export function isClaudeSignIn(authorization: string | undefined): boolean {
  const value = (authorization ?? "").trim();
  return value.length > 7 && value.slice(0, 7).toLowerCase() === "bearer "
    ? value.slice(7).trim().startsWith("sk-ant-oat")
    : false;
}

export interface ClaudeSignInFailure {
  status: number;
  /** The Anthropic error body, as JSON. */
  body: string;
}

/**
 * An upstream error as a Claude sign-in is told it: a 401, or a 403 saying
 * the OAuth token was revoked, becomes a 502 refusing the gateway's
 * credential; any other error is left to the caller, its `x-api-key` said
 * as "API key".
 */
export function claudeSignInFailure(input: {
  status: number;
  body: string;
  provider?: string;
}): ClaudeSignInFailure | null {
  const revoked = input.status === 403 && input.body.includes("OAuth token has been revoked");
  if (input.status !== 401 && !revoked) {
    return null;
  }
  const message = refusalMessage(input.body, input.provider ?? "", input.status);
  return {
    status: 502,
    body: JSON.stringify({ type: "error", error: { type: "api_error", message } }),
  };
}

/** An error body with `x-api-key` said as "API key". */
export function replaceApiKey(text: string): string {
  return text.replace(/x-api-key/gi, "API key");
}

/**
 * A stream's error frame with `x-api-key` said as "API key"; every other
 * frame is left as it came.
 */
export function rewriteErrorFrame(frame: string): string {
  const lower = frame.toLowerCase();
  return lower.startsWith("event: error") && lower.includes("x-api-key")
    ? replaceApiKey(frame)
    : frame;
}

/**
 * The provider's refusal as a Claude sign-in is told it: "<provider>
 * refused Neolix's credential (HTTP 401): reason". An error message that
 * begins with the provider's name, as the gateway writes it, gives the
 * name and the reason apart.
 */
function refusalMessage(body: string, provider: string, status: number): string {
  let name = provider;
  let reason = "";
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } };
    reason = typeof parsed.error?.message === "string" ? parsed.error.message.trim() : "";
  } catch {
    reason = body.trim();
  }
  const split = reason.indexOf(": ");
  if (
    split > 0 &&
    split <= 64 &&
    !reason.slice(0, split).includes("\n") &&
    !reason.slice(0, split).includes("{")
  ) {
    name = reason.slice(0, split);
    reason = reason.slice(split + 2).trim();
  }
  const who = name === "" ? "The provider" : name;
  const refused = `${who} refused Neox's credential (HTTP ${status})`;
  return reason === "" ? refused : `${refused}: ${replaceApiKey(reason)}`;
}
