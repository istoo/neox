import type { IncomingHttpHeaders } from "node:http";
import { fetch as undiciFetch } from "undici";
import type { GatewayAccount, GatewayModel, GatewayProvider } from "./config.js";
import { upstreamDispatcher } from "./dispatchers.js";
import { applyExtraBody } from "./extra-body.js";
import { agentUserAgentOf, gatewayUserAgent, passClientHeaders } from "./header-passthrough.js";
import { antigravitySystemPrompt, userAgentFor } from "./provider-shaping.js";
import { assertRecord, isRecord } from "./ir.js";
import { askedBetas, fitBetas } from "./betas.js";
import { chatGptApiSessionHeaders, chatgptApiBody } from "./chatgpt-api-body.js";
import {
  codeAssistAnswer,
  codeAssistEnvelope,
  codeAssistStream,
  codeAssistUrl,
  isCodeAssistAgent,
} from "./codeassist.js";
import { prepareSubscriptionUpstream, SubscriptionSkippedError } from "./subscription-upstream.js";
import { markMiddlewareReplyHeaders } from "./middleware-reply-headers.js";
import { openCodeFree, openCodeFreeUrl, openCodeProvider } from "./vendor-shaping.js";
import {
  hasGatewayMiddlewares,
  preparePluginUpstream,
  pluginRefOf,
  proxyPluginUpstream,
  runGatewayMiddlewareRequest,
  runGatewayMiddlewareResponse,
} from "./plugin-upstream.js";
import {
  vertexAuth,
  vertexClaude,
  vertexClaudeRequest,
  vertexPartner,
  vertexPath,
  vertexWholePath,
} from "./vertex-auth.js";

export type GatewayProtocol = GatewayProvider["protocol"];

/** One request the gateway sent upstream, for the archive's header log. */
export interface UpstreamWire {
  method: "POST";
  url: string;
  request: Record<string, string>;
  status: number;
  response: Record<string, string>;
  millis: number;
  error?: string;
}

export interface UpstreamRequestInput {
  provider: GatewayProvider;
  /** The credential this attempt uses; omitted when the provider has none. */
  account?: GatewayAccount;
  /** The model, and the name the vendor is asked for when it differs. */
  model: GatewayModel & { upstreamName?: string };
  body: Record<string, unknown>;
  incomingHeaders: IncomingHttpHeaders;
  /** The gateway's proxy, used when the account names none of its own. */
  proxy?: string;
  /** Aborts the attempt (the routing classifier's timeout). */
  signal?: AbortSignal;
  /** Told what went out and what came back, for the request archive. */
  onWire?: (wire: UpstreamWire) => void;
  /** `$NEOLIX_HOME/gateway`, where subscription sign-ins are kept. */
  gatewayDir?: string;
  /** Copilot's Auto session token, sent as `Copilot-Session-Token`. */
  copilotSessionToken?: string;
  /** Whether the agents' own sign-ins may be read (myna's account discovery). */
  accountDiscovery?: boolean;
}

export function buildUpstreamUrl(
  provider: GatewayProvider,
  modelId: string,
  streaming: boolean,
  account?: GatewayAccount,
  /** A subscription sign-in's base, which wins over the account's and provider's. */
  override?: string,
): string {
  const baseUrl = (override ?? account?.baseUrl ?? provider.baseUrl).replace(/\/+$/, "");
  // Zen's free tier answers at OpenCode 2's paths alone (myna's
  // forwardOnce, gateway.go:5307 — zenfree.go).
  if (openCodeProvider(provider) && openCodeFree(modelId)) {
    return openCodeFreeUrl(baseUrl, provider.protocol);
  }
  if ((provider.accounts ?? []).some((entry) => entry.agent === "factory")) {
    return factoryUpstreamUrl(baseUrl, provider.protocol);
  }
  switch (provider.protocol) {
    case "anthropic":
      return `${baseUrl}/messages`;
    case "openai":
      return `${baseUrl}/chat/completions`;
    case "openai-responses":
      return `${baseUrl}/responses`;
    case "gemini":
      // Gemini selects streaming by method name, not by a body flag.
      return streaming
        ? `${baseUrl}/models/${modelId}:streamGenerateContent?alt=sse`
        : `${baseUrl}/models/${modelId}:generateContent`;
  }
}

