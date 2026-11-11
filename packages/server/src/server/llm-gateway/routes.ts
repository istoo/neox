import { createHash, randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { join } from "node:path";
import * as nodeV8 from "node:v8";
import express, {
  type Request as ExpressRequest,
  type Response as ExpressResponse,
  type Router,
} from "express";
import type { Logger } from "pino";
import { z } from "zod";
import type { McpauthService } from "../mcpauth/mcpauth.js";
import { isGatewayMcpPath, serveSignedInMcp } from "../mcpauth/relay.js";
import {
  accountKey,
  allAccountsCreditLast,
  planAccounts,
  providerAtCap,
  type AccountRoutingState,
} from "./accounts.js";
import {
  allowsReadOnly,
  checkAccess,
  combineAccountFilters,
  keyAccountFilter,
  modelCovers,
  quotaScopeAllows,
  RateLimiter,
  readPresentedKey,
  resolvePrincipal,
  resolvePrincipalWithReason,
  type GatewayPrincipal,
} from "./access.js";
import { isLocalRequest, refuseNotAllowed } from "./allow.js";
import { currentOmarchyTheme } from "./omarchy.js";
import { snapshotGatewayQuota } from "./quota-cards.js";
import { observeTitleRequest, TITLE_KINDS } from "./title-link.js";
import { resolveDaemonVersion } from "../daemon-version.js";
import { setFetchPrivate } from "./vision-fetch.js";
import { refuseInvalidKey } from "./auth-throttle.js";
import { applyGatewayCors, isListedPreflight, omarchySiteOrigin } from "./cors.js";
import { eventsFromResponse } from "./assemble.js";
import {
  factoryWireLeft,
  fallbackCandidates,
  listGatewayModels,
  resolveGatewayCandidates,
  type GatewayCandidate,
} from "./catalog.js";
import {
  busy,
  maxWaits,
  noteBusy,
  PATIENCE_LONGEST_S,
  replan,
  retryAfterMs,
  SINGLE_PATIENCE_MS,
  waitsOf,
  type BusyTry,
} from "./patience.js";
import { groupByRequest } from "./groups-auto.js";
import { restForFailure } from "./provider-limits.js";
import {
  chatGptAccount,
  forVendor,
  fromLite,
  keepsAccessPrograms,
  liteKept,
  onOpenAiHost,
  withoutAccessPrograms,
} from "./codex-lite.js";
import { codexRequestAsSent, loadsAdditionalToolsInPlace } from "./provider-shaping.js";
import {
  COPILOT_AUTO,
  copilotApisOf,
  copilotAutoPick,
  copilotEndpointFallbacks,
  invalidateSession,
  markRefused,
  type CopilotAccountRef,
  type CopilotAutoPick,
  type CopilotProtocol,
  type CopilotRefusal,
} from "./copilot-auto.js";
import { loadSubscriptionAccount } from "./subscription-auth.js";
import { imageWaitMs } from "./images-draw.js";
import { disabledCandidateRefusal, disabledRequestRefusal } from "./model-prefs.js";
import { maskRouteFor } from "./mask-route.js";
import type { ClaudeBridge } from "./claude/bridge.js";
import { parseClaudeCallbackBody } from "./claude/callback.js";
import {
  claudeServeError,
  type ClaudeTextRestorer,
  defaultClaudeConfigDir,
  serveClaudeSubscription,
} from "./claude/serve.js";
import {
  groupAccountFilter,
  planRequestCandidates,
  readRuleContext,
  type PlannedRequestCandidates,
} from "./group-rules.js";
import {
  accountDiscoveryOn,
  GatewayKeyLimitSchema,
  gatewayKeyEntries,
  providerAccounts,
  newGatewayKeyId,
  type GatewayAccount,
  type GatewayConfig,
  type GatewayConfigStore,
  type GatewayGroup,
  type GatewayKeyLimit,
  type GatewayProvider,
} from "./config.js";
import { limitsOf, reserveBudget, statusesOf, type Reservation } from "./budget.js";
import {
  codexSideKind,
  descriptionJSON,
  encryptedSummary,
  hasCompactionTrigger,
  localCompactionTurn,
  localFallbackSummary,
  plainSummaryBody,
  predictionJSON,
  responseId,
  responseStatus,
  responseText,
  responseUsage,
  retrySummaryAsText,
  rewriteCodexInput,
  answerCalledTool,
  summaryJSON,
  titleJSON,
  titleShapeOf,
  TURN_METADATA_HEADER,
  type CodexSideKind,
} from "./codex-compaction.js";
import { runCandidateAttempts, type CandidateAttemptResult } from "./attempts.js";
import { pipeRestored, pipeUpstream, startEventStream } from "./deliver.js";
import { assertRecord, isRecord, type IrRequest } from "./ir.js";
import {
  maskingWanted,
  masksRequests,
  MaskingUnavailableError,
  type MaskHit,
  type Masker,
  type RestoreCounts,
} from "./masking.js";
import type { MaskingRecordStore } from "./masking-records.js";
import { calcConvert, calcDate, calcEval } from "./calc.js";
import { HookRuntime } from "./hooks.js";
import type { GatewayConversations } from "./conversations.js";
import { CurrentImageError } from "./vision-images.js";
import { serveVisionMcp } from "./vision-mcp.js";
import type { MediaMcp, MediaSend } from "./media-mcp.js";
import type { RouteHistory } from "./route-history.js";
import { captureRawBody, type GatewayArchive } from "./gateway-archive.js";
import { promptBody } from "./prompt-text.js";
import { routeCursor, routesAfter } from "./route-events.js";
import { VISION_USER_AGENT, type VisionSend, type VisionService } from "./vision.js";
import { KEY_PAGE_HTML } from "./key-page.js";
import { configuredOidcRules, matchOidcToken, oidcKeyName, resolveOidcIssuer } from "./oidc.js";
import type { SearchLedger } from "./search.js";
import {
  askSearchApi,
  pagesSaid,
  readySearchApis,
  searchKeys,
  SearchApiError,
  SearchKeyPicker,
  type FoundPage,
  type SearchApiConfig,
} from "./search-apis.js";
import { lastUserText, wantsWebSearch, withSearchResults } from "./web-search.js";
import { providerCanSearch, searchesForAll, searchSteps } from "./search-plan.js";
import {
  providerSearchFound,
  searchWithProvider,
  SEARCH_TIMEOUT_MS,
  type ProviderSearchRequest,
} from "./provider-search.js";
import { withoutRefusedShapes } from "./anthropic-shapes.js";
import { needsThinking, withThinkingEnabled } from "./thinking-needed.js";
import { unsaltRequestIds } from "./tool-use-ids.js";
import { withoutClaudeSeals } from "./claude-seal.js";
import { withoutRefusedBodyBetas } from "./betas.js";
import {
  isGeminiCompat,
  withoutCallSignatures,
  withGeminiCallSignatures,
} from "./gemini-compat.js";
import { unsignCallId } from "./gemini-signature.js";
import { configureSigstore } from "./sigstore.js";
import { isGrokLike, withSealedReasoning } from "./reasoning-carry.js";
import {
  continueIfAssistantLast,
  dropBillingLine,
  fitAdvisor,
  fitAutomode,
  namesThread,
  threadRefusal,
} from "./claude-compat.js";
import { withMaxOutput } from "./token-limits.js";
import { fillThinkingBack, needsThinkingBack } from "./thinking-back.js";
import { getLibraryHub } from "../library/hub-registry.js";
import { codexCatalogEntries, type CodexCatalogModel } from "../codex-catalog.js";
import { codexLeadModel, noteCodexLead } from "./codex-leads.js";
import { hubInstructions, hubToolNames } from "../library/hub.js";
import { drawImageFor } from "./images-draw.js";
import { handleVideoContent, handleVideoGet, handleVideosCreate, videoModelsOf } from "./video.js";
import {
  BROWSER_EXTENSION_ID,
  defaultExtensionDirectory,
  serveBrowserMcp,
  writeBrowserExtension,
  type BrowserRelay,
} from "./browser.js";
import { BROWSER_FILES_PATH, BROWSER_FILE_TOKEN } from "./browser-files.js";
import type { UsagePoller } from "./usage-poller.js";
import { readCodexSignIn, renewCodexSignIn } from "./codex-user-data.js";
import { pooledCodexSignIn, type PooledSignIn } from "./codex-accounts.js";
import { CODEX_OWN_LIMIT_KEY, noteCodexLimits, parseCodexLimitHeaders } from "./codex-limits.js";
import { codecFor } from "./protocols.js";
import {
  ANTIGRAVITY_FORESEEN_MS,
  ANTIGRAVITY_TURNED_AWAY_ERR_TYPE,
  ANTIGRAVITY_TURNED_AWAY_STATUS,
  antigravityHint,
  antigravityTurnsAway,
} from "./codeassist.js";
import { QuotaTracker } from "./quota.js";
import { isCreditFailure } from "./rests.js";
import { handsOver, type RefusalHandover } from "./refusal-handover.js";
import { loopErrorEvent } from "./loop-guard.js";
import { summarizePrompt, type RouteSeat } from "./route-trace.js";
import { createGatewayRuntime, snapshotGatewayStatus, type GatewayRuntime } from "./runtime.js";
import {
  candidateKey,
  planCandidates,
  planPluginStrategy,
  strategyFor,
  type RoutingState,
} from "./routing.js";
import { applyExtraBody } from "./extra-body.js";
import { isGatewayRequestPath } from "./gateway-paths.js";
import { applyReplyHeaders } from "./header-passthrough.js";
import { offlineDetector } from "./offline.js";
import { readCareful } from "./cap-careful.js";
import { scheduleRestProbe } from "./rest-probe.js";
import { BodyRoom, createBodyRoomMiddleware } from "./body-room.js";
import { createDecodedBodyMiddleware } from "./request-bounds.js";
import { IdleMemory } from "./idle-memory.js";
import { createTurnMiddleware } from "./turn-middleware.js";
import type { TurnTracker } from "./turndone.js";
import { shapeTools } from "./tool-shapes.js";
import { imageToolRefusedBefore, withoutImageToolRequest } from "./image-tool.js";
import { mayLoop, toolLoopNotice, toolLoopOf, type ToolLoop } from "./tool-loop.js";
import { chatCallIds } from "./chat-call-ids.js";
import { xaiBody } from "./vendor-shaping.js";
import { CodexWeekReset } from "./codex-reset-run.js";
import { codexOwnRedirect } from "./codex-own-v1.js";
import { searchAsFunction } from "./toolsearch.js";
import { claudeSignInFailure, isClaudeSignIn } from "./claude/signin.js";
import { chatTextParts } from "./chat-text-parts.js";
import { withPlaceholderNote } from "./placeholder-note.js";
import { fixToolRefusals, toolRefusalsFor } from "./refusals.js";
import { clientOfUserAgent, type UsageLedger } from "./usage.js";
import {
  buildUpstreamHeaders,
  shouldFailover,
  type GatewayProtocol,
  type UpstreamWire,
} from "./upstream.js";

const MAX_BODY_SIZE = "512mb";

/**
 * The router's own calls — its classifier asking a model through the gateway —
 * carry this User-Agent and a per-process token. Loopback is required as well:
 * the token never leaves the process except on a request to itself.
 */
const ROUTER_USER_AGENT = "neolix-router/1";
const ROUTER_CALL_HEADER = "x-neolix-gateway-internal";
const ROUTER_CALL_TOKEN = randomUUID();
const LOCAL_SOCKET_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

const ROUTER_PRINCIPAL: GatewayPrincipal = {
  key: null,
  label: "router",
  models: [],
  dailyTokens: null,
  monthlyUsd: null,
  limits: [],
  ratePerMinute: null,
  searchCallsPerMonth: null,
  readOnly: false,
  issues: false,
  issuer: null,
};

function isRouterCall(req: ExpressRequest): boolean {
  if (req.headers[ROUTER_CALL_HEADER] !== ROUTER_CALL_TOKEN) {
    return false;
  }
  // A socket without an address is a Unix socket, which only local
  // processes reach.
  const address = req.socket.remoteAddress;
  return address === undefined || LOCAL_SOCKET_ADDRESSES.has(address);
}

/** The router's own calls are the gateway's, not a key's. */
function gatewayPrincipal(req: ExpressRequest, config: GatewayConfig): GatewayPrincipal | null {
  return isRouterCall(req) ? ROUTER_PRINCIPAL : resolvePrincipal(req, config);
}

/** A failed call to the gateway itself, its status and body kept. */
class GatewaySelfError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`Gateway answered ${status}`);
    this.name = "GatewaySelfError";
  }
}

const CompletionBodySchema = z.object({ model: z.string().min(1) }).passthrough();

const IssueKeyBodySchema = z
  .object({
    label: z.string().min(1).optional(),
    models: z.array(z.string().min(1)).default([]),
    dailyTokens: z.number().int().positive().optional(),
    monthlyUsd: z.number().positive().optional(),
    /** Budget windows for the issued key, at most its issuer's own caps. */
    limits: z.array(GatewayKeyLimitSchema).max(5).optional(),
    ratePerMinute: z.number().int().positive().optional(),
    expiresAt: z.string().optional(),
    readOnly: z.boolean().default(false),
  })
  .passthrough();
type CompletionBody = z.infer<typeof CompletionBodySchema>;

export interface GatewayRouterOptions {
  configStore: GatewayConfigStore;
  /** Where long signatures are kept; omitted turns keeping off. */
  neolixHome?: string;
  masker: Masker;
  /** What masking swapped, for the settings page; omitted in tests. */
  maskingRecords?: MaskingRecordStore;
  ledger: UsageLedger;
  logger: Logger;
  /** Shared with the settings RPC; a fresh one is created when omitted. */
  runtime?: GatewayRuntime;
  searchLedger?: SearchLedger;
  /** The extension bridge; browser tools are local when it is present. */
  browser?: BrowserRelay;
  /** Opt-in local copies of gateway conversations; omitted in tests. */
  conversations?: GatewayConversations;
  /** Reads an account's usage endpoint again for a careful cap; omitted in tests. */
  usagePoller?: UsagePoller;
  /**
   * Whether Codex's own provider is off (or removed) in the agent settings:
   * its sign-in is then left to Codex, never refreshed or written back.
   */
  codexLeftAlone?: () => boolean;
  /** Image recognition; omitted in tests and when the daemon did not start it. */
  vision?: VisionService;
  /** The image generation MCP server; omitted in tests. */
  media?: MediaMcp;
  /** The routing history on disk; omitted in tests. */
  history?: RouteHistory;
  /** The request archive on this computer; omitted in tests. */
  archive?: GatewayArchive;
  /** Follows gateway-served turns for the "done" notification; omitted in tests. */
  turnTracker?: TurnTracker;
  /**
   * The Claude subscription bridge: accounts whose agent is `claude-code` are
   * served by a real Claude Code. Omitted in tests and where none is set up.
   */
  claude?: ClaudeGatewayOptions;
  /** The Library's OAuth sign-ins to remote MCP servers; /mcp/<name> relays
   * to a signed-in server with its token (myna internal/gateway/mcp.go). */
  mcpauth?: McpauthService;
  /** The fetch Copilot's Auto asks through; tests inject one. */
  copilotFetch?: typeof fetch;
}

export interface ClaudeGatewayOptions {
  bridge: ClaudeBridge;
  /** The absolute path of mcp-helper.mjs. */
  helperPath: string;
  /** Where the helper calls back, without a trailing slash. */
  callbackBaseUrl: () => string;
  /** An account's CLAUDE_CONFIG_DIR; absent is the machine's sign-in. */
  claudeConfigDir?: (accountConfigDir?: string) => string;
  workDir?: string;
}

const BARE_GET_PATHS = new Set(["/models"]);
const BARE_POST_PATHS = new Set([
  "/chat/completions",
  "/responses",
  "/messages",
  "/messages/count_tokens",
  "/images/generations",
  "/images/edits",
  "/embeddings",
  "/rerank",
  "/videos",
  "/audio/speech",
  "/audio/transcriptions",
  "/audio/translations",
  "/alpha/search",
]);

function isBareGatewayPath(method: string, path: string): boolean {
  if (method === "GET") {
    return BARE_GET_PATHS.has(path) || path.startsWith("/models/") || path.startsWith("/videos/");
  }
  if (method === "POST") {
    return BARE_POST_PATHS.has(path) || path.startsWith("/videos/");
  }
  return false;
}

