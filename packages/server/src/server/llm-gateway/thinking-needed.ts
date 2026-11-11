/**
 * An upstream that takes a model only with thinking "enabled" turns a
 * Messages request without it away: `thinking.type must be "enabled"`.
 * The refusal is read off the reply, remembered for the provider's model,
 * and every later turn is sent thinking at Anthropic's least budget
 * (myna's thinking_needed.go).
 */

const THINKING_NEEDED = /thinking[._ ]type\W+(?:must|should|has to) be\W+enabled\b/i;

/** The budget a request that asked for no thinking is sent at. */
const NEEDED_BUDGET = 1024;

const needed = new Set<string>();

function key(providerId: string, model: string): string {
  return `${providerId}\u0000${model}`;
}

/** Whether the refusal says this model needs thinking enabled. */
export function refusedThinkingNeeded(message: string): boolean {
  return THINKING_NEEDED.test(message);
}

export function markNeedsThinking(providerId: string, model: string): void {
  needed.add(key(providerId, model));
}

export function needsThinking(providerId: string, model: string): boolean {
  return needed.has(key(providerId, model));
}

export function resetThinkingNeeded(): void {
  needed.clear();
}

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A Messages body that asked for no thinking sent thinking at the least
 * budget: max_tokens raised past it, and the sampling a thinking request
 * is refused with left out.
 */
export function withThinkingEnabled(body: Json): { body: Json; changed: boolean } {
  const thinking = isRecord(body.thinking) ? body.thinking : null;
  if (thinking !== null && (thinking.type === "enabled" || thinking.type === "adaptive")) {
    return { body, changed: false };
  }
  const asked = typeof body.max_tokens === "number" ? body.max_tokens : 1;
  const maxTokens = asked <= NEEDED_BUDGET ? NEEDED_BUDGET + Math.max(asked, 1) : asked;
  const next: Json = { ...body };
  delete next.temperature;
  delete next.top_p;
  delete next.top_k;
  next.thinking = { type: "enabled", budget_tokens: NEEDED_BUDGET };
  next.max_tokens = maxTokens;
  return { body: next, changed: true };
}
