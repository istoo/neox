import { once } from "node:events";
import type { Response as ExpressResponse } from "express";
import { eventsFromResponse, responseFromEvents } from "./assemble.js";
import { ChatTidy, chatWholeTidy } from "./chat-tidy.js";
import { ToolSearchTidy, toolSearchResponse } from "./toolsearch.js";
import { wholeAsStream } from "./whole-stream.js";
import { CiteStream, citeText } from "./search-cite.js";
import { claudeSignInFailure, replaceApiKey, rewriteErrorFrame } from "./claude/signin.js";
import type { ProtocolCodec, StreamEncoder } from "./codec.js";
import type { GatewayProvider } from "./config.js";
import { FenceHold, unfenceResponse } from "./format.js";
import { applyReplyHeaders } from "./header-passthrough.js";
import type { EventHookContext, HookRuntime } from "./hooks.js";
import {
  assertRecord,
  type IrEvent,
  type IrPart,
  type IrResponse,
  type IrSearchPage,
  type IrStopReason,
  type IrUsage,
} from "./ir.js";
import { LoopGuard, loopErrorEvent, loopTripMessage, type LoopTrip } from "./loop-guard.js";
import { StreamRestorer, type Masker, type RestoreCounts } from "./masking.js";
import { codecFor } from "./protocols.js";
import { Continuation, emptyRetries, prefillMode } from "./continuation.js";
import { isGrokLike, packResponseReasoning, ReasoningCarry } from "./reasoning-carry.js";
import { namedModelResponse, ReplyNamingTidy } from "./reply-naming.js";
import { titleReplyDigest } from "./title-link.js";
import { HandoverFilter, RefusalHandover, SpliceFilter } from "./refusal-handover.js";
import { ItemIdTidy, phaseWholeText, PhaseTidy } from "./responses-tidy.js";
import {
  chainFilters,
  relayedTextCalls,
  wholeRelayedTextCalls,
  type StreamFilter,
} from "./text-calls.js";
import { CrDropper, CrLineTidy, crInResponseJson, dropCR, glmFlash } from "./tool-args-cr.js";
import type { ToolUseIds } from "./tool-use-ids.js";
import type { GatewayProtocol } from "./upstream.js";

/**
 * A reply on its way to the client: relayed as it came when the protocols
 * agree, translated when they don't. Kept apart from the routing it is
 * reached through (`routes.ts`), which decides what to send and to whom.
 */
export interface DeliverInput {
  res: ExpressResponse;
  upstream: globalThis.Response;
  /** Whose reply this is: the provider whose `replyHeaders` are passed on. */
  provider: GatewayProvider;
  /** The account the reply came from; null for the provider's own key. */
  accountId?: string | null;
  upstreamProtocol: GatewayProtocol;
  clientProtocol: GatewayProtocol;
  requestedModel: string;
  /** The model the upstream was asked for, as the vendor names it. */
  servedModel: string;
  wantsStream: boolean;
  reencode: boolean;
  masker: Masker | null;
  restoreCounts?: RestoreCounts;
  /** The client asked for structured output; a fenced answer goes unfenced. */
  wantsJson: boolean;
  hooks: HookRuntime;
  /** A Messages reply's tool ids, salted where the client has seen one. */
  toolIds: ToolUseIds | null;
  /** The search the gateway ran, told to the client as its provider's own. */
  search: { query: string; pages: IrSearchPage[] } | null;
  /** The tools the request offered, by the names a written call would say. */
  offeredTools: Set<string> | null;
  /** Whether a reply stuck in a loop is left to run on. */
  noLoopGuard: boolean;
  /** The name the reply's model should say, null for the vendor's own. */
  replyName: string | null;
  /** When the client's request reached the gateway, to time the first token. */
  startedAt: number;
  /** The client signed in as Claude Code itself (`Bearer sk-ant-oat…`). */
  claudeSignIn: boolean;
  /** The request offered Responses' client-side tool_search. */
  toolSearch: boolean;
  /**
   * Asks the same request again when the reply's reasoning loops before it
   * has said anything (myna's continuation.go:62 `loopReasks`), so a client
   * reads one reply that finished instead of one cut short. Null when the
   * upstream can't be asked again or the try has already re-asked.
   */
  reask?: (continuation?: Continuation) => Promise<globalThis.Response | null>;
  /**
   * A refusal handover a previous try left open: this try's stream goes on
   * in the same reply, its blocks and items moved past the ones already
   * sent (myna's refusal_handover.go spliceAfter).
   */
  handover?: RefusalHandover;
  /** Whether this try's own refusal may go to the next candidate in this
   * same stream (myna's handsOver). */
  canHandOver?: boolean;
  /** The request is Codex's own title turn: its reply names the title Codex
   * writes, digested for the conversation it belongs to (title_link.go). */
  titleTurn?: boolean;
}

export interface DeliverOutcome {
  usage: IrUsage | null;
  /** Milliseconds to the first streamed token; null when none was timed. */
  ttftMs: number | null;
  /** Set when this try's refusal was handed to the next candidate: nothing
   * more is written to the reply, and the next try continues it. */
  handedOver?: RefusalHandover;
  /** Why the reply ended, as the usage report keeps it (myna's Stop). */
  stopReason?: IrStopReason;
  /** The tier the vendor served on, when it said (myna's TierServed). */
  tierServed?: string;
  /** The credits the vendor billed, when it said (myna's Credits). */
  credits?: number;
}

/** A parsed reply's values as the attempt's record keeps them. */
function outcomeOf(response: IrResponse, ttftMs: number | null = null): DeliverOutcome {
  return {
    usage: response.usage,
    ttftMs,
    stopReason: response.stopReason,
    ...(response.tierServed === undefined ? {} : { tierServed: response.tierServed }),
    ...(response.usage.credits === undefined ? {} : { credits: response.usage.credits }),
  };
}