export function createGatewayRouter(options: GatewayRouterOptions): Router {
  configureSigstore(options.neolixHome ?? null);
  // Downloads of URLs the gateway did not choose (an image a request names, a
  // page web_fetch reads) may reach only public addresses unless the user's
  // fetchPrivate names the host or range.
  const applyFetchPrivate = (config: GatewayConfig): void => setFetchPrivate(config.fetchPrivate);
  applyFetchPrivate(options.configStore.get());
  options.configStore.onChange(applyFetchPrivate);
  const router = express.Router();
  // body-parser's verify hook is (req, res, buf): the archive keeps the bytes.
  const keepRawBody = (req: ExpressRequest, _res: ExpressResponse, buf: Buffer): void =>
    captureRawBody(req, buf);
  const jsonBody = express.json({ limit: MAX_BODY_SIZE, verify: keepRawBody });
  const runtime = options.runtime ?? createGatewayRuntime(options.ledger);
  const routingState = runtime.routingState;
  const accountState = runtime.accountState;
  const quotaTracker = runtime.quotaTracker;
  const rateLimiter = runtime.rateLimiter;
  const bodyRoom = new BodyRoom();
  const idleMemory = new IdleMemory();

  // This router sits on the daemon's own port, beside its routes. Leave
  // everything the gateway doesn't answer to them: the app's API, its
  // pairing and sign-in chain are judged by Neolix's auth, not by a gateway
  // key (myna serves the gateway on a port of its own).
  router.use((req, _res, next) => {
    if (isGatewayRequestPath(req.path) || isGatewayMcpPath(req.path)) {
      next();
      return;
    }
    next("router");
  });

  // The allow list judges the connection's own address before anything else
  // looks at the request (myna's lanGuard): a leaked key is of no use from an
  // address left out of it.
  router.use((req, res, next) => {
    if (refuseNotAllowed(req, res, options.configStore.get())) {
      return;
    }
    next();
  });

  // The request archive on this computer: off unless `archive.local` is on.
  if (options.archive !== undefined) {
    router.use(options.archive.middleware(options));
  }

  // Myna answers both /v1/... and the bare path, for clients whose base URL
  // already carries the version.
  router.use((req, _res, next) => {
    if (isBareGatewayPath(req.method, req.path)) {
      req.url = `/v1${req.url}`;
    }
    next();
  });

  router.use((req, res, next) => {
    const config = options.configStore.get();
    if (!config.enabled) {
      res.status(404).json({ error: { message: "LLM gateway is disabled", type: "not_found" } });
      return;
    }
    // The key page and the OIDC exchange are reached without a gateway key:
    // the first shows a login box, the second carries a signed token. A
    // recording's link is its own credential, as myna's made files are. A
    // listed origin's preflight carries no key either (CORS forbids one on
    // it); the CORS rules answer it behind this check.
    const keyless =
      req.path === "/me" ||
      (req.method === "POST" && req.path === "/v1/myna/keys/oidc") ||
      browserFileAsked(req) ||
      isListedPreflight(req, config);
    const principal = gatewayPrincipal(req, config);
    if (principal === null && !keyless) {
      // A key the gateway knows but can no longer honour says why, as myna's
      // 401 does; an unknown key stays as uninformative as before.
      const refusal = resolvePrincipalWithReason(req, config).refusal;
      if (refusal !== null) {
        res.status(401).json({ error: { message: refusal, type: "unauthorized" } });
        return;
      }
      // Only failed remote authentications are capped: a valid key, and this
      // computer's own callers, never touch the bucket (myna's auththrottle).
      if (!isLocalRequest(req)) {
        refuseInvalidKey(res);
        return;
      }
      res.status(401).json({ error: { message: "Invalid gateway key", type: "unauthorized" } });
      return;
    }
    if (principal !== null && principal.readOnly && !allowsReadOnly(req.method, req.path)) {
      res.status(403).json({
        error: { message: "This key is read-only", type: "read_only_key" },
      });
      return;
    }
    next();
  });

  // An authenticated completion is an agent's turn: follow its reply as it
  // streams for the "done" notification (myna's turndone).
  if (options.turnTracker !== undefined) {
    router.use(createTurnMiddleware(options.turnTracker));
  }

  // Pages the user listed get CORS headers and must carry a key; any other
  // web page is refused (myna's corsGuard).
  router.use((req, res, next) => {
    const config = options.configStore.get();
    const principal = resolvePrincipal(req, config);
    const keyed = principal !== null && principal.key !== null;
    const outcome = applyGatewayCors(req, res, config, keyed);
    if (outcome.done) {
      return;
    }
    next();
  });

  // Room for bodies held at once, taken before any parser reads one
  // (myna's body_room.go), and a zstd body decoded before body-parser sees it
  // (myna's request_bounds.go).
  router.use(createBodyRoomMiddleware(bodyRoom, options.logger));
  router.use(createDecodedBodyMiddleware());
  router.use((_req, res, next) => {
    idleMemory.begin();
    res.once("close", () => idleMemory.end());
    next();
  });

  router.get("/me", (_req, res) => {
    res.setHeader(
      "content-security-policy",
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    res.setHeader("x-frame-options", "DENY");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("cache-control", "no-cache");
    res.type("text/html").send(KEY_PAGE_HTML);
  });

  router.get("/v1/myna/me", (req, res) => {
    const config = options.configStore.get();
    const principal = resolvePrincipal(req, config);
    if (principal === null || principal.key === null) {
      res
        .status(401)
        .json({ error: { message: "Send an enabled gateway key", type: "unauthorized" } });
      return;
    }
    const now = Date.now();
    res.setHeader("cache-control", "no-store");
    res.json({
      key: maskKey(principal.key),
      label: principal.label,
      readOnly: principal.readOnly,
      models: principal.models,
      dailyTokens: principal.dailyTokens,
      monthlyUsd: principal.monthlyUsd,
      limits: statusesOf(
        options.configStore.get(),
        principal.key,
        new Date(now),
        options.ledger.filePath,
      ),
      ratePerMinute: principal.ratePerMinute,
      searchCallsPerMonth: principal.searchCallsPerMonth,
      spentThisMonthUsd: options.ledger.spentThisMonthForKey(principal.key, now),
      tokensToday: options.ledger.tokensToday(principal.key, now),
      recent: options.ledger
        .recentEntries()
        .filter((entry) => entry.key === principal.key)
        .map((entry) => ({
          time: entry.time,
          requested: entry.requested,
          model: entry.model,
          status: entry.status,
          inputTokens: entry.inputTokens,
          outputTokens: entry.outputTokens,
        })),
    });
  });

  router.delete("/v1/myna/keys/:id", (req, res) => {
    runGatewayHandler(
      () =>
        revokeIssuedKey({
          req,
          res,
          id: typeof req.params.id === "string" ? req.params.id : "",
          configStore: options.configStore,
        }),
      res,
      options.logger,
    );
  });

  router.get("/v1/myna/claude-runs", (req, res) => {
    if (!authenticateRead(req, res, options.configStore.get())) return;
    if (!isLocalRequest(req)) {
      res.status(403).json({ error: { message: "Claude runs are listed on this computer only" } });
      return;
    }
    res.json(
      options.claude?.bridge.describeRuns() ?? {
        object: "claude-runs",
        runs: [],
        live: 0,
        most: 0,
        mostWhy: "",
        idleMost: 6,
        idleForMs: 60 * 60_000,
      },
    );
  });

  // The bridge's MCP helper hands each of the caller's tool calls here and
  // blocks on the answer, as myna's `/myna/claude-mcp/` does. The token in
  // the path is the run's own, made for it and handed over in a private file.
  router.post("/_neolix/claude-mcp/:token", jsonBody, (req, res) => {
    runGatewayHandler(
      async () => {
        if (options.claude === undefined) {
          res.status(404).json({ error: "The Claude subscription bridge is not running" });
          return;
        }
        if (!isLocalRequest(req)) {
          res.status(403).json({ error: "Claude tool calls are answered on this computer only" });
          return;
        }
        const body = parseClaudeCallbackBody(req.body);
        if (body === null) {
          res.status(400).json({ error: "invalid tool call" });
          return;
        }
        const answer = await options.claude.bridge.handleToolCall({
          token: req.params.token ?? "",
          toolCallId: body.toolCallId,
          name: body.name,
          arguments: body.arguments,
        });
        res.status(answer.status).json(answer.body);
      },
      res,
      options.logger,
    );
  });

  router.get("/v1/myna/mcp", (req, res) => {
    if (!authenticateRead(req, res, options.configStore.get())) return;
    const configured = options.configStore.get().mcp ?? {};
    res.json({
      object: "list",
      data: Object.entries(configured).map(([name, url]) => ({ name, url })),
    });
  });

  router.get("/v1/myna/browser", (req, res) => {
    if (options.browser === undefined) {
      res.status(404).json({ error: { message: "The browser bridge is not running" } });
      return;
    }
    if (!loopbackRequest(req)) {
      res.status(403).json({ error: { message: "Browser state is told on this computer only" } });
      return;
    }
    res.json(options.browser.status());
  });

  router.post("/v1/myna/browser/setup", jsonBody, (req, res) => {
    runGatewayHandler(
      async () => {
        if (!loopbackRequest(req)) {
          res
            .status(403)
            .json({ error: { message: "The extension is written on this computer only" } });
          return;
        }
        const body = isRecord(req.body) ? req.body : {};
        const directory =
          typeof body.dir === "string" && body.dir.length > 0
            ? body.dir
            : defaultExtensionDirectory();
        const secure = (req.socket as { encrypted?: boolean }).encrypted === true;
        const host = typeof req.headers.host === "string" ? req.headers.host : "127.0.0.1";
        const result = await writeBrowserExtension(
          directory,
          `${secure ? "https" : "http"}://${host}`,
        );
        res.json(result);
      },
      res,
      options.logger,
    );
  });

  // A recording the browser bridge made. Its link is a credential of its
  // own; otherwise the key that had it made, or this computer, opens it.
  router.all(`${BROWSER_FILES_PATH}:name`, (req, res) => {
    if (options.browser === undefined) {
      res.status(404).json({ error: { message: "The browser bridge is not running" } });
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.setHeader("allow", "GET, HEAD");
      res.status(405).json({ error: { message: "GET a recording here" } });
      return;
    }
    // Served to agents and people, not to a web page that learned the link.
    if (!browserFileOriginAllowed(req)) {
      res
        .status(403)
        .json({ error: { message: "Neox's recordings are served to agents, not web pages" } });
      return;
    }
    const config = options.configStore.get();
    const token = req.query[BROWSER_FILE_TOKEN];
    const file = options.browser.files.read({
      name: typeof req.params.name === "string" ? req.params.name : "",
      token: typeof token === "string" ? token : null,
      key: resolvePrincipal(req, config)?.key ?? null,
      local: loopbackRequest(req),
      keyLive: (key) => keyIsLive(config, key),
    });
    if (!file.ok) {
      res.status(file.status).json({ error: { message: file.message } });
      return;
    }
    res.setHeader("content-type", file.mime);
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("cache-control", "private, max-age=3600");
    res.setHeader("content-length", String(file.data.length));
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    res.end(file.data);
  });

  router.get("/v1/myna/heap", (req, res) => {
    if (!authenticateRead(req, res, options.configStore.get())) return;
    sendHeap(res);
  });
  router.get("/v1/myna/cpu", (req, res) => {
    runGatewayHandler(() => sendCpuProfile(req, res), res, options.logger);
  });
  router.get("/v1/myna/goroutines", (req, res) => {
    if (!authenticateRead(req, res, options.configStore.get())) return;
    res.json({
      object: "list",
      uptimeSeconds: Math.round(process.uptime()),
      resources: process.getActiveResourcesInfo(),
    });
  });
  router.post("/v1/myna/restart", jsonBody, (req, res) => {
    if (!authenticateRead(req, res, options.configStore.get())) return;
    const body = isRecord(req.body) ? req.body : {};
    const version = "0.15.0";
    const requested = typeof body.version === "string" ? body.version : "";
    // Browsers announce themselves; a web page never restarts the daemon.
    const userAgent = req.headers["user-agent"] ?? "";
    const fromBrowser =
      req.headers.origin !== undefined ||
      req.headers["sec-fetch-site"] !== undefined ||
      req.headers["sec-fetch-mode"] !== undefined ||
      userAgent.startsWith("Mozilla/");
    const remote = req.socket.remoteAddress ?? "";
    const loopback = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote);
    if (!loopback) {
      res.status(403).json({
        error: {
          code: null,
          message: "Neox restarts only when a program on this computer asks, over loopback",
          param: null,
          type: "permission_error",
        },
      });
      return;
    }
    if (fromBrowser) {
      res.status(403).json({
        error: {
          code: null,
          message: "Neox does not restart when a web page asks: restart the daemon from a terminal",
          param: null,
          type: "permission_error",
        },
      });
      return;
    }
    // Under the supervisor, `neolix:restart` respawns the worker; a request
    // for the running version is already satisfied.
    if (typeof process.send === "function") {
      if (requested.length === 0 || requested === version) {
        res.json({ state: "current", version });
        return;
      }
      process.send({ type: "neolix:restart", reason: "api_update" });
      options.logger.info({ version: requested }, "Restarting for an update");
      res.json({ state: "restarting", version });
      return;
    }
    options.logger.info({ version: requested }, "Restart requested without a supervisor");
    res.json({ state: "unsupported", version });
  });

  // The Library's MCP hub: one server per agent, its tools named
  // <server>__<tool>; /mcp/myna/hub is kept for configs myna wrote.
  for (const base of ["/mcp/neox/hub", "/mcp/myna/hub"]) {
    router.post([base, `${base}/:agent`], jsonBody, (req, res) => {
      runGatewayHandler(
        () =>
          serveLibraryHub({ req, res, configStore: options.configStore, logger: options.logger }),
        res,
        options.logger,
      );
    });
    // Streamable HTTP's GET is the server's own stream; the hub sends
    // nothing of its own, only keeps the stream open as clients expect.
    router.get([base, `${base}/:agent`], (req, res) => {
      if (resolvePrincipal(req, options.configStore.get()) === null) {
        res.status(401).end();
        return;
      }
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(": connected\n\n");
      const timer = setInterval(() => res.write(": ping\n\n"), 15_000);
      timer.unref?.();
      req.on("close", () => clearInterval(timer));
    });
  }

  for (const prefix of ["/mcp/myna/:name", "/mcp/run/:name", "/mcp/:name"]) {
    router.post([prefix, `${prefix}/*`], jsonBody, (req, res) => {
      runGatewayHandler(
        () =>
          proxyMcp({
            req,
            res,
            configStore: options.configStore,
            searchLedger: options.searchLedger,
            ledger: options.ledger,
            logger: options.logger,
            browser: options.browser,
            masker: options.masker,
            maskingRecords: options.maskingRecords,
            vision: options.vision,
            media: options.media,
            mcpauth: options.mcpauth,
          }),
        res,
        options.logger,
      );
    });
  }

  // Streamable HTTP's GET is the server's own stream, and its DELETE ends
  // the session: relayed only for a server Neolix signed in to, so an agent
  // given /mcp/<name> can use the server as it does any other.
  for (const method of ["get", "delete"] as const) {
    router[method](["/mcp/:name", "/mcp/:name/*"], (req, res) => {
      if (resolvePrincipal(req, options.configStore.get()) === null) {
        res.status(401).end();
        return;
      }
      runGatewayHandler(
        async () => {
          const relayed = await serveSignedInMcp({
            req,
            res,
            logger: options.logger,
            mcpauth: options.mcpauth,
          });
          if (!relayed) {
            res.status(404).type("text/plain").send("No such MCP server");
          }
        },
        res,
        options.logger,
      );
    });
  }

  router.post("/v1/myna/keys/oidc", jsonBody, (req, res) => {
    runGatewayHandler(
      () => issueOidcKey({ req, res, configStore: options.configStore, logger: options.logger }),
      res,
      options.logger,
    );
  });

  router.post("/v1/alpha/search", jsonBody, (req, res) => {
    runGatewayHandler(
      () =>
        forwardSearch({
          req,
          res,
          configStore: options.configStore,
          searchLedger: options.searchLedger,
          ledger: options.ledger,
          logger: options.logger,
          masker: options.masker,
          maskingRecords: options.maskingRecords,
        }),
      res,
      options.logger,
    );
  });

  // An image the image MCP made, opened by the token in its URL: a model
  // hands the link to a person, and a browser sends no key. A recording the
  // browser bridge made is served here too, under myna's same path: the
  // token is the same kind of credential, and the image store is asked only
  // when it has no such file.
  router.get("/mcp/myna/image/files/:name", (req, res) => {
    const name = typeof req.params.name === "string" ? req.params.name : "";
    const token = typeof req.query.t === "string" ? req.query.t : "";
    if (options.browser !== undefined) {
      const config = options.configStore.get();
      const file = options.browser.files.read({
        name,
        token,
        key: resolvePrincipal(req, config)?.key ?? null,
        local: loopbackRequest(req),
        keyLive: (key) => keyIsLive(config, key),
      });
      if (file.ok) {
        res.setHeader("content-type", file.mime);
        res.setHeader("x-content-type-options", "nosniff");
        res.setHeader("cache-control", "private, max-age=3600");
        res.setHeader("content-length", String(file.data.length));
        res.end(file.data);
        return;
      }
    }
    if (options.media === undefined) {
      res.status(404).end();
      return;
    }
    options.media.serveFile(name, token, res);
  });

  router.post("/mcp/myna/web-search", jsonBody, (req, res) => {
    runGatewayHandler(
      () =>
        serveSearchMcp({
          req,
          res,
          configStore: options.configStore,
          searchLedger: options.searchLedger,
          ledger: options.ledger,
          logger: options.logger,
          masker: options.masker,
          maskingRecords: options.maskingRecords,
        }),
      res,
      options.logger,
    );
  });

  router.get("/v1/myna/keys", (req, res) => {
    const config = options.configStore.get();
    const principal = resolvePrincipal(req, config);
    if (principal === null || !principal.issues) {
      res.status(403).json({ error: { message: "This key cannot list keys", type: "forbidden" } });
      return;
    }
    res.json({
      object: "list",
      data: config.keys
        .filter((entry) => typeof entry !== "string" && entry.issuer === principal.key)
        .map((entry) => redactKeyEntry(entry)),
    });
  });

  router.post("/v1/myna/keys", jsonBody, (req, res) => {
    runGatewayHandler(
      () => issueKey({ req, res, configStore: options.configStore }),
      res,
      options.logger,
    );
  });

  router.delete("/v1/myna/keys", jsonBody, (req, res) => {
    runGatewayHandler(
      () => revokeKey({ req, res, configStore: options.configStore }),
      res,
      options.logger,
    );
  });

  const rawPaths = [
    "/v1/embeddings",
    "/v1/rerank",
    "/v1/images/generations",
    "/v1/audio/speech",
    "/v1/systemone",
  ];
  router.post(rawPaths, jsonBody, (req, res) => {
    runGatewayHandler(
      () =>
        forwardRaw({
          req,
          res,
          path: req.path,
          configStore: options.configStore,
          ledger: options.ledger,
          runtime,
          logger: options.logger,
          masker: options.masker,
          maskingRecords: options.maskingRecords,
        }),
      res,
      options.logger,
    );
  });

  // Videos are orchestrated here rather than passed through: a video is made
  // over minutes and polled by id, and each vendor says it differently.
  router.post(
    "/v1/videos",
    express.raw({ type: () => true, limit: MAX_BODY_SIZE, verify: keepRawBody }),
    (req, res) => {
      runGatewayHandler(
        () =>
          handleVideosCreate(req, res, {
            configStore: options.configStore,
            ledger: options.ledger,
            accountState,
            rateLimiter: runtime.rateLimiter,
            logger: options.logger,
          }),
        res,
        options.logger,
      );
    },
  );

  // Multipart endpoints: the file bytes go upstream untouched, so only the
  // `model` field is read and rewritten. Buffer in latin1 round-trips bytes.
  const multipartPaths = ["/v1/images/edits", "/v1/audio/transcriptions", "/v1/audio/translations"];
  router.post(
    multipartPaths,
    express.raw({ type: () => true, limit: MAX_BODY_SIZE, verify: keepRawBody }),
    (req, res) => {
      runGatewayHandler(
        () =>
          forwardRaw({
            req,
            res,
            path: req.path,
            configStore: options.configStore,
            ledger: options.ledger,
            runtime,
            logger: options.logger,
            multipart: true,
            masker: options.masker,
            maskingRecords: options.maskingRecords,
          }),
        res,
        options.logger,
      );
    },
  );

  // Ollama's API, for a client that takes a custom endpoint only as Ollama.
  router.get("/api/version", (_req, res) => {
    res.json({ version: OLLAMA_VERSION });
  });
  router.get("/api/tags", (_req, res) => {
    res.json({ models: listGatewayModels(options.configStore.get()).map(ollamaTag) });
  });
  router.post("/api/show", jsonBody, (req, res) => {
    const body = isRecord(req.body) ? req.body : {};
    // `model` is Ollama 0.5's name; `name` is what older clients send.
    const named = typeof body.model === "string" ? body.model.trim() : "";
    const fallback = typeof body.name === "string" ? body.name.trim() : "";
    const name = named !== "" ? named : fallback;
    if (name.length === 0) {
      res.status(400).json({ error: "model is required" });
      return;
    }
    const entry = ollamaModelNamed(listGatewayModels(options.configStore.get()), name);
    if (entry === undefined) {
      res.status(404).json({ error: `model '${name}' not found` });
      return;
    }
    // the ollama CLI before 0.7 reads parameter_count, context_length and
    // embedding_length without checking them and panics on one missing
    // (myna's ollamaShow)
    const window =
      entry.context_window === undefined || entry.context_window <= 0
        ? OLLAMA_DEFAULT_CONTEXT
        : entry.context_window;
    res.json({
      modelfile: "",
      parameters: "",
      template: "",
      details: ollamaDetails(entry),
      model_info: {
        "general.architecture": OLLAMA_ARCH,
        "general.basename": entry.display_name ?? entry.id,
        "general.parameter_count": 0,
        [`${OLLAMA_ARCH}.context_length`]: window,
        [`${OLLAMA_ARCH}.embedding_length`]: 0,
      },
      capabilities: ollamaCapabilities(entry),
      modified_at: OLLAMA_MODIFIED,
    });
  });
  for (const [path, generate] of [
    ["/api/chat", false],
    ["/api/generate", true],
  ] as const) {
    router.post(path, jsonBody, (req, res) => {
      runGatewayHandler(
        () =>
          forwardOllama({
            req,
            res,
            generate,
            configStore: options.configStore,
            masker: options.masker,
            maskingRecords: options.maskingRecords,
            ledger: options.ledger,
            runtime,
            logger: options.logger,
          }),
        res,
        options.logger,
      );
    });
  }

  // Myna's vendor-native passthrough, generalised to every configured provider.
  router.all("/v1/myna/native/:provider/*", jsonBody, (req, res) => {
    runGatewayHandler(
      () =>
        forwardNative({
          req,
          res,
          configStore: options.configStore,
          ledger: options.ledger,
          runtime,
          logger: options.logger,
        }),
      res,
      options.logger,
    );
  });

  router.get("/v1/models", (req, res) => {
    // An agent asks for the list it is shown: the same per-agent narrowing
    // myna writes into the agents' own configs (Visible/Hidden/Picked).
    const agent = req.get("x-neolix-agent") ?? req.get("x-magpie-agent") ?? undefined;
    res.json({
      object: "list",
      data: listGatewayModels(options.configStore.get(), agent),
    });
  });

  // Myna's discovery and inspection surface, under the same paths so a client
  // written against myna finds them here.
  router.get(["/v1", "/v1/"], (_req, res) => {
    res.json({
      name: "neolix-gateway",
      models: listGatewayModels(options.configStore.get()).length,
      apis: GATEWAY_APIS,
    });
  });

  router.get(/^\/v1\/models\/(.+)$/, (req, res) => {
    const id = req.params[0] ?? "";
    const entry = listGatewayModels(options.configStore.get()).find((model) => model.id === id);
    if (entry === undefined) {
      res.status(404).json({ error: { message: `No model ${id}`, type: "model_not_found" } });
      return;
    }
    res.json(entry);
  });

  router.get("/v1/myna/quotas", (req, res) => {
    const config = options.configStore.get();
    const principal = resolvePrincipal(req, config);
    if (principal === null) {
      res.status(401).json({ error: { message: "Invalid gateway key", type: "unauthorized" } });
      return;
    }
    const status = snapshotGatewayStatus({
      config,
      runtime,
      ledger: options.ledger,
      now: Date.now(),
    });
    res.json({
      object: "list",
      monthSpendUsd: status.monthSpendUsd,
      budgetUsd: status.budgetUsd,
      data: status.accounts
        .filter((account) =>
          quotaScopeAllows(principal, {
            providerId: account.provider,
            accountRef: account.account,
            usesEveryModelOfProvider: usesEveryModelOfProvider(principal, config, account.provider),
          }),
        )
        .map((account) => ({
          provider: account.provider,
          account: account.account,
          enabled: account.enabled,
          priority: account.priority,
          weight: account.weight,
          inflight: account.inflight,
          restingUntil: account.restingUntil,
          tokens5h: account.tokens5h,
          tokens7d: account.tokens7d,
          tokens5hCap: account.tokens5hCap,
          tokens7dCap: account.tokens7dCap,
          usedPercent: account.usedPercent,
          spendUsd: account.spendUsd,
          monthlyUsdCap: account.monthlyUsdCap,
        })),
    });
  });

  // The cards another Neolix's/myna's Usage page asks of this one (myna's
  // remote_quotas.go: the same cards this computer's page shows).
  const quotaCards = (): ReturnType<typeof snapshotGatewayQuota> => {
    const now = Date.now();
    return snapshotGatewayQuota({
      providers: options.configStore.get().providers,
      runtime: {
        routingState: runtime.routingState,
        accountState: runtime.accountState,
        quotaTracker: runtime.quotaTracker,
      },
      history: new Map(),
      usage: options.ledger.accountUsageHistory(now),
      since: now - 30 * 86_400_000,
      now,
    });
  };
  router.get("/v1/myna/quotas/cards", (req, res) => {
    const config = options.configStore.get();
    const principal = resolvePrincipal(req, config);
    if (principal === null) {
      res.status(401).json({ error: { message: "Invalid gateway key", type: "unauthorized" } });
      return;
    }
    const all = quotaCards();
    res.json({
      ...all,
      accounts: all.accounts.filter((card) =>
        quotaScopeAllows(principal, {
          providerId: card.provider,
          accountRef: card.account,
          usesEveryModelOfProvider: usesEveryModelOfProvider(principal, config, card.provider),
        }),
      ),
    });
  });
  const refreshQuotaCards = async (req: ExpressRequest, res: ExpressResponse): Promise<void> => {
    const providerId = typeof req.query.provider === "string" ? req.query.provider : "";
    const user = typeof req.query.user === "string" ? req.query.user.toLowerCase() : "";
    for (const provider of options.configStore.get().providers) {
      if (providerId !== "" && provider.id !== providerId) {
        continue;
      }
      for (const account of providerAccounts(provider)) {
        if (!account.enabled) {
          continue;
        }
        if (
          user !== "" &&
          (account.subscriptionUser ?? "").toLowerCase() !== user &&
          account.id !== user
        ) {
          continue;
        }
        await options.usagePoller?.refresh(provider, account);
      }
    }
    res.json(quotaCards());
  };
  router.post("/v1/myna/quotas/refresh", jsonBody, (req, res) => {
    if (!authenticateRead(req, res, options.configStore.get())) return;
    void refreshQuotaCards(req, res).catch((error: unknown) => {
      if (!res.headersSent) {
        res.status(502).json({ error: { message: errorMessage(error), type: "gateway_error" } });
      }
    });
  });
  const spendCodexReset = async (req: ExpressRequest, res: ExpressResponse): Promise<void> => {
    const user = typeof req.query.user === "string" ? req.query.user.trim() : "";
    if (user === "" || options.neolixHome === undefined) {
      res.status(400).json({
        error: {
          message: "name the Codex account whose reset is used: ?user=<its email>",
          type: "invalid_request",
        },
      });
      return;
    }
    const config = options.configStore.get();
    const found = config.providers
      .flatMap((provider) => providerAccounts(provider).map((account) => ({ provider, account })))
      .find(
        ({ account }) =>
          account.agent === "chatgpt-api" &&
          ((account.subscriptionUser ?? "").toLowerCase() === user.toLowerCase() ||
            account.id === user),
      );
    if (found === undefined) {
      res.status(404).json({
        error: { message: `Codex account '${user}' not found`, type: "not_found_error" },
      });
      return;
    }
    const reset = new CodexWeekReset({
      accountsFile: () => join(options.neolixHome as string, "gateway", "codex-accounts.json"),
      logger: options.logger,
      config: () => config,
    });
    const result = await reset.spend(found.account);
    if (!result.spent) {
      res.status(result.code === "already_spent" ? 409 : 400).json({
        error: { message: `the reset was not used: ${result.code}`, type: result.code },
      });
      return;
    }
    res.json(quotaCards());
  };
  router.post("/v1/myna/quotas/codex-reset", jsonBody, (req, res) => {
    if (!authenticateRead(req, res, options.configStore.get())) return;
    void spendCodexReset(req, res).catch((error: unknown) => {
      if (!res.headersSent) {
        res.status(502).json({ error: { message: errorMessage(error), type: "gateway_error" } });
      }
    });
  });

  router.get("/api/hello", (_req, res) => {
    res.json({ name: "neolix-gateway", version: resolveDaemonVersion() });
  });

  router.get("/muse-code/models", (_req, res) => {
    const data = listGatewayModels(options.configStore.get()).map((entry) => ({
      id: entry.id,
      object: "model",
      created: 0,
      owned_by: entry.owned_by,
      metadata: { "muse-code": museCodeMeta(entry) },
    }));
    res.json({ object: "list", data });
  });

  router.all("/backend-api/codex/*", jsonBody, (req, res) => {
    runGatewayHandler(
      () =>
        proxyCodexBackend({
          req,
          res,
          configStore: options.configStore,
          logger: options.logger,
          options,
        }),
      res,
      options.logger,
    );
  });

  router.get("/v1/codex/models", (_req, res) => {
    const config = options.configStore.get();
    const listed = listGatewayModels(config);
    const models = listed.map((model) => {
      const entry: CodexCatalogModel = { id: model.id };
      if (model.display_name !== undefined) {
        entry.label = model.display_name;
      }
      if (model.context_window !== undefined) {
        entry.contextWindow = model.context_window;
      }
      if (model.images !== undefined) {
        entry.images = model.images;
      }
      return entry;
    });
    // Codex's OpenAI models say multi-agent V1 when the user asked, and
    // every entry names the auto-review model in effect (myna's codexcat).
    const responsesProviders = new Set(
      config.providers
        .filter((provider) => provider.protocol === "openai-responses")
        .map((provider) => provider.id),
    );
    res.json({
      models: codexCatalogEntries(models, {
        ...(config.codexAgentsV1 === true ? { agentsV1: true } : {}),
        openAiModels: listed
          .filter((entry) => responsesProviders.has(entry.owned_by))
          .map((entry) => entry.id),
        ...(config.codexAutoReview === undefined ? {} : { autoReview: config.codexAutoReview }),
        ...(config.fullContext === true ? { fullContext: true } : {}),
        ...(config.compactAt === undefined ? {} : { compactAt: config.compactAt }),
      }),
    });
  });

  router.get("/v1/responses", (_req, res) => {
    res.setHeader("allow", "POST");
    res.status(405).json({
      error: { message: "Responses is served over POST and WebSocket", type: "method_not_allowed" },
    });
  });

  // myna gui/api.go GET /api/omarchy: the current Omarchy theme, asked again
  // every few seconds so a theme picked in Omarchy's menu reaches the page;
  // null off Omarchy.
  const omarchyTheme = (req: ExpressRequest, res: ExpressResponse): void => {
    // github.com/istoo/myna's pages draw themselves in this machine's
    // theme; MYNA_SITE_ORIGIN adds one (myna's omarchy.go:11-19).
    const origin = req.get("origin") ?? "";
    if (omarchySiteOrigin(origin)) {
      res.setHeader("access-control-allow-origin", origin);
      res.setHeader("vary", "Origin");
      if (req.get("access-control-request-private-network") === "true") {
        res.setHeader("access-control-allow-private-network", "true");
      }
    }
    if (req.method === "OPTIONS") {
      res.setHeader("access-control-allow-methods", "GET");
      res.status(204).end();
      return;
    }
    void currentOmarchyTheme()
      .then((theme) => res.json(theme))
      .catch(() => res.json(null));
  };
  router.get("/v1/myna/omarchy", omarchyTheme);
  router.options("/v1/myna/omarchy", omarchyTheme);

  router.get("/v1/myna/usage/requests", (req, res) => {
    if (!authenticateRead(req, res, options.configStore.get())) return;
    // The same stand-in /v1/myna/usage shows: enough to tell a key from
    // another, never enough to use it.
    res.json({
      object: "list",
      data: options.ledger.recentEntries().map((entry) => {
        const copy = structuredClone(entry);
        copy.key = entry.key === null ? null : maskKey(entry.key);
        return copy;
      }),
    });
  });

  router.post("/v1/myna/usage/requests", jsonBody, (req, res) => {
    const config = options.configStore.get();
    const principal = resolvePrincipal(req, config);
    if (principal === null) {
      res.status(401).json({ error: { message: "Invalid gateway key", type: "unauthorized" } });
      return;
    }
    if (principal.key === null) {
      res.status(403).json({
        error: { message: "Shared usage needs a gateway key", type: "forbidden" },
      });
      return;
    }
    const body = isRecord(req.body) ? req.body : null;
    if (body === null) {
      res
        .status(400)
        .json({ error: { message: "Expected a usage record", type: "invalid_request" } });
      return;
    }
    const now = new Date().toISOString();
    options.ledger.record({
      time: typeof body.time === "string" ? body.time : now,
      requested: typeof body.requested === "string" ? body.requested : "",
      provider: typeof body.provider === "string" ? body.provider : "",
      account: typeof body.account === "string" ? body.account : null,
      model: typeof body.model === "string" ? body.model : "",
      protocol: typeof body.protocol === "string" ? body.protocol : "openai",
      status: typeof body.status === "number" ? body.status : 200,
      ok: body.ok !== false,
      inputTokens: typeof body.inputTokens === "number" ? body.inputTokens : 0,
      outputTokens: typeof body.outputTokens === "number" ? body.outputTokens : 0,
      attempts: typeof body.attempts === "number" ? body.attempts : 1,
      durationMs: typeof body.durationMs === "number" ? body.durationMs : 0,
      costUsd: typeof body.costUsd === "number" ? body.costUsd : 0,
      key: null,
    });
    res.status(201).json({ ok: true });
  });

  router.get("/v1/myna/usage", (req, res) => {
    if (!authenticateRead(req, res, options.configStore.get())) return;
    const now = Date.now();
    res.json({
      object: "list",
      monthSpendUsd: options.ledger.spentThisMonth(now),
      data: [...options.ledger.countsSnapshot()].map(([key, count]) => ({ key, count })),
      recent: options.ledger.recentEntries().map((entry) => {
        const copy = structuredClone(entry);
        copy.key = entry.key === null ? null : maskKey(entry.key);
        return copy;
      }),
    });
  });

  router.get("/v1/myna/route", (req, res) => {
    if (!authenticateRead(req, res, options.configStore.get())) return;
    const header = req.headers["x-magpie-session"];
    let session = "";
    if (typeof req.query.session === "string") {
      session = req.query.session;
    } else if (typeof req.query.conversation === "string") {
      session = req.query.conversation;
    } else if (typeof header === "string") {
      session = header;
    }
    if (session.length === 0) {
      res.status(400).json({
        error: {
          code: null,
          message: "name the session: ?session=<id> or the X-Magpie-Session header",
          param: null,
          type: "invalid_request_error",
        },
      });
      return;
    }
    const upstream = runtime.routingState.sticky.get(session) ?? null;
    res.json({ route: upstream === null ? null : { model: upstream }, seq: 0, session });
  });

  router.get("/v1/myna/trace", (req, res) => {
    if (!authenticateRead(req, res, options.configStore.get())) return;
    const trace = gatewayTrace(options.ledger, Date.now());
    res.json({ object: "trace", now: new Date().toISOString(), ...trace });
  });

  router.get("/v1/myna/routing/history", (req, res) => {
    runGatewayHandler(
      async () => {
        if (!authenticateRead(req, res, options.configStore.get())) return;
        const day = typeof req.query.day === "string" ? req.query.day : "";
        const days = options.history === undefined ? [] : await options.history.days();
        const routes =
          options.history === undefined || day.length === 0
            ? []
            : await options.history.routes(day);
        res.json({ object: "list", days, day, data: routes });
      },
      res,
      options.logger,
    );
  });

  router.get("/v1/myna/prompt-text/:id", (req, res) => {
    if (!authenticateRead(req, res, options.configStore.get())) return;
    const id = typeof req.params.id === "string" ? req.params.id : "";
    const text = promptBody(id);
    if (text === null) {
      res.status(404).json({
        error: {
          message: "no prompt text is kept for that call (the last ten requests only)",
          type: "not_found",
        },
      });
      return;
    }
    res.json({ object: "prompt-text", id, ...text });
  });

  router.get("/v1/myna/archive/:date/:id", (req, res) => {
    runGatewayHandler(
      async () => {
        if (!authenticateRead(req, res, options.configStore.get())) return;
        const date = typeof req.params.date === "string" ? req.params.date : "";
        const id = typeof req.params.id === "string" ? req.params.id : "";
        const record = options.archive === undefined ? null : await options.archive.read(date, id);
        if (record === null) {
          res.status(404).json({
            error: { message: "no such call in the archive", type: "not_found" },
          });
          return;
        }
        res.json(record);
      },
      res,
      options.logger,
    );
  });

  router.get("/v1/myna/route-events", (req, res) => {
    if (!authenticateRead(req, res, options.configStore.get())) return;
    res.status(200);
    res.setHeader("content-type", "text/event-stream");
    res.setHeader("cache-control", "no-cache");
    const send = (event: string, payload: unknown): void => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    };
    const after = Number(req.query.after);
    if (Number.isFinite(after) && after >= 0) {
      // A reader that kept a cursor: the ring's changes after it, then each
      // new one as it is published, and a beat while nothing happens.
      let cursor = after;
      const flush = (): void => {
        const next = routesAfter(cursor);
        for (const entry of next.routes) {
          cursor = entry.cursor;
          send("route", { cursor: entry.cursor, route: entry.route });
        }
      };
      flush();
      const timer = setInterval(flush, 1000);
      const beat = setInterval(() => res.write(": beat\n\n"), 15_000);
      timer.unref();
      beat.unref();
      res.on("close", () => {
        clearInterval(timer);
        clearInterval(beat);
      });
      return;
    }
    let seen = new Set<string>();
    const trace = gatewayTrace(options.ledger, Date.now());
    seen = new Set(trace.routes.map(routeIdentity));
    send("trace", {
      object: "trace",
      now: new Date().toISOString(),
      cursor: routeCursor(),
      ...trace,
    });
    const timer = setInterval(() => {
      const next = gatewayTrace(options.ledger, Date.now());
      for (const route of next.routes.toReversed()) {
        const identity = routeIdentity(route);
        if (seen.has(identity)) {
          continue;
        }
        seen.add(identity);
        send("route", route);
      }
    }, 2000);
    timer.unref();
    res.on("close", () => clearInterval(timer));
  });

  router.get("/v1/myna/route-events/snapshot", (req, res) => {
    if (!authenticateRead(req, res, options.configStore.get())) return;
    res.json({
      object: "trace",
      now: new Date().toISOString(),
      cursor: routeCursor(),
      ...gatewayTrace(options.ledger, Date.now()),
    });
  });

  router.get("/v1/myna/quotas/history", (req, res) => {
    if (!authenticateRead(req, res, options.configStore.get())) return;
    const days = Number(req.query.days);
    const since = Date.now() - (Number.isFinite(days) && days > 0 ? days : 1) * 86_400_000;
    const data = options.ledger
      .accountUsageHistory(Date.now())
      .filter((entry) => entry.at >= since)
      .map((entry) => ({
        time: new Date(entry.at).toISOString(),
        account: entry.account,
        tokens: entry.tokens,
      }));
    res.json({ object: "list", data });
  });

  router.get("/v1/myna/statusline", (req, res) => {
    sendStatusline(req, res, options.configStore.get(), options.ledger, runtime);
  });
  router.post("/v1/myna/statusline", jsonBody, (req, res) => {
    sendStatusline(req, res, options.configStore.get(), options.ledger, runtime);
  });

  router.get("/v1/myna/concurrency", (req, res) => {
    if (!authenticateRead(req, res, options.configStore.get())) return;
    const status = snapshotGatewayStatus({
      config: options.configStore.get(),
      runtime,
      ledger: options.ledger,
      now: Date.now(),
    });
    res.json({
      object: "concurrency",
      requests: status.accounts.reduce((total, account) => total + account.inflight, 0),
      waiting: runtime.accountState.waiters.size,
      data: status.accounts.map((account) => ({
        provider: account.provider,
        account: account.account,
        inflight: account.inflight,
        restingUntil: account.restingUntil,
      })),
    });
  });

  router.get("/v1/myna/limit", (req, res) => {
    const principal = resolvePrincipal(req, options.configStore.get());
    if (principal === null) {
      res.status(401).json({ error: { message: "Invalid gateway key", type: "unauthorized" } });
      return;
    }
    const now = Date.now();
    const config = options.configStore.get();
    const limits =
      principal.key === null
        ? []
        : statusesOf(config, principal.key, new Date(now), options.ledger.filePath);
    const limited =
      principal.models.length > 0 ||
      principal.dailyTokens !== null ||
      principal.monthlyUsd !== null ||
      principal.ratePerMinute !== null ||
      limits.length > 0;
    res.json({
      limited,
      limits,
      key: principal.key === null ? null : maskKey(principal.key),
      label: principal.label,
      readOnly: principal.readOnly,
      models: principal.models,
      dailyTokens: principal.dailyTokens,
      monthlyUsd: principal.monthlyUsd,
      ratePerMinute: principal.ratePerMinute,
      spentThisMonthUsd:
        principal.key === null ? null : options.ledger.spentThisMonthForKey(principal.key, now),
      tokensToday: principal.key === null ? null : options.ledger.tokensToday(principal.key, now),
    });
  });

  // A video this gateway started carries the provider and the vendor's id in
  // its id. An id it cannot read is left to the old pass-through, which asks
  // each provider in catalog order until one recognises it.
  router.get(/^\/v1\/videos\/[^/]+(\/content)?$/, (req, res) => {
    runGatewayHandler(
      async () => {
        const segments = req.path.split("/");
        const id = decodeURIComponent(segments[3] ?? "");
        const content = segments[4] === "content";
        const lookup = {
          configStore: options.configStore,
          logger: options.logger,
        };
        const handled = content
          ? await handleVideoContent(req, res, lookup, id)
          : await handleVideoGet(req, res, lookup, id);
        if (!handled) {
          await forwardVideoGet({
            req,
            res,
            configStore: options.configStore,
            ledger: options.ledger,
            runtime,
            logger: options.logger,
          });
        }
      },
      res,
      options.logger,
    );
  });

  // Claude Code asks for a token count before it compacts context. The
  // gateway answers with an estimate instead of round-tripping every provider.
  router.post("/v1/messages/count_tokens", jsonBody, (req, res) => {
    const parsed = CompletionBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { message: "Invalid request body", type: "invalid_request" } });
      return;
    }
    try {
      resolveGatewayCandidates(options.configStore.get(), parsed.data.model);
    } catch (error) {
      res.status(404).json({ error: { message: errorMessage(error), type: "model_not_found" } });
      return;
    }
    const requestBody: Record<string, unknown> = parsed.data;
    const inputTokens = Math.max(1, Math.ceil(countCharacters(requestBody) / 4));
    res.json({ input_tokens: inputTokens });
  });

  router.post("/v1/messages", jsonBody, (req, res) => {
    runGatewayHandler(
      () =>
        forwardCompletion({
          req,
          res,
          protocol: "anthropic",
          routingState,
          accountState,
          quotaTracker,
          rateLimiter,
          ...options,
        }),
      res,
      options.logger,
    );
  });

  router.post("/v1/chat/completions", jsonBody, (req, res) => {
    runGatewayHandler(
      () =>
        forwardCompletion({
          req,
          res,
          protocol: "openai",
          routingState,
          accountState,
          quotaTracker,
          rateLimiter,
          ...options,
        }),
      res,
      options.logger,
    );
  });

  router.post("/v1/responses", jsonBody, (req, res) => {
    // A compaction a provider carries natively goes as Codex sent it, and
    // the sealed item comes back untouched: relayed, not translated, so
    // nothing in it is read as a message (native_compaction.go, myna).
    const config = options.configStore.get();
    if (isRecord(req.body) && hasCompactionTrigger(req.body)) {
      const model =
        typeof req.body.model === "string"
          ? (config.middleware?.aliases[req.body.model] ?? req.body.model)
          : "";
      if (nativeCompactionFor(config, model)) {
        const restored = rewriteCodexInput(req.body, true);
        if (restored.changed) {
          req.body = restored.body;
        }
        runGatewayHandler(
          () =>
            forwardRaw({
              req,
              res,
              path: "/v1/responses",
              configStore: options.configStore,
              ledger: options.ledger,
              runtime,
              logger: options.logger,
              masker: options.masker,
              maskingRecords: options.maskingRecords,
            }),
          res,
          options.logger,
        );
        return;
      }
    }
    runGatewayHandler(
      () =>
        forwardCompletion({
          req,
          res,
          protocol: "openai-responses",
          routingState,
          accountState,
          quotaTracker,
          rateLimiter,
          ...options,
        }),
      res,
      options.logger,
    );
  });

  router.get("/v1beta/models", (_req, res) => {
    res.json({
      models: listGatewayModels(options.configStore.get()).map((entry) => ({
        name: `models/${entry.id}`,
        displayName: entry.display_name,
        description: `${entry.display_name} via Neox`,
        inputTokenLimit: entry.context_window ?? null,
        outputTokenLimit: entry.max_output_tokens ?? null,
        supportedGenerationMethods: ["generateContent", "streamGenerateContent", "countTokens"],
      })),
    });
  });

  // Gemini selects the method in the path and carries the model there too.
  const geminiTarget =
    /^\/v1beta\/models\/(.+):(generateContent|streamGenerateContent|countTokens)$/;
  router.post(geminiTarget, jsonBody, (req, res) => {
    const target = req.params[0];
    const action = req.params[1];
    if (target === undefined || action === undefined) {
      res.status(400).json({ error: { message: "Invalid Gemini path", type: "invalid_request" } });
      return;
    }
    if (action === "countTokens") {
      // counted from the request's size, as myna's local estimate does
      // (gateway.go:2083): no model is asked.
      const body = isRecord(req.body) ? req.body : {};
      const inner = isRecord(body.generateContentRequest) ? body.generateContentRequest : body;
      try {
        res.json({ totalTokens: approximateTokens(codecFor("gemini").parseRequest(inner)) });
      } catch (error) {
        res.status(400).json({ error: { message: errorMessage(error), type: "invalid_request" } });
      }
      return;
    }
    const existing = isRecord(req.body) ? req.body : {};
    req.body = { ...existing, model: target, stream: action === "streamGenerateContent" };
    runGatewayHandler(
      () =>
        forwardCompletion({
          req,
          res,
          protocol: "gemini",
          routingState,
          accountState,
          quotaTracker,
          rateLimiter,
          ...options,
        }),
      res,
      options.logger,
    );
  });

  // myna's fallback for a gateway path it doesn't serve (gateway.go:1048):
  // another route's request never reaches here, as the first middleware
  // passes it on to the daemon's own.
  router.use((_req, res) => {
    res.status(404).json({
      error: {
        message:
          "Neox serves /v1/chat/completions, /v1/responses, /v1/messages, /v1/images/generations, /v1/images/edits, /v1/videos, /v1/embeddings, /v1/rerank, /v1/audio/transcriptions, /v1/audio/translations, /v1/audio/speech and /v1beta/models/*",
        type: "not_found_error",
      },
    });
  });

  return router;
}

