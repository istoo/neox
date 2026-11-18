import { createRestartRecovery } from "./agent/restart-recovery/index.js";
import { sendPromptToAgent } from "./agent/agent-prompt.js";
import { createIdleRuntimeCleanup } from "./agent/idle-runtime-cleanup/index.js";
import {
  createFinishSubscriptions,
  createFinishObservation,
  createJsonFinishSubscriptionStore,
} from "./agent/finish-subscriptions/index.js";
import { createWorkspaceRuntimeStore } from "./workspace-runtime-store/index.js";
import type { PluginRegistries } from "@neolix/protocol/plugin-registry";
import { describeHookWorkspace } from "./plugins/lifecycle/index.js";
import express from "express";
import { fileURLToPath } from "node:url";
import { createServer as createHTTPServer, type IncomingMessage, type ServerResponse } from "http";
import { constants, existsSync, unlinkSync } from "fs";
import { open, rm, stat } from "fs/promises";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { getHostName } from "./host-name.js";
import { formatListenTarget, parseListenString, type ListenTarget } from "./listen-address.js";
import {
  inheritedListenAddress,
  inheritListener,
  type InheritedListener,
} from "./inherited-listener.js";
export { formatListenTarget, parseListenString, type ListenTarget };
import path from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Logger } from "pino";
import { z } from "zod";
import { createBranchChangeRouteHandler } from "./script-route-branch-handler.js";
import {
  GatewayConfigStore,
  type GatewayAccount,
  type GatewayConfig,
  type GatewayProvider,
} from "./llm-gateway/config.js";
import { CheckinService } from "./llm-gateway/checkin/service.js";
import { GatewayConversations } from "./llm-gateway/conversations.js";
import { Masker } from "./llm-gateway/masking.js";
import { MaskingRecordStore } from "./llm-gateway/masking-records.js";
import { GuardService, localModelOf } from "./privacy/service.js";
import { createGatewayRouter } from "./llm-gateway/routes.js";
import { McpauthService } from "./mcpauth/mcpauth.js";
import { configurePluginSearch } from "./llm-gateway/plugin-search.js";
import {
  observeGatewayUsage,
  setGatewayMiddlewareRunner,
  setGatewayRoutingStrategyRunner,
  setGatewayUsageObserver,
  setPluginUpstreamResolver,
} from "./llm-gateway/plugin-upstream.js";
import { ClaudeBridge } from "./llm-gateway/claude/bridge.js";
import { ClaudeRun } from "./llm-gateway/claude/run.js";
import { ClaudeTuiRun } from "./llm-gateway/claude/tui-run.js";
import { claudeWslLaunch } from "./llm-gateway/claude/wsl.js";
import { defaultClaudeConfigDir } from "./llm-gateway/claude/serve.js";
import { ensureHubGatewayKey } from "./llm-gateway/hub-key.js";
import { BrowserRelay } from "./llm-gateway/browser.js";
import { AffinityStore } from "./llm-gateway/affinity.js";
import { PricingCatalog } from "./llm-gateway/pricing-catalog.js";
import { UsagePoller } from "./llm-gateway/usage-poller.js";
import { QuotaHistoryStore } from "./llm-gateway/quota-history.js";
import { accountKey } from "./llm-gateway/accounts.js";
import { takeAutoIncludedModels } from "./llm-gateway/auto-include.js";
import { refreshAntigravityModels } from "./llm-gateway/antigravity-pool.js";
import { ListRefreshScheduler } from "./llm-gateway/list-refresh.js";
import { fetchProviderModels } from "./llm-gateway/provider-probe.js";
import { RestStore } from "./llm-gateway/rests.js";
import { createGatewayRuntime } from "./llm-gateway/runtime.js";
import { SearchLedger } from "./llm-gateway/search.js";
import { WarmupScheduler } from "./llm-gateway/warmup.js";
import { SignInSwitchScheduler } from "./llm-gateway/sign-in-switch.js";
import { familyOf } from "./llm-gateway/warm-at.js";
import { codexLimitsOf } from "./llm-gateway/codex-limits.js";
import { CodexResetScheduler } from "./llm-gateway/codex-reset-run.js";
import {
  creditsFromReports,
  windowsFromCodexLimits,
  windowsFromReports,
} from "./llm-gateway/warm-windows.js";
import { codexCreditsFirst } from "./llm-gateway/codex-credits.js";
import { UsageLedger } from "./llm-gateway/usage.js";
import {
  exportGatewaySpan,
  OtelMetricsExporter,
  setGatewaySpanBodiesWholeSource,
} from "./llm-gateway/otel.js";
import { OtelSessionsExporter } from "./llm-gateway/otel-sessions.js";
import { ExternalSessionsService } from "./external-sessions/service.js";
import { sessionReadsOf } from "./external-sessions/session-reads.js";
import { readSessionTraceSpans } from "./external-sessions/trace-spans.js";
import { TurnTracker } from "./llm-gateway/turndone.js";
import { VisionService } from "./llm-gateway/vision.js";
import { MediaMcp } from "./llm-gateway/media-mcp.js";
import { GatewayArchive } from "./llm-gateway/gateway-archive.js";
import { RouteHistory } from "./llm-gateway/route-history.js";
import { ResponsesSockets } from "./llm-gateway/responses-ws.js";
import { isGatewayPath } from "./llm-gateway/cors.js";
import { noteConnection } from "./llm-gateway/peer-user.js";
import { networkSettingsOf } from "./network-settings.js";
import { configureRestProbe, disposeRestProbe } from "./llm-gateway/rest-probe.js";
import { configureHeldReports, HeldReportStore } from "./llm-gateway/held-report.js";
import { configureTitleLinks } from "./llm-gateway/title-link.js";
import { codexHomePath } from "./llm-gateway/codex-user-data.js";
import {
  startCodexRelayOnShutdown,
  leaveCodexRelay,
  isCodexGatewayRequest,
} from "./llm-gateway/codex-relay.js";
import { configureWebPage, WebPageServer } from "./web-page.js";

/** The listener the supervisor keeps, when this worker runs under one. */
function inheritedListenerFor(
  httpServer: ReturnType<typeof createHTTPServer>,
): InheritedListener | null {
  const address = inheritedListenAddress();
  return address === null
    ? null
    : inheritListener(httpServer, { listenTarget: parseListenString(address) });
}

function startHttpServerListen(
  httpServer: ReturnType<typeof createHTTPServer>,
  listenTarget: ListenTarget,
  inherited: InheritedListener | null,
): void {
  if (inherited) {
    // The supervisor owns the socket and delivers connections over IPC; the HTTP
    // server here is already the one that handles them, so startup continues as if
    // it had listened itself.
    process.nextTick(() => httpServer.emit("listening"));
    return;
  }
  if (listenTarget.type === "tcp") {
    httpServer.listen(listenTarget.port, listenTarget.host);
    return;
  }
  if (listenTarget.type === "socket" && existsSync(listenTarget.path)) {
    unlinkSync(listenTarget.path);
  }
  httpServer.listen(listenTarget.path);
}

function resolveBoundListenTarget(
  listenTarget: ListenTarget,
  httpServer: ReturnType<typeof createHTTPServer>,
): ListenTarget {
  if (listenTarget.type !== "tcp") {
    return listenTarget;
  }

  const address = httpServer.address();
  if (!address || typeof address === "string") {
    throw new Error("HTTP server did not expose a TCP address after listening");
  }

  return {
    type: "tcp",
    host: listenTarget.host,
    port: address.port,
  };
}

/** Where the daemon actually listens: the supervisor's socket when it owns one. */
function boundListenTargetOf(
  listenTarget: ListenTarget,
  httpServer: ReturnType<typeof createHTTPServer>,
  inherited: InheritedListener | null,
): ListenTarget {
  if (inherited) {
    return inherited.listenTarget;
  }
  return resolveBoundListenTarget(listenTarget, httpServer);
}

export async function fanOutReconciledWorkspaceUpdates(input: {
  sessions: Iterable<{
    syncWorkspaceGitObserversForExternalWorkspaceIds(workspaceIds: Iterable<string>): Promise<void>;
    emitWorkspaceUpdatesForExternalWorkspaceIds(workspaceIds: Iterable<string>): Promise<void>;
  }>;
  workspaceIds: readonly string[];
  logger: Pick<Logger, "warn">;
}): Promise<void> {
  await Promise.all(
    Array.from(input.sessions, async (session) => {
      try {
        await session.syncWorkspaceGitObserversForExternalWorkspaceIds(input.workspaceIds);
      } catch (error) {
        input.logger.warn(
          { err: error },
          "Failed to sync workspace Git observers after reconciliation",
        );
      }
      try {
        await session.emitWorkspaceUpdatesForExternalWorkspaceIds(input.workspaceIds);
      } catch (error) {
        input.logger.warn({ err: error }, "Failed to emit workspace updates after reconciliation");
      }
    }),
  );
}

import { VoiceAssistantWebSocketServer } from "./websocket-server.js";
import { SyncService } from "./sync/service.js";
import { readOtherQuotaReadings } from "./sync/usage.js";
import { WorkspaceSetupRuntime } from "./workspace-setup-runtime.js";
import { createWorkspaceLabelService } from "./workspace-labels/index.js";
import { createGitHubService } from "../services/github-service.js";
import { createNeolixWorktree as createRegisteredNeolixWorktree } from "./neolix-worktree-service.js";
import { createWorkspaceProvisioningService } from "./session/workspace-provisioning/workspace-provisioning-service.js";
import { createNeolixWorktreeWorkflow } from "./worktree-session.js";
import { DownloadTokenStore } from "./file-download/token-store.js";
import { formatAttachmentContentDisposition } from "./file-download/content-disposition.js";
import type { OpenAiSpeechProviderConfig } from "./speech/providers/openai/config.js";
import type { LocalSpeechProviderConfig } from "./speech/providers/local/config.js";
import type { RequestedSpeechProviders } from "./speech/speech-types.js";
import { createSpeechService } from "./speech/speech-runtime.js";
import { createSpeechSettingsOwner } from "./speech/speech-settings.js";
import { AgentManager } from "./agent/agent-manager.js";
import { AgentStorage } from "./agent/agent-storage.js";
import { attachAgentStoragePersistence } from "./persistence-hooks.js";
import { createAgentMcpServer } from "./agent/mcp-server.js";
import {
  createNeolixToolCatalog,
  createNeolixAgentToolManifest,
  type NeolixToolHostDependencies,
} from "./agent/tools/neolix-tools.js";
import type { NeolixToolRuntimeContext } from "./agent/tools/types.js";
import { createAgentProviderRuntime } from "./agent/provider-runtime.js";
import { bootstrapWorkspaceRegistries } from "./workspace-registry-bootstrap.js";
import { WorkspaceReconciliationService } from "./workspace-reconciliation-service.js";
import {
  FileBackedProjectRegistry,
  FileBackedWorkspaceRegistry,
  type WorkspaceArchiveContext,
} from "./workspace-registry.js";
import { CheckoutDiffManager } from "./checkout-diff-manager.js";
import { ScheduleService } from "./schedule/service.js";
import { DaemonConfigStore, type MutableDaemonConfig } from "./daemon-config-store.js";
import { createOrchestrationSkills } from "./orchestration-skills/index.js";
import {
  resolveReloadableConfig,
  type ResolvedDaemonSettings,
  type CliConfigOverrides,
} from "./config.js";
import { resolveNeolixToolPolicy } from "./agent/neolix-tool-policy.js";
import { BrowserToolsBroker } from "./browser-tools/broker.js";
import { DaemonConfigBrowserToolsPolicy } from "./browser-tools/policy.js";
import { WorkspaceGitServiceImpl } from "./workspace-git-service.js";
import { resolveWorkspaceIdForPath } from "./resolve-workspace-id-for-path.js";
import {
  archiveByScope,
  archivePersistedWorkspaceRecord,
  killTerminalsForWorkspace,
  type ActiveWorkspaceRef,
} from "./workspace-archive-service.js";
import { setupAutoArchiveOnMerge } from "./auto-archive-on-merge/index.js";
import { wrapSessionMessage, type SessionOutboundMessage } from "./messages.js";
import type { TerminalManager } from "../terminal/terminal-manager.js";
import { startWorkerTerminalManager } from "../terminal/worker-terminal-manager.js";
import { applyTerminalAgentHookSetting } from "../terminal/agent-hooks/terminal-agent-hook-setting.js";
import { loadOrCreateDaemonKeyPair } from "./daemon-keypair.js";
import { createRelayRuntime, type RelayRuntime } from "./relay-runtime.js";
import { admitSecuredRelaySocket } from "./websocket/secure-relay-ingress.js";
import type { PushNotificationSender } from "./push/index.js";
import { getOrCreateServerId } from "./server-id.js";
import { TelemetryService } from "./telemetry/service.js";
import { resolveDaemonVersion } from "./daemon-version.js";
import type { AgentClient, AgentProvider } from "./agent/agent-sdk-types.js";
import type {
  AgentProfile,
  AgentSkillSelection,
  FirstAgentContext,
  PluginSource,
  TerminalProfile,
} from "@neolix/protocol/messages";
import type {
  AgentProviderRuntimeSettingsMap,
  ProviderOverride,
} from "./agent/provider-launch-config.js";
import { type PersistedConfig } from "./persisted-config.js";
import { createServiceProxySubsystem, type ServiceProxySubsystem } from "./service-proxy.js";
import { releaseWorkspaceServicePortPlan } from "./workspace-service-port-registry.js";
import { ScriptHealthMonitor } from "./script-health-monitor.js";
import { createScriptStatusEmitter } from "./script-status-projection.js";
import { WorkspaceScriptRuntimeStore } from "./workspace-script-runtime-store.js";
import { createWorkspaceScriptsService } from "./session/workspace-scripts/workspace-scripts-service.js";
import { assertWorkspaceAutomationAllowedForWorkspace } from "./workspace-automation-gate.js";
import { spawnWorkspaceScript } from "./worktree-bootstrap.js";
import {
  createManagedProcessRegistry,
  createSystemManagedProcessTable,
  type ManagedProcessRegistry,
} from "./managed-processes/managed-processes.js";
import { terminateWithTreeKill } from "../utils/tree-kill.js";
import { withTimeout } from "../utils/promise-timeout.js";
import { isHostnameAllowed, type HostnamesConfig } from "./hostnames.js";
import {
  createRequireBearerMiddleware,
  isAgentMcpRequestAuthorized,
  type DaemonAuthConfig,
} from "./auth.js";
import { deleteLocalCredential, writeLocalCredential } from "./local-credential.js";
import { daemonAddressForWebApp, WebAppHost, type WebAppPaths } from "./web-app.js";
import { WorkspaceAutoName } from "./workspace-auto-name.js";
import { createGitMutationService } from "./session/git-mutation/git-mutation-service.js";
import { workspaceIdsOnCheckout } from "./workspace-directory.js";
import { configureGitProcessPolicy } from "../utils/run-git-command.js";
import { resolveGitProcessPolicy } from "../utils/git-process-scheduler.js";
import { resolveFirstAgentPromptTitle } from "./agent/create-agent-title.js";
import {
  createAgentCommand,
  type CreateAgentCommandDependencies,
} from "./agent/create-agent/create.js";
import { archiveAgentCommand, cancelAgentRunCommand } from "./agent/lifecycle-command.js";
import { CreateAgentLifecycleDispatch } from "./agent/create-agent-lifecycle-dispatch.js";
import {
  HubRelationshipController,
  type HubRelationshipClock,
  type HubRelationshipRetryPolicy,
} from "./hub/relationship-controller.js";
import {
  DirectHubRelationshipRemote,
  type HubRelationshipRemote,
} from "./hub/relationship-remote.js";
import { DaemonExecutions } from "./hub/daemon-executions.js";
import { PluginService } from "./plugins/index.js";
import { BuiltinPluginLoader } from "./plugins/builtin/index.js";
import { ManagedPluginSources } from "./plugins/managed-source.js";