/** A whole reply's tool arguments without GLM's stitched CR. */
function crResponse<T extends { parts: IrPart[] }>(response: T): T {
  if (!response.parts.some((part) => part.type === "tool_call")) {
    return response;
  }
  return {
    ...response,
    parts: response.parts.map((part) =>
      part.type === "tool_call" ? { ...part, arguments: dropCR(part.arguments) } : part,
    ),
  };
}

/** Whether this reply's reasoning must ride in the calls' ids. */
function carriesReasoning(input: DeliverInput): boolean {
  return (
    input.upstreamProtocol === "openai-responses" &&
    input.clientProtocol !== "openai-responses" &&
    isGrokLike(input.provider)
  );
}

/** Whether a client's protocol has a block for a search the gateway ran. */
function hearsSearch(protocol: GatewayProtocol): boolean {
  return protocol === "anthropic" || protocol === "openai-responses";
}

/** The pages a reply's claims cite, for an Anthropic client (myna's search_cite.go). */
function citePagesOf(input: DeliverInput): IrSearchPage[] | null {
  return input.clientProtocol === "anthropic" && input.search !== null ? input.search.pages : null;
}

/** A whole reply's text cut into the lines that cite a page. */
function withCitations<T extends { parts: IrPart[] }>(input: DeliverInput, response: T): T {
  const pages = citePagesOf(input);
  if (pages === null) {
    return response;
  }
  const parts = response.parts.flatMap((part): IrPart[] => {
    if (part.type !== "text") {
      return [part];
    }
    return citeText(part.text, pages).map((line) =>
      line.citations === undefined
        ? { type: "text" as const, text: line.text }
        : { type: "text" as const, text: line.text, citations: line.citations },
    );
  });
  return { ...response, parts };
}

/** A whole reply with the search that came before it. */
function withSearchPart<T extends { parts: IrPart[] }>(input: DeliverInput, response: T): T {
  if (input.search === null || !hearsSearch(input.clientProtocol)) {
    return response;
  }
  return {
    ...response,
    parts: [
      { type: "search", query: input.search.query, pages: input.search.pages },
      ...response.parts,
    ],
  };
}

/**
 * An upstream error as a Claude Code sign-in is told it: a 401 (or a 403
 * saying the token was revoked) becomes the 502 that names whose credential
 * was refused, and any other error's `x-api-key` is said as "API key"
 * (myna's claude_signin.go).
 */
async function deliverClaudeSignInError(input: DeliverInput): Promise<DeliverOutcome> {
  const text = await input.upstream.text().catch(() => "");
  const failure = claudeSignInFailure({
    status: input.upstream.status,
    body: text,
    provider: input.provider.id,
  });
  if (failure !== null) {
    input.res.status(failure.status);
    input.res.setHeader("content-type", "application/json");
    input.res.send(failure.body);
    return { usage: null, ttftMs: null };
  }
  input.res.status(input.upstream.status);
  input.res.setHeader(
    "content-type",
    input.upstream.headers.get("content-type") ?? "application/json",
  );
  input.res.send(replaceApiKey(text));
  return { usage: null, ttftMs: null };
}

/** Rewrites a Claude sign-in's error frames as they are relayed. */
class ClaudeSignInTidy implements StreamFilter {
  private buffer = "";

  public write(piece: string): string {
    this.buffer += piece;
    const at = this.buffer.lastIndexOf("\n\n");
    if (at < 0) {
      return "";
    }
    const whole = this.buffer.slice(0, at + 2);
    this.buffer = this.buffer.slice(at + 2);
    return this.frames(whole);
  }

  public flush(): string {
    const rest = this.buffer;
    this.buffer = "";
    return this.frames(rest);
  }

  private frames(text: string): string {
    if (!text.toLowerCase().includes("x-api-key")) {
      return text;
    }
    return text
      .split(/(?<=\n\n)/)
      .map((frame) => rewriteErrorFrame(frame))
      .join("");
  }
}

/** The provider and member that answered, as myna's member.go names them. */
function noteMember(res: ExpressResponse, input: DeliverInput): void {
  const member = `${input.provider.id}/${input.servedModel}`;
  // Neolix's own names, and myna's for clients that read them (ccusage and
  // myna's agents count by X-Magpie-Provider/-Model).
  for (const [providerName, modelName] of [
    ["X-Neolix-Provider", "X-Neolix-Model"],
    ["X-Magpie-Provider", "X-Magpie-Model"],
  ] as const) {
    res.setHeader(providerName, input.provider.id);
    res.setHeader(modelName, member);
  }
}

/** Journals what the client has of the reply, for a continuation. */
function feedContinuation(cont: Continuation, event: IrEvent): void {
  if (event.type === "text_delta") {
    cont.feed("text", event.text);
    return;
  }
  if (event.type === "thinking_delta") {
    cont.feed("think", event.text);
    return;
  }
  if (event.type === "tool_call_start" || event.type === "tool_args_delta") {
    cont.feed("tool_start");
    return;
  }
  cont.feed("other");
}

/** The host a provider's base URL names, "" when it names none. */
function hostOfUrl(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return "";
  }
}

/** Whether the reply was handed to the next candidate. Kept as a call: the
 * filters change the field while TypeScript narrows it. */
function handedOver(handover: RefusalHandover | null | undefined): boolean {
  return handover?.handed === true;
}

/**
 * The handover this try's stream is written through, its filters put in
 * front of the others: one a previous try left open, or a new one when its
 * own refusal may go to the next (myna's refusal_handover.go).
 */