/**
 * A rejected handler would surface as an unhandled rejection and take the
 * daemon down; a malformed upstream body is enough to cause one.
 */
function runGatewayHandler(
  handler: () => Promise<void>,
  res: ExpressResponse,
  logger: Logger,
): void {
  void handler().catch((error: unknown) => {
    logger.error({ err: error }, "LLM gateway request failed");
    if (!res.headersSent) {
      res.status(502).json({ error: { message: "Gateway failure", type: "gateway_error" } });
      return;
    }
    res.end();
  });
}

/** How long Codex's summary and its hidden side turns may take. */
const CODEX_COMPACT_TIMEOUT_MS = 10 * 60_000;
const CODEX_SIDE_TIMEOUT_MS = 2 * 60_000;

interface CodexPrepared {
  /** The request was answered here and nothing goes upstream. */
  handled: boolean;
  /** The body rewritten for a request that still goes upstream. */
  body?: Record<string, unknown>;
}

/**
 * Codex's Responses requests, before they are routed: a compaction a model
 * behind another API can't answer is summarised and wrapped here, a hidden
 * side turn (title, description, summary, prediction) is shaped here, and a
 * request goes upstream with earlier summaries restored.
 */
async function prepareCodexResponses(input: {
  req: ExpressRequest;
  res: ExpressResponse;
  config: GatewayConfig;
  body: Record<string, unknown>;
  model: string;
}): Promise<CodexPrepared> {
  const native = nativeCompactionFor(input.config, input.model);
  const rewrite = rewriteCodexInput(input.body, native);
  const kind = codexSideKind(input.req.headers, input.body);
  if (kind !== null) {
    await answerCodexSideTurn({
      req: input.req,
      res: input.res,
      kind,
      body: rewrite.body,
      config: input.config,
    });
    return { handled: true };
  }
  if (rewrite.compact) {
    await compactThroughGateway({
      req: input.req,
      res: input.res,
      body: rewrite.body,
    });
    return { handled: true };
  }
  return rewrite.changed ? { handled: false, body: rewrite.body } : { handled: false };
}

/** Whether a provider's wire can carry Codex's own compaction: Responses. */
function carriesCompaction(provider: GatewayProvider): boolean {
  return provider.protocol === "openai-responses";
}

/**
 * Whether Codex's trigger for the asked model goes upstream as Codex sent it:
 * every member of a group compacts natively, as any of them may answer it.
 */
function nativeCompactionFor(config: GatewayConfig, asked: string): boolean {
  let candidates: GatewayCandidate[];
  try {
    candidates = resolveGatewayCandidates(config, asked);
  } catch {
    return false;
  }
  return (
    candidates.length > 0 &&
    candidates.every(
      (candidate) =>
        candidate.provider.nativeCompaction === true && carriesCompaction(candidate.provider),
    )
  );
}

/** Asks the model for the summary through the gateway and wraps it as myna does. */
async function compactThroughGateway(input: {
  req: ExpressRequest;
  res: ExpressResponse;
  body: Record<string, unknown>;
}): Promise<void> {
  const headers: Record<string, string> = {};
  const turn = input.req.headers[TURN_METADATA_HEADER];
  if (typeof turn === "string") {
    const local = localCompactionTurn(turn);
    if (local.changed) {
      headers[TURN_METADATA_HEADER] = local.meta;
    }
  }
  const ask = async (body: Record<string, unknown>): Promise<SummaryAttempt> => {
    try {
      const answer = await postToSelf(input.req, {
        path: "/v1/responses",
        body: { ...body, stream: false },
        signal: AbortSignal.timeout(CODEX_COMPACT_TIMEOUT_MS),
        headers,
      });
      return summaryUsable(answer)
        ? { ok: true, answer, status: 200, error: "" }
        : { ok: false, status: 0, error: "the model wrote no summary" };
    } catch (error) {
      return error instanceof GatewaySelfError
        ? { ok: false, status: error.status, error: error.body }
        : { ok: false, status: 0, error: errorMessage(error) };
    }
  };

  let attempt = await ask(input.body);
  let summary = attempt.ok ? responseText(attempt.answer).trim() : "";
  if (!attempt.ok) {
    if (attempt.status >= 400 && !retrySummaryAsText(attempt.status, attempt.error)) {
      // An auth or rate-limit failure is the compaction's, as myna sends it.
      input.res.status(attempt.status).json({
        error: { message: `compaction: ${summaryFailure(attempt)}`, type: "compaction_failed" },
      });
      return;
    }
    // myna asks again with the conversation as text — no item ids or
    // sealed reasoning a provider can't find — and when that fails too
    // compacts without a model, so Codex goes on either way.
    const retry = await ask(plainSummaryBody(input.body));
    if (retry.ok) {
      attempt = retry;
      summary = responseText(retry.answer).trim();
    } else {
      summary = localFallbackSummary(input.body, summaryFailure(attempt));
    }
  }
  if (summary.length === 0) {
    input.res.status(502).json({
      error: { message: "compaction: the model wrote no summary", type: "compaction_failed" },
    });
    return;
  }
  const id = attempt.ok
    ? (responseId(attempt.answer) ?? `resp_neolix_${Date.now()}`)
    : `resp_neolix_${Date.now()}`;
  const item = {
    type: "compaction",
    id: `cmp_${id.replace(/^resp_/, "")}`,
    encrypted_content: encryptedSummary(summary),
  };
  writeCodexReply(input.req, input.res, {
    id,
    output: [item],
    ...(attempt.ok ? { usage: responseUsage(attempt.answer) } : {}),
  });
}

interface SummaryAttempt {
  ok: boolean;
  answer?: unknown;
  status: number;
  error: string;
}

function summaryUsable(answer: unknown): boolean {
  return (
    responseText(answer).trim().length > 0 &&
    responseStatus(answer) !== "incomplete" &&
    !answerCalledTool(answer)
  );
}

/** Why no summary came of an attempt, as the local summary reports it. */
function summaryFailure(attempt: SummaryAttempt): string {
  if (attempt.status >= 400) {
    return `${attempt.status}: ${summaryErrorText(attempt.error)}`;
  }
  return attempt.error.length > 0 ? attempt.error : "the model wrote no summary";
}

function summaryErrorText(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (isRecord(parsed) && isRecord(parsed.error) && typeof parsed.error.message === "string") {
      return parsed.error.message;
    }
  } catch {
    // Not JSON; its words are the answer.
  }
  return body.trim().length > 0 ? body.trim().slice(0, 300) : "nothing more";
}

/** Answers one of Codex's hidden turns by the model, its answer shaped. */
async function answerCodexSideTurn(input: {
  req: ExpressRequest;
  res: ExpressResponse;
  kind: CodexSideKind;
  body: Record<string, unknown>;
  config: GatewayConfig;
}): Promise<void> {
  const setting = codexSideSetting(input.config, input.kind)?.trim() ?? "";
  const answerId = `resp_neolix_${Date.now()}`;
  if (setting === "off") {
    // Answered here with nothing, sent nowhere: Codex takes it as no title,
    // description or prediction and leaves the thread as it was.
    writeCodexReply(input.req, input.res, {
      id: answerId,
      output:
        input.kind === "prediction" ? [codexMessageItem(answerId, '{"suggestion":null}')] : [],
    });
    return;
  }
  const model = codexSideModel(input.body, setting);
  let answer: unknown;
  try {
    answer = await postToSelf(input.req, {
      path: "/v1/responses",
      body: { ...input.body, model, stream: false },
      signal: AbortSignal.timeout(CODEX_SIDE_TIMEOUT_MS),
    });
  } catch (error) {
    input.res.status(502).json({
      error: { message: `${input.kind}: ${errorMessage(error)}`, type: "gateway_error" },
    });
    return;
  }
  const said = responseText(answer);
  const shaped = shapeCodexSide(input.kind, said, input.body);
  if (shaped === null) {
    input.res.status(502).json({
      error: {
        message: `${input.kind}: the model's answer had no ${input.kind} in it`,
        type: "gateway_error",
      },
    });
    return;
  }
  const id = responseId(answer) ?? `resp_neolix_${Date.now()}`;
  writeCodexReply(input.req, input.res, {
    id,
    output: [codexMessageItem(id, shaped)],
    usage: responseUsage(answer),
  });
}

/** The model a hidden turn's setting names, or the one Codex asked for. */
function codexSideModel(body: Record<string, unknown>, setting: string): string {
  if (setting.length > 0) {
    return setting;
  }
  return typeof body.model === "string" ? body.model : "";
}

/** myna's CodexTitles/CodexDescriptions/CodexPredictions for a turn. */
function codexSideSetting(config: GatewayConfig, kind: CodexSideKind): string | undefined {
  if (kind === "title") {
    return config.codexTitles;
  }
  if (kind === "description") {
    return config.codexDescriptions;
  }
  if (kind === "prediction") {
    return config.codexPredictions;
  }
  return undefined;
}

function shapeCodexSide(
  kind: CodexSideKind,
  said: string,
  body: Record<string, unknown>,
): string | null {
  if (kind === "title") {
    const title = titleJSON(said, titleShapeOf(body));
    return title.length > 0 ? title : null;
  }
  if (kind === "description") {
    const description = descriptionJSON(said);
    return description.length > 0 ? description : null;
  }
  if (kind === "summary") {
    const summary = summaryJSON(said, titleShapeOf(body));
    return summary.length > 0 ? summary : null;
  }
  return predictionJSON(said).json;
}

/** The assistant message a hidden turn's shaped answer rides in. */
function codexMessageItem(id: string, text: string): Record<string, unknown> {
  return {
    type: "message",
    id: `msg_${id.replace(/^resp_/, "")}`,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
}

/**
 * A finished Responses reply, streamed as Codex's backend streams one, or
 * as plain JSON when the client asked for no stream.
 */
function writeCodexReply(
  req: ExpressRequest,
  res: ExpressResponse,
  reply: { id: string; output: unknown[]; usage?: unknown },
): void {
  const done: Record<string, unknown> = {
    id: reply.id,
    object: "response",
    status: "completed",
    output: reply.output,
  };
  if (reply.usage !== undefined && reply.usage !== null) {
    done.usage = reply.usage;
  }
  if (!isRecord(req.body) || req.body.stream !== true) {
    res.status(200).json(done);
    return;
  }
  res.status(200);
  res.setHeader("content-type", "text/event-stream");
  res.setHeader("cache-control", "no-cache");
  const events: Record<string, unknown>[] = [
    {
      type: "response.created",
      response: { id: reply.id, object: "response", status: "in_progress", output: [] },
    },
  ];
  reply.output.forEach((item, index) => {
    events.push({ type: "response.output_item.added", output_index: index, item });
    events.push({ type: "response.output_item.done", output_index: index, item });
  });
  events.push({ type: "response.completed", response: done });
  for (const event of events) {
    res.write(`event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`);
  }
  res.end();
}

interface ForwardCompletionInput extends GatewayRouterOptions {
  req: ExpressRequest;
  res: ExpressResponse;
  protocol: GatewayProtocol;
  routingState: RoutingState;
  accountState: AccountRoutingState;
  quotaTracker: QuotaTracker;
  rateLimiter: RateLimiter;
}

// debt: one request pipeline holds translation, masking, hooks and tracing;
// split it by stage when the next concern lands here.
// eslint-disable-next-line complexity
/** Round-robin over the provider's Claude subscription accounts. */
const claudeAccountCursor = new Map<string, number>();

function claudeAccountFor(provider: GatewayProvider, model: string): GatewayAccount | undefined {
  const accounts = providerAccounts(provider).filter(
    (account) =>
      account.agent === "claude-code" &&
      account.enabled &&
      (account.models.length === 0 || account.models.includes(model)),
  );
  if (accounts.length === 0) {
    return undefined;
  }
  const at = claudeAccountCursor.get(provider.id) ?? 0;
  claudeAccountCursor.set(provider.id, at + 1);
  return accounts[at % accounts.length];
}

/**
 * Serves the candidate through Claude Code when one of its accounts is a
 * Claude subscription; null when it has none and the usual path applies.
 */
async function serveSubscriptionCandidate(input: {
  claude: ClaudeGatewayOptions;
  candidate: GatewayCandidate;
  /** The masked, search-injected body, in Anthropic's shape. */
  body: Record<string, unknown>;
  webSearch: boolean;
  res: ExpressResponse;
  leanPrompt?: boolean;
  /** Whether Claude Code answers with `-p` instead of its TUI. */
  printMode?: boolean;
  restorer?: ClaudeTextRestorer;
  /** The client's headers, for its own cache marks. */
  headers?: Record<string, unknown>;
}): Promise<number | null> {
  if (input.candidate.provider.protocol !== "anthropic") {
    return null;
  }
  const account = claudeAccountFor(input.candidate.provider, input.candidate.model.id);
  if (account === undefined) {
    return null;
  }
  const configDir = input.claude.claudeConfigDir ?? defaultClaudeConfigDir;
  try {
    await serveClaudeSubscription({
      runtime: {
        bridge: input.claude.bridge,
        helperPath: input.claude.helperPath,
        callbackBaseUrl: input.claude.callbackBaseUrl(),
        claudeConfigDir: configDir,
        ...(input.claude.workDir === undefined ? {} : { workDir: input.claude.workDir }),
      },
      res: input.res,
      body: input.body,
      webSearch: input.webSearch,
      model: input.candidate.model.id,
      owner: `${input.candidate.provider.id}/${account.id}`,
      ...(account.configDir === undefined ? {} : { configDir: account.configDir }),
      leanPrompt: input.leanPrompt === true,
      printMode: input.printMode,
      ...(input.restorer === undefined ? {} : { restorer: input.restorer }),
      ...(input.headers === undefined ? {} : { headers: input.headers }),
    });
    return 200;
  } catch (error) {
    const failure = claudeServeError(error);
    input.res.status(failure.status).json({
      error: { type: "api_error", message: failure.message },
    });
    return failure.status;
  }
}

/** Whether the turn was answered here for a tool loop, sent nowhere. */
function toolLoopAnswered(input: {
  fromRouter: boolean;
  config: GatewayConfig;
  req: ExpressRequest;
  res: ExpressResponse;
  protocol: GatewayProtocol;
  body: CompletionBody;
}): boolean {
  if (input.fromRouter || input.config.noLoopGuard === true) {
    return false;
  }
  return stoppedToolLoop(input.req, input.res, input.protocol, input.body);
}

/** Answers a request whose newest turns are one tool exchange here. */
function stoppedToolLoop(
  req: ExpressRequest,
  res: ExpressResponse,
  protocol: GatewayProtocol,
  body: CompletionBody,
): boolean {
  if (!isRecord(req.body) || !mayLoop(protocol, JSON.stringify(req.body))) {
    return false;
  }
  let loop: ToolLoop | null = null;
  try {
    loop = toolLoopOf(codecFor(protocol).parseRequest(req.body));
  } catch {
    // A body the codec can't read isn't a loop.
    return false;
  }
  if (loop === null) {
    return false;
  }
  answerTurnLocally(res, protocol, body.model, body.stream === true, toolLoopNotice(loop));
  return true;
}

/** Answers a turn here: a finished assistant turn with no call in it. */
function answerTurnLocally(
  res: ExpressResponse,
  protocol: GatewayProtocol,
  requestedModel: string,
  stream: boolean,
  text: string,
): void {
  const codec = codecFor(protocol);
  const response = {
    id: null,
    parts: [{ type: "text" as const, text }],
    stopReason: "stop" as const,
    usage: { inputTokens: 0, outputTokens: 0 },
  };
  if (!stream) {
    res.status(200).json(codec.buildResponseBody(response, requestedModel));
    return;
  }
  const encoder = codec.createStreamEncoder(requestedModel);
  startEventStream(res);
  res.write(encoder.start());
  for (const event of eventsFromResponse(response)) {
    res.write(encoder.push(event));
  }
  res.end(encoder.end());
}

interface PreparedForward {
  body: CompletionBody;
  config: GatewayConfig;
  routingModel: string;
  aliasTarget: string | undefined;
  agent: string;
  fromRouter: boolean;
}

/**
 * Reads the request body and answers here whatever the gateway answers
 * itself (a thread it won't route, Codex's hidden turns, a tool loop);
 * null when a response was sent.
 */
async function prepareForward(
  input: ForwardCompletionInput,
  protocol: GatewayProtocol,
  req: ExpressRequest,
  res: ExpressResponse,
): Promise<PreparedForward | null> {
  const parsed = CompletionBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: "Invalid request body", type: "invalid_request" } });
    return null;
  }
  let body: CompletionBody = parsed.data;
  // A thread would leave the history on a server myna routes away from.
  if (protocol === "anthropic" && namesThread(body)) {
    res.status(400).json(threadRefusal());
    return null;
  }

  const config = input.configStore.get();
  const aliasTarget = config.middleware?.aliases[body.model];
  let routingModel = aliasTarget ?? body.model;
  const agent = clientOfUserAgent(req.headers["user-agent"]);
  // The classifier's own request goes through here too; it asks no
  // classifier in turn, however many groups deep it is routed.
  const fromRouter = isRouterCall(req);
  // Codex compacts remotely, and asks for a thread's title, description,
  // summary and next-message prediction on hidden turns; a model behind
  // another API can't be given Codex's own answer to any of them.
  if (!fromRouter && protocol === "openai-responses" && isRecord(req.body)) {
    const prepared = await prepareCodexResponses({
      req,
      res,
      config,
      body: req.body,
      model: routingModel,
    });
    if (prepared.handled) {
      return null;
    }
    if (prepared.body !== undefined) {
      body = prepared.body as CompletionBody;
      req.body = prepared.body;
    }
  }
  // A Codex subagent goes on the model the user set for subagents, where
  // that model is served (myna's CodexSubagentModel, codex_subagent.go).
  const subagent = codexSubagentRoute({ config, req, body, agent, routingModel });
  if (subagent.rewritten) {
    routingModel = subagent.routingModel;
    body = subagent.body;
    req.body = isRecord(req.body) ? { ...req.body, model: subagent.routingModel } : subagent.body;
  }
  // A conversation stuck in a tool loop is answered here, sent nowhere
  // (myna's toolLoop, #1359's cross-turn half).
  if (toolLoopAnswered({ fromRouter, config, req, res, protocol, body })) {
    return null;
  }
  return { body, config, routingModel, aliasTarget, agent, fromRouter };
}

/**
 * The model a Codex subagent's task goes on, when the user set one: only
 * a collab_spawn from Codex, and only a model the gateway serves.
 * debt: "lead" (the lead's own model), a sealed task's ChatGPT-only rule
 * and the key's model list are not read here yet.
 */
function codexSubagentModelFor(input: {
  config: GatewayConfig;
  req: ExpressRequest;
  body: CompletionBody;
  agent: string;
}): string | null {
  const setting = (input.config.codexSubagentModel ?? "").trim();
  if (setting === "") {
    return null;
  }
  if (input.agent !== "codex" && !codexOriginator(input.req)) {
    return null;
  }
  const headerKind = input.req.get("x-openai-subagent");
  const bodyKind = typeof input.body.request_kind === "string" ? input.body.request_kind : "";
  if ((headerKind ?? bodyKind) !== "collab_spawn") {
    return null;
  }
  const target =
    setting === "lead"
      ? codexLeadModel({
          headers: input.req.headers,
          body: input.body,
          key: gatewayPrincipal(input.req, input.config)?.key ?? "",
        })
      : setting;
  if (target === null || target === input.body.model) {
    return null;
  }
  let candidates: GatewayCandidate[];
  try {
    candidates = resolveGatewayCandidates(input.config, target);
  } catch {
    return null;
  }
  if (candidates.length === 0) {
    return null;
  }
  // A task the ChatGPT backend sealed opens only on a ChatGPT account again
  // (myna's CodexSubagentUnserved / sealedTaskIn).
  if (sealedTaskIn(input.body) && !chatGptServedModel(input.config, target)) {
    return null;
  }
  const principal = gatewayPrincipal(input.req, input.config);
  if (principal !== null && !keyAllowsRoute(principal, target, candidates)) {
    return null;
  }
  return target;
}

/**
 * Puts a Codex subagent's task on the model the user set, or notes a
 * conversation's own turn as what its subagents follow under "lead". A
 * side call (a title, a task spawn) never becomes the lead (myna's
 * codexLeads.saw).
 */
function codexSubagentRoute(input: {
  config: GatewayConfig;
  req: ExpressRequest;
  body: CompletionBody;
  agent: string;
  routingModel: string;
}): { body: CompletionBody; routingModel: string; rewritten: boolean } {
  const target = codexSubagentModelFor({
    config: input.config,
    req: input.req,
    body: input.body,
    agent: input.agent,
  });
  if (target !== null) {
    return {
      body: { ...input.body, model: target },
      routingModel: target,
      rewritten: true,
    };
  }
  const callKind =
    input.req.get("x-openai-subagent") ??
    (typeof input.body.request_kind === "string" ? input.body.request_kind : "");
  if ((input.agent === "codex" || codexOriginator(input.req)) && callKind.length === 0) {
    noteCodexLead({
      headers: input.req.headers,
      body: input.body,
      model: input.routingModel,
      key: gatewayPrincipal(input.req, input.config)?.key ?? "",
    });
  }
  return { body: input.body, routingModel: input.routingModel, rewritten: false };
}

/** A payload the ChatGPT backend seals: only it can open it. */
const SEALED_AGENT_PAYLOAD = /^gAAAAA[A-Za-z0-9_-]+={0,2}$/;

/**
 * A subagent's task itself is sealed, not only a message between agents
 * (myna's sealedTaskIn): an input item with no "Message Type: MESSAGE"
 * header that carries a sealed payload.
 */
function sealedTaskIn(body: CompletionBody): boolean {
  const items = Array.isArray(body.input) ? body.input : [];
  for (const raw of items) {
    if (!isRecord(raw) || raw.type !== "agent_message") {
      continue;
    }
    const parts = Array.isArray(raw.content) ? raw.content : [];
    let message = false;
    let sealed = false;
    for (const part of parts) {
      if (!isRecord(part)) {
        continue;
      }
      if (
        part.type === "input_text" &&
        typeof part.text === "string" &&
        part.text.startsWith("Message Type: MESSAGE\n")
      ) {
        message = true;
      }
      if (
        part.type === "encrypted_content" &&
        typeof part.encrypted_content === "string" &&
        SEALED_AGENT_PAYLOAD.test(part.encrypted_content)
      ) {
        sealed = true;
      }
    }
    if (sealed && !message) {
      return true;
    }
  }
  return false;
}

/** Whether a model is served by a ChatGPT account (myna's CodexAccountModel). */
function chatGptServedModel(config: GatewayConfig, id: string): boolean {
  const slash = id.indexOf("/");
  if (slash <= 0) {
    return false;
  }
  const provider = config.providers.find((entry) => entry.id === id.slice(0, slash));
  if (provider === undefined) {
    return false;
  }
  return (
    provider.id.toLowerCase().includes("codex") ||
    provider.baseUrl.toLowerCase().includes("chatgpt.com") ||
    (provider.accounts ?? []).some((account) => account.agent === "chatgpt-api")
  );
}

interface ForwardPlan {
  plannedRequest: PlannedRequestCandidates;
  candidates: GatewayCandidate[];
  accountFilter: ReturnType<typeof groupAccountFilter>;
  translateRequest: (
    target: GatewayProtocol,
    model: string,
    loadedInPlace?: boolean,
  ) => Record<string, unknown>;
  principal: NonNullable<ReturnType<typeof gatewayPrincipal>>;
  hooks: HookRuntime;
  maskingEnabled: boolean;
  /** The key's windows hold this request until it ends. */
  reservation: Reservation;
}

/**
 * Plans the request's candidates, checks the caller may ask for them and
 * runs the request hooks; null when a response was sent.
 */
async function planForward(
  forward: ForwardCompletionInput & {
    req: ExpressRequest;
    res: ExpressResponse;
    protocol: GatewayProtocol;
    body: CompletionBody;
    config: GatewayConfig;
    routingModel: string;
    agent: string;
    fromRouter: boolean;
    prompt: ReturnType<typeof summarizePrompt>;
    startedAt: number;
    routingState: ForwardCompletionInput["routingState"];
    accountState: ForwardCompletionInput["accountState"];
    ledger: ForwardCompletionInput["ledger"];
    rateLimiter: ForwardCompletionInput["rateLimiter"];
    logger: ForwardCompletionInput["logger"];
  },
): Promise<ForwardPlan | null> {
  const {
    req,
    res,
    protocol,
    body,
    config,
    routingModel: askedRoute,
    agent,
    fromRouter,
    prompt,
    startedAt,
    routingState,
    accountState,
    ledger,
    rateLimiter,
    logger,
  } = forward;
  // A capped account near its cap is read again before it is planned, as
  // myna's careful caps do; one whose usage can't be told is held by
  // runCandidateAttempts.
  if (config.providers.some((provider) => provider.capCareful === true)) {
    await readCareful(config.providers, accountState, async (provider, account) => {
      await forward.usagePoller?.refresh(provider, account);
    });
  }
  const maskingEnabled = maskingWanted(config.masking);
  if (maskingEnabled) {
    await forward.masker.ensureKey();
  }
  // An agent's request that masking would change goes as written to the
  // model whose every route is set to take it unmasked (myna's
  // RedactRouteTo): the hits are read here first, before the route is
  // planned, so the request never goes to the masking route masked.
  let routingModel = askedRoute;
  const maskRouted = await maskRouteForRequest({
    config,
    masker: forward.masker,
    body,
    routeTo: config.masking?.routeTo,
    agentTurn: !fromRouter,
    principal: gatewayPrincipal(req, config),
  });
  if (maskRouted !== null) {
    routingModel = maskRouted;
  }
  let plannedRequest: PlannedRequestCandidates;
  try {
    plannedRequest = await planRequestCandidates({
      config,
      requestedModel: routingModel,
      state: routingState,
      context: readRuleContext({
        agent,
        tokens: prompt?.tokens ?? 0,
        body: req.body,
        now: startedAt,
      }),
      ...(fromRouter ? {} : { classify: (question) => postToSelf(req, question) }),
    });
  } catch (error) {
    // A Codex thread started on Neolix keeps asking for its own models after
    // Codex is set back to ChatGPT: they go on Codex's own sign-in to its
    // backend, as Codex's built-in provider would send them (myna's
    // codex_own_v1.go:21-105).
    const redirect = await codexOwnRedirect(
      {
        model: routingModel,
        local: isLocalRequest(req),
        fromCodex:
          agent === "codex" || (req.get("originator") ?? "").toLowerCase() === "codex_cli_rs",
        sideCall: false,
        served: false,
        switchedOff: false,
        keyHeld: resolvePrincipal(req, config)?.key != null,
        accountHeld: false,
      },
      { signIn: { discovery: accountDiscoveryOn(config) } },
    );
    if (redirect !== null && "why" in redirect) {
      res.status(404).json({ error: { message: redirect.why, type: "model_not_found" } });
      return null;
    }
    if (redirect !== null) {
      try {
        const upstream = await fetch(`https://chatgpt.com${redirect.path}`, {
          method: "POST",
          headers: { "content-type": "application/json", ...redirect.headers },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(120_000),
        });
        await pipeUpstream(res, upstream);
      } catch {
        res.status(502).json({
          error: { message: "Codex backend unreachable", type: "gateway_error" },
        });
      }
      return null;
    }
    res.status(404).json({
      error: { message: errorMessage(error), type: "model_not_found" },
    });
    return null;
  }
  // A candidate whose model is switched off isn't tried; a request whose
  // every candidate is, is refused as that model's (myna's disabled.go).
  const enabled = enabledCandidates(config, plannedRequest.candidates);
  if ("refusal" in enabled) {
    res.status(enabled.refusal.status).json({
      error: { message: enabled.refusal.message, type: "forbidden" },
    });
    return null;
  }
  const candidates = enabled.candidates;
  const authorized = authorizePlan({
    config,
    req,
    res,
    ledger,
    rateLimiter,
    body,
    routingModel,
    candidates,
    logger,
  });
  if (authorized === null) {
    return null;
  }
  const { principal, accountFilter, reservation, hooks } = authorized;

  let irRequest: IrRequest | null = null;
  const translateRequest = (
    target: GatewayProtocol,
    model: string,
    loadedInPlace = false,
  ): Record<string, unknown> => {
    irRequest ??= codecFor(protocol).parseRequest(body);
    return codecFor(target).buildRequestBody(
      loadedInPlace ? { ...irRequest, loadedInPlace: true } : irRequest,
      model,
    );
  };
  return {
    plannedRequest,
    candidates,
    accountFilter,
    translateRequest,
    principal,
    hooks,
    maskingEnabled,
    reservation,
  };
}

interface AuthorizedRequest {
  principal: NonNullable<ReturnType<typeof gatewayPrincipal>>;
  accountFilter: ReturnType<typeof combineAccountFilters>;
  reservation: Reservation;
}

/**
 * The caller's key, its access to the model and its budget window: null when
 * a response was sent instead (myna's access check and budget.Reserve). Every
 * endpoint that can spend uses this, not only the chat ones.
 */
function authorizeRequest(input: {
  config: GatewayConfig;
  req: ExpressRequest;
  res: ExpressResponse;
  ledger: UsageLedger;
  rateLimiter: RateLimiter;
  requestedModel: string;
  routingModel: string;
  candidates: GatewayCandidate[];
  bodyBytes: number;
}): AuthorizedRequest | null {
  const principal = gatewayPrincipal(input.req, input.config);
  if (principal === null) {
    input.res.status(401).json({ error: { message: "Invalid gateway key", type: "unauthorized" } });
    return null;
  }
  // A group and a key that both name a provider's accounts are held to the
  // ones both name (myna's HeldToGroup).
  const accountFilter = combineAccountFilters(
    groupAccountFilter(input.config, input.routingModel),
    keyAccountFilter(principal),
  );
  const denial = checkAccess({
    config: input.config,
    ledger: input.ledger,
    principal,
    requestedModel: input.requestedModel,
    routingModel: input.routingModel,
    candidates: input.candidates,
    rateLimiter: input.rateLimiter,
    now: Date.now(),
  });
  if (denial !== null) {
    if (denial.retryAfterSeconds !== undefined) {
      input.res.setHeader("Retry-After", String(denial.retryAfterSeconds));
    }
    input.res.status(denial.status).json({ error: { message: denial.message, type: denial.type } });
    return null;
  }
  // A key's windows hold this request's expected usage until it ends
  // (myna budget.Reserve); a request that would overflow is refused here,
  // before anything is sent, with the window's reset as Retry-After.
  const reservation = reserveBudget({
    config: input.config,
    key: principal.key,
    bodyBytes: input.bodyBytes,
    now: new Date(),
    ledgerPath: input.ledger.filePath,
  });
  if ("refusal" in reservation) {
    input.res.setHeader("Retry-After", String(reservation.refusal.retryAfterSeconds));
    input.res.status(429).json({
      error: { message: reservation.refusal.message, type: "quota_exceeded" },
    });
    return null;
  }
  return { principal, accountFilter, reservation: reservation.reservation };
}

/**
 * The caller's key, its access to the model, its budget window and the
 * request hooks: null when a response was sent instead (myna's access
 * check and budget.Reserve).
 */
