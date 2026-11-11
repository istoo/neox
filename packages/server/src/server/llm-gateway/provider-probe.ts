import type { GatewayProvider } from "./config.js";
import { fetch as undiciFetch } from "undici";
import { upstreamDispatcher } from "./dispatchers.js";
import { gatewayUserAgent } from "./header-passthrough.js";

type GatewayProtocol = GatewayProvider["protocol"];

/**
 * Asks a provider the settings form is still editing what it serves: its model
 * list, or whether one model answers. Called from `gateway.provider.*` RPCs, so
 * the URL comes from the user's own form rather than from a request body.
 */

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_ERROR_CHARS = 300;

export type ProviderProbeTarget = Pick<
  GatewayProvider,
  "protocol" | "baseUrl" | "apiKey" | "headers" | "insecureTls" | "modelsUrl"
> & {
  /** The proxy an account's requests go through, when it names one. */
  proxy?: string;
};

export type DetectedProtocol = "openai" | "openai-responses" | "anthropic" | "gemini";

export interface ProtocolDetection {
  protocol: DetectedProtocol;
  /** The URL that protocol's requests belong at, derived from the typed one. */
  base: string;
  ok: boolean;
  status: number;
  error: string | null;
}

const DETECT_PROTOCOLS: DetectedProtocol[] = ["openai", "openai-responses", "anthropic", "gemini"];

export interface ProviderProbeResult {
  ok: boolean;
  status: number;
  latencyMs: number;
  error: string | null;
}

/**
 * A probe the settings form asked for, written to the request log and never
 * counted in usage or cost — myna's probelog. `kind` is what the call was
 * for; `baseUrl` is the form's, so the log names the host the user is
 * configuring before it is saved.
 */
export interface ProbeNotice {
  kind: "test" | "detect" | "list";
  protocol: GatewayProtocol;
  baseUrl: string;
  model: string | null;
  status: number;
  millis: number;
  error: string | null;
}

export type ProbeSink = (notice: ProbeNotice) => void;

export async function fetchProviderModels(
  target: ProviderProbeTarget,
  sink?: ProbeSink,
): Promise<string[]> {
  const url = modelsUrl(target);
  const startedAt = Date.now();
  let response: Response;
  try {
    response = await probeFetch(url, target, { method: "GET" });
  } catch (error) {
    const message = errorMessage(error);
    sink?.({
      kind: "list",
      protocol: target.protocol,
      baseUrl: target.baseUrl,
      model: null,
      status: 0,
      millis: Date.now() - startedAt,
      error: message,
    });
    throw new Error(message, { cause: error });
  }
  if (!response.ok) {
    const error = await describeFailure(response, "The vendor refused the model list");
    sink?.({
      kind: "list",
      protocol: target.protocol,
      baseUrl: target.baseUrl,
      model: null,
      status: response.status,
      millis: Date.now() - startedAt,
      error,
    });
    throw new Error(error);
  }
  const body = await readLimited(response);
  sink?.({
    kind: "list",
    protocol: target.protocol,
    baseUrl: target.baseUrl,
    model: null,
    status: response.status,
    millis: Date.now() - startedAt,
    error: null,
  });
  return parseModelIds(target.protocol, body);
}

export async function testProviderModel(
  target: ProviderProbeTarget,
  model: string,
  sink?: ProbeSink,
): Promise<ProviderProbeResult> {
  const result = await probeModel(target, model);
  sink?.({
    kind: "test",
    protocol: target.protocol,
    baseUrl: target.baseUrl,
    model,
    status: result.status,
    millis: result.latencyMs,
    error: result.error,
  });
  return result;
}

async function probeModel(
  target: ProviderProbeTarget,
  model: string,
): Promise<ProviderProbeResult> {
  const startedAt = Date.now();
  let response: Response;
  try {
    response = await probeFetch(modelUrl(target, model), target, {
      method: "POST",
      body: JSON.stringify(probeBody(target.protocol, model)),
    });
  } catch (error) {
    return {
      ok: false,
      status: 0,
      latencyMs: Date.now() - startedAt,
      error: errorMessage(error),
    };
  }
  const latencyMs = Date.now() - startedAt;
  if (response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return { ok: true, status: response.status, latencyMs, error: null };
  }
  const error = await describeFailure(response, "The vendor refused the request");
  return { ok: false, status: response.status, latencyMs, error };
}