/**
 * Factory's paths under the org's own host: one wire per model (myna's
 * factoryAPIs). `factoryCreds.base()` returns the prem host as whoami gave
 * it, without a path, so the path is added here; Gemini's models are
 * generateContent at `/api/llm/g`, with the model in the body (myna's
 * `provider.Base(Gemini)` and `upstreamPath`).
 */
function factoryUpstreamUrl(baseUrl: string, protocol: GatewayProvider["protocol"]): string {
  switch (protocol) {
    case "anthropic":
      return `${baseUrl}/v1/messages`;
    case "openai":
      return `${baseUrl}/v1/chat/completions`;
    case "openai-responses":
      return `${baseUrl}/v1/responses`;
    case "gemini":
      return `${baseUrl}/api/llm/g/v1/generate`;
  }
}

export function buildUpstreamHeaders(
  provider: GatewayProvider,
  account: GatewayAccount | undefined,
  incomingHeaders: IncomingHttpHeaders,
  contentType = "application/json",
): Headers {
  const headers = new Headers({ "content-type": contentType });
  for (const [name, value] of Object.entries(provider.headers ?? {})) {
    headers.set(name, value);
  }
  for (const [name, value] of Object.entries(account?.headers ?? {})) {
    headers.set(name, value);
  }
  // The agent's own headers the provider lists (myna's passHeaders), over a
  // fixed header of the same name; an account's signing has the last word.
  passClientHeaders(provider, incomingHeaders, headers);
  const apiKey = account?.apiKey ?? provider.apiKey;
  if (provider.protocol === "anthropic") {
    headers.set(
      "anthropic-version",
      readHeader(incomingHeaders, "anthropic-version") ?? "2023-06-01",
    );
    const beta = readHeader(incomingHeaders, "anthropic-beta");
    if (beta !== null) {
      // The agent's own sign-in's betas are not the provider's to see, and
      // one a provider refused is left out (myna's askedBetas and betas).
      const kept = fitBetas(provider.id, askedBetas([beta]), provider.baseUrl);
      if (kept.length > 0) {
        headers.set("anthropic-beta", kept.join(","));
      }
    }
    if (apiKey !== undefined) {
      headers.set("x-api-key", apiKey);
    }
    // A provider or account header may name a beta it has since refused.
    const forwarded = headers.get("anthropic-beta");
    if (forwarded !== null) {
      const kept = fitBetas(provider.id, forwarded.split(","), provider.baseUrl);
      if (kept.length > 0) {
        headers.set("anthropic-beta", kept.join(","));
      } else {
        headers.delete("anthropic-beta");
      }
    }
  } else if (apiKey !== undefined && provider.protocol === "gemini") {
    headers.set("x-goog-api-key", apiKey);
  } else if (apiKey !== undefined) {
    headers.set("authorization", `Bearer ${apiKey}`);
  }
  // Codex says what a request is for here, and a Responses relay checks
  // it: remote compaction, or the gateway's own ("responses"). Relayed for
  // every protocol, as myna relays it, though only a Responses wire reads it.
  const turn = readHeader(incomingHeaders, "x-codex-turn-metadata");
  if (turn !== null) {
    headers.set("x-codex-turn-metadata", turn);
  }
  // The User-Agent the request goes with: the user's own when the provider's
  // headers name one, the agent's where the provider passes it on, else
  // Neolix's (myna's user_agent.go:22).
  headers.set("user-agent", upstreamUserAgent(provider, account, incomingHeaders));
  return headers;
}

/** The User-Agent a request to this provider goes with (myna's
 * `user_agent.go:22`). */
function upstreamUserAgent(
  provider: GatewayProvider,
  account: GatewayAccount | undefined,
  incomingHeaders: IncomingHttpHeaders,
): string {
  return userAgentFor(
    provider,
    agentUserAgentOf(provider, account, incomingHeaders) ?? undefined,
    gatewayUserAgent(),
  );
}

interface ShapedUpstream {
  headers: Headers;
  payload: Record<string, unknown>;
  url: string;
  codeAssist: boolean;
  streaming: boolean;
  /** The plugin fetch this request goes through, when its loader gave one. */
  pluginProxy?: { pluginId: string; providerId: string; token: string };
}

/**
 * The loader's answer for a plugin-backed provider: its headers over the
 * gateway's, the body it shaped, and where it says the request goes.
 */