function authorizePlan(input: {
  config: GatewayConfig;
  req: ExpressRequest;
  res: ExpressResponse;
  ledger: UsageLedger;
  rateLimiter: RateLimiter;
  body: CompletionBody;
  routingModel: string;
  candidates: GatewayCandidate[];
  logger: Logger;
}): {
  principal: NonNullable<ReturnType<typeof gatewayPrincipal>>;
  accountFilter: ReturnType<typeof combineAccountFilters>;
  reservation: Reservation;
  hooks: HookRuntime;
} | null {
  const access = authorizeRequest({
    config: input.config,
    req: input.req,
    res: input.res,
    ledger: input.ledger,
    rateLimiter: input.rateLimiter,
    requestedModel: input.body.model,
    routingModel: input.routingModel,
    candidates: input.candidates,
    bodyBytes: Buffer.byteLength(JSON.stringify(input.body)),
  });
  if (access === null) {
    return null;
  }
  const hooks = new HookRuntime(input.config, input.logger);
  const rejection = hooks.runRequest({ body: input.body, model: input.body.model });
  if (rejection !== null) {
    // The request never went anywhere: give back the window it held, or the
    // key stays refused until an in-flight hold that does not exist clears.
    access.reservation.release();
    input.res.status(rejection.status).json({
      error: { message: rejection.message, type: "hook_rejected" },
    });
    return null;
  }
  return { ...access, hooks };
}

async function forwardCompletion(input: ForwardCompletionInput): Promise<void> {
  const {
    req,
    res,
    protocol,
    masker,
    maskingRecords,
    ledger,
    routingState,
    accountState,
    quotaTracker,
    rateLimiter,
    logger,
  } = input;
  const onStickyChange = input.runtime?.onStickyChange;
  const onRestChange = input.runtime?.onRestChange;
  const onRestCleared = input.runtime?.onRestCleared;
  const startedAt = Date.now();
  input.conversations?.capture(req, res, protocol);

  const prepared = await prepareForward(input, protocol, req, res);
  if (prepared === null) {
    return;
  }
  const { body, config, routingModel, aliasTarget, agent, fromRouter } = prepared;
  // Codex's hidden title turn is tied to the conversation it names, by
  // fingerprints only (myna's title_link.go). Every other turn only leaves
  // its first prompt in the registry for that match.
  const titleKind = titleKindOf(req, body);
  const observedTitle = observeTitleRequest({
    headers: req.headers,
    body,
    kind: titleKind,
    agent,
    at: startedAt,
  });
  const titleLink = titleKind !== null && TITLE_KINDS.has(titleKind) ? observedTitle : null;
  // A model switched off serves nothing, however it was asked for
  // (myna's gateway/disabled.go).
  const disabled = disabledRequestRefusal(config, body.model);
  if (disabled !== null) {
    res.status(disabled.status).json({
      error: { message: disabled.message, type: "forbidden" },
    });
    return;
  }
  const prompt = summarizePrompt(req.body, null);
  const plan = await planForward({
    ...input,
    req,
    res,
    protocol,
    body,
    config,
    routingModel,
    agent,
    fromRouter,
    prompt,
    startedAt,
    routingState,
    accountState,
    ledger,
    rateLimiter,
    logger,
  });
  if (plan === null) {
    return;
  }
  const {
    plannedRequest,
    candidates,
    accountFilter,
    translateRequest,
    principal,
    hooks,
    maskingEnabled,
    reservation,
  } = plan;
  routingState.usageCounts = ledger.countsSnapshot();
  const conversationKey = readConversationKey(req);
  const turn = turnOfRequest(protocol, body);
  routingState.speed = ledger.speedSnapshot(startedAt);
  const routeInput = {
    config,
    requestedModel: routingModel,
    candidates,
    state: routingState,
    now: startedAt,
    conversationKey,
    withinTurn: turn.within,
    preserveOrder: plannedRequest.preserveOrder,
    catalog: input.runtime?.pricing ?? null,
  };
  const planned = await planPluginStrategy(planCandidates(routeInput), routeInput);
  // One id for the client call, shared by every candidate it walks. The
  // per-candidate `requestId` still groups that candidate's attempts.
  const gatewayCallId = randomUUID();
  const routeTrace = input.runtime?.routeTrace;
  const beginTrace = (): ReturnType<NonNullable<typeof routeTrace>["start"]> | null =>
    routeTrace?.start({
      time: startedAt,
      agent,
      key: principal.key === null ? null : maskKey(principal.key),
      model: body.model,
      routedModel: routingModel,
      alias: aliasTarget ?? null,
      group: routingModel.startsWith("group/") ? routingModel.slice("group/".length) : null,
      strategy: strategyFor(config, routingModel),
      provider: planned[0]?.provider.id ?? null,
      providerLabel:
        planned[0] === undefined ? null : (planned[0].provider.label ?? planned[0].provider.id),
      seats: traceSeats({ planned, accountState, routingState, ledger, now: startedAt }),
      tries: [],
      prompt: prompt === null ? null : { ...prompt, window: contextWindowOf(planned) },
      masked: maskingEnabled,
      gatewayCallId,
    }) ?? null;
  const route = beginTrace();
  const finishRoute = (delivered: boolean, status: number | null): void => {
    if (routeTrace === undefined || route === null) {
      return;
    }
    const served = route.tries.at(-1)?.status ?? null;
    const finalStatus = delivered ? (served ?? 200) : (status ?? 502);
    routeTrace.finish(route.id, {
      status: finalStatus,
      error: delivered || finalStatus < 400 ? null : `HTTP ${finalStatus}`,
      now: Date.now(),
    });
  };

  const attempts = { value: 0 };
  const restoreCounts: RestoreCounts = new Map();
  const clientName = clientOfUserAgent(req.headers["user-agent"]);
  const webSearchWanted = wantsWebSearch(protocol, body);
  // myna's SearchAll: the gateway searches even for a provider that can
  // search by itself. Its own searches (the router's calls) never do that
  // again, as myna's `searching` marks them (myna's mynaSearches).
  const webSearchAll = !isRouterCall(req) && searchesForAll(config);
  let clientSearch: ClientSearch | null = null;
  let webSearchDone = false;
  let lastStatus: number | null = null;
  let lastMasked: { candidate: GatewayCandidate; hits: MaskHit[]; tookMs: number } | null = null;
  // Spends a used-up week's Codex reset when every candidate is out; `spend`
  // validates the week and that only one is spent.
  const weekReset =
    input.neolixHome === undefined
      ? null
      : new CodexWeekReset({
          accountsFile: () => join(input.neolixHome as string, "gateway", "codex-accounts.json"),
          logger,
          config: () => config,
        });
  let weekResetTried = false;
  /** Spends a used-up week's reset on a resting Codex account, if one may. */
  const spendWeekReset = async (): Promise<boolean> => {
    if (weekReset === null || weekResetTried) {
      return false;
    }
    weekResetTried = true;
    const now = Date.now();
    for (const candidate of planned) {
      for (const account of providerAccounts(candidate.provider)) {
        if (!account.enabled || account.autoReset === undefined) {
          continue;
        }
        const key = accountKey(candidate.provider, account);
        if (!routingState.rest.isResting(key, now)) {
          continue;
        }
        const result = await weekReset.spend(account);
        if (result.spent) {
          routingState.rest.clear(key);
          return true;
        }
      }
    }
    return false;
  };
  // eslint-disable-next-line complexity -- myna's one candidate walk, kept whole so its steps stay beside each other (accept, re-ask Auto, pause, fail over).
  const walkCandidates = async (): Promise<void> => {
    // A group's patience (myna's patience.go): once every member has failed
    // in a way that passes, the ones back soon are asked again after a
    // pause, longer each round and never shorter than a Retry-After.
    const state = patienceStateFor(config, planned, routingModel);
    const codexHints = codexBodyHints({ req, agent, body });
    // The members asked again are appended, as myna appends to its cands;
    // planned itself stays as it was for the trace and the failure.
    const queue = creditsLastBehindFallbacks(
      [...planned, ...providerFallbackQueue(config, routingModel, planned)],
      accountState,
      startedAt,
    );
    /** The reply a refused try handed over: the next tries continue it. */
    let handover: RefusalHandover | undefined;
    /** How many tries the safety filter refused (myna's refusals). */
    let refusals = 0;
    /** Why Antigravity turned the request away, when one did. */
    let turnedAwayHint: string | null = null;
    /** Which daemon home's turn-aways are read: this request's. */
    const homeScope = String(input.neolixHome);
    /** Writes a patience round into the last try, as myna does. */
    const noteReplan = (info: PatienceReplan | null): void => {
      if (info === null || routeTrace === undefined || route === null) {
        return;
      }
      routeTrace.update(route.id, (entry) => {
        const tried = entry.tries.at(-1);
        if (tried === undefined) {
          return;
        }
        tried.again = info.waitMs;
        tried.replan = info.replan;
        tried.patience = info.patience;
      });
    };
    /** Keeps the last status a try failed with, for the final error. */
    const noteStatus = (status: number | null): void => {
      if (status !== null) {
        lastStatus = status;
      }
    };
    /** Whether Antigravity would only turn this request away again, as it
     * did lately, while someone after this member may answer. */
    const skipForeseen = (
      member: GatewayCandidate,
      target: GatewayProtocol,
      preparedBody: Record<string, unknown>,
      isLast: boolean,
    ): boolean => {
      if (isLast) {
        return false;
      }
      const hint = foreseenTurnedAway(member.provider, target, preparedBody, Date.now(), homeScope);
      if (hint === null) {
        return false;
      }
      turnedAwayHint = hint;
      noteStatus(ANTIGRAVITY_TURNED_AWAY_STATUS);
      return true;
    };
    /** What a candidate's Copilot Auto refusal left to ask again, by index. */
    const copilotRetries = new Map<
      number,
      { avoid: Set<CopilotProtocol>; fresh: boolean; tries: number }
    >();
    for (let index = 0; index < queue.length; index++) {
      const candidate = queue[index];
      const last = index === queue.length - 1;
      const prepareCandidate = async (
        member: GatewayCandidate,
      ): Promise<{
        candidate: GatewayCandidate;
        upstreamProtocol: GatewayProtocol;
        upstreamBody: Record<string, unknown>;
        nativeSearch: boolean;
        masking: { hits: MaskHit[]; blocked: boolean } | null;
        maskingMs: number;
        toolSearch: boolean;
        sessionToken?: string;
        auto: CopilotAutoResolved | null;
      } | null> => {
        // Copilot's Auto picks the model and the API it is served on
        // (myna's copilot_auto.go); the request goes there with the
        // session token its pick names. A refusal asks it again with the
        // API it refused left out and a fresh pick (`copilotRetries`).
        const retry = copilotRetries.get(index);
        const auto = await resolveCopilotAuto({
          config,
          candidate: member,
          protocol,
          body,
          neolixHome: input.neolixHome,
          avoid: retry?.avoid,
          fresh: retry?.fresh,
          fetchImpl: input.copilotFetch,
        });
        const target = autoTarget(auto, member);
        const upstreamProtocol = target.provider.protocol;
        // A provider that searches by itself gets the request as sent (myna's
        // Searches), unless SearchAll takes the search over; another, when a
        // search API or a searcher answers, gets what myna found.
        const nativeSearch = nativeSearchFor({
          wanted: webSearchWanted,
          all: webSearchAll,
          upstreamProtocol,
          clientProtocol: protocol,
          provider: target.provider,
          accountState,
          modelId: target.model.id,
        });
        if (webSearchWanted && !nativeSearch && !webSearchDone) {
          webSearchDone = true;
          clientSearch = await searchForClient({
            config,
            masker,
            maskingEnabled,
            query: lastUserText(protocol, body),
            logger,
            post: (request) =>
              postToSelf(req, {
                body: request.body,
                path: request.path,
                signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
              }),
          });
        }
        let upstreamBody: Record<string, unknown>;
        let masking: { hits: MaskHit[]; blocked: boolean } | null = null;
        let maskingMs = 0;
        let toolSearch = false;
        try {
          const built = await buildAttemptBody({
            config,
            candidate: target,
            protocol,
            clientBody: body,
            translate: translateRequest,
            maskingEnabled,
            masker,
            webSearch:
              webSearchWanted && !nativeSearch && clientSearch !== null
                ? { said: clientSearch.said }
                : null,
            fromCodex: codexHints.fromCodex,
            compaction: codexHints.compaction,
          });
          upstreamBody = built.body;
          masking = built.masking;
          maskingMs = built.tookMs;
          toolSearch = built.toolSearch;
        } catch (error) {
          if (error instanceof MaskingUnavailableError) {
            // myna's masking.model: the user asked for the model, and it is
            // broken, not busy. Sending the rules' masking alone would be
            // a promise the settings page doesn't make.
            res.status(503).json({
              error: {
                message: `masking failed, so nothing was sent: ${error.message}`,
                type: "masking_failed",
              },
            });
            return null;
          }
          res.status(400).json({
            error: { message: errorMessage(error), type: "invalid_request" },
          });
          return null;
        }
        if (input.vision !== undefined) {
          try {
            upstreamBody = await input.vision.prepareBody({
              config,
              candidate: target,
              protocol: upstreamProtocol,
              body: upstreamBody,
              masker: maskingEnabled ? masker : null,
              send: visionSend(req),
              convertWebp: input.vision.webpRefused(target.provider.id),
            });
          } catch (error) {
            const current = error instanceof CurrentImageError;
            res.status(current ? 400 : 502).json({
              error: {
                message: errorMessage(error),
                type: current ? "image_not_supported" : "image_description_failed",
              },
            });
            return null;
          }
        }
        if (masking !== null) {
          lastMasked = { candidate: target, hits: masking.hits, tookMs: maskingMs };
        }
        if (maskingBlocked(masking, res)) {
          maskingRecords?.add({
            gatewayCallId,
            agent: clientName,
            provider: target.provider.id,
            model: target.model.id,
            hits: (masking as { hits: MaskHit[] }).hits,
            tookMs: maskingMs,
            blocked: true,
          });
          return null;
        }
        return {
          candidate: target,
          upstreamProtocol,
          upstreamBody,
          nativeSearch,
          masking,
          maskingMs,
          toolSearch,
          sessionToken: auto?.sessionToken,
          auto,
        };
      };
      const preparedCandidate = await prepareCandidate(candidate);
      if (preparedCandidate === null) {
        return;
      }
      const {
        candidate: servedCandidate,
        upstreamProtocol,
        upstreamBody,
        nativeSearch,
        masking,
        maskingMs,
        toolSearch,
        sessionToken,
        auto: autoResolved,
      } = preparedCandidate;
      /** What a failed try leaves the ones after it: a refusal handed over
       * in the same reply, Antigravity's prompt turned away, or Copilot
       * refusing its Auto pick (the same candidate is asked again). Null
       * when it left none. */
      const tookAside = (result: CandidateAttemptResult): "over" | "turned" | "again" | null => {
        if (result.handover !== undefined) {
          // The safety filter refused this try after its reasoning, with
          // nothing of an answer yet: the next candidate continues the same
          // reply (myna's refusal_handover.go). It rests nobody.
          handover = result.handover;
          refusals += 1;
          noteStatus(result.status);
          return "over";
        }
        if (result.turnedAway !== undefined) {
          // Antigravity refused the request, not the account: it is told as
          // the agent's prompt turned away, and nobody else rests for it
          // (myna's gateway.go:4040-4055).
          antigravityTurnedAwayAt.set(homeScope, Date.now());
          turnedAwayHint = result.turnedAway;
          noteStatus(result.status);
          return "turned";
        }
        return reaskCopilotAuto(copilotRetries, index, autoResolved, result) ? "again" : null;
      };
      const serveSubscription = async (
        member: GatewayCandidate,
        maskedBody: Record<string, unknown>,
        searched: boolean,
        masked: { hits: MaskHit[]; blocked: boolean } | null,
        tookMs: number,
      ): Promise<boolean> => {
        if (input.claude === undefined) {
          return false;
        }
        const restore =
          maskingEnabled && masker !== null
            ? masker.createRestorer({ counts: restoreCounts })
            : null;
        const served = await serveSubscriptionCandidate({
          claude: input.claude,
          candidate: member,
          body: maskedBody,
          webSearch: searched,
          res,
          leanPrompt: config.claudeLeanPrompt,
          printMode: config.claudePrintMode,
          ...(restore === null ? {} : { restorer: restore }),
          headers: req.headers,
        });
        if (served !== null) {
          if (masked !== null && served === 200) {
            maskingRecords?.add({
              gatewayCallId,
              agent: clientName,
              provider: member.provider.id,
              model: member.model.id,
              hits: masked.hits,
              tookMs,
              blocked: false,
              back: restoredBack(restoreCounts),
            });
          }
          finishRoute(served === 200, served);
          return true;
        }
        return false;
      };

      // Antigravity turned this system prompt away lately: it isn't asked
      // again while someone after it may answer (myna's gateway.go:3312).
      if (skipForeseen(candidate, upstreamProtocol, upstreamBody, last)) {
        continue;
      }
      if (
        await serveSubscription(servedCandidate, upstreamBody, nativeSearch, masking, maskingMs)
      ) {
        return;
      }
      const canHandOver = handsOver({
        streams: body.stream === true,
        last,
        wantWhole: false,
        from: protocol,
        refusals,
        retries: config.refusalRetries,
      });
      const result = await runCandidateAttempts({
        config,
        candidate: servedCandidate,
        upstreamBody,
        upstreamProtocol,
        protocol,
        body,
        req,
        res,
        ledger,
        routingState,
        accountState,
        quotaTracker,
        principalKey: principal.key,
        hooks,
        conversationKey,
        turnNumber: turn.turn,
        withinTurn: turn.within,
        ...(factoryWireLeft(servedCandidate) ? { factoryRetry: true } : {}),
        maskingEnabled,
        masker,
        restoreCounts,
        attempts,
        startedAt,
        logger,
        onStickyChange,
        onRestChange,
        onRestCleared,
        pricing: input.runtime?.pricing ?? null,
        accountFilter,
        requestId: randomUUID(),
        gatewayCallId,
        prompt,
        wireHook,
        visionSend,
        toolSearch,
        ...(input.neolixHome === undefined
          ? {}
          : { gatewayDir: join(input.neolixHome, "gateway") }),
        search:
          webSearchWanted && !nativeSearch && clientSearch !== null
            ? { query: clientSearch.query, pages: clientSearch.pages }
            : null,
        ...(input.vision === undefined ? {} : { vision: input.vision }),
        ...(input.history === undefined ? {} : { history: input.history }),
        ...(handover === undefined ? {} : { handover }),
        ...(canHandOver ? { canHandOver } : {}),
        copilotSessionToken: sessionToken,
        ...(autoResolved === null ? {} : { copilotAuto: true }),
        ...(titleLink === null ? {} : { titleLink }),
        otherCandidates: hasOtherCandidates(queue, index, candidate),
        trace:
          routeTrace === undefined || route === null
            ? undefined
            : { trace: routeTrace, routeId: route.id },
      });
      /** The masking this served reply's client is told about. */
      const noteServedMask = (): void => {
        if (masking === null) {
          return;
        }
        maskingRecords?.add({
          gatewayCallId,
          agent: clientName,
          provider: servedCandidate.provider.id,
          model: servedCandidate.model.id,
          hits: masking.hits,
          tookMs: maskingMs,
          blocked: false,
          back: restoredBack(restoreCounts),
        });
      };
      if (result.delivered) {
        noteServedMask();
        finishRoute(true, null);
        return;
      }
      const aside = tookAside(result);
      if (aside !== null) {
        // Copilot's Auto refusing its pick asks this same candidate again,
        // with a fresh one (myna's copilot_refused.go).
        if (aside === "again") {
          index -= 1;
        }
        continue;
      }
      noteStatus(result.status);
      // The last of this round asks the ones back soon again, after a pause.
      noteReplan(
        await notePatienceFailure(
          state,
          candidate,
          result,
          last,
          res,
          queue,
          keepsPauseAlive(body, protocol),
        ),
      );
      continue;
    }

    const failAll = (): void => {
      if (lastMasked !== null) {
        maskingRecords?.add({
          gatewayCallId,
          agent: clientName,
          provider: lastMasked.candidate.provider.id,
          model: lastMasked.candidate.model.id,
          hits: lastMasked.hits,
          tookMs: lastMasked.tookMs,
          blocked: false,
          back: restoredBack(restoreCounts),
        });
      }
      finishRoute(false, lastStatus);
      // The reply a refused try began is open: the last failure ends it as
      // the stream's error, as no status or JSON can follow (myna's failTo).
      if (handover !== undefined && res.headersSent) {
        res.write(loopErrorEvent(protocol, `All upstreams failed for ${String(body.model)}`));
        res.end();
        return;
      }
      // A Claude Code signed in to claude.ai sent its own sign-in as the
      // key: the last provider's 401 (or revoked 403) is told as Neolix's
      // credential refused, never as that sign-in (myna's claude_signin.go).
      const upstreamError = (res.locals as Record<string, unknown>).upstreamError as
        | { status: number; body: string }
        | undefined;
      const signInFailure =
        upstreamError === undefined || !isClaudeSignIn(req.headers.authorization)
          ? null
          : claudeSignInFailure({
              status: upstreamError.status,
              body: upstreamError.body,
              provider: planned.at(-1)?.provider.id,
            });
      if (signInFailure !== null) {
        res.status(signInFailure.status);
        res.setHeader("content-type", "application/json");
        res.send(signInFailure.body);
        return;
      }
      if (turnedAwayHint !== null) {
        res.status(ANTIGRAVITY_TURNED_AWAY_STATUS).json({
          error: {
            message: turnedAwayHint,
            type: ANTIGRAVITY_TURNED_AWAY_ERR_TYPE,
            upstream_status: lastStatus,
          },
        });
        return;
      }
      res.status(502).json({
        error: {
          message: `All upstreams failed for ${body.model}`,
          type: "gateway_error",
          upstream_status: lastStatus,
        },
      });
    };
    // Every candidate is out or resting. A Codex account whose week is used
    // up may spend a reset and come back for this request (myna's
    // codex_autoreset.go:21); once only, so a second failure is final.
    if (await spendWeekReset()) {
      await walkCandidates();
      return;
    }
    failAll();
  };
  try {
    // A provider asked by name whose accounts are all held at their caps
    // ends the request at 429 rather than at its fallbacks (myna's CapStop).
    if (refuseAtProviderCap({ config, routingModel, planned, accountState, res, finishRoute })) {
      return;
    }
    await walkCandidates();
  } finally {
    // The held usage goes back whatever way the request left: delivered,
    // refused, or the client gone.
    reservation.release();
  }
}

/** What a patience round leaves the trace: the pause, the members asked
 * next, and the budget it was given (myna's Try.Again/Replan/Patience). */
interface PatienceReplan {
  waitMs: number;
  replan: number;
  patience: number;
}

/** Whether a pause must keep the agent's stream alive: it asked for one,
 * and it isn't Gemini's, which turns a comment away. */
function keepsPauseAlive(body: CompletionBody, protocol: GatewayProtocol): boolean {
  return body.stream === true && protocol !== "gemini";
}

/** The state of a group's patience across its members' rounds. */
interface PatienceState<C> {
  busyNow: BusyTry<C>[];
  rounds: number;
  /** When every member had first failed; 0 until then. */
  waitFrom: number;
  /** The group's patience, for a member that sets none. */
  fallbackMs: number;
  /** The longest member's patience: 0 leaves the last error as it was. */
  patienceMs: number;
  isGroup: boolean;
}

/** The candidates whose models aren't switched off, or the refusal to tell
 * when every one of them is (myna's gateway/disabled.go). */
function enabledCandidates(
  config: GatewayConfig,
  candidates: GatewayCandidate[],
): { candidates: GatewayCandidate[] } | { refusal: { status: 403; message: string } } {
  const allowed = candidates.filter(
    (candidate) =>
      disabledCandidateRefusal(config, candidate.provider.id, candidate.model.id) === null,
  );
  if (allowed.length > 0 || candidates.length === 0) {
    return { candidates: allowed };
  }
  const refusal = candidates
    .map((candidate) => disabledCandidateRefusal(config, candidate.provider.id, candidate.model.id))
    .find((entry) => entry !== null);
  return {
    refusal: refusal ?? { status: 403, message: "the model is switched off" },
  };
}

/** Tells the client that masking held the request back; true when it did. */
function maskingBlocked(
  masking: { hits: MaskHit[]; blocked: boolean } | null,
  res: ExpressResponse,
): boolean {
  if (masking?.blocked !== true) {
    return false;
  }
  const kinds = [
    ...new Set(masking.hits.filter((hit) => hit.action === "block").map((hit) => hit.kind)),
  ];
  res.status(400).json({
    error: {
      message: `Held back by masking: ${kinds.join(", ") || "a value"} is set to block`,
      type: "masking_blocked",
    },
  });
  return true;
}

/** What the request tells of its own shaping: Codex sent it, and whether
 * it is a compaction (myna's CodexAsSent and compactionTriggerIn). */
function codexBodyHints(input: { req: ExpressRequest; agent: string; body: CompletionBody }): {
  fromCodex: boolean;
  compaction: boolean;
} {
  return {
    fromCodex: input.agent === "codex" || codexOriginator(input.req),
    compaction: isRecord(input.body) && hasCompactionTrigger(input.body),
  };
}

/**
 * The model an agent's request that masking would change goes to as
 * written, when the user picked one whose every route takes it unmasked
 * and the calling key may use it (myna's RedactRouteTo).
 */
async function maskRouteForRequest(input: {
  config: GatewayConfig;
  masker: Masker;
  body: CompletionBody;
  routeTo: string | undefined;
  agentTurn: boolean;
  principal: GatewayPrincipal | null;
}): Promise<string | null> {
  const routeTo = (input.routeTo ?? "").trim();
  if (!input.agentTurn || routeTo === "" || input.principal === null) {
    return null;
  }
  let candidates: GatewayCandidate[];
  try {
    candidates = resolveGatewayCandidates(input.config, routeTo);
  } catch {
    return null;
  }
  const unmasked =
    candidates.length > 0 &&
    candidates.every((candidate) => candidate.provider.unredacted === true);
  try {
    await input.masker.prime(input.body);
  } catch (error) {
    // The request's own masking pass reads the model again and holds it
    // back; there is nothing to route here.
    if (!(error instanceof MaskingUnavailableError)) {
      throw error;
    }
    return null;
  }
  const probe = input.masker.maskValueWithHits(input.body);
  return maskRouteFor({
    hits: probe.hits,
    agentTurn: input.agentTurn,
    routeTo,
    target: { id: routeTo, unmasked },
    keyAllows: keyAllowsRoute(input.principal, routeTo, candidates),
  });
}

/** Whether the calling key may use the route, as checkAccess reads it. */
function keyAllowsRoute(
  principal: GatewayPrincipal,
  route: string,
  candidates: readonly GatewayCandidate[],
): boolean {
  const allowed = principal.models;
  if (allowed.length === 0 || allowed.includes(route)) {
    return true;
  }
  return candidates.some((candidate) => {
    const key = `${candidate.provider.id}/${candidate.model.id}`;
    return (
      allowed.includes(key) ||
      allowed.includes(candidate.model.id) ||
      allowed.includes(`${candidate.provider.id}/*`)
    );
  });
}

/**
 * myna's CapStop: a provider asked by name whose every account serving the
 * model is held at its usage or spend cap answers 429 rather than going on
 * to its fallbacks. True when the request was answered.
 */
function refuseAtProviderCap(input: {
  config: GatewayConfig;
  routingModel: string;
  planned: readonly GatewayCandidate[];
  accountState: AccountRoutingState;
  res: ExpressResponse;
  finishRoute: (delivered: boolean, status: number | null) => void;
}): boolean {
  const requested =
    groupByRequest(input.config, input.routingModel) === null ? input.planned[0] : undefined;
  if (
    requested === undefined ||
    !providerAtCap(input.accountState, requested.provider, Date.now(), requested.model.id)
  ) {
    return false;
  }
  const message = `usage cap reached: every account that serves ${JSON.stringify(
    requested.model.id,
  )} is held at the usage cap set on it`;
  input.finishRoute(false, 429);
  input.res.status(429).json({ error: { message, type: "quota_exceeded" } });
  return true;
}

/** How many times one candidate's Copilot Auto may be asked again. */
const COPILOT_AUTO_RETRIES = 4;

/**
 * What a Copilot Auto refusal leaves to ask again (myna's
 * `copilot_refused.go`): a model is marked refused so the next pick is
 * another, a session is let go and asked anew, and an endpoint is left out
 * so the same pick goes to another API. True when the candidate is to be
 * asked again.
 */
function reaskCopilotAuto(
  states: Map<number, { avoid: Set<CopilotProtocol>; fresh: boolean; tries: number }>,
  index: number,
  auto: CopilotAutoResolved | null,
  result: CandidateAttemptResult,
): boolean {
  return (
    auto !== null &&
    result.copilot !== undefined &&
    retryCopilotAuto(states, index, auto, result.copilot)
  );
}

function retryCopilotAuto(
  states: Map<number, { avoid: Set<CopilotProtocol>; fresh: boolean; tries: number }>,
  index: number,
  auto: CopilotAutoResolved,
  refusal: CopilotRefusal,
): boolean {
  const state = states.get(index) ?? { avoid: new Set<CopilotProtocol>(), fresh: false, tries: 0 };
  if (state.tries >= COPILOT_AUTO_RETRIES) {
    return false;
  }
  state.tries += 1;
  switch (refusal) {
    case "model":
      markRefused(auto.account, auto.pick.model);
      state.fresh = true;
      break;
    case "session":
      invalidateSession(auto.account);
      state.fresh = true;
      break;
    case "endpoint": {
      const next = copilotEndpointFallbacks(auto.protocol, auto.pick.endpoints).find(
        (api) => !state.avoid.has(api),
      );
      if (next === undefined) {
        return false;
      }
      // the same pick goes to the next API, not a new model
      state.avoid.add(auto.protocol);
      break;
    }
  }
  states.set(index, state);
  return true;
}

/**
 * A candidate whose every account is on its credits, set to spend them
 * last, goes behind the fallbacks too: myna's restLast orders such a
 * candidate after every candidate that isn't (a subscription's credits
 * after an API key fallback).
 */
function creditsLastBehindFallbacks(
  queue: readonly GatewayCandidate[],
  accountState: AccountRoutingState,
  now: number,
): GatewayCandidate[] {
  const ready: GatewayCandidate[] = [];
  const last: GatewayCandidate[] = [];
  for (const candidate of queue) {
    const onLast = allAccountsCreditLast({
      provider: candidate.provider,
      state: accountState,
      now,
      modelId: candidate.model.id,
    });
    (onLast ? last : ready).push(candidate);
  }
  return [...ready, ...last];
}

/**
 * The fallbacks a request that names a provider goes on to, none for a
 * group request (a member's fallbacks are not the group's).
 */
function providerFallbackQueue(
  config: GatewayConfig,
  routingModel: string,
  planned: readonly GatewayCandidate[],
): GatewayCandidate[] {
  if (groupByRequest(config, routingModel) !== null || planned[0] === undefined) {
    return [];
  }
  return providerFallbacks(config, planned);
}

/**
 * The fallbacks of the provider a request names, after its own candidates
 * (myna's Fallback, `providers_cli.go`): each one once, never a candidate
 * already planned, and never a group that leads back to one.
 */