function handoverFor(input: DeliverInput, filters: StreamFilter[]): RefusalHandover | null {
  const handover =
    input.handover ??
    (input.canHandOver === true
      ? new RefusalHandover(input.clientProtocol, { canHandOver: true })
      : null);
  if (handover === null) {
    return null;
  }
  if (input.handover !== undefined) {
    // This try continues a handed-over reply; its own refusal may go on to
    // the try after it.
    handover.handed = false;
    handover.handOver = null;
    filters.push(new SpliceFilter(handover));
  }
  if (input.canHandOver === true) {
    filters.push(new HandoverFilter(handover));
  }
  return handover;
}

/**
 * A reply relayed in its vendor's own shape, its frames tidied on the way.
 * The try's own refusal may hand the rest of the reply to the next
 * candidate, whose stream continues it in the same response
 * (myna's refusal_handover.go).
 */
async function deliverRelayedStream(
  input: DeliverInput,
  isEventStream: boolean,
): Promise<DeliverOutcome> {
  // A call written into the reply's text becomes a real one, then GLM's
  // flash replicas' stitched CR goes (myna's textcalls, then crTidy).
  const filters: StreamFilter[] = [];
  // A refusal after this try's reasoning, with nothing of an answer yet,
  // goes to the next candidate, whose stream continues this reply
  // (myna's refusal_handover.go). The filters read the upstream's own
  // frames, so they go before every other one.
  const handover = handoverFor(input, filters);
  if (input.claudeSignIn) {
    // A Claude sign-in's error frames never name the key it sent
    // (myna's claude_signin.go).
    filters.push(new ClaudeSignInTidy());
  }
  if (input.upstreamProtocol === "openai" && isEventStream) {
    // Chat's shapes are mended before anything reads them (myna's
    // chatTidy, chattidy.go:93; gateway.go:6331 puts it first).
    filters.push(new ChatTidy());
  }
  const calls = relayedTextCalls(input.upstreamProtocol, input.offeredTools, isEventStream);
  if (calls !== null) {
    filters.push(calls);
  }
  if (glmFlash(input.servedModel)) {
    filters.push(new CrLineTidy(input.upstreamProtocol));
  }
  if (input.upstreamProtocol === "openai-responses") {
    // A call the upstream made of tool_search goes back as the
    // tool_search_call the client knows (myna's toolsearch.go).
    if (input.toolSearch) {
      filters.push(new ToolSearchTidy());
    }
    // An item keeps its added's id and a message says its phase
    // (myna's idTidy and phaseTidy).
    filters.push(new ItemIdTidy(), new PhaseTidy(true));
  }
  // What the reply's model says (myna's memberWriter, outermost).
  filters.push(new ReplyNamingTidy(input.replyName, input.upstreamProtocol));
  await pipeUpstream(
    input.res,
    input.upstream,
    chainFilters(filters) ?? undefined,
    input.toolIds,
    input.noLoopGuard
      ? undefined
      : {
          guard: new LoopGuard(),
          protocol: input.upstreamProtocol,
        },
    handover ?? undefined,
    input.handover !== undefined || input.res.headersSent,
  );
  return {
    usage: null,
    ttftMs: null,
    ...(handover !== null && handedOver(handover) ? { handedOver: handover } : {}),
  };
}

/**
 * The vendor's reply headers and member note, for the try the agent is
 * given. A reply a refused try began has them sent already: only what
 * follows is written (myna's spliceAfter wraps the writer).
 */
function noteDeliveredReply(input: DeliverInput): void {
  if (input.handover !== undefined || input.res.headersSent) {
    return;
  }
  applyReplyHeaders(input.res, input.provider, input.upstream);
  // Which provider and member answered this reply (myna's member.go), so an
  // agent counting usage doesn't put every provider's same-named model in
  // one bucket.
  noteMember(input.res, input);
}

export async function deliver(input: DeliverInput): Promise<DeliverOutcome> {
  noteDeliveredReply(input);
  if (!input.upstream.ok && input.claudeSignIn) {
    return deliverClaudeSignInError(input);
  }
  const isEventStream = (input.upstream.headers.get("content-type") ?? "").includes(
    "text/event-stream",
  );
  // A client that asked for a stream must not receive JSON, and the reverse.
  const shapeMismatch = input.wantsStream !== isEventStream;
  // A client that asked for a stream and an upstream that gave the reply
  // whole: the vendor's own body is streamed in its own shape, keeping the
  // fields translation would drop (myna's whole_stream.go).
  if (!input.reencode && input.wantsStream && !isEventStream) {
    return deliverWholeAsStream(input);
  }
  if (!input.reencode && !shapeMismatch && !input.wantsJson) {
    if (input.wantsStream) {
      return deliverRelayedStream(input, isEventStream);
    }
    return deliverPassthroughJson(input);
  }
  return pipeTranslated(input);
}

/**
 * A whole reply written as the vendor's own stream (myna's
 * whole_stream.go). Gemini has no such shape and falls back to translation.
 */
async function deliverWholeAsStream(input: DeliverInput): Promise<DeliverOutcome> {
  const text = await input.upstream.text();
  const stream = wholeAsStream(input.upstreamProtocol, text);
  if (stream === null) {
    // The body was read: put it back for the translated path.
    const rebuilt = new Response(text, {
      status: input.upstream.status,
      headers: input.upstream.headers,
    });
    return pipeTranslated({ ...input, upstream: rebuilt });
  }
  noteReplyText(input.res, stream);
  if (!input.res.headersSent) {
    input.res.status(input.upstream.status);
    input.res.setHeader("content-type", "text/event-stream");
    input.res.setHeader("cache-control", "no-cache");
  }
  input.res.end(stream);
  try {
    return outcomeOf(
      codecFor(input.upstreamProtocol).parseResponse(assertRecord(JSON.parse(text), "whole reply")),
    );
  } catch {
    return { usage: null, ttftMs: null };
  }
}

