/**
 * A reply's length as vendors read it: the least a model takes (some turn
 * away a token or two an app asks to check it is up), and the two names
 * Chat Completions has for the field (myna's limit.go and token_field.go).
 */

export type TokenField = "max_tokens" | "max_completion_tokens";

/** A provider's floor from its 400: "max_tokens must be greater than 2", "at least 16". */
const TOO_FEW_TOKENS =
  /max_(?:completion_|output_)?tokens.{0,60}?(greater than|more than|larger than|at least|(?:>|\\u003e)=?)\s*(\d+)/i;

/** The field a provider asks for in place of the one sent: "Use 'max_completion_tokens' instead". */
const FIELD_ASKED = /\buse\s+['"`]?(max_completion_tokens|max_tokens)['"`]?/i;

/** The least a provider said it takes, or 0 when the error isn't about that. */
export function tokenFloor(message: string): number {
  const match = TOO_FEW_TOKENS.exec(message);
  if (match === null) {
    return 0;
  }
  const value = Number.parseInt(match[2] ?? "", 10);
  if (!Number.isFinite(value) || value < 0 || value > 1024) {
    return 0;
  }
  const sign = (match[1] ?? "").toLowerCase();
  return sign === "at least" || sign.endsWith("=") ? value : value + 1;
}

/** The field a refusal names as the one to use, or null. */
export function tokenFieldWanted(message: string): TokenField | null {
  const match = FIELD_ASKED.exec(message);
  if (match === null) {
    return null;
  }
  const field = (match[1] ?? "").toLowerCase();
  return field === "max_tokens" || field === "max_completion_tokens" ? field : null;
}

/** A body asking for at least `floor` tokens wherever its protocol keeps the length. */
export function withTokenFloor(
  body: Record<string, unknown>,
  floor: number,
): Record<string, unknown> | null {
  if (floor <= 0) {
    return null;
  }
  let raised = false;
  const next = { ...body };
  for (const field of ["max_tokens", "max_completion_tokens", "max_output_tokens"] as const) {
    const value = next[field];
    if (typeof value === "number" && value < floor) {
      next[field] = floor;
      raised = true;
    }
  }
  const generation = next.generationConfig;
  if (typeof generation === "object" && generation !== null && !Array.isArray(generation)) {
    const config = { ...(generation as Record<string, unknown>) };
    const value = config.maxOutputTokens;
    if (typeof value === "number" && value < floor) {
      config.maxOutputTokens = floor;
      next.generationConfig = config;
      raised = true;
    }
  }
  return raised ? next : null;
}

/** A Chat body with its reply length under the field the vendor asked for. */
export function withTokenField(
  body: Record<string, unknown>,
  want: TokenField,
): Record<string, unknown> | null {
  const from: TokenField = want === "max_tokens" ? "max_completion_tokens" : "max_tokens";
  const value = body[from];
  if (typeof value !== "number") {
    return null;
  }
  const next = { ...body };
  delete next[from];
  next[want] = body[want] ?? value;
  return next;
}

/**
 * A body asking for at most `limit` tokens, in its protocol's words: a
 * request that asks for more is lowered, and Anthropic's thinking budget,
 * which must be under it, with it (myna's maxoutput.go). null when the
 * request asks for that much already or names no length.
 */
export function withMaxOutput(
  protocol: string,
  body: Record<string, unknown>,
  limit: number,
): Record<string, unknown> | null {
  if (limit <= 0) {
    return null;
  }
  switch (protocol) {
    case "openai":
      return lowerChatLimit(body, limit);
    case "openai-responses":
      return lowerField(body, "max_output_tokens", limit);
    case "anthropic":
      return lowerAnthropicLimit(body, limit);
    case "gemini":
      return lowerGeminiLimit(body, limit);
    default:
      return null;
  }
}

function lowerChatLimit(
  body: Record<string, unknown>,
  limit: number,
): Record<string, unknown> | null {
  let changed = false;
  const next = { ...body };
  for (const field of ["max_completion_tokens", "max_tokens"] as const) {
    if (typeof next[field] === "number" && next[field] > limit) {
      next[field] = limit;
      changed = true;
    }
  }
  return changed ? next : null;
}

function lowerField(
  body: Record<string, unknown>,
  field: string,
  limit: number,
): Record<string, unknown> | null {
  const value = body[field];
  if (typeof value !== "number" || value <= limit) {
    return null;
  }
  return { ...body, [field]: limit };
}

function lowerAnthropicLimit(
  body: Record<string, unknown>,
  limit: number,
): Record<string, unknown> | null {
  let changed = false;
  const next = { ...body };
  if (typeof next.max_tokens === "number" && next.max_tokens > limit) {
    next.max_tokens = limit;
    changed = true;
  }
  const thinking = next.thinking;
  if (typeof thinking === "object" && thinking !== null && !Array.isArray(thinking)) {
    const entry = thinking as Record<string, unknown>;
    if (
      entry.type === "enabled" &&
      typeof entry.budget_tokens === "number" &&
      entry.budget_tokens >= limit
    ) {
      // The budget must be under the reply's limit; Anthropic's least is 1024.
      next.thinking =
        limit - 1 >= 1024 ? { type: "enabled", budget_tokens: limit - 1 } : { type: "disabled" };
      changed = true;
    }
  }
  return changed ? next : null;
}

function lowerGeminiLimit(
  body: Record<string, unknown>,
  limit: number,
): Record<string, unknown> | null {
  const generation = body.generationConfig;
  if (typeof generation !== "object" || generation === null || Array.isArray(generation)) {
    return null;
  }
  const config = generation as Record<string, unknown>;
  const value = config.maxOutputTokens;
  if (typeof value !== "number" || value <= limit) {
    return null;
  }
  return { ...body, generationConfig: { ...config, maxOutputTokens: limit } };
}