function providerFallbacks(
  config: GatewayConfig,
  planned: readonly GatewayCandidate[],
): GatewayCandidate[] {
  const provider = planned[0]?.provider;
  if (provider === undefined) {
    return [];
  }
  const seen = new Set(
    planned.map((candidate) => `${candidateKey(candidate)}/${candidate.provider.protocol}`),
  );
  return fallbackCandidates(config, provider.id).filter((candidate) => {
    const key = `${candidateKey(candidate)}/${candidate.provider.protocol}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

/** What kind of turn Codex says this is, as it says it (myna's title
 * kinds): the subagent header, else the turn metadata's thread_source. */
function titleKindOf(req: ExpressRequest, body: Record<string, unknown>): string | null {
  const subagent = req.get("x-openai-subagent");
  if (subagent !== undefined && subagent.length > 0) {
    return subagent;
  }
  const client = isRecord(body.client_metadata) ? body.client_metadata : {};
  const raw = req.get(TURN_METADATA_HEADER) ?? client[TURN_METADATA_HEADER];
  if (typeof raw !== "string" || raw.length === 0) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) &&
      typeof parsed.thread_source === "string" &&
      parsed.thread_source.length > 0
      ? parsed.thread_source
      : null;
  } catch {
    return null;
  }
}

/** Whether a provider other than this candidate's is left to try. */
function hasOtherCandidates(
  queue: readonly GatewayCandidate[],
  index: number,
  candidate: GatewayCandidate,
): boolean {
  return queue.slice(index + 1).some((member) => member.provider.id !== candidate.provider.id);
}

/** Whether a request came from Codex's own CLI, by its originator. */
function codexOriginator(req: ExpressRequest): boolean {
  return (req.get("originator") ?? "").toLowerCase() === "codex_cli_rs";
}

/**
 * A Responses body as the vendor under it takes it, in myna's order
 * (gateway.go:5661-5690): Lite lifted out, tool_search offered as a
 * function unless the account is ChatGPT's own, the vendor's own fields,
 * and access programs only where the vendor keeps them. Codex's own body
 * goes as sent when the provider says so.
 */
function fitResponsesBody(input: {
  body: Record<string, unknown>;
  provider: GatewayProvider;
  fromCodex: boolean;
  compaction: boolean;
}): { body: Record<string, unknown>; toolSearch: boolean } {
  if (codexRequestAsSent(input.provider, input.fromCodex)) {
    return { body: input.body, toolSearch: false };
  }
  let body = input.body;
  if (!liteKept(input.provider, { fromCodex: input.fromCodex })) {
    body = fromLite(body).body;
  }
  let toolSearch = false;
  if (!chatGptAccount(input.provider)) {
    const searched = searchAsFunction(body);
    body = searched.body;
    toolSearch = searched.search === true;
  }
  body = forVendor(body, {
    openAi: chatGptAccount(input.provider) || onOpenAiHost(input.provider),
    compaction: input.compaction,
  }).body;
  if (!keepsAccessPrograms(input.provider, input.fromCodex)) {
    body = withoutAccessPrograms(body).body;
  }
  return { body, toolSearch };
}

/**
 * Whether this request goes to the provider's own search: it asked for a
 * search, SearchAll doesn't take it over, the provider speaks the client's
 * wire (the client's own tool is passed through untranslated), and the
 * provider searches by itself.
 */
function nativeSearchFor(input: {
  wanted: boolean;
  all: boolean;
  upstreamProtocol: GatewayProtocol;
  clientProtocol: GatewayProtocol;
  provider: GatewayProvider;
  accountState: AccountRoutingState;
  modelId: string;
}): boolean {
  return (
    input.wanted &&
    !input.all &&
    input.upstreamProtocol === input.clientProtocol &&
    providerSearchesItself(input.provider, input.accountState, input.modelId)
  );
}

/**
 * Whether the provider searches by itself for this request (myna's
 * searchesItself): a subscription account decides on its own rules, a key
 * on the provider's host.
 */
function providerSearchesItself(
  provider: GatewayProvider,
  accountState: AccountRoutingState,
  modelId: string,
): boolean {
  const account = planAccounts({
    provider,
    state: accountState,
    now: Date.now(),
    modelId,
  })[0];
  const subscription =
    account !== undefined && (account.agent !== undefined || account.codexAccountId !== undefined)
      ? account
      : null;
  return providerCanSearch(provider, { account: subscription });
}

/** The candidate Copilot's Auto picked for, or the one asked for. */
function autoTarget(
  auto: { candidate: GatewayCandidate } | null,
  member: GatewayCandidate,
): GatewayCandidate {
  return auto === null ? member : auto.candidate;
}

/**
 * Copilot's Auto: asks Copilot which model to use and which API serves it,
 * as Copilot's own clients do (myna's copilot_auto.go), and sends the
 * request there with the session token its pick names.
 */
interface CopilotAutoResolved {
  candidate: GatewayCandidate;
  sessionToken?: string;
  account: CopilotAccountRef;
  pick: CopilotAutoPick;
  /** The API the request is sent on. */
  protocol: CopilotProtocol;
}

async function resolveCopilotAuto(input: {
  config: GatewayConfig;
  candidate: GatewayCandidate;
  protocol: GatewayProtocol;
  body: CompletionBody;
  neolixHome?: string;
  /** APIs Copilot refused the model on, left out of this pick. */
  avoid?: ReadonlySet<CopilotProtocol>;
  /** Ask Copilot for a new pick instead of keeping the hour's. */
  fresh?: boolean;
  /** The fetch the ask goes through; tests inject one. */
  fetchImpl?: typeof fetch;
}): Promise<CopilotAutoResolved | null> {
  if (input.candidate.model.id !== COPILOT_AUTO || input.neolixHome === undefined) {
    return null;
  }
  const account = providerAccounts(input.candidate.provider).find(
    (entry) => entry.agent === "copilot",
  );
  if (account === undefined) {
    return null;
  }
  const stored = await loadSubscriptionAccount(
    join(input.neolixHome, "gateway"),
    "copilot",
    account.subscriptionUser ?? "",
  );
  if (stored === null || stored.agent !== "copilot") {
    return null;
  }
  const pick = await copilotAutoPick({
    githubToken: stored.githubToken,
    host: stored.host,
    prompt: lastUserText(input.protocol, input.body),
    ...(input.config.proxy === undefined ? {} : { proxy: input.config.proxy }),
    ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
    ...(input.fresh === true ? { fresh: true } : {}),
  });
  if ("error" in pick) {
    return null;
  }
  const supported = copilotApisOf(pick.endpoints ?? []);
  const left = supported.filter((api) => input.avoid?.has(api) !== true);
  const apis = left.length === 0 ? supported : left;
  const target: GatewayProtocol =
    apis.find((api) => api === input.protocol) ?? apis[0] ?? input.candidate.provider.protocol;
  const provider =
    target === input.candidate.provider.protocol
      ? input.candidate.provider
      : { ...input.candidate.provider, protocol: target };
  return {
    candidate: {
      ...input.candidate,
      provider,
      model: { ...input.candidate.model, id: pick.model, upstreamName: pick.model },
    },
    ...(pick.sessionToken === null ? {} : { sessionToken: pick.sessionToken }),
    account: { githubToken: stored.githubToken, host: stored.host },
    pick,
    protocol: target,
  };
}

/**
 * The innermost group that sets a patience, the outer one when none does
 * (myna's #2410: a member of a group in the group uses the innermost that
 * sets Patience). Null for a model that is no group.
 */
function patienceGroupOf(config: GatewayConfig, routingModel: string): GatewayGroup | null {
  const outer = groupByRequest(config, routingModel);
  if (outer === null) {
    return null;
  }
  let found: GatewayGroup | null = outer;
  let group = outer;
  for (let depth = 0; depth < 4; depth++) {
    const inner = group.members.find((member) => member.startsWith("group/"));
    const next = inner === undefined ? null : groupByRequest(config, inner);
    if (next === null) {
      break;
    }
    group = next;
    if (group.patience !== undefined) {
      found = group;
    }
  }
  return found;
}

/** A group's patience in milliseconds: unset is myna's minute, 0 is off. */
function groupPatienceMs(group: GatewayGroup): number {
  if (group.patience === undefined) {
    return SINGLE_PATIENCE_MS;
  }
  if (group.patience === 0) {
    return 0;
  }
  return Math.min(group.patience, PATIENCE_LONGEST_S * 1000);
}

/** The patience a request starts with: the group's when the model names one,
 * and each member's own budget, the longest of which decides whether any
 * round may be waited for at all (myna's gateway.go:3078). */
function patienceStateFor(
  config: GatewayConfig,
  planned: readonly GatewayCandidate[],
  routingModel: string,
): PatienceState<GatewayCandidate> {
  const isGroup = routingModel.startsWith("group/");
  const group = isGroup ? patienceGroupOf(config, routingModel) : null;
  const fallbackMs =
    group !== null
      ? groupPatienceMs(group)
      : waitsOf(memberPatienceOf(planned[0]?.provider), SINGLE_PATIENCE_MS);
  return {
    busyNow: [],
    rounds: 0,
    waitFrom: 0,
    fallbackMs,
    patienceMs: maxWaits(
      planned.map((member) => ({ patience: memberPatienceOf(member.provider) })),
      fallbackMs,
    ),
    isGroup,
  };
}

/**
 * Records a failed member for a group's patience, and on the last of the
 * round waits out the pause and names the members to ask again (myna's
 * patience.go: noteBusy, replan).
 */
async function notePatienceFailure(
  state: PatienceState<GatewayCandidate>,
  candidate: GatewayCandidate,
  result: CandidateAttemptResult,
  last: boolean,
  res: ExpressResponse,
  queue: GatewayCandidate[],
  keepAlive: boolean,
): Promise<PatienceReplan | null> {
  const failure = result.failure;
  const memberPatience = memberPatienceOf(candidate.provider);
  const memberWaitMs = waitsOf(memberPatience, state.fallbackMs);
  const lastBusy = failure !== undefined && busy(failure.status, failure.body);
  const note = (): void => {
    if (failure === undefined) {
      return;
    }
    state.busyNow = noteBusy(
      state.busyNow,
      candidate,
      memberIdentity(candidate),
      failure.retryAfterMs,
      Date.now(),
      memberPatience,
    );
  };
  if (!last) {
    // A member that may be over it in a moment joins the round's, once.
    if (memberWaitMs > 0 && lastBusy) {
      note();
    }
    return null;
  }
  // The last of this round: every member has failed. A member out of its
  // allowance last, after one that may pass, has the earlier ones asked
  // again too (myna's lastSpent).
  const lastSpent =
    state.isGroup &&
    state.busyNow.length > 0 &&
    !lastBusy &&
    failure !== undefined &&
    isCreditFailure(failure.status, failure.body);
  if (state.patienceMs <= 0 || (!lastBusy && !lastSpent)) {
    return null;
  }
  if (state.waitFrom === 0) {
    state.waitFrom = Date.now();
  }
  if (memberWaitMs > 0 && !lastSpent) {
    note();
  }
  const next = replan(state.busyNow, state.rounds, state.waitFrom, state.fallbackMs, Date.now());
  if (next === null || !(await pauseUnlessGone(res, next.waitMs, keepAlive))) {
    return null;
  }
  state.rounds += 1;
  state.busyNow = [];
  queue.push(...next.candidates);
  return {
    waitMs: next.waitMs,
    replan: next.candidates.length,
    patience: Math.round((memberWaitMs > 0 ? memberWaitMs : state.patienceMs) / 1000),
  };
}

/**
 * When Antigravity last turned away a system prompt it refuses, by the
 * daemon's home (myna's Server.agTurnedAway): while that is recent, a group
 * skips an Antigravity account for such a request when someone is left
 * after it. Keyed by the home so two daemons in one process (tests) never
 * read each other's.
 */
const antigravityTurnedAwayAt = new Map<string, number>();

/** Why Antigravity would turn this request away again, as it did within
 * the foreseeing window; null when the account would be asked. */
function foreseenTurnedAway(
  provider: GatewayProvider,
  protocol: GatewayProtocol,
  body: Record<string, unknown>,
  now: number,
  scope: string,
): string | null {
  const at = antigravityTurnedAwayAt.get(scope) ?? 0;
  if (at === 0 || now - at > ANTIGRAVITY_FORESEEN_MS) {
    return null;
  }
  if (!providerAccounts(provider).some((account) => account.agent === "antigravity")) {
    return null;
  }
  const system = systemOfBody(protocol, body);
  return system !== "" && antigravityTurnsAway(system) ? antigravityHint(system) : null;
}

/** The system prompt a body carries, as its protocol reads it. */
function systemOfBody(protocol: GatewayProtocol, body: Record<string, unknown>): string {
  try {
    return codecFor(protocol).parseRequest(body).system ?? "";
  } catch {
    return "";
  }
}

/**
 * How long a request to a member alone is kept, in seconds: 0 follows the
 * group's patience, negative is none. Neolix keeps it in milliseconds, where
 * 0 is myna's PatienceOff (myna's provider.Patience).
 */
function memberPatienceOf(provider: GatewayProvider | undefined): number {
  const ms = provider?.patienceMs;
  if (ms === undefined) {
    return 0;
  }
  return ms === 0 ? -1 : ms / 1000;
}

/** A member as patience counts it: the account and the effort it is asked
 * at, myna's restKey plus effort. */
function memberIdentity(candidate: GatewayCandidate): string {
  return `${candidateKey(candidate)}\u0000${candidate.effort ?? candidate.ruleEffort ?? ""}`;
}

/**
 * Waits out a pause before the members are asked again, false when the
 * client goes away first. A streaming agent is not kept alive through the
 * pause the way myna's holdWriter does: no upstream has answered, so the
 * reply's headers aren't the gateway's to send yet.
 */
function pauseUnlessGone(
  res: ExpressResponse,
  waitMs: number,
  keepAlive: boolean,
): Promise<boolean> {
  if (res.destroyed || res.writableEnded) {
    return Promise.resolve(false);
  }
  const beat = keepAlive ? keepReplyAlive(res) : null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closedHandler: (() => void) | null = null;
  const closed = new Promise<boolean>((resolve) => {
    closedHandler = () => resolve(false);
    res.once("close", closedHandler);
  });
  const waited = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(true), waitMs);
  });
  return Promise.race([closed, waited]).then((waitedFirst) => {
    if (timer !== null) {
      clearTimeout(timer);
    }
    if (beat !== null) {
      clearInterval(beat);
    }
    if (closedHandler !== null) {
      res.off("close", closedHandler);
    }
    return waitedFirst;
  });
}

/** How long a stream held in a pause waits before the agent is first told
 * it is still there (myna's keepHeldAfter). */
const KEEP_HELD_AFTER_MS = 3_000;
/** How often the comment comes after that (myna's keepHeldEvery). */
const KEEP_ALIVE_EVERY_MS = 5_000;

/**
 * Tells the agent a pause is still a stream: the reply's headers and a
 * `: keepalive` comment, as myna's holdWriter does. The comment has no
 * blank line after it, and Gemini streams have none at all (agy turns it
 * away, myna #934).
 */
function keepReplyAlive(res: ExpressResponse): ReturnType<typeof setInterval> {
  const started = Date.now();
  let opened = false;
  let last = 0;
  return setInterval(() => {
    if (res.writableEnded || res.destroyed) {
      return;
    }
    const now = Date.now();
    if (!opened) {
      if (now - started < KEEP_HELD_AFTER_MS) {
        return;
      }
      if (!res.headersSent) {
        res.status(200);
        res.setHeader("content-type", "text/event-stream; charset=utf-8");
        res.setHeader("cache-control", "no-cache");
      }
      opened = true;
    } else if (now - last < KEEP_ALIVE_EVERY_MS) {
      return;
    }
    last = now;
    res.write(": keepalive\n");
  }, 500);
}

function countCharacters(value: unknown): number {
  if (typeof value === "string") {
    return value.length;
  }
  if (Array.isArray(value)) {
    return value.reduce<number>((total, entry) => total + countCharacters(entry), 0);
  }
  if (isRecord(value)) {
    return Object.values(value).reduce<number>((total, entry) => total + countCharacters(entry), 0);
  }
  return 0;
}

interface BuildAttemptBodyInput {
  config: GatewayConfig;
  candidate: GatewayCandidate;
  protocol: GatewayProtocol;
  clientBody: CompletionBody;
  translate: (
    target: GatewayProtocol,
    model: string,
    loadedInPlace?: boolean,
  ) => Record<string, unknown>;
  maskingEnabled: boolean;
  masker: Masker;
  /** What a search myna ran itself found, for a provider that can't search. */
  webSearch: { said: string } | null;
  /** The request came from Codex itself, whose Responses body it may keep. */
  fromCodex: boolean;
  /** The request is a compaction, which forVendor leaves whole. */
  compaction: boolean;
}

interface BuiltAttemptBody {
  body: Record<string, unknown>;
  masking: { hits: MaskHit[]; blocked: boolean } | null;
  tookMs: number;
  /** The request offered Responses' client-side tool_search. */
  toolSearch: boolean;
}

async function buildAttemptBody(input: BuildAttemptBodyInput): Promise<BuiltAttemptBody> {
  const target = input.candidate.provider.protocol;
  const translated =
    target === input.protocol
      ? { ...input.clientBody, model: input.candidate.model.id }
      : input.translate(
          target,
          input.candidate.model.id,
          target === "openai-responses" && loadsAdditionalToolsInPlace(input.candidate.provider),
        );
  // A Chat body bound to Gemini's OpenAI-compatible API carries its call
  // signatures in extra_content (myna's gemini_signature.go).
  const signed = withOpenAiCallSignatures(input.candidate.provider, translated);
  // Claude's sealed reasoning is this gateway's, not a Responses API's.
  const unsealed = target === "openai-responses" ? withoutClaudeSeals(signed) : signed;
  // A client that keeps no reasoning item has the upstream's reasoning
  // sealed so it can ride in the calls' ids (myna's reasoning_carry.go).
  const reasoned =
    target === "openai-responses" &&
    input.protocol !== "openai-responses" &&
    isGrokLike(input.candidate.provider)
      ? withSealedReasoning(unsealed)
      : unsealed;
  // Codex's tool_search is a client-side tool: the upstream is offered a
  // function named tool_search, and its history is rewritten to match (myna's
  // toolsearch.go). A ChatGPT-backend request keeps the tool its own way.
  // A Responses body is fitted to the vendor under it, and Codex's
  // tool_search offered as a function unless the account is ChatGPT's own
  // (myna gateway.go:5661-5690, codex-lite.ts).
  const fitted =
    target === "openai-responses"
      ? fitResponsesBody({
          body: reasoned,
          provider: input.candidate.provider,
          fromCodex: input.fromCodex,
          compaction: input.compaction,
        })
      : { body: reasoned, toolSearch: false };
  const withTools = shapeTools({
    protocol: target,
    provider: input.candidate.provider,
    body: fitted.body,
  });
  const withRefusals = fixToolRefusals(
    withTools,
    target,
    toolRefusalsFor(input.candidate.model.id),
  );
  // A provider that turned away Codex's image tool is not offered it again.
  const withImageTool =
    target === "openai-responses" && imageToolRefusedBefore(input.candidate.provider.id)
      ? withoutImageToolRequest(withRefusals).body
      : withRefusals;
  const withOverrides = applyOverrides(
    input.config,
    input.clientBody.model,
    input.candidate.model.id,
    withImageTool,
  );
  const withGroup = applyGroupMemberSettings(
    input.candidate,
    target,
    input.candidate.model.id,
    withOverrides,
  );
  const capped =
    input.candidate.model.maxOutputTokens === undefined
      ? withGroup
      : (withMaxOutput(target, withGroup, input.candidate.model.maxOutputTokens) ?? withGroup);
  const compatBody = continueIfAssistantLast(target, dropBillingLine(target, capped));
  const claudeBody =
    target === "anthropic"
      ? claudeCompatBody(
          input.candidate.provider,
          String(input.clientBody.model ?? ""),
          compatBody,
          input.candidate.model.id,
        )
      : compatBody;
  const compat = thinkingShapedBody(
    input.candidate.provider,
    target,
    input.candidate.model.id,
    claudeBody,
  );
  const withSearch =
    input.webSearch === null ? compat : withSearchResults(target, compat, input.webSearch.said);
  // A Chat body's pure-text typed parts go as the string the vendors take
  // (myna's chat_text_parts.go).
  const withParts = target === "openai" ? chatTextParts(withSearch) : withSearch;
  // A Chat call the client left without an id gets one, and the tool
  // messages that answer it too (myna's chatCallIDs, #2611).
  const withCalls = target === "openai" ? chatCallIds(withParts) : withParts;
  // xAI's own API takes neither a sealed reasoning item's null content nor
  // a system turn mid-conversation (myna's xai_body.go, gateway.go:5914).
  const withXai =
    hostOf(input.candidate.provider.baseUrl) === "api.x.ai"
      ? xaiBody(target, withCalls)
      : withCalls;
  // What a masking stand-in stood for, in the note the model reads (myna's
  // placeholder note); a Claude Code or ChatGPT-backend body keeps as it is.
  const toolSearch = fitted.toolSearch;
  return finishAttemptBody(input, withXai, toolSearch);
}

/**
 * Masks the body when the provider asks for it, then writes the note a
 * masking stand-in stands for (myna's placeholder_note.go). Both read the
 * provider's accounts, so they run after every other shaping.
 */
/** The host a provider's base URL names, "" when it names none. */
function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return "";
  }
}

async function finishAttemptBody(
  input: BuildAttemptBodyInput,
  body: Record<string, unknown>,
  toolSearch: boolean,
): Promise<BuiltAttemptBody> {
  const target = input.candidate.provider.protocol;
  const firstAccount = providerAccounts(input.candidate.provider)[0] ?? {};
  const noted = (value: Record<string, unknown>): Record<string, unknown> =>
    withPlaceholderNote(target, value, firstAccount);
  if (!masksRequests(input.candidate.provider, input.maskingEnabled)) {
    return { body: noted(body), masking: null, tookMs: 0, toolSearch };
  }
  const startedAt = performance.now();
  // The local model is async; its finds are taken before the sync masking
  // pass. A model that is on and fails throws, and the request is held
  // back rather than sent with the rules alone (myna's masking.model).
  await input.masker.prime(body);
  const masked = input.masker.maskValueWithHits(body);
  return {
    body: noted(assertRecord(masked.value, "masked request body")),
    masking: { hits: masked.hits, blocked: masked.blocked },
    tookMs: Math.round(performance.now() - startedAt),
    toolSearch,
  };
}

/**
 * Claude's own shaping of a request body: the shapes and betas it refused
 * before, and the advisor/automode fits that read the body's model
 * (myna's anthropic.go).
 */
function claudeCompatBody(
  provider: GatewayProvider,
  requestModel: string,
  body: Record<string, unknown>,
  modelId: string,
): Record<string, unknown> {
  return withoutRefusedBodyBetas(
    provider.id,
    unsaltRequestIds(
      withoutRefusedShapes(
        provider.id,
        fitAutomode(
          fitAdvisor({
            body,
            requestModel,
            providerId: provider.id,
            models: provider.models.map((entry) => entry.id),
          }),
          modelId,
        ),
      ),
    ),
    provider.baseUrl,
  );
}

/** Anthropic's thinking switched on where the provider needs it, and the
 * reasoning filled back in where the provider dropped it. */
function thinkingShapedBody(
  provider: GatewayProvider,
  target: GatewayProtocol,
  modelId: string,
  body: Record<string, unknown>,
): Record<string, unknown> {
  const enabled =
    target === "anthropic" && needsThinking(provider.id, modelId)
      ? withThinkingEnabled(body).body
      : body;
  return needsThinkingBack(provider.id, modelId, target)
    ? fillThinkingBack(target, enabled).body
    : enabled;
}

/**
 * A routing group may pin a member's reasoning and send it in the vendor's
 * fast mode. Both are written into the body the vendor reads, after protocol
 * translation and middleware overrides, as myna writes them.
 */
function applyGroupMemberSettings(
  candidate: GatewayCandidate,
  protocol: GatewayProtocol,
  modelId: string,
  body: Record<string, unknown>,
): Record<string, unknown> {
  const effort = candidate.ruleEffort ?? candidate.effort;
  const withEffort =
    effort === undefined ? body : applyReasoningEffort(protocol, modelId, body, effort);
  return candidate.fast === true ? applyFastMode(protocol, withEffort) : withEffort;
}

/** myna's budgetOf: an effort level as Anthropic's thinking budget. */
const THINKING_BUDGETS: Record<string, number> = {
  low: 4096,
  medium: 10000,
  high: 24000,
  xhigh: 32000,
  max: 32000,
};

function applyReasoningEffort(
  protocol: GatewayProtocol,
  modelId: string,
  body: Record<string, unknown>,
  effort: string,
): Record<string, unknown> {
  if (protocol === "openai") {
    return { ...body, reasoning_effort: openAiEffort(effort) };
  }
  if (protocol === "openai-responses") {
    const existing = isRecord(body.reasoning) ? body.reasoning : {};
    return { ...body, reasoning: { ...existing, effort: openAiEffort(effort) } };
  }
  if (protocol === "anthropic") {
    return applyAnthropicThinking(body, modelId, effort);
  }
  if (protocol === "gemini") {
    return applyGeminiThinking(body, modelId, effort);
  }
  return body;
}

/**
 * Anthropic takes a thinking budget under `max_tokens`, leaving room for the
 * answer: a client's cap is fitted, and a request without one is given a cap
 * above the budget. A cap of 2048 or less is left alone, as myna leaves it.
 *
 * Claude 4.5 and later refuse `type: "enabled"` and ask for adaptive thinking,
 * which decides its own budget, so those models get `type: "adaptive"` and no
 * budget. Other Anthropic-compatible upstreams still take the budget form.
 */
function applyAnthropicThinking(
  body: Record<string, unknown>,
  modelId: string,
  effort: string,
): Record<string, unknown> {
  if (claudeUsesAdaptiveThinking(modelId)) {
    return { ...body, thinking: { type: "adaptive" } };
  }
  const budget = THINKING_BUDGETS[effort] ?? THINKING_BUDGETS.medium;
  const maxTokens = typeof body.max_tokens === "number" ? body.max_tokens : 0;
  if (maxTokens > 0 && maxTokens <= 2048) {
    return body;
  }
  if (maxTokens > 0) {
    const fitted = Math.min(budget, maxTokens - 1024);
    return { ...body, thinking: { type: "enabled", budget_tokens: fitted } };
  }
  return {
    ...body,
    max_tokens: budget + 4096,
    thinking: { type: "enabled", budget_tokens: budget },
  };
}

/** Claude Opus/Sonnet/Haiku/Fable 4.5 and later take adaptive thinking only. */
function claudeUsesAdaptiveThinking(modelId: string): boolean {
  const match = /(?:claude-)?(?:opus|sonnet|haiku|fable)-(\d+)-(\d+)/i.exec(modelId);
  if (!match) {
    return false;
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 4 || (major === 4 && minor >= 5);
}

/**
 * Gemini 3 and later take a thinking level; earlier models take a budget, as
 * myna writes them.
 */
function applyGeminiThinking(
  body: Record<string, unknown>,
  modelId: string,
  effort: string,
): Record<string, unknown> {
  const generation = isRecord(body.generationConfig) ? body.generationConfig : {};
  const thinking =
    geminiGeneration(modelId) >= 3
      ? { includeThoughts: true, thinkingLevel: geminiLevel(effort) }
      : {
          includeThoughts: true,
          thinkingBudget: THINKING_BUDGETS[effort] ?? THINKING_BUDGETS.medium,
        };
  return { ...body, generationConfig: { ...generation, thinkingConfig: thinking } };
}

function geminiGeneration(modelId: string): number {
  const match = /(?:^|\/)gemini-(\d+)/.exec(modelId.toLowerCase());
  return match === null ? 0 : Number(match[1]);
}

function geminiLevel(effort: string): string {
  if (effort === "low") {
    return "low";
  }
  return effort === "medium" ? "medium" : "high";
}

function openAiEffort(effort: string): string {
  if (effort === "xhigh" || effort === "max") {
    return "high";
  }
  return effort;
}

function applyFastMode(
  protocol: GatewayProtocol,
  body: Record<string, unknown>,
): Record<string, unknown> {
  if (protocol === "anthropic") {
    return { ...body, speed: "fast" };
  }
  if (protocol === "openai" || protocol === "openai-responses") {
    return { ...body, service_tier: "priority" };
  }
  return body;
}

/**
 * Config middleware: a rule without `model` applies to every request; a rule
 * with one matches either the requested id or the upstream model id.
 */
function applyOverrides(
  config: GatewayConfig,
  requestedModel: string,
  servedModel: string,
  body: Record<string, unknown>,
): Record<string, unknown> {
  const rules = config.middleware?.overrides ?? [];
  if (rules.length === 0) {
    return body;
  }
  const result: Record<string, unknown> = { ...body };
  for (const rule of rules) {
    if (rule.model !== undefined && rule.model !== requestedModel && rule.model !== servedModel) {
      continue;
    }
    for (const key of rule.remove) {
      delete result[key];
    }
    Object.assign(result, rule.set);
  }
  return result;
}

const CONVERSATION_HEADER = "x-neolix-conversation";

function readConversationKey(req: ExpressRequest): string | null {
  const value = req.get(CONVERSATION_HEADER);
  return value !== undefined && value.trim().length > 0 ? value.trim() : null;
}

/**
 * The user's turns in a request's conversation, and whether it is the
 * agent handing tool results back within one (myna's turnIn): a turn
 * begins with what the user said, and an agent's own note after an answer
 * carries it on rather than beginning one.
 */
function turnOfRequest(
  protocol: GatewayProtocol,
  body: Record<string, unknown>,
): { turn: number; within: boolean } {
  let request: ReturnType<ReturnType<typeof codecFor>["parseRequest"]>;
  try {
    request = codecFor(protocol).parseRequest(body);
  } catch {
    return { turn: 0, within: false };
  }
  let turn = 0;
  let within = false;
  let answered = false;
  for (const message of request.messages) {
    if (message.role === "assistant") {
      answered = true;
    }
    if (message.role !== "user") {
      continue;
    }
    let said = false;
    let result = false;
    for (const part of message.parts) {
      if (part.type === "image") {
        said = true;
      } else if (part.type === "tool_result") {
        result = true;
      } else if (part.type === "text" && part.text.trim() !== "") {
        said = true;
      }
    }
    if (result) {
      within = true;
    } else if (said) {
      turn += 1;
      within = false;
    } else if (answered) {
      within = turn > 0;
    }
  }
  return { turn, within };
}

/**
 * A Chat body's call signatures: Gemini's own API takes them in
 * extra_content, any other Chat API gets the id the call had.
 */
function withOpenAiCallSignatures(
  provider: GatewayProvider,
  body: Record<string, unknown>,
): Record<string, unknown> {
  if (provider.protocol !== "openai") {
    return body;
  }
  return isGeminiCompat(provider.baseUrl)
    ? withGeminiCallSignatures(body, unsignCallId)
    : withoutCallSignatures(body, unsignCallId);
}

interface KeyAdminContext {
  req: ExpressRequest;
  res: ExpressResponse;
  configStore: GatewayRouterOptions["configStore"];
}

async function issueKey(input: KeyAdminContext): Promise<void> {
  const config = input.configStore.get();
  const principal = resolvePrincipal(input.req, config);
  if (principal === null || !principal.issues) {
    input.res
      .status(403)
      .json({ error: { message: "This key cannot issue keys", type: "forbidden" } });
    return;
  }
  const parsed = IssueKeyBodySchema.safeParse(input.req.body);
  if (!parsed.success) {
    input.res
      .status(400)
      .json({ error: { message: "Invalid key request", type: "invalid_request" } });
    return;
  }
  const body = parsed.data;
  // myna refuses a request naming any model the issuer may not use rather
  // than filtering it down (issue.go:122-127): a silently narrower key would
  // not be the one asked for.
  const uncovered = uncoveredModel(principal.models, body.models);
  if (uncovered !== null) {
    input.res.status(400).json({
      error: {
        message: `The key issuing may not use ${uncovered}, so the key it issues can't either`,
        type: "invalid_request",
      },
    });
    return;
  }
  const parent = gatewayKeyEntries(config).find((entry) => entry.key === principal.key);
  const issued = {
    id: newGatewayKeyId(),
    key: `pk_${randomUUID().replace(/-/g, "")}`,
    label: body.label,
    models: body.models,
    dailyTokens: clampLimit(body.dailyTokens, principal.dailyTokens),
    monthlyUsd: clampLimit(body.monthlyUsd, principal.monthlyUsd),
    limits: parent === undefined ? body.limits : clampLimits(limitsOf(parent), body.limits),
    ratePerMinute: clampLimit(body.ratePerMinute, principal.ratePerMinute),
    expiresAt: clampExpiry(body.expiresAt, parent?.expiresAt),
    // A read-only issuer cannot mint a key that can spend (issue.go:138).
    readOnly: body.readOnly || principal.readOnly,
    issues: false,
    issuer: principal.key ?? undefined,
  };
  await input.configStore.write({ ...config, keys: [...config.keys, issued] });
  input.res.status(201).json({ key: issued.key, data: redactKeyEntry(issued) });
}