/** Keeps the title a title turn wrote, for the conversation it belongs to
 * (myna's title_link.go, titleReplyDigest). */
function noteTitleReply(input: DeliverInput, payloadText: string): void {
  if (input.titleTurn !== true) {
    return;
  }
  (input.res.locals as Record<string, unknown>).titleReplyDigest = titleReplyDigest(payloadText);
}

/** Same-protocol JSON: forwarded byte for byte, after reading its usage. */
async function deliverPassthroughJson(input: DeliverInput): Promise<DeliverOutcome> {
  let text = await input.upstream.text();
  // A call written into a reply that came whole becomes a real one (myna's
  // anthropicTextCalls.whole and its Responses and Gemini counterparts).
  const whole = wholeRelayedTextCalls(input.upstreamProtocol, input.offeredTools, text);
  if (whole !== null) {
    text = whole;
  }
  if (input.upstreamProtocol === "openai") {
    // A whole Chat reply is mended after its text calls are read out of it
    // (myna's chatWhole runs after textcalls, gateway.go:6517).
    text = chatWholeTidy(text, input.offeredTools);
  }
  if (input.upstreamProtocol === "openai-responses" && input.toolSearch) {
    // The function call the upstream made of tool_search goes back as the
    // tool_search_call the client knows (myna's toolsearch.go).
    try {
      const parsed: unknown = JSON.parse(text);
      if (isRecord(parsed)) {
        text = JSON.stringify(toolSearchResponse(parsed).body);
      }
    } catch {
      // Not JSON: forwarded as it came.
    }
  }
  if (input.upstreamProtocol === "openai-responses") {
    text = phaseWholeText(text) ?? text;
  }
  let payloadText = text;
  let response: IrResponse | null = null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed)) {
      // GLM's flash replicas stitch a call's arguments with CR, on the
      // relayed reply too (myna's crTidy).
      const fixed = glmFlash(input.servedModel) ? crInResponseJson(parsed) : parsed;
      if (!isRecord(fixed)) {
        throw new Error("restored reply must be an object");
      }
      const salted = input.toolIds === null ? fixed : input.toolIds.json(fixed);
      if (typeof salted.id === "string" && salted.id !== "") {
        input.res.locals.responseId = salted.id;
      }
      response = codecFor(input.upstreamProtocol).parseResponse(salted);
      // What the reply's model says: the name asked for when it went out
      // under another, the member's id, or the vendor's text (myna's
      // memberWriter).
      const named = namedModelResponse(salted, input.replyName, input.upstreamProtocol);
      const hooked = input.hooks.runResponse({ body: named, status: input.upstream.status });
      if (hooked !== null) {
        payloadText = JSON.stringify(hooked);
      } else if (named !== parsed) {
        payloadText = JSON.stringify(named);
      }
    }
  } catch {
    // Not JSON. Forward it unchanged.
  }
  noteReplyText(input.res, payloadText);
  noteTitleReply(input, payloadText);
  input.res.status(input.upstream.status);
  input.res.setHeader(
    "content-type",
    input.upstream.headers.get("content-type") ?? "application/json",
  );
  input.res.send(payloadText);
  return response === null ? { usage: null, ttftMs: null } : outcomeOf(response);
}

async function pipeTranslated(input: DeliverInput): Promise<DeliverOutcome> {
  if (!input.upstream.ok) {
    await pipeUpstream(input.res, input.upstream);
    return { usage: null, ttftMs: null };
  }

  const upstreamCodec = codecFor(input.upstreamProtocol);
  const clientCodec = codecFor(input.clientProtocol);
  const isStream = (input.upstream.headers.get("content-type") ?? "").includes("text/event-stream");

  if (isStream && !input.wantsStream) {
    return deliverCollectedStream(input, upstreamCodec, clientCodec);
  }
  if (!isStream) {
    return deliverJson(input, upstreamCodec, clientCodec);
  }
  return deliverEventStream(input, upstreamCodec, clientCodec);
}

async function deliverCollectedStream(
  input: DeliverInput,
  upstreamCodec: ProtocolCodec,
  clientCodec: ProtocolCodec,
): Promise<DeliverOutcome> {
  const events: IrEvent[] = [];
  for (const event of await readStreamEvents(input.upstream, upstreamCodec)) {
    const hooked = await input.hooks.runEvent(event, eventHookContext(input));
    if (hooked !== null) events.push(hooked);
  }
  const collected = responseFromEvents(events);
  const crFixed = glmFlash(input.servedModel) ? crResponse(collected) : collected;
  const reasoned = carriesReasoning(input) ? packResponseReasoning(crFixed) : crFixed;
  const searched = withCitations(input, withSearchPart(input, reasoned));
  const salted = input.toolIds === null ? searched : input.toolIds.response(searched);
  const response = input.wantsJson ? unfenceResponse(salted) : salted;
  if (response.id !== null) {
    input.res.locals.responseId = response.id;
  }
  const built = clientCodec.buildResponseBody(response, input.replyName ?? input.servedModel);
  const body = input.hooks.runResponse({ body: built, status: 200 }) ?? built;
  const masker = input.masker;
  const payload =
    masker === null
      ? body
      : assertRecord(masker.restoreValue(body, input.restoreCounts), "restored response");
  noteReplyText(input.res, JSON.stringify(payload));
  input.res.json(payload);
  return outcomeOf(response);
}

