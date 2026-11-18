import type { Request as ExpressRequest, Response as ExpressResponse } from "express";
import type { Logger } from "pino";
import {
  accountKey,
  acquireAccount,
  addAccountSpend,
  hasFreeAccount,
  planAccounts,
  releaseAccount,
  waitForFreeAccount,
  type AccountRoutingState,
} from "./accounts.js";
import { refuseAnthropicShapes, withoutRefusedShapes } from "./anthropic-shapes.js";
import { refuseBetas, withoutRefusedBodyBetas } from "./betas.js";
import { carefulHeldAccounts } from "./cap-careful.js";
import { copilotRefusal, type CopilotRefusal } from "./copilot-auto.js";
import type { GatewayCandidate } from "./catalog.js";
import { accountDiscoveryOn, type GatewayAccount, type GatewayConfig } from "./config.js";
import { deliver, type DeliverInput } from "./deliver.js";
import { wantsStructuredOutput } from "./format.js";
import { recordHeldRequest } from "./held-report.js";
import type { HookRuntime } from "./hooks.js";
import {
  imageToolRefusedBefore,
  markImageToolRefused,
  mayDropImageTool,
  withoutImageToolRequest,
} from "./image-tool.js";
import { isRecord, type IrSearchPage, type IrUsage } from "./ir.js";
import type { Masker, RestoreCounts } from "./masking.js";
import type { GatewayStrategySeat } from "@neolix/plugin/server";
import {
  hasGatewayMiddlewareHook,
  runGatewayMiddlewareAccount,
  runGatewayMiddlewareProvider,
  runGatewayRoutingStrategy,
} from "./plugin-upstream.js";
import { offlineDetector } from "./offline.js";
import { offerGatewaySpanBodies } from "./otel.js";
import { usageCost } from "./pricing.js";
import type { PricingCatalog } from "./pricing-catalog.js";
import { keepPromptBody } from "./prompt-text.js";
import type { TitleLink } from "./title-link.js";
import { codecFor } from "./protocols.js";
import { isExhausted, quotaFromHeaders, QuotaTracker } from "./quota.js";
import {
  fixToolRefusals,
  rememberToolRefusal,
  toolRefusalOf,
  toolRefusalsFor,
} from "./refusals.js";
import { replyNameFor, replyNamingFor, requestResponseModel } from "./reply-naming.js";
import { clinePinBody, zcodeTrialRefused, type ZenTools } from "./vendor-shaping.js";
import { restProbeAnswered, scheduleRestProbe } from "./rest-probe.js";
import { creditRestMs, isCreditFailure } from "./rests.js";
import { restForFailure } from "./provider-limits.js";
import type { RouteHistory } from "./route-history.js";
import { publishRoute } from "./route-events.js";
import type { RoutePrompt, RouteTrace } from "./route-trace.js";
import {
  candidateKey,
  noteAffinity,
  parseSticky,
  permutationIndices,
  stickyValue,
  type RoutingState,
} from "./routing.js";
import type { FoundPage } from "./search-apis.js";
import { offeredToolNames } from "./text-calls.js";
import { fillThinkingBack, markNeedsThinkingBack, refusedThinkingBack } from "./thinking-back.js";
import {
  markNeedsThinking,
  refusedThinkingNeeded,
  withThinkingEnabled,
} from "./thinking-needed.js";
import { tokenFieldWanted, tokenFloor, withTokenField, withTokenFloor } from "./token-limits.js";
import { clientCallIds, ToolUseIds } from "./tool-use-ids.js";
import {
  clearMantleUnfit,
  isMantleRoute,
  mantleFits,
  mantleWrongRoute,
  markMantleUnfit,
} from "./mantle.js";
import {
  GatewayPluginRejection,
  requestUpstream,
  shouldFailover,
  type GatewayProtocol,
  type UpstreamRequestInput,
  type UpstreamWire,
} from "./upstream.js";
import { SubscriptionSkippedError } from "./subscription-upstream.js";
import {
  BoundThinking,
  refuseBoundThinking,
  withoutForeignThinking,
  withoutRefusedThinking,
} from "./thinking-bound.js";
import { isClaudeSignIn } from "./claude/signin.js";
import { antigravityRefusal } from "./codeassist.js";
import type { RefusalHandover } from "./refusal-handover.js";
import type { Continuation } from "./continuation.js";
import {
  clientOfUserAgent,
  sessionOfRequest,
  type UsageLedger,
  type UsageRecord,
} from "./usage.js";
import { isImageRefusal, isWebpRefusal, type VisionSend, type VisionService } from "./vision.js";

/**
 * One candidate's attempts and the retries a refusal earns, kept apart from
 * the forwarding they are reached through (`routes.ts`). Everything here is
 * per-attempt: the account walked, the body adjusted, the reply delivered and
 * the attempt recorded.
 */

/** The chat body as the endpoints read it (`routes.ts`'s CompletionBody). */
type CompletionBody = { model: string } & Record<string, unknown>;

export interface CandidateAttemptContext {
  config: GatewayConfig;
  candidate: GatewayCandidate;
  upstreamBody: Record<string, unknown>;
  upstreamProtocol: GatewayProtocol;
  protocol: GatewayProtocol;
  body: CompletionBody;
  req: ExpressRequest;
  res: ExpressResponse;
  ledger: UsageLedger;
  routingState: RoutingState;
  accountState: AccountRoutingState;
  quotaTracker: QuotaTracker;
  principalKey: string | null;
  hooks: HookRuntime;
  conversationKey: string | null;
  /** The user's turn this request is on, for `affinity: "auto"`. */
  turnNumber?: number;
  /** The agent handing tool results back within that turn. */
  withinTurn?: boolean;
  /** A Factory model droid doesn't list has another wire to try. */
  factoryRetry?: boolean;
  maskingEnabled: boolean;
  masker: Masker;
  /** How often each stand-in was put back in this request's reply. */
  restoreCounts: RestoreCounts;
  attempts: { value: number };
  startedAt: number;
  logger: Logger;
  onStickyChange?: () => void;
  onRestChange?: (rest: { key: string; until: number; level: number }) => void;
  onRestCleared?: (key: string) => void;
  pricing: PricingCatalog | null;
  /** The accounts a routing group holds each provider to, when it names any. */
  accountFilter: ReadonlyMap<string, ReadonlySet<string>> | null;
  /** The Routing page's record of this request, when tracing is on. */
  trace?: { trace: RouteTrace; routeId: number };
  /** One id for every attempt of this request, for the usage ledger. */
  requestId: string;
  /** One id for the client call, stable across every candidate it tries. */
  gatewayCallId: string;
  /** The prompt this request carries, as routing estimated it. */
  prompt: RoutePrompt | null;
  /** Image recognition, when the daemon started it. */
  vision?: VisionService;
  /** The routing history on disk, when the daemon started it. */
  history?: RouteHistory;
  /** The search the gateway ran for a model that can't search by itself. */
  search: { query: string; pages: FoundPage[] } | null;
  /** `$NEOLIX_HOME/gateway`, where subscription sign-ins are kept. */
  gatewayDir?: string;
  /** The request offered Responses' client-side tool_search. */
  toolSearch: boolean;
  /**
   * How a request to Zen's free tier was shaped, so the reply's tool names
   * go back to the client's and a stub's call is left out (myna's
   * zenReply); null when the request was not to a free Zen model.
   */
  zen: ZenTools | null;
  /** Notes an upstream wire for the request archive (`routes.ts`'s wireHook). */
  wireHook: (res: ExpressResponse) => { onWire: (wire: UpstreamWire) => void };
  /** Asks the daemon's own vision path (`routes.ts`'s visionSend). */
  visionSend: (req: ExpressRequest) => VisionSend;
  /** A reply another try's refusal handed over: this try's stream continues
   * it (myna's refusal_handover.go). */
  handover?: RefusalHandover;
  /** Whether this try's own refusal may go to the next candidate
   * (myna's handsOver). */
  canHandOver?: boolean;
  /** Copilot's Auto session token, sent as `Copilot-Session-Token`. */
  copilotSessionToken?: string;
  /** The request goes to Copilot's Auto pick, whose refusal the walk
   * re-asks with a fresh pick (myna's copilot_refused.go). */
  copilotAuto?: boolean;
  /** Another provider's candidate is left to try (myna's matesLast only
   * defers an Antigravity provider's mates while one is). */
  otherCandidates?: boolean;
  /** The conversation this request's title turn belongs to, when it is one
   * (myna's title_link.go). */
  titleLink?: TitleLink;
}

/** What an upstream said when it refused, for a group's patience. */
export interface AttemptFailure {
  status: number;
  /** The refusal's body as far as it was read; empty for most 5xx. */
  body: string;
  /** The wait its `Retry-After` asked for, 0 when it named none. */
  retryAfterMs: number;
}

export interface CandidateAttemptResult {
  delivered: boolean;
  status: number | null;
  /** The upstream's status when it delivered, for the routing trace. */
  upstreamStatus?: number;
  /** The last refusal's own words, when a later patience may ask again. */
  failure?: AttemptFailure;
  /** The refusal this try handed to the next candidate, whose stream goes on
   * in the same reply (myna's refusal_handover.go). */
  handover?: RefusalHandover;
  /** Antigravity's 429 to a system prompt it refuses: why, for the agent
   * (myna's codeassist.go:184-190). Nothing is held against the account. */
  turnedAway?: string;
  /** Why Copilot refused the Auto pick, for the walk to re-ask with a fresh
   * one (model or session) or another endpoint (myna's copilot_refused.go). */
  copilot?: CopilotRefusal;
}