async function revokeKey(input: KeyAdminContext): Promise<void> {
  const config = input.configStore.get();
  const principal = resolvePrincipal(input.req, config);
  if (principal === null || !principal.issues) {
    input.res
      .status(403)
      .json({ error: { message: "This key cannot revoke keys", type: "forbidden" } });
    return;
  }
  const presented = isRecord(input.req.body) ? input.req.body.key : undefined;
  if (typeof presented !== "string") {
    input.res.status(400).json({ error: { message: "Missing key", type: "invalid_request" } });
    return;
  }
  const keys = config.keys.filter(
    (entry) =>
      typeof entry === "string" || entry.key !== presented || entry.issuer !== principal.key,
  );
  if (keys.length === config.keys.length) {
    input.res.status(404).json({ error: { message: "No such key", type: "not_found" } });
    return;
  }
  await input.configStore.write({ ...config, keys });
  input.res.status(204).end();
}

/**
 * The first model a request names that its issuer may not use, or null. An
 * issuer naming no model is held to none (myna covered, issue.go:122-127),
 * and a pattern the issuer covers (a `*` wildcard included) is allowed.
 */
function uncoveredModel(parent: readonly string[], requested: readonly string[]): string | null {
  if (parent.length === 0) {
    return null;
  }
  return requested.find((model) => !modelCovers(parent, model)) ?? null;
}

function clampLimit(requested: number | undefined, parent: number | null): number | undefined {
  if (parent === null) {
    return requested;
  }
  return requested === undefined ? parent : Math.min(requested, parent);
}

/**
 * A child may not outlive its issuer: an expiry later than the issuer's (or
 * none at all) is lowered to it. An unparseable issuer expiry is left alone.
 */
function clampExpiry(
  requested: string | undefined,
  parent: string | undefined,
): string | undefined {
  if (parent === undefined) {
    return requested;
  }
  const parentAt = Date.parse(parent);
  if (!Number.isFinite(parentAt)) {
    return requested;
  }
  let requestedAt = Number.POSITIVE_INFINITY;
  if (requested !== undefined) {
    requestedAt = Date.parse(requested);
    if (!Number.isFinite(requestedAt)) {
      return requested;
    }
  }
  return new Date(Math.min(requestedAt, parentAt)).toISOString();
}

/**
 * A key issued under another may not outgrow its issuer's caps: a cap is
 * lowered to the issuer's in the same window (myna access's issued keys).
 * Without a matching window the request stands; the issuer's own limits
 * still hold the child on every request.
 */
function clampLimits(
  parent: readonly {
    period: string;
    days?: number;
    hours?: number;
    tokens?: number;
    cost?: number;
  }[],
  requested: GatewayKeyLimit[] | undefined,
): GatewayKeyLimit[] | undefined {
  if (requested === undefined || parent.length === 0) {
    return requested;
  }
  return requested.map((limit) => {
    const same = parent.find(
      (entry) =>
        entry.period === limit.period &&
        (entry.days ?? 0) === (limit.days ?? 0) &&
        (entry.hours ?? 0) === (limit.hours ?? 0),
    );
    if (same === undefined) {
      return limit;
    }
    const clamped = Object.assign({}, limit);
    if (limit.tokens !== undefined && same.tokens !== undefined) {
      clamped.tokens = Math.min(limit.tokens, same.tokens);
    }
    if (limit.cost !== undefined && same.cost !== undefined) {
      clamped.cost = Math.min(limit.cost, same.cost);
    }
    return clamped;
  });
}

/** Enough to tell keys apart, never enough to use one. */
/** How often each stand-in was put back, as a record keeps it. */
function restoredBack(counts: RestoreCounts): Record<string, number> | undefined {
  const out: Record<string, number> = {};
  for (const [token, count] of counts) {
    if (count > 0) {
      out[token] = count;
    }
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

function maskKey(key: string): string {
  return key.length > 8 ? `${key.slice(0, 4)}…${key.slice(-4)}` : "…";
}

/**
 * Whether the key may use every model the provider serves, in the sense
 * quotaScopeAllows asks for: an unheld key, or one naming the provider's
 * wildcard or each of its models.
 */
/** Whether a key's model list names anything the provider serves. */
function keyMayUseProvider(
  principal: Pick<GatewayPrincipal, "models">,
  provider: GatewayProvider,
): boolean {
  if (principal.models.length === 0) {
    return true;
  }
  const ids = new Set([...provider.models, ...videoModelsOf(provider)].map((model) => model.id));
  const prefix = `${provider.id}/`;
  return principal.models.some(
    (entry) =>
      entry.toLowerCase() === `${provider.id}/*`.toLowerCase() ||
      ids.has(entry) ||
      (entry.startsWith(prefix) && ids.has(entry.slice(prefix.length))),
  );
}

function usesEveryModelOfProvider(
  principal: GatewayPrincipal,
  config: GatewayConfig,
  providerId: string,
): boolean {
  if (principal.models.length === 0) {
    return true;
  }
  if (principal.models.some((model) => model.toLowerCase() === `${providerId}/*`.toLowerCase())) {
    return true;
  }
  const provider = config.providers.find((entry) => entry.id === providerId);
  if (provider === undefined) {
    return false;
  }
  const ids = new Set([...provider.models, ...videoModelsOf(provider)].map((model) => model.id));
  return (
    ids.size > 0 &&
    [...ids].every(
      (id) => principal.models.includes(id) || principal.models.includes(`${providerId}/${id}`),
    )
  );
}

function redactKeyEntry(entry: unknown): Record<string, unknown> {
  if (!isRecord(entry)) {
    return {};
  }
  const key = entry.key;
  const masked =
    typeof key === "string" && key.length > 8 ? `${key.slice(0, 4)}…${key.slice(-4)}` : "…";
  return { ...entry, key: masked };
}

const GATEWAY_APIS = [
  "/v1/models",
  "/v1/chat/completions",
  "/v1/responses",
  "/v1/messages",
  "/v1/messages/count_tokens",
  "/v1/embeddings",
  "/v1/rerank",
  "/v1/images/generations",
  "/v1/images/edits",
  "/v1/videos",
  "/v1/audio/transcriptions",
  "/v1/audio/translations",
  "/v1/audio/speech",
  "/v1beta/models/{model}:generateContent",
  "/v1/myna/quotas",
  "/v1/myna/usage",
  "/v1/myna/concurrency",
  "/v1/myna/limit",
] as const;

function browserSessionOf(req: ExpressRequest): string {
  const session = req.headers["x-magpie-browser-session"];
  if (typeof session === "string" && session.length > 0) {
    return session;
  }
  const mcpSession = req.headers["mcp-session-id"];
  return typeof mcpSession === "string" && mcpSession.length > 0 ? mcpSession : "default";
}

function loopbackRequest(req: ExpressRequest): boolean {
  const address = req.socket.remoteAddress ?? "";
  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1" ||
    address.startsWith("127.")
  );
}

/** The address the agent reached this gateway at, for the links it is given. */
function browserBaseUrl(req: ExpressRequest): string {
  const secure = (req.socket as { encrypted?: boolean }).encrypted === true;
  const host = req.headers.host ?? "127.0.0.1";
  return `${secure ? "https" : "http"}://${host}`;
}

/** A made file's link is judged as a request without a key, the way myna's
 * are: this computer's caller, or the link's token. */
function browserFileAsked(req: ExpressRequest): boolean {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return false;
  }
  if (!req.path.startsWith(BROWSER_FILES_PATH)) {
    return false;
  }
  const name = req.path.slice(BROWSER_FILES_PATH.length);
  if (name === "" || name.includes("/")) {
    return false;
  }
  // A presented key is judged as every request is, even on a link.
  if (readPresentedKey(req) !== null) {
    return false;
  }
  const token = req.query[BROWSER_FILE_TOKEN];
  return loopbackRequest(req) || (typeof token === "string" && token.length > 0);
}

/** A made file is for the extension and this computer; a page elsewhere that
 * learned the link is refused, as myna refuses it. */