async function deliverJson(
  input: DeliverInput,
  upstreamCodec: ProtocolCodec,
  clientCodec: ProtocolCodec,
): Promise<DeliverOutcome> {
  const payload: unknown = await input.upstream.json();
  const restored =
    input.masker === null ? payload : input.masker.restoreValue(payload, input.restoreCounts);
  const parsed = upstreamCodec.parseResponse(assertRecord(restored, "upstream response"));
  const crFixed = glmFlash(input.servedModel) ? crResponse(parsed) : parsed;
  const reasoned = carriesReasoning(input) ? packResponseReasoning(crFixed) : crFixed;
  const searched = withCitations(input, withSearchPart(input, reasoned));
  const salted = input.toolIds === null ? searched : input.toolIds.response(searched);
  const response = input.wantsJson ? unfenceResponse(salted) : salted;
  if (response.id !== null) {
    input.res.locals.responseId = response.id;
  }

  if (!input.wantsStream) {
    const built = clientCodec.buildResponseBody(response, input.replyName ?? input.servedModel);
    const body = input.hooks.runResponse({ body: built, status: 200 }) ?? built;
    noteReplyText(input.res, JSON.stringify(body));
    if (input.titleTurn === true) {
      (input.res.locals as Record<string, unknown>).titleReplyDigest = titleReplyDigest(
        JSON.stringify(body),
      );
    }
    input.res.status(200).json(body);
    return outcomeOf(response);
  }

  const encoder = clientCodec.createStreamEncoder(input.replyName ?? input.servedModel);
  startEventStream(input.res);
  await writeText(input.res, encoder.start());
  for (const event of eventsFromResponse(response)) {
    const hooked = await input.hooks.runEvent(event, eventHookContext(input));
    if (hooked !== null) {
      await writeText(input.res, encoder.push(hooked));
    }
  }
  await writeText(input.res, encoder.end());
  input.res.end();
  return outcomeOf(response);
}