export async function runCandidateAttempts(
  input: CandidateAttemptContext,
): Promise<CandidateAttemptResult> {
  const { candidate, accountState, routingState, conversationKey } = input;
  let accounts = planAccountsForCandidate(candidate, accountState, routingState, conversationKey);
  accounts = await reorderAccountsByStrategy(candidate, accounts, input);
  const allowed = input.accountFilter?.get(candidate.provider.id);
  if (allowed !== undefined) {
    accounts = accounts.filter((account) => allowed.has(account.id));
    if (accounts.length === 0) {
      // The group holds this provider to accounts it doesn't serve this model
      // on: no provider-level key may stand in for them.
      return { delivered: false, status: null };
    }
  }
  // A careful-capped account whose usage can't be told is held as one at its
  // cap is: that provider is skipped, not tried blind.
  const held = carefulHeldAccounts(input.config.providers, accountState, Date.now());
  if (held.size > 0) {
    accounts = accounts.filter((account) => !held.has(accountKey(candidate.provider, account)));
    if (accounts.length === 0) {
      return { delivered: false, status: null };
    }
  }
  if (
    candidate.provider.queueWaitMs > 0 &&
    accounts.length > 0 &&
    !hasFreeAccount(accountState, candidate.provider, Date.now(), candidate.model.id)
  ) {
    const waitStarted = Date.now();
    // A queue already holding what `queueLength` allows turns this one
    // away at once, as myna's QueueLimit does (provider.go:206-209); the
    // next candidate is asked, and the agent is told 429 when none is.
    const queued = await waitForFreeAccount(accountState, candidate.provider.queueWaitMs, {
      provider: candidate.provider,
      account: accounts[0] as GatewayAccount,
    });
    if (!queued) {
      return {
        delivered: false,
        status: 429,
        failure: { status: 429, body: "the provider's queue is full", retryAfterMs: 0 },
      };
    }
    // Re-plan once after the wait; if every slot is still full the request falls
    // back to trying them anyway rather than failing outright.
    accounts = planAccountsForCandidate(candidate, accountState, routingState, conversationKey);
    accounts = await reorderAccountsByStrategy(candidate, accounts, input);
    if (!hasFreeAccount(accountState, candidate.provider, Date.now(), candidate.model.id)) {
      // Held past what the provider allows: the wait is written down for a
      // bug report, as myna's held report does. Its file is kept on the
      // request's route so the Routing row can open it (myna trace.go:154).
      void recordHeldRequest({
        method: input.req.method,
        path: input.req.path,
        model: candidate.model.id,
        agent: clientOfUserAgent(input.req.headers["user-agent"]),
        provider: candidate.provider.id,
        waitedMs: Date.now() - waitStarted,
        inFlight: [...accountState.inflight.values()].reduce((sum, count) => sum + count, 0),
      }).then((report) => {
        if (report !== null) {
          input.trace?.trace.update(input.trace.routeId, (route) => {
            route.held = report;
          });
        }
        return undefined;
      });
    }
    if (allowed !== undefined) {
      accounts = accounts.filter((account) => allowed.has(account.id));
    }
  }
  if (accounts.length === 0) {
    if (allowed !== undefined) {
      return { delivered: false, status: null };
    }
    return runAccountList(input, [null]);
  }
  const activeLimit = candidate.provider.maxAccounts ?? accounts.length;
  const primary = await runAccountList(input, accounts.slice(0, activeLimit));
  if (primary.delivered || accounts.length <= activeLimit) {
    return primary;
  }
  // Accounts beyond `maxAccounts` are reserve: tried only after every active
  // account failed.
  const reserve = await runAccountList(input, accounts.slice(activeLimit));
  return reserve.delivered ? reserve : combineAttemptResults(primary, reserve);
}

/** What the active and reserve accounts together leave: the last status,
 * failure and turn-away of either. */
function combineAttemptResults(
  primary: CandidateAttemptResult,
  reserve: CandidateAttemptResult,
): CandidateAttemptResult {
  const failure = reserve.failure ?? primary.failure;
  const turnedAway = reserve.turnedAway ?? primary.turnedAway;
  const copilot = reserve.copilot ?? primary.copilot;
  return {
    delivered: false,
    status: reserve.status ?? primary.status,
    ...(failure === undefined ? {} : { failure }),
    ...(turnedAway === undefined ? {} : { turnedAway }),
    ...(copilot === undefined ? {} : { copilot }),
  };
}

/**
 * Whether an Antigravity account is left unasked: the same system prompt was
 * just turned away, and another provider may answer or a mate is still after
 * it (myna's matesLast). The last mate is asked when nothing else is left.
 */
function skipMate(
  turnedAway: string | undefined,
  account: GatewayAccount | null,
  index: number,
  count: number,
  otherCandidates: boolean | undefined,
): boolean {
  if (turnedAway === undefined || account?.agent !== "antigravity") {
    return false;
  }
  return otherCandidates === true || index < count - 1;
}

/** Orders one provider's accounts by a plugin strategy named in its `routing`. */
async function reorderAccountsByStrategy(
  candidate: GatewayCandidate,
  accounts: GatewayAccount[],
  input: CandidateAttemptContext,
): Promise<GatewayAccount[]> {
  const strategy = candidate.provider.routing;
  if (strategy === undefined || !strategy.includes("/") || accounts.length < 2) {
    return accounts;
  }
  const now = Date.now();
  const seats: GatewayStrategySeat[] = accounts.map((account, index) => ({
    key: account.id,
    provider: candidate.provider.id,
    model: candidate.model.id,
    index,
    priority: account.priority ?? 0,
    weight: account.weight ?? 1,
    resting: input.routingState.rest.isResting(accountKey(candidate.provider, account), now),
  }));
  const order = await runGatewayRoutingStrategy(strategy, {
    pool: candidate.provider.id,
    seats,
    options: {},
  });
  const indices = permutationIndices(
    order,
    seats.map((seat) => seat.key),
  );
  if (indices === null) return accounts;
  return indices.map((index) => accounts[index] as GatewayAccount);
}

/** Whether the configured hook or a plugin's onAccount passes this account over. */
async function accountSkippedByHooks(
  input: CandidateAttemptContext,
  candidate: GatewayCandidate,
  account: GatewayAccount,
): Promise<boolean> {
  if (
    input.hooks.runAccount({
      provider: candidate.provider.id,
      account: account.id,
      model: candidate.model.id,
    })
  ) {
    return true;
  }
  return runGatewayMiddlewareAccount({
    requestKey: input.gatewayCallId,
    providerId: candidate.provider.id,
    protocol: candidate.provider.protocol,
    model: candidate.model.id,
    accountId: account.id,
  });
}

/** The body one try sends: the configured provider hook, then the plugins'. */
async function attemptBodyWithHooks(
  input: CandidateAttemptContext,
  candidate: GatewayCandidate,
  account: GatewayAccount | null,
): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = { ...input.upstreamBody };
  input.hooks.runProvider({
    body,
    provider: candidate.provider.id,
    account: account?.id ?? null,
    model: candidate.model.id,
  });
  const changed = await runGatewayMiddlewareProvider({
    requestKey: input.gatewayCallId,
    providerId: candidate.provider.id,
    protocol: candidate.provider.protocol,
    model: candidate.model.id,
    accountId: account?.id ?? null,
    body,
  });
  return changed?.body ?? body;
}

async function runAccountList(
  input: CandidateAttemptContext,
  accounts: (GatewayAccount | null)[],
): Promise<CandidateAttemptResult> {
  const { candidate } = input;
  let lastStatus: number | null = null;
  let lastFailure: AttemptFailure | undefined;
  let lastTurnedAway: string | undefined;
  for (let index = 0; index < accounts.length; index++) {
    const account = accounts[index] as GatewayAccount | null;
    if (skipMate(lastTurnedAway, account, index, accounts.length, input.otherCandidates)) {
      continue;
    }
    const restKey =
      account === null ? candidateKey(candidate) : accountKey(candidate.provider, account);
    if (account !== null && (await accountSkippedByHooks(input, candidate, account))) {
      // A skipped account is neither rested nor counted as an attempt.
      continue;
    }
    let attemptBody = await attemptBodyWithHooks(input, candidate, account);
    // A maker's model on the Cline API goes to the maker's own API when the
    // provider pins it (myna's forwardOnce, gateway.go:5209).
    attemptBody = clinePinBody({
      provider: candidate.provider,
      protocol: candidate.provider.protocol,
      body: attemptBody,
    });
    if (candidate.provider.protocol === "anthropic") {
      // A thinking block signed for another conversation can't be sent to
      // this one: the ones refused here before go, and DeepSeek's UUID
      // signatures never go to an upstream serving Claude (myna's
      // thinking_bound.go).
      const owner = boundThinkingOwner(candidate.provider.id, account);
      attemptBody = withoutRefusedThinking(owner, attemptBody, boundThinking);
      attemptBody = withoutForeignThinking(
        hostOf(candidate.provider.baseUrl),
        candidate.model.id,
        attemptBody,
      );
    }
    input.attempts.value += 1;
    const tryStart = Date.now();
    input.trace?.trace.update(input.trace.routeId, (route) => {
      route.tries.push({
        provider: candidate.provider.id,
        account: account?.id ?? null,
        model: candidate.model.id,
        start: tryStart,
        done: false,
        status: null,
        millis: null,
        error: null,
      });
    });
    const result = await runOneAttempt({
      ...input,
      account,
      attemptBody,
      restKey,
      tryStartedAt: tryStart,
    });
    input.trace?.trace.update(input.trace.routeId, (route) => {
      const entry = route.tries.at(-1);
      if (entry === undefined) {
        return;
      }
      entry.done = true;
      entry.status = result.delivered ? (result.upstreamStatus ?? 200) : result.status;
      entry.millis = Math.max(0, Date.now() - tryStart);
      entry.error = result.delivered || result.status === null ? null : `HTTP ${result.status}`;
    });
    if (result.delivered) {
      return result;
    }
    if (result.handover !== undefined) {
      // The next candidate continues the reply this one began: its own
      // accounts aren't asked, as myna moves to the next try.
      return result;
    }
    if (result.copilot !== undefined) {
      // Copilot refused the Auto pick, not the account: the walk asks
      // Auto again and this account is not rested (copilot_refused.go).
      return result;
    }
    if (result.status !== null) {
      lastStatus = result.status;
    }
    if (result.failure !== undefined) {
      lastFailure = result.failure;
    }
    if (result.turnedAway !== undefined) {
      lastTurnedAway = result.turnedAway;
    }
  }
  return {
    delivered: false,
    status: lastStatus,
    ...(lastFailure === undefined ? {} : { failure: lastFailure }),
    ...(lastTurnedAway === undefined ? {} : { turnedAway: lastTurnedAway }),
  };
}

