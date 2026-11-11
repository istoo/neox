import type { GatewayModel, GatewayProvider } from "./config.js";
import { subscriptionAccountId, type FactorySubscriptionAccount } from "./subscription-store.js";

/**
 * Factory's subscription, added by an API key rather than a browser
 * (`provider/factory_key.go`): a `fk-…` droid takes from
 * `FACTORY_API_KEY`, sent as it is and never renewed. `whoami` says whose
 * key it is and where Factory serves its org; its model table is droid's,
 * which the provider keeps serving whatever wire each model rides.
 */

export const FACTORY_API = "https://api.factory.ai";
export const FACTORY_API_EU = "https://api.eu.factory.ai";

/** What `/api/cli/whoami` tells of a Factory account. */
export interface FactoryWho {
  userId: string;
  orgId: string;
  email: string;
  region: string;
  prem: string;
}

export interface FactoryKeyOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Overridable so a test never reaches Factory. */
  apiBase?: string;
  euBase?: string;
}

/** A Factory API key, `fk-` and the run of characters droid accepts. */
const FACTORY_KEY_RE = /\bfk-[A-Za-z0-9_-]{8,}\b/g;

/** The keys in pasted text: one a line, a `.env` line or JSON, each once. */
export function factoryKeysIn(texts: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const text of texts) {
    for (const key of text.match(FACTORY_KEY_RE) ?? []) {
      if (!seen.has(key)) {
        seen.add(key);
        out.push(key);
      }
    }
  }
  return out;
}

/** A key as it is shown before `whoami` names its account. */
export function factoryKeyName(key: string): string {
  return key.length <= 10 ? key : `${key.slice(0, 7)}…${key.slice(-4)}`;
}

/** Where this account's org is served (`factoryCreds.base`). */
export function factoryBase(
  account: Pick<FactorySubscriptionAccount, "region" | "prem">,
  options: Pick<FactoryKeyOptions, "apiBase" | "euBase"> = {},
): string {
  if (account.prem !== null && account.prem !== "") {
    return account.prem;
  }
  if (account.region === "eu") {
    return options.euBase ?? FACTORY_API_EU;
  }
  return options.apiBase ?? FACTORY_API;
}

function errorText(status: number, said: string): string {
  const body = said.trim();
  return `Factory answered ${status}${body === "" ? "" : `: ${body.slice(0, 300)}`}`;
}

/**
 * Asks Factory whose key this is, with droid's headers: the key,
 * `X-Factory-Whoami-Extended`, and the active org when there is one.
 */