// debt: masking, fences, the loop guard, citations, refusal handover and the
// continuation all meet here; split it by stage when the next stream fault
// lands in this function.
// eslint-disable-next-line complexity
async function deliverEventStream(
  input: DeliverInput,
  upstreamCodec: ProtocolCodec,
  clientCodec: ProtocolCodec,
): Promise<DeliverOutcome> {
  const masker = input.masker;
  const textRestorer =
    masker === null ? null : masker.createRestorer({ counts: input.restoreCounts });
  const thinkingRestorer =
    masker === null ? null : masker.createRestorer({ counts: input.restoreCounts });
  // A tool call's arguments are JSON text, so a value goes back escaped. The
  // restorer per call id keeps a stand-in split across deltas whole.
  const argRestorers = new Map<string, StreamRestorer>();
  const toolRestorer = (id: string): StreamRestorer | null => {
    if (masker === null) {
      return null;
    }
    const existing = argRestorers.get(id);
    if (existing !== undefined) {
      return existing;
    }
    const created = masker.createRestorer({ escaped: true, counts: input.restoreCounts });
    argRestorers.set(id, created);
    return created;
  };
  const encoder = clientCodec.createStreamEncoder(input.replyName ?? input.servedModel);
  let decoder = upstreamCodec.createStreamDecoder();
  // A reply the upstream cuts off goes on from what the client has, where
  // the upstream can be prefilled (myna's continuation.go).
  const cont = new Continuation(
    prefillMode(input.upstreamProtocol, hostOfUrl(input.provider.baseUrl), input.servedModel),
  );
  // GLM's flash replicas stitch streamed arguments with CR; its calls are
  // read without them (myna's tool_args_cr.go).
  const crDrop = glmFlash(input.servedModel) ? new CrDropper() : null;
  let lastToolId: string | null = null;
  const fence = input.wantsJson ? new FenceHold() : null;
  startEventStream(input.res);
  await writeText(input.res, encoder.start());
  // The search the gateway ran comes before the answer, as the provider's
  // own search would (myna's searchReply).
  if (input.search !== null && hearsSearch(input.clientProtocol)) {
    await writeText(
      input.res,
      encoder.push({ type: "search", query: input.search.query, pages: input.search.pages }),
    );
  }

  let usage: IrUsage | null = null;
  // Why the upstream said the reply ended, for the usage report.
  let stopReason: IrStopReason | null = null;
  let stopped = false;
  // The reply was cut here (a loop, or the loop guard ended it): nothing
  // more goes to the client, and its response was ended already.
  let cut = false;
  // Whether the reply has said anything yet: a loop of its reasoning alone
  // is asked again in place, one after it spoke is ended (myna's
  // continuation.go:62, `loopReasks`).
  let spoke = false;
  // A reply stuck in a loop is ended here too, as on the relayed path: the
  // bytes the client reads are what the guard reads (myna's holdWriter).
  let loopGuard = input.noLoopGuard ? null : new LoopGuard();
  let tripped: LoopTrip | null = null;
  // The upstream died mid-stream: the reply may go on with another ask.
  let broken = false;
  // A retry's own start is dropped: the client's reply began with the first.
  let restarted = false;
  /** What the error must follow: a newline when the last chunk ended one. */
  let tripGap = "\n\n";
  const carry = carriesReasoning(input) ? new ReasoningCarry() : null;
  const say = async (text: string): Promise<void> => {
    if (cut || tripped !== null) {
      return;
    }
    if (loopGuard !== null) {
      const trip = loopGuard.feed(text);
      if (trip !== null) {
        await writeText(input.res, text);
        tripped = trip;
        tripGap = text.endsWith("\n") ? "\n" : "\n\n";
        return;
      }
    }
    await writeText(input.res, text);
  };
  // An Anthropic client is told which found page each line cites (myna's
  // search_cite.go); other protocols hear no citations.
  const citePages = citePagesOf(input);
  const cite = citePages === null ? null : new CiteStream(citePages);
  const emitOut = async (event: IrEvent): Promise<void> => {
    if (cite === null) {
      await say(encoder.push(event));
      return;
    }
    if (event.type === "stop") {
      for (const piece of cite.flush()) {
        await say(encoder.push(piece));
      }
    }
    for (const piece of cite.push(event)) {
      await say(encoder.push(piece));
    }
  };
  /** When the first content reached the client, for the usage report's TTFT. */
  let firstTokenAt: number | null = null;

  const flushRestorers = async (): Promise<void> => {
    if (textRestorer !== null) {
      const text = textRestorer.flush();
      if (text.length > 0) {
        await emitOut({ type: "text_delta", text });
      }
    }
    if (thinkingRestorer !== null) {
      const text = thinkingRestorer.flush();
      if (text.length > 0) {
        await say(encoder.push({ type: "thinking_delta", text }));
      }
    }
    for (const [id, restorer] of argRestorers) {
      const args = restorer.flush();
      if (args.length > 0) {
        await say(encoder.push({ type: "tool_args_delta", id, args }));
      }
    }
    argRestorers.clear();
  };

  // debt: one event's way to the client holds masking, fences, timing and
  // the CR cure; split it by stage when the next stream fault lands here.
  // eslint-disable-next-line complexity
  const emit = async (raw: IrEvent): Promise<void> => {
    const carried = carry === null ? raw : carry.event(raw);
    let source = input.toolIds === null ? carried : input.toolIds.event(carried);
    if (crDrop !== null) {
      if (source.type === "tool_args_delta") {
        const args = crDrop.write(source.args);
        if (args.length === 0) {
          return;
        }
        source = { ...source, args };
      } else if (source.type === "tool_call_start") {
        lastToolId = source.id;
      } else if (source.type === "stop") {
        const tail = crDrop.flush();
        if (tail.length > 0 && lastToolId !== null) {
          await writeText(
            input.res,
            encoder.push({ type: "tool_args_delta", id: lastToolId, args: tail }),
          );
        }
      }
    }
    const source_ = source;
    const hooked = await input.hooks.runEvent(source_, eventHookContext(input));
    if (hooked === null) {
      return;
    }
    const event = hooked;
    if (event.type === "usage") {
      usage = event.usage;
    }
    if (event.type === "stop") {
      await flushRestorers();
      stopped = true;
      stopReason = event.reason;
    }
    let restored = restoreEvent(event, textRestorer, thinkingRestorer, toolRestorer);
    if ((cont.resume || restarted) && restored.type === "start") {
      // The continuation's own reply has begun: the client's started with
      // the first try's (myna splices without a second start).
      return;
    }
    if (restored.type === "text_delta" && cont.resume) {
      // A continuation echoes what it was prefilled with: the client has
      // that already (myna's Continuation.unecho).
      const text = cont.unecho(restored.text);
      if (text === "") {
        return;
      }
      restored = { ...restored, text };
    }
    if (
      (restored.type === "text_delta" || restored.type === "thinking_delta") &&
      restored.text.length === 0
    ) {
      return;
    }
    if (restored.type === "tool_args_delta" && restored.args.length === 0) {
      return;
    }
    if (fence !== null && restored.type === "text_delta") {
      const text = fence.push(restored.text);
      if (text.length === 0) {
        return;
      }
      spoke = true;
      if (firstTokenAt === null) {
        firstTokenAt = Date.now();
      }
      await emitOut({ type: "text_delta", text });
      return;
    }
    if (fence !== null && restored.type !== "usage" && restored.type !== "thinking_delta") {
      const held = fence.flush();
      if (held.length > 0) {
        spoke = true;
        await emitOut({ type: "text_delta", text: held });
      }
    }
    if (
      restored.type !== "usage" &&
      restored.type !== "thinking_delta" &&
      restored.type !== "stop" &&
      restored.type !== "start"
    ) {
      // Text or a call: the reply has said something (a stop alone hasn't).
      spoke = true;
    }
    if (firstTokenAt === null) {
      firstTokenAt = Date.now();
    }
    feedContinuation(cont, restored);
    await emitOut(restored);
  };

  const pump = async (from: globalThis.Response): Promise<void> => {
    try {
      await pumpUpstreamEvents(from, decoder, emit, input.res, () => tripped !== null);
      // A reply whose stream ended without saying it did was cut off, as a
      // disconnect was (myna's replyEnded).
      if (!stopped && tripped === null) {
        broken = true;
      }
    } catch {
      // The upstream died mid-stream: the reply may go on with another ask
      // (myna's continuation.go), and the terminal event is written after
      // the last ask when it can't.
      broken = true;
    }
  };
  // A loop of the reasoning alone, before the reply said anything, is asked
  // again in place once (myna's continuation.go:62); after speech, or a
  // second loop, it is ended as it was.
  const resume = async (): Promise<void> => {
    if (tripped === null || spoke || input.reask === undefined) {
      return;
    }
    const again = await input.reask();
    if (again === null) {
      return;
    }
    tripped = null;
    loopGuard = input.noLoopGuard ? null : new LoopGuard();
    decoder = upstreamCodec.createStreamDecoder();
    await pump(again);
  };
  await pump(input.upstream);
  await resume();
  // A translated reply cut off before its end is asked again with the text
  // so far prefilled, and the reply goes on in the same stream.
  let tries = 0;
  while (broken && input.reask !== undefined && cont.again(200, "", tries, input.res.destroyed)) {
    if (stopped) {
      break;
    }
    const next = await input.reask(cont);
    if (next === null) {
      break;
    }
    broken = false;
    tries += 1;
    decoder = upstreamCodec.createStreamDecoder();
    await pump(next);
  }
  if (broken && !stopped) {
    // Nothing could go on: the agent still has an end, not a stream that
    // never finished.
    await emit({ type: "stop", reason: "end_turn" });
  }
  // A reply that ended having said nothing is asked again in its place
  // (myna's continuation.go emptyRetries).
  let empties = emptyRetries({
    mayAskAgain: input.reask !== undefined,
    inGroup: false,
    thoughtOnly: cont.thinkText() !== "",
  });
  while (stopped && empties > 0 && input.reask !== undefined) {
    if (spoke) {
      break;
    }
    const next = await input.reask();
    if (next === null) {
      break;
    }
    stopped = false;
    restarted = true;
    empties -= 1;
    decoder = upstreamCodec.createStreamDecoder();
    await pump(next);
  }

  if (tripped !== null) {
    // The reply loops: it ends with the error the agent can act on.
    await writeText(
      input.res,
      tripGap + loopErrorEvent(input.clientProtocol, loopTripMessage(tripped)),
    );
    input.res.end();
    stopped = true;
    cut = true;
  }
  if (!stopped) {
    await flushRestorers();
  }
  if (fence !== null && !cut) {
    const held = fence.flush();
    if (held.length > 0) {
      await emitOut({ type: "text_delta", text: held });
    }
  }
  if (!cut) {
    keepReplyId(input.res, encoder);
    await writeText(input.res, encoder.end());
    input.res.end();
  }
  const credits = (usage as IrUsage | null)?.credits;
  return {
    usage: usage as IrUsage | null,
    ttftMs: firstTokenAt === null ? null : firstTokenAt - input.startedAt,
    ...(stopReason === null ? {} : { stopReason }),
    ...(credits === undefined ? {} : { credits }),
  };
}