function planAccountsForCandidate(
  candidate: GatewayCandidate,
  accountState: AccountRoutingState,
  routingState: RoutingState,
  conversationKey: string | null,
): GatewayAccount[] {
  return orderAccountsForConversation(
    planAccounts({
      provider: candidate.provider,
      state: accountState,
      now: Date.now(),
      modelId: candidate.model.id,
    }),
    candidate,
    routingState,
    conversationKey,
  );
}

interface OneAttemptContext extends CandidateAttemptContext {
  account: GatewayAccount | null;
  attemptBody: Record<string, unknown>;
  restKey: string;
  /** When this try began, the one clock the trace and the history share. */
  tryStartedAt: number;
}

/**
 * A Factory endpoint that doesn't serve this model: the provider's next
 * wire is tried, as myna's factoryAPIs does (404/405 name a missing route).
 */
function factoryWireRefused(input: OneAttemptContext, status: number): boolean {
  return input.factoryRetry === true && (status === 404 || status === 405);
}

/** How much of a Mantle refusal the gateway reads before judging it. */
const MANTLE_REFUSAL_BYTES = 1 << 20;

/**
 * The model a request goes upstream as: the vendor's own name when the user
 * gave one, which is what the provider's path is built from too.
 */
function sentModelOf(input: OneAttemptContext): string {
  return input.candidate.model.upstreamName ?? input.candidate.model.id;
}

/** The first bytes of a reply, read from a clone so the reply stays whole. */
async function responsePrefix(response: globalThis.Response, limit: number): Promise<string> {
  const clone = response.clone();
  if (clone.body === null) {
    return "";
  }
  const reader = clone.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < limit) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      const keep = chunk.value.subarray(0, limit - size);
      chunks.push(keep);
      size += keep.length;
      if (keep.length < chunk.value.length) {
        break;
      }
    }
  } catch {
    // An unreadable body says nothing about the route.
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

/**
 * Bedrock Mantle serves each model under `/v1` or `/openai/v1` and turns it
 * away at the other with "model `x` isn't supported on this route". A
 * refusal of the prefix the gateway guessed asks the request at the other
 * one once, and the prefix that served it is remembered; a model neither
 * prefix serves is forgotten, and the first refusal is what the client
 * reads (myna's mantle.go:44-72, gateway.go:5167-5168).
 */
async function retryMantleRoute(
  input: OneAttemptContext,
  upstream: globalThis.Response,
): Promise<globalThis.Response> {
  const provider = input.candidate.provider;
  if (!isMantleRoute(provider) || upstream.status < 400 || upstream.status >= 500) {
    return upstream;
  }
  const model = sentModelOf(input);
  if (model === "" || !mantleFits(provider.id, model, provider.protocol)) {
    return upstream;
  }
  if (!mantleWrongRoute(await responsePrefix(upstream, MANTLE_REFUSAL_BYTES))) {
    return upstream;
  }
  markMantleUnfit(provider.id, model, provider.protocol);
  let again: globalThis.Response;
  try {
    again = await requestUpstream(retryRequest(input, input.attemptBody));
  } catch {
    clearMantleUnfit(provider.id, model, provider.protocol);
    return upstream;
  }
  input.attempts.value += 1;
  if (again.status < 400) {
    return again;
  }
  if (!mantleWrongRoute(await responsePrefix(again, MANTLE_REFUSAL_BYTES))) {
    return again;
  }
  // Neither prefix serves it: the guess stands for the next request.
  clearMantleUnfit(provider.id, model, provider.protocol);
  return upstream;
}

async function runOneAttempt(input: OneAttemptContext): Promise<CandidateAttemptResult> {
  const { candidate, account, accountState } = input;
  if (account !== null) {
    acquireAccount(accountState, candidate.provider, account);
  }
  try {
    const fetched = await fetchUpstream(input);
    if (fetched === null) {
      return { delivered: false, status: null };
    }
    const upstream = await retryMantleRoute(input, fetched);
    const autoRefusal = await copilotAutoRefusal(input, upstream);
    if (autoRefusal !== null) {
      return autoRefusal;
    }
    const imageRetry = await retryImageRefusal(input, upstream);
    if (imageRetry !== null) {
      return imageRetry;
    }
    if (shouldFailover(upstream.status) || factoryWireRefused(input, upstream.status)) {
      return await handleRefusal(input, upstream);
    }
    const retried = await retryThinking(input, upstream);
    if ("result" in retried) {
      return retried.result;
    }
    const thinkingBackRetry = await retryThinkingBack(input, retried.upstream);
    if (thinkingBackRetry !== null) {
      return thinkingBackRetry;
    }
    const boundRetry = await retryBoundThinking(input, retried.upstream);
    if (boundRetry !== null) {
      return boundRetry;
    }
    const neededRetry = await retryThinkingNeeded(input, retried.upstream);
    if (neededRetry !== null) {
      return neededRetry;
    }
    const tokenRetry = await retryTokenLimits(input, retried.upstream);
    if (tokenRetry !== null) {
      return tokenRetry;
    }
    const shapeRetry = await retryAnthropicShapes(input, retried.upstream);
    if (shapeRetry !== null) {
      return shapeRetry;
    }
    const betaRetry = await retryRefusedBetas(input, retried.upstream);
    if (betaRetry !== null) {
      return betaRetry;
    }
    const toolRetry = await retryToolRefusal(input, retried.upstream);
    if (toolRetry !== null) {
      return toolRetry;
    }
    return await deliverSuccess(input, retried.upstream);
  } finally {
    if (account !== null) {
      releaseAccount(accountState, candidate.provider, account);
    }
  }
}

/**
 * Copilot refusing the Auto pick: the body names whether the model, the
 * session or the endpoint is at fault, and the walk asks Auto again with
 * what that changes. Nothing is held against the account, so this reads
 * the reply before any retry or rest (myna's copilot_refused.go).
 */
async function copilotAutoRefusal(
  input: OneAttemptContext,
  upstream: globalThis.Response,
): Promise<CandidateAttemptResult | null> {
  if (input.copilotAuto !== true) {
    return null;
  }
  if (upstream.status !== 400 && upstream.status !== 404) {
    return null;
  }
  const body = await upstream
    .clone()
    .text()
    .catch(() => "");
  const refusal = copilotRefusal(upstream.status, body);
  if (refusal === null) {
    return null;
  }
  await upstream.body?.cancel();
  return {
    delivered: false,
    status: upstream.status,
    failure: { status: upstream.status, body, retryAfterMs: 0 },
    copilot: refusal,
  };
}

/** The wait a reply's `Retry-After` asks for; 0 when it names none. */
function retryAfterMsOf(headers: Headers): number {
  const raw = headers.get("retry-after");
  if (raw === null) {
    return 0;
  }
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }
  const at = Date.parse(raw);
  return Number.isNaN(at) ? 0 : Math.max(0, at - Date.now());
}

/**
 * The request a retry sends: everything the first attempt used — its account,
 * Copilot session, proxy and sign-in discovery — so an account pool's retry
 * reaches the same upstream as itself instead of going out anonymous.
 */
function retryRequest(
  input: OneAttemptContext,
  body: Record<string, unknown>,
): UpstreamRequestInput {
  const { candidate, account } = input;
  const proxy = account?.proxy ?? input.config.proxy;
  return {
    requestKey: input.gatewayCallId,
    ...(input.gatewayDir === undefined ? {} : { gatewayDir: input.gatewayDir }),
    accountDiscovery: accountDiscoveryOn(input.config),
    ...(input.copilotSessionToken === undefined
      ? {}
      : { copilotSessionToken: input.copilotSessionToken }),
    provider: candidate.provider,
    ...(account === null ? {} : { account }),
    model: candidate.model,
    body,
    incomingHeaders: input.req.headers,
    ...input.wireHook(input.res),
    ...(proxy === undefined ? {} : { proxy }),
  };
}