async function applyPluginUpstream(input: {
  provider: GatewayProvider;
  accountId: string;
  model: string;
  payload: Record<string, unknown>;
  headers: Headers;
}): Promise<{ payload: Record<string, unknown>; baseUrl?: string; token?: string }> {
  const target = await preparePluginUpstream({
    provider: input.provider,
    accountId: input.accountId,
    model: input.model,
    body: input.payload,
    headers: Object.fromEntries(input.headers),
  });
  if (target === null) return { payload: input.payload };
  if ("skip" in target) throw new SubscriptionSkippedError(target.skip);
  for (const [name, value] of Object.entries(target.headers)) {
    input.headers.set(name, value);
  }
  return {
    payload: target.body ?? input.payload,
    ...(target.baseUrl === undefined || target.baseUrl === "" ? {} : { baseUrl: target.baseUrl }),
    token: target.token,
  };
}

/** The body after the provider's extra fields and its protocol's shaping. */
function upstreamPayload(
  input: UpstreamRequestInput,
  provider: GatewayProvider,
  headers: Headers,
  modelName: string,
  account: UpstreamRequestInput["account"],
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    ...applyExtraBody(input.body, provider.extraBody),
    model: modelName,
  };
  if (provider.protocol === "gemini") {
    delete payload.stream;
  }
  const shaped = chatGptApiBody(payload, headers, account, provider);
  if (input.copilotSessionToken !== undefined) {
    // Copilot's Auto names the model its session token serves
    // (myna's copilot_auto.go).
    headers.set("copilot-session-token", input.copilotSessionToken);
  }
  return shaped;
}

/** A subscription sign-in's headers and base, or empty when it has none. */
async function applySubscription(
  input: UpstreamRequestInput,
  account: UpstreamRequestInput["account"],
  headers: Headers,
): Promise<{ baseUrl?: string; project: string | null }> {
  const subscription = await subscriptionOf(input, account);
  if (subscription === null) return { project: null };
  if ("skip" in subscription) throw new SubscriptionSkippedError(subscription.skip);
  for (const [name, value] of Object.entries(subscription.headers)) {
    headers.set(name, value);
  }
  return {
    ...(subscription.baseUrl === undefined ? {} : { baseUrl: subscription.baseUrl }),
    project: subscription.project ?? null,
  };
}

/**
 * A request as the upstream takes it: the provider's own headers and body,
 * with a subscription sign-in's over them, ChatGPT's field set, and Code
 * Assist's envelope around a Gemini body.
 */
/**
 * Zen's free tier takes only what OpenCode itself sends, so a free-model
 * request to opencode.ai keeps just the headers OpenCode 2.2.5 sends its
 * gateway (myna's gateway.go:5391-5400).
 */
function dropNonOpenCodeHeaders(
  headers: Headers,
  provider: GatewayProvider,
  modelName: string,
): void {
  if (!openCodeProvider(provider) || !openCodeFree(modelName)) {
    return;
  }
  for (const name of headers.keys()) {
    if (name !== "content-type" && name !== "anthropic-version" && name !== "anthropic-beta") {
      headers.delete(name);
    }
  }
}

async function shapeUpstreamRequest(input: UpstreamRequestInput): Promise<ShapedUpstream> {
  const { provider, account, model, incomingHeaders } = input;
  const headers = buildUpstreamHeaders(provider, account, incomingHeaders);
  // Streaming is read before a hook runs, so a hook that flips `stream`
  // does not move the request to the other endpoint (myna's onRequest).
  const streaming = input.body.stream === true;
  // A plugin's middleware may reshape the body going out (myna's onRequest).
  const middleware = await runGatewayMiddlewareRequest({
    providerId: provider.id,
    protocol: provider.protocol,
    model: model.id,
    accountId: account?.id ?? "",
    body: input.body,
  });
  const request = middleware?.body === undefined ? input : { ...input, body: middleware.body };
  // The user may ask the vendor for a model by another name (myna's Wires).
  const modelName = model.upstreamName ?? model.id;
  const shapedPayload = upstreamPayload(request, provider, headers, modelName, account);
  const subscription = await applySubscription(input, account, headers);
  const pluginUpstream = await applyPluginUpstream({
    provider,
    accountId: account?.id ?? "",
    model: modelName,
    payload: shapedPayload,
    headers,
  });
  const payload = pluginUpstream.payload;
  const codeAssist = provider.protocol === "gemini" && isCodeAssistAgent(account?.agent ?? "");
  const url = buildUpstreamUrl(
    provider,
    modelName,
    streaming,
    account,
    pluginUpstream.baseUrl ?? subscription.baseUrl,
  );
  const target = await shapeUpstreamTarget({
    provider,
    account,
    modelId: model.id,
    streaming,
    payload,
    codeAssist,
    headers,
    baseUrl: pluginUpstream.baseUrl ?? subscription.baseUrl ?? account?.baseUrl ?? provider.baseUrl,
    project: subscription.project,
    fallbackUrl: url,
    ...(input.proxy === undefined ? {} : { proxy: input.proxy }),
  });
  // Zen's free tier takes only what OpenCode itself sends: an agent's own
  // headers (Claude Code's x-stainless-*, Codex's originator) would mark
  // the request as not OpenCode's, so everything else is dropped
  // (myna's gateway.go:5391-5400).
  dropNonOpenCodeHeaders(headers, provider, modelName);
  const ref = pluginRefOf(provider);
  return {
    headers,
    payload: target.payload,
    url: target.url,
    codeAssist,
    streaming,
    ...(pluginUpstream.token !== undefined && ref !== null
      ? {
          pluginProxy: {
            pluginId: ref.pluginId,
            providerId: ref.providerId,
            token: pluginUpstream.token,
          },
        }
      : {}),
  };
}