function browserFileOriginAllowed(req: ExpressRequest): boolean {
  const origin = req.headers.origin;
  if (origin === undefined) {
    return true;
  }
  if (origin === `chrome-extension://${BROWSER_EXTENSION_ID}`) {
    return true;
  }
  try {
    const host = new URL(origin).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

/** Whether a key that had a file made is still enabled: revoking it takes
 * the links with it. */
function keyIsLive(config: GatewayConfig, key: string): boolean {
  return config.keys.some((entry) => {
    if (typeof entry === "string") {
      return entry === key;
    }
    if (entry.key !== key) {
      return false;
    }
    return entry.expiresAt === undefined || Date.parse(entry.expiresAt) > Date.now();
  });
}

/** Read endpoints answer loopback when no key is configured, else demand one. */
function authenticateRead(
  req: ExpressRequest,
  res: ExpressResponse,
  config: GatewayConfig,
): boolean {
  const principal = resolvePrincipal(req, config);
  if (principal !== null) {
    return true;
  }
  res.status(401).json({ error: { message: "Invalid gateway key", type: "unauthorized" } });
  return false;
}

interface VideoGetContext {
  req: ExpressRequest;
  res: ExpressResponse;
  configStore: GatewayConfigStore;
  ledger: UsageLedger;
  runtime: GatewayRuntime;
  logger: Logger;
}

async function forwardVideoGet(input: VideoGetContext): Promise<void> {
  const config = input.configStore.get();
  const principal = gatewayPrincipal(input.req, config);
  if (principal === null) {
    input.res.status(401).json({ error: { message: "Invalid gateway key", type: "unauthorized" } });
    return;
  }
  const now = Date.now();
  // A by-id poll names no model, so only pace and the key's windows can be
  // read; which providers it may ask is settled below.
  const denial = checkAccess({
    config,
    ledger: input.ledger,
    principal,
    requestedModel: "",
    routingModel: "",
    candidates: [],
    rateLimiter: input.runtime.rateLimiter,
    now,
    skipModelCheck: true,
  });
  if (denial !== null) {
    if (denial.retryAfterSeconds !== undefined) {
      input.res.setHeader("Retry-After", String(denial.retryAfterSeconds));
    }
    input.res.status(denial.status).json({ error: { message: denial.message, type: denial.type } });
    return;
  }
  const accountFilter = keyAccountFilter(principal);
  const path = input.req.path;
  let sawNotFound = false;
  let permitted = false;
  for (const provider of config.providers) {
    if (!keyMayUseProvider(principal, provider)) {
      continue;
    }
    const allowed = accountFilter?.get(provider.id);
    const accounts = planAccounts({
      provider,
      state: input.runtime.accountState,
      now,
    }).filter((entry) => allowed === undefined || allowed.has(entry.id));
    if (allowed !== undefined && accounts.length === 0) {
      continue;
    }
    permitted = true;
    const account = accounts[0];
    let upstream: globalThis.Response;
    try {
      upstream = await fetch(joinUpstreamPath(account?.baseUrl ?? provider.baseUrl, path), {
        headers: buildUpstreamHeaders(provider, account, input.req.headers),
      });
    } catch (error) {
      input.logger.info({ err: error, provider: provider.id }, "Video poll failed");
      continue;
    }
    if (upstream.status === 404) {
      sawNotFound = true;
      await upstream.body?.cancel();
      continue;
    }
    applyReplyHeaders(input.res, provider, upstream);
    await pipeUpstream(input.res, upstream);
    input.ledger.record({
      time: new Date(now).toISOString(),
      requested: "",
      provider: provider.id,
      account: account?.id ?? null,
      model: "",
      protocol: provider.protocol,
      status: upstream.status,
      ok: upstream.ok,
      inputTokens: 0,
      outputTokens: 0,
      attempts: 1,
      durationMs: Date.now() - now,
      costUsd: 0,
      key: principal.key,
      client: clientOfUserAgent(input.req.headers["user-agent"]),
    });
    return;
  }
  if (!permitted) {
    input.res.status(403).json({
      error: {
        message: "This key cannot use any provider that might know this video",
        type: "model_not_allowed",
      },
    });
    return;
  }
  input.res.status(sawNotFound ? 404 : 502).json({
    error: {
      message: sawNotFound ? "No provider knows this video" : "All upstreams failed",
      type: sawNotFound ? "not_found" : "gateway_error",
    },
  });
}

/** The release answered as Ollama: one past every client's minimum (VS
 * Code's Copilot refuses a server older than 0.6.4), as myna's
 * `ollamaVersion` (myna ollama.go:27-31). */
const OLLAMA_VERSION = "0.12.6";
/** The architecture every model is told as: `model_info`'s keys are named
 * after it (myna's `ollamaArch`). */
const OLLAMA_ARCH = "myna";
/** The window told for a model whose own is unknown: what VS Code's
 * Copilot takes when none is told (myna's `ollamaDefaultContext`). */
const OLLAMA_DEFAULT_CONTEXT = 32768;
/** Stands in for when a model was pulled, which no model here was. */
const OLLAMA_MODIFIED = "2025-01-01T00:00:00Z";

type GatewayModel = ReturnType<typeof listGatewayModels>[number];

/** A token count from sizes, for clients that ask before sending (myna's
 * `estimate`, gateway.go:2106). */
function approximateTokens(request: IrRequest): number {
  let chars = request.system?.length ?? 0;
  for (const message of request.messages) {
    for (const part of message.parts) {
      switch (part.type) {
        case "text":
        case "thinking":
          chars += part.text.length;
          break;
        case "tool_call":
          chars += part.name.length + part.arguments.length;
          break;
        case "tool_result":
          chars += part.content.length;
          break;
        case "search":
          chars += part.query.length;
          break;
        default:
          break;
      }
    }
  }
  for (const tool of request.tools) {
    chars += tool.name.length + (tool.description?.length ?? 0);
    chars += JSON.stringify(tool.inputSchema).length;
  }
  return Math.round(chars / 4);
}

/** What Muse Code is told of a model at /muse-code/models (myna's
 * `museModels`): a row without `metadata["muse-code"]` is hidden. */
function museCodeMeta(entry: GatewayModel): Record<string, unknown> {
  const name = entry.display_name;
  const images = entry.images === true;
  const context = entry.context_window === undefined ? 128_000 : entry.context_window;
  const output =
    entry.max_output_tokens !== undefined && entry.max_output_tokens > 0
      ? entry.max_output_tokens
      : Math.min(32_000, context);
  return {
    name,
    family: entry.owned_by,
    is_hidden: false,
    attachment: images,
    reasoning: false,
    temperature: false,
    tool_call: true,
    modalities: { input: images ? ["text", "image"] : ["text"], output: ["text"] },
    options: { include: [] },
    variants: {},
    description: `${name} via Neox`,
    limit: { context, output },
  };
}

function ollamaDetails(entry: GatewayModel): Record<string, unknown> {
  return {
    parent_model: "",
    format: "",
    family: OLLAMA_ARCH,
    families: [OLLAMA_ARCH],
    parameter_size: "",
    quantization_level: "",
    ...(entry.context_window === undefined || entry.context_window <= 0
      ? {}
      : { context_length: entry.context_window }),
  };
}

/** What the model does, in Ollama's words (myna's `ollamaCapabilities`). */
function ollamaCapabilities(entry: GatewayModel): string[] {
  const caps = ["completion", "tools"];
  if (entry.images === true) {
    caps.push("vision");
  }
  return caps;
}

/** The same id always gives the same digest: no local blob backs these. */
function ollamaDigest(id: string): string {
  return createHash("sha256").update(id).digest("hex");
}

/** The model a name asks for: its id, or the bare one before `:latest`
 * (the ollama CLI names an untagged model so, myna's `ollamaName`). */
function ollamaModelNamed(models: readonly GatewayModel[], name: string): GatewayModel | undefined {
  const exact = models.find((model) => model.id === name);
  if (exact !== undefined) {
    return exact;
  }
  const suffix = ":latest";
  if (!name.endsWith(suffix)) {
    return undefined;
  }
  const bare = name.slice(0, -suffix.length);
  return models.find((model) => model.id === bare);
}

function ollamaTag(entry: GatewayModel): Record<string, unknown> {
  return {
    name: entry.id,
    model: entry.id,
    modified_at: OLLAMA_MODIFIED,
    size: 0,
    digest: ollamaDigest(entry.id),
    details: ollamaDetails(entry),
    capabilities: ollamaCapabilities(entry),
  };
}

interface OllamaContext {
  req: ExpressRequest;
  res: ExpressResponse;
  generate: boolean;
  configStore: GatewayConfigStore;
  masker: Masker;
  maskingRecords?: MaskingRecordStore;
  ledger: UsageLedger;
  runtime: GatewayRuntime;
  logger: Logger;
}

/**
 * Ollama's chat and generate calls become OpenAI Chat requests, so every
 * provider and translation rule applies unchanged; the reply is turned back
 * into Ollama's JSON or NDJSON.
 */
async function forwardOllama(input: OllamaContext): Promise<void> {
  const body = isRecord(input.req.body) ? input.req.body : null;
  const model = body?.model;
  if (body === null || typeof model !== "string" || model.length === 0) {
    input.res.status(400).json({ error: "model is required" });
    return;
  }
  const messages = ollamaMessages(body, input.generate);
  if (messages.length === 0) {
    input.res.status(400).json({ error: "messages are required" });
    return;
  }
  const stream = body.stream !== false;
  const openaiBody: Record<string, unknown> = { model, messages, stream };
  const options = isRecord(body.options) ? body.options : {};
  if (typeof options.temperature === "number") {
    openaiBody.temperature = options.temperature;
  }
  if (typeof options.num_predict === "number" && options.num_predict > 0) {
    openaiBody.max_tokens = options.num_predict;
  }
  if (typeof body.system === "string") {
    messages.unshift({ role: "system", content: body.system });
  }
  const bridge = new OllamaBridge({
    res: input.res,
    model,
    generate: input.generate,
    stream,
    promptCharacters: countCharacters(messages),
  });
  const synthRequest = Object.assign(Object.create(input.req) as ExpressRequest, {
    body: openaiBody,
  });
  await forwardCompletion({
    req: synthRequest,
    res: bridge as unknown as ExpressResponse,
    protocol: "openai",
    configStore: input.configStore,
    masker: input.masker,
    maskingRecords: input.maskingRecords,
    ledger: input.ledger,
    routingState: input.runtime.routingState,
    accountState: input.runtime.accountState,
    quotaTracker: input.runtime.quotaTracker,
    rateLimiter: input.runtime.rateLimiter,
    runtime: input.runtime,
    logger: input.logger,
  });
}

function ollamaMessages(
  body: Record<string, unknown>,
  generate: boolean,
): Record<string, unknown>[] {
  let source: unknown[] = [];
  if (generate) {
    source = [{ role: "user", content: typeof body.prompt === "string" ? body.prompt : "" }];
  } else if (Array.isArray(body.messages)) {
    source = body.messages;
  }
  const messages: Record<string, unknown>[] = [];
  for (const entry of source) {
    if (!isRecord(entry) || typeof entry.role !== "string") {
      continue;
    }
    messages.push({
      role: entry.role,
      content: entry.images === undefined ? entry.content : withImages(entry.content, entry.images),
      ...(entry.tool_calls === undefined ? {} : { tool_calls: entry.tool_calls }),
    });
  }
  return messages;
}

function withImages(content: unknown, images: unknown): unknown {
  if (!Array.isArray(images) || images.length === 0) {
    return content;
  }
  const parts: Record<string, unknown>[] = [];
  if (typeof content === "string" && content.length > 0) {
    parts.push({ type: "text", text: content });
  }
  for (const image of images) {
    if (typeof image === "string") {
      parts.push({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${image}` } });
    }
  }
  return parts;
}

interface OllamaBridgeOptions {
  res: ExpressResponse;
  model: string;
  generate: boolean;
  stream: boolean;
  promptCharacters: number;
}

/**
 * Presents an Express response to the OpenAI-shaped forwarder and rewrites
 * what it writes into Ollama's frames. SSE events can split across writes, so
 * text is held until a blank line ends the event.
 */
class OllamaBridge {
  public writableEnded = false;
  public destroyed = false;
  /** The real response's locals: the archive reads the wires kept there. */
  public get locals(): Record<string, unknown> {
    return this.options.res.locals as Record<string, unknown>;
  }

  private readonly startedAt = Date.now();
  private statusCode = 200;
  private buffer = "";
  private finished = false;
  private text = "";
  private thinking = "";
  private readonly toolCalls = new Map<number, { name: string; arguments: string }>();

  private readonly options: OllamaBridgeOptions;

  constructor(options: OllamaBridgeOptions) {
    this.options = options;
  }

  public status(code: number): this {
    this.statusCode = code;
    this.options.res.status(code);
    return this;
  }

  public setHeader(name: string, value: string): this {
    const stream = this.options.stream;
    const header = name.toLowerCase() === "content-type" && stream ? "application/x-ndjson" : value;
    this.options.res.setHeader(name, header);
    return this;
  }

  public write(chunk: string | Buffer): boolean {
    if (this.options.stream) {
      this.consume(chunk.toString());
    }
    return true;
  }

  public end(chunk?: string | Buffer): this {
    if (chunk !== undefined && chunk !== null) {
      this.write(chunk);
    }
    if (this.options.stream) {
      this.finish();
    }
    this.writableEnded = true;
    this.options.res.end();
    return this;
  }

  public json(payload: unknown): this {
    if (this.statusCode >= 400 || !isRecord(payload)) {
      this.options.res.status(this.statusCode).json(payload);
      this.writableEnded = true;
      return this;
    }
    this.options.res.status(200).json(this.complete(payload));
    this.writableEnded = true;
    return this;
  }

  public on(): this {
    return this;
  }

  public once(): this {
    return this;
  }

  private consume(text: string): void {
    this.buffer += text;
    let index = this.buffer.indexOf("\n\n");
    while (index >= 0) {
      const event = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 2);
      this.handleEvent(event);
      index = this.buffer.indexOf("\n\n");
    }
  }

  private handleEvent(event: string): void {
    for (const line of event.split("\n")) {
      if (!line.startsWith("data:")) {
        continue;
      }
      const data = line.slice(5).trim();
      if (data === "[DONE]") {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue;
      }
      if (isRecord(parsed)) {
        this.emitDelta(parsed);
      }
    }
  }

  private emitDelta(chunk: Record<string, unknown>): void {
    const choices = chunk.choices;
    const choice = Array.isArray(choices) ? choices[0] : null;
    if (!isRecord(choice)) {
      return;
    }
    const delta = isRecord(choice.delta) ? choice.delta : {};
    const content = typeof delta.content === "string" ? delta.content : "";
    const reasoning = typeof delta.reasoning_content === "string" ? delta.reasoning_content : "";
    if (content.length > 0) {
      this.text += content;
    }
    if (reasoning.length > 0) {
      this.thinking += reasoning;
    }
    this.collectToolCalls(delta.tool_calls);
    if (content.length === 0 && reasoning.length === 0) {
      return;
    }
    this.send({
      ...this.base(),
      message: {
        role: "assistant",
        content: this.options.generate ? "" : content,
        ...(this.options.generate ? { response: content } : {}),
        ...(reasoning.length > 0 ? { thinking: reasoning } : {}),
      },
      done: false,
    });
  }

  private collectToolCalls(calls: unknown): void {
    if (!Array.isArray(calls)) {
      return;
    }
    for (const call of calls) {
      if (!isRecord(call)) {
        continue;
      }
      const index = typeof call.index === "number" ? call.index : 0;
      const fn = isRecord(call.function) ? call.function : {};
      const current = this.toolCalls.get(index) ?? { name: "", arguments: "" };
      if (typeof fn.name === "string" && fn.name.length > 0) {
        current.name = fn.name;
      }
      if (typeof fn.arguments === "string") {
        current.arguments += fn.arguments;
      }
      this.toolCalls.set(index, current);
    }
  }

  private finish(): void {
    if (this.finished) {
      return;
    }
    this.finished = true;
    if (this.toolCalls.size > 0) {
      this.send({
        ...this.base(),
        message: { role: "assistant", content: "", tool_calls: this.toolCallList() },
        done: false,
      });
    }
    this.send({
      ...this.base(),
      message: { role: "assistant", content: "" },
      done: true,
      done_reason: "stop",
      prompt_eval_count: Math.ceil(this.options.promptCharacters / 4),
      // Streamed OpenAI chunks carry no usage; count what arrived.
      eval_count: Math.ceil(this.text.length / 4),
      ...this.durations(),
    });
  }

  private complete(payload: Record<string, unknown>): Record<string, unknown> {
    const choice =
      Array.isArray(payload.choices) && isRecord(payload.choices[0]) ? payload.choices[0] : {};
    const message = isRecord(choice.message) ? choice.message : {};
    const usage = isRecord(payload.usage) ? payload.usage : {};
    const content = typeof message.content === "string" ? message.content : "";
    const thinking = typeof message.reasoning_content === "string" ? message.reasoning_content : "";
    const toolCalls = this.completeToolCalls(message.tool_calls);
    return {
      model: this.options.model,
      created_at: new Date().toISOString(),
      ...this.durations(),
      ...(this.options.generate
        ? { response: content }
        : {
            message: {
              role: "assistant",
              content,
              ...(thinking.length > 0 ? { thinking } : {}),
              ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
            },
          }),
      done: true,
      done_reason: typeof choice.finish_reason === "string" ? choice.finish_reason : "stop",
      prompt_eval_count: typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0,
      eval_count: typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0,
    };
  }

  /** Ollama reports nanoseconds; the process has no model load to report. */
  private durations(): Record<string, number> {
    const total = (Date.now() - this.startedAt) * 1_000_000;
    return {
      total_duration: total,
      load_duration: 0,
      prompt_eval_duration: 0,
      eval_duration: total,
    };
  }

  private completeToolCalls(calls: unknown): Record<string, unknown>[] {
    if (!Array.isArray(calls)) {
      return [];
    }
    return calls.flatMap((call) => {
      if (!isRecord(call) || !isRecord(call.function)) {
        return [];
      }
      const name = typeof call.function.name === "string" ? call.function.name : "";
      return [{ function: { name, arguments: parseArguments(call.function.arguments) } }];
    });
  }

  private toolCallList(): Record<string, unknown>[] {
    return [...this.toolCalls.values()].map((call) => ({
      function: { name: call.name, arguments: parseArguments(call.arguments) },
    }));
  }

  private base(): Record<string, unknown> {
    return { model: this.options.model, created_at: new Date().toISOString() };
  }

  private send(payload: Record<string, unknown>): void {
    this.options.res.write(`${JSON.stringify(payload)}\n`);
  }
}

function parseArguments(value: unknown): Record<string, unknown> {
  if (isRecord(value)) {
    return value;
  }
  if (typeof value !== "string" || value.length === 0) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

interface NativeContext {
  req: ExpressRequest;
  res: ExpressResponse;
  configStore: GatewayConfigStore;
  ledger: UsageLedger;
  runtime: GatewayRuntime;
  logger: Logger;
}

interface NativeAccess {
  principal: GatewayPrincipal;
  account: GatewayAccount | undefined;
  reservation: Reservation;
}

/** The key's hold on a native passthrough, or null when a refusal was written. */
function authorizeNativeRequest(
  input: NativeContext,
  config: GatewayConfig,
  provider: GatewayProvider,
): NativeAccess | null {
  // The body's model, when there is one, is what the key's allow-list is
  // read against; without one the provider's models stand in, so a key
  // naming another provider is still refused.
  const bodyModel =
    isRecord(input.req.body) && typeof input.req.body.model === "string"
      ? input.req.body.model
      : "";
  const requestedModel = bodyModel.length > 0 ? bodyModel : provider.id;
  const routingModel =
    bodyModel.length > 0 ? (config.middleware?.aliases[bodyModel] ?? bodyModel) : provider.id;
  let candidates: GatewayCandidate[];
  if (bodyModel.length > 0) {
    try {
      candidates = resolveGatewayCandidates(config, routingModel);
    } catch {
      // A vendor name outside the catalog is the provider's to judge.
      candidates = [];
    }
  } else {
    // Video providers keep their models outside `provider.models`; include
    // them so a `provider/*` key still matches.
    candidates = [...provider.models, ...videoModelsOf(provider)].map((model) => ({
      provider,
      model,
    }));
  }
  const access = authorizeRequest({
    config,
    req: input.req,
    res: input.res,
    ledger: input.ledger,
    rateLimiter: input.runtime.rateLimiter,
    requestedModel,
    routingModel,
    candidates,
    bodyBytes: Buffer.isBuffer(input.req.body)
      ? input.req.body.length
      : Buffer.byteLength(JSON.stringify(input.req.body ?? {})),
  });
  if (access === null) {
    return null;
  }
  const allowed = access.accountFilter?.get(provider.id);
  const accounts = planAccounts({
    provider,
    state: input.runtime.accountState,
    now: Date.now(),
  }).filter((entry) => allowed === undefined || allowed.has(entry.id));
  if (allowed !== undefined && accounts.length === 0) {
    access.reservation.release();
    input.res.status(403).json({
      error: { message: `This key cannot use ${provider.id}`, type: "model_not_allowed" },
    });
    return null;
  }
  return { principal: access.principal, account: accounts[0], reservation: access.reservation };
}

/** `/v1/myna/native/<provider>/<path>` goes to that provider's base URL as is. */
async function forwardNative(input: NativeContext): Promise<void> {
  const config = input.configStore.get();
  const providerId = typeof input.req.params.provider === "string" ? input.req.params.provider : "";
  const rest = typeof input.req.params[0] === "string" ? input.req.params[0] : "";
  const provider = config.providers.find((entry) => entry.id === providerId);
  if (provider === undefined) {
    input.res
      .status(404)
      .json({ error: { message: `No provider ${providerId}`, type: "not_found" } });
    return;
  }
  const native = authorizeNativeRequest(input, config, provider);
  if (native === null) {
    return;
  }
  const { principal, account, reservation } = native;
  const now = Date.now();
  const queryIndex = input.req.originalUrl.indexOf("?");
  const query = queryIndex < 0 ? "" : input.req.originalUrl.slice(queryIndex);
  const url = `${joinUpstreamPath(account?.baseUrl ?? provider.baseUrl, `/${rest}`)}${query}`;
  const hasBody =
    input.req.method !== "GET" && input.req.method !== "HEAD" && input.req.body !== undefined;
  try {
    let upstream: globalThis.Response;
    try {
      upstream = await fetch(url, {
        method: input.req.method,
        headers: buildUpstreamHeaders(
          provider,
          account,
          input.req.headers,
          incomingContentType(input.req),
        ),
        ...(hasBody ? { body: JSON.stringify(input.req.body) } : {}),
      });
    } catch (error) {
      input.logger.info({ err: error, provider: provider.id }, "Native passthrough failed");
      input.res
        .status(502)
        .json({ error: { message: "Upstream unreachable", type: "gateway_error" } });
      return;
    }
    applyReplyHeaders(input.res, provider, upstream);
    await pipeUpstream(input.res, upstream);
    input.ledger.record({
      time: new Date(now).toISOString(),
      requested: "",
      provider: provider.id,
      account: account?.id ?? null,
      model: rest,
      protocol: provider.protocol,
      status: upstream.status,
      ok: upstream.ok,
      inputTokens: 0,
      outputTokens: 0,
      attempts: 1,
      durationMs: Date.now() - now,
      costUsd: 0,
      key: principal.key,
      client: clientOfUserAgent(input.req.headers["user-agent"]),
    });
  } finally {
    reservation.release();
  }
}

/**
 * The order routing would try a provider's accounts in, read without spending
 * the weighted round-robin's turn: `planAccounts` advances `currentWeight`,
 * and the trace must not change what the request then does.
 */
function planAccountsForTrace(input: Parameters<typeof planAccounts>[0]): GatewayAccount[] {
  const saved = new Map(input.state.currentWeight);
  try {
    return planAccounts(input);
  } finally {
    input.state.currentWeight.clear();
    for (const [key, value] of saved) {
      input.state.currentWeight.set(key, value);
    }
  }
}

/** The seats routing weighed for a request, in the order it planned them. */
function traceSeats(input: {
  planned: GatewayCandidate[];
  accountState: AccountRoutingState;
  routingState: RoutingState;
  ledger: UsageLedger;
  now: number;
}): RouteSeat[] {
  const seats: RouteSeat[] = [];
  let rank = 0;
  for (const candidate of input.planned) {
    const accounts = planAccountsForTrace({
      provider: candidate.provider,
      state: input.accountState,
      now: input.now,
      modelId: candidate.model.id,
    });
    const served = input.ledger.countFor(candidateKey(candidate));
    if (accounts.length === 0) {
      seats.push({
        id: candidateKey(candidate),
        provider: candidate.provider.id,
        providerLabel: candidate.provider.label ?? candidate.provider.id,
        account: null,
        accountLabel: candidate.provider.label ?? candidate.provider.id,
        model: candidate.model.id,
        rank,
        restingUntil: input.routingState.rest.until(candidateKey(candidate), input.now),
        served,
      });
      rank += 1;
      continue;
    }
    for (const account of accounts) {
      const key = accountKey(candidate.provider, account);
      seats.push({
        id: key,
        provider: candidate.provider.id,
        providerLabel: candidate.provider.label ?? candidate.provider.id,
        account: account.id,
        accountLabel: account.label ?? account.id,
        model: candidate.model.id,
        rank,
        restingUntil: input.routingState.rest.until(key, input.now),
        served,
      });
      rank += 1;
    }
  }
  return seats;
}

function contextWindowOf(planned: GatewayCandidate[]): number | null {
  for (const candidate of planned) {
    if (candidate.model.contextWindow !== undefined) {
      return candidate.model.contextWindow;
    }
  }
  return null;
}

function routeIdentity(route: Record<string, unknown>): string {
  return `${String(route.time)}|${String(route.served)}|${String(route.status)}`;
}

function gatewayTrace(
  ledger: UsageLedger,
  now: number,
): {
  seq: number;
  routes: Record<string, unknown>[];
  totals: Record<string, unknown>;
  ids: number[];
} {
  const routes = ledger.recentEntries().map((entry, index) => {
    const served = entry.model.length > 0 ? `${entry.provider}/${entry.model}` : entry.provider;
    const route: Record<string, unknown> = {
      id: index + 1,
      time: entry.time,
      asked: entry.requested,
      served,
      model: served,
      tries: [{ model: served, done: true, status: entry.status }],
      done: true,
      status: entry.status,
      millis: entry.durationMs,
    };
    if (!entry.ok) {
      route.error = `HTTP ${entry.status}`;
    }
    return route;
  });
  const served = [...ledger.countsSnapshot()].reduce((total, [, count]) => total + count, 0);
  return {
    seq: routes.length,
    routes,
    totals: { served, spendUsd: ledger.spentThisMonth(now) },
    ids: [],
  };
}

function sendStatusline(
  req: ExpressRequest,
  res: ExpressResponse,
  config: GatewayConfig,
  ledger: UsageLedger,
  runtime: GatewayRuntime,
): void {
  if (resolvePrincipal(req, config) === null) {
    res.status(401).json({ error: { message: "Invalid gateway key", type: "unauthorized" } });
    return;
  }
  const parts: string[] = [];
  for (const provider of config.providers) {
    for (const account of providerAccounts(provider)) {
      if (!account.enabled) {
        continue;
      }
      const usage = runtime.quotaTracker.usage(accountKey(provider, account), Date.now());
      const window5h = percentOf(usage.tokens5h, account.quota?.tokens5h);
      const window7d = percentOf(usage.tokens7d, account.quota?.tokens7d);
      if (window5h !== null) {
        parts.push(`${provider.id}/${account.id} 5h ${window5h}%`);
      }
      if (window7d !== null) {
        parts.push(`${provider.id}/${account.id} 7d ${window7d}%`);
      }
    }
  }
  const session = typeof req.query.session === "string" ? req.query.session : "";
  const sticky = session.length > 0 ? runtime.routingState.sticky.get(session) : undefined;
  if (sticky !== undefined) {
    parts.push(sticky);
  }
  const spend = ledger.spentThisMonth(Date.now());
  const budget = config.budget?.monthlyUsd;
  parts.push(budget === undefined ? `$${spend.toFixed(2)}` : `$${spend.toFixed(2)}/$${budget}`);
  res.setHeader("content-type", "text/plain; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.send(`${parts.join(" · ")}\n`);
}

function percentOf(tokens: number, cap: number | undefined): number | null {
  if (cap === undefined || cap <= 0) {
    return null;
  }
  return Math.min(100, Math.round((tokens / cap) * 100));
}

interface OidcIssueContext {
  req: ExpressRequest;
  res: ExpressResponse;
  configStore: GatewayConfigStore;
  logger: Logger;
}

/** Trades a signed OIDC token for a short-lived key, under a configured rule. */
async function issueOidcKey(input: OidcIssueContext): Promise<void> {
  const config = input.configStore.get();
  const rules = configuredOidcRules(config);
  const authorization = input.req.headers.authorization;
  const token =
    typeof authorization === "string" && /^Bearer\s+/i.test(authorization)
      ? authorization.replace(/^Bearer\s+/i, "").trim()
      : "";
  if (token.length === 0) {
    input.res.status(401).json({
      error: {
        code: null,
        message: "send the OIDC token as Authorization: Bearer <token>",
        param: null,
        type: "authentication_error",
      },
    });
    return;
  }
  if (rules.length === 0) {
    input.res.status(401).json({
      error: {
        code: null,
        message: "no rule takes tokens from this issuer (gateway.json oidc)",
        param: null,
        type: "authentication_error",
      },
    });
    return;
  }
  let match: Awaited<ReturnType<typeof matchOidcToken>>;
  try {
    match = await matchOidcToken(token, rules, Date.now());
  } catch (error) {
    input.res.status(401).json({ error: { message: errorMessage(error), type: "unauthorized" } });
    return;
  }
  const parent = resolveOidcIssuer(config, match.rule.key);
  if (parent === null) {
    input.res.status(403).json({
      error: {
        message: `The key "${match.rule.key}" cannot issue keys`,
        type: "forbidden",
      },
    });
    return;
  }
  const body = isRecord(input.req.body) ? input.req.body : {};
  const requestedTtl = parseTtlSeconds(body.ttl);
  const ttlSeconds =
    requestedTtl === null ? match.rule.ttlSeconds : Math.min(requestedTtl, match.rule.ttlSeconds);
  const requestedModels = Array.isArray(body.models)
    ? body.models.filter((entry): entry is string => typeof entry === "string")
    : [];
  const uncovered = uncoveredModel(parent.models, requestedModels);
  if (uncovered !== null) {
    input.res.status(400).json({
      error: {
        code: null,
        message: `The key issuing may not use ${uncovered}, so the key it issues can't either`,
        param: null,
        type: "invalid_request",
      },
    });
    return;
  }
  const now = Date.now();
  const secret = `pk_${randomUUID().replace(/-/g, "")}`;
  const entry = {
    id: newGatewayKeyId(),
    key: secret,
    label: oidcKeyName(match.claims),
    models: requestedModels,
    readOnly: false,
    issues: false,
    issuer: parent.secret,
    expiresAt: new Date(now + ttlSeconds * 1000).toISOString(),
  };
  try {
    const written = await input.configStore.write({
      ...config,
      keys: [...config.keys, entry],
    });
    const stored = written.keys.find((key) => typeof key !== "string" && key.key === secret);
    input.res.setHeader("cache-control", "no-store");
    input.res.status(201).json({ key: secret, data: redactKeyEntry(stored ?? entry) });
  } catch (error) {
    input.res
      .status(400)
      .json({ error: { message: errorMessage(error), type: "invalid_request" } });
  }
}

/** `30m`, `1h`, `90s` or seconds as a number. */
function parseTtlSeconds(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.round(value);
  }
  if (typeof value !== "string") {
    return null;
  }
  const match = /^(\d+)\s*(s|m|h|d)?$/i.exec(value.trim());
  if (match === null) {
    return null;
  }
  const amount = Number(match[1]);
  const unit = (match[2] ?? "s").toLowerCase();
  let factor = 1;
  if (unit === "d") {
    factor = 86_400;
  } else if (unit === "h") {
    factor = 3600;
  } else if (unit === "m") {
    factor = 60;
  }
  return amount * factor;
}

interface SearchContext {
  req: ExpressRequest;
  res: ExpressResponse;
  configStore: GatewayConfigStore;
  searchLedger: SearchLedger | undefined;
  ledger: UsageLedger;
  logger: Logger;
  masker: Masker;
  maskingRecords?: MaskingRecordStore;
}

interface SearchOutcome {
  status: number;
  payload: unknown;
}

const searchKeyPicker = new SearchKeyPicker();

/**
 * Asks the search APIs in their order, each key in its turn or in order,
 * until one answers (myna's askSearchAPIKeys): a key refused is rested and
 * the next asked; a failure that isn't about the key ends that API.
 */
async function searchApisOnce(input: {
  apis: readonly SearchApiConfig[];
  query: string;
  fetchImpl?: typeof fetch;
  logger: Logger;
  masker: Masker;
  maskingEnabled: boolean;
}): Promise<{ outcome: SearchOutcome; counts: RestoreCounts }> {
  let status = 502;
  let message = "All search APIs failed";
  for (const api of input.apis) {
    const tries = Math.max(searchKeys(api).length, 1);
    for (let attempt = 0; attempt < tries; attempt += 1) {
      const key = searchKeyPicker.pick(api);
      const result = await trySearchApi(input, api, key);
      if (result.pages !== null) {
        return searchOutcomeOf(api, result.pages, input);
      }
      status = result.status;
      message = result.message;
      if (!result.refusal) {
        break;
      }
    }
  }
  return {
    outcome: { status, payload: { error: { message, type: "gateway_error" } } },
    counts: new Map(),
  };
}

async function trySearchApi(
  input: { query: string; fetchImpl?: typeof fetch; logger: Logger },
  api: SearchApiConfig,
  key: string | null,
): Promise<{ pages: FoundPage[] | null; status: number; message: string; refusal: boolean }> {
  try {
    const pages = await askSearchApi({
      api,
      key,
      query: input.query,
      fetchImpl: input.fetchImpl,
      logger: input.logger,
    });
    return { pages, status: 200, message: "", refusal: false };
  } catch (error) {
    if (error instanceof SearchApiError) {
      searchKeyPicker.refuse(api, key, error.status, error.retryAfter);
      return {
        pages: null,
        status: error.status,
        message: error.message,
        refusal: isSearchKeyRefusal(error.status),
      };
    }
    return { pages: null, status: 502, message: errorMessage(error), refusal: false };
  }
}

function searchOutcomeOf(
  api: SearchApiConfig,
  pages: readonly FoundPage[],
  input: { masker: Masker; maskingEnabled: boolean },
): { outcome: SearchOutcome; counts: RestoreCounts } {
  const counts: RestoreCounts = new Map();
  const restored = pages.map((page) => {
    const entry: FoundPage = { title: page.title, url: page.url, text: page.text };
    if (page.age !== undefined) {
      entry.age = page.age;
    }
    if (input.maskingEnabled) {
      entry.title = input.masker.restoreText(page.title, counts);
      entry.text = input.masker.restoreText(page.text, counts);
    }
    return entry;
  });
  return {
    outcome: {
      status: 200,
      payload: {
        source: api.vendor,
        results: restored.map((page) => {
          const row: Record<string, unknown> = {
            title: page.title,
            url: page.url,
            content: page.text,
          };
          if (page.age !== undefined) {
            row.age = page.age;
          }
          return row;
        }),
        said: pagesSaid(restored),
      },
    },
    counts,
  };
}

function isSearchKeyRefusal(status: number): boolean {
  return (
    status === 401 ||
    status === 402 ||
    status === 403 ||
    status === 429 ||
    status === 432 ||
    status === 433
  );
}

/**
 * The search myna runs when a request asks the web and the provider it is
 * going to can't search (myna's searchReply): the query masked first, the
 * pages cut and put back, or null when no search API answers.
 */
interface ClientSearch {
  said: string;
  query: string;
  pages: FoundPage[];
}

async function searchForClient(input: {
  config: GatewayConfig;
  masker: Masker;
  maskingEnabled: boolean;
  query: string;
  logger: Logger;
  /** Reaches this daemon's own gateway for a searcher's model. */
  post: (request: ProviderSearchRequest) => Promise<unknown>;
}): Promise<ClientSearch | null> {
  const query = input.query.trim();
  if (query.length === 0) {
    return null;
  }
  let sent = query;
  if (input.maskingEnabled) {
    await input.masker.prime(query);
    const masked = input.masker.maskTextWithHits(query);
    if (masked.blocked) {
      return null;
    }
    sent = masked.text;
  }
  // The search APIs and the searchers in the order the settings name
  // (myna's searchSteps): the first that finds a page answers, and the
  // others after it are not asked.
  const steps = searchSteps(input.config);
  if (steps.length === 0) {
    return searchWithLegacyApi(input, sent);
  }
  for (const step of steps) {
    if (step.kind === "apis") {
      const { outcome } = await searchApisOnce({
        apis: readySearchApis(input.config.search?.apis),
        query: sent,
        logger: input.logger,
        masker: input.masker,
        maskingEnabled: input.maskingEnabled,
      });
      const said = pagesSaidOf(outcome.payload);
      if (said !== null) {
        return { said, query: sent, pages: pagesOfPayload(outcome.payload) };
      }
      continue;
    }
    const slash = step.model.indexOf("/");
    const providerId = slash > 0 ? step.model.slice(0, slash) : step.ref;
    const provider = input.config.providers.find((entry) => entry.id === providerId);
    if (provider === undefined) {
      continue;
    }
    const model = slash > 0 ? step.model.slice(slash + 1) : step.model;
    try {
      const found = await searchWithProvider({
        provider,
        model,
        query: sent,
        post: input.post,
      });
      if (!providerSearchFound(found)) {
        continue;
      }
      const pages = restorePages(input, found.pages);
      const said = input.maskingEnabled ? input.masker.restoreText(found.said) : found.said;
      return { said: saidWithSources(said, pages), query: sent, pages };
    } catch {
      // a searcher that fails or refuses is skipped, as myna asks the next
      continue;
    }
  }
  return null;
}

/** The pages a searcher found, put back, when masking is on. */
function restorePages(
  input: { masker: Masker; maskingEnabled: boolean },
  pages: readonly FoundPage[],
): FoundPage[] {
  return pages.map((page) => {
    const entry: FoundPage = { title: page.title, url: page.url, text: page.text };
    if (page.age !== undefined) {
      entry.age = page.age;
    }
    if (input.maskingEnabled) {
      entry.title = input.masker.restoreText(page.title);
      entry.text = input.masker.restoreText(page.text);
    }
    return entry;
  });
}

/** A searcher's words with the pages it found listed after them (myna's
 * `searchWith` appends 20 sources at most). */
function saidWithSources(said: string, pages: readonly FoundPage[]): string {
  if (pages.length === 0 || pages.length > 20) {
    return said;
  }
  return `${said}\n\nSources:\n${pages.map((page) => `- ${page.title} — ${page.url}`).join("\n")}`;
}

/** The one search URL older gateway settings kept, before `search.apis`. */
async function searchWithLegacyApi(
  input: { config: GatewayConfig; masker: Masker; maskingEnabled: boolean; logger: Logger },
  sent: string,
): Promise<ClientSearch | null> {
  const search = input.config.search;
  if (search?.enabled !== true || search.url.length === 0) {
    return null;
  }
  const legacy: SearchApiConfig = {
    vendor: "tavily",
    url: search.url,
    ...(search.apiKey === undefined ? {} : { key: search.apiKey }),
  };
  try {
    const pages = await askSearchApi({
      api: legacy,
      key: search.apiKey ?? null,
      query: sent,
      logger: input.logger,
    });
    const restored = restorePages(input, pages);
    return { said: pagesSaid(restored), query: sent, pages: restored };
  } catch {
    return null;
  }
}

/** The pages a configured search API's own answer kept. */
function pagesOfPayload(payload: unknown): FoundPage[] {
  if (!isRecord(payload) || !Array.isArray(payload.results)) {
    return [];
  }
  const pages: FoundPage[] = [];
  for (const row of payload.results) {
    if (!isRecord(row) || typeof row.title !== "string" || typeof row.url !== "string") {
      continue;
    }
    const page: FoundPage = {
      title: row.title,
      url: row.url,
      text: typeof row.content === "string" ? row.content : "",
    };
    if (typeof row.age === "string") {
      page.age = row.age;
    }
    pages.push(page);
  }
  return pages;
}

function pagesSaidOf(payload: unknown): string | null {
  if (isRecord(payload) && typeof payload.said === "string" && payload.said.length > 0) {
    return payload.said;
  }
  return null;
}

/** Tavily-shaped search with a monthly call cap per key and for the gateway. */
// eslint-disable-next-line complexity -- one branch per quota, masking action and vendor answer.
async function searchOnce(input: {
  config: GatewayConfig;
  principal: GatewayPrincipal;
  query: string;
  searchLedger: SearchLedger;
  now: number;
  fetchImpl?: typeof fetch;
  masker: Masker;
  maskingRecords?: MaskingRecordStore;
  agent: string;
  logger: Logger;
}): Promise<SearchOutcome> {
  const settings = input.config.search;
  if (settings?.enabled !== true) {
    return {
      status: 404,
      payload: { error: { message: "Search is not enabled", type: "not_found" } },
    };
  }
  if (settings.monthlyCalls !== undefined && settings.monthlyCalls !== null) {
    if (input.searchLedger.countThisMonth(null, input.now) >= settings.monthlyCalls) {
      return {
        status: 429,
        payload: { error: { message: "Search budget is used up", type: "quota_exceeded" } },
      };
    }
  }
  if (
    input.principal.searchCallsPerMonth !== null &&
    input.searchLedger.countThisMonth(input.principal.key, input.now) >=
      input.principal.searchCallsPerMonth
  ) {
    return {
      status: 429,
      payload: {
        error: { message: "This key's search allowance is used up", type: "quota_exceeded" },
      },
    };
  }
  const maskingEnabled = maskingWanted(input.config.masking);
  let sentQuery = input.query;
  let masking: { hits: MaskHit[]; blocked: boolean } | null = null;
  let maskingMs = 0;
  if (maskingEnabled) {
    const started = Date.now();
    await input.masker.prime(input.query);
    const masked = input.masker.maskTextWithHits(input.query);
    maskingMs = Date.now() - started;
    masking = { hits: masked.hits, blocked: masked.blocked };
    if (masked.blocked) {
      input.maskingRecords?.add({
        agent: input.agent,
        provider: "search",
        hits: masked.hits,
        tookMs: maskingMs,
        blocked: true,
      });
      return {
        status: 400,
        payload: {
          error: { message: "Held back by masking", type: "masking_blocked" },
        },
      };
    }
    sentQuery = masked.text;
  }
  const apis = readySearchApis(settings.apis);
  if (apis.length > 0) {
    const { outcome, counts } = await searchApisOnce({
      apis,
      query: sentQuery,
      fetchImpl: input.fetchImpl,
      logger: input.logger,
      masker: input.masker,
      maskingEnabled,
    });
    input.searchLedger.record({
      time: new Date(input.now).toISOString(),
      key: input.principal.key,
      status: outcome.status,
      credits: 1,
    });
    if (masking !== null) {
      input.maskingRecords?.add({
        agent: input.agent,
        provider: "search",
        hits: masking.hits,
        tookMs: maskingMs,
        blocked: false,
        back: restoredBack(counts),
      });
    }
    return outcome;
  }
  const headers = new Headers({ "content-type": "application/json" });
  if (settings.apiKey !== undefined) {
    headers.set("authorization", `Bearer ${settings.apiKey}`);
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  let response: globalThis.Response;
  try {
    response = await fetchImpl(settings.url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        ...(settings.apiKey === undefined ? {} : { api_key: settings.apiKey }),
        query: sentQuery,
      }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    input.searchLedger.record({
      time: new Date(input.now).toISOString(),
      key: input.principal.key,
      status: 0,
      credits: 1,
    });
    return {
      status: 502,
      payload: { error: { message: errorMessage(error), type: "gateway_error" } },
    };
  }
  const text = await response.text();
  let payload: unknown = text;
  try {
    payload = JSON.parse(text);
  } catch {
    // A search vendor that answers text is passed on as text.
  }
  const restoreCounts: RestoreCounts = new Map();
  if (maskingEnabled) {
    payload = input.masker.restoreValue(payload, restoreCounts);
  }
  input.searchLedger.record({
    time: new Date(input.now).toISOString(),
    key: input.principal.key,
    status: response.status,
    credits: 1,
  });
  if (masking !== null) {
    input.maskingRecords?.add({
      agent: input.agent,
      provider: "search",
      hits: masking.hits,
      tookMs: maskingMs,
      blocked: false,
      back: restoredBack(restoreCounts),
    });
  }
  return { status: response.status, payload };
}

async function forwardSearch(input: SearchContext): Promise<void> {
  const config = input.configStore.get();
  const principal = resolvePrincipal(input.req, config);
  if (principal === null) {
    input.res.status(401).json({ error: { message: "Invalid gateway key", type: "unauthorized" } });
    return;
  }
  if (input.searchLedger === undefined) {
    input.res
      .status(503)
      .json({ error: { message: "Search ledger is unavailable", type: "unavailable" } });
    return;
  }
  const body = isRecord(input.req.body) ? input.req.body : {};
  let query = "";
  if (typeof body.query === "string") {
    query = body.query;
  } else if (typeof body.q === "string") {
    query = body.q;
  }
  if (query.trim().length === 0) {
    input.res
      .status(400)
      .json({ error: { message: "query is required", type: "invalid_request" } });
    return;
  }
  const outcome = await searchOnce({
    config,
    principal,
    query,
    searchLedger: input.searchLedger,
    now: Date.now(),
    masker: input.masker,
    maskingRecords: input.maskingRecords,
    agent: clientOfUserAgent(input.req.headers["user-agent"]),
    logger: input.logger,
  });
  if (typeof outcome.payload === "string") {
    input.res.status(outcome.status).type("text/plain").send(outcome.payload);
    return;
  }
  input.res.status(outcome.status).json(outcome.payload);
}

async function serveSearchMcp(input: SearchContext): Promise<void> {
  const body = isRecord(input.req.body) ? input.req.body : {};
  const id = body.id ?? null;
  const method = typeof body.method === "string" ? body.method : "";
  const reply = (result: unknown): void => {
    input.res.json({ jsonrpc: "2.0", id, result });
  };
  if (method === "initialize") {
    reply({
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "neox-web-search", version: "1" },
    });
    return;
  }
  if (method === "tools/list") {
    reply({ tools: WEB_SEARCH_TOOLS });
    return;
  }
  if (method === "notifications/initialized" || method === "notifications/cancelled") {
    input.res.status(202).end();
    return;
  }
  if (method !== "tools/call") {
    input.res.json({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
    return;
  }
  const params = isRecord(body.params) ? body.params : {};
  const args = isRecord(params.arguments) ? params.arguments : {};
  const config = input.configStore.get();
  const principal = resolvePrincipal(input.req, config);
  if (principal === null || input.searchLedger === undefined) {
    input.res.status(401).json({ error: { message: "Invalid gateway key", type: "unauthorized" } });
    return;
  }
  if (params.name === "web_fetch") {
    const text = await fetchPage(args);
    reply({ content: [{ type: "text", text }], isError: false });
    return;
  }
  const query = typeof args.query === "string" ? args.query : "";
  if (query.trim().length === 0) {
    reply({ content: [{ type: "text", text: "query is required" }], isError: true });
    return;
  }
  const outcome = await searchOnce({
    config,
    principal,
    query,
    searchLedger: input.searchLedger,
    now: Date.now(),
    masker: input.masker,
    maskingRecords: input.maskingRecords,
    agent: clientOfUserAgent(input.req.headers["user-agent"]),
    logger: input.logger,
  });
  reply({
    content: [
      {
        type: "text",
        text:
          typeof outcome.payload === "string" ? outcome.payload : JSON.stringify(outcome.payload),
      },
    ],
    isError: outcome.status >= 400,
  });
}

interface KeyRevokeContext {
  req: ExpressRequest;
  res: ExpressResponse;
  id: string;
  configStore: GatewayConfigStore;
}

/** DELETE /v1/myna/keys/:id revokes a child key the caller issued. */
async function revokeIssuedKey(input: KeyRevokeContext): Promise<void> {
  const config = input.configStore.get();
  const principal = resolvePrincipal(input.req, config);
  if (principal === null || !principal.issues) {
    input.res
      .status(403)
      .json({ error: { message: "This key cannot revoke keys", type: "forbidden" } });
    return;
  }
  const keys = config.keys.filter((entry) => {
    if (typeof entry === "string") {
      return true;
    }
    if (entry.issuer !== principal.key) {
      return true;
    }
    return entry.key !== input.id && entry.label !== input.id;
  });
  if (keys.length === config.keys.length) {
    input.res.status(404).json({ error: { message: "No such key", type: "not_found" } });
    return;
  }
  await input.configStore.write({ ...config, keys });
  input.res.status(204).end();
}

interface McpProxyContext {
  req: ExpressRequest;
  res: ExpressResponse;
  configStore: GatewayConfigStore;
  searchLedger: SearchLedger | undefined;
  ledger: UsageLedger;
  logger: Logger;
  browser: BrowserRelay | undefined;
  masker: Masker;
  maskingRecords?: MaskingRecordStore;
  vision: VisionService | undefined;
  media: MediaMcp | undefined;
  mcpauth: McpauthService | undefined;
}

/**
 * myna's companion MCP endpoints answer with tools that belong to its
 * plugins. Neolix does not ship those plugins; it forwards the JSON-RPC to
 * whichever server `gateway.json` names for that tool.
 */
interface LibraryHubContext {
  req: ExpressRequest;
  res: ExpressResponse;
  configStore: GatewayConfigStore;
  logger: Logger;
}

/**
 * Serves the Library's hub as MCP: the tools of the servers ticked for an
 * agent (every server for the all-agents address), each named
 * `<server>__<tool>`, handed to the library's own connections.
 */
async function serveLibraryHub(input: LibraryHubContext): Promise<void> {
  const config = input.configStore.get();
  if (resolvePrincipal(input.req, config) === null) {
    input.res.status(401).json({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32001, message: "The MCP hub needs a gateway key from another machine" },
    });
    return;
  }
  const agent =
    typeof input.req.params.agent === "string" ? decodeURIComponent(input.req.params.agent) : "";
  const body = input.req.body;
  const messages = Array.isArray(body) ? body : [body];
  const answers: unknown[] = [];
  for (const message of messages) {
    if (!isRecord(message)) {
      continue;
    }
    const id = message.id ?? null;
    const method = typeof message.method === "string" ? message.method : "";
    const params = isRecord(message.params) ? message.params : {};
    if (message.id === undefined || id === null) {
      continue; // a notification is answered with nothing
    }
    if (method === "initialize") {
      answers.push({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion:
            typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "neox", title: "Neox MCP hub", version: "1" },
          instructions: hubInstructions(),
        },
      });
      continue;
    }
    if (method === "ping") {
      answers.push({ jsonrpc: "2.0", id, result: {} });
      continue;
    }
    if (method === "tools/list") {
      const hub = getLibraryHub();
      const tools = hub ? await hub.listTools(agent) : [];
      answers.push({
        jsonrpc: "2.0",
        id,
        result: {
          tools: hubToolNames(tools).map((tool) => ({
            name: tool.name,
            description: `[${tool.server}] ${tool.description ?? ""}`.trim(),
            inputSchema: tool.inputSchema,
          })),
        },
      });
      continue;
    }
    if (method === "tools/call") {
      answers.push({ jsonrpc: "2.0", ...(await callLibraryHubTool(agent, id, params)) });
      continue;
    }
    answers.push({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `The MCP hub has no ${method}` },
    });
  }
  if (answers.length === 0) {
    input.res.status(202).end();
    return;
  }
  input.res.json(Array.isArray(body) ? answers : answers[0]);
}

async function callLibraryHubTool(
  agent: string,
  id: unknown,
  params: Record<string, unknown>,
): Promise<{ id: unknown; result?: unknown; error?: { code: number; message: string } }> {
  const hub = getLibraryHub();
  if (!hub) {
    return { id, error: { code: -32601, message: "The MCP hub is not running" } };
  }
  const name = typeof params.name === "string" ? params.name : "";
  const args = isRecord(params.arguments) ? params.arguments : {};
  const meta = isRecord(params._meta) ? params._meta : undefined;
  const listed = hubToolNames(await hub.listTools(agent)).find((entry) => entry.name === name);
  // A tool the server stopped listing can still be called, as myna allows
  // (hub_mcp_test.go: TestHubMCPCallsAToolNoLongerListed).
  const [serverName, toolName] = listed
    ? [listed.server, listed.tool]
    : [name.slice(0, name.indexOf("__")), name.slice(name.indexOf("__") + 2)];
  if (!serverName || !toolName || name.indexOf("__") < 0) {
    return { id, error: { code: -32602, message: `The MCP hub has no tool ${name}` } };
  }
  try {
    return { id, result: await hub.callTool(agent, serverName, toolName, args, meta) };
  } catch (error) {
    return {
      id,
      result: {
        content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
        isError: true,
      },
    };
  }
}

/** The browser MCP server, with the file host's base URL and the caller's key. */
function serveBrowserCall(input: McpProxyContext, config: GatewayConfig): void {
  const principal = resolvePrincipal(input.req, config);
  serveBrowserMcp(input.browser!, input.req.body ?? {}, input.res, browserSessionOf(input.req), {
    baseUrl: browserBaseUrl(input.req),
    key: principal === null ? null : principal.key,
  });
}

async function proxyMcp(input: McpProxyContext): Promise<void> {
  const config = input.configStore.get();
  if (resolvePrincipal(input.req, config) === null) {
    input.res.status(401).json({ error: { message: "Invalid gateway key", type: "unauthorized" } });
    return;
  }
  const name = typeof input.req.params.name === "string" ? input.req.params.name : "";
  if (name === "web-search") {
    await serveSearchMcp({
      req: input.req,
      res: input.res,
      configStore: input.configStore,
      searchLedger: input.searchLedger,
      ledger: input.ledger,
      logger: input.logger,
      masker: input.masker,
      maskingRecords: input.maskingRecords,
    });
    return;
  }
  if (name === "browser" && input.browser !== undefined) {
    serveBrowserCall(input, config);
    return;
  }
  if (await serveBuiltInMcp(input, name)) {
    return;
  }
  // A remote server Neolix signed in to once: the agents are given this
  // address, and Neolix sends the request on with its own token
  // (myna internal/library/mcp_signin.go:38, internal/gateway/mcp.go:56).
  if (
    await serveSignedInMcp({
      req: input.req,
      res: input.res,
      logger: input.logger,
      mcpauth: input.mcpauth,
    })
  ) {
    return;
  }
  const run = input.req.path.startsWith("/mcp/run/");
  const configured = config.mcp ?? {};
  const target = run ? (configured[`run:${name}`] ?? configured[name]) : configured[name];
  if (target === undefined) {
    // A valid MCP server with no tools, so a client that lists before the
    // user configures one gets an answer rather than a 404.
    serveEmptyMcp(input.req.body, input.res, name);
    return;
  }
  const rest = typeof input.req.params[0] === "string" ? input.req.params[0] : "";
  const url = `${target.replace(/\/+$/, "")}${rest.length > 0 ? `/${rest}` : ""}`;
  let upstream: { status: number; contentType: string | null; text: string };
  try {
    upstream = await postJson(url, input.req.body ?? {});
  } catch (error) {
    input.logger.warn({ err: error, name }, "Cannot reach the MCP server");
    input.res
      .status(502)
      .json({ error: { message: "MCP server unreachable", type: "gateway_error" } });
    return;
  }
  input.res.status(upstream.status);
  if (upstream.contentType !== null) {
    input.res.setHeader("content-type", upstream.contentType);
  }
  input.res.send(upstream.text);
}

/**
 * A JSON POST without undici's `Sec-Fetch-*` headers: myna's browser MCP
 * refuses anything that looks like a web page, and this proxy is a program.
 */
function postJson(
  url: string,
  body: unknown,
): Promise<{ status: number; contentType: string | null; text: string }> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const payload = JSON.stringify(body);
    const request = (target.protocol === "https:" ? httpsRequest : httpRequest)(
      target,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
        },
        timeout: 60_000,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 502,
            contentType:
              typeof response.headers["content-type"] === "string"
                ? response.headers["content-type"]
                : null,
            text: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    request.on("timeout", () => request.destroy(new Error("MCP server timed out")));
    request.on("error", reject);
    request.end(payload);
  });
}

/**
 * Posts a request to this daemon's own gateway, so the router's calls — the
 * classifier's, Codex's summary and its side turns — go through the same
 * routing, account rotation and failover as any other. `path` is a gateway
 * path such as /v1/chat/completions. The listener may be a TCP port or a Unix
 * socket.
 */
function postToSelf(
  req: ExpressRequest,
  input: {
    body: Record<string, unknown>;
    signal: AbortSignal;
    path?: string;
    headers?: Record<string, string>;
  },
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(input.body);
    const request = httpRequest(
      {
        ...selfListener(req),
        path: `${req.baseUrl}${input.path ?? "/v1/chat/completions"}`,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
          "user-agent": ROUTER_USER_AGENT,
          [ROUTER_CALL_HEADER]: ROUTER_CALL_TOKEN,
          ...input.headers,
        },
        signal: input.signal,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const status = response.statusCode ?? 502;
          const text = Buffer.concat(chunks).toString("utf8");
          if (status >= 300) {
            // A failed call is not an answer: the classifier is asked again
            // next turn rather than the failure being kept as "no intent".
            reject(new GatewaySelfError(status, text));
            return;
          }
          try {
            resolve(JSON.parse(text));
          } catch {
            reject(new GatewaySelfError(status, text));
          }
        });
        response.on("error", reject);
      },
    );
    request.on("error", reject);
    request.end(payload);
  });
}