export async function factoryWhoami(
  input: { key: string; orgId?: string | null; base?: string },
  options: FactoryKeyOptions = {},
): Promise<FactoryWho | { error: string }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const headers: Record<string, string> = {
    authorization: `Bearer ${input.key}`,
    "x-factory-whoami-extended": "true",
  };
  if (input.orgId !== undefined && input.orgId !== null && input.orgId !== "") {
    headers["x-factory-org-id"] = input.orgId;
  }
  let response: Response;
  try {
    response = await fetchImpl(`${input.base ?? options.apiBase ?? FACTORY_API}/api/cli/whoami`, {
      headers,
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  const text = await response.text();
  if (!response.ok) {
    return { error: errorText(response.status, text) };
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { error: "Factory's whoami didn't answer JSON" };
  }
  if (typeof body !== "object" || body === null) {
    return { error: "Factory's whoami named no account" };
  }
  const record = body as Record<string, unknown>;
  return {
    userId: stringOf(record.userId),
    orgId: stringOf(record.orgId),
    email: stringOf(record.email),
    region: stringOf(record.region),
    prem: stringOf(record.premBaseHostV2),
  };
}

/**
 * Turns one key into the account Neolix keeps, after `whoami` accepts it.
 * A key Factory takes but cannot name is refused, as myna refuses it.
 */
export async function addFactoryKey(
  key: string,
  options: FactoryKeyOptions = {},
): Promise<{ account: FactorySubscriptionAccount } | { error: string }> {
  const wanted = key.trim();
  if (!/^fk-[A-Za-z0-9_-]{8,}$/.test(wanted)) {
    return { error: `"${factoryKeyName(wanted)}" is not a Factory API key (fk-…)` };
  }
  const who = await factoryWhoami({ key: wanted }, options);
  if ("error" in who) {
    return { error: `Factory didn't take this key: ${who.error}` };
  }
  const user = who.email !== "" ? who.email : who.userId;
  if (user === "") {
    return { error: "Factory took the key but didn't say whose account it is" };
  }
  return {
    account: {
      agent: "factory",
      id: subscriptionAccountId("factory", user),
      user,
      plan: null,
      addedAt: options.now?.() ?? Date.now(),
      lapsed: null,
      key: wanted,
      orgId: who.orgId === "" ? null : who.orgId,
      region: who.region === "" ? null : who.region,
      prem: who.prem === "" ? null : who.prem,
    },
  };
}

/** The headers a Factory request carries. */
export function factoryAuthHeaders(
  account: Pick<FactorySubscriptionAccount, "key" | "orgId">,
): Record<string, string> {
  return {
    authorization: `Bearer ${account.key}`,
    ...(account.orgId === null || account.orgId === ""
      ? {}
      : { "x-factory-org-id": account.orgId }),
  };
}

// ---- models ---------------------------------------------------------------

/** One model Factory serves a subscription, as droid's registry lists it. */
export interface FactoryModel extends GatewayModel {
  /** The wire droid sends it on. */
  protocol: GatewayProvider["protocol"];
  /** The vendor droid names in `x-api-provider`. */
  upstream: string;
}

/**
 * The models droid's picker offers, less auto, ported from myna's
 * `factoryModels` (`provider/factory.go:175-218`).
 */
export const FACTORY_MODELS: readonly FactoryModel[] = [
  {
    id: "claude-fable-5.1",
    label: "Fable 5.1",
    protocol: "anthropic",
    upstream: "anthropic",
    contextWindow: 867_000,
    maxOutputTokens: 128_000,
    images: true,
  },
  {
    id: "claude-fable-5",
    label: "Fable 5",
    protocol: "anthropic",
    upstream: "anthropic",
    contextWindow: 867_000,
    maxOutputTokens: 128_000,
    images: true,
  },
  {
    id: "claude-opus-5-5",
    label: "Opus 5.5",
    protocol: "anthropic",
    upstream: "anthropic",
    contextWindow: 872_000,
    maxOutputTokens: 128_000,
    images: true,
  },
  {
    id: "claude-opus-5",
    label: "Opus 5",
    protocol: "anthropic",
    upstream: "anthropic",
    contextWindow: 867_000,
    maxOutputTokens: 128_000,
    images: true,
  },
  {
    id: "claude-opus-4-8",
    label: "Opus 4.8",
    protocol: "anthropic",
    upstream: "anthropic",
    contextWindow: 867_000,
    maxOutputTokens: 128_000,
    images: true,
  },
  {
    id: "claude-sonnet-5-5",
    label: "Sonnet 5.5",
    protocol: "anthropic",
    upstream: "anthropic",
    contextWindow: 872_000,
    maxOutputTokens: 128_000,
    images: true,
  },
  {
    id: "claude-sonnet-5",
    label: "Sonnet 5",
    protocol: "anthropic",
    upstream: "anthropic",
    contextWindow: 872_000,
    maxOutputTokens: 128_000,
    images: true,
  },
  {
    id: "claude-sonnet-4-6",
    label: "Sonnet 4.6",
    protocol: "anthropic",
    upstream: "anthropic",
    contextWindow: 931_000,
    maxOutputTokens: 64_000,
    images: true,
  },
  {
    id: "claude-haiku-5-5",
    label: "Haiku 5.5",
    protocol: "anthropic",
    upstream: "anthropic",
    contextWindow: 872_000,
    maxOutputTokens: 128_000,
    images: true,
  },
  {
    id: "claude-haiku-4-5-20251001",
    label: "Haiku 4.5",
    protocol: "anthropic",
    upstream: "anthropic",
    images: true,
  },
  {
    id: "gpt-6-sol",
    label: "GPT-6 Sol",
    protocol: "openai-responses",
    upstream: "openai",
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    images: true,
  },
  {
    id: "gpt-6-astra",
    label: "GPT-6 Astra",
    protocol: "openai-responses",
    upstream: "openai",
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    images: true,
  },
  {
    id: "gpt-6-luna",
    label: "GPT-6 Luna",
    protocol: "openai-responses",
    upstream: "openai",
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    images: true,
  },
  {
    id: "gpt-5.6-sol",
    label: "GPT-5.6 Sol",
    protocol: "openai-responses",
    upstream: "openai",
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    images: true,
  },
  {
    id: "gpt-5.6-terra",
    label: "GPT-5.6 Terra",
    protocol: "openai-responses",
    upstream: "openai",
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    images: true,
  },
  {
    id: "gpt-5.6-luna",
    label: "GPT-5.6 Luna",
    protocol: "openai-responses",
    upstream: "openai",
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    images: true,
  },
  {
    id: "gpt-5.5",
    label: "GPT-5.5",
    protocol: "openai-responses",
    upstream: "openai",
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    images: true,
  },
  {
    id: "gpt-5.4",
    label: "GPT-5.4",
    protocol: "openai-responses",
    upstream: "openai",
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    images: true,
  },
  {
    id: "gpt-5.3-codex",
    label: "GPT-5.3-Codex",
    protocol: "openai-responses",
    upstream: "openai",
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    images: true,
  },
  {
    id: "grok-4.7",
    label: "Grok 4.7",
    protocol: "openai-responses",
    upstream: "xai",
    contextWindow: 500_000,
    maxOutputTokens: 63_356,
    images: true,
  },
  {
    id: "grok-4.6",
    label: "Grok 4.6",
    protocol: "openai-responses",
    upstream: "xai",
    contextWindow: 200_000,
    maxOutputTokens: 63_356,
    images: true,
  },
  {
    id: "gemini-4-argon",
    label: "Gemini 4 Argon",
    protocol: "gemini",
    upstream: "google",
    contextWindow: 1_000_000,
    maxOutputTokens: 65_536,
    images: true,
  },
  {
    id: "gemini-3.1-pro-preview",
    label: "Gemini 3.1 Pro",
    protocol: "gemini",
    upstream: "google",
    contextWindow: 1_000_000,
    maxOutputTokens: 65_536,
    images: true,
  },
  {
    id: "gemini-3.8-flash",
    label: "Gemini 3.8 Flash",
    protocol: "gemini",
    upstream: "google",
    contextWindow: 1_000_000,
    maxOutputTokens: 65_536,
    images: true,
  },
  {
    id: "gemini-3.7-flash",
    label: "Gemini 3.7 Flash",
    protocol: "gemini",
    upstream: "google",
    contextWindow: 1_000_000,
    maxOutputTokens: 65_536,
    images: true,
  },
  {
    id: "gemini-3.6-flash",
    label: "Gemini 3.6 Flash",
    protocol: "gemini",
    upstream: "google",
    contextWindow: 1_000_000,
    maxOutputTokens: 65_536,
    images: true,
  },
  {
    id: "gemini-3.5-flash",
    label: "Gemini 3.5 Flash",
    protocol: "gemini",
    upstream: "google",
    contextWindow: 1_000_000,
    maxOutputTokens: 65_536,
    images: true,
  },
  {
    id: "gemini-3-flash-preview",
    label: "Gemini 3 Flash",
    protocol: "gemini",
    upstream: "google",
    contextWindow: 1_000_000,
    maxOutputTokens: 65_536,
    images: true,
  },
  {
    id: "glm-5.3",
    label: "GLM-5.3",
    protocol: "openai",
    upstream: "fireworks",
    contextWindow: 1_040_000,
    maxOutputTokens: 131_072,
  },
  {
    id: "glm-5.3-flash",
    label: "GLM-5.3-Flash",
    protocol: "openai",
    upstream: "fireworks",
    contextWindow: 1_048_576,
    maxOutputTokens: 131_072,
    images: true,
  },
  {
    id: "glm-5.2",
    label: "GLM-5.2",
    protocol: "openai",
    upstream: "baseten",
    contextWindow: 1_040_000,
    maxOutputTokens: 131_072,
  },
  {
    id: "kimi-k3",
    label: "Kimi K3",
    protocol: "openai",
    upstream: "fireworks",
    contextWindow: 262_144,
    maxOutputTokens: 65_536,
    images: true,
  },
  {
    id: "deepseek-v4.1-flash",
    label: "DeepSeek V4.1 Flash",
    protocol: "openai",
    upstream: "fireworks",
    contextWindow: 1_040_000,
    maxOutputTokens: 131_072,
    images: true,
  },
  {
    id: "qwen3.8-max",
    label: "Qwen3.8 Max",
    protocol: "openai",
    upstream: "fireworks",
    contextWindow: 262_144,
    maxOutputTokens: 131_072,
  },
  {
    id: "minimax-m3",
    label: "MiniMax M3",
    protocol: "openai",
    upstream: "fireworks",
    contextWindow: 512_000,
    maxOutputTokens: 64_000,
    images: true,
  },
  {
    id: "minimax-m2.7",
    label: "MiniMax M2.7",
    protocol: "anthropic",
    upstream: "fireworks",
    contextWindow: 196_600,
    maxOutputTokens: 64_000,
  },
  {
    id: "mistral-large-4",
    label: "Mistral Large 4",
    protocol: "openai",
    upstream: "mistral",
    contextWindow: 524_288,
    maxOutputTokens: 64_000,
    images: true,
  },
  {
    id: "mistral-medium-3.5",
    label: "Mistral Medium 3.5",
    protocol: "openai",
    upstream: "mistral",
    contextWindow: 256_000,
    maxOutputTokens: 64_000,
    images: true,
  },
  {
    id: "nemotron-3-ultra",
    label: "Nemotron 3 Ultra",
    protocol: "openai",
    upstream: "baseten",
    contextWindow: 202_000,
    maxOutputTokens: 65_536,
  },
];

/** One model droid's registry lists, or null for one it didn't. */
export function factoryModel(id: string): FactoryModel | null {
  return FACTORY_MODELS.find((model) => model.id === id) ?? null;
}

/** The models a provider signed in to a Factory account adds to its list. */
export function factoryGatewayModels(): GatewayModel[] {
  return FACTORY_MODELS.map(({ protocol: _protocol, upstream: _upstream, ...model }) => model);
}

/** The wires a model is tried on, in order; one droid didn't list may ride any of the three. */
export function factoryModelProtocols(id: string): GatewayProvider["protocol"][] {
  const model = factoryModel(id);
  return model === null ? ["anthropic", "openai-responses", "openai"] : [model.protocol];
}

function stringOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}