/**
 * Where a request goes once its sign-in is set: a Code Assist envelope for
 * an account signed in to Gemini or Antigravity, a Vertex AI project, or
 * the provider's own base.
 */
async function shapeUpstreamTarget(input: {
  provider: GatewayProvider;
  account: GatewayAccount | undefined;
  modelId: string;
  streaming: boolean;
  payload: Record<string, unknown>;
  codeAssist: boolean;
  headers: Headers;
  baseUrl: string;
  project: string | null;
  fallbackUrl: string;
  proxy?: string;
}): Promise<{ url: string; payload: Record<string, unknown> }> {
  if (input.codeAssist) {
    // Antigravity turns away a few well-known system prompts whatever quota
    // is left; the lines are broken up as Google's check doesn't read them
    // (myna's codeassist.go:123-165).
    const sent =
      input.account?.agent === "antigravity" && input.provider.promptAsWritten !== true
        ? cloakAntigravitySystem(input.provider, input.payload)
        : input.payload;
    return {
      url: codeAssistUrl(input.baseUrl.replace(/\/+$/, ""), input.streaming),
      payload: codeAssistEnvelope({
        model: input.modelId,
        project: input.project,
        request: sent,
      }),
    };
  }
  // A Vertex AI provider is its project at its location, under Google's
  // token; a Claude or Gemini model's id, not the base, says where
  // (myna's vertex.go; gateway/vertex.go).
  const vertex = await vertexUpstream({
    provider: input.provider,
    modelId: input.modelId,
    streaming: input.streaming,
    headers: input.headers,
    payload: input.payload,
    ...(input.proxy === undefined ? {} : { proxy: input.proxy }),
  });
  return vertex ?? { url: input.fallbackUrl, payload: input.payload };
}

/**
 * The system instruction an Antigravity account is sent: the lines it turns
 * away broken up by a zero-width space, every other byte as the agent wrote
 * it (myna's antigravityCloak).
 */
function cloakAntigravitySystem(
  provider: GatewayProvider,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const instruction = payload.systemInstruction;
  if (!isRecord(instruction) || !Array.isArray(instruction.parts)) {
    return payload;
  }
  let changed = false;
  const parts = instruction.parts.map((entry: unknown) => {
    if (!isRecord(entry) || typeof entry.text !== "string") {
      return entry;
    }
    const cloaked = antigravitySystemPrompt(provider, entry.text);
    if (cloaked === entry.text) {
      return entry;
    }
    changed = true;
    return { ...entry, text: cloaked };
  });
  return changed ? { ...payload, systemInstruction: { ...instruction, parts } } : payload;
}

/**
 * A Vertex AI request's address and body, its token in the headers: Gemini
 * on generateContent, an Anthropic Claude on the Messages API with the
 * model moved into the path, a partner model on the project's
 * OpenAI-compatible chat completions. Null for a provider that isn't one.
 */