async function fetchUpstream(input: OneAttemptContext): Promise<globalThis.Response | null> {
  const { candidate, account } = input;
  try {
    const upstream = await requestUpstream({
      requestKey: input.gatewayCallId,
      ...(input.gatewayDir === undefined ? {} : { gatewayDir: input.gatewayDir }),
      accountDiscovery: accountDiscoveryOn(input.config),
      ...(input.copilotSessionToken === undefined
        ? {}
        : { copilotSessionToken: input.copilotSessionToken }),
      provider: candidate.provider,
      account: account ?? undefined,
      model: candidate.model,
      body: input.attemptBody,
      incomingHeaders: input.req.headers,
      ...input.wireHook(input.res),
      ...(input.config.proxy === undefined ? {} : { proxy: input.config.proxy }),
    });
    offlineDetector.noteHeard();
    return upstream;
  } catch (error) {
    // A plugin turned the request away: nothing is tried after it, and the
    // client gets the middleware's answer (myna's ctx.reject).
    if (error instanceof GatewayPluginRejection) throw error;
    // A subscription sign-in that can't serve its account skips the attempt:
    // the request was refused, not the account, so nothing rests (myna
    // leaves a lapsed login alone and tries the next).
    if (error instanceof SubscriptionSkippedError) {
      input.logger.info(
        {
          provider: candidate.provider.id,
          account: account?.id ?? null,
          reason: error.reason,
        },
        "LLM gateway skipped an account whose subscription sign-in can't serve it",
      );
      return null;
    }
    // Offline, the provider said nothing of itself: no rest, no count.
    if (await offlineDetector.isOffline(error, input.config.providers, candidate.provider)) {
      input.logger.info(
        { provider: candidate.provider.id, model: candidate.model.id },
        "LLM gateway is offline; the provider is not rested",
      );
      return null;
    }
    recordAttempt(
      buildRecordInput(input, 0, false, null, {
        errorMessage: error instanceof Error ? error.message : String(error),
        errorType: "transport",
      }),
    );
    const now = Date.now();
    // A transport failure rests as myna's backoff does, capped by the
    // provider (myna's provider.go:231-237).
    const duration = restForFailure({ status: null, provider: candidate.provider, now });
    input.routingState.rest.rest(input.restKey, duration, now);
    scheduleRestProbe({
      key: input.restKey,
      provider: candidate.provider,
      account: account ?? null,
      until: now + duration,
      status: 0,
      now,
    });
    clearStickyOnFailure(input.routingState, input.conversationKey, candidate);
    input.logger.info(
      {
        err: error,
        provider: candidate.provider.id,
        account: account?.id ?? null,
        model: candidate.model.id,
      },
      "LLM gateway upstream request failed; falling back",
    );
    return null;
  }
}

/**
 * A model that turned an image away, or a provider that refused a WebP, gets
 * the request once more with the image described (vision) or rewritten. The
 * original refusal is left for `handleRefusal` when the retry does not answer.
 */
async function retryImageRefusal(
  input: OneAttemptContext,
  upstream: globalThis.Response,
): Promise<CandidateAttemptResult | null> {
  // Only a request the vendor turned away is read: a streamed answer is left
  // for the client, unread.
  if (!refusedImageStatus(upstream.status)) {
    return null;
  }
  const vision = input.vision;
  if (vision === undefined) {
    return null;
  }
  const probe = upstream.clone();
  const text = await probe.text().catch(() => "");
  const plan = imageRetryPlan(input, upstream.status, text);
  if (plan === null) {
    return null;
  }
  const { candidate } = input;
  const { webp, blind } = plan;
  let prepared: Record<string, unknown>;
  try {
    prepared = await vision.prepareBody({
      config: input.config,
      candidate,
      protocol: input.upstreamProtocol,
      body: input.attemptBody,
      masker: input.maskingEnabled ? input.masker : null,
      send: input.visionSend(input.req),
      convertWebp: webp,
      blind,
    });
  } catch {
    return null;
  }
  if (webp) {
    vision.markWebpRefused(candidate.provider.id);
  }
  if (blind) {
    vision.markBlind(candidate);
  }
  let retried: globalThis.Response;
  try {
    retried = await requestUpstream(retryRequest(input, prepared));
  } catch {
    return null;
  }
  input.attempts.value += 1;
  if (shouldFailover(retried.status)) {
    await retried.body?.cancel();
    return null;
  }
  return deliverSuccess(input, retried);
}

interface ImageRetryPlan {
  webp: boolean;
  blind: boolean;
}

/** The statuses a vendor turns an image away with. */
function refusedImageStatus(status: number): boolean {
  return status === 400 || status === 415 || status === 422;
}

/** What the refusal asks for: a rewritten WebP, or the image described. */
function imageRetryPlan(
  input: OneAttemptContext,
  status: number,
  text: string,
): ImageRetryPlan | null {
  const vision = input.vision;
  if (vision === undefined) {
    return null;
  }
  const webpSaid = isWebpRefusal(text);
  if (!isImageRefusal(status, text) && !webpSaid) {
    return null;
  }
  const webp = webpSaid && bodyHasWebp(input.attemptBody);
  const blind = !webp && !vision.isBlind(input.candidate);
  return webp || blind ? { webp, blind } : null;
}

function bodyHasWebp(body: Record<string, unknown>): boolean {
  try {
    const text = JSON.stringify(body);
    // myna's mayHoldWebP: a named type, a type a relay escaped, or the
    // base64 of a RIFF head (a WebP sent under another type).
    return text.includes("image/webp") || text.includes("image\\/webp") || text.includes("UklG");
  } catch {
    return false;
  }
}

/**
 * Keeps a 401, or a 403, for the answer when no candidate is left: a Claude
 * sign-in reads it as the provider refusing Neolix's credential (myna's
 * claude_signin.go).
 */
async function noteUpstreamError(
  input: OneAttemptContext,
  upstream: globalThis.Response,
): Promise<void> {
  if (upstream.status !== 401 && upstream.status !== 403) {
    return;
  }
  const body = await upstream
    .clone()
    .text()
    .catch(() => "");
  (input.res.locals as Record<string, unknown>).upstreamError = {
    status: upstream.status,
    body,
  };
}

/**
 * A refusal's body, as far as it is read: the statuses whose words decide a
 * rest, a tool refusal (422), and the ones a group's patience reads (5xx).
 */
async function refusalBody(upstream: globalThis.Response, classified: boolean): Promise<string> {
  return classified || upstream.status === 422 || upstream.status >= 500
    ? await upstream.text().catch(() => "")
    : "";
}

/**
 * Antigravity's 429 to a system prompt it refuses, with nothing wrong in the
 * account: the hint for the agent, or null. It changes nothing about the
 * account, so it is never rested (myna's codeassist.go:184-190,
 * gateway.go:4040-4055).
 */
function antigravityTurnedAway(
  input: OneAttemptContext,
  status: number,
  body: string,
): string | null {
  if (input.account?.agent !== "antigravity") {
    return null;
  }
  return antigravityRefusal(status, body, systemOf(input));
}

/** The system prompt an attempt carries, as its upstream protocol reads it. */
function systemOf(input: OneAttemptContext): string {
  try {
    return codecFor(input.upstreamProtocol).parseRequest(input.attemptBody).system ?? "";
  } catch {
    return "";
  }
}

/** Remembers a tool refusal the vendor made: the next request is shaped
 * before it goes. */
function noteToolRefusal(candidate: GatewayCandidate, status: number, body: string): void {
  const toolRefusal = toolRefusalOf(status, body);
  if (toolRefusal !== null) {
    rememberToolRefusal(candidate.model.id, toolRefusal);
  }
}

/** The rest a refusal earns, and the Retry-After it named: the header wins
 * over every cap (myna's restForFailure). */
function refusalRest(
  input: OneAttemptContext,
  status: number,
  headers: Headers,
  now: number,
): { duration: number; retryAfterMs: number } {
  const retryAfterMs = retryAfterMsOf(headers);
  return {
    retryAfterMs,
    duration: restForFailure({
      status,
      provider: input.candidate.provider,
      ...(retryAfterMs > 0 ? { vendorResetAt: now + retryAfterMs } : {}),
      now,
    }),
  };
}

/**
 * The rest key a refusal uses: a ZCode trial entry refused is that entry's
 * (`key/model`), not the account's — its GLM Coding Plan models still
 * answer (myna's routing.go:1540, `restID`).
 */
function zcodeTrialRestKey(
  input: OneAttemptContext,
  restKey: string,
  status: number,
  body: string,
): string {
  const refused = zcodeTrialRefused({
    pluginProvider: input.candidate.provider.plugin?.providerId ?? "",
    model: input.candidate.model.id,
    status,
    body,
  });
  return refused ? `${restKey}/${input.candidate.model.id}` : restKey;
}

/**
 * Antigravity's refusal, kept as the try's result without resting anything:
 * the request, not the account, was turned away (myna's #666).
 */
function antigravityRefusedResult(
  input: OneAttemptContext,
  upstream: globalThis.Response,
  body: string,
): CandidateAttemptResult | null {
  const hint = antigravityTurnedAway(input, upstream.status, body);
  if (hint === null) {
    return null;
  }
  input.logger.info(
    {
      provider: input.candidate.provider.id,
      account: input.account?.id ?? null,
      model: input.candidate.model.id,
      status: upstream.status,
    },
    "LLM gateway: Antigravity turned the system prompt away",
  );
  return {
    delivered: false,
    status: upstream.status,
    failure: {
      status: upstream.status,
      body,
      retryAfterMs: retryAfterMsOf(upstream.headers),
    },
    turnedAway: hint,
  };
}