const MCP_DEBUG_BATCH_LIMIT = 10;
const MCP_DEBUG_SECRET = "[redacted]";
const DOWNLOAD_OPEN_FLAGS =
  process.platform === "win32" ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW;

function formatHostForHttpUrl(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function resolveAgentMcpClientHost(host: string): string {
  if (host === "0.0.0.0") {
    return "127.0.0.1";
  }
  if (host === "::" || host === "[::]") {
    return "::1";
  }
  return host;
}

function createAgentMcpBaseUrl(listenTarget: ListenTarget | null): string | null {
  if (!listenTarget || listenTarget.type !== "tcp") {
    return null;
  }
  const host = resolveAgentMcpClientHost(listenTarget.host);
  return new URL(
    "/mcp/agents",
    `http://${formatHostForHttpUrl(host)}:${listenTarget.port}`,
  ).toString();
}

function createTerminalActivityUrl(listenTarget: ListenTarget | null): string | null {
  if (!listenTarget || listenTarget.type !== "tcp") {
    return null;
  }
  const host = resolveAgentMcpClientHost(listenTarget.host);
  return new URL(
    "/api/terminal-activity",
    `http://${formatHostForHttpUrl(host)}:${listenTarget.port}`,
  ).toString();
}

const TerminalActivityReportSchema = z.object({
  terminalId: z.string().min(1),
  token: z.string().min(1),
  state: z.enum(["running", "idle", "needs-input"]),
});

const TERMINAL_ACTIVITY_STATE_MAP = {
  running: "working",
  idle: "idle",
  "needs-input": "attention",
} as const;

const LOOPBACK_REMOTE_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

function isLoopbackRemoteAddress(remoteAddress: string | undefined): boolean {
  return remoteAddress !== undefined && LOOPBACK_REMOTE_ADDRESSES.has(remoteAddress);
}

export function createTerminalActivityRouteHandler(
  terminalManager: TerminalManager,
): express.RequestHandler {
  return async (req, res) => {
    if (!isLoopbackRemoteAddress(req.socket.remoteAddress)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    const parsed = TerminalActivityReportSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid terminal activity report" });
      return;
    }

    const validation = terminalManager.validateTerminalActivityToken(
      parsed.data.terminalId,
      parsed.data.token,
    );
    if (validation !== "valid") {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    try {
      const updated = await terminalManager.setTerminalActivity(
        parsed.data.terminalId,
        TERMINAL_ACTIVITY_STATE_MAP[parsed.data.state],
      );
      if (!updated) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }
      res.status(204).end();
    } catch {
      res.status(500).json({ error: "Failed to update terminal activity" });
    }
  };
}

function describeMcpRequest(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { shape: value === null ? "null" : typeof value };
  }
  const request = value as Record<string, unknown>;
  return {
    shape: "request",
    ...(typeof request.jsonrpc === "string" ? { jsonrpc: request.jsonrpc } : {}),
    ...(typeof request.method === "string" ? { method: request.method } : {}),
    hasId: "id" in request,
    hasParams: "params" in request,
  };
}

function describeMcpDebugPayload(value: unknown): Record<string, unknown> {
  if (!Array.isArray(value)) return describeMcpRequest(value);
  const sampled = value.slice(0, MCP_DEBUG_BATCH_LIMIT).map(describeMcpRequest);
  return {
    shape: "batch",
    count: value.length,
    sampled,
    ...(sampled.length < value.length ? { skipped: value.length - sampled.length } : {}),
  };
}

export type NeolixOpenAIConfig = OpenAiSpeechProviderConfig;
export type NeolixLocalSpeechConfig = LocalSpeechProviderConfig;

export interface NeolixSpeechSttLanguages {
  dictation: string;
  voice: string;
}

export interface NeolixSpeechConfig {
  providers: RequestedSpeechProviders;
  // Where local models live, whether or not a feature currently uses the local provider.
  localModelsDir: string;
  sttLanguages?: NeolixSpeechSttLanguages;
  local?: NeolixLocalSpeechConfig;
}

export type DaemonLifecycleIntent =
  | {
      type: "shutdown";
      clientId: string;
      requestId: string;
      reason: string;
      keepTerminals: boolean;
    }
  | {
      type: "restart";
      clientId: string;
      requestId: string;
      reason: string;
      keepTerminals: boolean;
    };

export interface NeolixDaemonConfig {
  listen: string;
  neolixHome: string;
  daemonVersion?: string;
  desktopManaged?: boolean;
  worktreesRoot?: string;
  corsAllowedOrigins: string[];
  allowedHosts?: HostnamesConfig;
  hostnames?: HostnamesConfig;
  trustedProxies?: true | string[];
  mcpEnabled?: boolean;
  mcpInjectIntoAgents?: boolean;
  usageEnabled?: boolean;
  /** myna's UsageAlert: the share of a window that notifies when used; 0 is off. */
  usageAlertPercent?: number;
  /** myna's BalanceAlert: the balance that notifies when fallen to; 0 is off. */
  balanceAlert?: number;
  /** The Mac terminal app (bundle id) a resumed session opens in; "" is the system default. */
  sessionTerminal?: string;
  /** Anonymous usage sharing, off unless the user opts in. */
  telemetry?: {
    enabled?: boolean;
    shareUsage?: boolean;
    decidedAt?: string;
  };
  browserToolsEnabled?: boolean;
  git?: {
    maxProcessesPerSecond: number;
    maxProcessConcurrency: number;
  };
  autoArchiveAfterMerge?: boolean;
  enableTerminalAgentHooks?: boolean;
  appendSystemPrompt?: string;
  terminalProfiles?: TerminalProfile[];
  agentProfiles?: AgentProfile[];
  skillSelection?: AgentSkillSelection;
  pluginsEnabled?: boolean;
  plugins?: Record<string, PluginSource>;
  builtinFeatures?: import("@neolix/protocol/plugin-features").BuiltinFeatures;
  builtinFeatureConfig?: import("@neolix/protocol/plugin-features").BuiltinFeatureConfig;
  pluginRegistries?: PluginRegistries;
  pluginRegistryUrl?: string;
  staticDir: string;
  mcpDebug: boolean;
  isDev?: boolean;
  /**
   * Whether quitting leaves a relay for Codex threads still pointed at this
   * daemon's gateway. On unless a caller turns it off; test daemons do.
   */
  codexRelayOnShutdown?: boolean;
  agentClients: Partial<Record<AgentProvider, AgentClient>>;
  agentStoragePath: string;
  relayEnabled?: boolean;
  relayEnabledMutable?: boolean;
  relayRequireProtectedSecurity?: boolean;
  relayEndpoint?: string;
  relayPublicEndpoint?: string;
  relayUseTls?: boolean;
  relayPublicUseTls?: boolean;
  serviceProxy?: {
    publicBaseUrl: string | null;
    standaloneListen: string | null;
  };
  webUi?: {
    enabled: boolean;
    distDir: string | null;
  };
  /** Where the desktop web app served on this port may be built; absent or null leaves it off. */
  webApp?: WebAppPaths[] | null;
  appBaseUrl?: string;
  auth?: DaemonAuthConfig;
  openai?: NeolixOpenAIConfig;
  speech?: NeolixSpeechConfig;
  voiceLlmProvider?: AgentProvider | null;
  voiceLlmProviderExplicit?: boolean;
  voiceLlmModel?: string | null;
  dictationFinalTimeoutMs?: number;
  downloadTokenTtlMs?: number;
  agentProviderSettings?: AgentProviderRuntimeSettingsMap;
  idleRuntimeCleanup?: boolean;
  resumeOnStartup?: boolean;
  resumePrompt?: string;
  providerCatalogRefreshTimeoutMs?: number;
  metadataGeneration?: {
    providers?: Array<{
      provider: string;
      model?: string;
      thinkingOptionId?: string;
    }>;
  };
  providerOverrides?: Record<string, ProviderOverride>;
  log?: PersistedConfig["log"];
  onLifecycleIntent?: (intent: DaemonLifecycleIntent) => void;
  pushNotificationSender?: PushNotificationSender;
  managedProcesses?: ManagedProcessRegistry;
  configReload?: {
    env: NodeJS.ProcessEnv;
    cli?: CliConfigOverrides;
    overrideControlledPaths: string[];
    relayEnabledFallback: boolean;
    startupPersisted: PersistedConfig;
  };
}

export interface NeolixDaemon {
  config: NeolixDaemonConfig;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  terminalManager: TerminalManager;
  serviceProxy: ServiceProxySubsystem;
  scriptRuntimeStore: WorkspaceScriptRuntimeStore;
  browserToolsBroker: BrowserToolsBroker;
  start(): Promise<void>;
  /** Stops the daemon. Terminals keep running for the next daemon only with keepTerminals. */
  stop(options?: { keepTerminals?: boolean }): Promise<void>;
  getListenTarget(): ListenTarget | null;
  getServerId(): string;
}

export interface NeolixDaemonDependencies {
  builtinPlugins?: BuiltinPluginLoader;
  hubRelationshipRemote?: HubRelationshipRemote;
  hubRelationshipClock?: HubRelationshipClock;
  hubRelationshipRetryPolicy?: HubRelationshipRetryPolicy;
  createHubDaemonId?: () => string;
  serverFeatureOverrides?: {
    daemonStatusRpc?: boolean;
    relayConfig?: boolean;
  };
}

const SESSION_BODY_CHARS = 320 * 1024;

/** A transcript's parts as one body; cut before masking to bound masking cost. */
function transcriptPartsText(parts: readonly { text: string }[]): string {
  const out: string[] = [];
  let chars = 0;
  for (const part of parts) {
    if (chars >= SESSION_BODY_CHARS) {
      break;
    }
    out.push(part.text);
    chars += part.text.length + 2;
  }
  return out.join("\n\n").slice(0, SESSION_BODY_CHARS);
}

function resolveBuiltinPluginLoader(dependencies: NeolixDaemonDependencies): BuiltinPluginLoader {
  return dependencies.builtinPlugins ?? new BuiltinPluginLoader();
}

function createBootstrapManagedProcessRegistry(
  config: Pick<NeolixDaemonConfig, "neolixHome" | "managedProcesses">,
  logger: Logger,
): ManagedProcessRegistry {
  if (config.managedProcesses) {
    return config.managedProcesses;
  }

  return createManagedProcessRegistry({
    neolixHome: config.neolixHome,
    processTable: createSystemManagedProcessTable(),
    terminateProcess: terminateWithTreeKill,
    logger,
  });
}

async function reconcileManagedProcessLedger(
  managedProcesses: ManagedProcessRegistry,
  logger: Logger,
): Promise<void> {
  const reapResult = await managedProcesses.reapStale();
  if (reapResult.checked > 0 || reapResult.errors.length > 0) {
    logger.info(reapResult, "Managed helper process ledger reconciled");
  }
}

function resolveExpressTrustProxySetting(config: NeolixDaemonConfig): true | string[] {
  return config.trustedProxies ?? ["loopback"];
}

/** Where this daemon may be reached over TCP, for the browser page's proxy. */
function daemonTcpAddress(target: ListenTarget | null): { host: string; port: number } | null {
  if (target === null || target.type !== "tcp") {
    return null;
  }
  const host = target.host === "0.0.0.0" || target.host === "::" ? "127.0.0.1" : target.host;
  return { host, port: target.port };
}

function createInitialRelayConfig(config: ResolvedDaemonSettings): MutableDaemonConfig["relay"] {
  return {
    enabled: (config.relayEndpoint?.length ?? 0) > 0 && (config.relayEnabled ?? true),
    requireProtectedSecurity: config.relayRequireProtectedSecurity ?? false,
  };
}

function resolveReloadEnv(config: NeolixDaemonConfig): NodeJS.ProcessEnv {
  return config.configReload?.env ?? process.env;
}

function initialNetworkSettings(config: NeolixDaemonConfig): ReturnType<typeof networkSettingsOf> {
  return networkSettingsOf(
    config.listen,
    config.configReload?.startupPersisted?.daemon?.lanKey ?? null,
  );
}

function initialMcpConfig(config: ResolvedDaemonSettings): MutableDaemonConfig["mcp"] {
  return {
    enabled: config.mcpEnabled ?? true,
    injectIntoAgents: config.mcpInjectIntoAgents ?? true,
  };
}

/** The alert thresholds a host has saved, when it has them. */
function alertThresholds(
  config: ResolvedDaemonSettings,
): Pick<MutableDaemonConfig, "usageAlertPercent" | "balanceAlert"> {
  return {
    ...(config.usageAlertPercent === undefined
      ? {}
      : { usageAlertPercent: config.usageAlertPercent }),
    ...(config.balanceAlert === undefined ? {} : { balanceAlert: config.balanceAlert }),
  };
}

function telemetrySetting(config: ResolvedDaemonSettings): Pick<MutableDaemonConfig, "telemetry"> {
  return config.telemetry === undefined ? {} : { telemetry: config.telemetry };
}

function createInitialMutableDaemonConfig(
  config: ResolvedDaemonSettings,
  network?: ReturnType<typeof networkSettingsOf>,
): MutableDaemonConfig {
  const providers = config.providerOverrides ?? {};

  const initialConfig: MutableDaemonConfig = {
    relay: createInitialRelayConfig(config),
    mcp: initialMcpConfig(config),
    ...(config.hostnames !== undefined ? { hostnames: config.hostnames } : {}),
    cors: { allowedOrigins: config.corsAllowedOrigins },
    // Where this process listens and how it was configured to, for
    // Settings › Network; a change is bound at the next start.
    ...(network === undefined
      ? {}
      : {
          network: {
            listen: network.listen,
            port: network.port,
            lan: network.lan,
            lanKey: network.lanKey,
            lanUrls: network.lanUrls,
          },
        }),
    trustedProxies: config.trustedProxies ?? ["loopback"],
    git: config.git ?? resolveGitProcessPolicy({ env: process.env }),
    app: { baseUrl: config.appBaseUrl ?? "" },
    ...(config.providerCatalogRefreshTimeoutMs !== undefined
      ? { catalogRefreshTimeoutMs: config.providerCatalogRefreshTimeoutMs }
      : {}),
    usage: { enabled: config.usageEnabled !== false },
    ...telemetrySetting(config),
    ...alertThresholds(config),
    sessionTerminal: config.sessionTerminal ?? "",
    browserTools: { enabled: config.browserToolsEnabled ?? false },
    providers,
    metadataGeneration: { providers: config.metadataGeneration?.providers ?? [] },
    autoArchiveAfterMerge: config.autoArchiveAfterMerge ?? false,
    enableTerminalAgentHooks: config.enableTerminalAgentHooks ?? false,
    idleRuntimeCleanup: config.idleRuntimeCleanup !== false,
    resumeOnStartup: config.resumeOnStartup === true,
    resumePrompt: config.resumePrompt ?? "Resume working.",
    appendSystemPrompt: config.appendSystemPrompt ?? "",
    pluginsEnabled: config.pluginsEnabled ?? false,
    plugins: config.plugins ?? {},
    builtinFeatures: config.builtinFeatures,
    builtinFeatureConfig: config.builtinFeatureConfig,
    skills: { selection: config.skillSelection },
  };

  if (config.terminalProfiles !== undefined) {
    initialConfig.terminalProfiles = config.terminalProfiles;
  }

  if (config.agentProfiles !== undefined) {
    initialConfig.agentProfiles = config.agentProfiles;
  }

  return initialConfig;
}