async function vertexUpstream(input: {
  provider: GatewayProvider;
  modelId: string;
  streaming: boolean;
  headers: Headers;
  payload: Record<string, unknown>;
  proxy?: string;
}): Promise<{ url: string; payload: Record<string, unknown> } | null> {
  const settings = input.provider.vertex;
  if (settings === undefined) {
    return null;
  }
  const auth = await vertexAuth(
    { ...settings, project: settings.project ?? "" },
    input.proxy === undefined ? {} : { proxy: input.proxy },
  );
  if ("error" in auth) {
    throw new Error(auth.error);
  }
  input.headers.set("authorization", auth.headers.authorization);
  if (vertexClaude(input.modelId)) {
    const moved = vertexClaudeRequest("/v1/messages", JSON.stringify(input.payload));
    if (moved !== null) {
      return {
        url: `${auth.baseUrl}${moved.path}`,
        payload: assertRecord(JSON.parse(moved.body), "vertex request body"),
      };
    }
    return {
      url: `${auth.baseUrl}/publishers/anthropic/models/${input.modelId}:rawPredict`,
      payload: input.payload,
    };
  }
  if (vertexPartner(input.modelId)) {
    return { url: `${auth.baseUrl}/endpoints/openapi/chat/completions`, payload: input.payload };
  }
  return {
    url: `${auth.baseUrl}${
      input.streaming ? vertexPath(input.modelId, true) : vertexWholePath(input.modelId)
    }`,
    payload: input.payload,
  };
}

/** The account's subscription sign-in, when it names one. */
async function subscriptionOf(
  input: UpstreamRequestInput,
  account: UpstreamRequestInput["account"],
): Promise<Awaited<ReturnType<typeof prepareSubscriptionUpstream>> | null> {
  if (input.gatewayDir === undefined || account?.agent === undefined) {
    return null;
  }
  return prepareSubscriptionUpstream({
    account,
    gatewayDir: input.gatewayDir,
    ...(input.proxy === undefined ? {} : { proxy: input.proxy }),
    ...(input.accountDiscovery === undefined ? {} : { accountDiscovery: input.accountDiscovery }),
  });
}

/** A Responses body as Sign in with ChatGPT takes it, its session in headers. */
function chatGptApiBody(
  payload: Record<string, unknown>,
  headers: Headers,
  account: UpstreamRequestInput["account"],
  provider: GatewayProvider,
): Record<string, unknown> {
  if (account?.agent !== "chatgpt-api" || provider.protocol !== "openai-responses") {
    return payload;
  }
  const shaped = chatgptApiBody(payload);
  for (const [name, value] of Object.entries(chatGptApiSessionHeaders(shaped))) {
    headers.set(name, value);
  }
  return shaped;
}

/**
 * The vendor's answer after plugin middleware. Streaming answers pass through
 * untouched (debt: middleware sees non-streaming answers only until a
 * streaming plugin RPC exists); a non-streaming one is buffered to be seen.
 */