async function handleRefusal(
  input: OneAttemptContext,
  upstream: globalThis.Response,
): Promise<CandidateAttemptResult> {
  const { candidate, account, restKey, routingState, accountState } = input;
  await noteUpstreamError(input, upstream);
  const snapshot = quotaFromHeaders(upstream.headers, Date.now());
  const sinkable =
    upstream.status === 429 &&
    candidate.provider.sink &&
    snapshot !== null &&
    !isExhausted(snapshot);
  const classified =
    upstream.status === 400 ||
    upstream.status === 402 ||
    upstream.status === 403 ||
    upstream.status === 429;
  // A 5xx body is read too: patience leaves a proxy's "did not stream"
  // alone, and tells a used-up quota by its words (myna's patience.go busy).
  const body = await refusalBody(upstream, classified);
  // the refusal's own words, for the usage report's error columns
  recordAttempt(buildRecordInput(input, upstream.status, false, null, errorFieldsOf(body)));
  noteToolRefusal(candidate, upstream.status, body);
  const turnedAway = antigravityRefusedResult(input, upstream, body);
  if (turnedAway !== null) {
    return turnedAway;
  }
  const credit = classified && isCreditFailure(upstream.status, body);
  if (credit) {
    routingState.spent?.add(candidateKey(candidate));
    const level = (accountState.credit.get(restKey) ?? 0) + 1;
    accountState.credit.set(restKey, level);
    const duration = creditRestMs(level);
    routingState.rest.rest(restKey, duration, Date.now());
    input.onRestChange?.({ key: restKey, until: Date.now() + duration, level });
  } else if (!sinkable) {
    const now = Date.now();
    const rest = refusalRest(input, upstream.status, upstream.headers, now);
    const zcodeRestKey = zcodeTrialRestKey(input, restKey, upstream.status, body);
    routingState.rest.rest(zcodeRestKey, rest.duration, now);
    scheduleRestProbe({
      key: zcodeRestKey,
      provider: candidate.provider,
      account,
      until: now + rest.duration,
      status: upstream.status,
      retryAfterMs: rest.retryAfterMs,
      now,
    });
  }
  clearStickyOnFailure(routingState, input.conversationKey, candidate);
  input.logger.info(
    {
      provider: candidate.provider.id,
      account: account?.id ?? null,
      model: candidate.model.id,
      status: upstream.status,
    },
    "LLM gateway upstream refused the request; falling back",
  );
  // A body read for its words was consumed; only one left untouched is
  // cancelled here.
  if (!classified && upstream.status !== 422 && upstream.status < 500) {
    await upstream.body?.cancel();
  }
  return {
    delivered: false,
    status: upstream.status,
    failure: {
      status: upstream.status,
      body,
      retryAfterMs: retryAfterMsOf(upstream.headers),
    },
  };
}

async function retryThinking(
  input: OneAttemptContext,
  upstream: globalThis.Response,
): Promise<{ upstream: globalThis.Response } | { result: CandidateAttemptResult }> {
  // A thinking-capable model behind a provider that rejects the legacy
  // `thinking` knob answers 400. Retry once without it instead of failing a
  // turn the user cannot fix from the client.
  const retry = await maybeRetryWithoutThinking(input, upstream);
  if (retry.kind !== "skipped") {
    input.attempts.value += 1;
  }
  if (retry.kind === "failed") {
    input.routingState.rest.rest(
      input.restKey,
      restForFailure({
        status: retry.status,
        provider: input.candidate.provider,
        now: Date.now(),
      }),
      Date.now(),
    );
    clearStickyOnFailure(input.routingState, input.conversationKey, input.candidate);
    return { result: { delivered: false, status: retry.status } };
  }
  if (retry.kind === "delivered") {
    return { upstream: retry.upstream };
  }
  return { upstream };
}

/**
 * A 400 asking for an earlier tool turn's thinking is asked once more
 * with a filler on those turns, and the provider's model is remembered
 * as wanting it (myna's thinking_back.go).
 */
async function retryThinkingBack(
  input: OneAttemptContext,
  upstream: globalThis.Response,
): Promise<CandidateAttemptResult | null> {
  if (upstream.status !== 400) {
    return null;
  }
  const message = await upstream
    .clone()
    .text()
    .catch(() => "");
  if (!refusedThinkingBack(message)) {
    return null;
  }
  const filled = fillThinkingBack(input.upstreamProtocol, input.attemptBody);
  if (!filled.changed) {
    return null;
  }
  markNeedsThinkingBack(
    input.candidate.provider.id,
    input.candidate.model.id,
    input.upstreamProtocol,
  );
  await upstream.body?.cancel();
  input.attempts.value += 1;
  try {
    const retried = await requestUpstream(retryRequest(input, filled.body));
    if (shouldFailover(retried.status)) {
      await retried.body?.cancel();
      return { delivered: false, status: retried.status };
    }
    return await deliverSuccess(input, retried);
  } catch {
    return { delivered: false, status: null };
  }
}

/** Thinking signatures this gateway was told another conversation signed. */
const boundThinking = new BoundThinking();

/** Whose refusal memory a thinking block belongs to: provider and account. */
function boundThinkingOwner(providerId: string, account: GatewayAccount | null): string {
  return `${providerId}\u0000${account?.subscriptionUser ?? account?.id ?? ""}`;
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return "";
  }
}

/** The hostname alone, as the usage report names an upstream (myna's HostOf). */
function hostnameOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return "";
  }
}

/**
 * A 400 naming a thinking block signed for another conversation is asked
 * once more without that block and the thinking after it, and those
 * signatures are remembered for this provider and account (myna's
 * thinking_bound.go).
 */
async function retryBoundThinking(
  input: OneAttemptContext,
  upstream: globalThis.Response,
): Promise<CandidateAttemptResult | null> {
  if (input.upstreamProtocol !== "anthropic" || upstream.status !== 400) {
    return null;
  }
  const errorText = await upstream
    .clone()
    .text()
    .catch(() => "");
  if (errorText.length === 0) {
    return null;
  }
  const owner = boundThinkingOwner(input.candidate.provider.id, input.account);
  if (
    !refuseBoundThinking({
      owner,
      errorText,
      body: input.attemptBody,
      refused: boundThinking,
    })
  ) {
    return null;
  }
  const cleaned = withoutForeignThinking(
    hostOf(input.candidate.provider.baseUrl),
    input.candidate.model.id,
    withoutRefusedThinking(owner, input.attemptBody, boundThinking),
  );
  await upstream.body?.cancel();
  input.attempts.value += 1;
  try {
    const retried = await requestUpstream(retryRequest(input, cleaned));
    if (shouldFailover(retried.status)) {
      await retried.body?.cancel();
      return { delivered: false, status: retried.status };
    }
    return await deliverSuccess(input, retried);
  } catch {
    return { delivered: false, status: null };
  }
}

/**
 * A 400 about the reply's length is asked once more: a floor the model
 * takes raised to it, or the other of Chat's two field names (myna's
 * limit.go and token_field.go). null when the refusal is about neither.
 */
async function retryTokenLimits(
  input: OneAttemptContext,
  upstream: globalThis.Response,
): Promise<CandidateAttemptResult | null> {
  if (upstream.status !== 400 && upstream.status !== 422) {
    return null;
  }
  const message = await upstream
    .clone()
    .text()
    .catch(() => "");
  if (message.length === 0) {
    return null;
  }
  const floor = tokenFloor(message);
  const want = floor > 0 ? null : tokenFieldWanted(message);
  let next: Record<string, unknown> | null = null;
  if (floor > 0) {
    next = withTokenFloor(input.attemptBody, floor);
  } else if (want !== null) {
    next = withTokenField(input.attemptBody, want);
  }
  if (next === null) {
    return null;
  }
  await upstream.body?.cancel();
  input.attempts.value += 1;
  try {
    const retried = await requestUpstream(retryRequest(input, next));
    if (shouldFailover(retried.status)) {
      await retried.body?.cancel();
      return { delivered: false, status: retried.status };
    }
    return await deliverSuccess(input, retried);
  } catch {
    return { delivered: false, status: null };
  }
}

/** How many of Claude Code's shapes one turn mends, as myna loops. */
const SHAPE_RETRIES = 3;

/**
 * A 400 asking for thinking enabled is asked once more with it at the
 * least budget, and the provider's model is remembered as needing it
 * (myna's thinking_needed.go).
 */
async function retryThinkingNeeded(
  input: OneAttemptContext,
  upstream: globalThis.Response,
): Promise<CandidateAttemptResult | null> {
  if (upstream.status !== 400 && upstream.status !== 422) {
    return null;
  }
  const message = await upstream
    .clone()
    .text()
    .catch(() => "");
  if (!refusedThinkingNeeded(message)) {
    return null;
  }
  const fitted = withThinkingEnabled(input.attemptBody);
  if (!fitted.changed) {
    return null;
  }
  markNeedsThinking(input.candidate.provider.id, input.candidate.model.id);
  await upstream.body?.cancel();
  input.attempts.value += 1;
  try {
    const retried = await requestUpstream(retryRequest(input, fitted.body));
    if (shouldFailover(retried.status)) {
      await retried.body?.cancel();
      return { delivered: false, status: retried.status };
    }
    return await deliverSuccess(input, retried);
  } catch {
    return { delivered: false, status: null };
  }
}

/**
 * A refusal naming one of Claude Code's newest Anthropic shapes is asked
 * once more without it, and the provider is not sent it again; myna mends
 * up to three in one turn, each named by the next refusal
 * (myna's anthropic_shapes.go).
 */
async function retryAnthropicShapes(
  input: OneAttemptContext,
  upstream: globalThis.Response,
): Promise<CandidateAttemptResult | null> {
  if (
    input.upstreamProtocol !== "anthropic" ||
    (upstream.status !== 400 && upstream.status !== 422)
  ) {
    return null;
  }
  let current = upstream;
  let retried = false;
  for (let round = 0; round < SHAPE_RETRIES; round += 1) {
    const next = await shapedRetryBody(input, current);
    if (next === null) {
      break;
    }
    await current.body?.cancel();
    input.attempts.value += 1;
    try {
      current = await requestUpstream(retryRequest(input, next));
    } catch {
      return { delivered: false, status: null };
    }
    retried = true;
    if (shouldFailover(current.status)) {
      await current.body?.cancel();
      return { delivered: false, status: current.status };
    }
  }
  return retried ? deliverSuccess(input, current) : null;
}

/** The body to send once more after a shape refusal, or null for no new shape. */
async function shapedRetryBody(
  input: OneAttemptContext,
  upstream: globalThis.Response,
): Promise<Record<string, unknown> | null> {
  if (upstream.status !== 400 && upstream.status !== 422) {
    return null;
  }
  const message = await upstream
    .clone()
    .text()
    .catch(() => "");
  if (message.length === 0) {
    return null;
  }
  const providerId = input.candidate.provider.id;
  const fresh = refuseAnthropicShapes({ providerId, message, body: input.attemptBody });
  if (fresh.length === 0) {
    return null;
  }
  const next = withoutRefusedShapes(providerId, input.attemptBody);
  return JSON.stringify(next) === JSON.stringify(input.attemptBody) ? null : next;
}