export async function createNeolixDaemon(
  config: NeolixDaemonConfig,
  rootLogger: Logger,
  dependencies: NeolixDaemonDependencies = {},
): Promise<NeolixDaemon> {
  configureGitProcessPolicy(config.git ?? resolveGitProcessPolicy({ env: process.env }));
  const logger = rootLogger.child({ module: "bootstrap" });
  const obsoleteTimelineDirectory = path.join(config.neolixHome, "agent-timelines");
  await rm(obsoleteTimelineDirectory, { recursive: true, force: true }).catch((error) => {
    logger.warn(
      { err: error, path: obsoleteTimelineDirectory },
      "Failed to remove obsolete agent timeline data",
    );
  });
  const bootstrapStart = performance.now();
  const elapsed = () => `${(performance.now() - bootstrapStart).toFixed(0)}ms`;
  const daemonVersion = config.daemonVersion ?? resolveDaemonVersion(import.meta.url);
  const initialNetwork = initialNetworkSettings(config);
  const initialMutableConfig = createInitialMutableDaemonConfig(config, initialNetwork);
  const speechService = createSpeechService({
    logger,
    openaiConfig: config.openai,
    speechConfig: config.speech,
  });
  logger.info({ elapsed: elapsed() }, "Speech service created");
  const daemonConfigStore = new DaemonConfigStore(config.neolixHome, initialMutableConfig, logger, {
    relayEnabledMutable: config.relayEnabledMutable ?? true,
    startupPersisted: config.configReload?.startupPersisted,
    speech: createSpeechSettingsOwner({
      neolixHome: config.neolixHome,
      env: resolveReloadEnv(config),
      speechService,
    }),
    reloadSource: {
      resolve: (persisted) => {
        const reloaded = resolveReloadableConfig(persisted, {
          env: resolveReloadEnv(config),
          cli: config.configReload?.cli,
          relayEnabledFallback: config.configReload?.relayEnabledFallback,
        });
        return {
          mutable: createInitialMutableDaemonConfig(reloaded, initialNetwork),
          overrideControlledPaths: reloaded.overrideControlledPaths,
        };
      },
    },
  });
  const orchestrationSkills = createOrchestrationSkills(daemonConfigStore);
  void orchestrationSkills.autoUpdate().catch((error) => {
    logger.error({ err: error }, "Failed to maintain orchestration skills at startup");
  });
  const browserToolsPolicy = new DaemonConfigBrowserToolsPolicy(daemonConfigStore);
  const browserToolsBroker = new BrowserToolsBroker({});
  const pluginRuntime: PluginService = new PluginService(logger, daemonConfigStore, daemonVersion, {
    usageAgents: {
      hasAgent: (id) => agentManager.getAgent(id) !== null,
      usageSession: (id) => agentManager.usageSession(id),
    },
    managedSources: new ManagedPluginSources(config.neolixHome, {
      registries: config.pluginRegistries,
      defaultUrl: config.pluginRegistryUrl,
    }),
    market: {
      baseUrl: config.pluginRegistryUrl,
      registries: config.pluginRegistries,
    },
    builtinPlugins: resolveBuiltinPluginLoader(dependencies),
    settingsDirectory: path.join(config.neolixHome, "plugin-settings"),
  });
  configurePluginSearch({
    list: () => pluginRuntime.listSearchApis(),
    run: (vendor, input) => pluginRuntime.executeSearchApi(vendor, input),
  });
  const releasePluginUpstream = setPluginUpstreamResolver({
    load: (input) =>
      pluginRuntime.loadSubscription(input.pluginId, input.providerId, {
        accountId: input.accountId,
        model: input.model,
        body: input.body,
        headers: input.headers,
      }),
    request: (input) => pluginRuntime.proxySubscription(input.pluginId, input.providerId, input),
  });
  const releaseGatewayMiddleware = setGatewayMiddlewareRunner({
    active: () => pluginRuntime.hasGatewayMiddlewares(),
    hasHook: (hook) => pluginRuntime.hasGatewayMiddlewareHook(hook),
    request: (input) => pluginRuntime.runGatewayMiddlewareRequest(input) ?? Promise.resolve(null),
    response: (input) => pluginRuntime.runGatewayMiddlewareResponse(input) ?? Promise.resolve(null),
    provider: (input) => pluginRuntime.runGatewayMiddlewareProvider(input) ?? Promise.resolve(null),
    account: (input) => pluginRuntime.runGatewayMiddlewareAccount(input) ?? Promise.resolve(false),
    event: (input) => pluginRuntime.runGatewayMiddlewareEvent(input) ?? Promise.resolve(null),
    headers: (input) => pluginRuntime.runGatewayMiddlewareHeaders(input) ?? Promise.resolve(null),
  });
  const releaseGatewayUsageObserver = setGatewayUsageObserver({
    observe: (row) => pluginRuntime.observeGatewayUsage(row),
  });
  const releaseGatewayStrategy = setGatewayRoutingStrategyRunner({
    order: (name, strategyInput) => pluginRuntime.runRoutingStrategy(name, strategyInput),
  });

  const serverId = getOrCreateServerId(config.neolixHome, { logger });
  const daemonKeyPair = await loadOrCreateDaemonKeyPair(config.neolixHome, logger);
  const managedProcesses = createBootstrapManagedProcessRegistry(config, logger);
  // Reconcile the helper-process ledger in the background so it never blocks the
  // daemon from coming up; terminating a live leftover can take a few seconds.
  // Best-effort, so a failure is logged here rather than crashing startup.
  void reconcileManagedProcessLedger(managedProcesses, logger).catch((error) => {
    logger.warn({ err: error }, "Failed to reconcile managed helper process ledger");
  });
  let relayRuntime: RelayRuntime | null = null;
  let syncService: SyncService | null = null;

  const staticDir = config.staticDir;
  const downloadTokenTtlMs = config.downloadTokenTtlMs ?? 60000;

  const downloadTokenStore = new DownloadTokenStore({
    ttlMs: downloadTokenTtlMs,
  });

  // Capability token authenticating the daemon's own agents to the loopback
  // Agent MCP endpoint (/mcp/agents). Random per daemon run, injected only into
  // local agent configs and the daemon's own MCP client — never sent to remote
  // clients — so it cannot be replayed off-box. This lets the injected MCP
  // authenticate even when the daemon password is set via the app (hash only,
  // no plaintext available). Mirrors the /api/files/download capability-token
  // pattern.
  const agentMcpAuthToken = randomUUID();

  const listenTarget = parseListenString(config.listen);

  const app = express();
  app.set("trust proxy", resolveExpressTrustProxySetting(config));
  daemonConfigStore.onFieldChange("trustedProxies", (value) => {
    app.set("trust proxy", value ?? ["loopback"]);
  });
  let boundListenTarget: ListenTarget | null = null;
  let webPage: WebPageServer | null = null;
  let workspaceRegistry: FileBackedWorkspaceRegistry | null = null;
  const terminalManager = await startWorkerTerminalManager({
    neolixHome: config.neolixHome,
    neolixVersion: daemonVersion,
    logger,
    getTerminalActivityUrl: () => createTerminalActivityUrl(boundListenTarget),
  });
  applyTerminalAgentHookSetting({ store: daemonConfigStore, logger });

  const serviceProxyPublicBaseUrl = config.serviceProxy?.publicBaseUrl
    ? config.serviceProxy.publicBaseUrl
    : null;
  const serviceProxy = createServiceProxySubsystem({
    logger,
    publicBaseUrl: serviceProxyPublicBaseUrl,
  });
  const scriptRuntimeStore = new WorkspaceScriptRuntimeStore();
  const workspaceSetupRuntime = new WorkspaceSetupRuntime();
  let configuredHostnames = config.hostnames ?? config.allowedHosts;
  let appBaseUrl = config.appBaseUrl ?? "";
  daemonConfigStore.onFieldChange("hostnames", (value) => {
    configuredHostnames = value as HostnamesConfig | undefined;
  });
  daemonConfigStore.onFieldChange("app.baseUrl", (value) => {
    appBaseUrl = typeof value === "string" ? value : "";
  });
  let wsServer: VoiceAssistantWebSocketServer | null = null;
  let serviceProxyListenTarget: ListenTarget | null = null;
  const scriptHealthMonitor = new ScriptHealthMonitor({
    serviceProxy,
    onChange: createScriptStatusEmitter({
      sessions: () =>
        wsServer?.listSessions().map((session) => ({
          emit: (message) => session.emitServerMessage(message),
        })) ?? [],
      serviceProxy,
      runtimeStore: scriptRuntimeStore,
      daemonPort: () => (boundListenTarget?.type === "tcp" ? boundListenTarget.port : null),
      resolveWorkspaceDirectory: async (workspaceId) =>
        (await workspaceRegistry?.get(workspaceId))?.cwd ?? null,
      logger,
      serviceProxyPublicBaseUrl,
    }),
  });
  const handleBranchChange = createBranchChangeRouteHandler({
    serviceProxy,
    onRoutesChanged: (workspaceId) => {
      scriptHealthMonitor.invalidateWorkspace(workspaceId);
    },
    logger,
  });

  // Service proxy classifies service hosts before daemon auth/route fallthrough.
  // Registered service hosts proxy directly; known service namespaces without a
  // route return 404 and never reach daemon APIs.
  app.use(serviceProxy.middleware());

  // Host allowlist / DNS rebinding protection (vite-like semantics).
  // For non-TCP (unix sockets), skip host validation.
  if (listenTarget.type === "tcp") {
    app.use((req, res, next) => {
      const hostHeader = typeof req.headers.host === "string" ? req.headers.host : undefined;
      if (!isHostnameAllowed(hostHeader, configuredHostnames)) {
        res.status(403).json({ error: "Invalid Host header" });
        return;
      }
      next();
    });
  }

  // CORS - allow same-origin + configured origins
  const fixedAllowedOrigins =
    // For TCP, add localhost variants.
    listenTarget.type === "tcp"
      ? [
          `http://${listenTarget.host}:${listenTarget.port}`,
          `http://localhost:${listenTarget.port}`,
          `http://127.0.0.1:${listenTarget.port}`,
        ]
      : [];
  const allowedOrigins = new Set([...config.corsAllowedOrigins, ...fixedAllowedOrigins]);
  daemonConfigStore.onFieldChange("cors.allowedOrigins", (value) => {
    allowedOrigins.clear();
    for (const origin of [...((value as string[] | undefined) ?? []), ...fixedAllowedOrigins]) {
      allowedOrigins.add(origin);
    }
  });

  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && (allowedOrigins.has("*") || allowedOrigins.has(origin))) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
      res.setHeader("Access-Control-Allow-Credentials", "true");
    }
    if (req.method === "OPTIONS") {
      // The gateway answers its own preflights: a page listed in gateway.json
      // gets its headers there, and no other page gets this blanket answer.
      if (isGatewayPath(req.path)) {
        next();
        return;
      }
      res.status(204).end();
      return;
    }
    next();
  });

  // Local, harmless, and token-gated; deliberately skips daemon auth.
  app.post(
    "/api/terminal-activity",
    express.json(),
    createTerminalActivityRouteHandler(terminalManager),
  );

  // Model gateway: loopback agents point their provider base URLs here. It
  // authenticates itself with the gateway config's keys (or loopback), so it
  // mounts before daemon bearer auth like the terminal-activity route. The web
  // UI middleware below answers every GET it doesn't own with a 404, so the
  // gateway mounts first.
  const gatewayConfigStore = new GatewayConfigStore({ neolixHome: config.neolixHome, logger });
  await gatewayConfigStore.start();
  // myna's settings.OTel.BodiesWhole: full content in traces instead of 256 KiB cuts.
  setGatewaySpanBodiesWholeSource(() => gatewayConfigStore.get().otel?.bodiesWhole === true);
  // Settings → Masking's local model (AstrLink Guard). Nothing is
  // downloaded at start: the settings page's Download button is the only
  // call that fetches it.
  const gatewayMaskingLocalModel = new GuardService({
    neolixHome: config.neolixHome,
    logger,
    score: () => gatewayConfigStore.get().masking?.modelScore ?? 0.8,
  });
  const gatewayMasker = new Masker({
    neolixHome: config.neolixHome,
    logger,
    allow: () => gatewayConfigStore.get().masking?.allow ?? [],
    categories: () => gatewayConfigStore.get().masking?.categories ?? [],
    actions: () => gatewayConfigStore.get().masking?.actions ?? {},
    shape: () => gatewayConfigStore.get().masking?.shape === true,
    categorySwitches: () => gatewayConfigStore.get().masking?.categorySwitches ?? {},
    secrets: () => gatewayConfigStore.get().masking?.enabled === true,
    personal: () => gatewayConfigStore.get().masking?.personal === true,
    words: () => gatewayConfigStore.get().masking?.words ?? [],
    wordsAnyCase: () => gatewayConfigStore.get().masking?.wordsAnyCase === true,
    wordsWhole: () => gatewayConfigStore.get().masking?.wordsWhole === true,
    rules: () => gatewayConfigStore.get().masking?.rules ?? [],
    localModel: () =>
      gatewayConfigStore.get().masking?.model === "astrlink-guard"
        ? localModelOf(gatewayMaskingLocalModel)
        : null,
    localModelScore: () => gatewayConfigStore.get().masking?.modelScore,
  });
  await gatewayMasker.ensureKey();
  // myna's daily check-ins: WorkBuddy and MiniMax Code for now, from the
  // sign-ins myna's plugin left in plugin-auth.json. Its loop asks two minutes
  // after start and every minute after; each vendor's switch in gateway.json
  // decides whether it is on, as myna's settings do.
  const gatewayCheckin = new CheckinService({
    neolixHome: config.neolixHome,
    config: gatewayConfigStore,
    plugins: {
      providers: () =>
        pluginRuntime
          .listSubscriptionProviders()
          .filter((provider) => provider.checkin === true)
          .map((provider) => ({
            pluginId: provider.pluginId,
            id: provider.id,
            label: provider.label,
          })),
      checkin: (input) =>
        pluginRuntime.subscriptionCheckin(input.pluginId, input.providerId, input.accountId),
    },
    onError: (error) => logger.warn({ err: error }, "Daily check-in failed"),
  });
  gatewayCheckin.startScheduler();
  const gatewayConversations = new GatewayConversations({
    neolixHome: config.neolixHome,
    configStore: gatewayConfigStore,
    logger,
    scrub: (text) => gatewayMasker.maskText(text),
  });
  const gatewayMaskingRecords = new MaskingRecordStore({
    neolixHome: config.neolixHome,
    logger,
  });
  await gatewayMaskingRecords.start();
  const gatewayLedger = new UsageLedger({ neolixHome: config.neolixHome, logger });
  await gatewayLedger.start();
  const gatewayOtelMetrics = new OtelMetricsExporter({
    config: () => gatewayConfigStore.get().otel,
  });
  gatewayOtelMetrics.start();
  // myna traces the agents' local conversations too, including calls that
  // never went through the gateway (settings.OTel.Sessions, off unless on).
  const gatewaySessionsForOtel = new ExternalSessionsService({
    neolixHome: config.neolixHome,
    reads: () => sessionReadsOf(gatewayConfigStore.get()),
  });
  const gatewayOtelSessions = new OtelSessionsExporter({
    config: () => gatewayConfigStore.get().otel,
    load: () => gatewaySessionsForOtel.listAll(),
    bodies: async (session) => {
      const transcript = await gatewaySessionsForOtel.transcript({
        agent: session.agent,
        id: session.id,
        limit: 500,
      });
      return {
        input: transcriptPartsText(transcript.parts.filter((part) => part.role === "user")),
        output: transcriptPartsText(transcript.parts.filter((part) => part.role !== "user")),
      };
    },
    mask: (text) => gatewayMasker.maskText(text),
    trace: (session, bodies) =>
      readSessionTraceSpans({
        agent: session.agent,
        session: session.id,
        path: session.path,
        bodies,
      }),
  });
  gatewayOtelSessions.start();
  gatewayLedger.onRecord = (record) => {
    exportGatewaySpan(gatewayConfigStore.get().otel, record);
    gatewayOtelMetrics.add(record);
    observeGatewayUsage({ ...record });
  };
  const gatewayAffinity = new AffinityStore({ neolixHome: config.neolixHome, logger });
  const stickyBindings = await gatewayAffinity.load(Date.now());
  const gatewayRests = new RestStore({ neolixHome: config.neolixHome, logger });
  const gatewayPricing = new PricingCatalog({ neolixHome: config.neolixHome, logger });
  await gatewayPricing.start(Date.now());
  // A rest kept for a key gateway.json no longer has is let go, as myna does.
  const configuredProviders = new Set(
    gatewayConfigStore.get().providers.map((provider) => provider.id),
  );
  const savedRests = new Map(
    [...(await gatewayRests.load(Date.now()))].filter(([key]) =>
      configuredProviders.has(key.split("/")[0] ?? ""),
    ),
  );
  const restMap = new Map(savedRests);
  const creditLevels = new Map([...savedRests].map(([key, rest]) => [key, rest.level]));
  const runtimeHolder: { current?: ReturnType<typeof createGatewayRuntime> } = {};
  const gatewayRuntime = createGatewayRuntime(gatewayLedger, {
    sticky: stickyBindings,
    creditLevels,
    onStickyChange: () => {
      if (runtimeHolder.current !== undefined) {
        gatewayAffinity.scheduleSave(runtimeHolder.current.routingState.sticky);
      }
    },
    onRestChange: (rest) => {
      restMap.set(rest.key, rest);
      gatewayRests.scheduleSave(restMap);
    },
    onRestCleared: (key) => {
      restMap.delete(key);
      gatewayRests.scheduleSave(restMap);
    },
    pricing: gatewayPricing,
  });
  runtimeHolder.current = gatewayRuntime;
  // A key resting after an outage is asked its vendor's model list in the
  // background, and let go as soon as it answers (myna's rest_probe.go).
  configureHeldReports(new HeldReportStore(config.neolixHome, logger));
  // Title turns are tied to the chat whose title they wrote, by fingerprints
  // kept here and Codex's own name index (myna's title_link.go).
  await configureTitleLinks({ neolixHome: config.neolixHome, codexHome: codexHomePath() });
  configureRestProbe({
    rest: gatewayRuntime.routingState.rest,
    logger,
    onCleared: (key) => {
      restMap.delete(key);
      gatewayRests.scheduleSave(restMap);
    },
  });
  const gatewayQuotaHistory = new QuotaHistoryStore({
    neolixHome: config.neolixHome,
    logger,
    // The usage sync's other computers' readings join this one's at read
    // time; the gateway's file stays its own append log.
    sharedHistory: (since, filter) => readOtherQuotaReadings(config.neolixHome, since, filter),
  });
  await gatewayQuotaHistory.start();
  const usagePoller = new UsagePoller({
    state: gatewayRuntime.accountState,
    providers: () => gatewayConfigStore.get().providers,
    logger,
    gatewayDir: path.join(config.neolixHome, "gateway"),
    onReading: (provider, account, reading) => {
      gatewayQuotaHistory.record(provider.id, account.id, reading);
    },
    // myna's quotaReads: "asked" leaves the timer quiet until the user asks.
    readsAsked: () => gatewayConfigStore.get().quotaReads === "asked",
  });
  usagePoller.start();
  const gatewaySearch = new SearchLedger({ neolixHome: config.neolixHome, logger });
  await gatewaySearch.start();
  const gatewayVision = new VisionService({
    neolixHome: config.neolixHome,
    logger,
  });
  await gatewayVision.start();
  const gatewayMedia = new MediaMcp({ logger });
  const gatewayArchive = new GatewayArchive({ neolixHome: config.neolixHome, logger });
  const gatewayHistory = new RouteHistory({ neolixHome: config.neolixHome, logger });
  await gatewayHistory.start();
  // The warm-up reads each subscription account's windows through the same
  // usage sources the app's meters use. One read serves every account in a
  // tick: the registry caches its fetches for five minutes, but its account
  // discovery reads the stores each call.
  let warmupReports: Awaited<ReturnType<typeof pluginRuntime.listUsageReports>> | null = null;
  let warmupReportsAt = 0;
  const reportsForWarmup = async () => {
    const now = Date.now();
    if (warmupReports === null || now - warmupReportsAt >= 60_000) {
      warmupReports = await pluginRuntime.listUsageReports();
      warmupReportsAt = now;
    }
    return warmupReports;
  };
  const gatewayWarmup = new WarmupScheduler({
    providers: () => gatewayConfigStore.get().providers,
    config: () => gatewayConfigStore.get(),
    windows: async (provider, account) => {
      const family = familyOf(provider);
      if (family === null) {
        return undefined;
      }
      // A Codex account in Neolix's own ChatGPT store is read where the
      // gateway keeps what its backend last said: no usage store and no
      // label match needed (routes.ts notes it by the same store id).
      if (family === "codex" && account.codexAccountId !== undefined) {
        const limits = windowsFromCodexLimits(codexLimitsOf(account.codexAccountId));
        if (limits !== undefined) {
          return limits;
        }
      }
      try {
        return windowsFromReports(await reportsForWarmup(), family, account);
      } catch (error) {
        logger.debug({ err: error, provider: provider.id }, "Cannot read usage for the warm-up");
        return undefined;
      }
    },
    logger,
  });
  gatewayWarmup.start();
  /** The gateway account that spends a saved Codex or Claude sign-in. */
  const signInGatewayAccount = (
    current: GatewayConfig,
    id: string,
    user: string,
  ): { provider: GatewayProvider; account: GatewayAccount } | undefined => {
    for (const provider of current.providers) {
      const account =
        provider.accounts.find((entry) => entry.codexAccountId === id) ??
        provider.accounts.find(
          (entry) =>
            entry.agent === "claude-code" &&
            (entry.subscriptionUser ?? "").toLowerCase() === user.toLowerCase(),
        );
      if (account !== undefined) {
        return { provider, account };
      }
    }
    return undefined;
  };
  /** Whether `codex app-server daemon` exists here, once probed; null until then. */
  const codexDaemonRestart: { probed: boolean | null } = { probed: null };
  const restartCodexDaemon = (): void => {
    execFile("codex", ["app-server", "daemon", "restart"], (error) => {
      if (error !== null) {
        logger.debug({ err: error }, "Cannot restart the Codex app-server after a sign-in switch");
      }
    });
  };
  // myna's KeepOnAnAccountWithRoom: with SwitchOnly and the agent's
  // automatic switch on, Codex's and Claude Code's own sign-ins move to the
  // next account with room; the look is every five minutes, every minute
  // while the account signed in to is near out (`codex_switch.go:52-86`).
  const gatewaySignInSwitch = new SignInSwitchScheduler({
    config: () => gatewayConfigStore.get(),
    gatewayDir: path.join(config.neolixHome, "gateway"),
    logger,
    windowsOf: async (agent, account) => {
      if (agent === "codex") {
        const limits = windowsFromCodexLimits(codexLimitsOf(account.id));
        if (limits !== undefined) {
          return limits.flatMap((window) =>
            window.usedPct === null
              ? []
              : [{ usedPercent: window.usedPct, resetAt: window.resetsAt, name: window.id }],
          );
        }
      }
      try {
        const windows = windowsFromReports(await reportsForWarmup(), agent, {
          id: account.id,
          label: account.user,
        });
        return windows?.flatMap((window) =>
          window.usedPct === null
            ? []
            : [{ usedPercent: window.usedPct, resetAt: window.resetsAt, name: window.id }],
        );
      } catch (error) {
        logger.debug({ err: error, agent }, "Cannot read usage for the sign-in switch");
        return undefined;
      }
    },
    capsOf: (id, user) => {
      const found = signInGatewayAccount(gatewayConfigStore.get(), id, user);
      return found === undefined
        ? undefined
        : { all: found.account.capPercent, windows: found.account.capWindows };
    },
    creditsFirstOf: (id, user) => {
      const found = signInGatewayAccount(gatewayConfigStore.get(), id, user);
      return found !== undefined && found.provider.id === "codex"
        ? codexCreditsFirst(found.account)
        : false;
    },
    creditsOf: async (agent, account) => {
      try {
        return creditsFromReports(await reportsForWarmup(), agent, {
          id: account.id,
          label: account.user,
        });
      } catch (error) {
        logger.debug({ err: error, agent }, "Cannot read the account's credits");
        return undefined;
      }
    },
    restingOf: (id, user) => {
      const found = signInGatewayAccount(gatewayConfigStore.get(), id, user);
      return (
        found !== undefined &&
        gatewayRuntime.routingState.rest.isResting(
          accountKey(found.provider, found.account),
          Date.now(),
        )
      );
    },
    restartCodexApp: ({ spent }: { spent: boolean }) => {
      if (!spent) {
        return;
      }
      // myna restarts the Codex app-server off a spent account either way,
      // because the app greys Send there. Neolix may have no Codex desktop
      // app, so the subcommand is probed first: an older CLI without it is
      // left alone, and Neolix's own agents (each starts its own app-server)
      // are not affected either way.
      if (codexDaemonRestart.probed === false) {
        return;
      }
      if (codexDaemonRestart.probed === true) {
        restartCodexDaemon();
        return;
      }
      execFile("codex", ["app-server", "daemon", "--help"], (probeError) => {
        codexDaemonRestart.probed = probeError === null;
        if (probeError !== null) {
          logger.debug(
            { err: probeError },
            "Codex has no app-server daemon to restart after a sign-in switch",
          );
          return;
        }
        restartCodexDaemon();
      });
    },
  });
  gatewaySignInSwitch.start();
  // Cap windows read the same windows the warm-up reads: a subscription
  // account's 5-hour and weekly shares are kept on its usage reading, where
  // routing's `capWindows` looks. A reading an account's own usage endpoint
  // wrote last stands: that endpoint knows the account better.
  const bridgeAccountWindows = async () => {
    // Only a subscription provider has these windows; a host with none
    // doesn't wake the usage sources at all.
    const providers = gatewayConfigStore
      .get()
      .providers.filter(
        (provider) =>
          familyOf(provider) !== null && provider.accounts.some((entry) => entry.enabled),
      );
    if (providers.length === 0) {
      return;
    }
    let reports: Awaited<ReturnType<typeof reportsForWarmup>>;
    try {
      reports = await reportsForWarmup();
    } catch (error) {
      logger.debug({ err: error }, "Cannot read the usage windows for the cap windows");
      return;
    }
    const now = Date.now();
    for (const provider of providers) {
      const family = familyOf(provider);
      if (family === null) {
        continue;
      }
      for (const account of provider.accounts) {
        if (!account.enabled) {
          continue;
        }
        const windows = windowsFromReports(reports, family, account);
        if (windows === undefined) {
          continue;
        }
        const key = accountKey(provider, account);
        const previous = gatewayRuntime.accountState.usage.get(key);
        if (
          previous !== undefined &&
          previous.windows !== undefined &&
          now - previous.readAt < 5 * 60_000
        ) {
          continue;
        }
        gatewayRuntime.accountState.usage.set(key, {
          remaining: previous?.remaining ?? null,
          limit: previous?.limit ?? null,
          usedPercent: previous?.usedPercent ?? null,
          resetAt: previous?.resetAt ?? null,
          readAt: now,
          windows: windows.map((window) => ({
            key: window.id,
            usedPercent: window.usedPct,
            resetsAt: window.resetsAt,
          })),
        });
      }
    }
  };
  const gatewayWindowBridge = setInterval(() => {
    void bridgeAccountWindows();
  }, 60_000);
  gatewayWindowBridge.unref();
  void bridgeAccountWindows();
  // A provider that sets refreshEveryMs is asked for its list on that
  // schedule, and the models its AutoInclude rules newly match join what it
  // serves (myna's KeepListsFresh).
  const gatewayListRefresh = new ListRefreshScheduler({
    providers: () => gatewayConfigStore.get().providers,
    fetchModels: (provider) =>
      fetchProviderModels({
        protocol: provider.protocol,
        baseUrl: provider.baseUrl,
        ...(provider.apiKey === undefined ? {} : { apiKey: provider.apiKey }),
        ...(provider.headers === undefined ? {} : { headers: provider.headers }),
        ...(provider.insecureTls === true ? { insecureTls: true } : {}),
        ...(provider.modelsUrl === undefined ? {} : { modelsUrl: provider.modelsUrl }),
      }),
    take: (providerId, listed) => takeAutoIncludedModels(gatewayConfigStore, providerId, listed),
    logger,
  });
  gatewayListRefresh.start();
  // `neolix sync` asks the same scheduler, so an explicit refresh shares the
  // retry guard a scheduled one would wait on (myna's RefreshLists).
  gatewayRuntime.listRefresh = gatewayListRefresh;
  // Antigravity's models are listed per signed-in account and pooled
  // (`antigravity_pool.go`): the pool is refreshed on the same slow beat and
  // written into the providers signed in to it, so /v1/models and every
  // model list serve the union.
  const refreshAntigravityPool = (): void => {
    void refreshAntigravityModels({
      store: gatewayConfigStore,
      gatewayDir: path.join(config.neolixHome, "gateway"),
      logger,
    }).catch((error: unknown) => {
      logger.warn({ err: error }, "Cannot refresh Antigravity's pooled models");
    });
  };
  const gatewayAntigravityModels = setInterval(refreshAntigravityPool, 10 * 60_000);
  gatewayAntigravityModels.unref();
  refreshAntigravityPool();
  // myna's KeepResetsFromRunningOut: a Codex reset about to run out unused
  // is spent for the accounts that let it be, at the time codex-reset.ts
  // decides. A used-up week's one is spent from the routing path, where
  // "every candidate is out" is known.
  const gatewayCodexResets = new CodexResetScheduler({
    providers: () => gatewayConfigStore.get().providers,
    config: () => gatewayConfigStore.get(),
    accountsFile: () => path.join(config.neolixHome, "gateway", "codex-accounts.json"),
    // A rest that outlasts the reset's lead is why it is spent at once;
    // the table holds both this run's rests and the ones loaded at boot.
    restUntil: (key, now) => gatewayRuntime.routingState.rest.until(key, now),
    logger,
  });
  const gatewayBrowser = new BrowserRelay({ logger });
  // Turns are timed here, in the gateway, because only it sees a turn's
  // requests; the websocket server forwards each end to the app.
  const gatewayTurnTracker = new TurnTracker({
    thresholdSeconds: () => gatewayConfigStore.get().turnDoneSeconds ?? 0,
  });
  const restoredAt = Date.now();
  for (const [key, rest] of savedRests) {
    gatewayRuntime.routingState.rest.rest(key, rest.until - restoredAt, restoredAt);
  }
  // Started after the saved rests are back in the table, so the first look
  // already sees an account held up past its reset.
  gatewayCodexResets.start();
  // The Claude subscription bridge: a real Claude Code per conversation. Its
  // MCP helper calls back on the daemon's own TCP address, known only once the
  // server listens, so the URL is read at call time.
  const claudeBridge = new ClaudeBridge({
    runsMost: () => gatewayConfigStore.get().claudeRunsMost,
    // A Claude Code installed only in a WSL distro runs there, its paths
    // and config folder spelt as the distro spells them.
    prepareLaunch: (launch) => claudeWslLaunch(launch),
    // `claudePrintMode` off is myna's default: the interactive mode, told on
    // as `-p`'s stream-json.
    createRun: (options, input, dirs) => {
      if (input.tui === undefined) {
        return new ClaudeRun(options);
      }
      return new ClaudeTuiRun({
        ...options,
        sessionDirs: dirs,
        listedFile: input.tui.listedFile,
        ...(input.tui.readyTimeoutMs === undefined
          ? {}
          : { readyTimeoutMs: input.tui.readyTimeoutMs }),
        ...(input.tui.trust === undefined ? {} : { trust: input.tui.trust }),
        ...(input.tui.waitMs === undefined ? {} : { waitMs: input.tui.waitMs }),
      });
    },
  });
  const claudeHelperPath = fileURLToPath(
    new URL("./llm-gateway/claude/mcp-helper.mjs", import.meta.url),
  );
  const claudeCallbackBaseUrl = (): string => {
    if (boundListenTarget?.type === "tcp") {
      const host =
        boundListenTarget.host === "0.0.0.0" || boundListenTarget.host === "::"
          ? "127.0.0.1"
          : boundListenTarget.host;
      return `http://${host}:${boundListenTarget.port}`;
    }
    return "http://127.0.0.1:6868";
  };
  // The Library's OAuth sign-ins to remote MCP servers: signed in once here,
  // and every agent given the server reaches it through /mcp/<name>
  // (myna internal/mcpauth/mcpauth.go, internal/library/mcp_signin.go).
  const mcpauth = new McpauthService({
    neolixHome: config.neolixHome,
    onChanged: () => {
      // The agents' addresses changed: signed in to one, or signed out.
      void wsServer
        ?.getLibraryService()
        .resync()
        .catch((error: unknown) => {
          logger.warn({ err: error }, "Cannot give the agents a changed MCP sign-in");
        });
    },
  });
  app.use(
    createGatewayRouter({
      neolixHome: config.neolixHome,
      mcpauth,
      claude: {
        bridge: claudeBridge,
        helperPath: claudeHelperPath,
        callbackBaseUrl: claudeCallbackBaseUrl,
        claudeConfigDir: defaultClaudeConfigDir,
      },
      configStore: gatewayConfigStore,
      masker: gatewayMasker,
      maskingRecords: gatewayMaskingRecords,
      ledger: gatewayLedger,
      logger,
      // Codex switched off in the agent settings is left alone: its sign-in
      // is read, never refreshed or written back (myna's leftAlone).
      codexLeftAlone: () => daemonConfigStore.get().providers?.codex?.enabled === false,
      runtime: gatewayRuntime,
      searchLedger: gatewaySearch,
      browser: gatewayBrowser,
      conversations: gatewayConversations,
      vision: gatewayVision,
      media: gatewayMedia,
      archive: gatewayArchive,
      history: gatewayHistory,
      turnTracker: gatewayTurnTracker,
      usagePoller,
    }),
  );

  // The desktop web app (page, `/rpc` socket and its upload routes) on this port, as
  // T3 Code's server hosts its client. Mounted before daemon bearer auth and the JSON
  // body parser: it answers only this computer and reads its own request bodies.
  const webApp = new WebAppHost({
    candidates: config.webApp,
    neolixHome: config.neolixHome,
    logger: logger.child({ module: "web-app" }),
  });
  app.use(webApp.middleware());

  let localCredential: string | null = null;
  const daemonAuth = { ...config.auth, localCredential: () => localCredential };
  app.use(
    createRequireBearerMiddleware(daemonAuth, (context) => {
      logger.warn(context, "Rejected HTTP request with invalid daemon password");
    }),
  );

  app.use(express.json());

  // Serve static files from public directory
  app.use("/public", express.static(staticDir));

  // Health check endpoint
  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  app.get("/api/status", (_req, res) => {
    res.json({
      status: "server_info",
      serverId,
      hostname: getHostName(),
      version: daemonVersion,
      listen: formatListenTarget(boundListenTarget ?? listenTarget),
    });
  });

  const handleFileDownload = async (req: express.Request, res: express.Response): Promise<void> => {
    const token =
      typeof req.query.token === "string" && req.query.token.trim().length > 0
        ? req.query.token.trim()
        : null;

    if (!token) {
      res.status(400).json({ error: "Missing download token" });
      return;
    }

    const entry = downloadTokenStore.consumeToken(token);
    if (!entry) {
      res.status(403).json({ error: "Invalid or expired token" });
      return;
    }

    let fileHandle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      fileHandle = await open(entry.absolutePath, DOWNLOAD_OPEN_FLAGS);
      const fileStats = await fileHandle.stat();
      if (res.destroyed) {
        return;
      }
      if (!fileStats.isFile()) {
        res.status(404).json({ error: "File not found" });
        return;
      }

      res.setHeader("Content-Type", entry.mimeType);
      res.setHeader("Content-Disposition", formatAttachmentContentDisposition(entry.fileName));
      res.setHeader("Content-Length", fileStats.size.toString());

      const stream = fileHandle.createReadStream();
      fileHandle = null;
      res.once("close", () => stream.destroy());
      stream.on("error", (err) => {
        logger.error({ err }, "Failed to stream download");
        if (!res.headersSent) {
          res.status(500).json({ error: "Failed to read file" });
        } else {
          res.end();
        }
      });
      stream.pipe(res);
    } catch (err) {
      logger.error({ err }, "Failed to download file");
      if (!res.headersSent) {
        res.status(404).json({ error: "File not found" });
      }
    } finally {
      await fileHandle?.close().catch(() => undefined);
    }
  };

  app.get("/api/files/download", (req, res) => {
    void handleFileDownload(req, res);
  });

  const httpServer = createHTTPServer(app);
  // A Codex thread keeps the address it was started on. Only a thread that
  // asked this daemon for Codex's own backend keeps this one, so quit leaves
  // a relay only then; a daemon no Codex ever reached leaves none
  // (llm-gateway/codex-relay.ts).
  let servedCodex = false;
  const noteCodexRequest = (url: string | undefined): void => {
    if (isCodexGatewayRequest(url)) {
      servedCodex = true;
    }
  };
  httpServer.on("request", (request) => noteCodexRequest(request.url));
  const inherited = inheritedListenerFor(httpServer);
  // A loopback connection's OS user is read once, in the background, so a
  // request on it needs no kernel table read (llm-gateway/peer-user.ts).
  // Only a keyless gateway answers loopback without a key, which is the one
  // case the owner matters; a keyed one skips the read.
  httpServer.on("connection", (socket) => {
    const gateway = gatewayConfigStore.get();
    if (gateway.enabled && gateway.keys.length === 0) {
      noteConnection(socket);
    }
  });

  // The browser extension's socket; its handshake is checked by the relay,
  // and anything that is not its path is left to the daemon's own sockets.
  httpServer.on("upgrade", (request, socket, head) => {
    gatewayBrowser.handleUpgrade(request, socket, head);
  });

  // Responses over a WebSocket: each turn is dispatched through the same
  // Express app an HTTP request would use, so every guard judges it too.
  const gatewayResponses = new ResponsesSockets({
    configStore: gatewayConfigStore,
    logger,
    dispatch: (request, response) => {
      // Express's app is callable; its type declaration doesn't spell it.
      (app as unknown as { handle: (req: IncomingMessage, res: ServerResponse) => void }).handle(
        request,
        response,
      );
    },
  });
  httpServer.on("upgrade", (request, socket, head) => {
    noteCodexRequest(request.url);
    gatewayResponses.handleUpgrade(request, socket, head);
  });

  // Script proxy WebSocket upgrade handler — must be registered before the
  // VoiceAssistantWebSocketServer attaches its own "upgrade" listener so that
  // script-bound upgrades are forwarded first. The handler is a no-op for
  // requests that don't match a registered script route.
  httpServer.on("upgrade", serviceProxy.upgradeHandler({ passthroughUnknown: true }));
  // The web app's `/rpc` sockets; every other path is left to the listeners above and
  // the daemon's own `/ws`.
  httpServer.on("upgrade", webApp.upgradeListener());

  if (config.serviceProxy?.standaloneListen) {
    serviceProxyListenTarget = parseListenString(config.serviceProxy.standaloneListen);
  }

  const agentStorage = new AgentStorage(config.agentStoragePath, logger);
  const projectRegistry = new FileBackedProjectRegistry(
    path.join(config.neolixHome, "projects", "projects.json"),
    logger,
  );
  workspaceRegistry = new FileBackedWorkspaceRegistry(
    path.join(config.neolixHome, "projects", "workspaces.json"),
    logger,
  );
  const workspaceLabelService = createWorkspaceLabelService({
    neolixHome: config.neolixHome,
    workspaceRegistry,
  });
  const github = createGitHubService();
  const workspaceGitService = new WorkspaceGitServiceImpl({
    logger,
    neolixHome: config.neolixHome,
    worktreesRoot: config.worktreesRoot,
    deps: {
      forgeOverrides: { github },
    },
  });
  const workspaceRuntimeStore = createWorkspaceRuntimeStore();
  workspaceGitService.onSnapshotUpdated((snapshot) => workspaceRuntimeStore.set(snapshot));
  workspaceRegistry.subscribeToMutations(async (mutation) => {
    if (mutation.kind === "remove" && mutation.workspace) {
      const cwd = path.resolve(mutation.workspace.cwd);
      const workspaces = await workspaceRegistry.listActive();
      const hasActiveWorkspace = workspaces.some(
        (workspace) => !workspace.archivedAt && path.resolve(workspace.cwd) === cwd,
      );
      if (!hasActiveWorkspace) workspaceRuntimeStore.remove(cwd);
    }
    if (mutation.kind === "archive" && mutation.workspace) {
      pluginRuntime.emit("workspace.archive.after", {
        workspace: describeHookWorkspace(mutation.workspace),
      });
    }
  });
  const workspaceProvisioning = createWorkspaceProvisioningService({
    lifecycle: pluginRuntime,
    serverId,
    projectRegistry,
    workspaceRegistry,
    workspaceGitService,
    isDirectory: async (target) => (await stat(target).catch(() => null))?.isDirectory() ?? false,
    logger,
  });
  const agentProviderRuntime = await createAgentProviderRuntime({
    neolixHome: config.neolixHome,
    logger,
    snapshotManager: {
      refreshTimeoutMs: config.providerCatalogRefreshTimeoutMs,
      runtimeSettings: config.agentProviderSettings,
      providerOverrides: config.providerOverrides,
      workspaceGitService,
      managedProcesses,
      isDev: config.isDev === true,
      extraClients: config.agentClients,
    },
  });
  const providerSnapshotManager = agentProviderRuntime.snapshotManager;
  daemonConfigStore.onFieldChange("catalogRefreshTimeoutMs", (value) => {
    providerSnapshotManager.setRefreshTimeoutMs(typeof value === "number" ? value : undefined);
  });
  daemonConfigStore.onFieldChange("git.maxProcessesPerSecond", () => {
    const git = daemonConfigStore.get().git;
    if (git) configureGitProcessPolicy(git);
  });
  daemonConfigStore.onFieldChange("git.maxProcessConcurrency", () => {
    const git = daemonConfigStore.get().git;
    if (git) configureGitProcessPolicy(git);
  });
  const initialAgentManagerState = providerSnapshotManager.getAgentManagerProviderState();
  const agentManager = new AgentManager({
    pluginLifecycle: pluginRuntime,
    pluginAgentTools: pluginRuntime,
    clients: initialAgentManagerState.clients,
    providerDefinitions: initialAgentManagerState.providerDefinitions,
    registry: agentStorage,
    appendSystemPrompt: config.appendSystemPrompt,
    onWorkspaceStateMayHaveChanged: ({ cwd }) => {
      workspaceGitService.onWorkspaceStateMayHaveChanged(cwd);
    },
    mcpAuthToken: agentMcpAuthToken,
    resolveNeolixToolPolicy: (provider) =>
      resolveNeolixToolPolicy(provider, daemonConfigStore.get().providers),
    logger,
  });
  const telemetry = new TelemetryService({
    neolixHome: config.neolixHome,
    version: daemonVersion,
    logger,
    config: () => daemonConfigStore.get().telemetry ?? {},
    usage: () => {
      const definitions =
        providerSnapshotManager.getAgentManagerProviderState().providerDefinitions;
      const gateway = gatewayConfigStore.get();
      const hiddenGroups = new Set(gateway.hiddenGroups ?? []);
      return {
        agents: Object.entries(definitions)
          .filter(([, definition]) => definition?.enabled === true)
          .map(([provider]) => provider),
        providers: gateway.providers
          .filter((provider) => provider.enabled !== false)
          .map((provider) => ({
            preset: provider.preset,
            baseUrl: provider.baseUrl,
            models: provider.models.map((model) => model.id),
          })),
        groups: gateway.groups.filter(
          (group) => group.disabled !== true && !hiddenGroups.has(group.id),
        ).length,
      };
    },
  });
  daemonConfigStore.onFieldChange("telemetry.enabled", () => telemetry.refresh());
  telemetry.start();
  const syncPluginProviders = () => {
    agentManager.updateProviderRegistry(
      providerSnapshotManager.replacePluginProviders(pluginRuntime.getProviderRegistrations()),
    );
  };
  const unsubscribePluginProviders =
    pluginRuntime.subscribeProviderRegistrations(syncPluginProviders);

  const unsubscribePluginSessionChanges = pluginRuntime.subscribeSessionOpenChanges(() => {
    agentManager.invalidatePluginSessions();
  });

  const detachAgentStoragePersistence = attachAgentStoragePersistence(
    logger,
    agentManager,
    agentStorage,
  );
  await agentStorage.initialize();
  const restartRecovery = createRestartRecovery({
    storage: agentStorage,
    settings: () => ({
      enabled: daemonConfigStore.get().resumeOnStartup === true,
      prompt: daemonConfigStore.get().resumePrompt ?? "Resume working.",
    }),
    eligible: async (record) =>
      !record.workspaceId || !(await workspaceRegistry?.get(record.workspaceId))?.archivedAt,
    dispatch: (agentId, prompt) =>
      sendPromptToAgent({ agentId, prompt, agentManager, agentStorage, logger, unarchive: false }),
    report: (agentId, err) => logger.error({ agentId, err }, "Agent restart recovery failed"),
  });
  await restartRecovery.prepareStartup();
  logger.info({ elapsed: elapsed() }, "Agent storage initialized");
  await bootstrapWorkspaceRegistries({
    serverId,
    neolixHome: config.neolixHome,
    agentStorage,
    projectRegistry,
    workspaceRegistry,
    workspaceGitService,
    logger,
  });
  await workspaceLabelService.initialize();
  logger.info({ elapsed: elapsed() }, "Workspace registries bootstrapped");
  const teardownArchivedWorkspaceRuntime = (workspaceId: string): void => {
    scriptRuntimeStore.removeForWorkspace(workspaceId);
    releaseWorkspaceServicePortPlan(workspaceId);
  };
  const workspaceReconciliation = new WorkspaceReconciliationService({
    serverId,
    projectRegistry,
    workspaceRegistry,
    logger,
    workspaceGitService,
    onProjectUpdate: (update) => wsServer?.publishProjectUpdate(update),
    onWorkspaceArchived: teardownArchivedWorkspaceRuntime,
    onWorkspacesChanged: async (workspaceIds) => {
      await fanOutReconciledWorkspaceUpdates({
        sessions: wsServer?.listSessions() ?? [],
        workspaceIds,
        logger,
      });
    },
  });
  await workspaceReconciliation.start();
  void workspaceReconciliation.reconcileNow().catch((error) => {
    logger.warn({ err: error }, "Initial workspace reconciliation failed");
  });
  const checkoutDiffManager = new CheckoutDiffManager({
    logger,
    neolixHome: config.neolixHome,
    workspaceGitService,
    workspaceRuntimeStore,
  });
  const archiveWorkspaceRecordExternal = async (
    workspaceId: string,
    context?: WorkspaceArchiveContext,
  ) => {
    const existingWorkspace = await archivePersistedWorkspaceRecord({
      workspaceId,
      workspaceRegistry,
      context,
    });
    if (!existingWorkspace || existingWorkspace.archivedAt) return;
    teardownArchivedWorkspaceRuntime(workspaceId);
  };
  // external path→workspace adapter, not ownership: archive-by-path requests that
  // arrive with a worktree path and no workspaceId (old clients / CLI).
  const findWorkspaceIdForCwdExternal = async (cwd: string): Promise<string | null> => {
    // Explicit archive administration must prefer an archived exact match to an active ancestor.
    return resolveWorkspaceIdForPath(cwd, await workspaceRegistry.listAll());
  };
  const ensureWorkspaceForCreateExternal = async (
    cwd: string,
    firstAgentContext?: FirstAgentContext,
    context?: { background?: boolean; callerWorkspaceId?: string },
  ): Promise<string> => {
    const workspace = await workspaceProvisioning.createWorkspaceForDirectory(
      cwd,
      resolveFirstAgentPromptTitle(firstAgentContext),
      undefined,
      context,
    );
    if (firstAgentContext) {
      workspaceAutoName.scheduleForDirectory({
        workspaceId: workspace.workspaceId,
        cwd: workspace.cwd,
        firstAgentContext,
      });
    }
    return workspace.workspaceId;
  };
  const listActiveWorkspacesExternal = async (): Promise<ActiveWorkspaceRef[]> => {
    const workspaces = await workspaceRegistry.listActive();
    return workspaces
      .filter((workspace) => !workspace.archivedAt)
      .map((workspace) => ({
        workspaceId: workspace.workspaceId,
        cwd: workspace.cwd,
        kind: workspace.kind,
        worktreeRoot: workspace.worktreeRoot,
        isNeolixOwnedWorktree: workspace.isNeolixOwnedWorktree,
        mainRepoRoot: workspace.mainRepoRoot,
      }));
  };
  const markWorkspaceArchivingExternal = (workspaceIds: Iterable<string>, archivingAt: string) => {
    const workspaceIdList = Array.from(workspaceIds);
    for (const session of wsServer?.listSessions() ?? []) {
      session.markWorkspaceArchivingForExternalMutation(workspaceIdList, archivingAt);
    }
  };
  const clearWorkspaceArchivingExternal = (workspaceIds: Iterable<string>) => {
    const workspaceIdList = Array.from(workspaceIds);
    for (const session of wsServer?.listSessions() ?? []) {
      session.clearWorkspaceArchivingForExternalMutation(workspaceIdList);
    }
  };
  const emitWorkspaceUpdatesExternal = async (workspaceIds: Iterable<string>) => {
    const workspaceIdList = Array.from(workspaceIds);
    await Promise.all(
      (wsServer?.listSessions() ?? []).map((session) =>
        session.emitWorkspaceUpdatesForExternalWorkspaceIds(workspaceIdList),
      ),
    );
  };
  const ensureWorkspaceForCreateAndBroadcastExternal = async (
    cwd: string,
    firstAgentContext?: FirstAgentContext,
    context?: { background?: boolean; callerWorkspaceId?: string },
  ): Promise<string> => {
    const workspaceId = await ensureWorkspaceForCreateExternal(cwd, firstAgentContext, context);
    await emitWorkspaceUpdatesExternal([workspaceId]);
    return workspaceId;
  };
  const emitWorkspaceUpdateForCwdExternal = async (cwd: string) => {
    const workspaceIds = workspaceIdsOnCheckout(await workspaceRegistry.listActive(), cwd);
    await emitWorkspaceUpdatesExternal(workspaceIds);
  };
  const emitExternalSessionMessage = (message: SessionOutboundMessage) => {
    wsServer?.broadcast(wrapSessionMessage(message));
  };
  const workspaceAutoName = new WorkspaceAutoName({
    agentManager,
    workspaceRegistry,
    workspaceGitService,
    providerSnapshotManager,
    readDaemonConfig: () => ({ metadataGeneration: daemonConfigStore.get().metadataGeneration }),
    gitMutation: createGitMutationService({
      workspaceGitService,
      logger,
    }),
    emitWorkspaceUpdateForCwd: emitWorkspaceUpdateForCwdExternal,
    emitWorkspaceUpdateForWorkspaceId: async (workspaceId) => {
      await emitWorkspaceUpdatesExternal([workspaceId]);
    },
    logger,
  });

  setupAutoArchiveOnMerge({
    neolixHome: config.neolixHome,
    neolixWorktreesBaseRoot: config.worktreesRoot,
    daemonConfigStore,
    workspaceGitService,
    github,
    agentManager,
    agentStorage,
    terminalManager,
    logger,
    findWorkspaceIdForCwd: findWorkspaceIdForCwdExternal,
    listActiveWorkspaces: listActiveWorkspacesExternal,
    getAutoArchivedChangeRequestUrl: async (workspaceId) =>
      (await workspaceRegistry.get(workspaceId))?.autoArchivedChangeRequestUrl ?? null,
    archiveWorkspaceRecord: archiveWorkspaceRecordExternal,
    markWorkspaceArchiving: markWorkspaceArchivingExternal,
    clearWorkspaceArchiving: clearWorkspaceArchivingExternal,
    emitWorkspaceUpdatesForWorkspaceIds: emitWorkspaceUpdatesExternal,
  });

  const createNeolixWorktreeForTools = async (
    input: Parameters<typeof createNeolixWorktreeWorkflow>[1],
    serviceOptions?: Parameters<typeof createNeolixWorktreeWorkflow>[2],
  ) => {
    return createNeolixWorktreeWorkflow(
      {
        neolixHome: config.neolixHome,
        worktreesRoot: config.worktreesRoot,
        createNeolixWorktree: async (workflowInput, workflowOptions) => {
          return createRegisteredNeolixWorktree(workflowInput, {
            lifecycle: pluginRuntime,
            github,
            ...(workflowOptions?.resolveDefaultBranch
              ? {
                  resolveDefaultBranch: workflowOptions.resolveDefaultBranch,
                }
              : {}),
            workspaceGitService,
            workspaceProvisioning,
          });
        },
        warmWorkspaceGitData: async (workspace) => {
          await Promise.all(
            wsServer
              ?.listSessions()
              .map((session) => session.warmWorkspaceGitDataForWorkspace(workspace)) ?? [],
          );
        },
        autoNameWorkspaceBranchForFirstAgent: (autoNameInput) =>
          workspaceAutoName.scheduleForWorktree(autoNameInput),
        emitWorkspaceUpdateForWorkspaceId: async (workspaceId) => {
          await emitWorkspaceUpdatesExternal([workspaceId]);
        },
        cacheWorkspaceSetupSnapshot: () => {},
        startWorkspaceSetup: (workspaceId, operation) =>
          workspaceSetupRuntime.start(workspaceId, operation),
        assertWorkspaceAutomationAllowed: (guardedWorkspaceId) =>
          assertWorkspaceAutomationAllowedForWorkspace(workspaceRegistry, guardedWorkspaceId),
        emit: emitExternalSessionMessage,
        sessionLogger: logger,
        terminalManager,
        serviceProxy,
        scriptRuntimeStore,
        getDaemonTcpPort: () => (boundListenTarget?.type === "tcp" ? boundListenTarget.port : null),
        getDaemonTcpHost: () => (boundListenTarget?.type === "tcp" ? boundListenTarget.host : null),
        serviceProxyPublicBaseUrl,
        onScriptsChanged: null,
      },
      input,
      serviceOptions,
    );
  };

  const createAgentCommandDependencies: CreateAgentCommandDependencies = {
    agentManager,
    agentStorage,
    logger,
    neolixHome: config.neolixHome,
    worktreesRoot: config.worktreesRoot,
    terminalManager,
    providerSnapshotManager,
    createNeolixWorktree: createNeolixWorktreeForTools,
    ensureWorkspaceForCreate: ensureWorkspaceForCreateAndBroadcastExternal,
  };
  const createAgent = (input: Parameters<typeof createAgentCommand>[1]) =>
    createAgentCommand(createAgentCommandDependencies, input);
  const archiveWorkspaceByIdExternal = (workspaceId: string, requestId: string) =>
    archiveByScope(
      {
        neolixHome: config.neolixHome,
        neolixWorktreesBaseRoot: config.worktreesRoot,
        github,
        workspaceGitService,
        agentManager,
        agentStorage,
        findWorkspaceIdForCwd: findWorkspaceIdForCwdExternal,
        listActiveWorkspaces: listActiveWorkspacesExternal,
        getWorkspace: (workspaceIdToGet) => workspaceRegistry.get(workspaceIdToGet),
        archiveWorkspaceRecord: archiveWorkspaceRecordExternal,
        emitWorkspaceUpdatesForWorkspaceIds: emitWorkspaceUpdatesExternal,
        markWorkspaceArchiving: markWorkspaceArchivingExternal,
        clearWorkspaceArchiving: clearWorkspaceArchivingExternal,
        killTerminalsForWorkspace: (workspaceIdToKill) =>
          killTerminalsForWorkspace({ terminalManager, sessionLogger: logger }, workspaceIdToKill),
        stopWorkspaceSetup: (workspaceIdToStop) => workspaceSetupRuntime.stop(workspaceIdToStop),
        assertWorkspaceAutomationAllowed: (guardedWorkspaceId) =>
          assertWorkspaceAutomationAllowedForWorkspace(workspaceRegistry, guardedWorkspaceId),
        sessionLogger: logger,
      },
      { scope: { kind: "workspace", workspaceId }, requestId },
    );
  const hubAgentLifecycle = new CreateAgentLifecycleDispatch({
    neolixHome: config.neolixHome,
    worktreesRoot: config.worktreesRoot,
    agentManager,
    agentStorage,
    github,
    workspaceGitService,
    createNeolixWorktreeWorkflow: createNeolixWorktreeForTools,
    archiveAgentForClose: (agentId) =>
      archiveAgentCommand({ agentManager, agentStorage, logger }, agentId),
    findWorkspaceIdForCwd: findWorkspaceIdForCwdExternal,
    listActiveWorkspaces: listActiveWorkspacesExternal,
    archiveWorkspaceRecord: archiveWorkspaceRecordExternal,
    emit: emitExternalSessionMessage,
    emitAgentRemove: async () => undefined,
    emitWorkspaceUpdatesForWorkspaceIds: emitWorkspaceUpdatesExternal,
    markWorkspaceArchiving: markWorkspaceArchivingExternal,
    clearWorkspaceArchiving: clearWorkspaceArchivingExternal,
    killTerminalsForWorkspace: (workspaceId) =>
      killTerminalsForWorkspace({ terminalManager, sessionLogger: logger }, workspaceId),
    logger,
  });
  const hubRelationships = new HubRelationshipController({
    neolixHome: config.neolixHome,
    hostname: getHostName(),
    serverId,
    daemonPublicKey: daemonKeyPair.publicKeyB64,
    logger,
    remote: dependencies.hubRelationshipRemote ?? new DirectHubRelationshipRemote(),
    clock: dependencies.hubRelationshipClock,
    retryPolicy: dependencies.hubRelationshipRetryPolicy,
    createDaemonId: dependencies.createHubDaemonId,
    attachSocket: async (socket, options) => {
      if (!wsServer) throw new Error("WebSocket server is not running");
      await wsServer.attachExternalSocket(
        socket,
        { transport: "hub", hubDaemonId: options.daemonId },
        {
          principalId: options.principalId,
          permissions: options.permissions,
          hubExecutionAgents: options.agents,
        },
        options.sessionProtocol === "legacy"
          ? {
              type: "hello",
              clientId: `hub:${options.daemonId}`,
              clientType: "hub",
              protocolVersion: 1,
            }
          : undefined,
      );
    },
    updateAttachedPermissions: (principalId, permissions) => {
      if (!wsServer) throw new Error("WebSocket server is not running");
      wsServer.updatePrincipalPermissions(principalId, permissions);
    },
    createExecutionAgents: (daemonId) =>
      new DaemonExecutions({
        daemonId,
        agentManager,
        agentStorage,
        createAgent,
        interruptAgent: (agentId) => cancelAgentRunCommand({ agentManager, logger }, agentId),
        archiveWorkspace: archiveWorkspaceByIdExternal,
        cleanupFailedCreate: (input) =>
          hubAgentLifecycle.cleanupCreatedWorktreeAfterFailedAgentCreate(input),
      }),
  });

  const createScheduleLocalWorkspaceExternal = async (input: {
    cwd: string;
    firstAgentContext: FirstAgentContext;
  }) => {
    const workspace = await workspaceProvisioning.createWorkspaceForDirectory(
      input.cwd,
      resolveFirstAgentPromptTitle(input.firstAgentContext),
    );
    workspaceAutoName.scheduleForDirectory({
      workspaceId: workspace.workspaceId,
      cwd: workspace.cwd,
      firstAgentContext: input.firstAgentContext,
    });
    await emitWorkspaceUpdatesExternal([workspace.workspaceId]);
    return workspace;
  };
  const createScheduleNeolixWorktreeExternal = async (input: {
    cwd: string;
    firstAgentContext: FirstAgentContext;
  }) => {
    const result = await createNeolixWorktreeForTools({
      cwd: input.cwd,
      firstAgentContext: input.firstAgentContext,
    });
    await emitWorkspaceUpdatesExternal([result.workspace.workspaceId]);
    return result;
  };
  const archiveScheduleWorkspaceExternal = async (workspaceId: string) => {
    await archiveByScope(
      {
        neolixHome: config.neolixHome,
        neolixWorktreesBaseRoot: config.worktreesRoot,
        github,
        workspaceGitService,
        agentManager,
        agentStorage,
        findWorkspaceIdForCwd: findWorkspaceIdForCwdExternal,
        listActiveWorkspaces: listActiveWorkspacesExternal,
        getWorkspace: (workspaceIdToGet) => workspaceRegistry.get(workspaceIdToGet),
        archiveWorkspaceRecord: archiveWorkspaceRecordExternal,
        emitWorkspaceUpdatesForWorkspaceIds: emitWorkspaceUpdatesExternal,
        markWorkspaceArchiving: markWorkspaceArchivingExternal,
        clearWorkspaceArchiving: clearWorkspaceArchivingExternal,
        killTerminalsForWorkspace: (workspaceIdToKill) =>
          killTerminalsForWorkspace(
            {
              terminalManager,
              sessionLogger: logger,
            },
            workspaceIdToKill,
          ),
        stopWorkspaceSetup: (workspaceIdToStop) => workspaceSetupRuntime.stop(workspaceIdToStop),
        assertWorkspaceAutomationAllowed: (guardedWorkspaceId) =>
          assertWorkspaceAutomationAllowedForWorkspace(workspaceRegistry, guardedWorkspaceId),
        sessionLogger: logger,
      },
      {
        scope: { kind: "workspace", workspaceId },
        requestId: "schedule-run-finish",
      },
    );
  };
  const scheduleService = new ScheduleService({
    neolixHome: config.neolixHome,
    logger,
    agentManager,
    agentStorage,
    createAgent,
    createDirectoryWorkspace: createScheduleLocalWorkspaceExternal,
    createNeolixWorktreeWorkspace: createScheduleNeolixWorktreeExternal,
    archiveWorkspace: archiveScheduleWorkspaceExternal,
  });
  await scheduleService.start();

  agentManager.setAgentArchivedCallback(async (agentId) => {
    try {
      await scheduleService.completeForAgent(agentId);
    } catch (error) {
      logger.warn({ err: error, agentId }, "Failed to complete schedules for archived agent");
    }
  });
  logger.info({ elapsed: elapsed() }, "Schedule service initialized");
  logger.info({ elapsed: elapsed() }, "Loading persisted agent registry");
  // Startup loads persisted agent history once before restoring the registry.
  const persistedRecords = await agentStorage.listAll();
  logger.info(
    { elapsed: elapsed() },
    `Agent registry loaded (${persistedRecords.length} record${persistedRecords.length === 1 ? "" : "s"}); agents will initialize on demand`,
  );
  logger.info(
    "Voice mode configured for agent-scoped resume flow (no dedicated voice assistant provider)",
  );
  logger.info({ elapsed: elapsed() }, "Preparing voice and MCP runtime");

  const finishSubscriptions = createFinishSubscriptions({
    store: createJsonFinishSubscriptionStore(config.neolixHome),
    serverId,
    logger,
    messages: () => {
      if (!wsServer) throw new Error("Daemon is not accepting agent messages");
      return wsServer.agentMessages;
    },
    callerIsActive: async (agentId) => {
      const record = await agentStorage.get(agentId);
      return record ? !record.archivedAt : Boolean(agentManager.getAgent(agentId));
    },
    ...createFinishObservation({
      agentManager,
      agentStorage,
      waitForResume: restartRecovery.waitForResume,
      serverId,
      logger,
      messages: () => {
        if (!wsServer) throw new Error("Daemon is not accepting agent messages");
        return wsServer.agentMessages;
      },
      hosts: () => {
        if (!wsServer) throw new Error("Daemon is not accepting host operations");
        return wsServer.toolHosts();
      },
    }),
  });

  const idleRuntimeCleanup = createIdleRuntimeCleanup({
    enabled: daemonConfigStore.get().idleRuntimeCleanup !== false,
    runtimes: () => agentManager.getRuntimeCleanupCandidates(),
    isProtected: (agentId) =>
      finishSubscriptions.hasPendingForCaller(agentId) ||
      (wsServer?.agentMessages.hasPending(agentId) ?? false),
    logger,
  });

  const unsubscribeIdleRuntimeCleanup = connectIdleRuntimeCleanupConfig(
    daemonConfigStore,
    idleRuntimeCleanup,
  );

  const createAgentToolHostDependencies = (
    runtime: NeolixToolRuntimeContext,
  ): NeolixToolHostDependencies => ({
    finishSubscriptions: () => finishSubscriptions,
    agentMessages: () => {
      if (!wsServer) throw new Error("Daemon is not accepting agent messages");
      return wsServer.agentMessages;
    },
    serverId,
    hosts: () => {
      if (!wsServer) throw new Error("Daemon is not accepting host operations");
      return wsServer.toolHosts();
    },
    agentManager,
    agentStorage,
    terminalManager,
    getDaemonTcpPort: () => (boundListenTarget?.type === "tcp" ? boundListenTarget.port : null),
    scheduleService,
    providerSnapshotManager,
    daemonConfigStore,
    github,
    workspaceGitService,
    findWorkspaceIdForCwd: findWorkspaceIdForCwdExternal,
    listActiveWorkspaces: listActiveWorkspacesExternal,
    archiveWorkspaceRecord: archiveWorkspaceRecordExternal,
    emitWorkspaceUpdatesForWorkspaceIds: emitWorkspaceUpdatesExternal,
    workspaceRegistry,
    projectRegistry,
    createDirectoryWorkspace: async (cwd, title, projectId, context) => {
      const workspace = await workspaceProvisioning.createWorkspaceForDirectory(
        cwd,
        title,
        projectId,
        context,
      );
      await emitWorkspaceUpdatesExternal([workspace.workspaceId]);
      return workspace;
    },
    workspaceScripts: createWorkspaceScriptsService({
      serviceProxy,
      scriptRuntimeStore,
      terminalManager,
      workspaceRegistry,
      projectRegistry,
      workspaceRuntimeStore,
      getDaemonTcpPort: () => (boundListenTarget?.type === "tcp" ? boundListenTarget.port : null),
      getDaemonTcpHost: () => (boundListenTarget?.type === "tcp" ? boundListenTarget.host : null),
      serviceProxyPublicBaseUrl,
      resolveScriptHealth: (hostname) => scriptHealthMonitor.getHealthForHostname(hostname),
      logger,
      emit: (message) => wsServer?.broadcast(wrapSessionMessage(message)),
      publishStatusUpdate: (message) => wsServer?.publishScriptStatusUpdate(message),
      spawnWorkspaceScript,
      assertAutomationAllowed: (workspaceId) =>
        assertWorkspaceAutomationAllowedForWorkspace(workspaceRegistry, workspaceId),
      getGlobalServicePorts: () => daemonConfigStore.readServicePorts(),
    }),
    markWorkspaceArchiving: markWorkspaceArchivingExternal,
    clearWorkspaceArchiving: clearWorkspaceArchivingExternal,
    ensureWorkspaceForCreate: createAgentCommandDependencies.ensureWorkspaceForCreate,
    createNeolixWorktree: createAgentCommandDependencies.createNeolixWorktree,
    browserToolsEnabled: browserToolsPolicy.isEnabled(),
    browserToolsBroker,
    neolixToolPolicy:
      runtime.neolixToolPolicy ??
      (runtime.callerAgentId ? agentManager.getNeolixToolPolicy(runtime.callerAgentId) : undefined),
    neolixHome: config.neolixHome,
    worktreesRoot: config.worktreesRoot,
    callerAgentId: runtime.callerAgentId,
    enableVoiceTools: runtime.enableVoiceTools,
    voiceOnly: runtime.voiceOnly,
    resolveSpeakHandler: (agentId) => wsServer?.resolveVoiceSpeakHandler(agentId) ?? null,
    resolveCallerContext: (agentId) => wsServer?.resolveVoiceCallerContext(agentId) ?? null,
    logger,
  });
  const createAgentToolCatalog = (runtime: NeolixToolRuntimeContext) =>
    createNeolixToolCatalog(createAgentToolHostDependencies(runtime));
  const setAgentProviderToolsEnabled = (enabled: boolean) => {
    agentProviderRuntime.setNeolixToolCatalog(
      enabled ? createNeolixAgentToolManifest(createAgentToolHostDependencies({})) : null,
    );
  };
  agentManager.setNeolixToolCatalogFactory(createAgentToolCatalog);
  agentManager.setNeolixToolsEnabled(config.mcpInjectIntoAgents !== false);
  setAgentProviderToolsEnabled(config.mcpEnabled !== false && config.mcpInjectIntoAgents !== false);

  let mcpEnabled = config.mcpEnabled ?? true;
  let agentMcpBaseUrl: string | null = null;
  {
    const agentMcpRoute = "/mcp/agents";

    const createAgentMcpSession = async (callerAgentId?: string) => {
      const agentMcpServer = await createAgentMcpServer(
        createAgentToolHostDependencies({
          callerAgentId,
          neolixToolPolicy: callerAgentId
            ? agentManager.getNeolixToolPolicy(callerAgentId)
            : undefined,
        }),
      );

      // Stateless mode: each HTTP request builds a fresh server + transport that is
      // torn down when the response closes, so no per-session state is retained between
      // requests. The agent control plane only lists and calls tools, neither of which
      // needs cross-request state, so sessions would only pin memory for the life of the
      // daemon (agents that exit without a clean DELETE never get reaped).
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        // NOTE: We enforce a Vite-like host allowlist at the app/websocket layer.
        // StreamableHTTPServerTransport's built-in check requires exact Host header matches.
        enableDnsRebindingProtection: false,
      });
      Object.assign(transport, {
        onerror: (err: Error) => {
          logger.error({ err }, "Agent MCP transport error");
        },
      });

      await agentMcpServer.connect(transport);
      return { server: agentMcpServer, transport };
    };

    const runAgentMcpRequest = async (
      req: express.Request,
      res: express.Response,
    ): Promise<void> => {
      if (!mcpEnabled) {
        res.status(404).json({ error: "Agent MCP endpoint disabled" });
        return;
      }
      // This route is exempt from the global daemon-password middleware, so it
      // authenticates here using the injected capability token (or a valid
      // daemon password). Without this, a password-protected daemon would be
      // wide open on its agent control plane.
      if (
        !(await isAgentMcpRequestAuthorized({
          password: config.auth?.password,
          capabilityToken: agentMcpAuthToken,
          authorizationHeader: req.header("authorization"),
        }))
      ) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
      if (config.mcpDebug) {
        logger.debug(
          {
            method: req.method,
            url: req.originalUrl,
            sessionId: req.header("mcp-session-id"),
            authorization: req.header("authorization") ? MCP_DEBUG_SECRET : undefined,
            body: describeMcpDebugPayload(req.body),
          },
          "Agent MCP request",
        );
      }
      try {
        // Stateless: GET (standalone SSE) and DELETE (session termination) have no
        // meaning without sessions. The MCP client tolerates 405 on the GET stream
        // and never issues a DELETE because it is never handed a session id.
        if (req.method !== "POST") {
          res.status(405).json({
            jsonrpc: "2.0",
            error: {
              code: -32000,
              message: "Method not allowed",
            },
            id: null,
          });
          return;
        }
        const callerAgentIdRaw = req.query.callerAgentId;
        let callerAgentId: string | undefined;
        if (typeof callerAgentIdRaw === "string") {
          callerAgentId = callerAgentIdRaw;
        } else if (Array.isArray(callerAgentIdRaw) && typeof callerAgentIdRaw[0] === "string") {
          callerAgentId = callerAgentIdRaw[0];
        }
        const { server, transport } = await createAgentMcpSession(callerAgentId);
        res.on("close", () => {
          void transport.close();
          void server.close();
        });

        await transport.handleRequest(
          req as unknown as IncomingMessage,
          res as unknown as ServerResponse,
          req.body,
        );
      } catch (err) {
        logger.error({ err }, "Failed to handle Agent MCP request");
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: "2.0",
            error: {
              code: -32603,
              message: "Internal MCP server error",
            },
            id: null,
          });
        }
      }
    };

    const handleAgentMcpRequest: express.RequestHandler = (req, res) => {
      void runAgentMcpRequest(req, res);
    };

    app.post(agentMcpRoute, handleAgentMcpRequest);
    app.get(agentMcpRoute, handleAgentMcpRequest);
    app.delete(agentMcpRoute, handleAgentMcpRequest);
    logger.info({ route: agentMcpRoute, enabled: mcpEnabled }, "Agent MCP route mounted");
  }

  logger.info({ elapsed: elapsed() }, "Bootstrap complete, ready to start listening");

  const start = async () => {
    let mainStarted = false;
    try {
      localCredential = await writeLocalCredential(config.neolixHome);
      if (serviceProxyListenTarget) {
        const boundServiceProxyTarget = await serviceProxy.startStandalone({
          listenTarget: serviceProxyListenTarget,
        });
        serviceProxyListenTarget = boundServiceProxyTarget;
        logger.info(
          {
            listen: formatListenTarget(serviceProxyListenTarget),
            publicBaseUrl: serviceProxyPublicBaseUrl,
            elapsed: elapsed(),
          },
          "Service proxy listening",
        );
      }

      // A relay from an earlier daemon still holds this port until it is told
      // to let go (myna's `codexrelay.Leave`, `relay.go:283-300`).
      if (listenTarget.type === "tcp") {
        await leaveCodexRelay(path.join(config.neolixHome, "gateway", "codex-relay.json")).catch(
          () => false,
        );
      }

      // Start main HTTP server
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error) => {
          httpServer.off("listening", onListening);
          reject(err);
        };
        const onListening = () => {
          httpServer.off("error", onError);
          mainStarted = true;
          const logAndResolve = async () => {
            boundListenTarget = boundListenTargetOf(listenTarget, httpServer, inherited);
            // Settings › Network › Browser access: the bundled page on a port
            // of its own, with the daemon's API passed on beside it.
            webPage = new WebPageServer({
              neolixHome: config.neolixHome,
              distDir: config.webUi?.distDir ?? null,
              logger,
              daemonAddress: () => daemonTcpAddress(boundListenTarget),
              webApp,
            });
            configureWebPage(webPage);
            await webPage.start();
            const mcpBaseUrl = createAgentMcpBaseUrl(boundListenTarget);
            agentMcpBaseUrl =
              !mcpEnabled || config.mcpInjectIntoAgents === false ? null : mcpBaseUrl;
            agentManager.setMcpBaseUrl(agentMcpBaseUrl);
            agentManager.setNeolixToolsEnabled(mcpEnabled && config.mcpInjectIntoAgents !== false);
            daemonConfigStore.onFieldChange("mcp.enabled", (value) => {
              mcpEnabled = value !== false;
              const inject = daemonConfigStore.get().mcp.injectIntoAgents !== false;
              agentManager.setMcpBaseUrl(mcpEnabled && inject ? mcpBaseUrl : null);
              agentManager.setNeolixToolsEnabled(mcpEnabled && inject);
              setAgentProviderToolsEnabled(mcpEnabled && inject);
            });
            daemonConfigStore.onFieldChange("mcp.injectIntoAgents", (value) => {
              agentManager.setMcpBaseUrl(mcpEnabled && value ? mcpBaseUrl : null);
              agentManager.setNeolixToolsEnabled(mcpEnabled && value !== false);
              setAgentProviderToolsEnabled(mcpEnabled && value !== false);
            });
            daemonConfigStore.onFieldChange("appendSystemPrompt", (value) => {
              agentManager.setAppendSystemPrompt(typeof value === "string" ? value : "");
            });
            const relayEndpoint = config.relayEndpoint ?? "";
            const relayEnabled = relayEndpoint.length > 0 && (config.relayEnabled ?? true);
            const relayPublicEndpoint = config.relayPublicEndpoint ?? relayEndpoint;
            const relayUseTls = config.relayUseTls ?? true;
            const relayPublicUseTls = config.relayPublicUseTls ?? relayUseTls;
            if (boundListenTarget.type === "tcp") {
              logger.info(
                {
                  host: boundListenTarget.host,
                  port: boundListenTarget.port,
                  authRequired: !!config.auth?.password,
                  elapsed: elapsed(),
                },
                `Server listening on http://${boundListenTarget.host}:${boundListenTarget.port}`,
              );
            } else {
              logger.info(
                {
                  path: boundListenTarget.path,
                  authRequired: !!config.auth?.password,
                  elapsed: elapsed(),
                },
                `Server listening on ${boundListenTarget.path}`,
              );
            }
            if (config.auth?.password) {
              logger.info("Daemon password authentication enabled");
            }

            const startedSyncService = new SyncService({
              neolixHome: config.neolixHome,
              logger,
              onEvent: (event) => {
                if (!wsServer) {
                  return;
                }
                if (event.type === "sync.status.changed") {
                  wsServer.broadcast(
                    wrapSessionMessage({
                      type: "sync.status.changed",
                      payload: { status: event.status },
                    }),
                  );
                } else if (event.type === "sync.app_settings.apply") {
                  wsServer.broadcast(
                    wrapSessionMessage({
                      type: "sync.app_settings.apply",
                      payload: {
                        settings: (event.value as Record<string, unknown> | null) ?? {},
                      },
                    }),
                  );
                }
              },
            });
            syncService = startedSyncService;
            startedSyncService.start();
            wsServer = new VoiceAssistantWebSocketServer(
              httpServer,
              logger,
              serverId,
              agentManager,
              agentStorage,
              downloadTokenStore,
              config.neolixHome,
              daemonConfigStore,
              mcpBaseUrl,
              {
                getAllowedOrigins: () => allowedOrigins,
                getHostnames: () => configuredHostnames,
                daemonStatusRpc: dependencies.serverFeatureOverrides?.daemonStatusRpc,
                relayConfig: dependencies.serverFeatureOverrides?.relayConfig,
                llmGateway: {
                  configStore: gatewayConfigStore,
                  ledger: gatewayLedger,
                  runtime: gatewayRuntime,
                  masker: gatewayMasker,
                  maskingRecords: gatewayMaskingRecords,
                  maskingLocalModel: gatewayMaskingLocalModel,
                  quotaHistory: gatewayQuotaHistory,
                  usagePoller,
                  warmup: gatewayWarmup,
                  checkin: gatewayCheckin,
                  turnTracker: gatewayTurnTracker,
                  archive: gatewayArchive,
                  history: gatewayHistory,
                },
                startPaused: true,
              },
              workspaceAutoName,
              workspaceRuntimeStore,
              daemonAuth,
              speechService,
              terminalManager,
              {
                finalTimeoutMs: config.dictationFinalTimeoutMs,
              },
              daemonVersion,
              (intent) => {
                try {
                  config.onLifecycleIntent?.(intent);
                } catch (error) {
                  logger.error({ err: error, intent }, "Failed to handle daemon lifecycle intent");
                }
              },
              projectRegistry,
              workspaceRegistry,
              scheduleService,
              checkoutDiffManager,
              serviceProxy,
              scriptRuntimeStore,
              handleBranchChange,
              () => (boundListenTarget?.type === "tcp" ? boundListenTarget.port : null),
              () => (boundListenTarget?.type === "tcp" ? boundListenTarget.host : null),
              (hostname) => scriptHealthMonitor.getHealthForHostname(hostname),
              workspaceGitService,
              github,
              config.pushNotificationSender,
              providerSnapshotManager,
              {
                listen: formatListenTarget(boundListenTarget ?? listenTarget),
                worktreesRoot: config.worktreesRoot,
                get appBaseUrl() {
                  return appBaseUrl;
                },
                desktopManaged: config.desktopManaged === true,
                getRelayConfig: () => ({
                  ...(relayRuntime?.getConfig() ?? {
                    enabled: daemonConfigStore.get().relay?.enabled ?? relayEnabled,
                    endpoint: relayEndpoint,
                    publicEndpoint: relayPublicEndpoint,
                    useTls: relayUseTls,
                    publicUseTls: relayPublicUseTls,
                  }),
                  requireProtectedSecurity:
                    daemonConfigStore.get().relay?.requireProtectedSecurity === true,
                }),
              },
              serviceProxyPublicBaseUrl,
              browserToolsBroker,
              hubRelationships,
              workspaceSetupRuntime,
              pluginRuntime,
              orchestrationSkills,
              workspaceLabelService,
              startedSyncService,
            );
            agentManager.setLibraryMcpServersProvider(
              (agentId) => wsServer?.getLibraryService().mcpServersForAgent(agentId) ?? {},
            );
            wsServer.getLibraryService().setHub({
              baseUrl: () => {
                const target = boundListenTarget;
                if (target?.type !== "tcp") {
                  return null;
                }
                const reported = target.host.trim();
                const wildcard =
                  reported === "" ||
                  reported === "0.0.0.0" ||
                  reported === "::" ||
                  reported === "::0";
                const host = wildcard ? "127.0.0.1" : reported;
                return `http://${host.includes(":") ? `[${host}]` : host}:${target.port}`;
              },
              keyForAgent: (agent) => ensureHubGatewayKey(gatewayConfigStore, agent),
            });
            wsServer.getLibraryService().setMcpauth(mcpauth);
            // The library warmed before the sign-ins were wired: give every
            // agent the relayed address now, not at the next library edit.
            void wsServer
              .getLibraryService()
              .resync()
              .catch((error: unknown) => {
                logger.warn({ err: error }, "Cannot give the agents their MCP sign-ins");
              });
            pluginRuntime.bindNeolixSessionHost(wsServer);
            await pluginRuntime.start();
            const syncPluginProviderModels = async (): Promise<void> => {
              const gatewayConfig = gatewayConfigStore.get();
              const providers = [...gatewayConfig.providers];
              let changed = false;
              for (let index = 0; index < providers.length; index++) {
                const provider = providers[index];
                if (
                  provider === undefined ||
                  provider.plugin === undefined ||
                  provider.models.length > 0
                ) {
                  continue;
                }
                try {
                  const models = await pluginRuntime.subscriptionModels(
                    provider.plugin.pluginId,
                    provider.plugin.providerId,
                    provider.accounts[0]?.id ?? provider.id,
                  );
                  if (models.length === 0) continue;
                  const built: NonNullable<(typeof provider)["models"]> = [];
                  for (const model of models) {
                    const entry: (typeof built)[number] = { id: model.id };
                    if (model.name !== undefined) entry.label = model.name;
                    if (model.context !== undefined) entry.contextWindow = model.context;
                    if (model.maxOutput !== undefined) entry.maxOutputTokens = model.maxOutput;
                    if (model.images !== undefined) entry.images = model.images;
                    built.push(entry);
                  }
                  providers[index] = { ...provider, models: built };
                  changed = true;
                } catch (error) {
                  logger.warn(
                    { err: error, provider: provider.id },
                    "Cannot read a plugin provider's models",
                  );
                }
              }
              if (changed) await gatewayConfigStore.write({ ...gatewayConfig, providers });
            };
            void syncPluginProviderModels();
            pluginRuntime.subscribe(() => {
              void syncPluginProviderModels();
            });
            providerSnapshotManager.settlePluginProviders();
            // Registrations before this point left out providers that extend a plugin provider.
            // Rebuild once now so they exist, and a bad `extends` is logged at startup.
            syncPluginProviders();
            restartRecovery.resumePending();
            await finishSubscriptions.start();
            wsServer.beginAcceptingConnections();
            const relaySecurityLogger = logger.child({ module: "relay-security" });
            relayRuntime = createRelayRuntime({
              config: {
                enabled: relayEnabled,
                endpoint: relayEndpoint,
                publicEndpoint: relayPublicEndpoint,
                useTls: relayUseTls,
                publicUseTls: relayPublicUseTls,
              },
              logger,
              attachSocket: (ws, metadata) =>
                admitSecuredRelaySocket(
                  ws,
                  {
                    daemonKeyPair: daemonKeyPair.keyPair,
                    logger: relaySecurityLogger,
                    requireProtectedMode: () =>
                      daemonConfigStore.get().relay?.requireProtectedSecurity === true,
                  },
                  async (secured) => {
                    if (!wsServer) throw new Error("WebSocket server is not ready");
                    await wsServer.attachExternalSocket(secured.socket, {
                      ...metadata,
                      transport: "relay",
                      securityMode: secured.securityMode,
                    });
                  },
                ),
              serverId,
            });
            // There is no default relay: without a configured endpoint it stays off.
            daemonConfigStore.onFieldChange("relay.enabled", (value) => {
              relayRuntime?.setEnabled(value === true && relayEndpoint.length > 0);
            });
            await hubRelationships.start();
          };

          logAndResolve().then(resolve, reject);
        };
        httpServer.once("error", onError);
        httpServer.once("listening", onListening);

        startHttpServerListen(httpServer, listenTarget, inherited);
      });

      // Start speech service after listening so synchronous Sherpa native
      // model loading doesn't block the server from accepting connections.
      speechService.start();
      scriptHealthMonitor.start();
      // The web app is a client of this daemon, so it connects once the daemon accepts
      // connections. Its startup never holds the daemon's up; until it is ready its
      // routes answer 503.
      if (boundListenTarget) {
        void webApp.start(daemonAddressForWebApp(boundListenTarget), (socket) => {
          if (!wsServer) throw new Error("WebSocket server is not ready");
          return wsServer.attachWebAppSocket(socket);
        });
      }
    } catch (error) {
      localCredential = null;
      await deleteLocalCredential(config.neolixHome);
      unsubscribePluginProviders();
      unsubscribePluginSessionChanges();
      await pluginRuntime.stopAllPlugins().catch(() => undefined);
      await serviceProxy.stopStandalone().catch(() => undefined);
      await agentProviderRuntime.shutdown().catch(() => undefined);
      if (mainStarted) {
        httpServer.closeAllConnections();
        await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      }
      throw error;
    }
  };

  const stop = async (options?: { keepTerminals?: boolean }) => {
    const keepTerminals = options?.keepTerminals === true;
    let terminalShutdownError: unknown = null;
    // First, while the daemon still answers: the web app's own client says goodbye.
    await webApp.dispose();
    localCredential = null;
    await deleteLocalCredential(config.neolixHome);
    // Stop tracking plugin provider registrations before anything tears plugins
    // down, so plugin shutdown cannot withdraw a provider from under an agent
    // that is still open. Plugins themselves are stopped once every session
    // they serve has been closed, further down.
    unsubscribePluginProviders();
    unsubscribePluginSessionChanges();
    await hubRelationships.stop();
    await workspaceReconciliation.dispose();
    // The gateway's timers outlive their service unless they are told to stop:
    // a stopped daemon must not keep polling a vendor's usage endpoint.
    await usagePoller.dispose();
    await telemetry.stopAndDrain();
    clearInterval(gatewayWindowBridge);
    disposeRestProbe();
    webPage?.dispose();
    webPage = null;
    gatewayWarmup.dispose();
    await gatewaySignInSwitch.dispose();
    gatewayListRefresh.dispose();
    gatewayCodexResets.dispose();
    // Their saves are debounced; awaiting them finishes the write now rather
    // than after the daemon has stopped.
    await gatewayAffinity.dispose();
    await gatewayRests.dispose();
    await claudeBridge.abortAll();
    await gatewayPricing.dispose();
    await gatewayVision.dispose();
    await gatewayHistory.dispose();
    await gatewayArchive.dispose();
    scriptHealthMonitor.stop();
    unsubscribeIdleRuntimeCleanup();
    await idleRuntimeCleanup.close();
    // Freeze both ingress and registration before taking the agent closure snapshot.
    wsServer?.prepareForShutdown();
    await finishSubscriptions.close();
    await wsServer?.agentMessages.close();
    agentManager.prepareForShutdown();
    await restartRecovery.captureRunningAgents();
    await closeAllAgents(logger, agentManager);
    await withTimeout({
      promise: pluginRuntime.drainEvents(),
      timeoutMs: AGENT_CLOSE_TIMEOUT_MS,
      label: "drain plugin lifecycle events",
    }).catch((error) => logger.warn({ err: error }, "Plugin lifecycle events did not finish"));
    await agentManager.flushForShutdown().catch(() => undefined);
    detachAgentStoragePersistence();
    await agentStorage.flush().catch(() => undefined);
    await agentProviderRuntime.shutdown();
    releasePluginUpstream();
    releaseGatewayMiddleware();
    releaseGatewayUsageObserver();
    releaseGatewayStrategy();
    await pluginRuntime.stopAllPlugins();
    try {
      if (keepTerminals) {
        await terminalManager.detach();
        logger.info("Terminals left running for the next daemon");
      } else {
        await terminalManager.closeTerminals();
      }
    } catch (error) {
      // Finish the rest of the shutdown, then report it: the supervisor and `daemon stop`
      // retry the cleanup from the record the reaper kept.
      terminalShutdownError = error;
      logger.error({ err: error }, "Terminal shutdown failed");
    }
    await speechService.stop();
    await scheduleService.stop().catch(() => undefined);
    await relayRuntime?.stop().catch(() => undefined);
    if (syncService) {
      await syncService.stop();
    }
    if (wsServer) {
      await wsServer.close();
    }
    // Responses sockets end after their turn in flight; Codex opens a new one
    // to the gateway serving the port then, and sends the conversation whole.
    await gatewayResponses.drain();
    await serviceProxy.stopStandalone();
    // Force-drop remaining sockets so httpServer.close() resolves promptly.
    // We've already closed wsServer (which sent ws-layer close frames) and
    // stopped every other service, so anything still attached is a TCP
    // socket whose higher-level shutdown hasn't fully released it (e.g.
    // upgraded WS sockets in the closing handshake, or HTTP keep-alive
    // sockets in CLOSE_WAIT). closeIdleConnections() does not catch
    // upgraded sockets, so we use closeAllConnections() here.
    httpServer.closeAllConnections();
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });
    // A Codex thread keeps the address it was started on; with Codex still
    // running, leave a relay on the port this daemon just gave up so those
    // turns reach ChatGPT on Codex's own sign-in (myna's
    // `agent/codex.go:2445-2467`). Only a daemon a Codex thread reached has
    // any such thread, and test daemons must not leave processes behind.
    if (config.codexRelayOnShutdown !== false && boundListenTarget?.type === "tcp") {
      await startCodexRelayOnShutdown({
        addr: `127.0.0.1:${boundListenTarget.port}`,
        statePath: path.join(config.neolixHome, "gateway", "codex-relay.json"),
        program: process.env.NEOLIX_CLI_PATH?.trim() || "neolix",
        servedCodex,
        spawn,
        run: (program, args) =>
          promisify(execFile)(program, [...args]).then((result) => result.stdout),
      }).catch(() => undefined);
    }
    // Clean up socket files
    if (listenTarget.type === "socket" && existsSync(listenTarget.path)) {
      unlinkSync(listenTarget.path);
    }
    if (terminalShutdownError) {
      throw terminalShutdownError;
    }
  };

  return {
    config,
    agentManager,
    agentStorage,
    terminalManager,
    serviceProxy,
    scriptRuntimeStore,
    browserToolsBroker,
    start,
    stop,
    getListenTarget: () => boundListenTarget,
    getServerId: () => serverId,
  };
}