async function applyGatewayMiddlewareResponse(
  response: Response,
  input: UpstreamRequestInput,
): Promise<Response> {
  if (!hasGatewayMiddlewares() || input.body.stream === true) return response;
  const text = await response.text();
  const headers = new Headers(response.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  const changed = await runGatewayMiddlewareResponse({
    providerId: input.provider.id,
    model: input.model.id,
    accountId: input.account?.id ?? "",
    status: response.status,
    headers: Object.fromEntries(headers),
    body: text === "" ? null : text,
  });
  if (changed === null) {
    return new Response(text === "" ? null : text, { status: response.status, headers });
  }
  const changedHeaders = new Headers(changed.headers);
  changedHeaders.delete("content-encoding");
  changedHeaders.delete("content-length");
  const rewritten = new Response(changed.body === null ? null : changed.body, {
    status: changed.status,
    headers: changedHeaders,
  });
  markMiddlewareReplyHeaders(rewritten, [...changedHeaders.keys()]);
  return rewritten;
}

export async function requestUpstream(input: UpstreamRequestInput): Promise<Response> {
  const { provider, account } = input;
  const { headers, payload, url, codeAssist, streaming, pluginProxy } =
    await shapeUpstreamRequest(input);
  const proxy = account?.proxy ?? input.proxy;
  const dispatcher = upstreamDispatcher({
    ...(proxy === undefined ? {} : { proxy }),
    ...(provider.insecureTls === true ? { insecureTls: true } : {}),
  });
  const body = JSON.stringify(payload);
  const signal = input.signal === undefined ? {} : { signal: input.signal };
  const started = Date.now();
  const sent: Record<string, string> = Object.fromEntries(headers);
  const tell = (response: Response | null, error?: unknown): void => {
    input.onWire?.({
      method: "POST",
      url,
      request: sent,
      status: response?.status ?? 0,
      response: response === null ? {} : Object.fromEntries(response.headers),
      millis: Date.now() - started,
      ...(error === undefined
        ? {}
        : { error: error instanceof Error ? error.message : String(error) }),
    });
  };
  try {
    if (pluginProxy !== undefined) {
      // The loader's own fetch runs in the plugin process; its answer is
      // buffered whole, so a stream arrives as one body (debt: buffered
      // through the plugin process; a streaming RPC would restore chunks).
      const proxied = await proxyPluginUpstream({
        pluginId: pluginProxy.pluginId,
        providerId: pluginProxy.providerId,
        token: pluginProxy.token,
        url,
        method: "POST",
        headers: sent,
        body,
      });
      if ("skip" in proxied) throw new SubscriptionSkippedError(proxied.skip);
      const responseHeaders = new Headers(proxied.headers);
      responseHeaders.delete("content-encoding");
      responseHeaders.delete("content-length");
      const bytes = proxied.body;
      const responseBody = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer;
      const response = new Response(responseBody, {
        status: proxied.status,
        headers: responseHeaders,
      });
      tell(response);
      return applyGatewayMiddlewareResponse(response, input);
    }
    if (dispatcher !== undefined) {
      // Node's global fetch has no dispatcher option; undici's does. undici ships
      // its own DOM types, hence the cast back to the platform Response.
      const dispatched: unknown = await undiciFetch(url, {
        method: "POST",
        headers: Object.fromEntries(headers),
        body,
        dispatcher,
        ...signal,
      });
      tell(dispatched as Response);
      const unenveloped = codeAssist
        ? await unwrapCodeAssist(dispatched as Response, streaming)
        : (dispatched as Response);
      return applyGatewayMiddlewareResponse(unenveloped, input);
    }
    const response = await fetch(url, {
      method: "POST",
      headers,
      body,
      ...signal,
    });
    tell(response);
    const unenveloped = codeAssist ? await unwrapCodeAssist(response, streaming) : response;
    return applyGatewayMiddlewareResponse(unenveloped, input);
  } catch (error) {
    tell(null, error);
    throw error;
  }
}

/**
 * Code Assist's reply as the Gemini codec reads it: every `data:` frame's
 * `{response}` unwrapped, or a whole reply's envelope. Other lines (event
 * names, blank separators) pass untouched.
 */
async function unwrapCodeAssist(response: Response, streaming: boolean): Promise<Response> {
  if (!response.ok || response.body === null) {
    return response;
  }
  if (streaming) {
    return new Response(codeAssistStreamBody(response.body), {
      status: response.status,
      headers: response.headers,
    });
  }
  const text = await response.text();
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return new Response(text, { status: response.status, headers: response.headers });
  }
  const answer = codeAssistAnswer(value);
  if ("error" in answer) {
    return new Response(JSON.stringify({ error: { message: answer.error } }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });
  }
  if ("empty" in answer) {
    return new Response(text, { status: response.status, headers: response.headers });
  }
  return new Response(JSON.stringify(answer.chunk), {
    status: response.status,
    headers: response.headers,
  });
}

/** Unwraps a Code Assist SSE body frame by frame, keeping lines whole. */
function codeAssistStreamBody(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = "";
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller): void {
        pending += decoder.decode(chunk, { stream: true });
        const at = pending.lastIndexOf("\n");
        if (at < 0) {
          return;
        }
        controller.enqueue(encoder.encode(codeAssistStream(pending.slice(0, at + 1))));
        pending = pending.slice(at + 1);
      },
      flush(controller): void {
        pending += decoder.decode();
        if (pending.length > 0) {
          controller.enqueue(encoder.encode(codeAssistStream(pending)));
        }
      },
    }),
  );
}

const FAILOVER_STATUSES = new Set([401, 402, 403, 408, 409, 425, 429]);

export function shouldFailover(status: number): boolean {
  return status >= 500 || FAILOVER_STATUSES.has(status);
}

function readHeader(headers: IncomingHttpHeaders, name: string): string | null {
  const value = headers[name];
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  if (Array.isArray(value) && value.length > 0 && value[0].length > 0) {
    return value[0];
  }
  return null;
}