async function pumpUpstreamEvents(
  upstream: globalThis.Response,
  decoder: ReturnType<ProtocolCodec["createStreamDecoder"]>,
  emit: (event: IrEvent) => Promise<void>,
  res: ExpressResponse,
  stop?: () => boolean,
): Promise<void> {
  const reader = upstream.body?.getReader();
  if (reader === undefined) {
    return;
  }
  res.on("close", () => {
    void reader.cancel().catch(() => {});
  });
  const textDecoder = new TextDecoder();
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      for (const event of decoder.push(textDecoder.decode(chunk.value, { stream: true }))) {
        await emit(event);
        if (stop?.() === true) {
          void reader.cancel().catch(() => {});
          return;
        }
      }
    }
    for (const event of decoder.flush()) {
      await emit(event);
      if (stop?.() === true) {
        return;
      }
    }
  } catch (error) {
    // Mark the reader's failure as handled: the caller degrades to a terminal
    // event, and an unhandled rejection here would crash the daemon.
    void reader.closed.catch(() => {});
    throw error;
  }
}

function restoreEvent(
  event: IrEvent,
  textRestorer: StreamRestorer | null,
  thinkingRestorer: StreamRestorer | null,
  toolRestorer: (id: string) => StreamRestorer | null,
): IrEvent {
  if (event.type === "text_delta" && textRestorer !== null) {
    return { type: "text_delta", text: textRestorer.push(event.text) };
  }
  if (event.type === "thinking_delta" && thinkingRestorer !== null) {
    return { type: "thinking_delta", text: thinkingRestorer.push(event.text) };
  }
  if (event.type === "tool_args_delta") {
    const restorer = toolRestorer(event.id);
    if (restorer !== null) {
      return { type: "tool_args_delta", id: event.id, args: restorer.push(event.args) };
    }
  }
  return event;
}

export function startEventStream(res: ExpressResponse): void {
  // A pause before this try may have opened the reply already, to keep the
  // agent's stream alive (myna's keepAlive).
  if (res.headersSent) {
    return;
  }
  res.status(200);
  res.setHeader("content-type", "text/event-stream");
  res.setHeader("cache-control", "no-cache");
}

/** Keeps the id the encoder named the streamed reply with. */
function keepReplyId(res: ExpressResponse, encoder: StreamEncoder): void {
  const id = encoder.replyId?.();
  if (id !== undefined && id !== "") {
    res.locals.responseId = id;
  }
}

/** As much of a reply as a trace body keeps (the masker cuts it again). */
const REPLY_TEXT_LIMIT = 256 * 1024;

/**
 * Keeps the reply the client receives for the request's OTel span, only
 * when the gateway was set to keep bodies (`res.locals.otelBodies`). A
 * stream's text is what the client reads, so it is appended as it goes.
 */
function noteReplyText(res: ExpressResponse, text: string): void {
  const locals = res.locals as Record<string, unknown>;
  if (locals.otelBodies !== true) {
    return;
  }
  const kept = typeof locals.replyText === "string" ? locals.replyText : "";
  if (kept.length >= REPLY_TEXT_LIMIT) {
    return;
  }
  locals.replyText = kept + text.slice(0, REPLY_TEXT_LIMIT - kept.length);
}

async function readStreamEvents(
  upstream: globalThis.Response,
  codec: ProtocolCodec,
): Promise<IrEvent[]> {
  const decoder = codec.createStreamDecoder();
  const events: IrEvent[] = [];
  if (!upstream.body) {
    return events;
  }
  const reader = upstream.body.getReader();
  const textDecoder = new TextDecoder();
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) {
      break;
    }
    events.push(...decoder.push(textDecoder.decode(chunk.value, { stream: true })));
  }
  events.push(...decoder.flush());
  return events;
}

