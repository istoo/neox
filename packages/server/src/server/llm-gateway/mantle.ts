import type { GatewayProvider } from "./config.js";

/**
 * Amazon Bedrock's Mantle endpoint serves its OpenAI APIs under two
 * prefixes, each model at one: most at `/v1`, OpenAI's closed GPT models
 * and xAI's Grok at `/openai/v1`, as each model's card says. A model asked
 * at the other is turned away with "model `x` isn't supported on this
 * route"; the gateway asks it at the other prefix once and remembers the
 * prefix that served it (myna's internal/gateway/mantle.go:15-73 and
 * internal/provider/provider.go:2129-2199). Mantle's Messages are at
 * `/anthropic` alone, so only chat completions and Responses are placed
 * here.
 */

/** Whether a hostname is Bedrock Mantle's (`bedrock-mantle.{region}.api.aws`). */
export function mantleHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host.startsWith("bedrock-mantle.") && host.endsWith(".api.aws");
}

/** Whether the provider is Bedrock's Mantle endpoint, by its preset or address. */
export function isBedrockMantle(provider: GatewayProvider): boolean {
  if (provider.preset === "bedrock-mantle") {
    return true;
  }
  const bases = [
    provider.baseUrl,
    ...Object.values(provider.wires ?? {}),
    ...(provider.accounts ?? []).map((account) => account.baseUrl),
  ];
  return bases.some((base) => {
    if (base === undefined) {
      return false;
    }
    try {
      return mantleHost(new URL(base).hostname);
    } catch {
      return false;
    }
  });
}

/** Whether a wire is one Mantle places: chat completions or Responses. */
export function isMantleRoute(provider: GatewayProvider): boolean {
  return (
    (provider.protocol === "openai" || provider.protocol === "openai-responses") &&
    isBedrockMantle(provider)
  );
}

/**
 * OpenAI's closed GPT models in a Bedrock id (`global.openai.gpt-6-luna`),
 * which Mantle serves under `/openai/v1`; gpt-oss is at `/v1`.
 */
export function bedrockGPT(model: string): boolean {
  const id = model.toLowerCase();
  return id.includes("openai.gpt-") && !id.includes("gpt-oss");
}

/** A model Mantle serves at `/openai/v1` rather than `/v1`. */
export function mantleOpenAI(model: string): boolean {
  return bedrockGPT(model) || model.toLowerCase().startsWith("xai.");
}

/**
 * The base a model's chat or Responses request goes to, given a Mantle
 * provider's base: one ending `/v1` or `/openai/v1` goes at whichever
 * serves the model, or at the other when `other` is set (the model was
 * refused at the first, so the gateway learned its prefix). A base ending
 * otherwise, one the user typed, is given back as it is.
 */
export function mantleBase(baseUrl: string, model: string, other: boolean): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (!trimmed.endsWith("/v1")) {
    return baseUrl;
  }
  let root = trimmed.slice(0, -3);
  if (root.endsWith("/openai")) {
    root = root.slice(0, -7);
  }
  return mantleOpenAI(model) !== other ? `${root}/openai/v1` : `${root}/v1`;
}

/** Mantle's refusal of a model asked at the prefix that doesn't serve it. */
export function mantleWrongRoute(said: string): boolean {
  return /(?:isn't|is not|not) supported on this route/i.test(said);
}

/**
 * The prefixes that served a model, as the gateway learned them: in this
 * process, for the life of the provider's id (myna's `unfit` map). A model
 * refused at both prefixes is forgotten, so the next request starts from
 * the id's guess again.
 */
const unfit = new Set<string>();

function mantleRouteKey(providerId: string, model: string, protocol: string): string {
  return `${providerId}\u0000${model}\u0000${protocol}`;
}

/** Whether Mantle's guess for a model still stands (myna's `fits`). */
export function mantleFits(providerId: string, model: string, protocol: string): boolean {
  return !unfit.has(mantleRouteKey(providerId, model, protocol));
}

/** Remember the prefix a model was refused at, so the other is asked. */
export function markMantleUnfit(providerId: string, model: string, protocol: string): void {
  unfit.add(mantleRouteKey(providerId, model, protocol));
}

/** Forget a model's prefix, for the next request to start from the guess. */
export function clearMantleUnfit(providerId: string, model: string, protocol: string): void {
  unfit.delete(mantleRouteKey(providerId, model, protocol));
}

/** Drop every learned prefix, for a test to start from a clean process. */
export function resetMantleRoutes(): void {
  unfit.clear();
}