/**
 * The base URL a protocol's requests belong at, given the one the user typed.
 * Anthropic takes the root (its callers append /v1/messages), Gemini the
 * /v1beta beside a /v1, and OpenAI's two keep /v1.
 */
export function detectBaseFor(protocol: DetectedProtocol, typed: string): string {
  let base = typed.trim().replace(/\/+$/, "");
  for (const suffix of ["/chat/completions", "/responses", "/v1/messages", "/messages"]) {
    if (base.endsWith(suffix)) {
      base = base.slice(0, -suffix.length);
      break;
    }
  }
  if (protocol === "anthropic") {
    return base.endsWith("/v1") ? base.slice(0, -3) : base;
  }
  if (protocol === "gemini") {
    if (base.endsWith("/v1")) {
      return `${base}beta`;
    }
    return base;
  }
  const path = safePath(base);
  return path === "" ? `${base}/v1` : base;
}

function safePath(value: string): string {
  try {
    return new URL(value).pathname.replace(/\/+$/, "");
  } catch {
    return "";
  }
}

/**
 * Asks every protocol the gateway speaks at the typed URL: the smallest
 * request when a model is known, otherwise that API's model list. A protocol
 * answering 200 is one the provider can be given.
 */
export async function detectProviderProtocols(
  target: ProviderProbeTarget,
  model: string | null,
  sink?: ProbeSink,
): Promise<ProtocolDetection[]> {
  return Promise.all(
    DETECT_PROTOCOLS.map(async (protocol) => {
      const base = detectBaseFor(protocol, target.baseUrl);
      const candidate: ProviderProbeTarget = Object.assign({}, target, {
        protocol,
        baseUrl: base,
      });
      const startedAt = Date.now();
      if (model !== null && model.length > 0) {
        const result = await probeModel(candidate, model);
        sink?.({
          kind: "detect",
          protocol,
          baseUrl: base,
          model,
          status: result.status,
          millis: result.latencyMs,
          error: result.error,
        });
        return {
          protocol,
          base,
          ok: result.ok,
          status: result.status,
          error: result.error,
        };
      }
      try {
        const response = await probeFetch(modelsUrl(candidate), candidate, { method: "GET" });
        const status = response.status;
        await response.body?.cancel().catch(() => undefined);
        sink?.({
          kind: "detect",
          protocol,
          baseUrl: base,
          model: null,
          status,
          millis: Date.now() - startedAt,
          error: response.ok ? null : `HTTP ${status}`,
        });
        return {
          protocol,
          base,
          ok: response.ok,
          status,
          error: response.ok ? null : `HTTP ${status}`,
        };
      } catch (error) {
        const message = errorMessage(error);
        sink?.({
          kind: "detect",
          protocol,
          baseUrl: base,
          model: null,
          status: 0,
          millis: Date.now() - startedAt,
          error: message,
        });
        return {
          protocol,
          base,
          ok: false,
          status: 0,
          error: message,
        };
      }
    }),
  );
}

function modelsUrl(target: ProviderProbeTarget): URL {
  // myna's ModelsURL (`provider.go:487`): where its list is, when that is
  // not the vendor's own `${baseUrl}/models`.
  const own = target.modelsUrl?.trim();
  if (own !== undefined && own.length > 0) {
    return parseTargetUrl(own);
  }
  return parseTargetUrl(`${trimSlash(target.baseUrl)}/models`);
}

function modelUrl(target: ProviderProbeTarget, model: string): URL {
  const base = trimSlash(target.baseUrl);
  if (target.protocol === "gemini") {
    return parseTargetUrl(`${base}/models/${encodeURIComponent(model)}:generateContent`);
  }
  return parseTargetUrl(`${base}${chatPath(target.protocol)}`);
}

function chatPath(protocol: GatewayProtocol): string {
  switch (protocol) {
    case "anthropic":
      return "/messages";
    case "openai-responses":
      return "/responses";
    default:
      return "/chat/completions";
  }
}