async function writeText(res: ExpressResponse, text: string): Promise<void> {
  if (text.length === 0 || res.writableEnded || res.destroyed) {
    return;
  }
  noteReplyText(res, text);
  if (!res.write(text)) {
    // A client that disconnects mid-stream never drains; race the close.
    await Promise.race([once(res, "drain"), once(res, "close")]);
  }
}

/**
 * The reply's status and headers, written unless another try began it: a
 * handed-over reply has them sent, or opens with this try's stream when the
 * refused one wrote no frame at all.
 */
function setReplyHeaders(
  res: ExpressResponse,
  upstream: globalThis.Response,
  splicing: boolean,
): void {
  if (!splicing) {
    res.status(upstream.status);
    const contentType = upstream.headers.get("content-type");
    if (contentType !== null) {
      res.setHeader("content-type", contentType);
    }
    const requestId = upstream.headers.get("request-id");
    if (requestId !== null) {
      res.setHeader("request-id", requestId);
    }
    return;
  }
  if (!res.headersSent) {
    res.status(200);
    res.setHeader("content-type", "text/event-stream");
    res.setHeader("cache-control", "no-cache");
  }
}

export async function pipeUpstream(
  res: ExpressResponse,
  upstream: globalThis.Response,
  cure?: StreamFilter,
  toolIds?: ToolUseIds | null,
  loop?: { guard: LoopGuard; protocol: GatewayProtocol },
  handover?: RefusalHandover,
  /** The reply's headers are sent already: another try began it. */
  splicing?: boolean,
): Promise<void> {
  setReplyHeaders(res, upstream, splicing === true);

  if (!upstream.body) {
    res.end();
    return;
  }

  const reader = upstream.body.getReader();
  const decoder = cure || toolIds || loop !== undefined ? new TextDecoder() : null;
  // A raw relayed reply is decoded only to be kept for the trace, if at all.
  const traceDecoder = traceDecoderOf(res, decoder);
  res.on("close", () => {
    void reader.cancel().catch(() => {});
  });
  const send = async (payload: Uint8Array): Promise<void> => {
    if (payload.length === 0) {
      return;
    }
    if (!res.write(Buffer.from(payload))) {
      await Promise.race([once(res, "drain"), once(res, "close")]);
    }
  };
  /** What a relayed chunk looks like once cured and its call ids salted. */
  const through = (text: string): Uint8Array =>
    toolIds ? toolIds.write(Buffer.from(text, "utf8")) : Buffer.from(text, "utf8");
  try {
    for (;;) {
      if (handedOver(handover)) {
        // The refusal went to the next candidate: this reply is theirs now.
        void reader.cancel().catch(() => {});
        return;
      }
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      if (decoder === null) {
        noteRawReply(res, traceDecoder, chunk.value);
        await send(chunk.value);
        continue;
      }
      // GLM's flash replicas stitch a call's arguments with CR on the
      // relayed stream too; a line is cured once its newline arrives.
      let text = decoder.decode(chunk.value, { stream: true });
      noteReplyText(res, text);
      if (cure) {
        text = cure.write(text);
      }
      if (loop !== undefined) {
        // A reply stuck in a loop is ended rather than let run to its limit
        // (myna's loopGuard).
        const trip = loop.guard.feed(text);
        if (trip !== null) {
          await send(through(text));
          const gap = text.endsWith("\n") ? "\n" : "\n\n";
          await send(
            Buffer.from(gap + loopErrorEvent(loop.protocol, loopTripMessage(trip)), "utf8"),
          );
          void reader.cancel().catch(() => {});
          res.end();
          return;
        }
      }
      await send(through(text));
    }
    if (decoder !== null) {
      let rest = decoder.decode();
      if (cure) {
        rest = cure.write(rest);
      }
      await send(through(rest));
      if (cure) {
        await send(Buffer.from(cure.flush(), "utf8"));
      }
      if (toolIds) {
        await send(toolIds.flush());
      }
    }
  } catch (error) {
    void reader.closed.catch(() => {});
    if (!handedOver(handover)) {
      throw error;
    }
  }
  if (!handedOver(handover)) {
    res.end();
  }
}

/** Decodes a raw relayed chunk only when the trace keeps the reply. */
function traceDecoderOf(res: ExpressResponse, relayed: TextDecoder | null): TextDecoder | null {
  return relayed === null && (res.locals as Record<string, unknown>).otelBodies === true
    ? new TextDecoder()
    : null;
}

function noteRawReply(res: ExpressResponse, decoder: TextDecoder | null, value: Uint8Array): void {
  if (decoder !== null) {
    noteReplyText(res, decoder.decode(value, { stream: true }));
  }
}

/**
 * An image's answer is a JSON body the size of its pictures; it is read
 * whole so stand-ins in the revised prompt go back, then sent at once.
 */
export async function pipeRestored(
  res: ExpressResponse,
  upstream: globalThis.Response,
  masker: Masker,
  counts: RestoreCounts,
): Promise<void> {
  const text = await upstream.text();
  let body = text;
  try {
    body = JSON.stringify(masker.restoreValue(JSON.parse(text), counts));
  } catch {
    body = masker.restoreText(text, counts);
  }
  res.status(upstream.status);
  res.setHeader("content-type", upstream.headers.get("content-type") ?? "application/json");
  const requestId = upstream.headers.get("request-id");
  if (requestId !== null) {
    res.setHeader("request-id", requestId);
  }
  res.send(body);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** What an event hook is told about this reply. */
function eventHookContext(input: DeliverInput): EventHookContext {
  return {
    providerId: input.provider.id,
    model: input.requestedModel,
    accountId: input.accountId ?? "",
  };
}