/**
 * A refusal naming an anthropic-beta the provider doesn't know is asked
 * once more: the betas are remembered, so the header and the body's
 * anthropic_beta leave them out from now on (myna's betas.go).
 */
async function retryRefusedBetas(
  input: OneAttemptContext,
  upstream: globalThis.Response,
): Promise<CandidateAttemptResult | null> {
  if (upstream.status !== 400 && upstream.status !== 422) {
    return null;
  }
  const message = await upstream
    .clone()
    .text()
    .catch(() => "");
  if (message.length === 0) {
    return null;
  }
  const fresh = refuseBetas(input.candidate.provider.id, message);
  if (fresh.length === 0) {
    return null;
  }
  await upstream.body?.cancel();
  input.attempts.value += 1;
  const next = withoutRefusedBodyBetas(
    input.candidate.provider.id,
    input.attemptBody,
    input.candidate.provider.baseUrl,
  );
  try {
    const retried = await requestUpstream(retryRequest(input, next));
    if (shouldFailover(retried.status)) {
      await retried.body?.cancel();
      return { delivered: false, status: retried.status };
    }
    return await deliverSuccess(input, retried);
  } catch {
    return { delivered: false, status: null };
  }
}

/**
 * A tool fault the upstream named only when it saw the request is fixed and
 * the request sent once more, as myna does; the fault is remembered for the
 * model, so later turns are shaped before they go.
 */
async function retryToolRefusal(
  input: OneAttemptContext,
  upstream: globalThis.Response,
): Promise<CandidateAttemptResult | null> {
  if (upstream.status !== 400 && upstream.status !== 422) {
    return null;
  }
  const message = await upstream
    .clone()
    .text()
    .catch(() => "");
  const fault = toolRefusalOf(upstream.status, message);
  let next: Record<string, unknown>;
  if (fault === null) {
    // A bare 400 over Codex's image tool, which a vendor's Responses API
    // that knows no namespaces gives: asked again without it, and not
    // offered it there again once that works.
    if (
      !mayDropImageTool(input.candidate.provider) ||
      imageToolRefusedBefore(input.candidate.provider.id)
    ) {
      return null;
    }
    const stripped = withoutImageToolRequest(input.attemptBody);
    if (!stripped.had) {
      return null;
    }
    markImageToolRefused(input.candidate.provider.id);
    next = stripped.body;
  } else {
    rememberToolRefusal(input.candidate.model.id, fault);
    next = fixToolRefusals(
      input.attemptBody,
      input.upstreamProtocol,
      toolRefusalsFor(input.candidate.model.id),
    );
  }
  if (JSON.stringify(next) === JSON.stringify(input.attemptBody)) {
    return null;
  }
  await upstream.body?.cancel();
  input.attempts.value += 1;
  try {
    const retried = await requestUpstream(retryRequest(input, next));
    if (shouldFailover(retried.status)) {
      await retried.body?.cancel();
      return { delivered: false, status: retried.status };
    }
    return await deliverSuccess(input, retried);
  } catch {
    return { delivered: false, status: null };
  }
}

/**
 * Asks the same upstream again in place, for a reply whose reasoning looped
 * before it said anything (myna's continuation.go:62, `loopReasks`). No
 * rest, no ledger line: the try is one attempt either way.
 */
async function reaskUpstream(
  input: OneAttemptContext,
  continuation?: Continuation,
): Promise<globalThis.Response | null> {
  // A cut reply goes on from what the client already has, when the upstream
  // can (myna's continuation.go withPrefill).
  const body =
    continuation === undefined
      ? input.attemptBody
      : continuation.withPrefill(input.upstreamProtocol, input.attemptBody);
  try {
    return await requestUpstream(retryRequest(input, body));
  } catch {
    return null;
  }
}

/** The attempt as the deliverer takes it. */
function deliverInputOf(
  input: OneAttemptContext,
  upstream: globalThis.Response,
  toolIds: ReturnType<typeof replyToolUseIds>,
): DeliverInput {
  const candidate = input.candidate;
  return {
    requestKey: input.gatewayCallId,
    res: input.res,
    upstream,
    provider: candidate.provider,
    accountId: input.account?.id ?? null,
    upstreamProtocol: input.upstreamProtocol,
    clientProtocol: input.protocol,
    requestedModel: input.body.model,
    servedModel: candidate.model.id,
    wantsStream: input.body.stream === true,
    reencode:
      input.upstreamProtocol !== input.protocol ||
      input.maskingEnabled ||
      input.search !== null ||
      input.zen !== null ||
      (input.body.stream === true &&
        (input.hooks.hasEventHook() || hasGatewayMiddlewareHook("event"))),
    masker: input.maskingEnabled ? input.masker : null,
    restoreCounts: input.restoreCounts,
    wantsJson: wantsStructuredOutput(input.protocol, input.body),
    hooks: input.hooks,
    toolIds,
    offeredTools: offeredToolNames(input.upstreamProtocol, input.attemptBody),
    noLoopGuard: input.config.noLoopGuard === true,
    replyName: replyNameFor({
      naming: replyNamingFor({
        requestHeader: requestResponseModel(input.req.headers),
        config: input.config,
      }),
      asked: input.body.model,
      wire: candidate.model.id,
      providerId: candidate.provider.id,
    }),
    search:
      input.search === null
        ? null
        : { query: input.search.query, pages: input.search.pages.map(searchPageOf) },
    startedAt: input.startedAt,
    claudeSignIn: isClaudeSignIn(input.req.headers.authorization),
    toolSearch: input.toolSearch,
    zen: input.zen,
    ...(input.titleLink === undefined ? {} : { titleTurn: true }),
    reask: (continuation?: Continuation) => reaskUpstream(input, continuation),
    ...(input.handover === undefined ? {} : { handover: input.handover }),
    ...(input.canHandOver === undefined ? {} : { canHandOver: input.canHandOver }),
  };
}

/** What a delivered reply leaves the account, the stickiness and the ledger. */
function noteDelivered(
  input: OneAttemptContext,
  upstream: globalThis.Response,
  outcome: Awaited<ReturnType<typeof deliver>>,
): void {
  const { candidate, account, restKey, routingState, accountState } = input;
  recordAttempt({
    ...buildRecordInput(input, upstream.status, true, outcome.usage),
    ttftMs: outcome.ttftMs,
    ...(outcome.stopReason === undefined ? {} : { upstreamStop: outcome.stopReason }),
    ...(outcome.tierServed === undefined ? {} : { tierServed: outcome.tierServed }),
    ...(outcome.credits === undefined ? {} : { credits: outcome.credits }),
  });
  routingState.lastUsed.set(candidateKey(candidate), Date.now());
  if (accountState.credit.delete(restKey)) {
    input.onRestCleared?.(restKey);
  }
  applyAccountQuota({
    config: input.config,
    pricing: input.pricing,
    upstream,
    candidate,
    account,
    usage: outcome.usage,
    protocol: input.upstreamProtocol,
    quotaTracker: input.quotaTracker,
    routingState,
    accountState,
    now: Date.now(),
  });
  if (input.conversationKey !== null) {
    const key = stickyValue(candidateKey(candidate), account?.id ?? null);
    routingState.sticky.set(input.conversationKey, key);
    if (outcome.usage !== null) {
      noteAffinity(routingState, input.conversationKey, {
        key,
        turn: input.turnNumber ?? 0,
        within: input.withinTurn === true,
        at: Date.now(),
        usage: {
          input: outcome.usage.inputTokens,
          cacheRead: outcome.usage.cacheReadTokens ?? 0,
          cacheWrite: outcome.usage.cacheWriteTokens ?? 0,
          ...(outcome.usage.cacheWrite1hTokens === undefined
            ? {}
            : { cacheWrite1h: outcome.usage.cacheWrite1hTokens }),
        },
      });
    }
    input.onStickyChange?.();
  }
}

async function deliverSuccess(
  input: OneAttemptContext,
  upstream: globalThis.Response,
): Promise<CandidateAttemptResult> {
  input.routingState.rest.clear(input.restKey);
  restProbeAnswered(input.restKey);
  const toolIds = input.upstreamProtocol === "anthropic" ? replyToolUseIds(input) : null;
  // The reply is kept for the request's trace only when bodies were asked for.
  input.res.locals.otelBodies = input.config.otel?.bodies === true;
  const outcome = await deliver(deliverInputOf(input, upstream, toolIds));
  if (outcome.handedOver !== undefined) {
    // The refusal went to the next candidate in the same reply: this try
    // neither delivered nor failed, and rests nobody (myna's handedOver).
    return {
      delivered: false,
      status: outcome.handedOver.handOver?.status ?? null,
      handover: outcome.handedOver,
    };
  }
  noteDelivered(input, upstream, outcome);
  return { delivered: true, status: null, upstreamStatus: upstream.status };
}

/** The ids a Messages reply may say without naming one the client holds. */
function replyToolUseIds(input: OneAttemptContext): ToolUseIds | null {
  try {
    return new ToolUseIds(clientCallIds(codecFor(input.protocol).parseRequest(input.body)));
  } catch {
    return null;
  }
}

/** The host a request went to: an account's own base URL first. */
function recordHost(input: OneAttemptContext): string {
  return hostnameOf(input.account?.baseUrl ?? input.candidate.provider.baseUrl);
}

/** The reasoning level the sent body actually asks for, when the candidate
 * pins none (myna's EffortOf). */