function probeBody(protocol: GatewayProtocol, model: string): Record<string, unknown> {
  switch (protocol) {
    case "anthropic":
      return {
        model,
        max_tokens: 1,
        messages: [{ role: "user", content: "ping" }],
      };
    case "openai-responses":
      return { model, input: "ping", max_output_tokens: 16 };
    case "gemini":
      return {
        contents: [{ role: "user", parts: [{ text: "ping" }] }],
        generationConfig: { maxOutputTokens: 1 },
      };
    default:
      return {
        model,
        max_tokens: 1,
        messages: [{ role: "user", content: "ping" }],
      };
  }
}

/** Only http(s) leaves the daemon; a redirect is reported rather than followed. */
function parseTargetUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("The base URL is not a URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("The base URL must start with http:// or https://");
  }
  return url;
}

async function probeFetch(
  url: URL,
  target: ProviderProbeTarget,
  init: { method: "GET" | "POST"; body?: string },
): Promise<Response> {
  const headers = probeHeaders(target);
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const dispatcher = upstreamDispatcher({
    ...(target.proxy === undefined ? {} : { proxy: target.proxy }),
    ...(target.insecureTls === true ? { insecureTls: true } : {}),
  });
  if (dispatcher === undefined) {
    return fetch(url, {
      method: init.method,
      headers,
      body: init.body,
      redirect: "manual",
      signal,
    });
  }
  const dispatched: unknown = await undiciFetch(url, {
    method: init.method,
    headers: Object.fromEntries(headers),
    body: init.body,
    redirect: "manual",
    signal,
    dispatcher,
  });
  return dispatched as Response;
}

function probeHeaders(target: ProviderProbeTarget): Headers {
  const headers = new Headers({ accept: "application/json" });
  if (target.protocol !== "gemini") {
    headers.set("content-type", "application/json");
  }
  // A probe is Neolix's own request, so it goes as Neolix (myna's stampUA on
  // its own calls); a User-Agent among the provider's headers stands over it.
  headers.set("user-agent", gatewayUserAgent());
  for (const [name, value] of Object.entries(target.headers ?? {})) {
    headers.set(name, value);
  }
  const apiKey = target.apiKey;
  if (apiKey !== undefined) {
    if (target.protocol === "anthropic") {
      headers.set("anthropic-version", "2023-06-01");
      headers.set("x-api-key", apiKey);
    } else if (target.protocol === "gemini") {
      headers.set("x-goog-api-key", apiKey);
    } else {
      headers.set("authorization", `Bearer ${apiKey}`);
    }
  }
  return headers;
}

async function readLimited(response: Response): Promise<string> {
  const text = await response.text();
  return text.length > MAX_RESPONSE_BYTES ? text.slice(0, MAX_RESPONSE_BYTES) : text;
}

async function describeFailure(response: Response, prefix: string): Promise<string> {
  const detail = truncate((await readLimited(response).catch(() => "")).trim());
  const status = `HTTP ${response.status}`;
  return detail.length > 0 ? `${prefix} (${status}): ${detail}` : `${prefix} (${status})`;
}

function parseModelIds(protocol: GatewayProtocol, body: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error("The vendor did not answer JSON");
  }
  const entries = modelEntries(protocol, parsed);
  const ids = new Set<string>();
  for (const entry of entries) {
    const id = modelId(protocol, entry);
    if (id !== null) {
      ids.add(id);
    }
  }
  return [...ids].sort((left, right) => left.localeCompare(right));
}

function modelEntries(protocol: GatewayProtocol, parsed: unknown): unknown[] {
  if (typeof parsed !== "object" || parsed === null) {
    return [];
  }
  const record = parsed as Record<string, unknown>;
  const list = protocol === "gemini" ? record.models : record.data;
  return Array.isArray(list) ? list : [];
}

function modelId(protocol: GatewayProtocol, entry: unknown): string | null {
  if (typeof entry !== "object" || entry === null) {
    return null;
  }
  const record = entry as Record<string, unknown>;
  const raw = protocol === "gemini" ? record.name : record.id;
  if (typeof raw !== "string" || raw.length === 0) {
    return null;
  }
  if (protocol === "gemini") {
    const prefix = "models/";
    return raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
  }
  return raw;
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function truncate(value: string): string {
  return value.length > MAX_ERROR_CHARS ? `${value.slice(0, MAX_ERROR_CHARS)}…` : value;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      return `The vendor did not answer within ${REQUEST_TIMEOUT_MS / 1000}s`;
    }
    return truncate(error.message);
  }
  return truncate(String(error));
}
