/**
 * The betas an agent asks of Anthropic's Messages API (the anthropic-beta
 * header, or a body's anthropic_beta list) go on to the provider, save
 * those it is known to turn away: a provider that checks them by name
 * refuses the whole request for one it doesn't know (Bedrock's runtime:
 * "Unexpected value(s) `x`, `y` for the `anthropic-beta` header";
 * Copilot's "unsupported beta header(s): …").
 *
 * A refusal names the betas, which are remembered per provider and left
 * out of every later request, as myna leaves them out of its unfit set
 * (myna's betas.go).
 */

type Json = Record<string, unknown>;

const UNEXPECTED_BETAS =
  /unexpected values?(?:\(s\))?\s+((?:`[^`]+`[,\s]*(?:and\s+)?)+)for the\s+`anthropic[-_]beta`/i;
const BACKQUOTED = /`([^`]+)`/g;
const UNSUPPORTED_BETAS =
  /unsupported beta headers?(?:\(s\))?:\s*([a-z0-9][a-z0-9._-]*(?:\s*,\s*[a-z0-9][a-z0-9._-]*)*)/i;

/** Betas of Anthropic's own API that Bedrock and Vertex name another way. */
const BEDROCK_BETAS: Record<string, string> = {
  "advanced-tool-use-2025-11-20": "tool-search-tool-2025-10-19",
};

/** Betas Bedrock has turned away, left out from the first request. */
const BEDROCK_REFUSES = new Set(["prompt-caching-scope-2026-01-05", "redact-thinking-2026-02-12"]);

const refused = new Map<string, Set<string>>();

function refusedBy(providerId: string): Set<string> {
  return refused.get(providerId) ?? new Set<string>();
}

/** The betas this provider has turned away before. */
export function refusedBetas(providerId: string): ReadonlySet<string> {
  return refusedBy(providerId);
}

export function resetBetas(): void {
  refused.clear();
}

/** The betas in one or more header values, without the agent's own sign-in. */
export function askedBetas(values: readonly string[]): string[] {
  const betas: string[] = [];
  for (const value of values) {
    for (const raw of value.split(",")) {
      const beta = raw.trim();
      if (beta.length > 0 && !beta.startsWith("oauth-")) {
        betas.push(beta);
      }
    }
  }
  return betas;
}

/** Whether a provider's address is Amazon Bedrock's runtime or Mantle. */
export function isBedrockHost(baseUrl: string): boolean {
  const host = hostOf(baseUrl);
  return (
    (host.startsWith("bedrock-runtime.") && host.endsWith(".amazonaws.com")) ||
    (host.startsWith("bedrock-mantle.") && host.endsWith(".api.aws"))
  );
}

/** Whether a provider's address is Vertex AI's. */
export function isVertexHost(baseUrl: string): boolean {
  const host = hostOf(baseUrl);
  return (
    host === "aiplatform.googleapis.com" ||
    host.endsWith("-aiplatform.googleapis.com") ||
    host.endsWith(".rep.googleapis.com")
  );
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return "";
  }
}

/** The betas a provider takes: renamed, preset-refused, refused, without repeats. */
export function fitBetas(providerId: string, asked: readonly string[], baseUrl?: string): string[] {
  const bedrock = baseUrl === undefined ? false : isBedrockHost(baseUrl);
  const vertex = baseUrl === undefined ? false : isVertexHost(baseUrl);
  const kept: string[] = [];
  const known = refusedBy(providerId);
  for (const raw of asked) {
    let beta = raw.trim();
    if (beta.length === 0) {
      continue;
    }
    if (bedrock || vertex) {
      beta = BEDROCK_BETAS[beta] ?? beta;
    }
    if (bedrock && BEDROCK_REFUSES.has(beta)) {
      continue;
    }
    if (known.has(beta) || kept.includes(beta)) {
      continue;
    }
    kept.push(beta);
  }
  return kept;
}

/**
 * Notes the betas a refusal names and answers those that are new. Both
 * wordings a provider uses are read.
 */
export function refuseBetas(providerId: string, message: string): string[] {
  const named = namedBetas(message);
  const fresh: string[] = [];
  const set = refusedBy(providerId);
  for (const raw of named) {
    const beta = raw.trim();
    if (beta.length === 0 || set.has(beta)) {
      continue;
    }
    set.add(beta);
    fresh.push(beta);
  }
  if (fresh.length > 0) {
    refused.set(providerId, set);
  }
  return fresh;
}

function namedBetas(message: string): string[] {
  const unexpected = UNEXPECTED_BETAS.exec(message);
  if (unexpected !== null) {
    const names: string[] = [];
    for (const match of (unexpected[1] ?? "").matchAll(BACKQUOTED)) {
      if (match[1] !== undefined) {
        names.push(match[1]);
      }
    }
    return names;
  }
  const unsupported = UNSUPPORTED_BETAS.exec(message);
  return unsupported?.[1] === undefined ? [] : unsupported[1].split(",");
}

/** A body without the body-level betas the provider has refused. */
export function withoutRefusedBodyBetas(providerId: string, body: Json, baseUrl?: string): Json {
  if (!Array.isArray(body.anthropic_beta)) {
    return body;
  }
  const asked = body.anthropic_beta.filter((beta): beta is string => typeof beta === "string");
  const kept = fitBetas(providerId, asked, baseUrl);
  if (kept.length === asked.length) {
    return body;
  }
  const next = { ...body };
  if (kept.length === 0) {
    delete next.anthropic_beta;
  } else {
    next.anthropic_beta = kept;
  }
  return next;
}