function sentEffort(body: Record<string, unknown>): string | undefined {
  const direct = body.reasoning_effort;
  if (typeof direct === "string" && direct.length > 0) {
    return direct;
  }
  const reasoning = isRecord(body.reasoning) ? body.reasoning : null;
  const nested = reasoning === null ? undefined : reasoning.effort;
  if (typeof nested === "string" && nested.length > 0) {
    return nested;
  }
  const config = isRecord(body.generationConfig) ? body.generationConfig : null;
  const thinking =
    config === null || !isRecord(config.thinkingConfig) ? null : config.thinkingConfig;
  const level = thinking === null ? undefined : thinking.thinkingLevel;
  return typeof level === "string" && level.length > 0 ? level : undefined;
}

/** What the turn was for (myna's Kind): the subagent header, then body. */
function turnKind(input: OneAttemptContext): string | undefined {
  const header = input.req.headers["x-openai-subagent"];
  const named = Array.isArray(header) ? header[0] : header;
  if (typeof named === "string" && named.length > 0) {
    return named;
  }
  const kind = input.body.request_kind;
  return typeof kind === "string" && kind.length > 0 ? kind : undefined;
}

/** A refusal's own words and type, cut short for the usage report. */
function errorFieldsOf(body: string): { errorMessage?: string; errorType?: string } {
  if (body.length === 0) {
    return {};
  }
  const cut = body.length > 300 ? body.slice(0, 300) : body;
  try {
    const parsed: unknown = JSON.parse(body);
    if (!isRecord(parsed)) {
      return { errorMessage: cut };
    }
    const error = isRecord(parsed.error) ? parsed.error : parsed;
    const type = typeof error.type === "string" ? error.type : error.status;
    const message = typeof error.message === "string" ? error.message : cut;
    return {
      errorMessage: message.slice(0, 300),
      ...(typeof type === "string" && type.length > 0 ? { errorType: type } : {}),
    };
  } catch {
    return { errorMessage: cut };
  }
}

/** The service tier a body names: OpenAI's service_tier or Anthropic's speed. */
function tierOf(body: Record<string, unknown>): string | undefined {
  const tier = body.service_tier ?? body.speed;
  return typeof tier === "string" && tier.length > 0 ? tier : undefined;
}

function buildRecordInput(
  input: OneAttemptContext,
  status: number,
  ok: boolean,
  usage: IrUsage | null,
  extra: Partial<RecordAttemptInput> = {},
): RecordAttemptInput {
  const replyId = responseIdOf(input.res);
  const archiveName =
    typeof input.res.locals?.archiveName === "string" ? input.res.locals.archiveName : undefined;
  return {
    ledger: input.ledger,
    config: input.config,
    pricing: input.pricing,
    principalKey: input.principalKey,
    candidate: input.candidate,
    accountId: input.account?.id ?? null,
    requestedModel: input.body.model,
    protocol: input.protocol,
    status,
    ok,
    attempts: input.attempts.value,
    startedAt: input.startedAt,
    tryStartedAt: input.tryStartedAt,
    usage,
    userAgent: input.req.headers["user-agent"],
    upstreamProtocol: input.upstreamProtocol,
    session: sessionOfRequest(input.req.headers, input.body),
    requestId: input.requestId,
    gatewayCallId: input.gatewayCallId,
    prompt: input.prompt,
    ttftMs: null,
    upstreamBody: input.upstreamBody,
    masker: input.masker,
    res: input.res,
    ...attemptRecordFields(input, replyId, archiveName),
    ...extra,
  };
}

/** The record's fields the attempt may or may not know. */
function attemptRecordFields(
  input: OneAttemptContext,
  replyId: string | undefined,
  archiveName: string | undefined,
): Partial<RecordAttemptInput> {
  const askedTier = tierOf(input.body);
  const sentTier = tierOf(input.upstreamBody);
  const kind = turnKind(input);
  return {
    ...(replyId === undefined ? {} : { responseId: replyId }),
    ...(archiveName === undefined ? {} : { archiveName }),
    ...(input.history === undefined ? {} : { history: input.history }),
    ...(input.titleLink === undefined ? {} : { titleLink: input.titleLink }),
    host: recordHost(input),
    effort: input.candidate.ruleEffort ?? input.candidate.effort ?? sentEffort(input.upstreamBody),
    ...(kind === undefined ? {} : { kind }),
    providerKeyId: input.account?.id ?? "default",
    providerKeyName: input.account?.label ?? input.account?.id,
    ...(input.trace === undefined ? {} : { routeId: input.trace.routeId }),
    endpoint: input.req.path,
    ...(askedTier === undefined ? {} : { tierAsked: askedTier }),
    ...(sentTier === undefined ? {} : { tierSent: sentTier }),
  };
}

/** A found page as the reply's search block names it. */
function searchPageOf(page: FoundPage): IrSearchPage {
  return {
    title: page.title,
    url: page.url,
    ...(page.age === undefined ? {} : { age: page.age }),
    // Kept for the citations an Anthropic client is given; never sent as
    // part of the search block.
    ...(page.text === undefined ? {} : { text: page.text }),
  };
}

interface RecordAttemptInput {
  ledger: UsageLedger;
  config: GatewayConfig;
  pricing: PricingCatalog | null;
  principalKey: string | null;
  candidate: GatewayCandidate;
  accountId: string | null;
  requestedModel: string;
  protocol: GatewayProtocol;
  status: number;
  ok: boolean;
  attempts: number;
  /** When the request began, for the row's own duration. */
  startedAt: number;
  /** When this try began, for the try's duration. */
  tryStartedAt: number;
  usage: IrUsage | null;
  /** The client's User-Agent, read as the agent that made the request. */
  userAgent: string | undefined;
  upstreamProtocol: GatewayProtocol;
  /** The conversation the request belongs to, when one can be told. */
  session: string | null;
  /** One id for every attempt of this request. */
  requestId: string;
  /** One id for the client call, stable across every candidate it tries. */
  gatewayCallId: string;
  /** The prompt the request carried, for the Context page. */
  prompt: RoutePrompt | null;
  /** Milliseconds to the first streamed token, when the relay timed one. */
  ttftMs: number | null;
  history?: RouteHistory;
  /** The masked body the vendor was sent, for the prompt's text. */
  upstreamBody: Record<string, unknown>;
  /** Masks a body before the trace keeps it; the masker is always there. */
  masker: Masker;
  /** Where the reply the client received was kept, for the trace. */
  res: ExpressResponse;
  /** The response object's id as the client received it (myna's ResponseID). */
  responseId?: string;
  /** The archive this request's bytes were kept under (`<date>/<id>`). */
  archiveName?: string;
  /** The upstream's host, as the usage report names it (myna's Host). */
  host?: string;
  /** The reasoning level the attempt went with (myna's Effort). */
  effort?: string;
  /** What the turn was for, as its client said (myna's Kind). */
  kind?: string;
  /** The upstream credential, not the gateway key (myna's ProviderKeyID). */
  providerKeyId?: string;
  providerKeyName?: string;
  /** The Routing row this attempt belongs to, when tracing is on. */
  routeId?: number;
  /** The path the client called (myna's Endpoint). */
  endpoint?: string;
  errorMessage?: string;
  errorType?: string;
  /** The tier the client asked for, and the one sent (myna's TierAsked/TierSent). */
  tierAsked?: string;
  tierSent?: string;
  /** The tier the vendor served on, and why it said the reply ended. */
  tierServed?: string;
  upstreamStop?: string;
  /** The credits the vendor billed (WorkBuddy's usage.credit). */
  credits?: number;
  /** A title turn's conversation, its reply's title digested on the route
   * row for the Routing page. */
  titleLink?: TitleLink;
}

/** The prompt's slices as a record keeps them: totals only, no items. */
function promptSummaryOf(prompt: RoutePrompt): {
  tokens: number;
  parts: { kind: string; tokens: number }[];
} {
  return {
    tokens: prompt.tokens,
    parts: (prompt.slices ?? []).map((slice) => ({ kind: slice.kind, tokens: slice.tokens })),
  };
}