/**
 * myna's own MCP servers at myna's paths. The bare /mcp/vision and
 * /mcp/image stay free for servers the user configured under those names.
 */
async function serveBuiltInMcp(input: McpProxyContext, name: string): Promise<boolean> {
  const path = input.req.path;
  if (name === "vision" && path === "/mcp/myna/vision" && input.vision !== undefined) {
    await serveVisionMcp({
      req: input.req,
      res: input.res,
      configStore: input.configStore,
      vision: input.vision,
      send: visionSend(input.req),
      masker: input.masker,
      logger: input.logger,
    });
    return true;
  }
  if (name === "image" && path === "/mcp/myna/image" && input.media !== undefined) {
    await input.media.serve({
      req: input.req,
      res: input.res,
      configStore: input.configStore,
      send: mediaSend(input.req),
    });
    return true;
  }
  return false;
}

/**
 * The vision service's asker: a description request posted to this daemon's
 * own /v1/chat/completions, as myna's vision asks itself. The router's call
 * token and the loopback socket make it the gateway's own call, and the User
 * Agent keeps the usage ledger's client name `neolix-vision`.
 */
/** At most the first 8 upstream requests of a call are logged. */
const WIRE_MOST = 8;

/** The upstream requests of a call, for the request archive. */
function wireLog(res: ExpressResponse): UpstreamWire[] {
  // A synthetic response (the Ollama bridge) has no locals to keep them in.
  const locals = res.locals as Record<string, unknown> | undefined;
  if (locals === undefined) {
    return [];
  }
  const existing = locals.archiveWire;
  if (Array.isArray(existing)) {
    return existing as UpstreamWire[];
  }
  const created: UpstreamWire[] = [];
  locals.archiveWire = created;
  return created;
}

function wireHook(res: ExpressResponse): { onWire: (wire: UpstreamWire) => void } {
  return {
    onWire: (wire) => {
      const log = wireLog(res);
      if (log.length < WIRE_MOST) {
        log.push(wire);
      }
    },
  };
}

function visionSend(req: ExpressRequest): VisionSend {
  return async (ask, signal) => {
    let reply: unknown;
    try {
      reply = await postToSelf(req, {
        body: {
          model: ask.model,
          stream: false,
          max_tokens: 4096,
          messages: [
            { role: "system", content: ask.system },
            {
              role: "user",
              content: [
                { type: "text", text: ask.prompt },
                { type: "image_url", image_url: { url: ask.image } },
              ],
            },
          ],
        },
        signal,
        headers: { "user-agent": VISION_USER_AGENT },
      });
    } catch (error) {
      // GatewaySelfError keeps the vendor's answer; its message alone would
      // only say a status.
      if (error instanceof GatewaySelfError) {
        throw new Error(error.body.slice(0, 300).trim() || error.message, { cause: error });
      }
      throw error;
    }
    if (!isRecord(reply)) {
      throw new Error("the gateway's description is not an object");
    }
    return codecFor("openai")
      .parseResponse(reply)
      .parts.map((part) => (part.type === "text" ? part.text : ""))
      .join("\n")
      .trim();
  };
}

/**
 * The image MCP's caller: calls this daemon's own images and videos API with
 * the caller's own credentials, so its key's models and limits hold the call
 * as they hold /v1/images. Unlike the router's own calls it does not carry
 * the internal token: the gateway must see the key, not the router.
 */
function mediaSend(req: ExpressRequest): MediaSend {
  return (input) =>
    new Promise((resolve, reject) => {
      const headers: Record<string, string> = {};
      for (const name of [
        "authorization",
        "x-api-key",
        "x-goog-api-key",
        "anthropic-version",
        "user-agent",
      ]) {
        const value = req.headers[name];
        if (typeof value === "string" && value.length > 0) {
          headers[name] = value;
        }
      }
      if (input.contentType !== undefined) {
        headers["content-type"] = input.contentType;
      }
      if (input.body !== undefined) {
        headers["content-length"] = String(input.body.length);
      }
      const request = httpRequest(
        {
          ...selfListener(req),
          path: `${req.baseUrl}${input.path}`,
          method: input.method,
          headers,
          signal: AbortSignal.timeout(input.timeoutMs),
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () =>
            resolve({
              status: response.statusCode ?? 502,
              text: Buffer.concat(chunks).toString("utf8"),
            }),
          );
          response.on("error", reject);
        },
      );
      request.on("error", reject);
      if (input.body !== undefined) {
        request.write(input.body);
      }
      request.end();
    });
}

/** Where the server that took req is listening. */
function selfListener(
  req: ExpressRequest,
): { host: string; port: number } | { socketPath: string } {
  const socket = req.socket;
  if (socket.localPort === undefined) {
    const address = socket.address();
    if (typeof address === "string") {
      return { socketPath: address };
    }
    if ("port" in address && typeof address.port === "number") {
      return { host: "127.0.0.1", port: address.port };
    }
    throw new Error("The gateway listener has no address to call");
  }
  const address = socket.localAddress;
  const host = localHostFor(address);
  return { host, port: socket.localPort };
}

/** The address to reach a listener bound to `address` over the loopback. */
function localHostFor(address: string | undefined): string {
  if (address === "0.0.0.0") {
    return "127.0.0.1";
  }
  if (address === "::") {
    return "::1";
  }
  return address ?? "127.0.0.1";
}

const WEB_SEARCH_TOOLS = [
  {
    name: "web_search",
    title: "Web search",
    description:
      "Search the web for current information: news, releases, documentation, prices, anything after your training or that you are unsure of. Returns what the pages found say, with their URLs.",
    annotations: { openWorldHint: true, readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "What to search for" } },
      required: ["query"],
    },
  },
  {
    name: "web_fetch",
    title: "Fetch a web page",
    description:
      "Fetch a web page by its http(s) URL and return its text (an HTML page as text, with its links). A long page comes in parts: ask again with offset.",
    annotations: { openWorldHint: true, readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The page's http(s) URL" },
        max_chars: { type: "number", description: "How much text to return (default 20000)" },
        offset: { type: "number", description: "Where to start reading (default 0)" },
      },
      required: ["url"],
    },
  },
] as const;

/** myna's companion tools; Neolix forwards their calls to a configured server. */
function companionTools(name: string): Record<string, unknown>[] {
  if (name === "tools") {
    return [
      {
        name: "calc_eval",
        description: "Evaluate an arithmetic expression exactly.",
        inputSchema: {
          type: "object",
          properties: { expression: { type: "string" }, places: { type: "number" } },
          required: ["expression"],
        },
      },
      {
        name: "calc_convert",
        description: "Convert between units and currencies.",
        inputSchema: {
          type: "object",
          properties: {
            value: { type: "number" },
            from: { type: "string" },
            to: { type: "string" },
          },
          required: ["value", "from", "to"],
        },
      },
      {
        name: "calc_date",
        description: "Do date arithmetic and time-zone questions.",
        inputSchema: {
          type: "object",
          properties: { expression: { type: "string" } },
          required: ["expression"],
        },
      },
    ];
  }
  if (name === "browser") {
    // myna lists its browser tool only while the extension is connected;
    // without a configured server Neolix has none to list.
    return [];
  }
  return [];
}

async function fetchPage(args: Record<string, unknown>): Promise<string> {
  const url = typeof args.url === "string" ? args.url : "";
  if (!/^https?:\/\//i.test(url)) {
    return "url must be an http(s) address";
  }
  const maxChars =
    typeof args.max_chars === "number" && args.max_chars > 0
      ? Math.min(200_000, Math.trunc(args.max_chars))
      : 20_000;
  const offset = typeof args.offset === "number" && args.offset > 0 ? Math.trunc(args.offset) : 0;
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(20_000),
      headers: { "user-agent": "neolix-gateway/1" },
    });
    if (!response.ok) {
      return `The page answered ${response.status}`;
    }
    const text = await response.text();
    const plain = /html/i.test(response.headers.get("content-type") ?? "") ? toText(text) : text;
    return plain.slice(offset, offset + maxChars);
  } catch (error) {
    return `The page cannot be read: ${errorMessage(error)}`;
  }
}

function toText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function serveEmptyMcp(body: unknown, res: ExpressResponse, name: string): void {
  const request = isRecord(body) ? body : {};
  const id = request.id ?? null;
  const method = typeof request.method === "string" ? request.method : "";
  if (method === "initialize") {
    res.json({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "neolix-mcp", version: "1" },
      },
    });
    return;
  }
  if (method === "tools/list") {
    res.json({ jsonrpc: "2.0", id, result: { tools: companionTools(name) } });
    return;
  }
  if (method === "notifications/initialized" || method === "notifications/cancelled") {
    res.status(202).end();
    return;
  }
  if (method === "tools/call") {
    const params = isRecord(request.params) ? request.params : {};
    const tool = typeof params.name === "string" ? params.name : "";
    const args = isRecord(params.arguments) ? params.arguments : {};
    const result = runCalcTool(tool, args);
    res.json({
      jsonrpc: "2.0",
      id,
      result: {
        content: [{ type: "text", text: result.text }],
        isError: result.isError,
      },
    });
    return;
  }
  res.json({
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: "No MCP server is configured for this name" },
  });
}

/** The calc tools myna ships execute locally; the rest need `mcp.<name>`. */
function runCalcTool(
  tool: string,
  args: Record<string, unknown>,
): { text: string; isError: boolean } {
  const optionalPlaces = typeof args.places === "number" ? args.places : undefined;
  let text: string;
  try {
    if (tool === "calc_eval") {
      text = calcEval(String(args.expression ?? ""), optionalPlaces);
    } else if (tool === "calc_convert") {
      text = calcConvert(
        String(args.value ?? ""),
        String(args.from ?? ""),
        String(args.to ?? ""),
        optionalPlaces,
      );
    } else if (tool === "calc_date") {
      text = calcDate({
        ...(typeof args.date === "string" ? { date: args.date } : {}),
        ...(typeof args.add === "string" ? { add: args.add } : {}),
        ...(typeof args.to === "string" ? { to: args.to } : {}),
        ...(typeof args.timeZone === "string" ? { timeZone: args.timeZone } : {}),
      });
    } else {
      return { text: `No MCP server is configured for ${tool}`, isError: true };
    }
  } catch (error) {
    return { text: errorMessage(error), isError: true };
  }
  let isError = false;
  try {
    const parsed: unknown = JSON.parse(text);
    isError = isRecord(parsed) && typeof parsed.error === "string";
  } catch {
    isError = false;
  }
  return { text, isError };
}

function sendHeap(res: ExpressResponse): void {
  const memory = process.memoryUsage();
  const heap = nodeV8.getHeapStatistics();
  const stats = {
    pid: process.pid,
    program: "neolix",
    version: "0.15.0",
    window: false,
    uptime: `${Math.round(process.uptime())}s`,
    heapAlloc: memory.heapUsed,
    heapSys: heap.heap_size_limit,
    heapInuse: memory.heapTotal,
    sys: memory.rss,
    heapObjects: heap.number_of_native_contexts,
  };
  res.setHeader("x-magpie-heap-stats", JSON.stringify(stats));
  res.setHeader("cache-control", "no-store");
  res.json(stats);
}

async function sendCpuProfile(req: ExpressRequest, res: ExpressResponse): Promise<void> {
  const requested = Number(req.query.seconds);
  const seconds = Number.isFinite(requested) && requested > 0 ? Math.min(30, requested) : 2;
  const before = process.cpuUsage();
  const started = Date.now();
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  const delta = process.cpuUsage(before);
  const elapsedMs = Date.now() - started;
  const userMs = delta.user / 1000;
  const systemMs = delta.system / 1000;
  res.setHeader("cache-control", "no-store");
  res.json({
    seconds,
    elapsedMs,
    userMs,
    systemMs,
    percent: Math.round(((userMs + systemMs) / elapsedMs) * 1000) / 10,
  });
}

interface CodexBackendContext {
  req: ExpressRequest;
  res: ExpressResponse;
  configStore: GatewayConfigStore;
  logger: Logger;
  options: GatewayRouterOptions;
}

/** `/backend-api/codex/*` is Codex's own backend protocol. */
async function proxyCodexBackend(input: CodexBackendContext): Promise<void> {
  const config = input.configStore.get();
  if (resolvePrincipal(input.req, config) === null) {
    input.res.status(401).json({ error: { message: "Invalid gateway key", type: "unauthorized" } });
    return;
  }
  const isWrite = input.req.method !== "GET" && input.req.method !== "HEAD";
  const body = input.req.body;
  if (isWrite && (!isRecord(body) || (body.model === undefined && body.input === undefined))) {
    input.res.status(400).json({ error: "not a Codex request" });
    return;
  }
  const leftAlone = input.options?.codexLeftAlone;
  const neolixHome = input.options?.neolixHome;
  let target = await codexTarget(config, { neolixHome, leftAlone });
  if ("error" in target) {
    input.res.status(401).json({ error: { message: target.error, type: "unauthorized" } });
    return;
  }
  const rest = input.req.originalUrl.slice("/backend-api/codex".length);
  let upstream: globalThis.Response;
  try {
    upstream = await sendCodex(input.req, target.target, rest, body, isWrite);
    if (upstream.status === 401 && target.target.pooled) {
      // A pool sign-in was called expired with time left: leave the pool
      // alone this time and let Codex's own sign-in answer, as myna turns
      // to a login that can (provider/logins_on.go:200).
      const fallback = await codexTarget(config, { neolixHome, leftAlone, ignorePool: true });
      if (!("error" in fallback)) {
        target = fallback;
        upstream = await sendCodex(input.req, fallback.target, rest, body, isWrite);
      }
    } else if (upstream.status === 401 && target.target.canRenew) {
      // The backend called a token with time left expired: refresh it once,
      // as myna does (codexTokenRenewing), and ask again.
      const renewed = await codexTarget(config, { neolixHome, leftAlone, force: true });
      if (!("error" in renewed)) {
        target = renewed;
        upstream = await sendCodex(input.req, renewed.target, rest, body, isWrite);
      }
    }
  } catch (error) {
    input.logger.warn({ err: error }, "Cannot reach the Codex backend");
    input.res
      .status(502)
      .json({ error: { message: "Codex backend unreachable", type: "gateway_error" } });
    return;
  }
  noteCodexLimits(target.target.limitKey, parseCodexLimitHeaders(upstream.headers));
  await pipeUpstream(input.res, upstream);
}

/** One try at the backend, with the headers this turn goes on with. */
async function sendCodex(
  req: ExpressRequest,
  target: CodexTarget,
  rest: string,
  body: unknown,
  isWrite: boolean,
): Promise<globalThis.Response> {
  return fetch(`${target.base.replace(/\/+$/, "")}${rest}`, {
    method: req.method,
    headers: codexRequestHeaders(req, target, isWrite),
    ...(isWrite ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(120_000),
  });
}

/** ChatGPT's own Codex backend, which the sign-in Codex keeps answers. */
const CHATGPT_CODEX_BASE = "https://chatgpt.com/backend-api/codex";

interface CodexTarget {
  base: string;
  headers: Record<string, string>;
  /** The ChatGPT account that answered; null for a backend of the user's own. */
  accountId: string | null;
  /** The key the account's windows are kept under (`codexLimitsOf`). */
  limitKey: string;
  /** A sign-in of Codex's, which a 401 may refresh once. */
  canRenew: boolean;
  /** A sign-in from Neolix's own pool (`codex-accounts.json`). */
  pooled: boolean;
}

interface CodexTargetOptions {
  neolixHome?: string;
  leftAlone?: () => boolean;
  /** Refresh Codex's sign-in even while its access token is good. */
  force?: boolean;
  /** Read Codex's own sign-in only, leaving Neolix's pool alone. */
  ignorePool?: boolean;
}

/**
 * Where a Codex turn goes: `gateway.json`'s backend as it is, or ChatGPT's
 * with a sign-in. Neolix's own ChatGPT accounts (`codex-accounts.json`) answer
 * first and Codex's own sign-in is the fallback, as myna spends the first
 * login that can answer (`provider/account_order.go:5-8`). A left-alone
 * provider is read as it is; any other is refreshed and written back where
 * Codex keeps it.
 */
async function codexTarget(
  config: GatewayConfig,
  options: CodexTargetOptions = {},
): Promise<{ target: CodexTarget } | { error: string }> {
  if (config.codexBackend !== undefined) {
    return {
      target: {
        base: config.codexBackend,
        headers: {},
        accountId: null,
        limitKey: "codex-own",
        canRenew: false,
        pooled: false,
      },
    };
  }
  if (options.ignorePool !== true && options.neolixHome !== undefined) {
    let pooled: PooledSignIn | null = null;
    try {
      pooled = await pooledCodexSignIn({
        accountsFile: join(options.neolixHome, "gateway", "codex-accounts.json"),
        // Write-back off leaves every sign-in, Neolix's own included, as it
        // is: a token near its expiry is then skipped rather than refreshed.
        writeBack: config.codexSignInWriteBack !== false,
      });
    } catch {
      // A store that cannot be written leaves Codex's own sign-in to answer.
      pooled = null;
    }
    if (pooled !== null) {
      return {
        target: {
          base: CHATGPT_CODEX_BASE,
          headers: {
            authorization: `Bearer ${pooled.accessToken}`,
            "OpenAI-Beta": "responses=experimental",
            originator: "codex_cli_rs",
            ...(pooled.accountId === null ? {} : { "chatgpt-account-id": pooled.accountId }),
          },
          accountId: pooled.accountId,
          limitKey: pooled.limitKey,
          canRenew: false,
          pooled: true,
        },
      };
    }
  }
  const discovery = accountDiscoveryOn(config);
  const writeBack = config.codexSignInWriteBack !== false;
  const signIn =
    options.leftAlone?.() === true || !writeBack
      ? await readCodexSignIn({ discovery })
      : await renewCodexSignIn({ discovery, renew: true, force: options.force === true });
  if (!signIn.ok) {
    return { error: signIn.error };
  }
  return {
    target: {
      base: CHATGPT_CODEX_BASE,
      headers: {
        authorization: `Bearer ${signIn.accessToken}`,
        "OpenAI-Beta": "responses=experimental",
        originator: "codex_cli_rs",
        ...(signIn.accountId === null ? {} : { "chatgpt-account-id": signIn.accountId }),
      },
      accountId: signIn.accountId,
      // Codex's own sign-in is not one of the pool's accounts, so it gets
      // the one key both reading and writing use (`CODEX_OWN_LIMIT_KEY`).
      limitKey: CODEX_OWN_LIMIT_KEY,
      canRenew: writeBack && options.leftAlone?.() !== true,
      pooled: false,
    },
  };
}

/** The headers a Codex turn goes on with: its own, and the sign-in's when ChatGPT answers. */
function codexRequestHeaders(req: ExpressRequest, target: CodexTarget, isWrite: boolean): Headers {
  const headers = new Headers(target.headers);
  for (const name of [
    "accept",
    "version",
    "session_id",
    "conversation_id",
    "x-openai-internal-codex-responses-lite",
  ]) {
    const value = req.get(name);
    if (value !== undefined) {
      headers.set(name, value);
    }
  }
  if (isWrite) {
    headers.set("content-type", "application/json");
  }
  return headers;
}

interface RawRouteContext {
  req: ExpressRequest;
  res: ExpressResponse;
  path: string;
  configStore: GatewayConfigStore;
  ledger: UsageLedger;
  runtime: GatewayRuntime;
  logger: Logger;
  multipart?: boolean;
  masker: Masker;
  maskingRecords?: MaskingRecordStore;
}

/**
 * Non-chat APIs (embeddings, rerank, images, speech, video) go to the upstream
 * that serves the requested model, shape untouched. Failover and resting use
 * the same rules as chat, without protocol translation.
 */
// debt: failover, tracing and ledger writes share one loop; split it when the
// next raw API needs its own shape.
// eslint-disable-next-line complexity
async function forwardRaw(input: RawRouteContext): Promise<void> {
  const config = input.configStore.get();
  if (gatewayPrincipal(input.req, config) === null) {
    input.res.status(401).json({ error: { message: "Invalid gateway key", type: "unauthorized" } });
    return;
  }
  // A generation's prompt is free text, masked as a chat's; other raw APIs
  // stay byte-for-byte (embeddings, speech, files).
  const maskingEnabled = maskingWanted(config.masking) && input.path === "/v1/images/generations";
  const agent = clientOfUserAgent(input.req.headers["user-agent"]);
  let sentBody = input.req.body;
  let masking: { hits: MaskHit[]; blocked: boolean } | null = null;
  let maskingMs = 0;
  if (maskingEnabled && isRecord(sentBody)) {
    const started = Date.now();
    const masked = input.masker.maskValueWithHits(sentBody);
    maskingMs = Date.now() - started;
    masking = { hits: masked.hits, blocked: masked.blocked };
    if (masked.blocked) {
      input.maskingRecords?.add({
        agent,
        provider: "image",
        hits: masked.hits,
        tookMs: maskingMs,
        blocked: true,
      });
      input.res
        .status(400)
        .json({ error: { message: "Held back by masking", type: "masking_blocked" } });
      return;
    }
    sentBody = masked.value;
  }
  const payload = readRawPayload(sentBody, input.multipart === true);
  if (payload === null) {
    input.res.status(400).json({ error: { message: "Missing model", type: "invalid_request" } });
    return;
  }
  const model = payload.model;
  const routingModel = config.middleware?.aliases[model] ?? model;
  const now = Date.now();
  let plannedRequest: PlannedRequestCandidates;
  try {
    plannedRequest = await planRequestCandidates({
      config,
      requestedModel: routingModel,
      state: input.runtime.routingState,
      context: readRuleContext({ agent, tokens: 0, body: input.req.body, now }),
      ...(isRouterCall(input.req)
        ? {}
        : { classify: (question) => postToSelf(input.req, question) }),
    });
  } catch (error) {
    input.res
      .status(404)
      .json({ error: { message: errorMessage(error), type: "model_not_found" } });
    return;
  }
  const access = authorizeRequest({
    config,
    req: input.req,
    res: input.res,
    ledger: input.ledger,
    rateLimiter: input.runtime.rateLimiter,
    requestedModel: model,
    routingModel,
    candidates: plannedRequest.candidates,
    bodyBytes: Buffer.isBuffer(input.req.body)
      ? input.req.body.length
      : Buffer.byteLength(JSON.stringify(input.req.body ?? {})),
  });
  if (access === null) {
    return;
  }
  // Every raw API spends the key's windows and pace too, not only chat:
  // embeddings, images, speech, rerank and the multipart uploads.
  const { principal, accountFilter } = access;
  const routeInput = {
    config,
    requestedModel: routingModel,
    candidates: plannedRequest.candidates,
    state: input.runtime.routingState,
    now,
    conversationKey: readConversationKey(input.req),
    preserveOrder: plannedRequest.preserveOrder,
    catalog: input.runtime.pricing ?? null,
  };
  const planned = await planPluginStrategy(planCandidates(routeInput), routeInput);
  const trace = input.runtime.routeTrace;
  const route = trace.start({
    time: now,
    agent,
    key: principal.key === null ? null : maskKey(principal.key),
    model,
    routedModel: routingModel,
    alias: config.middleware?.aliases[model] ?? null,
    group: routingModel.startsWith("group/") ? routingModel.slice("group/".length) : null,
    strategy: strategyFor(config, routingModel),
    provider: planned[0]?.provider.id ?? null,
    providerLabel:
      planned[0] === undefined ? null : (planned[0].provider.label ?? planned[0].provider.id),
    seats: traceSeats({
      planned,
      accountState: input.runtime.accountState,
      routingState: input.runtime.routingState,
      ledger: input.ledger,
      now,
    }),
    tries: [],
    prompt: null,
    masked: false,
  });
  try {
    // A provider asked by name whose accounts are all held at their caps
    // ends the request at 429, as chat does (myna's CapStop).
    if (
      refuseAtProviderCap({
        config,
        routingModel,
        planned,
        accountState: input.runtime.accountState,
        res: input.res,
        finishRoute: (_delivered, status) =>
          trace.finish(route.id, {
            status,
            error: status === null ? "refused" : `HTTP ${status}`,
            now: Date.now(),
          }),
      })
    ) {
      return;
    }
    for (const candidate of planned) {
      const allowed = accountFilter?.get(candidate.provider.id);
      const accounts = planAccounts({
        provider: candidate.provider,
        state: input.runtime.accountState,
        now,
        modelId: candidate.model.id,
      }).filter((entry) => allowed === undefined || allowed.has(entry.id));
      if (allowed !== undefined && accounts.length === 0) {
        const skippedAt = Date.now();
        trace.update(route.id, (entry) => {
          entry.tries.push({
            provider: candidate.provider.id,
            account: null,
            model: candidate.model.id,
            start: skippedAt,
            done: true,
            status: null,
            millis: 0,
            error: "The group's accounts do not serve this model",
          });
        });
        continue;
      }
      const account = accounts[0];
      const restKey =
        account === undefined ? candidateKey(candidate) : accountKey(candidate.provider, account);
      const tryStart = Date.now();
      trace.update(route.id, (entry) => {
        entry.tries.push({
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
      const settleTry = (status: number | null, error: string | null): void => {
        trace.update(route.id, (entry) => {
          const last = entry.tries.at(-1);
          if (last === undefined) {
            return;
          }
          last.done = true;
          last.status = status;
          last.millis = Math.max(0, Date.now() - tryStart);
          last.error = error;
        });
      };
      let upstream: globalThis.Response;
      try {
        // A drawing on a vendor whose images API isn't OpenAI's is asked by
        // its adapter, and answered in OpenAI's shape; every other request
        // goes upstream as it came.
        const drawn =
          input.path === "/v1/images/generations" && isRecord(sentBody)
            ? await drawImageFor({
                provider: candidate.provider,
                ...(account === undefined ? {} : { account }),
                model: candidate.model.id,
                body: sentBody,
                timing: { waitMs: imageWaitMs(config) },
              })
            : null;
        upstream =
          drawn ??
          (await fetch(
            joinUpstreamPath(account?.baseUrl ?? candidate.provider.baseUrl, input.path),
            {
              method: "POST",
              headers: buildUpstreamHeaders(
                candidate.provider,
                account,
                input.req.headers,
                incomingContentType(input.req),
              ),
              body: payload.build(candidate.model.id, candidate.provider.extraBody),
            },
          ));
      } catch (error) {
        if (await offlineDetector.isOffline(error, config.providers, candidate.provider)) {
          input.logger.info(
            { provider: candidate.provider.id },
            "Raw gateway call failed while offline; the provider is not rested",
          );
          settleTry(null, "Connection failed");
          continue;
        }
        const duration = restForFailure({ status: null, provider: candidate.provider, now });
        input.runtime.routingState.rest.rest(restKey, duration, now);
        scheduleRestProbe({
          key: restKey,
          provider: candidate.provider,
          account,
          until: now + duration,
          status: 0,
          now,
        });
        input.logger.info(
          { err: error, provider: candidate.provider.id },
          "Raw gateway call failed",
        );
        settleTry(null, "Connection failed");
        continue;
      }
      offlineDetector.noteHeard();
      if (shouldFailover(upstream.status)) {
        const retryAfter = retryAfterMs(upstream.headers.get("retry-after"), now);
        input.runtime.routingState.rest.rest(
          restKey,
          restForFailure({
            status: upstream.status,
            provider: candidate.provider,
            ...(retryAfter > 0 ? { vendorResetAt: now + retryAfter } : {}),
            now,
          }),
          now,
        );
        await upstream.body?.cancel();
        settleTry(upstream.status, `HTTP ${upstream.status}`);
        continue;
      }
      settleTry(upstream.status, null);
      applyReplyHeaders(input.res, candidate.provider, upstream);
      const restoreCounts: RestoreCounts = new Map();
      if (maskingEnabled && masking !== null) {
        await pipeRestored(input.res, upstream, input.masker, restoreCounts);
      } else {
        await pipeUpstream(input.res, upstream);
      }
      if (masking !== null) {
        input.maskingRecords?.add({
          agent,
          provider: "image",
          hits: masking.hits,
          tookMs: maskingMs,
          blocked: false,
          back: restoredBack(restoreCounts),
        });
      }
      input.ledger.record({
        time: new Date(now).toISOString(),
        requested: model,
        provider: candidate.provider.id,
        account: account?.id ?? null,
        model: candidate.model.id,
        protocol: candidate.provider.protocol,
        status: upstream.status,
        ok: upstream.ok,
        inputTokens: 0,
        outputTokens: 0,
        attempts: 1,
        durationMs: Date.now() - now,
        costUsd: 0,
        key: principal.key,
        client: clientOfUserAgent(input.req.headers["user-agent"]),
      });
      trace.finish(route.id, { status: upstream.status, error: null, now: Date.now() });
      return;
    }
  } finally {
    // The held usage goes back however the request left, delivered or not.
    access.reservation.release();
  }
  trace.finish(route.id, { status: 502, error: "HTTP 502", now: Date.now() });
  input.res.status(502).json({ error: { message: "All upstreams failed", type: "gateway_error" } });
}

interface RawPayload {
  model: string;
  build: (modelId: string, extraBody?: Record<string, unknown>) => BodyInit;
}

function readRawPayload(body: unknown, multipart: boolean): RawPayload | null {
  if (multipart) {
    const model = readMultipartModel(body);
    if (model === null || model.length === 0) {
      return null;
    }
    return {
      model,
      build: (modelId) => new Blob([new Uint8Array(rewriteMultipartModel(body, modelId))]),
    };
  }
  if (!isRecord(body)) {
    return null;
  }
  const model = body.model;
  if (typeof model !== "string" || model.length === 0) {
    return null;
  }
  return {
    model,
    build: (modelId, extraBody) =>
      JSON.stringify({ ...applyExtraBody(body, extraBody), model: modelId }),
  };
}

function incomingContentType(req: ExpressRequest): string {
  const value = req.headers["content-type"];
  return typeof value === "string" ? value : "application/json";
}

function readMultipartModel(body: unknown): string | null {
  if (!Buffer.isBuffer(body)) {
    return null;
  }
  const match = /name="model"\r\n\r\n([^\r\n]*)/.exec(body.toString("latin1"));
  return match?.[1] ?? null;
}

function rewriteMultipartModel(body: unknown, modelId: string): Buffer {
  if (!Buffer.isBuffer(body)) {
    return Buffer.alloc(0);
  }
  const text = body.toString("latin1");
  if (!/name="model"\r\n\r\n[^\r\n]*/.test(text)) {
    return body;
  }
  return Buffer.from(text.replace(/(name="model"\r\n\r\n)[^\r\n]*/, `$1${modelId}`), "latin1");
}

/** Keeps one `v1` segment when the base URL already ends with it. */
function joinUpstreamPath(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  if (base.endsWith("/v1") && path.startsWith("/v1/")) {
    return `${base}${path.slice(3)}`;
  }
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