/**
 * Closing an agent asks its provider to close the session and waits for the
 * answer. A provider that never answers must not hold the daemon open, so a
 * close that outlives this deadline is abandoned; `agentProviderRuntime`
 * shutdown runs next and rejects the request that was still pending.
 */
const AGENT_CLOSE_TIMEOUT_MS = 5_000;

async function closeAllAgents(logger: Logger, agentManager: AgentManager): Promise<void> {
  const agents = agentManager.listAgents({ includeInternal: true });
  await Promise.all(
    agents.map(async (agent) => {
      try {
        await withTimeout({
          promise: agentManager.closeAgent(agent.id),
          timeoutMs: AGENT_CLOSE_TIMEOUT_MS,
          label: `close agent ${agent.id}`,
        });
      } catch (err) {
        logger.error({ err, agentId: agent.id }, "Failed to close agent");
      }
    }),
  );
}

export function connectIdleRuntimeCleanupConfig(
  store: DaemonConfigStore,
  cleanup: Pick<ReturnType<typeof createIdleRuntimeCleanup>, "setEnabled">,
): () => void {
  cleanup.setEnabled(store.get().idleRuntimeCleanup !== false);
  return store.onFieldChange("idleRuntimeCleanup", (value) => cleanup.setEnabled(value !== false));
}