/** The response id the client was given, when the reply named one. */
function responseIdOf(res: ExpressResponse): string | undefined {
  const value = (res.locals as Record<string, unknown> | undefined)?.responseId;
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** The reply the client received, when the trace was set to keep bodies. */
function replyTextOf(res: ExpressResponse): string | undefined {
  const value = (res.locals as Record<string, unknown> | undefined)?.replyText;
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** A call that reported no usage: it is still priced, at nothing. */
const ZERO_USAGE: IrUsage = { inputTokens: 0, outputTokens: 0 };

/**
 * The bodies this request's span keeps (myna's OTel.BodiesWhole): masked
 * before they are kept, cut at 256 KiB inside. The ledger's record, written
 * right after, picks them up; off, nothing is read.
 */
function offerTraceBodies(input: RecordAttemptInput): void {
  const replyText = replyTextOf(input.res);
  offerGatewaySpanBodies(
    input.requestId,
    {
      request: JSON.stringify(input.upstreamBody),
      ...(replyText === undefined ? {} : { response: replyText }),
    },
    (text) => input.masker.maskText(text),
  );
}

/** The request's archive and reply id, as both records carry them. */
function traceExtras(input: RecordAttemptInput): Record<string, unknown> {
  return {
    ...(input.archiveName === undefined ? {} : { archive: input.archiveName }),
    ...(input.responseId === undefined ? {} : { responseId: input.responseId }),
  };
}

/** The optional fields a record keeps, each only when the attempt knew it. */
function optionalRecordFields(input: RecordAttemptInput): Partial<UsageRecord> {
  return {
    ...(input.host === undefined ? {} : { host: input.host }),
    ...(input.effort === undefined ? {} : { effort: input.effort }),
    ...(input.kind === undefined ? {} : { kind: input.kind }),
    ...(input.providerKeyId === undefined ? {} : { providerKeyId: input.providerKeyId }),
    ...(input.providerKeyName === undefined ? {} : { providerKeyName: input.providerKeyName }),
    ...(input.routeId === undefined ? {} : { routeId: input.routeId }),
    ...(input.endpoint === undefined ? {} : { endpoint: input.endpoint }),
    ...(input.errorMessage === undefined ? {} : { errorMessage: input.errorMessage }),
    ...(input.errorType === undefined ? {} : { errorType: input.errorType }),
    ...(input.tierAsked === undefined ? {} : { tierAsked: input.tierAsked }),
    ...(input.tierSent === undefined ? {} : { tierSent: input.tierSent }),
    ...(input.tierServed === undefined ? {} : { tierServed: input.tierServed }),
    ...(input.upstreamStop === undefined ? {} : { upstreamStop: input.upstreamStop }),
    ...(input.credits === undefined ? {} : { credits: input.credits }),
  };
}

/** One attempt as the usage ledger's row keeps it. */
function usageRecordOf(
  input: RecordAttemptInput,
  cost: { costUsd: number; priced: boolean },
): UsageRecord {
  return {
    time: new Date(input.startedAt).toISOString(),
    requested: input.requestedModel,
    provider: input.candidate.provider.id,
    account: input.accountId,
    model: input.candidate.model.id,
    protocol: input.protocol,
    status: input.status,
    ok: input.ok,
    inputTokens: input.usage?.inputTokens ?? 0,
    outputTokens: input.usage?.outputTokens ?? 0,
    client: clientOfUserAgent(input.userAgent),
    upstreamProtocol: input.upstreamProtocol,
    ...(input.session === null ? {} : { session: input.session }),
    requestId: input.requestId,
    gatewayCallId: input.gatewayCallId,
    ...(input.prompt === null ? {} : { prompt: promptSummaryOf(input.prompt) }),
    ...traceExtras(input),
    cacheReadTokens: input.usage?.cacheReadTokens ?? 0,
    cacheWriteTokens: input.usage?.cacheWriteTokens ?? 0,
    cacheWrite1hTokens: input.usage?.cacheWrite1hTokens ?? 0,
    reasoningTokens: input.usage?.reasoningTokens ?? 0,
    ...(input.ttftMs === null ? {} : { ttftMs: input.ttftMs }),
    attempts: input.attempts,
    durationMs: Date.now() - input.startedAt,
    costUsd: cost.costUsd,
    priced: cost.priced,
    key: input.principalKey,
    ...optionalRecordFields(input),
  };
}

/** The title a title turn's reply wrote, digested by the deliverer. */
function titleDigestOf(input: RecordAttemptInput): string | undefined {
  const digest = (input.res.locals as Record<string, unknown>).titleReplyDigest;
  return typeof digest === "string" && digest.length > 0 ? digest : undefined;
}

/**
 * Why a failed try failed, as the live routing trace says it: the HTTP status
 * when the upstream answered, else the transport's own message. A status of 0
 * means the vendor never answered (attempts.ts, the transport failure path),
 * and nothing but that message explains it.
 */
function tryErrorOf(input: RecordAttemptInput): string | null {
  if (input.ok) {
    return null;
  }
  if (input.status > 0) {
    return `HTTP ${input.status}`;
  }
  return input.errorMessage ?? null;
}

/** One attempt as the Routing page's row keeps it. */
function routeRowOf(input: RecordAttemptInput): Record<string, unknown> {
  const served = `${input.candidate.provider.id}/${input.candidate.model.id}`;
  const replyDigest = titleDigestOf(input);
  // The try's own clock, not the request's: a later candidate must not carry
  // the time the earlier ones spent. The row keeps the request's separately.
  const tryMillis = Math.max(0, Date.now() - input.tryStartedAt);
  return {
    id: input.requestId,
    time: new Date(input.startedAt).toISOString(),
    asked: input.requestedModel,
    served,
    model: served,
    // The seat's parts, as the Routing page draws them: `served` joins them
    // for its title, and the try keeps them apart for its badge.
    tries: [
      {
        provider: input.candidate.provider.id,
        model: input.candidate.model.id,
        done: true,
        status: input.status,
        millis: tryMillis,
        error: tryErrorOf(input),
      },
    ],
    done: true,
    status: input.status,
    millis: Math.max(0, Date.now() - input.startedAt),
    client: clientOfUserAgent(input.userAgent),
    ...(input.session === null ? {} : { session: input.session }),
    ...(input.ok ? {} : { error: `HTTP ${input.status}` }),
    ...traceExtras(input),
    ...(input.titleLink === undefined
      ? {}
      : {
          titleLink: {
            ...input.titleLink,
            ...(replyDigest === undefined ? {} : { reply: replyDigest }),
          },
        }),
  };
}

function recordAttempt(input: RecordAttemptInput): void {
  const cost = usageCost({
    config: input.config,
    providerId: input.candidate.provider.id,
    modelId: input.candidate.model.id,
    catalog: input.pricing,
    at: input.startedAt,
    usage: input.usage ?? ZERO_USAGE,
    cacheInPrompt: input.upstreamProtocol !== "anthropic",
  });
  offerTraceBodies(input);
  input.ledger.record(usageRecordOf(input, cost));
  keepPromptBody(input.requestId, input.upstreamProtocol, input.upstreamBody);
  const route = routeRowOf(input);
  input.history?.record(route);
  publishRoute(route);
}

interface ApplyQuotaInput {
  config: GatewayConfig;
  pricing: PricingCatalog | null;
  upstream: globalThis.Response;
  candidate: GatewayCandidate;
  account: GatewayAccount | null;
  usage: IrUsage | null;
  /** The protocol the call went upstream in, which says how cache tokens are counted. */
  protocol: GatewayProtocol;
  quotaTracker: QuotaTracker;
  routingState: RoutingState;
  accountState: AccountRoutingState;
  now: number;
}

/**
 * Keeps an account out of rotation once its allowance is gone: either the caps
 * configured for it, or the remaining budget the vendor reported in headers.
 * A streamed passthrough reply records no usage, so only header quotas apply
 * there.
 */
function applyAccountQuota(input: ApplyQuotaInput): void {
  const { account, candidate, now, quotaTracker, routingState } = input;
  if (account === null) {
    return;
  }
  const key = accountKey(candidate.provider, account);
  addAccountSpend(
    input.accountState,
    candidate.provider,
    account,
    usageCost({
      config: input.config,
      providerId: candidate.provider.id,
      modelId: candidate.model.id,
      catalog: input.pricing,
      at: now,
      usage: input.usage ?? ZERO_USAGE,
      cacheInPrompt: input.protocol !== "anthropic",
    }).costUsd,
    now,
  );
  const tokens = input.usage === null ? 0 : input.usage.inputTokens + input.usage.outputTokens;
  quotaTracker.record(key, now, tokens);
  const restedUntil = quotaTracker.restedUntil(key, now, account.quota ?? {});
  if (restedUntil !== null) {
    routingState.rest.rest(key, Math.max(0, restedUntil - now), now);
  }
  const snapshot = quotaFromHeaders(input.upstream.headers, now);
  if (snapshot !== null && isExhausted(snapshot)) {
    const until = snapshot.resetAt ?? now + 60_000;
    routingState.rest.rest(key, Math.max(0, until - now), now);
  }
}

function clearStickyOnFailure(
  state: RoutingState,
  conversationKey: string | null,
  candidate: GatewayCandidate,
): void {
  if (conversationKey === null) {
    return;
  }
  const bound = state.sticky.get(conversationKey);
  if (bound !== undefined && parseSticky(bound).candidateKey === candidateKey(candidate)) {
    state.sticky.delete(conversationKey);
  }
}

/** A conversation keeps the account that answered it when that account can serve. */
function orderAccountsForConversation(
  accounts: GatewayAccount[],
  candidate: GatewayCandidate,
  state: RoutingState,
  conversationKey: string | null,
): GatewayAccount[] {
  if (conversationKey === null || accounts.length < 2) {
    return accounts;
  }
  const bound = state.sticky.get(conversationKey);
  if (bound === undefined) {
    return accounts;
  }
  const binding = parseSticky(bound);
  if (binding.candidateKey !== candidateKey(candidate) || binding.accountId === null) {
    return accounts;
  }
  const index = accounts.findIndex((account) => account.id === binding.accountId);
  if (index <= 0) {
    return accounts;
  }
  const preferred = accounts[index];
  if (preferred === undefined) {
    return accounts;
  }
  return [preferred, ...accounts.slice(0, index), ...accounts.slice(index + 1)];
}

type ThinkingRetry =
  | { kind: "skipped" }
  | { kind: "delivered"; upstream: globalThis.Response }
  | { kind: "failed"; status: number | null };

async function maybeRetryWithoutThinking(
  input: OneAttemptContext,
  upstream: globalThis.Response,
): Promise<ThinkingRetry> {
  if (upstream.status !== 400 || !hasThinkingParams(input.attemptBody)) {
    return { kind: "skipped" };
  }
  const retried = await retryWithoutThinking(input, upstream);
  if (retried === null) {
    return { kind: "failed", status: null };
  }
  if (shouldFailover(retried.status)) {
    await retried.body?.cancel();
    return { kind: "failed", status: retried.status };
  }
  return { kind: "delivered", upstream: retried };
}

function hasThinkingParams(body: Record<string, unknown>): boolean {
  return body.thinking !== undefined || body.output_config !== undefined;
}

async function retryWithoutThinking(
  input: OneAttemptContext,
  upstream: globalThis.Response,
): Promise<globalThis.Response | null> {
  await upstream.body?.cancel();
  const retryBody: Record<string, unknown> = { ...input.attemptBody };
  delete retryBody.thinking;
  delete retryBody.output_config;
  try {
    return await requestUpstream(retryRequest(input, retryBody));
  } catch {
    return null;
  }
}
