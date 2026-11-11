import { type WorkspaceRuntimeStore } from "./workspace-runtime-store/index.js";
import type { AgentMessageDelivery } from "./agent/agent-messages/index.js";
import { AgentDirectory, type BackgroundVisibility } from "./agent/directory.js";
import { ConnectedHostSession } from "./connected-hosts/index.js";
import type { ConnectedHosts } from "./connected-hosts/index.js";
import { searchTimeline } from "./agent/chat-search/index.js";
import type { BrowserToolsBroker } from "./browser-tools/broker.js";
import { BrowserAutomationHostCapabilitySchema } from "@neolix/protocol/browser-automation/capabilities";
import type {
  SessionEventSubscription,
  UsageReportEntry,
  ProviderUsage,
} from "@neolix/protocol/messages";
import { isAbsolute, join, relative } from "node:path";
import { CreationService, type CreatedAgent } from "./creation/index.js";
import type { CreationSnapshot, AgentCreateRequest } from "@neolix/protocol/messages";
import type { MessageReceipts } from "./message-receipts/index.js";
import equal from "fast-deep-equal";
import { WorkspaceSetupObservation } from "./workspace-setup-observation.js";
import { SessionDelivery, type OwnedSubscription } from "./session/owned-subscriptions/index.js";
import { sharedAgentConnectService, type AgentConnectService } from "./agent-connect/service.js";
import { sharedAgentInstallService, type AgentInstallService } from "./agent-install/service.js";
import { writeAgentWiring } from "./llm-gateway/agent-wiring.js";
import { maskHitsToWire } from "./llm-gateway/masking-wire.js";
import { EMPTY_GATEWAY_CONFIG } from "./llm-gateway/config.js";
import { saveNetworkSettings, type NetworkSettings } from "./network-settings.js";
import { currentWebPageState, webPageServer } from "./web-page.js";
import { v4 as uuidv4 } from "uuid";
import { lstat, mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import { basename, resolve, sep } from "path";
import { homedir } from "node:os";
import { CLIENT_CAPS, type ClientCapability } from "@neolix/protocol/client-capabilities";
import { formatPluginSourceReference } from "@neolix/protocol/plugin-source-reference";
import {
  serializeAgentStreamEvent,
  type AgentSnapshotPayload,
  type AgentAttachment,
  type FirstAgentContext,
  type SessionInboundMessage,
  type SessionOutboundMessage,
  type ScriptStatusUpdateMessage,
  type StartWorkspaceScriptRequest,
  type WorkspaceScriptListRequest,
  type WorkspaceScriptStartRequest,
  type WorkspaceScriptStopRequest,
  type CloseItemsRequest,
  type DirectorySuggestionsRequest,
  type ProjectPlacementPayload,
  type WorkspaceSetupSnapshot,
  type WorkspaceDescriptorPayload,
} from "./messages.js";
import type {
  TerminalManager,
  TerminalWorkspaceContributionChangedEvent,
} from "../terminal/terminal-manager.js";
import { TerminalSessionController } from "../terminal/terminal-session-controller.js";
import type { TerminalActivity } from "@neolix/protocol/terminal-activity";
import type { BinaryFrame } from "@neolix/protocol/binary-frames/index";
import {
  encodePluginEventFrame,
  encodePluginOutputFrame,
  PluginFrameOpcode,
} from "@neolix/protocol/binary-frames/index";
import { CursorError } from "./pagination/cursor.js";
import { SortablePager, type SortSpec } from "./pagination/sortable-pager.js";
import { matchesAgentHistoryQuery } from "./agent-history-search.js";
import type { SpeechToTextProvider, TextToSpeechProvider } from "./speech/speech-provider.js";
import type { TurnDetectionProvider } from "./speech/turn-detection-provider.js";
import {
  buildConfigOverrides,
  isStoredAgentProviderAvailable,
  resolveStoredAgentUpdatedAt,
  toAgentPersistenceHandle,
} from "./persistence-hooks.js";
import { ensureAgentLoaded, ensureUnarchivedAgentLoaded } from "./agent/agent-loading.js";
import {
  sendPromptToAgent,
  waitForAgentRunStartWithTimeout,
  unarchiveAgentState,
} from "./agent/agent-prompt.js";
import {
  resolveCreateAgentTitles,
  resolveFirstAgentPromptTitle,
} from "./agent/create-agent-title.js";
import { respondToAgentPermission } from "./agent/permission-response.js";
import type { VoiceCallerContext, VoiceSpeakHandler } from "./voice-types.js";
import type { ScriptHealthState } from "./script-health-monitor.js";
import { spawnWorkspaceScript } from "./worktree-bootstrap.js";
import type { WorkspaceScriptRuntimeStore } from "./workspace-script-runtime-store.js";
import {
  createWorkspaceScriptsService,
  type WorkspaceScriptsService,
} from "./session/workspace-scripts/workspace-scripts-service.js";
import type { DaemonConfigStore } from "./daemon-config-store.js";
import {
  GatewayMaskingPreviewWireSchema,
  GatewayMaskingLocalModelStatusWireSchema,
  GatewayMaskingRecordsWireSchema,
  GatewayMaskingRecordWireSchema,
  GatewayMaskingSummaryWireSchema,
  GatewayCheckinAccountWireSchema,
  GatewayCheckinEntryWireSchema,
  GatewayRouteTraceWireSchema,
  GatewayStatusWireSchema,
  GatewayReplyWireSchema,
  GatewaySearchKeyQuotaWireSchema,
  GatewayTuneAdviceWireSchema,
  GatewayTuneSettingWireSchema,
  type GatewayPriceWire,
  type GatewayProviderWire,
} from "@neolix/protocol/gateway";
import {
  readArchivedCall,
  readPromptReply,
  readPromptText,
  readRouteEvents,
  readRoutingHistory,
} from "./llm-gateway/gateway-diagnostics.js";
import { probeRecorder } from "./llm-gateway/probe-log.js";
import { maskingWanted } from "./llm-gateway/masking.js";
import { providerSearchesByItself } from "./llm-gateway/search-plan.js";
import { canReadSearchQuota, searchQuotas } from "./llm-gateway/search-quota.js";
import { tuneAdvice, tuneCalls, type TuneAdvice } from "./llm-gateway/tune.js";
import {
  applyTune,
  readTuneSetting,
  undoTune,
  type TuneAgent,
  type TuneSettingState,
} from "./llm-gateway/tune-settings.js";
import type { GatewayConfigStore, GatewayProvider } from "./llm-gateway/config.js";
import { accountDiscoveryOn, gatewayKeyEntries, providerAccounts } from "./llm-gateway/config.js";
import { servedModels } from "./llm-gateway/catalog.js";
import { peakOf } from "./llm-gateway/peak.js";
import { listHeldReports, readHeldReport, revealHeldReport } from "./llm-gateway/held-report.js";
import { resolveTitleRows } from "./llm-gateway/title-link.js";
import { configuredOidcRules } from "./llm-gateway/oidc.js";
import {
  oidcRuleWire,
  oidcRulesForConfig,
  oidcRulesWire,
  removeOidcRule,
  saveOidcRule,
} from "./llm-gateway/oidc-rules.js";
import { groupsOf } from "./llm-gateway/groups-auto.js";
import { usageModelId } from "./llm-gateway/model-prefs.js";
import {
  clockOf,
  normalizeWarmAt,
  normalizeWarmAts,
  withAccountWarmAt,
  withWarmAts,
} from "./llm-gateway/warm-at.js";
import type { PricedModel, PricingCatalog } from "./llm-gateway/pricing-catalog.js";
import { costUsd, usagePrice } from "./llm-gateway/pricing.js";
import {
  buildUsageReport,
  DEFAULT_PAGE_LIMIT,
  readUsageRecords,
  windowOf,
} from "./llm-gateway/usage-report.js";
import type { UsageRecord } from "./llm-gateway/usage.js";
import { snapshotGatewayQuota } from "./llm-gateway/quota-cards.js";
import { spendCodexReset } from "./llm-gateway/codex-reset-run.js";
import { readImportSources } from "./llm-gateway/provider-import.js";
import { readUpstreamStatuses } from "./llm-gateway/upstream-status.js";
import { readProviderBalance } from "./llm-gateway/balance.js";
import { discoverCodexAccounts, codexHomePath } from "./llm-gateway/codex-user-data.js";
import { loadCodexAccounts, redactedCodexAccounts } from "./llm-gateway/codex-accounts.js";
import {
  arrangeOwnedCodexAccounts,
  removeOwnedCodexAccount,
  setOwnedCodexAccountEnabled,
} from "./llm-gateway/codex-login.js";
import {
  importCodexAccounts,
  importCodexAccountsFromText,
  type CodexImportResult,
} from "./llm-gateway/codex-import.js";
import {
  callbackGatewaySignIn,
  cancelGatewaySignIn,
  startGatewaySignIn,
  statusGatewaySignIn,
} from "./llm-gateway/gateway-signin.js";
import {
  importGoogleAccounts,
  type ImportedSubscriptionAccount,
} from "./llm-gateway/google-import.js";
import {
  addSubscriptionAccount,
  isSubscriptionAgent,
  loadAnySubscriptionAccounts,
  redactedSubscriptionAccounts,
  saveSubscriptionAccounts,
  subscriptionAccountsFile,
  switchSubscriptionAccount,
  type SubscriptionAgent,
} from "./llm-gateway/subscription-store.js";
import { addFactoryKey } from "./llm-gateway/factory-accounts.js";
import { takeAutoIncludedModels } from "./llm-gateway/auto-include.js";
import { findClaudeBinary } from "./llm-gateway/claude/cli.js";
import { claudeModeNow } from "./llm-gateway/claude/mode.js";
import {
  detectProviderProtocols,
  fetchProviderModels,
  testProviderModel,
} from "./llm-gateway/provider-probe.js";
import { snapshotGatewayStatus, type LlmGatewayService } from "./llm-gateway/runtime.js";
import { releaseWorkspaceServicePortPlan } from "./workspace-service-port-registry.js";
import { getErrorMessage, getErrorMessageOr } from "@neolix/protocol/error-utils";
import { getAgentStatusPriority } from "@neolix/protocol/agent-state-bucket";
import { getParentAgentIdFromLabels } from "@neolix/protocol/agent-labels";
import type { WorkspaceGitRuntimeSnapshot, WorkspaceGitService } from "./workspace-git-service.js";
import type { ProjectUpdate } from "./workspace-reconciliation-service.js";
import {
  CLIENT_SHUTDOWN_RPC_REASON,
  normalizeClientRestartRpcReason,
} from "./lifecycle-reasons.js";
import { DirectorySyncService } from "./directory-sync/index.js";
import {
  assertWorkspaceAutomationAllowedForWorkspace,
  clearWorkspaceAutomationBlock,
  formatWorkspaceAutomationBlockedMessage,
} from "./workspace-automation-gate.js";
import {
  WorkspaceLabelError,
  WorkspaceLabelStorageUncertainError,
  type WorkspaceLabelService,
} from "./workspace-labels/index.js";
import { createLibraryService, type LibraryService } from "./library/index.js";
import { SyncService, type SyncEvent } from "./sync/service.js";
import { SecretsStore } from "./library/github-token.js";
import { githubSettingsRefused } from "./library/github-api.js";

import { AgentManager, AgentRunCancellationError } from "./agent/agent-manager.js";
import { buildTimelinePromptIndex } from "./agent/timeline-prompt-index.js";
import { ProviderSnapshotManager } from "./agent/provider-snapshot-manager.js";
import type {
  AgentManagerEvent,
  AgentTimelineCursor,
  AgentTimelineFetchDirection,
  AgentTimelineFetchResult,
  ManagedAgent,
} from "./agent/agent-manager.js";
import { createAgentCommand } from "./agent/create-agent/create.js";
import {
  inheritAgentBackground,
  inheritWorkspaceBackground,
  resolveCreateAgentIntent,
  type CreateAgentIntent,
  type CreateAgentCaller,
} from "./agent/create-agent/intent.js";
import {
  archiveAgentCommand,
  cancelAgentRunCommand,
  closeAgentCommand,
  detachAgentCommand,
  setAgentModeCommand,
  updateAgentCommand,
} from "./agent/lifecycle-command.js";
import { buildStoredAgentPayload, toAgentPayload } from "./agent/agent-projections.js";
import { assertPluginTimelineDataSize } from "./agent/agent-timeline-content.js";
import { parsePluginClientId } from "./plugins/plugin-session-identity.js";
import { buildAgentForkContextAttachment } from "./agent/activity-curator.js";
import { buildAgentPrompt } from "./agent/prompt-attachments.js";
import type { StructuredGenerationDaemonConfig } from "./agent/structured-generation-providers.js";
import {
  getAgentStreamEventTurnId,
  type AgentPersistenceHandle,
  type AgentPermissionResponse,
  type AgentRunOptions,
  type AgentSessionConfig,
} from "./agent/agent-sdk-types.js";
import type { StoredAgentRecord } from "./agent/agent-storage.js";
import type { AgentStorage } from "./agent/agent-storage.js";
import {
  ImportSessionsRequestError,
  importProviderSession,
  listImportableProviderSessions,
  normalizeImportAgentRequest,
} from "./agent/import-sessions.js";
import { listProjectSuggestions, ProjectSuggestionsRequestError } from "./project-suggestions.js";
import {
  checkoutLiteFromGitSnapshot,
  checkoutFromPersistedWorkspacePlacement,
  deriveWorkspaceDisplayName,
} from "./workspace-registry-model.js";
import { resolveWorkspaceIdForPath } from "./resolve-workspace-id-for-path.js";
import {
  resolveProjectDisplayName,
  resolveWorkspaceDisplayName,
  resolveWorkspaceName,
  type PersistedProjectRecord,
  type PersistedWorkspaceRecord,
  type ProjectMutation,
  type ProjectRegistry,
  type WorkspaceMutation,
  type WorkspaceRegistry,
} from "./workspace-registry.js";
import { wrapSpokenInput } from "./voice-config.js";
import { isVoicePermissionAllowed } from "./voice-permission-policy.js";
import {
  ProjectIconReader,
  removeProjectCustomIcon,
  setProjectCustomIcon,
} from "../utils/project-custom-icon.js";
import { VoiceSessions } from "./session/voice/index.js";
import { CheckoutSession } from "./session/checkout/checkout-session.js";
import {
  createWorkspaceGitObserverService,
  type WorkspaceGitObserverService,
} from "./session/workspace-git-observer/workspace-git-observer-service.js";
import {
  createAgentStructuredTextGeneration,
  createGitMetadataGenerator,
} from "./session/checkout/git-metadata-generator.js";
import { ScheduleSession } from "./session/schedule/schedule-session.js";
import { ProviderCatalogSession } from "./session/provider/provider-catalog-session.js";
import { UsageSession } from "./session/usage/usage-session.js";
import { ExternalSessionsService } from "./external-sessions/service.js";
import { ExternalSessionsSession } from "./external-sessions/external-sessions-session.js";
import {
  foundSessionAgents,
  sessionReadsOf,
  sessionReadsSnapshot,
  setSessionReads,
} from "./external-sessions/session-reads.js";
import { listTerminals, openInTerminal } from "./external-sessions/terminals.js";
import { GatewayConversations } from "./llm-gateway/conversations.js";
import {
  SpeechModelsSession,
  type SpeechModelsSessionOptions,
} from "./session/speech/speech-models-session.js";
import { WorkspaceFilesSession } from "./session/files/workspace-files-session.js";
import { AgentConfigSession } from "./session/agent-config/agent-config-session.js";
import { ProjectConfigSession } from "./session/project-config/project-config-session.js";
import { DaemonSession, type DaemonRuntimeConfig } from "./session/daemon/daemon-session.js";
import type { DaemonWebSocketRuntimeDiagnosticSnapshot } from "./session/daemon/diagnostics.js";
import type { HubRelationshipManagement } from "./hub/relationship-controller.js";
import { HubExecutionController } from "./hub/execution-controller.js";
import type { HubExecutionAgents } from "./hub/daemon-executions.js";
import { DownloadTokenStore } from "./file-download/token-store.js";
import type { PushNotifications } from "./push/index.js";
import {
  archivePersistedWorkspaceRecord,
  archiveWorkspaceContents,
} from "./workspace-archive-service.js";
import type { ServiceProxySubsystem } from "./service-proxy.js";
import { renameCurrentBranch as renameCurrentBranchDefault } from "../utils/checkout-git.js";
import {
  createGitMutationService,
  type GitMutationService,
} from "./session/git-mutation/git-mutation-service.js";
import {
  createWorkspaceProvisioningService,
  type WorkspaceProvisioningService,
} from "./session/workspace-provisioning/workspace-provisioning-service.js";
import {
  createWorkspaceRecoveryService,
  type WorkspaceRecoveryService,
} from "./session/workspace-recovery/workspace-recovery-service.js";
import {
  createAgentUpdatesService,
  matchesAgentUpdatesFilter,
  type AgentUpdatesService,
} from "./session/agent-updates/agent-updates-service.js";
import { expandTilde } from "../utils/path.js";
import {
  searchDirectoryEntries,
  WORKSPACE_SEARCH_HIDDEN_DIRECTORIES,
} from "../utils/directory-suggestions.js";
import type { CheckoutDiffManager } from "./checkout-diff-manager.js";
import type { Resolvable } from "./speech/provider-resolver.js";
import type { SpeechReadinessSnapshot } from "./speech/speech-runtime.js";
import type pino from "pino";
import { ScheduleService } from "./schedule/service.js";
import {
  createGitHubService,
  GitHubAuthenticationError,
  GitHubCliMissingError,
  GitHubCommandError,
  type GitHubService,
} from "../services/github-service.js";
import type { ForgeService } from "../services/forge-service.js";
import {
  resolveWorkspaceRootAgent,
  summarizeFetchWorkspacesEntries,
  workspaceIdsOnCheckout,
  WorkspaceDirectory,
  type WorkspaceUpdatesFilter,
} from "./workspace-directory.js";
import { shouldEmitPendingBootstrapUpdate } from "./workspace-bootstrap-dedupe.js";
import {
  createNeolixWorktree,
  type CreateNeolixWorktreeInput,
  type CreateNeolixWorktreeResult,
} from "./neolix-worktree-service.js";
import { WorkspaceAutoName } from "./workspace-auto-name.js";
import {
  createNeolixWorktreeWorkflow as createWorktreeWorkflow,
  type CreateNeolixWorktreeWorkflowResult,
  handleCreateNeolixWorktreeRequest as handleCreateWorktreeRequest,
  handleNeolixWorktreeArchiveRequest as handleWorktreeArchiveRequest,
  handleNeolixWorktreeListRequest as handleWorktreeListRequest,
  handleWorkspaceSetupStatusRequest as handleWorkspaceSetupStatusRequestMessage,
  handleWorkspaceSetupRunRequest as handleWorkspaceSetupRunRequestMessage,
} from "./worktree-session.js";
import { archiveByScope, type ActiveWorkspaceRef } from "./workspace-archive-service.js";
import { WorkspaceSetupRuntime } from "./workspace-setup-runtime.js";
import { SessionAuthorization, type DaemonPermission } from "./authorization/index.js";

function resolveWorkspaceSetupRuntime(
  runtime: WorkspaceSetupRuntime | undefined,
): WorkspaceSetupRuntime {
  return runtime ?? new WorkspaceSetupRuntime();
}
import { WorktreeRequestError, toWorktreeWireError } from "./worktree-errors.js";
import { parseGitRemoteLocation } from "@neolix/protocol/git-remote";
import {
  createProjectDirectory,
  ProjectDirectoryRequestError,
} from "./project-directory-service.js";
import { runGitCommand } from "../utils/run-git-command.js";
import { CreateAgentLifecycleDispatch } from "./agent/create-agent-lifecycle-dispatch.js";
import { resolveWorktreeSourceCwd } from "./workspace-source.js";

type ProviderSubagentManagerEvent = Extract<
  AgentManagerEvent,
  { type: "provider_subagent" }
>["event"];

// TODO: Remove once all app store clients are on >=0.1.45 and understand arbitrary provider strings.
// Clients before 0.1.45 validate providers with z.enum(["claude", "codex", "opencode"]) and reject
// the entire session message if they encounter an unknown provider.
const LEGACY_PROVIDER_IDS = new Set(["claude", "codex", "opencode"]);
const MIN_VERSION_ALL_PROVIDERS = "0.1.45";
const MIN_VERSION_EXPLICIT_WORKSPACE_RECOVERY = "0.1.105";
function errorToFriendlyMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Unknown error";
}

function isAppVersionAtLeast(appVersion: string | null, minVersion: string): boolean {
  if (!appVersion) return false;
  // Strip prerelease suffix: "0.1.45-beta.4" -> "0.1.45"
  const base = appVersion.replace(/-.*$/, "");
  const parts = base.split(".").map(Number);
  const minParts = minVersion.split(".").map(Number);
  for (let i = 0; i < minParts.length; i++) {
    const a = parts[i] ?? 0;
    const b = minParts[i] ?? 0;
    if (a > b) return true;
    if (a < b) return false;
  }
  return true;
}

function clientSupportsAllProviders(appVersion: string | null): boolean {
  return isAppVersionAtLeast(appVersion, MIN_VERSION_ALL_PROVIDERS);
}

function clientUsesLegacyWorkspaceRestore(appVersion: string | null): boolean {
  return (
    appVersion !== null && !isAppVersionAtLeast(appVersion, MIN_VERSION_EXPLICIT_WORKSPACE_RECOVERY)
  );
}

type DeleteFencedAgentStorage = AgentStorage & {
  beginDelete(agentId: string): void;
};

function beginAgentDeleteIfSupported(agentStorage: AgentStorage, agentId: string): void {
  if ("beginDelete" in agentStorage && typeof agentStorage.beginDelete === "function") {
    (agentStorage as DeleteFencedAgentStorage).beginDelete(agentId);
  }
}

const FETCH_AGENTS_SORT_KEYS = ["status_priority", "created_at", "updated_at", "title"] as const;

export function resolveWaitForFinishError(options: {
  status: "permission" | "error" | "idle";
  final: AgentSnapshotPayload | null;
}): string | null {
  if (options.status !== "error") {
    return null;
  }
  const message = options.final?.lastError;
  return typeof message === "string" && message.trim().length > 0 ? message : "Agent failed";
}

export interface SessionRuntimeMetrics {
  terminalDirectorySubscriptionCount: number;
  terminalSubscriptionCount: number;
  workspaceGitWatchedDirectoryCount: number;
  workspaceGitWorkspaceRecordCount: number;
  workspaceGitSubscriptionCount: number;
  inflightRequests: number;
  peakInflightRequests: number;
}

type FetchAgentsRequestMessage = Extract<SessionInboundMessage, { type: "fetch_agents_request" }>;
type FetchAgentHistoryRequestMessage = Extract<
  SessionInboundMessage,
  { type: "fetch_agent_history_request" }
>;
type AgentDirectoryRequestMessage = FetchAgentsRequestMessage | FetchAgentHistoryRequestMessage;

/**
 * Only history carries a query. The active-agents directory filters on
 * structure and never ranks, so it always reads as no query at all.
 */
function agentDirectorySearchQuery(request: AgentDirectoryRequestMessage): string {
  if (request.type !== "fetch_agent_history_request") return "";
  return request.search?.trim() ?? "";
}
type FetchAgentsRequestFilter = NonNullable<FetchAgentsRequestMessage["filter"]>;
type FetchAgentsRequestSort = NonNullable<FetchAgentsRequestMessage["sort"]>[number];
type FetchAgentsResponsePayload = Extract<
  SessionOutboundMessage,
  { type: "fetch_agents_response" }
>["payload"];
type FetchAgentsResponseEntry = FetchAgentsResponsePayload["entries"][number];
type FetchAgentsResponsePageInfo = FetchAgentsResponsePayload["pageInfo"];
type AgentUpdatesFilter = FetchAgentsRequestFilter;
type CreateAgentRequestMessage = Extract<SessionInboundMessage, { type: "create_agent_request" }>;

interface ResolvedSessionCreateAgentIntent {
  config: AgentSessionConfig;
  intent: CreateAgentIntent;
  background: boolean;
  createdDirectoryWorkspace: boolean;
}

type FetchWorkspacesRequestMessage = Extract<
  SessionInboundMessage,
  { type: "fetch_workspaces_request" }
>;
type FetchWorkspacesRequestFilter = NonNullable<FetchWorkspacesRequestMessage["filter"]>;
type FetchWorkspacesResponsePayload = Extract<
  SessionOutboundMessage,
  { type: "fetch_workspaces_response" }
>["payload"];
type FetchWorkspacesResponseEntry = FetchWorkspacesResponsePayload["entries"][number];
type FetchWorkspacesResponsePageInfo = FetchWorkspacesResponsePayload["pageInfo"];
type WorkspaceProjectDescriptorPayload = FetchWorkspacesResponsePayload["emptyProjects"][number];
type WorkspaceGithubSearchRepositoriesResponsePayload = Extract<
  SessionOutboundMessage,
  { type: "workspace.github.search_repositories.response" }
>["payload"];
type WorkspaceUpdatePayload = Extract<
  SessionOutboundMessage,
  { type: "workspace_update" }
>["payload"];
interface WorkspaceUpdatesSubscriptionState {
  subscriptionId: string;
  owner: OwnedSubscription;
  syncEnabled?: boolean;
  filter?: WorkspaceUpdatesFilter;
  isBootstrapping: boolean;
  pendingUpdatesByWorkspaceId: Map<string, WorkspaceUpdatePayload>;
  lastEmittedByWorkspaceId: Map<string, WorkspaceUpdatePayload>;
  visibleEmptyProjectIds?: Set<string>;
}

class SessionRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SessionRequestError";
  }
}

export interface SessionFileSystem {
  isDirectory(path: string): Promise<boolean>;
}

const nodeSessionFileSystem: SessionFileSystem = {
  async isDirectory(path) {
    const stats = await stat(path).catch(() => null);
    return stats?.isDirectory() ?? false;
  },
};

// Stub types for features under development (modules not yet available)
type AgentMcpTransportFactory = () => Promise<unknown>;

export interface SessionOptions {
  connectedHosts?: ConnectedHosts;
  sourceId?: string;
  routed?: boolean;
  /** The connection came from a browser page (an Origin header was sent). */
  browserOrigin?: boolean;
  browserToolsBroker?: BrowserToolsBroker | null;
  clientId: string;
  permissions: readonly DaemonPermission[];
  appVersion?: string | null;
  clientCapabilities?: Record<string, unknown> | null;
  onMessage: (msg: SessionOutboundMessage) => void;
  onMessageToSource?: (source: object, msg: SessionOutboundMessage) => void | Promise<void>;
  onBinaryMessage?: (frame: Uint8Array) => void;
  onBinaryMessageToSource?: (source: object, frame: Uint8Array) => Promise<void>;
  getTransportBufferedAmount?: (source?: object) => number | null;
  getConnectedHostBufferedAmount?: () => number | null;
  onLifecycleIntent?: (intent: SessionLifecycleIntent) => void;
  onWorkspaceRecovered?: (workspace: PersistedWorkspaceRecord) => Promise<void>;
  publishScriptStatusUpdate?: (message: ScriptStatusUpdateMessage) => void;
  logger: pino.Logger;
  downloadTokenStore: DownloadTokenStore;
  pushNotifications: PushNotifications;
  neolixHome: string;
  worktreesRoot?: string;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  messageReceipts: Pick<MessageReceipts, "send">;
  agentMessages: AgentMessageDelivery;
  creationService: Pick<CreationService, "create" | "subscribe">;
  projectRegistry: ProjectRegistry;
  workspaceRegistry: WorkspaceRegistry;
  directorySync?: DirectorySyncService;
  workspaceLabelService?: WorkspaceLabelService;
  /** Tests inject one whose home is a temp folder. */
  libraryService?: LibraryService;
  /** The daemon's sync, when one was started; a session otherwise makes its own. */
  syncService?: SyncService;
  filesystem?: SessionFileSystem;
  scheduleService: ScheduleService;
  checkoutDiffManager: CheckoutDiffManager;
  github?: ForgeService;
  createAgentMcpTransport?: AgentMcpTransportFactory;
  // Injected so tests can substitute the git branch rename without module mocks;
  // defaults to the real checkout-git implementation.
  renameCurrentBranch?: typeof renameCurrentBranchDefault;
  workspaceGitService: WorkspaceGitService;
  workspaceRuntimeStore: WorkspaceRuntimeStore;
  workspaceAutoName: WorkspaceAutoName;
  daemonConfigStore: DaemonConfigStore;
  llmGateway?: import("./llm-gateway/runtime.js").LlmGatewayService;
  pluginRuntime?: {
    wait: import("./plugins/lifecycle/index.js").PluginLifecycle["wait"];
    before: import("./plugins/lifecycle/index.js").PluginLifecycle["before"];
    emit: import("./plugins/lifecycle/index.js").PluginLifecycle["emit"];
    listPlugins(): Promise<import("@neolix/protocol/messages").PluginListItem[]>;
    listBuiltinPluginIds(): string[];
    getPluginMarket(): Promise<import("./plugins/market.js").PluginMarket>;
    searchPluginMarket(
      query: string,
      options: { mirror?: boolean },
    ): Promise<import("./plugins/market.js").PluginMarketSearchHit[]>;
    getPluginReadme(
      source: import("@neolix/protocol/messages").PluginReadmeSource,
      locale?: string,
    ): Promise<string>;
    getProviderContributions(): Array<{ pluginId: string; providers: string[] }>;
    listSubscriptionProviders?: import("./plugins/index.js").PluginService["listSubscriptionProviders"];
    subscriptionModels?: import("./plugins/index.js").PluginService["subscriptionModels"];
    subscriptionSignIn?: import("./plugins/index.js").PluginService["subscriptionSignIn"];
    subscriptionSignInPoll?: import("./plugins/index.js").PluginService["subscriptionSignInPoll"];
    listAgentIntegrations?: import("./plugins/index.js").PluginService["listAgentIntegrations"];
    wireAgentIntegration?: import("./plugins/index.js").PluginService["wireAgentIntegration"];
    listSearchApis(): Array<{
      vendor: string;
      name: string;
      keysURL?: string;
      keyOptional?: boolean;
      needURL?: boolean;
    }>;
    getLogs(pluginId: string): import("@neolix/protocol/messages").PluginLogEntry[];
    getWebAsset(
      pluginId: string,
      assetPath: string,
    ): Promise<{
      pluginId: string;
      path: string;
      contentType: import("@neolix/protocol/messages").PluginWebAssetContentType;
      encoding: "utf8" | "base64";
      content: string;
    }>;
    installDirectory(input: {
      path: string;
      id?: string;
    }): Promise<import("@neolix/protocol/messages").PluginListItem>;
    inspectDirectory(path: string): Promise<{ id: string }>;
    installSource(input: {
      source: string;
      id?: string;
      ref?: string;
    }): Promise<import("@neolix/protocol/messages").PluginListItem>;
    statusSources(
      pluginId?: string,
    ): Promise<import("@neolix/protocol/messages").PluginSourceStatusItem[]>;
    previewUpdates(input: {
      pluginId?: string;
      target?: import("@neolix/protocol/messages").PluginUpdateSelection;
    }): Promise<import("@neolix/protocol/messages").PluginUpdatePreview[]>;
    applyUpdates(
      proposals: import("@neolix/protocol/messages").PluginUpdateProposal[],
    ): Promise<import("@neolix/protocol/messages").PluginUpdateResult[]>;
    updateSources(
      pluginId?: string,
    ): Promise<import("@neolix/protocol/messages").PluginSourceUpdateItem[]>;
    reloadPlugin(pluginId: string): Promise<import("@neolix/protocol/messages").PluginListItem>;
    enablePlugin(pluginId: string): Promise<import("@neolix/protocol/messages").PluginListItem>;
    disablePlugin(pluginId: string): Promise<import("@neolix/protocol/messages").PluginListItem>;
    removePlugin(pluginId: string): Promise<void>;
    subscribe(listener: (pluginId: string) => void): () => void;
    subscribeSettings?(listener: (pluginId: string, settingsId: string) => void): () => void;
    catalog(): Array<{ id: string; clientBundle: string; clientBundleHash?: string }>;
    invokePluginRpc(pluginId: string, method: string, input: unknown): Promise<unknown>;
    subscribePluginRpc(
      pluginId: string,
      method: string,
      input: unknown,
    ): import("./plugins/runtime-subscription.js").PluginRuntimeSubscription;
    listUsageReports(options?: {
      forceRefresh?: boolean;
      reportIds?: string[];
    }): Promise<UsageReportEntry[]>;
    listLegacyUsage(): Promise<{ fetchedAt: string; providers: ProviderUsage[] }>;
  };
  orchestrationSkills?: import("./orchestration-skills/index.js").OrchestrationSkills;
  mcpBaseUrl?: string | null;
  stt: Resolvable<SpeechToTextProvider | null>;
  sttLanguage?: string;
  tts: Resolvable<TextToSpeechProvider | null>;
  speechModels?: SpeechModelsSessionOptions["runtime"];
  terminalManager: TerminalManager | null;
  providerSnapshotManager: ProviderSnapshotManager;
  hubExecutionAgents?: HubExecutionAgents;
  hubRelationships?: HubRelationshipManagement;
  serviceProxy?: ServiceProxySubsystem;
  scriptRuntimeStore?: WorkspaceScriptRuntimeStore;
  workspaceSetupObservation?: WorkspaceSetupObservation;
  workspaceSetupRuntime?: WorkspaceSetupRuntime;
  onBranchChanged?: (
    workspaceId: string,
    oldBranch: string | null,
    newBranch: string | null,
  ) => void;
  getDaemonTcpPort?: () => number | null;
  getDaemonTcpHost?: () => string | null;
  serviceProxyPublicBaseUrl?: string | null;
  resolveScriptHealth?: (hostname: string) => ScriptHealthState | null;
  voice?: {
    turnDetection?: Resolvable<TurnDetectionProvider | null>;
  };
  voiceBridge?: {
    registerVoiceSpeakHandler?: (agentId: string, handler: VoiceSpeakHandler) => void;
    unregisterVoiceSpeakHandler?: (agentId: string) => void;
    registerVoiceCallerContext?: (agentId: string, context: VoiceCallerContext) => void;
    unregisterVoiceCallerContext?: (agentId: string) => void;
  };
  dictation?: {
    finalTimeoutMs?: number;
    stt?: Resolvable<SpeechToTextProvider | null>;
    sttLanguage?: string;
    getSpeechReadiness?: () => SpeechReadinessSnapshot;
  };
  serverId?: string;
  daemonVersion?: string;
  daemonRuntimeConfig?: DaemonRuntimeConfig;
  getWebSocketRuntimeMetrics?: () => DaemonWebSocketRuntimeDiagnosticSnapshot | null;
}

export type SessionLifecycleIntent =
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

function parseClientCapabilities(
  capabilities: Record<string, unknown> | null | undefined,
): ReadonlySet<ClientCapability> {
  if (!capabilities) {
    return new Set();
  }
  const known = new Set<ClientCapability>(Object.values(CLIENT_CAPS));
  const result: ClientCapability[] = [];
  for (const [key, value] of Object.entries(capabilities)) {
    if (value === true && known.has(key as ClientCapability)) {
      result.push(key as ClientCapability);
    }
  }
  return new Set(result);
}

function sessionRequestId(message: SessionInboundMessage): string | null {
  if ("requestId" in message && typeof message.requestId === "string") {
    return message.requestId;
  }
  if (
    "payload" in message &&
    typeof message.payload === "object" &&
    message.payload !== null &&
    "requestId" in message.payload &&
    typeof message.payload.requestId === "string"
  ) {
    return message.payload.requestId;
  }
  return null;
}

type RegistryTransition = "created" | "unarchived" | "existing";

interface ArchivedRecordSnapshot {
  archivedAt?: string | null;
}

interface WorkspaceUpdateOptions {
  removedProjectId?: string;
  optimisticStatus?: WorkspaceDescriptorPayload["status"];
}

function resolveDirectorySync(service: DirectorySyncService | undefined): DirectorySyncService {
  return service ?? new DirectorySyncService();
}

function describeRegistryTransition(record: ArchivedRecordSnapshot | null): RegistryTransition {
  if (!record) {
    return "created";
  }
  return record.archivedAt ? "unarchived" : "existing";
}

/**
 * Session represents a single connected client session.
 * It owns all state management, orchestration logic, and message processing.
 * Session has no knowledge of WebSockets - it only emits and receives messages.
 */
function resolveWorkspaceLabelService(
  service: WorkspaceLabelService | undefined,
): WorkspaceLabelService | null {
  return service ?? null;
}

function hasInitialCreationPrompt(
  request?: Pick<AgentCreateRequest, "initialPrompt" | "images" | "attachments">,
): boolean {
  return Boolean(
    request &&
    buildAgentPrompt(request.initialPrompt?.trim() ?? "", request.images, request.attachments)
      .length,
  );
}

function workspaceLabelErrorCode(error: unknown): string {
  if (
    error instanceof WorkspaceLabelError ||
    error instanceof WorkspaceLabelStorageUncertainError ||
    error instanceof SessionRequestError
  ) {
    return error.code;
  }
  return "workspace_label_failed";
}

interface ClientActivity {
  deviceType: "web" | "mobile";
  focusedAgentId: string | null;
  focusedTerminalId: string | null;
  lastActivityAt: Date;
  appVisible: boolean;
  appVisibilityChangedAt: Date;
}

type PluginMarketInboundMessage = Extract<
  SessionInboundMessage,
  {
    type:
      | "plugin.market.list.request"
      | "plugin.market.search.request"
      | "plugin.builtin.list.request"
      | "plugin.readme.get.request";
  }
>;

function isPluginMarketMessage(msg: SessionInboundMessage): msg is PluginMarketInboundMessage {
  return (
    msg.type === "plugin.market.list.request" ||
    msg.type === "plugin.market.search.request" ||
    msg.type === "plugin.builtin.list.request" ||
    msg.type === "plugin.readme.get.request"
  );
}

export class Session {
  private readonly connectedHostSession: ConnectedHostSession | null;
  private routed = false;
  isRouted(): boolean {
    return this.routed;
  }
  getHostSourceId(): string {
    return this.hostSourceId;
  }
  private hostSourceId: string;
  setHostSource(sourceId: string): void {
    this.hostSourceId = sourceId;
    this.connectedHostSession?.setSource(sourceId);
  }
  setRouted(routed: boolean): void {
    this.routed = routed;
  }
  readonly delivery = new SessionDelivery(
    (source, message) => {
      if (!this.authorization.allowsOutbound(message)) return;
      if (this.onMessageToSource) return this.onMessageToSource(source, message);
      this.onMessage(message);
    },
    (source, frame) => {
      if (this.onBinaryMessageToSource) {
        return this.onBinaryMessageToSource(source, frame);
      } else this.emitBinary(frame);
    },
    (source, message) => this.workspaceSetupMessageForClient(message, source),
    (request, message) =>
      this.sessionLogger.warn(
        {
          requestType: request.type,
          messageType: message.type,
          status: message.type === "status" ? message.payload.status : undefined,
        },
        "Unrecognized reply contract; application delivery denied",
      ),
  );
  private readonly browserToolsBroker: SessionOptions["browserToolsBroker"];
  private readonly clientId: string;
  private readonly browserOrigin: boolean;

  /** Whether this connection came from a browser page, for gateway mode. */
  public get isBrowserOrigin(): boolean {
    return this.browserOrigin;
  }
  private readonly authorization: SessionAuthorization;
  private appVersion: string | null;
  private clientCapabilities: ReadonlySet<ClientCapability>;
  private readonly sessionId: string;
  private readonly onMessage: (msg: SessionOutboundMessage) => void;
  private readonly onMessageToSource:
    | ((source: object, msg: SessionOutboundMessage) => void | Promise<void>)
    | null;
  private readonly onBinaryMessage: ((frame: Uint8Array) => void) | null;
  private readonly onBinaryMessageToSource:
    | ((source: object, frame: Uint8Array) => Promise<void>)
    | null;
  private readonly getTransportBufferedAmount: (source?: object) => number | null;
  private readonly onLifecycleIntent: ((intent: SessionLifecycleIntent) => void) | null;
  private readonly onWorkspaceRecovered:
    | ((workspace: PersistedWorkspaceRecord) => Promise<void>)
    | null;
  private readonly sessionLogger: pino.Logger;
  private readonly neolixHome: string;
  private readonly projectIcons: ProjectIconReader;
  private readonly worktreesRoot: string | undefined;
  private readonly rewindInitiators = new Map<string, object | undefined>();

  private agentManager: AgentManager;
  private readonly agentStorage: AgentStorage;
  private readonly projectRegistry: ProjectRegistry;
  private readonly workspaceRegistry: WorkspaceRegistry;
  private readonly agentDirectory: AgentDirectory;
  private readonly directorySync: DirectorySyncService;
  private readonly filesystem: SessionFileSystem;
  private readonly github: ForgeService;
  private readonly renameCurrentBranch: typeof renameCurrentBranchDefault;
  private readonly workspaceGitService: WorkspaceGitService;
  private readonly workspaceRuntimeStore: WorkspaceRuntimeStore;
  private readonly workspaceAutoName: WorkspaceAutoName;
  private readonly gitMutation: GitMutationService;
  private readonly workspaceProvisioning: WorkspaceProvisioningService;
  private readonly workspaceRecovery: WorkspaceRecoveryService;
  private readonly daemonConfigStore: DaemonConfigStore;
  private readonly llmGateway?: import("./llm-gateway/runtime.js").LlmGatewayService;
  private readonly pushNotifications: PushNotifications;
  private readonly pluginRuntime: SessionOptions["pluginRuntime"];
  private readonly orchestrationSkills: SessionOptions["orchestrationSkills"];
  private unsubscribeAgentEvents: (() => void) | null = null;
  private unsubscribeProjectMutations: (() => void) | null = null;
  private unsubscribePluginChanges: (() => void) | null = null;
  private unsubscribeWorkspaceMutations: (() => void) | null = null;
  private registryMutationQueue: Promise<void> = Promise.resolve();
  private projectUpdateQueue: Promise<void> = Promise.resolve();
  private isCleanedUp = false;
  private readonly timelineSubscriptions = new Map<
    string,
    { owner: OwnedSubscription; agentIds: Set<string> }
  >();
  private readonly clientSources = new Map<
    object,
    {
      capabilities: ReadonlySet<ClientCapability>;
      appVersion: string | null;
      activity: ClientActivity | null;
      pushToken: string | null;
    }
  >();
  private unsubscribeTerminalWorkspaceContributionEvents: (() => void) | null = null;
  private readonly agentUpdates: AgentUpdatesService;
  private readonly workspaceUpdatesSubscriptions = new Map<
    string,
    WorkspaceUpdatesSubscriptionState
  >();
  private readonly workspaceLabelService: WorkspaceLabelService | null;
  private readonly libraryService: LibraryService;
  private readonly syncService: SyncService;
  private readonly secretsStore: SecretsStore;
  private readonly eventSubscriptions = new Map<
    string,
    { owner: OwnedSubscription; events: Set<SessionEventSubscription>; notifications: boolean }
  >();
  private readonly workspaceUpdateTails = new Map<string, Promise<void>>();
  private readonly terminalManager: TerminalManager | null;
  private readonly providerSnapshotManager: ProviderSnapshotManager;
  private readonly serviceProxy: ServiceProxySubsystem | null;
  private readonly scriptRuntimeStore: WorkspaceScriptRuntimeStore | null;
  private readonly getDaemonTcpPort: (() => number | null) | null;
  private readonly getDaemonTcpHost: (() => string | null) | null;
  private readonly agentConnect: AgentConnectService;
  private readonly agentInstall: AgentInstallService;
  private unsubscribeAgentConnect: (() => void) | null = null;
  private readonly serviceProxyPublicBaseUrl: string | null;
  private readonly resolveScriptHealth: ((hostname: string) => ScriptHealthState | null) | null;
  private readonly terminalController: TerminalSessionController;
  private inflightRequests = 0;
  private peakInflightRequests = 0;
  private readonly workspaceSetupObservation: WorkspaceSetupObservation;
  private readonly unsubscribeSetupObservation: () => void;
  private readonly workspaceSetupRuntime: WorkspaceSetupRuntime;
  private readonly workspaceGitObserver: WorkspaceGitObserverService;
  private readonly workspaceDirectory: WorkspaceDirectory;
  private readonly voiceSessions: VoiceSessions;
  private readonly checkoutSession: CheckoutSession;
  private readonly scheduleSession: ScheduleSession;
  private readonly providerCatalogSession: ProviderCatalogSession;
  private readonly usageSession: UsageSession;
  private readonly externalSessionsSession: ExternalSessionsSession;
  private readonly speechModelsSession: SpeechModelsSession;
  private readonly workspaceFilesSession: WorkspaceFilesSession;
  private readonly agentConfigSession: AgentConfigSession;
  private readonly projectConfigSession: ProjectConfigSession;
  private readonly daemonSession: DaemonSession;
  private readonly hubExecutionController: HubExecutionController | null;
  private readonly workspaceScripts: WorkspaceScriptsService;
  private readonly messageReceipts: Pick<MessageReceipts, "send">;
  private readonly agentMessages: AgentMessageDelivery;
  private readonly createAgentLifecycleDispatch: CreateAgentLifecycleDispatch;
  private readonly creationService: Pick<CreationService, "create" | "subscribe">;

  constructor(options: SessionOptions) {
    const {
      clientId,
      permissions,
      appVersion,
      clientCapabilities,
      onMessage,
      onMessageToSource,
      onBinaryMessage,
      onBinaryMessageToSource,
      getTransportBufferedAmount,
      onLifecycleIntent,
      onWorkspaceRecovered,
      publishScriptStatusUpdate,
      logger,
      downloadTokenStore,
      pushNotifications,
      neolixHome,
      worktreesRoot,
      agentManager,
      agentStorage,
      projectRegistry,
      workspaceRegistry,
      directorySync,
      workspaceLabelService,
      libraryService,
      syncService,
      filesystem,
      scheduleService,
      checkoutDiffManager,
      github,
      renameCurrentBranch,
      workspaceGitService,
      workspaceRuntimeStore,
      workspaceAutoName,
      daemonConfigStore,
      llmGateway,
      pluginRuntime,
      orchestrationSkills,
      stt,
      sttLanguage,
      tts,
      speechModels,
      terminalManager,
      providerSnapshotManager,
      serviceProxy,
      scriptRuntimeStore,
      workspaceSetupObservation,
      workspaceSetupRuntime,
      onBranchChanged,
      getDaemonTcpPort,
      getDaemonTcpHost,
      serviceProxyPublicBaseUrl,
      resolveScriptHealth,
      voice,
      voiceBridge,
      dictation,
      serverId,
      daemonVersion,
      daemonRuntimeConfig,
      getWebSocketRuntimeMetrics,
    } = options;
    this.browserToolsBroker = options.browserToolsBroker;
    this.clientId = clientId;
    this.browserOrigin = options.browserOrigin === true;
    this.authorization = new SessionAuthorization(permissions);

    this.appVersion = appVersion ?? null;
    this.clientCapabilities = parseClientCapabilities(clientCapabilities);
    this.sessionId = uuidv4();
    this.hostSourceId = hostSource(options);
    this.connectedHostSession = createHostSession(options, this);
    this.onMessage = onMessage;
    this.onMessageToSource = sourceSendHandler(onMessageToSource, (work) =>
      this.observeSourceSend(work),
    );
    this.onBinaryMessage = onBinaryMessage ?? null;
    this.onBinaryMessageToSource = sourceSendHandler(onBinaryMessageToSource, (work) =>
      this.observeSourceSend(work),
    );
    this.getTransportBufferedAmount = getTransportBufferedAmount ?? (() => 0);
    this.onLifecycleIntent = onLifecycleIntent ?? null;
    this.onWorkspaceRecovered = onWorkspaceRecovered ?? null;
    this.pushNotifications = pushNotifications;
    this.neolixHome = neolixHome;
    this.messageReceipts = options.messageReceipts;
    this.agentMessages = options.agentMessages;
    this.creationService = options.creationService;
    this.projectIcons = new ProjectIconReader(neolixHome);
    this.secretsStore = new SecretsStore(neolixHome);
    this.worktreesRoot = worktreesRoot;
    this.pluginRuntime = pluginRuntime;
    this.orchestrationSkills = orchestrationSkills;
    this.sessionLogger = logger.child({
      module: "session",
      clientId: this.clientId,
      sessionId: this.sessionId,
    });
    this.workspaceFilesSession = new WorkspaceFilesSession({
      host: {
        emit: (msg, source) => this.emitForSource(msg, source),
        emitBinary: (frame, source) => this.emitBinaryReply(frame, source),
        hasBinaryChannel: () => this.onBinaryMessage !== null,
      },
      downloadTokenStore,
      neolixHome,
      logger: this.sessionLogger,
    });
    this.agentManager = agentManager;
    this.agentStorage = agentStorage;
    this.projectRegistry = projectRegistry;
    this.workspaceRegistry = workspaceRegistry;
    this.directorySync = resolveDirectorySync(directorySync);
    this.workspaceLabelService = resolveWorkspaceLabelService(workspaceLabelService);
    this.libraryService =
      libraryService ??
      createLibraryService({
        neolixHome: this.neolixHome,
        wslEnabled: () => daemonConfigStore.get().noWslAgents !== true,
      });
    this.syncService =
      syncService ??
      new SyncService({
        neolixHome: this.neolixHome,
        logger: this.sessionLogger,
        onEvent: (event) => this.emitSyncEvent(event),
      });
    this.filesystem = filesystem ?? nodeSessionFileSystem;
    this.github = github ?? createGitHubService();
    this.renameCurrentBranch = renameCurrentBranch ?? renameCurrentBranchDefault;
    this.workspaceGitService = workspaceGitService;
    this.workspaceRuntimeStore = workspaceRuntimeStore;
    this.gitMutation = createGitMutationService({
      workspaceGitService: this.workspaceGitService,
      logger: this.sessionLogger,
    });
    this.workspaceAutoName = workspaceAutoName;
    this.workspaceProvisioning = createWorkspaceProvisioningService({
      lifecycle: this.pluginRuntime,
      serverId,
      workspaceRegistry: this.workspaceRegistry,
      projectRegistry: this.projectRegistry,
      workspaceGitService: this.workspaceGitService,
      isDirectory: (path) => this.filesystem.isDirectory(path),
      logger: this.sessionLogger,
    });
    this.workspaceRecovery = createWorkspaceRecoveryService({
      neolixHome: this.neolixHome,
      worktreesRoot: this.worktreesRoot,
      getWorkspace: (workspaceId) => this.workspaceRegistry.get(workspaceId),
      getProject: (projectId) => this.projectRegistry.get(projectId),
      isDirectory: (path) => this.filesystem.isDirectory(path),
      unarchiveWorkspace: async (workspace) => {
        await this.workspaceProvisioning.ensureWorkspaceRecordUnarchived(workspace);
      },
    });
    this.checkoutSession = new CheckoutSession({
      host: {
        emit: (msg) => this.emit(msg),
        emitWorkspaceUpdateForCwd: (cwd) => this.emitWorkspaceUpdateForCwd(cwd),
        handleWorkspaceGitBranchSnapshot: (cwd, branchName) =>
          this.workspaceGitObserver.handleBranchSnapshot(cwd, branchName),
        renameCurrentBranch: (cwd, branch) => this.renameCurrentBranch(cwd, branch),
      },
      gitMutation: this.gitMutation,
      workspaceGitService: this.workspaceGitService,
      github: this.github,
      checkoutDiffManager,
      gitMetadataGenerator: createGitMetadataGenerator({
        workspaceGitService: this.workspaceGitService,
        generation: createAgentStructuredTextGeneration({
          agentManager: this.agentManager,
          providerSnapshotManager,
          readDaemonConfig: () => this.readStructuredGenerationDaemonConfig(),
          getFocusedSelection: (cwd) => this.getFocusedAgentSelectionForCwd(cwd),
          logger: this.sessionLogger,
        }),
        logger: this.sessionLogger,
      }),
      neolixHome: this.neolixHome,
      worktreesRoot: this.worktreesRoot,
      logger: this.sessionLogger,
    });
    this.workspaceGitObserver = createWorkspaceGitObserverService({
      workspaceGitService: this.workspaceGitService,
      emitWorkspaceUpdateForCwd: (cwd) => this.emitWorkspaceUpdateForCwd(cwd),
      emitStatusUpdate: (cwd, snapshot) => this.checkoutSession.emitStatusUpdate(cwd, snapshot),
      onBranchChanged,
      logger: this.sessionLogger,
    });
    this.scheduleSession = new ScheduleSession({
      host: { emit: (msg) => this.emit(msg) },
      scheduleService,
      logger: this.sessionLogger,
    });
    this.providerCatalogSession = new ProviderCatalogSession({
      host: {
        emit: (msg) => this.emit(msg),
        isProviderVisibleToClient: (provider) => this.isProviderVisibleToClient(provider),
        supportsCustomModeIcons: () => this.supports(CLIENT_CAPS.customModeIcons),
        supportsCompactProviderSnapshots: () => this.supports(CLIENT_CAPS.compactProviderSnapshots),
        publishSnapshot: (project) => {
          const delivered = new Set<object>();
          for (const subscription of this.eventSubscriptions.values()) {
            if (!subscription.events.has("providers_snapshot_update")) continue;
            const message = this.delivery.forSource(subscription.owner.source, project);
            if (message) subscription.owner.emit(message);
            delivered.add(subscription.owner.source);
          }
          // COMPAT(ownedSubscriptions): added in v0.8.0, remove implicit provider delivery after 2027-03-09.
          for (const source of this.clientSources.keys()) {
            if (
              delivered.has(source) ||
              this.delivery.isModern(source) ||
              !this.wantsEvent("providers_snapshot_update", source)
            )
              continue;
            const message = this.delivery.forSource(source, project);
            if (message) this.onMessageToSource?.(source, message);
          }
        },
        supportsProviderSnapshotReferences: () =>
          this.supports(CLIENT_CAPS.providerSnapshotReferences),
        listProviderAvailability: () => this.agentManager.listProviderAvailability(),
        listDraftFeatures: (config) => this.agentManager.listDraftFeatures(config),
      },
      providerSnapshotManager,
      logger: this.sessionLogger,
    });
    this.usageSession = new UsageSession({
      isEnabled: () => daemonConfigStore.get().usage?.enabled !== false,
      emit: (msg) => this.emit(msg),
      runtime: pluginRuntime,
      logger: this.sessionLogger,
    });
    this.externalSessionsSession = createExternalSessionsSession({
      neolixHome,
      llmGateway,
      logger: this.sessionLogger,
      emit: (msg) => this.emit(msg),
      isWslEnabled: () => daemonConfigStore.get().noWslAgents !== true,
      sessionTerminal: () => daemonConfigStore.get().sessionTerminal ?? "",
    });
    this.speechModelsSession = new SpeechModelsSession({
      emit: (msg) => this.emit(msg),
      runtime: speechModels,
    });
    this.agentConfigSession = new AgentConfigSession({
      host: {
        emit: (msg) => this.emit(msg),
      },
      operations: {
        ensureLoaded: async (agentId) => {
          await ensureUnarchivedAgentLoaded(agentId, {
            agentManager,
            agentStorage,
            logger: this.sessionLogger,
          });
        },
        setMode: async (agentId, modeId) =>
          (await setAgentModeCommand({ agentManager }, { agentId, modeId })).notice,
        setModel: (agentId, modelId) => agentManager.setAgentModel(agentId, modelId),
        setFeature: (agentId, featureId, value) =>
          agentManager.setAgentFeature(agentId, featureId, value),
        setThinking: (agentId, thinkingOptionId) =>
          agentManager.setAgentThinkingOption(agentId, thinkingOptionId),
      },
      logger: this.sessionLogger,
    });
    this.projectConfigSession = new ProjectConfigSession({
      host: {
        emit: (msg) => this.emit(msg),
      },
      projectRegistry: this.projectRegistry,
      logger: this.sessionLogger,
    });
    this.daemonSession = new DaemonSession({
      host: {
        emit: (msg) => this.emit(msg),
        emitLifecycleIntent: (intent) => this.emitLifecycleIntent(intent),
      },
      clientId: this.clientId,
      neolixHome: this.neolixHome,
      serverId,
      daemonVersion,
      daemonRuntimeConfig,
      getWebSocketRuntimeMetrics,
      getObservationMetrics: () => ({
        Registrations: this.delivery.registrationCount,
        "Source registrations": this.delivery.sourceRegistrationCount(),
        "Producer listeners": [
          this.unsubscribeAgentEvents,
          this.unsubscribeProjectMutations,
          this.unsubscribeWorkspaceMutations,
          this.unsubscribePluginChanges,
          this.unsubscribeTerminalWorkspaceContributionEvents,
          this.providerCatalogSession.isObserving,
          this.hubExecutionController?.isObserving,
        ].filter(Boolean).length,
        "Git observations": this.workspaceGitObserver.getMetrics().subscriptionCount,
        "Terminal directories": this.terminalController.getMetrics().directorySubscriptionCount,
        "Terminal output": this.terminalController.getMetrics().streamSubscriptionCount,
      }),
      listProviderAvailability: () => this.agentManager.listProviderAvailability(),
      getTerminalsUnavailable: () => terminalManager?.getUnavailableError?.()?.message ?? null,
      listAgents: () => this.agentManager.listAgents(),
      listProjects: () => this.projectRegistry.list(),
      // Diagnostics report both the active count and total archived history.
      listWorkspaces: () => this.workspaceRegistry.listAll(),
      logger: this.sessionLogger,
      hubRelationships: options.hubRelationships,
      reloadConfig: () => daemonConfigStore.reload(),
    });
    this.hubExecutionController = options.hubExecutionAgents
      ? new HubExecutionController({
          agents: options.hubExecutionAgents,
          validateAgentConfiguration: (input) =>
            providerSnapshotManager.validateAgentConfiguration(input),
          send: (message) => this.emit(message),
        })
      : null;
    this.daemonConfigStore = daemonConfigStore;
    this.llmGateway = llmGateway;
    this.terminalManager = terminalManager;
    this.terminalController = new TerminalSessionController({
      terminalManager,
      emit: (msg) => this.emit(msg),
      hasBinaryChannel: () => this.onBinaryMessage !== null,
      supportsChunkedReplay: (source) =>
        this.supportsForSource(CLIENT_CAPS.terminalChunkedReplay, source),
      isPathWithinRoot: (rootPath, candidatePath) => this.isPathWithinRoot(rootPath, candidatePath),
      sessionLogger: this.sessionLogger,
      listTerminalWorkspaceRefs: () => this.listActiveWorkspaceRefs(),
      getClientBufferedAmount: (source) => this.getTransportBufferedAmount(source),
    });
    this.agentDirectory = new AgentDirectory({
      manager: this.agentManager,
      storage: this.agentStorage,
      workspaces: this.workspaceRegistry,
      projectLive: (agent) => this.buildAgentPayload(agent),
      projectStored: (record) => this.buildStoredAgentPayload(record),
      isProviderVisible: (provider) => this.isProviderVisibleToClient(provider),
      isStoredProviderAvailable: (record) =>
        isStoredAgentProviderAvailable(
          record,
          new Set(this.providerSnapshotManager.listRegisteredProviderIds()),
        ),
    });
    this.agentUpdates = createAgentUpdatesService({
      includesWorkspace: (agent, backgroundVisibility) =>
        this.agentDirectory.includes(agent, backgroundVisibility),
      emit: (message) => this.emit(message),
      enrichAgentPayload: (payload) => this.enrichAgentPayload(payload),
      buildStoredAgentPayload: (record) => this.buildStoredAgentPayload(record),
      isProviderVisibleToClient: (provider) => this.isProviderVisibleToClient(provider),
      buildProjectPlacementForWorkspaceId: (workspaceId) =>
        this.buildProjectPlacementForWorkspaceId(workspaceId),
      emitWorkspaceUpdateForWorkspaceId: (workspaceId) =>
        this.emitWorkspaceUpdateForWorkspaceId(workspaceId),
      sequenceAgentUpdate: (payload, agent, project, agentId, includeSequence, includeBackground) =>
        this.directorySync.sequenceAgentUpdate(
          payload,
          agent && project ? { agent, project } : null,
          agentId,
          includeSequence,
          includeBackground,
        ),
      logger: this.sessionLogger,
    });
    this.createAgentLifecycleDispatch = new CreateAgentLifecycleDispatch({
      neolixHome: this.neolixHome,
      worktreesRoot: this.worktreesRoot,
      agentManager: this.agentManager,
      agentStorage: this.agentStorage,
      github: this.github,
      workspaceGitService: this.workspaceGitService,
      createNeolixWorktreeWorkflow: (input, workflowOptions) =>
        this.createNeolixWorktreeWorkflow(input, workflowOptions),
      archiveAgentForClose: (agentId) => this.archiveAgentForClose(agentId),
      findWorkspaceIdForCwd: (cwd) => this.findWorkspaceIdForCwd(cwd),
      listActiveWorkspaces: () => this.listActiveWorkspaceRefs(),
      archiveWorkspaceRecord: (workspaceId) => this.archiveWorkspaceRecord(workspaceId),
      emit: (message) => this.emit(message),
      emitAgentRemove: (agentId) => this.agentUpdates.removeAgent(agentId),
      emitWorkspaceUpdatesForWorkspaceIds: (workspaceIds) =>
        this.emitWorkspaceUpdatesForWorkspaceIds(workspaceIds),
      markWorkspaceArchiving: (workspaceIds, archivingAt) =>
        this.markWorkspaceArchiving(workspaceIds, archivingAt),
      clearWorkspaceArchiving: (workspaceIds) => this.clearWorkspaceArchiving(workspaceIds),
      killTerminalsForWorkspace: (workspaceId) =>
        this.terminalController.killTerminalsForWorkspace(workspaceId),
      logger: this.sessionLogger,
    });
    this.providerSnapshotManager = providerSnapshotManager;
    this.serviceProxy = serviceProxy ?? null;
    this.scriptRuntimeStore = scriptRuntimeStore ?? null;
    this.workspaceSetupObservation = workspaceSetupObservation ?? new WorkspaceSetupObservation();
    this.unsubscribeSetupObservation = this.workspaceSetupObservation.subscribe(
      (workspaceId, snapshot, statusChanged) => {
        if (statusChanged)
          void this.emitWorkspaceUpdateForWorkspaceId(workspaceId).catch((error) =>
            this.sessionLogger.warn({ err: error, workspaceId }, "Failed to publish setup status"),
          );
        this.emitSubscribedEvent({
          type: "workspace_setup_progress",
          payload: { workspaceId, ...snapshot },
        });
      },
    );
    this.workspaceSetupRuntime = resolveWorkspaceSetupRuntime(workspaceSetupRuntime);
    this.getDaemonTcpPort = getDaemonTcpPort ?? null;
    this.getDaemonTcpHost = getDaemonTcpHost ?? null;
    this.agentInstall = sharedAgentInstallService(this.neolixHome);
    const gatewayConfigStore = this.llmGateway?.configStore;
    this.agentConnect = sharedAgentConnectService({
      neolixHome: this.neolixHome,
      homeDir: homedir(),
      gatewayConfig: () => this.llmGateway?.configStore.get() ?? EMPTY_GATEWAY_CONFIG,
      gatewayBaseUrl: () => this.agentConnectBaseUrl(),
      pluginProviders: () => this.pluginRuntime?.getProviderContributions() ?? [],
      // Settings' Detect agents in WSL, off, looks in no distro.
      wslEnabled: () => daemonConfigStore.get().noWslAgents !== true,
      // Claude Science's daemon stays on the gateway once connected.
      startScienceKeeper: true,
      // A profile saves and restores the library's own assignments.
      library: () => this.libraryService,
      // Each agent's CLI version, as its own CLI reports it.
      probeVersions: true,
      // A field whose truth myna keeps in its own settings, not the
      // agent's config (Codex's subagent model and sign-in, memories).
      writeAgentPref: (key, value) => {
        const store = this.llmGateway?.configStore;
        if (store === undefined) return Promise.resolve();
        const config = { ...store.get() };
        if (key === "codexSubagentModel") {
          if (value === undefined) delete config.codexSubagentModel;
          else config.codexSubagentModel = value;
        } else if (key === "codexLogin") {
          if (value === undefined) delete config.codexLogin;
          else config.codexLogin = value;
        } else if (value === undefined) {
          delete config.codexMemories;
        } else {
          config.codexMemories = value;
        }
        return store.write(config).then(() => undefined);
      },
      // `neolix visible` and the Agents page keep the same records in the
      // gateway config; an agent's own list follows them.
      writeVisibility: (_agent, records) => {
        const store = this.llmGateway?.configStore;
        if (store === undefined) return Promise.resolve();
        return store.write({ ...store.get(), ...records }).then(() => undefined);
      },
      // A visibility edit (`neolix visible`, the Agents page) or a provider
      // moving rewrites the agents' own lists at once. The shared service
      // keeps one subscription for the whole daemon home.
      watchGatewayConfig: (listener: () => void) =>
        gatewayConfigStore?.onChange(() => listener()) ?? (() => {}),
    });
    // The Library asks the same cache when it looks for the agents, so a
    // Pi new enough is known to read ~/.agents/skills too.
    this.libraryService.setAgentVersionSource((agent) => this.agentConnect.cliVersionOf(agent));
    this.unsubscribeAgentConnect = this.agentConnect.subscribe((snapshot) => {
      this.emit({ type: "agent.connect.changed", payload: { snapshot } });
    });
    this.serviceProxyPublicBaseUrl = serviceProxyPublicBaseUrl ?? null;
    this.resolveScriptHealth = resolveScriptHealth ?? null;
    this.workspaceScripts = createWorkspaceScriptsService({
      serviceProxy: this.serviceProxy,
      scriptRuntimeStore: this.scriptRuntimeStore,
      terminalManager: this.terminalManager,
      workspaceRegistry: this.workspaceRegistry,
      projectRegistry: this.projectRegistry,
      workspaceRuntimeStore: this.workspaceRuntimeStore,
      getDaemonTcpPort: this.getDaemonTcpPort,
      getDaemonTcpHost: this.getDaemonTcpHost,
      serviceProxyPublicBaseUrl: this.serviceProxyPublicBaseUrl,
      resolveScriptHealth: this.resolveScriptHealth,
      logger: this.sessionLogger,
      emit: (message) => this.emit(message),
      publishStatusUpdate: (message) => {
        if (publishScriptStatusUpdate) publishScriptStatusUpdate(message);
        else this.emit(message);
      },
      spawnWorkspaceScript,
      assertAutomationAllowed: (workspaceId) =>
        assertWorkspaceAutomationAllowedForWorkspace(this.workspaceRegistry, workspaceId),
      getGlobalServicePorts: () => this.daemonConfigStore.readServicePorts(),
    });
    this.workspaceDirectory = new WorkspaceDirectory({
      logger: this.sessionLogger,
      projectRegistry: this.projectRegistry,
      workspaceRegistry: this.workspaceRegistry,
      listAgentPayloads: (workspaceIds) =>
        this.listAgentPayloads({ workspaceIds, includeBackground: true, includeAncestors: true }),
      workspaceLastUserMessageTimes: (workspaceIds) =>
        this.agentDirectory.workspaceLastUserMessageTimes(workspaceIds),
      listProviderSubagentActivity: async () => this.agentManager.listProviderSubagentActivity(),
      listTerminalActivityContributions: () => this.listTerminalActivityContributions(),
      isProviderVisibleToClient: (provider) => this.isProviderVisibleToClient(provider),
      buildWorkspaceDescriptor: (input) => this.buildWorkspaceDescriptor(input),
    });

    this.voiceSessions = new VoiceSessions(
      {
        host: {
          emit: (msg) => this.emit(msg),
          loadAgent: (agentId) =>
            ensureAgentLoaded(agentId, {
              agentManager: this.agentManager,
              agentStorage: this.agentStorage,
              logger: this.sessionLogger,
            }),
          reloadAgentSession: (agentId, overrides) =>
            this.agentManager.reloadAgentSession(agentId, overrides),
          sendSpokenInput: async (agentId, text) => {
            await this.handleSendAgentMessage(
              agentId,
              text,
              undefined,
              undefined,
              undefined,
              undefined,
              { spokenInput: true },
            );
          },
          interruptAgentIfRunning: (agentId) => this.interruptAgentIfRunning(agentId),
          hasActiveAgentRun: (agentId) => this.hasActiveAgentRun(agentId),
        },
        logger: this.sessionLogger,
        sessionId: this.sessionId,
        sttLanguage,
        tts,
        stt,
        voice,
        voiceBridge,
        dictation,
      },
      this.delivery,
      () => this.refreshObservationProducers(),
    );

    this.sessionLogger.trace({}, "agent.session.lifecycle.created");
  }

  updateAppVersion(appVersion: string | null): void {
    if (appVersion && appVersion !== this.appVersion) {
      this.appVersion = appVersion;
    }
  }

  updateClientCapabilities(
    capabilities: Record<string, unknown> | null,
    source?: object,
    appVersion = this.appVersion,
  ): void {
    this.clientCapabilities = parseClientCapabilities(capabilities);
    if (source) {
      this.delivery.attach(source, capabilities?.[CLIENT_CAPS.ownedSubscriptions] === true);
      this.clientSources.set(source, {
        capabilities: this.clientCapabilities,
        appVersion,
        activity: this.clientSources.get(source)?.activity ?? null,
        pushToken: this.clientSources.get(source)?.pushToken ?? null,
      });
      this.refreshObservationProducers();
      // COMPAT(ownedSubscriptions): added in v0.8.0, remove capability-driven legacy host registration after 2027-03-09.
      if (
        !this.delivery.isModern(source) &&
        this.authorization.allowsPermission("workspace.write")
      ) {
        const host = BrowserAutomationHostCapabilitySchema.safeParse(capabilities?.browser_host);
        if (host.success && this.browserToolsBroker) {
          const request = {
            type: "browser.host.register.request" as const,
            requestId: uuidv4(),
            hostKind: host.data.hostKind,
            supportedCommands: host.data.supportedCommands,
          };
          void this.delivery
            .request(source, request, () => this.registerBrowserHost(request, false))
            .catch((error) =>
              this.sessionLogger.warn({ err: error }, "Failed to register legacy browser host"),
            );
        }
      }
    }
  }

  clearAgentTimelineSubscription(source: object): void {
    void this.delivery
      .detach(source)
      .catch((err) => this.sessionLogger.error({ err }, "Failed to release source subscriptions"));
    this.clientSources.delete(source);
    this.refreshObservationProducers();
  }

  private subscribeAgentTimelines(agentIds: string[]): OwnedSubscription {
    const owner = this.delivery.begin("timelines", undefined, (id) => {
      this.timelineSubscriptions.delete(id);
      this.refreshObservationProducers();
    });
    this.timelineSubscriptions.set(owner.id, { owner, agentIds: new Set(agentIds) });
    this.refreshObservationProducers();
    return owner;
  }

  // COMPAT(timelineItemCapabilities): plugin items added in v0.8.0, notifications in v0.7.2.
  // Remove after 2027-03-07 once the supported client floor is >= v0.8.0.
  private supportsTimelineItem(item: { type: string }, source?: object): boolean {
    let capability: ClientCapability;
    if (item.type === "notification") capability = CLIENT_CAPS.timelineNotifications;
    else if (item.type === "plugin") capability = CLIENT_CAPS.pluginTimelineItems;
    else return true;
    return source ? this.supportsForSource(capability, source) : this.supports(capability);
  }

  private forwardAgentStream(
    event: Extract<AgentManagerEvent, { type: "agent_stream" }>,
    serializedEvent: Extract<SessionOutboundMessage, { type: "agent_stream" }>["payload"]["event"],
  ): void {
    const attention = serializedEvent.type === "attention_required";
    if (attention) {
      this.emit({
        type: "agent_attention_required",
        payload: {
          agentId: event.agentId,
          reason: serializedEvent.reason,
          timestamp: serializedEvent.timestamp,
          shouldNotify: serializedEvent.shouldNotify,
          ...(serializedEvent.notification ? { notification: serializedEvent.notification } : {}),
        },
      });
    }
    const message: SessionOutboundMessage = {
      type: "agent_stream",
      payload: this.buildAgentStreamPayload(event, serializedEvent),
    };
    for (const subscription of this.timelineSubscriptions.values()) {
      const source = subscription.owner.source;
      if (!subscription.agentIds.has(event.agentId)) continue;
      if (
        attention &&
        (this.delivery.isModern(source) ||
          this.supportsForSource(CLIENT_CAPS.selectiveAgentTimeline, source))
      )
        continue;
      if (
        serializedEvent.type === "timeline" &&
        !this.supportsTimelineItem(serializedEvent.item, source)
      )
        continue;
      subscription.owner.emit(message);
    }
    // COMPAT(ownedSubscriptions): added in v0.8.0, remove implicit timeline delivery after 2027-03-09.
    for (const [source, { capabilities }] of this.clientSources) {
      if (this.delivery.isModern(source) || capabilities.has(CLIENT_CAPS.selectiveAgentTimeline))
        continue;
      if (
        serializedEvent.type === "timeline" &&
        !this.supportsTimelineItem(serializedEvent.item, source)
      )
        continue;
      const alreadyDelivered = [...this.timelineSubscriptions.values()].some(
        (subscription) =>
          subscription.owner.source === source && subscription.agentIds.has(event.agentId),
      );
      if (!alreadyDelivered) this.onMessageToSource?.(source, message);
    }
    if (
      this.clientSources.size === 0 &&
      !this.supports(CLIENT_CAPS.selectiveAgentTimeline) &&
      this.timelineSubscriptions.size === 0
    )
      this.emit(message);
  }

  supports(capability: ClientCapability): boolean {
    const source = this.delivery.currentSource;
    return source
      ? this.supportsForSource(capability, source)
      : this.clientCapabilities.has(capability);
  }

  supportsForSource(capability: ClientCapability, source: object): boolean {
    return (
      this.clientSources.get(source)?.capabilities.has(capability) ??
      this.clientCapabilities.has(capability)
    );
  }

  emitProjectUpdate(update: ProjectUpdate): Promise<void> {
    if (!this.wantsEvent("project.update")) return Promise.resolve();
    const queued = this.projectUpdateQueue
      .catch(() => undefined)
      .then(() => this.publishProjectUpdate(update));
    this.projectUpdateQueue = queued;
    return queued;
  }

  private async publishProjectUpdate(update: ProjectUpdate): Promise<void> {
    if (!this.wantsEvent("project.update")) return;
    const projectedPayload =
      update.kind === "upsert"
        ? { kind: "upsert" as const, project: await this.buildProjectDescriptor(update.project) }
        : update;
    if (!this.wantsEvent("project.update")) return;
    const message: SessionOutboundMessage = {
      type: "project.update",
      payload: this.directorySync.sequenceProjectUpdate(projectedPayload, true),
    };
    this.emit(message);
  }

  async syncWorkspaceGitObserverForWorkspace(workspace: PersistedWorkspaceRecord): Promise<void> {
    if (this.workspaceUpdatesSubscriptions.size === 0 && !this.wantsEvent("checkout_status_update"))
      return;
    const descriptor = await this.describeWorkspaceRecord(workspace);
    const demanded = [...this.workspaceUpdatesSubscriptions.values()].some((subscription) =>
      this.matchesWorkspaceFilter({ workspace: descriptor, filter: subscription.filter }),
    );
    if (demanded || this.wantsEvent("checkout_status_update"))
      this.workspaceGitObserver.syncObservers([descriptor]);
  }

  async emitWorkspaceUpdateForWorkspaceId(workspaceId: string): Promise<void> {
    await this.emitWorkspaceUpdatesForWorkspaceIds([workspaceId]);
  }

  private async emitCreatedWorkspaceUpdate(
    workspace: WorkspaceDescriptorPayload,
    optimisticStatus?: WorkspaceDescriptorPayload["status"],
  ): Promise<void> {
    if (this.workspaceUpdatesSubscriptions.size > 0) {
      await this.emitWorkspaceUpdatesForWorkspaceIds(
        [workspace.id],
        optimisticStatus ? { optimisticStatus } : undefined,
      );
      return;
    }
    // COMPAT(workspaceCreateCausalUpdate): added in v0.1.106, remove after 2027-01-12.
    // Older clients create before subscribing and require the causal update beside the response.
    if (workspace.background) return;
    this.emit({
      type: "workspace_update",
      payload: {
        kind: "upsert",
        workspace: optimisticStatus ? { ...workspace, status: optimisticStatus } : workspace,
      },
    });
  }

  markWorkspaceArchivingForExternalMutation(
    workspaceIds: Iterable<string>,
    archivingAt: string,
  ): void {
    this.markWorkspaceArchiving(workspaceIds, archivingAt);
  }

  clearWorkspaceArchivingForExternalMutation(workspaceIds: Iterable<string>): void {
    this.clearWorkspaceArchiving(workspaceIds);
  }

  async emitWorkspaceUpdatesForExternalWorkspaceIds(workspaceIds: Iterable<string>): Promise<void> {
    await this.emitWorkspaceUpdatesForWorkspaceIds(workspaceIds);
  }

  async syncWorkspaceGitObserversForExternalWorkspaceIds(
    workspaceIds: Iterable<string>,
  ): Promise<void> {
    if (!this.delivery.hasDemand("workspaces") && !this.wantsEvent("checkout_status_update"))
      return;
    await Promise.all(
      Array.from(new Set(workspaceIds)).map(async (workspaceId) => {
        const workspace = await this.workspaceRegistry.get(workspaceId);
        if (workspace && !workspace.archivedAt) {
          await this.syncWorkspaceGitObserverForWorkspace(workspace);
        }
      }),
    );
  }

  async warmWorkspaceGitDataForWorkspace(workspace: PersistedWorkspaceRecord): Promise<void> {
    await this.syncWorkspaceGitObserverForWorkspace(workspace);
    await this.emitWorkspaceUpdateForWorkspaceId(workspace.workspaceId);
  }

  async refreshRecoveredWorkspaceForExternalMutation(
    workspace: PersistedWorkspaceRecord,
  ): Promise<void> {
    try {
      await this.syncWorkspaceGitObserverForWorkspace(workspace);
      await this.emitWorkspaceUpdateForWorkspaceId(workspace.workspaceId);
    } catch (error) {
      this.sessionLogger.warn(
        { err: error, workspaceId: workspace.workspaceId },
        "Failed to warm git observer after workspace recovery",
      );
      try {
        await this.emitWorkspaceUpdateForWorkspaceId(workspace.workspaceId);
      } catch (emitError) {
        this.sessionLogger.warn(
          { err: emitError, workspaceId: workspace.workspaceId },
          "Failed to emit workspace update after recovery",
        );
      }
    }
  }

  /**
   * Get the client's current activity state
   */
  private currentClientMetadata() {
    const source = this.delivery.currentSource;
    if (!source) throw new Error("Client control has no source");
    let metadata = this.clientSources.get(source);
    if (!metadata) {
      // COMPAT(ownedSubscriptions): added in v0.8.0, remove socketless legacy session adapter after 2027-03-09.
      metadata = {
        capabilities: this.clientCapabilities,
        appVersion: this.appVersion,
        activity: null,
        pushToken: null,
      };
      this.clientSources.set(source, metadata);
    }
    return metadata;
  }

  public getClientActivity(source = this.delivery.currentSource): ClientActivity | null {
    return source ? (this.clientSources.get(source)?.activity ?? null) : null;
  }

  private getFocusedAgentSelectionForCwd(cwd: string):
    | {
        provider?: string | null;
        model?: string | null;
        thinkingOptionId?: string | null;
      }
    | undefined {
    const focusedAgentId = this.getClientActivity()?.focusedAgentId;
    if (!focusedAgentId) {
      return undefined;
    }

    const agent = this.agentManager.getAgent(focusedAgentId);
    if (!agent || agent.cwd !== cwd) {
      return undefined;
    }

    return {
      provider: agent.provider,
      model: agent.runtimeInfo?.model ?? agent.config.model ?? null,
      thinkingOptionId:
        agent.runtimeInfo?.thinkingOptionId ?? agent.config.thinkingOptionId ?? null,
    };
  }

  private readStructuredGenerationDaemonConfig(): StructuredGenerationDaemonConfig {
    return {
      metadataGeneration: this.daemonConfigStore.get().metadataGeneration,
    };
  }

  public getRuntimeMetrics(): SessionRuntimeMetrics {
    const terminalMetrics = this.terminalController.getMetrics();
    const workspaceGitMetrics = this.workspaceGitObserver.getMetrics();
    return {
      terminalDirectorySubscriptionCount: terminalMetrics.directorySubscriptionCount,
      terminalSubscriptionCount: terminalMetrics.streamSubscriptionCount,
      workspaceGitWatchedDirectoryCount: workspaceGitMetrics.watchedDirectoryCount,
      workspaceGitWorkspaceRecordCount: workspaceGitMetrics.workspaceRecordCount,
      workspaceGitSubscriptionCount: workspaceGitMetrics.subscriptionCount,
      inflightRequests: this.inflightRequests,
      peakInflightRequests: this.peakInflightRequests,
    };
  }

  public emitServerMessage(message: SessionOutboundMessage): void {
    this.emit(message);
  }

  /**
   * Send initial state to client after connection
   */
  public async sendInitialState(): Promise<void> {
    // No unsolicited agent list hydration. Callers must use fetch_agents_request.
  }

  /**
   * Interrupt the agent's active run so the next prompt starts a fresh turn.
   * Returns once the manager confirms the stream has been cancelled.
   */
  private async interruptAgentIfRunning(agentId: string): Promise<void> {
    const snapshot = this.agentManager.getAgent(agentId);
    if (!snapshot) {
      this.sessionLogger.trace({ agentId }, "agent.session.interrupt.not_found");
      throw new Error(`Agent ${agentId} not found`);
    }

    const hasInFlightRun = this.agentManager.hasInFlightRun(agentId);
    if (!hasInFlightRun) {
      this.sessionLogger.trace(
        {
          agentId,
          provider: snapshot.provider,
          lifecycle: snapshot.lifecycle,
          hasInFlightRun,
        },
        "agent.session.interrupt.skip_not_running",
      );
      return;
    }

    this.sessionLogger.debug(
      { agentId, lifecycle: snapshot.lifecycle, hasInFlightRun },
      "interruptAgentIfRunning: interrupting",
    );

    const t0 = Date.now();
    const cancellation = await this.agentManager.cancelAgentRun(agentId);
    this.sessionLogger.debug(
      { agentId, cancellation: cancellation.status, durationMs: Date.now() - t0 },
      "interruptAgentIfRunning: cancelAgentRun completed",
    );
    if (cancellation.status === "refused") {
      this.sessionLogger.warn(
        { agentId },
        "interruptAgentIfRunning: reported running but no active run was cancelled",
      );
      throw new AgentRunCancellationError(agentId, "stop");
    }
  }

  private hasActiveAgentRun(agentId: string | null): boolean {
    if (!agentId) {
      return false;
    }
    return this.agentManager.hasInFlightRun(agentId);
  }

  private handleAgentRunError(agentId: string, error: unknown, context: string): void {
    const message = errorToFriendlyMessage(error);
    this.sessionLogger.error({ err: error, agentId, context }, `${context} for agent ${agentId}`);
    this.emit({
      type: "activity_log",
      payload: {
        id: uuidv4(),
        timestamp: new Date(),
        type: "error",
        content: `${context}: ${message}`,
      },
    });
  }

  /**
   * Subscribe to AgentManager events and forward them to the client
   */
  private refreshObservationProducers(): void {
    const legacy = this.delivery.hasLegacySources();
    const workspaces =
      legacy || this.delivery.hasDemand("workspaces") || this.wantsEvent("checkout_status_update");
    const agents =
      workspaces ||
      this.delivery.hasDemand("agents") ||
      this.delivery.hasDemand("timelines") ||
      this.voiceSessions.hasDemand ||
      this.wantsEvent("agent_attention_required") ||
      this.wantsEvent("agent_permission_request") ||
      this.wantsEvent("agent_permission_resolved") ||
      this.wantsEvent("agent.provider_subagents.update");
    if (agents && !this.unsubscribeAgentEvents) this.subscribeToAgentEvents();
    if (!agents) {
      this.unsubscribeAgentEvents?.();
      this.unsubscribeAgentEvents = null;
    }
    this.refreshWorkspaceProducers(workspaces);
    this.refreshCatalogProducers(legacy);
  }

  private refreshWorkspaceProducers(observing: boolean): void {
    if (observing) {
      this.unsubscribeProjectMutations ??=
        this.projectRegistry.subscribeToMutations?.((mutation) =>
          this.enqueueRegistryMutation(() => this.handleProjectMutation(mutation)),
        ) ?? null;
      this.unsubscribeWorkspaceMutations ??=
        this.workspaceRegistry.subscribeToMutations?.((mutation) =>
          this.enqueueRegistryMutation(() => this.handleWorkspaceMutation(mutation)),
        ) ?? null;
      this.unsubscribeTerminalWorkspaceContributionEvents ??=
        this.terminalManager?.subscribeTerminalWorkspaceContributionChanged((event) => {
          void this.emitWorkspaceUpdateForTerminalContribution(event).catch((error) =>
            this.sessionLogger.warn(
              { err: error, terminalId: event.terminalId },
              "Failed to emit workspace terminal contribution",
            ),
          );
        }) ?? null;
    } else {
      this.unsubscribeProjectMutations?.();
      this.unsubscribeProjectMutations = null;
      this.unsubscribeWorkspaceMutations?.();
      this.unsubscribeWorkspaceMutations = null;
      this.unsubscribeTerminalWorkspaceContributionEvents?.();
      this.unsubscribeTerminalWorkspaceContributionEvents = null;
    }
  }

  private refreshCatalogProducers(legacy: boolean): void {
    this.hubExecutionController?.setObserving(
      legacy ||
        this.wantsEvent("hub.execution.agent.update") ||
        this.wantsEvent("hub.execution.agent.stream"),
    );
    if (this.wantsEvent("providers_snapshot_update")) this.providerCatalogSession.start();
    else this.providerCatalogSession.dispose();
    if (
      legacy ||
      this.wantsEvent("status.plugin_catalog_changed") ||
      this.wantsEvent("status.plugin_settings_changed")
    )
      this.unsubscribePluginChanges ??= this.subscribeToPluginChanges(this.pluginRuntime);
    else {
      this.unsubscribePluginChanges?.();
      this.unsubscribePluginChanges = null;
    }
  }

  private enqueueRegistryMutation(handleMutation: () => Promise<void>): Promise<void> {
    const next = this.registryMutationQueue.then(handleMutation);
    this.registryMutationQueue = next.catch(() => {});
    return next;
  }

  private async handleWorkspaceMutation(mutation: WorkspaceMutation): Promise<void> {
    try {
      if (this.isCleanedUp) {
        return;
      }
      if (
        mutation.kind === "archive" ||
        mutation.kind === "remove" ||
        mutation.workspace?.archivedAt
      ) {
        this.workspaceGitObserver.removeForWorkspaceId(mutation.workspaceId);
      } else {
        await this.syncWorkspaceMutationObserver(mutation);
      }
      if (this.isCleanedUp) {
        return;
      }
      await this.emitWorkspaceUpdatesForWorkspaceIds(
        [mutation.workspaceId],
        mutation.expectsInitialAgent ? { optimisticStatus: "running" } : undefined,
      );
    } catch (error) {
      this.sessionLogger.warn(
        { err: error, workspaceId: mutation.workspaceId, mutationKind: mutation.kind },
        "Failed to apply workspace mutation to session",
      );
    }
  }

  private async syncWorkspaceMutationObserver(mutation: WorkspaceMutation): Promise<void> {
    if (
      !mutation.workspace ||
      (this.workspaceUpdatesSubscriptions.size === 0 && !this.wantsEvent("checkout_status_update"))
    )
      return;
    const descriptorsByWorkspaceId = await this.buildWorkspaceDescriptorMap({
      workspaceIds: [mutation.workspaceId],
      includeGitData: false,
    });
    const descriptor = descriptorsByWorkspaceId.get(mutation.workspaceId);
    if (
      !descriptor ||
      (!this.wantsEvent("checkout_status_update") &&
        ![...this.workspaceUpdatesSubscriptions.values()].some((subscription) =>
          this.matchesWorkspaceFilter({ workspace: descriptor, filter: subscription.filter }),
        ))
    ) {
      this.workspaceGitObserver.removeForWorkspaceId(mutation.workspaceId);
      return;
    }
    const currentWorkspace = await this.workspaceRegistry.get(mutation.workspaceId);
    if (!currentWorkspace || currentWorkspace.archivedAt) {
      this.workspaceGitObserver.removeForWorkspaceId(mutation.workspaceId);
      return;
    }
    await this.syncWorkspaceGitObserverForWorkspace(currentWorkspace);
    if (this.isCleanedUp) {
      this.workspaceGitObserver.removeForWorkspaceId(mutation.workspaceId);
    }
  }

  private async handleProjectMutation(mutation: ProjectMutation): Promise<void> {
    for (const subscription of this.workspaceUpdatesSubscriptions.values()) {
      await this.handleProjectMutationForSubscription(mutation, subscription);
    }
  }

  private async handleProjectMutationForSubscription(
    mutation: ProjectMutation,
    subscription: WorkspaceUpdatesSubscriptionState,
  ): Promise<void> {
    try {
      if (this.isCleanedUp) {
        return;
      }
      const projectWorkspaceIds = (await this.workspaceRegistry.listActive())
        .filter((workspace) => workspace.projectId === mutation.projectId)
        .map((workspace) => workspace.workspaceId);

      if (mutation.kind === "remove") {
        // Archived workspaces can still represent an empty project in this subscription.
        for (const [workspaceId, update] of subscription.lastEmittedByWorkspaceId) {
          const projectId =
            update.kind === "upsert" ? update.workspace.projectId : update.emptyProject?.projectId;
          if (projectId === mutation.projectId && !projectWorkspaceIds.includes(workspaceId)) {
            projectWorkspaceIds.push(workspaceId);
          }
        }
        const visibleWorkspaceIds = projectWorkspaceIds.filter((workspaceId) => {
          const lastEmitted = subscription.lastEmittedByWorkspaceId.get(workspaceId);
          return (
            lastEmitted?.kind === "upsert" ||
            (lastEmitted?.kind === "remove" &&
              lastEmitted.emptyProject?.projectId === mutation.projectId)
          );
        });
        let updateIds = visibleWorkspaceIds;
        if (
          updateIds.length === 0 &&
          subscription.visibleEmptyProjectIds?.has(mutation.projectId)
        ) {
          updateIds = [mutation.projectId];
        }
        if (updateIds.length === 0) {
          return;
        }
        for (const workspaceId of projectWorkspaceIds) {
          this.workspaceGitObserver.removeForWorkspaceId(workspaceId);
        }
        await this.enqueueWorkspaceUpdates(new Set(updateIds), subscription, {
          removedProjectId: mutation.projectId,
        });
        return;
      }

      if (mutation.kind === "archive" || mutation.project?.archivedAt) {
        for (const workspaceId of projectWorkspaceIds) {
          this.workspaceGitObserver.removeForWorkspaceId(workspaceId);
        }
      }
      await this.enqueueWorkspaceUpdates(new Set(projectWorkspaceIds), subscription, undefined);
    } catch (error) {
      this.sessionLogger.warn(
        { err: error, projectId: mutation.projectId, mutationKind: mutation.kind },
        "Failed to apply project mutation to session",
      );
    }
  }

  private supportsSubagentTimelineItem(
    item: AgentTimelineFetchResult["rows"][number]["item"],
    source?: object,
  ): boolean {
    // COMPAT(projectedSubagentTimeline): added after v0.8.0, remove gate after 2027-03-14.
    const supportsProjection = source
      ? this.supportsForSource(CLIENT_CAPS.projectedSubagentTimeline, source)
      : this.supports(CLIENT_CAPS.projectedSubagentTimeline);
    return supportsProjection && this.supportsTimelineItem(item, source);
  }

  private forwardProviderSubagentUpdate(
    update: Extract<AgentManagerEvent, { type: "provider_subagent" }>["event"],
  ): void {
    let message: SessionOutboundMessage;
    if (update.type === "upsert") {
      message = {
        type: "agent.provider_subagents.update",
        payload: { kind: "upsert", subagent: update.subagent },
      };
    } else if (update.type === "timeline") {
      message = {
        type: "agent.provider_subagents.update",
        payload: {
          kind: "timeline",
          parentAgentId: update.parentAgentId,
          subagentId: update.subagentId,
          provider: update.provider,
          item: update.row.item,
          timestamp: update.row.timestamp,
          seq: update.row.seq,
          epoch: update.epoch,
        },
      };
    } else {
      message = {
        type: "agent.provider_subagents.update",
        payload: {
          kind: "remove",
          parentAgentId: update.parentAgentId,
          subagentId: update.subagentId,
        },
      };
    }

    const delivered = new Set<object>();
    for (const subscription of this.eventSubscriptions.values()) {
      if (!subscription.events.has("agent.provider_subagents.update")) continue;
      if (
        update.type === "timeline" &&
        !this.supportsSubagentTimelineItem(update.row.item, subscription.owner.source)
      )
        continue;
      subscription.owner.emit(message);
      delivered.add(subscription.owner.source);
    }
    if (this.clientSources.size === 0 || !this.onMessageToSource) {
      if (
        this.supports(CLIENT_CAPS.providerSubagents) &&
        (update.type !== "timeline" || this.supportsSubagentTimelineItem(update.row.item))
      ) {
        this.emit(message);
      }
      return;
    }
    for (const [source, { capabilities }] of this.clientSources) {
      if (
        delivered.has(source) ||
        this.delivery.isModern(source) ||
        !capabilities.has(CLIENT_CAPS.providerSubagents)
      )
        continue;
      if (update.type === "timeline" && !this.supportsSubagentTimelineItem(update.row.item, source))
        continue;
      this.onMessageToSource(source, message);
    }
  }

  private subscribeToAgentEvents(): void {
    if (this.unsubscribeAgentEvents) {
      this.unsubscribeAgentEvents();
    }

    this.unsubscribeAgentEvents = this.agentManager.subscribe(
      (event) => {
        if (event.type === "timeline_replacement") {
          this.deliverTimelineReplacement(event.agentId, this.rewindInitiators.get(event.agentId));
          return;
        }

        if (event.type === "agent_removed") {
          if (event.internal) return;
          void this.agentUpdates
            .removeAgent(event.agentId)
            .then(() => {
              if (event.workspaceId)
                return this.emitWorkspaceUpdateForWorkspaceId(event.workspaceId);
              return undefined;
            })
            .catch((error) => {
              this.sessionLogger.error(
                { err: error, agentId: event.agentId },
                "Failed to emit agent removal",
              );
            });
          return;
        }

        if (event.type === "agent_state") {
          this.sessionLogger.trace(
            {
              agentId: event.agent.id,
              provider: event.agent.provider,
              providerSessionId: event.agent.persistence?.sessionId ?? undefined,
              turnId: event.agent.activeForegroundTurnId ?? undefined,
              lifecycle: event.agent.lifecycle,
            },
            "agent.session.forward_update",
          );
          void this.agentUpdates.forwardLiveAgent(event.agent);
          return;
        }

        if (event.type === "provider_subagent") {
          // The subagents track of an internal parent stays hidden.
          const parentAgentId =
            event.event.type === "upsert"
              ? event.event.subagent.parentAgentId
              : event.event.parentAgentId;
          if (this.agentManager.getAgent(parentAgentId)?.internal) return;
          this.emitProviderSubagentWorkspaceUpdate(event.event);
          this.forwardProviderSubagentUpdate(event.event);
          return;
        }

        if (
          this.voiceSessions.isActiveForAgent(event.agentId) &&
          event.event.type === "permission_requested" &&
          isVoicePermissionAllowed(event.event.request)
        ) {
          const requestId = event.event.request.id;
          void this.agentManager
            .respondToPermission(event.agentId, requestId, {
              behavior: "allow",
            })
            .catch((error) => {
              this.sessionLogger.warn(
                {
                  err: error,
                  agentId: event.agentId,
                  requestId,
                },
                "Failed to auto-allow speak tool permission in voice mode",
              );
            });
        }

        const serializedEvent = serializeAgentStreamEvent(event.event);
        if (!serializedEvent) {
          return;
        }
        this.sessionLogger.trace(
          {
            agentId: event.agentId,
            provider: event.event.provider,
            turnId: getAgentStreamEventTurnId(event.event),
            seq: event.seq,
            epoch: event.epoch,
            event: event.event,
          },
          "agent.session.forward_stream",
        );

        this.forwardAgentStream(event, serializedEvent);

        // An internal agent streams only to clients subscribed to it by id;
        // session-wide prompts would surface it everywhere.
        const internal = this.agentManager.getAgent(event.agentId)?.internal === true;
        if (event.event.type === "permission_requested" && !internal) {
          this.emit({
            type: "agent_permission_request",
            payload: {
              agentId: event.agentId,
              request: event.event.request,
            },
          });
        } else if (event.event.type === "permission_resolved") {
          // A provider event is not the outcome of whichever request is currently running.
          this.emitSubscribedEvent({
            type: "agent_permission_resolved",
            payload: {
              agentId: event.agentId,
              requestId: event.event.requestId,
              resolution: event.event.resolution,
            },
          });
        }

        // Title updates may be applied asynchronously after agent creation.
      },
      // Internal agents flow through so exact-id subscribers and opted-in
      // listings see them; everything else above filters them out.
      { replayState: false, includeInternal: true },
    );
  }

  private emitProviderSubagentWorkspaceUpdate(event: ProviderSubagentManagerEvent): void {
    if (event.type === "timeline") {
      return;
    }
    const parentAgentId =
      event.type === "upsert" ? event.subagent.parentAgentId : event.parentAgentId;
    const parent = this.agentManager.getAgent(parentAgentId);
    if (!parent?.workspaceId) {
      return;
    }
    void this.emitWorkspaceUpdateForWorkspaceId(parent.workspaceId).catch((error) => {
      this.sessionLogger.error(
        { err: error, parentAgentId, workspaceId: parent.workspaceId },
        "Failed to emit provider subagent workspace update",
      );
    });
  }

  private buildAgentStreamPayload(
    event: Extract<AgentManagerEvent, { type: "agent_stream" }>,
    serializedEvent: Extract<SessionOutboundMessage, { type: "agent_stream" }>["payload"]["event"],
  ): Extract<SessionOutboundMessage, { type: "agent_stream" }>["payload"] {
    return {
      agentId: event.agentId,
      event: serializedEvent,
      timestamp: event.timestamp ?? new Date().toISOString(),
      ...(typeof event.seq === "number" ? { seq: event.seq } : {}),
      ...(typeof event.epoch === "string" ? { epoch: event.epoch } : {}),
    };
  }

  private async enrichAgentPayload(payload: AgentSnapshotPayload): Promise<AgentSnapshotPayload> {
    const storedRecord = await this.agentStorage.get(payload.id);
    payload.title = storedRecord?.title ?? null;
    payload.archivedAt = storedRecord?.archivedAt ?? null;
    return payload;
  }

  private buildAgentPayload(agent: ManagedAgent): Promise<AgentSnapshotPayload> {
    return this.enrichAgentPayload(toAgentPayload(agent));
  }

  private buildStoredAgentPayload(
    record: StoredAgentRecord,
    registeredProviderIds = new Set(this.providerSnapshotManager.listRegisteredProviderIds()),
  ): AgentSnapshotPayload {
    return buildStoredAgentPayload(record, registeredProviderIds);
  }

  private isProviderVisibleToClient(provider: string): boolean {
    if (
      this.supports(CLIENT_CAPS.allProviders) ||
      clientSupportsAllProviders(
        this.delivery.currentSource
          ? (this.clientSources.get(this.delivery.currentSource)?.appVersion ?? null)
          : this.appVersion,
      )
    ) {
      return true;
    }
    return LEGACY_PROVIDER_IDS.has(provider);
  }

  private async buildProjectPlacementForWorkspace(
    workspace: PersistedWorkspaceRecord,
    projectRecord?: PersistedProjectRecord | null,
  ): Promise<ProjectPlacementPayload> {
    const project = projectRecord ?? (await this.projectRegistry.get(workspace.projectId));
    if (!project) {
      throw new Error(`Project not found for workspace ${workspace.workspaceId}`);
    }
    const snapshot = this.workspaceRuntimeStore.get(workspace.cwd);
    const checkout = checkoutFromPersistedWorkspacePlacement({
      workspace,
      // COMPAT(workspacePlacementBackfill): added in v0.1.107, remove after 2027-01-15.
      // Legacy records can lack branch and worktreeRoot because persisted registries
      // are not migrated in place.
      fallbackBranch: snapshot?.git.currentBranch ?? null,
      fallbackWorktreeRoot: snapshot?.git.repoRoot,
    });
    return {
      projectKey: project.projectId,
      projectName: resolveProjectDisplayName(project),
      workspaceName: resolveWorkspaceDisplayName(workspace),
      checkout,
    };
  }

  private async buildProjectPlacementForWorkspaceId(
    workspaceId: string,
  ): Promise<ProjectPlacementPayload | null> {
    const workspace = await this.workspaceRegistry.get(workspaceId);
    if (!workspace) return null;

    const project = await this.projectRegistry.get(workspace.projectId);
    if (!project) return null;
    return this.buildProjectPlacementForWorkspace(workspace, project);
  }

  /**
   * Main entry point for processing session messages
   */
  public async handleMessage(msg: SessionInboundMessage, source?: object): Promise<void> {
    return this.delivery.request(source, msg, () => this.handleRequest(msg, source));
  }

  private async handleRequest(msg: SessionInboundMessage, source?: object): Promise<void> {
    this.inflightRequests++;
    if (this.inflightRequests > this.peakInflightRequests) {
      this.peakInflightRequests = this.inflightRequests;
    }
    try {
      // Stringifying a binary plugin input costs its size; test logger stubs lack isLevelEnabled.
      if (this.sessionLogger.isLevelEnabled?.("trace"))
        this.sessionLogger.trace(
          {
            messageType: msg.type,
            payloadBytes: JSON.stringify(msg).length,
          },
          "agent.session.inbound",
        );
      if (!this.authorization.allowsInbound(msg)) {
        const requestId = sessionRequestId(msg);
        if (requestId) {
          this.emit({
            type: "rpc_error",
            payload: {
              requestId,
              requestType: msg.type,
              error: `Session is not authorized for ${msg.type}`,
              code: msg.type.startsWith("hosts.") ? "permission_denied" : "access_denied",
            },
          });
        }
        return;
      }
      try {
        await this.dispatchInboundMessage(msg, source);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        this.sessionLogger.error({ err }, "Error handling message");

        const requestId =
          "requestId" in msg && typeof msg.requestId === "string" ? msg.requestId : undefined;
        if (typeof requestId === "string") {
          try {
            this.emit({
              type: "rpc_error",
              payload: {
                requestId,
                requestType: msg.type,
                error: `Request failed: ${err.message}`,
                code: "handler_error",
              },
            });
          } catch (emitError) {
            this.sessionLogger.error({ err: emitError }, "Failed to emit rpc_error");
          }
        }

        this.emit({
          type: "activity_log",
          payload: {
            id: uuidv4(),
            timestamp: new Date(),
            type: "error",
            content: `Error: ${err.message}`,
          },
        });
      }
    } finally {
      this.inflightRequests--;
    }
  }

  public setPermissions(permissions: readonly DaemonPermission[]): void {
    this.authorization.replacePermissions(permissions);
    this.connectedHostSession?.revoke();
    if (!this.authorization.allowsPermission("workspace.write")) {
      void this.delivery
        .releaseFamily("browser-host")
        .catch((error) =>
          this.sessionLogger.error({ err: error }, "Failed to release revoked browser hosting"),
        );
    }
    // Binary plugin events skip the outbound permission check, so revocation ends the streams.
    if (!this.authorization.allowsPermission("daemon.manage")) {
      void this.delivery
        .releaseFamily("plugin-rpc")
        .catch((error) =>
          this.sessionLogger.error(
            { err: error },
            "Failed to release revoked plugin subscriptions",
          ),
        );
    }
  }

  public getPermissions(): DaemonPermission[] {
    return this.authorization.listPermissions();
  }

  public allowsInbound(message: SessionInboundMessage): boolean {
    return this.authorization.allowsInbound(message);
  }

  public allowsPermission(permission: DaemonPermission): boolean {
    return this.authorization.allowsPermission(permission);
  }

  public subscribesToAgent(agent: ManagedAgent, source: object): Promise<boolean> {
    return this.agentUpdates.includesLiveAgent(
      agent,
      new Set(this.delivery.subscriptionIds(source, "agents")),
    );
  }

  public subscribesToTerminalDirectory(
    input: {
      cwd: string;
      workspaceId?: string;
    },
    source: object,
  ): Promise<boolean> {
    return this.terminalController.hasDirectorySubscription(input, source);
  }

  public publishToSource(source: object, message: SessionOutboundMessage): void {
    if (!this.authorization.allowsOutbound(message)) return;
    this.emitSubscribedEvent(message, source);
  }

  public wantsSourceEvent(source: object, event: SessionEventSubscription): boolean {
    return this.wantsEvent(event, source);
  }

  public wantsSourceNotification(source: object, event: SessionEventSubscription): boolean {
    // COMPAT(ownedSubscriptions): added in v0.8.0, remove legacy notification selection after 2027-03-09.
    if (!this.delivery.isModern(source)) return true;
    return [...this.eventSubscriptions.values()].some(
      (subscription) =>
        subscription.owner.source === source &&
        subscription.notifications &&
        subscription.events.has(event),
    );
  }

  public publish(message: SessionOutboundMessage): void {
    this.emit(message);
  }

  private async registerBrowserHost(
    request: Extract<SessionInboundMessage, { type: "browser.host.register.request" }>,
    respond = true,
  ): Promise<void> {
    if (!this.browserToolsBroker) throw new Error("Browser hosting is unavailable");
    let unregister: (() => void) | undefined;
    const owner = this.delivery.begin("browser-host", undefined, () => unregister?.());
    try {
      unregister = this.browserToolsBroker.registerClient({
        id: owner.id,
        hostKind: request.hostKind,
        supportedCommands: request.supportedCommands,
        sendBrowserAutomationRequest: (message) => owner.emit(message),
      });
      if (respond)
        this.emit({
          type: "browser.host.register.response",
          payload: { requestId: request.requestId, subscriptionId: owner.responseId },
        });
    } catch (error) {
      await owner.release();
      throw error;
    }
  }

  private async subscribeWorkspaceSetup(
    request: Extract<SessionInboundMessage, { type: "workspace.setup.subscribe.request" }>,
  ): Promise<void> {
    if (
      !this.supports(CLIENT_CAPS.workspaceSetupObservation) ||
      !this.delivery.isModern(this.delivery.currentSource)
    )
      throw new Error("Workspace setup observation requires owned subscriptions");
    // Resolve persisted blocked state first. Register and read the current cache in one
    // synchronous turn afterward, so a setup transition during this read cannot be lost.
    let initial: WorkspaceSetupSnapshot | null = null;
    await handleWorkspaceSetupStatusRequestMessage(
      {
        workspaceSetupSnapshots: this.workspaceSetupObservation,
        getWorkspace: (id) => this.workspaceRegistry.get(id),
        emit: (message) => {
          if (message.type === "workspace_setup_status_response")
            initial = message.payload.snapshot;
        },
      },
      { ...request, type: "workspace_setup_status_request" },
    );
    let stop: (() => void) | undefined;
    const owner = this.delivery.begin("workspace-setup", undefined, () => stop?.());
    stop = this.workspaceSetupObservation.subscribe((workspaceId, snapshot) => {
      if (workspaceId === request.workspaceId)
        owner.emit({ type: "workspace_setup_progress", payload: { workspaceId, ...snapshot } });
    });
    this.emit({
      type: "workspace.setup.subscribe.response",
      payload: {
        requestId: request.requestId,
        subscriptionId: owner.responseId,
        workspaceId: request.workspaceId,
        snapshot: this.workspaceSetupObservation.get(request.workspaceId) ?? initial,
      },
    });
  }

  private dispatchSubscriptionMessage(
    msg: SessionInboundMessage,
    source?: object,
  ): Promise<void> | undefined {
    if (msg.type === "workspace.setup.subscribe.request") return this.subscribeWorkspaceSetup(msg);
    if (msg.type === "browser.host.register.request") return this.registerBrowserHost(msg);
    if (msg.type === "browser.automation.execute.response") {
      if (source)
        this.browserToolsBroker?.receiveResponse(
          msg,
          this.delivery.subscriptionIds(source, "browser-host"),
        );
      return Promise.resolve();
    }
    if (msg.type === "subscription.release.request") {
      return this.delivery.release(msg.subscriptionId).then(() => {
        this.emit({
          type: "subscription.release.response",
          payload: { requestId: msg.requestId, subscriptionId: msg.subscriptionId },
        });
        return undefined;
      });
    }
    return undefined;
  }

  private async dispatchInboundMessage(msg: SessionInboundMessage, source?: object): Promise<void> {
    const promise =
      this.connectedHostSession?.dispatch(msg) ??
      this.dispatchSubscriptionMessage(msg, source) ??
      this.dispatchVoiceAndControlMessage(msg) ??
      this.dispatchAgentObservationMessage(msg, source) ??
      this.dispatchHubExecutionMessage(msg) ??
      this.dispatchCreationMessage(msg, source) ??
      this.dispatchAgentLifecycleMessage(msg) ??
      this.dispatchAgentConfigMessage(msg) ??
      this.dispatchCheckoutMessage(msg) ??
      this.dispatchWorkspaceLifecycleMessage(msg) ??
      this.dispatchWorkspaceFileMessage(msg, source) ??
      this.dispatchProviderMessage(msg) ??
      this.dispatchOrchestrationSkillsMessage(msg) ??
      this.dispatchPluginDirectoryMessage(msg) ??
      this.dispatchPluginMessage(msg) ??
      this.dispatchPluginRpcMessage(msg) ??
      this.dispatchHostServiceMessage(msg) ??
      this.dispatchMiscMessage(msg);
    if (promise) await promise;
  }

  private dispatchAgentObservationMessage(
    msg: SessionInboundMessage,
    source?: object,
  ): Promise<void> | undefined {
    return (
      this.dispatchAgentRewindMessage(msg, source) ??
      this.dispatchAgentRelationshipMessage(msg) ??
      this.dispatchAgentTimelineMessage(msg, source)
    );
  }

  private dispatchExternalSessionsMessage(msg: SessionInboundMessage): Promise<void> | undefined {
    switch (msg.type) {
      case "sessions.external.list.request":
        return this.externalSessionsSession.handleList(msg);
      case "sessions.external.search.request":
        return this.externalSessionsSession.handleSearch(msg);
      case "sessions.external.delete.request":
        return this.externalSessionsSession.handleDelete(msg);
      case "sessions.external.restore.request":
        return this.externalSessionsSession.handleRestore(msg);
      case "sessions.external.purge.request":
        return this.externalSessionsSession.handlePurge(msg);
      case "sessions.external.transcript.request":
        return this.externalSessionsSession.handleTranscript(msg);
      case "sessions.external.export.request":
        return this.externalSessionsSession.handleExport(msg);
      case "sessions.external.codex_provider.request":
        return this.externalSessionsSession.handleCodexProvider(msg);
      case "sessions.external.relocate_claude.request":
        return this.externalSessionsSession.handleRelocate(msg);
      case "sessions.reads.get.request":
        return this.externalSessionsSession.handleReadsGet(msg);
      case "sessions.reads.set.request":
        return this.externalSessionsSession.handleReadsSet(msg);
      case "sessions.terminals.list.request":
        return this.externalSessionsSession.handleTerminalsList(msg);
      case "sessions.open_in_terminal.request":
        return this.externalSessionsSession.handleOpenInTerminal(msg);
      case "sessions.recording.set.request":
        return this.externalSessionsSession.handleRecording(msg);
      default:
        return undefined;
    }
  }

  private dispatchHostServiceMessage(msg: SessionInboundMessage): Promise<void> | undefined {
    return (
      this.dispatchExternalSessionsMessage(msg) ??
      this.dispatchTerminalMessage(msg) ??
      this.dispatchScheduleMessage(msg) ??
      this.dispatchSyncMessage(msg) ??
      this.dispatchLibraryMessage(msg) ??
      this.speechModelsSession.dispatch(msg)
    );
  }

  private dispatchWorkspaceLifecycleMessage(msg: SessionInboundMessage): Promise<void> | undefined {
    return (
      this.dispatchWorkspaceStateMessage(msg) ??
      this.dispatchWorkspaceLabelMessage(msg) ??
      this.dispatchWorkspaceSetupMessage(msg) ??
      this.dispatchWorkspaceAndProjectMessage(msg)
    );
  }

  private dispatchOrchestrationSkillsMessage(
    msg: SessionInboundMessage,
  ): Promise<void> | undefined {
    if (!this.orchestrationSkills || !msg.type.startsWith("agent.skills.")) return undefined;
    const emitStatus = (
      type:
        | "agent.skills.get_status.response"
        | "agent.skills.reconcile.response"
        | "agent.skills.uninstall.response",
      requestId: string,
      operation: Promise<import("./orchestration-skills/index.js").SkillsSnapshot>,
    ) =>
      operation.then((status) => {
        this.emit({ type, payload: { requestId, ...status } });
        return undefined;
      });
    switch (msg.type) {
      case "agent.skills.get_status.request":
        return emitStatus(
          "agent.skills.get_status.response",
          msg.requestId,
          this.orchestrationSkills.getStatus(),
        );
      case "agent.skills.reconcile.request":
        return emitStatus(
          "agent.skills.reconcile.response",
          msg.requestId,
          this.orchestrationSkills.reconcile(),
        );
      case "agent.skills.uninstall.request":
        return emitStatus(
          "agent.skills.uninstall.response",
          msg.requestId,
          this.orchestrationSkills.uninstall(),
        );
      case "agent.skills.save_selection.request":
        return this.orchestrationSkills
          .saveSelection(msg.selection, msg.confirmedRemovals)
          .then((result) => {
            this.emit({
              type: "agent.skills.save_selection.response",
              payload: { requestId: msg.requestId, ...result },
            });
            return undefined;
          });
      case "agent.skills.import_legacy_selection.request":
        return this.orchestrationSkills
          .importLegacySelectionIfUnset(msg.selection)
          .then((result) => {
            this.emit({
              type: "agent.skills.import_legacy_selection.response",
              payload: { requestId: msg.requestId, ...result },
            });
            return undefined;
          });
      default:
        return undefined;
    }
  }

  private dispatchPluginMarketMessage(msg: PluginMarketInboundMessage): Promise<void> {
    if (!this.pluginRuntime) throw new Error("Plugin service is unavailable");
    if (msg.type === "plugin.builtin.list.request") {
      this.emit({
        type: "plugin.builtin.list.response",
        payload: { requestId: msg.requestId, plugins: this.pluginRuntime.listBuiltinPluginIds() },
      });
      return Promise.resolve();
    }
    if (msg.type === "plugin.market.list.request") {
      return this.pluginRuntime.getPluginMarket().then((market) => {
        this.emit({
          type: "plugin.market.list.response",
          payload: { requestId: msg.requestId, ...market },
        });
        return undefined;
      });
    }
    if (msg.type === "plugin.readme.get.request") {
      return this.pluginRuntime.getPluginReadme(msg.source, msg.locale).then((markdown) => {
        this.emit({
          type: "plugin.readme.get.response",
          payload: { requestId: msg.requestId, markdown },
        });
        return undefined;
      });
    }
    return this.pluginRuntime.searchPluginMarket(msg.query, { mirror: msg.mirror }).then((hits) => {
      this.emit({
        type: "plugin.market.search.response",
        payload: { requestId: msg.requestId, hits },
      });
      return undefined;
    });
  }

  private dispatchPluginMessage(msg: SessionInboundMessage): Promise<void> | undefined {
    if (isPluginMarketMessage(msg)) return this.dispatchPluginMarketMessage(msg);
    if (msg.type === "plugin.list.request") {
      return (this.pluginRuntime?.listPlugins() ?? Promise.resolve([])).then((plugins) => {
        this.emit({
          type: "plugin.list.response",
          payload: { requestId: msg.requestId, plugins },
        });
        return undefined;
      });
    }
    if (msg.type === "plugin.logs.get.request") {
      if (!this.pluginRuntime) throw new Error("Plugin service is unavailable");
      this.emit({
        type: "plugin.logs.get.response",
        payload: {
          requestId: msg.requestId,
          pluginId: msg.pluginId,
          entries: this.pluginRuntime.getLogs(msg.pluginId),
        },
      });
      return undefined;
    }
    if (msg.type === "plugin.web_asset.get.request") {
      return this.dispatchPluginWebAssetMessage(msg);
    }
    if (msg.type === "plugin.reload.request") {
      if (!this.pluginRuntime) throw new Error("Plugin service is unavailable");
      return this.pluginRuntime.reloadPlugin(msg.pluginId).then((plugin) => {
        this.emit({
          type: "plugin.reload.response",
          payload: { requestId: msg.requestId, plugin },
        });
        return undefined;
      });
    }
    if (msg.type === "plugin.enable.request") {
      if (!this.pluginRuntime) throw new Error("Plugin service is unavailable");
      return this.pluginRuntime.enablePlugin(msg.pluginId).then((plugin) => {
        this.emit({
          type: "plugin.enable.response",
          payload: { requestId: msg.requestId, plugin },
        });
        return undefined;
      });
    }
    if (msg.type === "plugin.disable.request") {
      if (!this.pluginRuntime) throw new Error("Plugin service is unavailable");
      return this.pluginRuntime.disablePlugin(msg.pluginId).then((plugin) => {
        this.emit({
          type: "plugin.disable.response",
          payload: { requestId: msg.requestId, plugin },
        });
        return undefined;
      });
    }
    if (msg.type === "plugin.remove.request") {
      if (!this.pluginRuntime) throw new Error("Plugin service is unavailable");
      return this.pluginRuntime.removePlugin(msg.pluginId).then(() => {
        this.emit({ type: "plugin.remove.response", payload: { requestId: msg.requestId } });
        return undefined;
      });
    }
    if (msg.type === "plugin.catalog.get.request") {
      const cached = new Map(
        msg.cachedClientBundles?.map((entry) => [entry.id, entry.clientBundleHash]),
      );
      const plugins = (this.pluginRuntime?.catalog() ?? []).map(({ clientBundle, ...plugin }) =>
        plugin.clientBundleHash !== undefined && cached.get(plugin.id) === plugin.clientBundleHash
          ? plugin
          : Object.assign(plugin, { clientBundle }),
      );
      this.emit({
        type: "plugin.catalog.get.response",
        payload: { requestId: msg.requestId, plugins },
      });
      return undefined;
    }
    return undefined;
  }

  private dispatchPluginWebAssetMessage(
    msg: Extract<SessionInboundMessage, { type: "plugin.web_asset.get.request" }>,
  ): Promise<void> {
    if (!this.pluginRuntime) throw new Error("Plugin service is unavailable");
    return this.pluginRuntime.getWebAsset(msg.pluginId, msg.path).then((asset) => {
      this.emit({
        type: "plugin.web_asset.get.response",
        payload: { requestId: msg.requestId, ...asset },
      });
      return undefined;
    });
  }

  private dispatchPluginRpcMessage(msg: SessionInboundMessage): Promise<void> | undefined {
    if (msg.type === "plugin.rpc.invoke.request") {
      if (!this.pluginRuntime) throw new Error("Plugin service is unavailable");
      return this.pluginRuntime
        .invokePluginRpc(msg.pluginId, msg.method, msg.input)
        .then((output) => this.replyPluginRpc(msg, output));
    }
    if (msg.type === "plugin.rpc.subscribe.request") return this.subscribePluginRpc(msg);
    return undefined;
  }

  /** A `Uint8Array` output is the binary form of `plugin.rpc.invoke.response`. */
  private async replyPluginRpc(
    request: Extract<SessionInboundMessage, { type: "plugin.rpc.invoke.request" }>,
    output: unknown,
  ): Promise<void> {
    const response: SessionOutboundMessage = {
      type: "plugin.rpc.invoke.response",
      payload: { requestId: request.requestId, output },
    };
    if (!(output instanceof Uint8Array)) {
      this.emit(response);
      return;
    }
    // The frame is the binary form of the response, so it needs the response's permission.
    if (!this.authorization.allowsOutbound(response)) return;
    if (!this.supports(CLIENT_CAPS.pluginBinaryPayloads) || this.onBinaryMessage === null)
      throw new Error(
        `Update Neox to receive the binary output of plugin RPC ${request.pluginId}.${request.method}`,
      );
    await this.emitBinaryReply(
      encodePluginOutputFrame(request.requestId, output),
      this.delivery.currentSource,
    );
  }

  private async subscribePluginRpc(
    request: Extract<SessionInboundMessage, { type: "plugin.rpc.subscribe.request" }>,
  ): Promise<void> {
    if (!this.pluginRuntime) throw new Error("Plugin service is unavailable");
    const subscription = this.pluginRuntime.subscribePluginRpc(
      request.pluginId,
      request.method,
      request.input,
    );
    const owner = this.delivery.begin("plugin-rpc", undefined, () => subscription.release());
    try {
      await subscription.ready;
    } catch (error) {
      await owner.release();
      throw error;
    }
    if (owner.signal.aborted) return;
    this.emit({
      type: "plugin.rpc.subscribe.response",
      payload: { requestId: request.requestId, subscriptionId: owner.responseId },
    });
    const close = (reason?: string) => {
      owner.emit({
        type: "plugin.rpc.closed",
        payload: {
          subscriptionId: owner.responseId,
          ...(reason === undefined ? {} : { error: reason }),
        },
      });
      void owner.release().catch(() => undefined);
    };
    subscription.attach({
      event: (event) => {
        const message: SessionOutboundMessage = {
          type: "plugin.rpc.event",
          payload: { subscriptionId: owner.responseId, event },
        };
        if (!(event instanceof Uint8Array)) {
          owner.emit(message);
          return;
        }
        if (!this.authorization.allowsOutbound(message)) return;
        if (this.onBinaryMessage === null) {
          subscription.release();
          close("This connection cannot carry binary plugin events");
          return;
        }
        owner.emitBinary(encodePluginEventFrame(owner.responseId, event));
      },
      closed: close,
    });
  }

  private dispatchPluginDirectoryMessage(msg: SessionInboundMessage): Promise<void> | undefined {
    if (msg.type === "plugin.source.install.request") {
      if (!this.pluginRuntime) throw new Error("Plugin service is unavailable");
      return this.pluginRuntime
        .installSource({
          // COMPAT(plugin-source-path): accepted for v0.7 clients; remove after 2027-09-01.
          source: formatPluginSourceReference(msg.source, msg.pluginPath),
          ...(msg.id ? { id: msg.id } : {}),
          ...(msg.ref ? { ref: msg.ref } : {}),
        })
        .then((plugin) => {
          this.emit({
            type: "plugin.source.install.response",
            payload: { requestId: msg.requestId, plugin },
          });
          return undefined;
        });
    }
    if (msg.type === "plugin.source.status.request") {
      if (!this.pluginRuntime) throw new Error("Plugin service is unavailable");
      return this.pluginRuntime.statusSources(msg.pluginId).then((plugins) => {
        this.emit({
          type: "plugin.source.status.response",
          payload: { requestId: msg.requestId, plugins },
        });
        return undefined;
      });
    }
    if (msg.type === "plugin.source.update.preview.request") {
      if (!this.pluginRuntime) throw new Error("Plugin service is unavailable");
      return this.pluginRuntime
        .previewUpdates({ pluginId: msg.pluginId, target: msg.target })
        .then((plugins) => {
          this.emit({
            type: "plugin.source.update.preview.response",
            payload: { requestId: msg.requestId, plugins },
          });
          return undefined;
        });
    }
    if (msg.type === "plugin.source.update.apply.request") {
      if (!this.pluginRuntime) throw new Error("Plugin service is unavailable");
      return this.pluginRuntime.applyUpdates(msg.proposals).then((plugins) => {
        this.emit({
          type: "plugin.source.update.apply.response",
          payload: { requestId: msg.requestId, plugins },
        });
        return undefined;
      });
    }
    if (msg.type === "plugin.source.update.request") {
      if (!this.pluginRuntime) throw new Error("Plugin service is unavailable");
      return this.pluginRuntime.updateSources(msg.pluginId).then((plugins) => {
        this.emit({
          type: "plugin.source.update.response",
          payload: { requestId: msg.requestId, plugins },
        });
        return undefined;
      });
    }
    if (msg.type === "plugin.directory.install.request") {
      if (!this.pluginRuntime) throw new Error("Plugin service is unavailable");
      return this.pluginRuntime.installDirectory({ path: msg.path, id: msg.id }).then((plugin) => {
        this.emit({
          type: "plugin.directory.install.response",
          payload: { requestId: msg.requestId, plugin },
        });
        return undefined;
      });
    }
    if (msg.type === "plugin.directory.inspect.request") {
      if (!this.pluginRuntime) throw new Error("Plugin service is unavailable");
      return this.pluginRuntime.inspectDirectory(msg.path).then(({ id }) => {
        this.emit({
          type: "plugin.directory.inspect.response",
          payload: { requestId: msg.requestId, id },
        });
        return undefined;
      });
    }
    return undefined;
  }

  /** The gateway's status and route-trace snapshots. */
  private handleGatewaySnapshotRpc(msg: GatewaySnapshotRpcRequest): Promise<void> | undefined {
    const service = this.requireLlmGateway();
    if (msg.type === "gateway.status.get.request") {
      this.emit({
        type: "gateway.status.get.response",
        payload: { requestId: msg.requestId, status: this.gatewayStatus(service) },
      });
      return undefined;
    }
    if (msg.type === "gateway.trace.get.request") {
      return this.handleGatewayTraceGet(msg, service);
    }
    return undefined;
  }

  /** The routing trace, with title turns put under the chats they titled. */
  private async handleGatewayTraceGet(
    msg: Extract<SessionInboundMessage, { type: "gateway.trace.get.request" }>,
    service: LlmGatewayService,
  ): Promise<void> {
    const snapshot = service.runtime.routeTrace.snapshot();
    const routes = await resolveTitleRows(snapshot.routes);
    this.emit({
      type: "gateway.trace.get.response",
      payload: {
        requestId: msg.requestId,
        trace: GatewayRouteTraceWireSchema.parse({ ...snapshot, routes }),
      },
    });
  }

  /** The read-only gateway RPCs: status, trace, and the request views. */
  private handleGatewayReadRpc(
    msg: GatewaySnapshotRpcRequest | GatewayDiagnosticsRpcRequest,
    service: LlmGatewayService,
  ): Promise<void> | undefined {
    if (isGatewaySnapshotRpcRequest(msg)) {
      return this.handleGatewaySnapshotRpc(msg);
    }
    return this.handleGatewayDiagnosticsRpc(msg, service);
  }

  /** The request views: routing history, the archive, prompt text, route events. */
  private handleGatewayDiagnosticsRpc(
    msg: GatewayDiagnosticsRpcRequest,
    service: LlmGatewayService,
  ): Promise<void> | undefined {
    if (msg.type === "gateway.routing.history.request") {
      return readRoutingHistory(service.history, msg.day ?? "").then(async (read) => {
        // A day's title turns are drawn under the chats they titled, where
        // Codex's own name index says which (myna's ResolveTitleParents).
        const routes = await resolveTitleRows(read.routes);
        this.emit({
          type: "gateway.routing.history.response",
          payload: { requestId: msg.requestId, ...read, routes },
        });
        return undefined;
      });
    }
    if (msg.type === "gateway.archive.get.request") {
      return readArchivedCall(service.archive, msg.date, msg.id).then((archive) => {
        this.emit({
          type: "gateway.archive.get.response",
          payload: { requestId: msg.requestId, archive },
        });
        return undefined;
      });
    }
    if (msg.type === "gateway.prompt_text.get.request") {
      this.emit({
        type: "gateway.prompt_text.get.response",
        payload: { requestId: msg.requestId, text: readPromptText(msg.id) },
      });
      return undefined;
    }
    if (msg.type === "gateway.route_events.get.request") {
      this.emit({
        type: "gateway.route_events.get.response",
        payload: { requestId: msg.requestId, ...readRouteEvents(msg.after ?? 0) },
      });
      return undefined;
    }
    if (msg.type === "gateway.prompt_reply.get.request") {
      return readPromptReply(service.archive, msg.date, msg.id).then((reply) => {
        this.emit({
          type: "gateway.prompt_reply.get.response",
          payload: {
            requestId: msg.requestId,
            reply: reply === null ? null : GatewayReplyWireSchema.parse(reply),
          },
        });
        return undefined;
      });
    }
    if (msg.type === "gateway.tune.get.request") {
      return this.handleGatewayTuneGet(msg, service);
    }
    if (msg.type === "gateway.tune.apply.request") {
      return applyTune({
        agent: msg.agent,
        knob: msg.knob,
        value: msg.value,
        neolixHome: this.neolixHome,
        ...(msg.model === undefined ? {} : { model: msg.model }),
      }).then(
        (setting) => {
          this.emitTuneChange(msg.requestId, setting, null);
          return undefined;
        },
        (cause: unknown) => {
          this.emitTuneChange(msg.requestId, null, tuneErrorMessage(cause));
          return undefined;
        },
      );
    }
    if (msg.type === "gateway.tune.undo.request") {
      return undoTune({
        agent: msg.agent,
        knob: msg.knob,
        neolixHome: this.neolixHome,
        ...(msg.model === undefined ? {} : { model: msg.model }),
      }).then(
        (setting) => {
          this.emitTuneChange(msg.requestId, setting, null);
          return undefined;
        },
        (cause: unknown) => {
          this.emitTuneChange(msg.requestId, null, tuneErrorMessage(cause));
          return undefined;
        },
      );
    }
    return undefined;
  }

  /**
   * The settings tune would change, from the user's own calls: the usage
   * ledger's records replayed the way myna replays an agent's sessions.
   */
  private handleGatewayTuneGet(
    msg: Extract<SessionInboundMessage, { type: "gateway.tune.get.request" }>,
    service: LlmGatewayService,
  ): Promise<void> {
    const days = msg.days ?? 7;
    const since = Date.now() - days * 86_400_000;
    const windows = new Map<string, number>();
    for (const provider of service.configStore.get().providers) {
      for (const model of provider.models) {
        if (model.contextWindow !== undefined && !windows.has(model.id.toLowerCase())) {
          windows.set(model.id.toLowerCase(), model.contextWindow);
        }
      }
    }
    return readUsageRecords(service.ledger.filePath, since).then(async (records) => {
      const advice = tuneAdvice(tuneCalls(records), {
        windowOf: (model) => windows.get(model) ?? null,
      });
      const enriched = await Promise.all(
        advice.map((entry) => enrichTuneAdvice(entry, this.neolixHome)),
      );
      this.emit({
        type: "gateway.tune.get.response",
        payload: {
          requestId: msg.requestId,
          days,
          advice: GatewayTuneAdviceWireSchema.array().parse(enriched),
        },
      });
      return undefined;
    });
  }

  /** The setting Neolix put in, or why it could not. */
  private emitTuneChange(
    requestId: string,
    setting: TuneSettingState | null,
    error: string | null,
  ): void {
    this.emit({
      type: "gateway.tune.change.response",
      payload: {
        requestId,
        setting: setting === null ? null : GatewayTuneSettingWireSchema.parse(setting),
        error,
      },
    });
  }

  /** The provider probes, import preview and balance the settings page asks for. */
  /**
   * `neolix sync` (myna's main.go:497): every ready vendor's list is fetched
   * again, a newly listed model its AutoInclude rules match joins what it
   * serves (`auto-include.ts`), and models.dev's price catalog is fetched now
   * instead of waiting for its six-hour timer.
   */
  private async handleGatewayCatalogRefresh(
    msg: Extract<SessionInboundMessage, { type: "gateway.catalog.refresh.request" }>,
    service: LlmGatewayService,
  ): Promise<void> {
    // The scheduler owns the fetch: its retry guard keeps a vendor that just
    // failed from being asked again, and a fetched list is merged and
    // stamped on the provider (myna's RefreshLists, through list-refresh).
    const before = new Map(
      service.configStore
        .get()
        .providers.map((provider) => [provider.id, provider.listFetchedAt] as const),
    );
    const scheduler = service.runtime.listRefresh;
    const asked = scheduler === undefined ? [] : await scheduler.refreshNow();
    const config = service.configStore.get();
    const listed = asked.map((id) => {
      const provider = config.providers.find((entry) => entry.id === id);
      const ids = provider?.models.map((model) => model.id) ?? [];
      // takeAutoIncludedModels stamps listFetchedAt only when the vendor
      // answered, so an unchanged stamp is a failed fetch.
      if (provider !== undefined && provider.listFetchedAt === before.get(id)) {
        return { id, ids: [], taken: [], error: "the vendor did not answer its model list" };
      }
      return { id, ids, taken: [] };
    });
    const pricing = service.runtime.pricing;
    const catalog =
      pricing === undefined
        ? { ok: false, error: "this daemon has no price catalog" }
        : await pricing.refresh(Date.now());
    this.emit({
      type: "gateway.catalog.refresh.response",
      payload: { requestId: msg.requestId, ...catalog, providers: listed },
    });
  }

  private handleGatewayProviderRpc(msg: GatewayProviderRpcRequest): Promise<void> | undefined {
    // The editor's Test, Detect and model-list refresh are Neolix's own calls:
    // they are written to the request log as probes, never counted as usage.
    const service = this.requireLlmGateway();
    const probe = probeRecorder(service.ledger);
    if (msg.type === "gateway.provider.get_models.request") {
      return this.emitProviderModels(msg, service, probe);
    }
    if (msg.type === "gateway.claude.mode.get.request") {
      return this.emitClaudeMode(msg.requestId, service);
    }
    if (msg.type === "gateway.provider.test_model.request") {
      return this.emitProviderTestModel(msg, probe);
    }
    if (msg.type === "gateway.provider.detect.request") {
      return detectProviderProtocols(
        probeTargetOf(msg),
        msg.model === undefined || msg.model.length === 0 ? null : msg.model,
        probe,
      ).then((results) => {
        this.emit({
          type: "gateway.provider.detect.response",
          payload: {
            requestId: msg.requestId,
            results: results.map((result) => ({
              protocol: result.protocol,
              base: result.base,
              ok: result.ok,
              status: result.status,
              error: result.error,
            })),
          },
        });
        return undefined;
      });
    }
    if (msg.type === "gateway.pricing.get.request") {
      const catalog = this.requireLlmGateway().runtime.pricing;
      const prices: Record<string, GatewayPriceWire | null> = {};
      const provider = this.requireLlmGateway()
        .configStore.get()
        .providers.find((entry) => entry.id === msg.provider);
      for (const model of msg.models) {
        prices[model] = modelPriceWire(catalog, msg.provider, provider, model);
      }
      this.emit({
        type: "gateway.pricing.get.response",
        payload: { requestId: msg.requestId, prices },
      });
      return undefined;
    }
    if (msg.type === "gateway.provider.upstream_status.request") {
      return readUpstreamStatuses().then((statuses) => {
        this.emit({
          type: "gateway.provider.upstream_status.response",
          payload: {
            requestId: msg.requestId,
            statuses: statuses.map((status) => ({
              vendor: status.vendor,
              name: status.name,
              page: status.page,
              hosts: [...status.hosts],
              level: status.level,
              parts: status.parts.map((part) => ({ name: part.name, status: part.status })),
              incidents: status.incidents.map((incident) => ({
                name: incident.name,
                ...(incident.impact === undefined ? {} : { impact: incident.impact }),
                ...(incident.url === undefined ? {} : { url: incident.url }),
              })),
              readAt: status.readAt,
              ...(status.error === undefined ? {} : { error: status.error }),
            })),
          },
        });
        return undefined;
      });
    }
    if (isSignInRpcRequest(msg)) {
      return this.handleGatewaySigninRpc(msg);
    }
    if (isCodexAccountRpcRequest(msg)) {
      return this.handleCodexAccountRpc(msg);
    }
    if (msg.type === "gateway.codex.status.request") {
      return this.handleGatewayCodexStatus(msg);
    }
    if (msg.type === "gateway.provider.balance.request") {
      return this.emitProviderBalance(msg);
    }
    if (msg.type === "gateway.provider.preview_import.request") {
      return readImportSources().then((sources) => {
        this.emit({
          type: "gateway.provider.preview_import.response",
          payload: {
            requestId: msg.requestId,
            sources: sources.map((source) => ({
              id: source.id,
              name: source.name,
              path: source.path,
              found: source.found,
              ...(source.error === undefined ? {} : { error: source.error }),
              providers: source.providers.map((provider) => ({
                source: provider.source,
                ref: provider.ref,
                name: provider.name,
                protocol: provider.protocol,
                baseUrl: provider.baseUrl,
                ...(provider.apiKey === undefined ? {} : { apiKey: provider.apiKey }),
                models: provider.models,
                ...(provider.headers === undefined ? {} : { headers: provider.headers }),
                ...(provider.enabled === false ? { enabled: false } : {}),
              })),
            })),
          },
        });
        return undefined;
      });
    }
    return undefined;
  }

  /** Neolix's own ChatGPT accounts: list them, or remove one. */
  private handleCodexAccountRpc(msg: CodexAccountRpcRequest): Promise<void> {
    const file = join(this.neolixHome, "gateway", "codex-accounts.json");
    if (msg.type === "gateway.codex.accounts.request") {
      const config = this.llmGateway?.configStore.get();
      const discovery = accountDiscoveryOn(config);
      const sessionReads = config?.codexSessionReads;
      return discoverCodexAccounts(
        sessionReads === undefined ? { discovery } : { discovery, sessionReads },
      ).then(async (found) => {
        const owned = await loadCodexAccounts(file);
        this.emit({
          type: "gateway.codex.accounts.response",
          payload: {
            requestId: msg.requestId,
            discovery: found.discovery,
            owned: redactedCodexAccounts(owned),
            codex: found.accounts[0] ?? null,
          },
        });
        return undefined;
      });
    }
    if (msg.type === "gateway.codex.account.arrange.request") {
      return arrangeOwnedCodexAccounts(file, msg.order).then(() => {
        this.emit({
          type: "gateway.codex.account.arrange.response",
          payload: { requestId: msg.requestId },
        });
        return undefined;
      });
    }
    if (msg.type === "gateway.codex.account.set.request") {
      return setOwnedCodexAccountEnabled(file, msg.id, msg.enabled).then(() => {
        this.emit({
          type: "gateway.codex.account.set.response",
          payload: { requestId: msg.requestId },
        });
        return undefined;
      });
    }
    if (msg.type === "gateway.codex.account.import.request") {
      const imported = importRequestOf(msg, file);
      return imported.then((result) => {
        this.emit({
          type: "gateway.codex.account.import.response",
          payload: { requestId: msg.requestId, ...result },
        });
        return undefined;
      });
    }
    return removeOwnedCodexAccount(file, msg.id).then(() => {
      this.emit({
        type: "gateway.codex.account.remove.response",
        payload: { requestId: msg.requestId },
      });
      return undefined;
    });
  }

  /** The editor's model-list refresh, and the AutoInclude merge it makes. */
  private emitProviderModels(
    msg: Extract<GatewayProviderRpcRequest, { type: "gateway.provider.get_models.request" }>,
    service: LlmGatewayService,
    probe: ReturnType<typeof probeRecorder>,
  ): Promise<void> {
    // An Antigravity provider is signed in to accounts, not a URL: its
    // list is the pool those accounts listed (antigravity-pool.ts), which
    // the gateway already wrote into the provider.
    const signedIn =
      msg.providerId === undefined
        ? undefined
        : service.configStore.get().providers.find((provider) => provider.id === msg.providerId);
    if (
      signedIn !== undefined &&
      providerAccounts(signedIn).some((account) => account.agent === "antigravity")
    ) {
      this.emit({
        type: "gateway.provider.get_models.response",
        payload: {
          requestId: msg.requestId,
          models: servedModels(signedIn).map((model) => model.id),
          error: null,
        },
      });
      return Promise.resolve();
    }
    return fetchProviderModels(probeTargetOf(msg), probe)
      .then(async (models) => {
        if (msg.providerId !== undefined) {
          // A saved provider keeps its list fresh here too, not only in the
          // CLI and the app (myna's takeMatching). The list the form asked
          // for is answered even when the merge cannot be saved.
          await takeAutoIncludedModels(service.configStore, msg.providerId, models).catch(
            (error: unknown) => {
              this.sessionLogger.warn(
                { err: error, provider: msg.providerId },
                "Cannot merge the newly listed models",
              );
            },
          );
        }
        this.emit({
          type: "gateway.provider.get_models.response",
          payload: { requestId: msg.requestId, models, error: null },
        });
        return undefined;
      })
      .catch((cause: unknown) => {
        this.emit({
          type: "gateway.provider.get_models.response",
          payload: {
            requestId: msg.requestId,
            models: [],
            error: cause instanceof Error ? cause.message : String(cause),
          },
        });
      });
  }

  /** The editor's balance check against the provider's own endpoint. */
  private emitProviderBalance(
    msg: Extract<GatewayProviderRpcRequest, { type: "gateway.provider.balance.request" }>,
  ): Promise<void> {
    return readProviderBalance({
      balanceUrl: msg.balanceUrl,
      ...(msg.balancePath === undefined ? {} : { balancePath: msg.balancePath }),
      ...(msg.apiKey === undefined ? {} : { apiKey: msg.apiKey }),
      ...(msg.baseUrls === undefined ? {} : { baseUrls: msg.baseUrls }),
      ...(msg.headers === undefined ? {} : { headers: msg.headers }),
      ...(msg.method === undefined ? {} : { method: msg.method }),
      ...(msg.token === undefined ? {} : { token: msg.token }),
    }).then((result) => {
      this.emit({
        type: "gateway.provider.balance.response",
        payload: {
          requestId: msg.requestId,
          amount: result.amount,
          ...(result.error === undefined ? {} : { error: result.error }),
        },
      });
      return undefined;
    });
  }

  /** The editor's Test: one tiny request to the model it names. */
  private emitProviderTestModel(
    msg: Extract<GatewayProviderRpcRequest, { type: "gateway.provider.test_model.request" }>,
    probe: ReturnType<typeof probeRecorder>,
  ): Promise<void> {
    return testProviderModel(probeTargetOf(msg), msg.model, probe).then((result) => {
      this.emit({
        type: "gateway.provider.test_model.response",
        payload: { requestId: msg.requestId, ...result },
      });
      return undefined;
    });
  }

  /** The provider editor's "Claude Code runs as" read, as myna's /api/claude/mode. */
  private emitClaudeMode(requestId: string, service: LlmGatewayService): Promise<void> {
    return findClaudeBinary({ env: process.env })
      .catch(() => "")
      .then((binary) => {
        const mode = claudeModeNow({
          platform: process.platform,
          hasBinary: binary !== "",
          printMode: service.configStore.get().claudePrintMode === true,
        });
        this.emit({
          type: "gateway.claude.mode.get.response",
          payload: { requestId, mode },
        });
        return undefined;
      });
  }

  /** The gateway's sign-in flow, shaped as myna's: start, status, cancel, callback. */
  private handleGatewaySigninRpc(msg: SignInRpcRequest): Promise<void> {
    const context = { accountsFile: join(this.neolixHome, "gateway", "codex-accounts.json") };
    if (msg.type === "gateway.signin.start.request") {
      return startGatewaySignIn(
        {
          agent: msg.agent,
          ...(msg.site === undefined ? {} : { site: msg.site }),
          ...(msg.proxy === undefined ? {} : { proxy: msg.proxy }),
          ...(msg.user === undefined ? {} : { user: msg.user }),
        },
        context,
      ).then((state) => {
        this.emit({
          type: "gateway.signin.start.response",
          payload: { requestId: msg.requestId, state },
        });
        return undefined;
      });
    }
    if (msg.type === "gateway.signin.status.request") {
      return statusGatewaySignIn(msg.id, context).then((state) => {
        this.emit({
          type: "gateway.signin.status.response",
          payload: { requestId: msg.requestId, state },
        });
        return undefined;
      });
    }
    if (msg.type === "gateway.signin.cancel.request") {
      const ok = cancelGatewaySignIn(msg.id);
      this.emit({
        type: "gateway.signin.cancel.response",
        payload: { requestId: msg.requestId, ok },
      });
      return Promise.resolve();
    }
    if (msg.type === "gateway.subscription.list.request") {
      return this.handleSubscriptionList(msg);
    }
    if (msg.type === "gateway.subscription.remove.request") {
      return this.handleSubscriptionRemove(msg);
    }
    if (msg.type === "gateway.subscription.import.request") {
      return this.handleSubscriptionImport(msg);
    }
    if (msg.type === "gateway.subscription.add.request") {
      return this.handleSubscriptionAdd(msg);
    }
    if (msg.type === "gateway.subscription.switch.request") {
      return this.handleSubscriptionSwitch(msg);
    }
    return callbackGatewaySignIn(msg.id, msg.url, context).then((result) => {
      this.emit({
        type: "gateway.signin.callback.response",
        payload: {
          requestId: msg.requestId,
          ok: result.ok,
          ...(result.error === undefined ? {} : { error: result.error }),
        },
      });
      return undefined;
    });
  }

  /**
   * The subscriptions Neolix signed in to itself, with every token left out
   * (`redactedSubscriptionAccounts`): the page's account rows. One agent's,
   * or every one the daemon keeps.
   */
  private handleSubscriptionList(
    msg: Extract<SessionInboundMessage, { type: "gateway.subscription.list.request" }>,
  ): Promise<void> {
    const agents: SubscriptionAgent[] = [];
    if (msg.agent === undefined) {
      agents.push("chatgpt-api", "copilot", "gemini", "antigravity", "factory");
    } else if (isSubscriptionAgent(msg.agent)) {
      agents.push(msg.agent);
    }
    const dir = join(this.neolixHome, "gateway");
    const files = [...new Set(agents.map((agent) => subscriptionAccountsFile(dir, agent)))];
    return Promise.all(files.map((file) => loadAnySubscriptionAccounts(file))).then((lists) => {
      const accounts = lists.flat().filter((account) => agents.includes(account.agent));
      this.emit({
        type: "gateway.subscription.list.response",
        payload: {
          requestId: msg.requestId,
          accounts: redactedSubscriptionAccounts(accounts),
        },
      });
      return undefined;
    });
  }

  /** Forgets one of the subscriptions Neolix signed in to itself. */
  private handleSubscriptionRemove(
    msg: Extract<SessionInboundMessage, { type: "gateway.subscription.remove.request" }>,
  ): Promise<void> {
    const respond = (ok: boolean): void => {
      this.emit({
        type: "gateway.subscription.remove.response",
        payload: { requestId: msg.requestId, ok },
      });
    };
    if (!isSubscriptionAgent(msg.agent)) {
      respond(false);
      return Promise.resolve();
    }
    const file = subscriptionAccountsFile(join(this.neolixHome, "gateway"), msg.agent);
    const wanted = msg.user.trim().toLowerCase();
    return loadAnySubscriptionAccounts(file)
      .then((all) => {
        const account = all.find(
          (entry) =>
            entry.agent === msg.agent &&
            (entry.id.toLowerCase() === wanted ||
              entry.user.trim().toLowerCase() === wanted ||
              (entry.alias ?? "").trim().toLowerCase() === wanted),
        );
        if (account === undefined) {
          respond(false);
          return undefined;
        }
        return saveSubscriptionAccounts(
          file,
          all.filter((entry) => entry.id !== account.id),
        ).then(() => respond(true));
      })
      .catch(() => respond(false));
  }

  /**
   * Accounts brought in from another tool's export (myna's
   * `/api/signin/import`): each file's text as it is, checked with the
   * vendor before it is kept. Only Antigravity has such an export today.
   */
  private handleSubscriptionImport(
    msg: Extract<SessionInboundMessage, { type: "gateway.subscription.import.request" }>,
  ): Promise<void> {
    const respond = (results: ImportedSubscriptionAccount[], error?: string): void => {
      this.emit({
        type: "gateway.subscription.import.response",
        payload: {
          requestId: msg.requestId,
          results,
          ...(error === undefined ? {} : { error }),
        },
      });
    };
    if (msg.agent !== "antigravity") {
      respond([], `Importing ${msg.agent} accounts is not supported here yet`);
      return Promise.resolve();
    }
    return importGoogleAccounts({ gatewayDir: join(this.neolixHome, "gateway"), texts: msg.files })
      .then((results) => respond(results))
      .catch((error: unknown) => {
        respond([], error instanceof Error ? error.message : String(error));
      });
  }

  /**
   * Adds a Factory account by its API key (`provider/factory_key.go`):
   * `whoami` accepts the key and names the account before anything is kept.
   */
  private handleSubscriptionAdd(
    msg: Extract<SessionInboundMessage, { type: "gateway.subscription.add.request" }>,
  ): Promise<void> {
    const respond = (result: {
      ok: boolean;
      account?: ReturnType<typeof redactedSubscriptionAccounts>[number];
      error?: string;
    }): void => {
      this.emit({
        type: "gateway.subscription.add.response",
        payload: {
          requestId: msg.requestId,
          ok: result.ok,
          ...(result.account === undefined ? {} : { account: result.account }),
          ...(result.error === undefined ? {} : { error: result.error }),
        },
      });
    };
    if (msg.agent !== "factory") {
      respond({ ok: false, error: `Adding ${msg.agent} accounts by key is not supported here` });
      return Promise.resolve();
    }
    return (async () => {
      try {
        const added = await addFactoryKey(msg.key);
        if ("error" in added) {
          respond({ ok: false, error: added.error });
          return;
        }
        const file = subscriptionAccountsFile(join(this.neolixHome, "gateway"), "factory");
        const all = await loadAnySubscriptionAccounts(file);
        await saveSubscriptionAccounts(file, addSubscriptionAccount(all, added.account));
        respond({
          ok: true,
          account: redactedSubscriptionAccounts([added.account])[0],
        });
      } catch (error) {
        respond({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    })();
  }

  /**
   * Makes one saved account first in its agent's store, as `accounts
   * switch` does: the account the gateway serves next (`First` in myna's
   * `logins.go`). The other agent's entries in a shared Google store stay.
   */
  private handleSubscriptionSwitch(
    msg: Extract<SessionInboundMessage, { type: "gateway.subscription.switch.request" }>,
  ): Promise<void> {
    const respond = (result: {
      ok: boolean;
      account?: ReturnType<typeof redactedSubscriptionAccounts>[number];
      error?: string;
    }): void => {
      this.emit({
        type: "gateway.subscription.switch.response",
        payload: {
          requestId: msg.requestId,
          ok: result.ok,
          ...(result.account === undefined ? {} : { account: result.account }),
          ...(result.error === undefined ? {} : { error: result.error }),
        },
      });
    };
    if (!isSubscriptionAgent(msg.agent)) {
      respond({ ok: false, error: `${msg.agent} accounts are not kept here` });
      return Promise.resolve();
    }
    const agent = msg.agent;
    const file = subscriptionAccountsFile(join(this.neolixHome, "gateway"), agent);
    const wanted = msg.user.trim().toLowerCase();
    return (async () => {
      try {
        const all = await loadAnySubscriptionAccounts(file);
        const index = all.findIndex(
          (entry) =>
            entry.agent === agent &&
            (entry.id.toLowerCase() === wanted ||
              entry.user.trim().toLowerCase() === wanted ||
              (entry.alias ?? "").trim().toLowerCase() === wanted),
        );
        const target = all[index];
        if (index < 0 || target === undefined) {
          respond({ ok: false, error: `no ${agent} account "${msg.user}"` });
          return;
        }
        // The chosen one takes the place of the first of its agent's,
        // leaving the other agent's entries where they were.
        const next = switchSubscriptionAccount(all, agent, target.id);
        await saveSubscriptionAccounts(file, next);
        respond({
          ok: true,
          account: redactedSubscriptionAccounts([target])[0],
        });
      } catch (error) {
        respond({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    })();
  }

  /**
   * Reads Codex's own ChatGPT sign-in for the gateway's Codex page. The
   * switches in gateway.json decide whether anything is read at all.
   */
  private handleGatewayCodexStatus(
    msg: Extract<SessionInboundMessage, { type: "gateway.codex.status.request" }>,
  ): Promise<void> {
    const config = this.llmGateway?.configStore.get();
    const discovery = accountDiscoveryOn(config);
    const sessionReads = config?.codexSessionReads;
    return discoverCodexAccounts(
      sessionReads === undefined ? { discovery } : { discovery, sessionReads },
    ).then((result) => {
      this.emit({
        type: "gateway.codex.status.response",
        payload: {
          requestId: msg.requestId,
          discovery: result.discovery,
          accounts: result.accounts,
        },
      });
      return undefined;
    });
  }

  private handleHeldReportRequest(
    msg: Extract<
      SessionInboundMessage,
      {
        type:
          | "gateway.held.list.request"
          | "gateway.held.read.request"
          | "gateway.held.reveal.request";
      }
    >,
  ): Promise<void> | undefined {
    if (msg.type === "gateway.held.list.request") {
      return listHeldReports().then((names) => {
        this.emit({
          type: "gateway.held.list.response",
          payload: { requestId: msg.requestId, names },
        });
        return undefined;
      });
    }
    if (msg.type === "gateway.held.read.request") {
      return readHeldReport(msg.name).then((text) => {
        this.emit({
          type: "gateway.held.read.response",
          payload: { requestId: msg.requestId, name: msg.name, text },
        });
        return undefined;
      });
    }
    return revealHeldReport(msg.name).then((result) => {
      this.emit({
        type: "gateway.held.reveal.response",
        payload: {
          requestId: msg.requestId,
          ok: result.ok,
          ...(result.error === undefined ? {} : { error: result.error }),
        },
      });
      return undefined;
    });
  }

  private handleOidcRuleRequest(
    msg: Extract<
      SessionInboundMessage,
      {
        type:
          | "gateway.oidc.rules.list.request"
          | "gateway.oidc.rule.save.request"
          | "gateway.oidc.rule.remove.request";
      }
    >,
  ): Promise<void> | undefined {
    const service = this.requireLlmGateway();
    if (msg.type === "gateway.oidc.rules.list.request") {
      this.emit({
        type: "gateway.oidc.rules.list.response",
        payload: {
          requestId: msg.requestId,
          rules: oidcRulesWire(configuredOidcRules(service.configStore.get())),
        },
      });
      return undefined;
    }
    return this.applyOidcRuleChange(service, msg);
  }

  private async applyOidcRuleChange(
    service: NonNullable<SessionOptions["llmGateway"]>,
    msg: Extract<
      SessionInboundMessage,
      {
        type: "gateway.oidc.rule.save.request" | "gateway.oidc.rule.remove.request";
      }
    >,
  ): Promise<void> {
    const config = service.configStore.get();
    try {
      if (msg.type === "gateway.oidc.rule.remove.request") {
        const change = removeOidcRule(config, msg.id);
        await service.configStore.write({ ...config, oidc: oidcRulesForConfig(change.rules) });
        this.emit({
          type: "gateway.oidc.rule.remove.response",
          payload: { requestId: msg.requestId, rules: oidcRulesWire(change.rules) },
        });
        return;
      }
      const change = saveOidcRule(config, {
        ...(msg.id === undefined ? {} : { id: msg.id }),
        key: msg.key,
        ...(msg.issuer === undefined ? {} : { issuer: msg.issuer }),
        ...(msg.audience === undefined ? {} : { audience: msg.audience }),
        ...(msg.claims === undefined ? {} : { claims: msg.claims }),
        ...(msg.ttlSeconds === undefined ? {} : { ttlSeconds: msg.ttlSeconds }),
      });
      await service.configStore.write({ ...config, oidc: oidcRulesForConfig(change.rules) });
      this.emit({
        type: "gateway.oidc.rule.save.response",
        payload: {
          requestId: msg.requestId,
          rule: oidcRuleWire(change.rule),
          rules: oidcRulesWire(change.rules),
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const rules = configuredOidcRules(config);
      if (msg.type === "gateway.oidc.rule.remove.request") {
        this.emit({
          type: "gateway.oidc.rule.remove.response",
          payload: { requestId: msg.requestId, rules: oidcRulesWire(rules), error: message },
        });
        return;
      }
      this.emit({
        type: "gateway.oidc.rule.save.response",
        payload: {
          requestId: msg.requestId,
          rule: null,
          rules: oidcRulesWire(rules),
          error: message,
        },
      });
    }
  }

  private async updateWebPage(
    msg: Extract<SessionInboundMessage, { type: "daemon.web_page.set.request" }>,
  ): Promise<void> {
    const server = webPageServer();
    if (this.browserOrigin) {
      // myna's appPageRoutes: a browser on the page can't change the access it
      // came in through, nor read the key it came in without. Only the app's
      // own windows may.
      this.emit({
        type: "daemon.web_page.set.response",
        payload: {
          requestId: msg.requestId,
          page: null,
          error: "Change browser access from the Neox app, not from the page itself",
        },
      });
      return;
    }
    if (server === null) {
      this.emit({
        type: "daemon.web_page.set.response",
        payload: {
          requestId: msg.requestId,
          page: null,
          error: "this daemon serves no browser page",
        },
      });
      return;
    }
    try {
      const page = await server.update({
        ...(msg.mode === undefined ? {} : { mode: msg.mode }),
        ...(msg.port === undefined ? {} : { port: msg.port }),
        ...(msg.addr === undefined ? {} : { addr: msg.addr }),
        ...(msg.tlsCert === undefined ? {} : { tlsCert: msg.tlsCert }),
        ...(msg.tlsKey === undefined ? {} : { tlsKey: msg.tlsKey }),
        ...(msg.gateway === undefined ? {} : { gateway: msg.gateway }),
        ...(msg.newKey === undefined ? {} : { newKey: msg.newKey }),
      });
      this.emit({
        type: "daemon.web_page.set.response",
        payload: { requestId: msg.requestId, page: webPageWire(page) },
      });
    } catch (error) {
      this.emit({
        type: "daemon.web_page.set.response",
        payload: {
          requestId: msg.requestId,
          page: null,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  /**
   * Applies a daemon config patch. A network change is persisted and answers
   * `restartRequiredPaths`: the daemon never rebinds its own listener here.
   */
  private async applyDaemonConfigPatch(
    msg: Extract<SessionInboundMessage, { type: "set_daemon_config_request" }>,
  ): Promise<void> {
    const { network, ...patch } = msg.config;
    const config = await this.daemonConfigStore.patch(patch);
    let saved: (NetworkSettings & { restartRequired: true }) | undefined;
    if (network !== undefined) {
      saved = await saveNetworkSettings({
        neolixHome: this.neolixHome,
        listen: config.network?.listen ?? null,
        ...(network.port === undefined ? {} : { port: network.port }),
        ...(network.lan === undefined ? {} : { lan: network.lan }),
        ...(this.llmGateway === undefined ? {} : { gatewayStore: this.llmGateway.configStore }),
        logger: this.sessionLogger,
      });
    }
    const settings =
      saved === undefined
        ? undefined
        : {
            listen: saved.listen,
            port: saved.port,
            lan: saved.lan,
            lanKey: saved.lanKey,
            lanUrls: saved.lanUrls,
          };
    this.emit({
      type: "set_daemon_config_response",
      payload: {
        requestId: msg.requestId,
        config,
        ...(settings === undefined
          ? {}
          : { network: settings, restartRequiredPaths: ["daemon.listen"] }),
      },
    });
  }

  private handleGatewayRpc(
    msg: Extract<SessionInboundMessage, { type: `gateway.${string}.request` }>,
  ): Promise<void> | undefined {
    const service = this.requireLlmGateway();
    const configRpc = this.handleGatewayConfigRpc(msg, service);
    if (configRpc !== undefined) {
      return configRpc;
    }
    if (isGatewayQuotaRpcRequest(msg)) {
      return this.handleGatewayQuotaRpc(msg, service);
    }
    if (isGatewayReadRpcRequest(msg)) {
      return this.handleGatewayReadRpc(msg, service);
    }
    if (isGatewayProviderRpcRequest(msg)) {
      return this.handleGatewayProviderRpc(msg);
    }
    if (isGatewayMaskingRpcRequest(msg)) {
      return this.handleGatewayMaskingRpc(msg, service);
    }
    if (isGatewayCheckinRpcRequest(msg)) {
      return this.handleGatewayCheckinRpc(msg, service);
    }
    if (isGatewayPluginSubscriptionRpcRequest(msg)) {
      return this.handleGatewayPluginSubscriptionRpc(msg);
    }
    if (isGatewayPluginAgentRpcRequest(msg)) {
      return this.handleGatewayPluginAgentRpc(msg);
    }
    if (msg.type === "gateway.catalog.refresh.request") {
      return this.handleGatewayCatalogRefresh(msg, service);
    }
    this.emitGatewayConfig(
      service,
      "gateway.config.get.response",
      msg.requestId,
      service.configStore.get(),
    );
    return undefined;
  }

  /** The allowance cards' figures as the readings stand now. */
  private async emitQuotaSnapshot(
    service: LlmGatewayService,
    requestId: string,
    days: number,
    now: number,
    filter: { provider?: string; account?: string } = {},
  ): Promise<void> {
    // The history read adds the other computers' readings the usage sync
    // brought; the gateway's own file is never written by it.
    const history = await service.quotaHistory.historyWithShared(now - days * 86_400_000, filter);
    this.emit({
      type: "gateway.quota.get.response",
      payload: {
        requestId,
        quota: snapshotGatewayQuota({
          providers: service.configStore.get().providers,
          runtime: service.runtime,
          history,
          usage: service.ledger.accountUsageHistory(now),
          since: now - days * 86_400_000,
          now,
        }),
      },
    });
  }

  /** Usage and quota reads, and warming a window by hand. */
  private handleGatewayQuotaRpc(
    msg: Extract<
      SessionInboundMessage,
      {
        type:
          | "gateway.usage.get.request"
          | "gateway.search.quota.request"
          | "gateway.quota.get.request"
          | "gateway.quota.reset.request"
          | "gateway.quota.warm.request";
      }
    >,
    service: LlmGatewayService,
  ): Promise<void> | undefined {
    if (msg.type === "gateway.usage.get.request") {
      return this.handleGatewayUsageGet(msg, service);
    }
    if (msg.type === "gateway.search.quota.request") {
      const api = (service.configStore.get().search?.apis ?? []).find(
        (entry) => entry.vendor === msg.vendor,
      );
      if (api === undefined || !canReadSearchQuota(api)) {
        this.emit({
          type: "gateway.search.quota.response",
          payload: { requestId: msg.requestId, keys: [] },
        });
        return undefined;
      }
      return searchQuotas(api, {
        fresh: msg.fresh === true,
        logger: this.sessionLogger,
      }).then((keys) => {
        this.emit({
          type: "gateway.search.quota.response",
          payload: {
            requestId: msg.requestId,
            keys: keys.map((entry) => GatewaySearchKeyQuotaWireSchema.parse(entry)),
          },
        });
        return undefined;
      });
    }
    if (msg.type === "gateway.quota.get.request") {
      const now = Date.now();
      const days = msg.historyDays ?? 2;
      const filter = {
        ...(msg.provider === undefined ? {} : { provider: msg.provider }),
        ...(msg.account === undefined ? {} : { account: msg.account }),
      };
      if (msg.read === true) {
        return service.usagePoller
          .refreshAll(now)
          .then(() => this.emitQuotaSnapshot(service, msg.requestId, days, now, filter));
      }
      return this.emitQuotaSnapshot(service, msg.requestId, days, now, filter);
    }
    if (msg.type === "gateway.quota.reset.request") {
      if (msg.confirm !== true) {
        this.emit({
          type: "gateway.quota.reset.response",
          payload: {
            requestId: msg.requestId,
            spent: false,
            code: "confirmation_required",
            windows: 0,
            error: "A reset cannot be undone; pass confirm to spend one.",
          },
        });
        return undefined;
      }
      return spendCodexReset({
        config: service.configStore.get(),
        accountsFile: join(this.neolixHome, "gateway", "codex-accounts.json"),
        ...(msg.account === undefined ? {} : { account: msg.account }),
        ...(msg.card === undefined ? {} : { card: msg.card }),
        logger: this.sessionLogger,
      }).then((result) => {
        this.emit({
          type: "gateway.quota.reset.response",
          payload: { requestId: msg.requestId, ...result },
        });
        return undefined;
      });
    }
    return service.warmup.warmNow(msg.provider, msg.account).then((result) => {
      this.emit({
        type: "gateway.quota.warm.response",
        payload: {
          requestId: msg.requestId,
          status: result === null ? null : result.status,
          ...(result === null ? { error: "Account not found" } : {}),
        },
      });
      return undefined;
    });
  }

  /** What masking swapped, for the settings page. */
  private handleGatewayMaskingRpc(
    msg: Extract<
      SessionInboundMessage,
      {
        type:
          | "gateway.masking.summary.request"
          | "gateway.masking.records.request"
          | "gateway.masking.record.request"
          | "gateway.masking.preview.request"
          | "gateway.masking.clear.request"
          | "gateway.masking.local_model.status.request"
          | "gateway.masking.local_model.download.request"
          | "gateway.masking.local_model.cancel.request"
          | "gateway.masking.local_model.remove.request";
      }
    >,
    service: LlmGatewayService,
  ): Promise<void> | undefined {
    if (msg.type.startsWith("gateway.masking.local_model.")) {
      const model = service.maskingLocalModel;
      const emit = async (
        type:
          | "gateway.masking.local_model.status.response"
          | "gateway.masking.local_model.download.response"
          | "gateway.masking.local_model.cancel.response"
          | "gateway.masking.local_model.remove.response",
      ): Promise<void> => {
        this.emit({
          type,
          payload: {
            requestId: msg.requestId,
            status: GatewayMaskingLocalModelStatusWireSchema.parse(await model.status()),
          },
        });
      };
      if (msg.type === "gateway.masking.local_model.status.request") {
        return emit("gateway.masking.local_model.status.response");
      }
      if (msg.type === "gateway.masking.local_model.download.request") {
        model.startDownload();
        return emit("gateway.masking.local_model.download.response");
      }
      if (msg.type === "gateway.masking.local_model.cancel.request") {
        model.cancelDownload();
        return emit("gateway.masking.local_model.cancel.response");
      }
      return model.remove().then(() => emit("gateway.masking.local_model.remove.response"));
    }
    if (msg.type === "gateway.masking.summary.request") {
      this.emit({
        type: "gateway.masking.summary.response",
        payload: {
          requestId: msg.requestId,
          summary: GatewayMaskingSummaryWireSchema.parse(service.maskingRecords.summary(msg.days)),
        },
      });
      return undefined;
    }
    if (msg.type === "gateway.masking.records.request") {
      const page = service.maskingRecords.list({
        ...(msg.gatewayCallId === undefined ? {} : { gatewayCallId: msg.gatewayCallId }),
        ...(msg.before === undefined ? {} : { before: msg.before }),
        ...(msg.limit === undefined ? {} : { limit: msg.limit }),
        ...(msg.kind === undefined ? {} : { kinds: msg.kind }),
        ...(msg.by === undefined ? {} : { by: msg.by }),
        ...(msg.agent === undefined ? {} : { agent: msg.agent }),
        ...(msg.provider === undefined ? {} : { provider: msg.provider }),
        ...(msg.blocked === undefined ? {} : { blocked: msg.blocked }),
      });
      this.emit({
        type: "gateway.masking.records.response",
        payload: {
          requestId: msg.requestId,
          ...GatewayMaskingRecordsWireSchema.parse(page),
        },
      });
      return undefined;
    }
    if (msg.type === "gateway.masking.record.request") {
      this.emit({
        type: "gateway.masking.record.response",
        payload: {
          requestId: msg.requestId,
          record: GatewayMaskingRecordWireSchema.nullable().parse(
            service.maskingRecords.get(msg.key),
          ),
        },
      });
      return undefined;
    }
    if (msg.type === "gateway.masking.preview.request") {
      return service.masker.ensureKey().then(async () => {
        try {
          await service.masker.prime(msg.text);
        } catch {
          // The preview is local and sent nowhere; the model's own status
          // row says why it found nothing.
        }
        const preview = service.masker.preview(msg.text);
        this.emit({
          type: "gateway.masking.preview.response",
          payload: {
            requestId: msg.requestId,
            preview: GatewayMaskingPreviewWireSchema.parse({
              text: preview.text,
              hits: maskHitsToWire(preview.hits),
              blocked: preview.blocked,
              off: !maskingWanted(service.configStore.get().masking),
            }),
          },
        });
        return undefined;
      });
    }
    return service.maskingRecords.clear().then(() => {
      this.emit({
        type: "gateway.masking.clear.response",
        payload: { requestId: msg.requestId, cleared: true },
      });
      return undefined;
    });
  }

  /** Daily check-ins: the accounts' state, a press, and the switches. */
  private handleGatewayCheckinRpc(
    msg: Extract<SessionInboundMessage, { type: `gateway.checkin.${string}.request` }>,
    service: LlmGatewayService,
  ): Promise<void> | undefined {
    const checkin = service.checkin;
    const switches = (): Record<string, boolean> => {
      const config = service.configStore.get().checkin;
      const out: Record<string, boolean> = {};
      const vendors = ["workbuddy", "minimax", "trae", "qoder"] as const;
      for (const vendor of vendors) {
        out[vendor] = config?.[vendor] === true;
      }
      for (const [id, on] of Object.entries(config?.plugins ?? {})) {
        out[id] = on === true;
      }
      return out;
    };
    const accounts = async () => {
      if (checkin === undefined) {
        return [];
      }
      try {
        return (await checkin.listAccounts()).map((account) =>
          GatewayCheckinAccountWireSchema.parse(account),
        );
      } catch (error) {
        // A read that failed answers with no accounts rather than hanging the
        // client; the log says why.
        this.sessionLogger.warn({ err: error }, "Cannot list the check-in accounts");
        return [];
      }
    };

    if (msg.type === "gateway.checkin.status.request") {
      return accounts().then((list) => {
        this.emit({
          type: "gateway.checkin.status.response",
          payload: { requestId: msg.requestId, accounts: list, switches: switches() },
        });
        return undefined;
      });
    }
    if (msg.type === "gateway.checkin.switch.request") {
      if (checkin === undefined) {
        this.emit({
          type: "gateway.checkin.switch.response",
          payload: { requestId: msg.requestId, switches: switches() },
        });
        return undefined;
      }
      return checkin.setSwitch(msg.by, msg.on).then(() => {
        this.emit({
          type: "gateway.checkin.switch.response",
          payload: { requestId: msg.requestId, switches: switches() },
        });
        return undefined;
      });
    }
    if (msg.type === "gateway.checkin.account.request") {
      if (checkin !== undefined) {
        return checkin.setAccountOn(msg.key, msg.on).then(async () => {
          const list = await accounts();
          this.emit({
            type: "gateway.checkin.account.response",
            payload: { requestId: msg.requestId, accounts: list },
          });
          return undefined;
        });
      }
      return accounts().then((list) => {
        this.emit({
          type: "gateway.checkin.account.response",
          payload: { requestId: msg.requestId, accounts: list },
        });
        return undefined;
      });
    }
    const run =
      checkin === undefined
        ? Promise.resolve([])
        : checkin.run({
            ...(msg.by === undefined ? {} : { by: msg.by }),
            ...(msg.key === undefined ? {} : { key: msg.key }),
          });
    return run.then(async (entries) => {
      this.emit({
        type: "gateway.checkin.run.response",
        payload: {
          requestId: msg.requestId,
          entries: entries.map((entry) => GatewayCheckinEntryWireSchema.parse(entry)),
          accounts: await accounts(),
          switches: switches(),
        },
      });
      return undefined;
    });
  }

  private handleGatewayPluginSubscriptionRpc(
    msg: Extract<SessionInboundMessage, { type: `gateway.plugin.subscription.${string}.request` }>,
  ): Promise<void> | undefined {
    const plugins = this.pluginRuntime;
    if (plugins === undefined) throw new Error("Plugin service is unavailable");
    if (msg.type === "gateway.plugin.subscription.list.request") {
      if (plugins.listSubscriptionProviders === undefined) {
        throw new Error("Plugin subscriptions are unavailable");
      }
      const providers: Array<{
        pluginId: string;
        id: string;
        label: string;
        protocol: string;
        methods: Array<{ type: "oauth" | "api"; label: string }>;
        options?: Record<string, unknown>;
      }> = [];
      for (const provider of plugins.listSubscriptionProviders()) {
        const row = {
          pluginId: provider.pluginId,
          id: provider.id,
          label: provider.label,
          protocol: provider.protocol,
          methods: provider.methods,
        };
        providers.push(
          provider.options === undefined ? row : Object.assign(row, { options: provider.options }),
        );
      }
      this.emit({
        type: "gateway.plugin.subscription.list.response",
        payload: { requestId: msg.requestId, providers },
      });
      return undefined;
    }
    if (msg.type === "gateway.plugin.subscription.models.request") {
      if (plugins.subscriptionModels === undefined) {
        throw new Error("Plugin subscriptions are unavailable");
      }
      return plugins
        .subscriptionModels(msg.pluginId, msg.providerId, msg.accountId)
        .then((models) => {
          const wireModels: Array<Record<string, unknown> & { id: string }> = [];
          for (const model of models) {
            wireModels.push(Object.assign({}, model) as Record<string, unknown> & { id: string });
          }
          this.emit({
            type: "gateway.plugin.subscription.models.response",
            payload: { requestId: msg.requestId, models: wireModels },
          });
          return undefined;
        });
    }
    if (plugins.subscriptionSignIn === undefined) {
      throw new Error("Plugin subscriptions are unavailable");
    }
    if (msg.type === "gateway.plugin.subscription.sign_in.poll.request") {
      if (plugins.subscriptionSignInPoll === undefined) {
        throw new Error("Plugin subscriptions are unavailable");
      }
      return plugins
        .subscriptionSignInPoll(msg.pluginId, msg.providerId, msg.token)
        .then((poll) => {
          this.emit({
            type: "gateway.plugin.subscription.sign_in.poll.response",
            payload: {
              requestId: msg.requestId,
              status: poll.status,
              ...(poll.status === "signed_in" ? { auth: poll.auth } : {}),
            },
          });
          return undefined;
        });
    }
    return plugins
      .subscriptionSignIn(msg.pluginId, msg.providerId, msg.method, msg.accountId, msg.inputs)
      .then((outcome) => {
        this.emit({
          type: "gateway.plugin.subscription.sign_in.response",
          payload: {
            requestId: msg.requestId,
            status: outcome.status === "pending" ? "pending" : "signed_in",
            ...(typeof outcome.auth === "object" && outcome.auth !== null
              ? { auth: outcome.auth as Record<string, unknown> }
              : {}),
            ...(typeof outcome.url === "string" ? { url: outcome.url } : {}),
            ...(typeof outcome.instructions === "string"
              ? { instructions: outcome.instructions }
              : {}),
            ...(typeof outcome.token === "string" ? { token: outcome.token } : {}),
          },
        });
        return undefined;
      });
  }

  private handleGatewayPluginAgentRpc(
    msg: Extract<SessionInboundMessage, { type: `gateway.plugin.agent.${string}.request` }>,
  ): Promise<void> | undefined {
    const plugins = this.pluginRuntime;
    if (plugins === undefined) throw new Error("Plugin service is unavailable");
    if (plugins.listAgentIntegrations === undefined || plugins.wireAgentIntegration === undefined) {
      throw new Error("Plugin agent integrations are unavailable");
    }
    const integrations = plugins.listAgentIntegrations();
    if (msg.type === "gateway.plugin.agent.list.request") {
      this.emit({
        type: "gateway.plugin.agent.list.response",
        payload: {
          requestId: msg.requestId,
          integrations: integrations.map((entry) => ({
            pluginId: entry.pluginId,
            id: entry.id,
            label: entry.label,
            config: entry.config,
            ...(entry.format === undefined ? {} : { format: entry.format }),
            ...(entry.model === undefined ? {} : { model: entry.model }),
          })),
        },
      });
      return undefined;
    }
    const integration = integrations.find(
      (entry) => entry.pluginId === msg.pluginId && entry.id === msg.integrationId,
    );
    if (integration === undefined) {
      throw new Error(`Unknown agent integration: ${msg.pluginId}/${msg.integrationId}`);
    }
    return plugins
      .wireAgentIntegration(msg.pluginId, msg.integrationId, {
        gateway: msg.gateway,
        model: msg.model,
        models: msg.models ?? [msg.model],
      })
      .then(async (settings) => {
        if (settings === null) throw new Error("The agent integration did not answer");
        const written = await writeAgentWiring({
          config: integration.config,
          ...(integration.format === undefined ? {} : { format: integration.format }),
          ...(integration.model === undefined ? {} : { modelPath: integration.model }),
          settings,
          model: msg.model,
        });
        this.emit({
          type: "gateway.plugin.agent.wire.response",
          payload: { requestId: msg.requestId, path: written.path, keys: written.keys },
        });
        return undefined;
      });
  }

  private handleHostRpc(msg: SessionInboundMessage): Promise<void> | undefined {
    if (isHeldReportRequest(msg)) {
      return this.handleHeldReportRequest(msg);
    }
    if (isOidcRuleRequest(msg)) {
      return this.handleOidcRuleRequest(msg);
    }
    if (isGatewayRpcRequest(msg)) {
      return this.handleGatewayRpc(msg);
    }
    if (isAgentConnectRpcRequest(msg)) {
      return this.handleAgentConnectRpc(msg);
    }
    if (isAgentInstallRpcRequest(msg)) {
      return this.handleAgentInstallRpc(msg);
    }
    return undefined;
  }

  private async handleAgentInstallRpc(msg: AgentInstallRpcRequest): Promise<void> {
    if (msg.type === "agent.install.list.request") {
      this.emit({
        type: "agent.install.list.response",
        payload: { requestId: msg.requestId, entries: this.agentInstall.list() },
      });
      return;
    }
    if (msg.type === "agent.install.uninstall.request") {
      const result = await this.agentInstall.uninstall({
        provider: msg.provider,
        ...(msg.commandId === undefined ? {} : { commandId: msg.commandId }),
        ...(msg.timeoutMs === undefined ? {} : { timeoutMs: msg.timeoutMs }),
      });
      this.emit({
        type: "agent.install.uninstall.response",
        payload: { ...result, requestId: msg.requestId },
      });
      return;
    }
    const result = await this.agentInstall.run({
      provider: msg.provider,
      commandId: msg.commandId,
      ...(msg.timeoutMs === undefined ? {} : { timeoutMs: msg.timeoutMs }),
    });
    this.emit({
      type: "agent.install.run.response",
      payload: { ...result, requestId: msg.requestId },
    });
  }

  private async handleAgentConnectRpc(msg: AgentConnectRpcRequest): Promise<void> {
    switch (msg.type) {
      case "agent.connect.get.request": {
        this.emitAgentConnect(
          "agent.connect.get.response",
          msg.requestId,
          await this.agentConnect.snapshot(),
        );
        return;
      }
      case "agent.connect.profile.list.request": {
        this.emitAgentConnect(
          "agent.connect.profile.list.response",
          msg.requestId,
          await this.agentConnect.snapshot(),
        );
        return;
      }
      case "agent.connect.set.request": {
        const snapshot = await this.agentConnect.set({
          provider: msg.provider,
          connected: msg.connected,
          ...(msg.model === undefined ? {} : { model: msg.model }),
          ...(msg.field === undefined ? {} : { field: msg.field }),
          ...(msg.value === undefined ? {} : { value: msg.value }),
        });
        this.emitAgentConnect("agent.connect.set.response", msg.requestId, snapshot);
        return;
      }
      case "agent.connect.models.request": {
        this.emitAgentConnect(
          "agent.connect.models.response",
          msg.requestId,
          await this.agentConnect.setModels({ provider: msg.provider, hidden: msg.hidden }),
        );
        return;
      }
      case "agent.connect.stale.restart.request": {
        this.emitAgentConnect(
          "agent.connect.stale.restart.response",
          msg.requestId,
          await this.agentConnect.restartStale({ provider: msg.provider, kind: msg.kind }),
        );
        return;
      }
      case "agent.connect.profile.save.request": {
        this.emitAgentConnect(
          "agent.connect.profile.save.response",
          msg.requestId,
          await this.agentConnect.saveProfile(msg.name),
        );
        return;
      }
      case "agent.connect.profile.apply.request": {
        this.emitAgentConnect(
          "agent.connect.profile.apply.response",
          msg.requestId,
          await this.agentConnect.applyProfile(msg.name),
        );
        return;
      }
      case "agent.connect.profile.rename.request": {
        this.emitAgentConnect(
          "agent.connect.profile.rename.response",
          msg.requestId,
          await this.agentConnect.renameProfile(msg.name, msg.to),
        );
        return;
      }
      case "agent.connect.profile.delete.request": {
        this.emitAgentConnect(
          "agent.connect.profile.delete.response",
          msg.requestId,
          await this.agentConnect.deleteProfile(msg.name),
        );
        return;
      }
      case "agent.connect.layout.set.request": {
        this.emitAgentConnect(
          "agent.connect.layout.set.response",
          msg.requestId,
          await this.agentConnect.setLayout({ order: msg.order, hidden: msg.hidden }),
        );
        return;
      }
      case "agent.connect.shell.request": {
        this.emitAgentConnect(
          "agent.connect.shell.response",
          msg.requestId,
          await this.agentConnect.setShellFunction({
            provider: msg.provider,
            enabled: msg.enabled,
          }),
        );
        return;
      }
    }
  }

  private emitAgentConnect(
    type:
      | "agent.connect.get.response"
      | "agent.connect.set.response"
      | "agent.connect.profile.list.response"
      | "agent.connect.profile.save.response"
      | "agent.connect.profile.apply.response"
      | "agent.connect.profile.rename.response"
      | "agent.connect.profile.delete.response"
      | "agent.connect.layout.set.response"
      | "agent.connect.shell.response"
      | "agent.connect.models.response"
      | "agent.connect.stale.restart.response",
    requestId: string,
    snapshot: Awaited<ReturnType<AgentConnectService["snapshot"]>>,
  ): void {
    this.emit({ type, payload: { requestId, snapshot } } as SessionOutboundMessage);
  }

  private agentConnectBaseUrl(): string | null {
    const port = this.getDaemonTcpPort?.() ?? null;
    if (port === null) {
      return null;
    }
    const reported = this.getDaemonTcpHost?.()?.trim() ?? "";
    const wildcard =
      reported === "" || reported === "0.0.0.0" || reported === "::" || reported === "::0";
    const host = wildcard ? "127.0.0.1" : reported;
    return `http://${host.includes(":") ? `[${host}]` : host}:${port}`;
  }

  private emitGatewayConfig(
    service: LlmGatewayService,
    type: "gateway.config.get.response" | "gateway.config.set.response",
    requestId: string,
    config: ReturnType<GatewayConfigStore["get"]>,
  ): void {
    // The page lists and edits the groups the gateway finds too, so the wire
    // carries them; a write drops them again (config.ts). Each provider also
    // carries the daemon's own search verdict, so the page need not guess it
    // from the protocol: hostOf decides, and an explicit switch wins.
    const effective = {
      ...config,
      groups: groupsOf(config),
      providers: config.providers.map((provider) => ({
        ...provider,
        searchesUpstream: providerSearchesByItself(provider),
      })),
    };
    this.emit({
      type,
      payload: {
        requestId,
        config: effective,
        status: this.gatewayStatus(service, effective),
        searchVendors: this.pluginRuntime?.listSearchApis(),
      },
    });
  }

  private gatewayStatus(
    service: LlmGatewayService,
    config: ReturnType<GatewayConfigStore["get"]> = service.configStore.get(),
  ) {
    return GatewayStatusWireSchema.parse(
      snapshotGatewayStatus({
        config,
        runtime: service.runtime,
        ledger: service.ledger,
        now: Date.now(),
      }),
    );
  }

  /** The gateway config writes: the whole config, and the warm-up times. */
  private handleGatewayConfigRpc(
    msg: Extract<SessionInboundMessage, { type: `gateway.${string}.request` }>,
    service: LlmGatewayService,
  ): Promise<void> | undefined {
    if (msg.type === "gateway.config.set.request") {
      return service.configStore.write(msg.config).then((config) => {
        this.emitGatewayConfig(service, "gateway.config.set.response", msg.requestId, config);
        // The catalog the agents' lists carry follows the gateway's
        // (myna's SyncCatalog, which dsh's sync runs).
        void this.agentConnect.refreshModels().catch(() => undefined);
        return undefined;
      });
    }
    if (msg.type === "gateway.warmup.warm-at.request") {
      return this.handleGatewayWarmAts(msg, service);
    }
    if (msg.type === "gateway.warmup.account-warm-at.request") {
      return this.handleGatewayAccountWarmAt(msg, service);
    }
    return undefined;
  }

  /**
   * The times of day an agent's 5-hour windows are started at, myna's
   * CodexWarmAts / ClaudeWarmAts. The times come back canonical, earliest
   * first, as saved.
   */
  private async handleGatewayWarmAts(
    msg: Extract<SessionInboundMessage, { type: "gateway.warmup.warm-at.request" }>,
    service: LlmGatewayService,
  ): Promise<void> {
    const bad = msg.ats.find((at) => clockOf(at) === null);
    if (bad !== undefined) {
      this.emitWarmAts(msg.requestId, undefined, `${bad} is not a time of day, as 06:00 is`);
      return;
    }
    try {
      const config = withWarmAts(service.configStore.get(), msg.agent, normalizeWarmAts(msg.ats));
      const saved = await service.configStore.write(config);
      this.emitWarmAts(
        msg.requestId,
        msg.agent === "codex" ? saved.codexWarmAts : saved.claudeWarmAts,
      );
    } catch (error) {
      this.emitWarmAts(
        msg.requestId,
        undefined,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private emitWarmAts(requestId: string, ats: string[] | undefined, error?: string): void {
    this.emit({
      type: "gateway.warmup.warm-at.response",
      payload: {
        requestId,
        ...(ats === undefined ? {} : { ats }),
        ...(error === undefined ? {} : { error }),
      },
    });
  }

  /**
   * One account's own time of day, myna's /api/settings/codex-warm-at:
   * "06:00", "off" for none, "" to follow its agent's list.
   */
  private async handleGatewayAccountWarmAt(
    msg: Extract<SessionInboundMessage, { type: "gateway.warmup.account-warm-at.request" }>,
    service: LlmGatewayService,
  ): Promise<void> {
    const trimmed = msg.at.trim();
    const at = normalizeWarmAt(trimmed);
    if (trimmed !== "" && trimmed.toLowerCase() !== "off" && clockOf(trimmed) === null) {
      this.emitAccountWarmAt(
        msg.requestId,
        undefined,
        `${msg.at} is not a time of day, as 06:00 is`,
      );
      return;
    }
    const next = withAccountWarmAt(service.configStore.get(), msg.provider, msg.account, at);
    if (next === null) {
      this.emitAccountWarmAt(msg.requestId, undefined, `No ${msg.provider} account ${msg.account}`);
      return;
    }
    try {
      await service.configStore.write(next);
      this.emitAccountWarmAt(msg.requestId, at);
    } catch (error) {
      this.emitAccountWarmAt(
        msg.requestId,
        undefined,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private emitAccountWarmAt(requestId: string, at: string | undefined, error?: string): void {
    this.emit({
      type: "gateway.warmup.account-warm-at.response",
      payload: {
        requestId,
        ...(at === undefined ? {} : { at }),
        ...(error === undefined ? {} : { error }),
      },
    });
  }

  private handleGatewayUsageGet(
    msg: Extract<SessionInboundMessage, { type: "gateway.usage.get.request" }>,
    service: LlmGatewayService,
  ): Promise<void> {
    const period = msg.period ?? "30d";
    const zone = msg.timezoneOffsetMinutes ?? 0;
    const now = Date.now();
    const config = service.configStore.get();
    const catalog = service.runtime.pricing ?? null;
    const keyLabels = new Map<string, string>();
    for (const entry of gatewayKeyEntries(config)) {
      if (entry.label !== undefined && entry.label.length > 0) {
        keyLabels.set(entry.key, entry.label);
      }
    }
    const window = windowOf({
      period,
      now,
      timezoneOffsetMinutes: zone,
      ...(msg.from === undefined ? {} : { from: msg.from }),
      ...(msg.to === undefined ? {} : { to: msg.to }),
      ...(msg.since === undefined ? {} : { since: msg.since }),
      ...(msg.until === undefined ? {} : { until: msg.until }),
    });
    return readUsageRecords(service.ledger.filePath, window.since)
      .then((records) => {
        // One price per model and hour: the peak window is the finest a price
        // varies, so a month of calls resolves each rate once, not per call.
        const prices = new Map<string, ReturnType<typeof usagePrice>>();
        const priceForRecord = (record: UsageRecord) => {
          const hour = Math.floor(Date.parse(record.time) / 3_600_000);
          const key = `${record.provider}\u0000${record.model}\u0000${hour}`;
          const known = prices.get(key);
          if (known !== undefined || prices.has(key)) {
            return known ?? null;
          }
          const price = usagePrice({
            config,
            providerId: record.provider,
            modelId: record.model,
            catalog,
            at: Date.parse(record.time),
          });
          prices.set(key, price);
          return price;
        };
        const report = buildUsageReport(
          records,
          {
            period,
            now,
            timezoneOffsetMinutes: zone,
            offset: msg.offset ?? 0,
            limit: msg.limit ?? DEFAULT_PAGE_LIMIT,
            ...(msg.client === undefined ? {} : { client: msg.client }),
            ...(msg.model === undefined ? {} : { model: msg.model }),
            ...(msg.provider === undefined ? {} : { provider: msg.provider }),
            ...(msg.account === undefined ? {} : { account: msg.account }),
            ...(msg.key === undefined ? {} : { key: msg.key }),
            ...(msg.failed === true ? { failedOnly: true } : {}),
            ...(msg.retried === true ? { retriedOnly: true } : {}),
            ...(msg.query === undefined ? {} : { query: msg.query }),
            ...(msg.from === undefined ? {} : { from: msg.from }),
            ...(msg.to === undefined ? {} : { to: msg.to }),
            ...(msg.since === undefined ? {} : { since: msg.since }),
            ...(msg.until === undefined ? {} : { until: msg.until }),
          },
          {
            filePath: service.ledger.filePath,
            ...(keyLabels.size === 0 ? {} : { keyLabels }),
            // myna re-prices a period's calls at today's effective price, so a
            // tariff changed since then shows on the report and its export.
            priceOf: (record) => {
              const price = priceForRecord(record);
              if (price === null) {
                return null;
              }
              return {
                costUsd: costUsd(
                  price,
                  {
                    inputTokens: record.inputTokens,
                    outputTokens: record.outputTokens,
                    cacheReadTokens: record.cacheReadTokens,
                    cacheWriteTokens: record.cacheWriteTokens,
                    cacheWrite1hTokens: record.cacheWrite1hTokens,
                  },
                  { cacheInPrompt: (record.upstreamProtocol ?? record.protocol) !== "anthropic" },
                ),
                priced: true,
              };
            },
            // myna's UsageAliases: two ids of one model are one row.
            modelName: (model) => usageModelId(config, model),
          },
        );
        this.emit({
          type: "gateway.usage.get.response",
          payload: { requestId: msg.requestId, report },
        });
        return undefined;
      })
      .catch((cause: unknown) => {
        this.sessionLogger.warn({ err: cause }, "Cannot read the gateway usage ledger");
        this.emit({
          type: "gateway.usage.get.response",
          payload: {
            requestId: msg.requestId,
            report: null,
            error: cause instanceof Error ? cause.message : String(cause),
          },
        });
      });
  }

  private requireLlmGateway(): LlmGatewayService {
    if (this.llmGateway === undefined) {
      throw new Error("LLM gateway is unavailable");
    }
    return this.llmGateway;
  }

  private subscribeToPluginChanges(
    pluginRuntime: SessionOptions["pluginRuntime"],
  ): (() => void) | null {
    if (!pluginRuntime) return null;
    const catalog = pluginRuntime.subscribe((pluginId) => {
      this.emit({ type: "status", payload: { status: "plugin_catalog_changed", pluginId } });
    });
    const settings = pluginRuntime.subscribeSettings?.((pluginId, settingsId) => {
      this.emit({
        type: "status",
        payload: { status: "plugin_settings_changed", pluginId, settingsId },
      });
    });
    return () => {
      catalog();
      settings?.();
    };
  }

  private dispatchVoiceAndControlMessage(msg: SessionInboundMessage): Promise<void> | undefined {
    switch (msg.type) {
      case "voice_audio_chunk":
      case "abort_request":
      case "audio_played":
      case "set_voice_mode":
      case "dictation_stream_start":
      case "dictation_stream_chunk":
      case "dictation_stream_finish":
      case "dictation_stream_cancel":
        return this.voiceSessions.handleMessage(msg);
      case "restart_server_request":
        return this.handleRestartServerRequest(msg.requestId, msg.reason, {
          keepTerminals: msg.killTerminals !== true,
        });
      case "shutdown_server_request":
        // The daemon is going: its keeper's timer goes with it.
        this.agentConnect.stopScienceKeeper();
        return this.handleShutdownServerRequest(msg.requestId, {
          keepTerminals: msg.keepTerminals === true,
        });
      case "client_heartbeat":
        this.handleClientHeartbeat(msg);
        return undefined;
      case "ping": {
        const now = Date.now();
        this.emit({
          type: "pong",
          payload: {
            requestId: msg.requestId,
            clientSentAt: msg.clientSentAt,
            serverReceivedAt: now,
            serverSentAt: now,
          },
        });
        return undefined;
      }
      default:
        return undefined;
    }
  }

  private dispatchAgentRewindMessage(
    msg: SessionInboundMessage,
    source?: object,
  ): Promise<void> | undefined {
    switch (msg.type) {
      case "agent.rewind.request":
        return this.handleAgentRewindRequest(msg, source);
      default:
        return undefined;
    }
  }

  private dispatchAgentRelationshipMessage(msg: SessionInboundMessage): Promise<void> | undefined {
    switch (msg.type) {
      case "agent.detach.request":
        return this.handleDetachAgentRequest(msg.agentId, msg.requestId);
      default:
        return undefined;
    }
  }

  private dispatchAgentTimelineMessage(
    msg: SessionInboundMessage,
    source?: object,
  ): Promise<void> | undefined {
    switch (msg.type) {
      case "fetch_agent_timeline_request":
        return this.handleFetchAgentTimelineRequest(msg, source);
      case "agent.timeline.append.request":
        return this.handleAgentTimelineAppendRequest(msg);
      case "agent.timeline.search.request":
        return this.handleAgentTimelineSearchRequest(msg, source);
      case "agent.timeline.list_prompts.request":
        return this.handleAgentTimelineListPromptsRequest(msg, source);
      case "agent.provider_subagents.list.request":
        return this.handleProviderSubagentListRequest(msg);
      case "agent.provider_subagents.timeline.get.request":
        return this.handleProviderSubagentTimelineRequest(msg, source);
      case "session.events.set_subscription.request": {
        const owner = this.delivery.begin("events", undefined, async (id) => {
          this.eventSubscriptions.delete(id);
          this.refreshObservationProducers();
          if (msg.events.includes("checkout_status_update"))
            await this.reconcileWorkspaceGitObservers();
        });
        this.eventSubscriptions.set(owner.id, {
          owner,
          events: new Set(msg.events),
          notifications: msg.notifications === true,
        });
        this.emitForSource(
          {
            type: "session.events.set_subscription.response",
            payload: { requestId: msg.requestId, subscriptionId: owner.responseId },
          },
          source,
        );
        this.refreshObservationProducers();
        if (!msg.events.includes("checkout_status_update")) return undefined;
        return this.reconcileWorkspaceGitObservers().catch(async (error) => {
          await owner.release();
          throw error;
        });
      }
      case "agent.timeline.set_subscription.request": {
        const agentIds = [...new Set(msg.agentIds)].sort();
        const owner = this.subscribeAgentTimelines(agentIds);
        this.emitForSource(
          {
            type: "agent.timeline.set_subscription.response",
            payload: { agentIds, requestId: msg.requestId, subscriptionId: owner.responseId },
          },
          source,
        );
        return undefined;
      }
      case "agent.fork_context.request":
        return this.handleAgentForkContextRequest(msg);
      default:
        return undefined;
    }
  }

  private dispatchHubExecutionMessage(msg: SessionInboundMessage): Promise<void> | undefined {
    if (msg.type === "hub.execution.agent.create.request") {
      return this.hubExecutionController?.createAgent(msg);
    }
    if (msg.type === "hub.execution.agent.validate.request") {
      return this.hubExecutionController?.validateAgent(msg);
    }
    if (msg.type === "hub.execution.control.request") {
      return this.hubExecutionController?.controlExecution(msg);
    }
    return undefined;
  }

  private dispatchCreationMessage(
    msg: SessionInboundMessage,
    source?: object,
  ): Promise<void> | undefined {
    switch (msg.type) {
      case "agent.create.request":
        return this.handleAgentCreation(msg, source);
      case "creation.subscribe.request":
        return this.handleCreationSubscription(msg, source);
      case "workspace.create.request":
        return this.handleWorkspaceCreation(msg, source);
      default:
        return undefined;
    }
  }

  private dispatchAgentLifecycleMessage(msg: SessionInboundMessage): Promise<void> | undefined {
    switch (msg.type) {
      case "fetch_agents_request":
        return this.handleFetchAgents(msg);
      case "fetch_agent_history_request":
        return this.handleFetchAgentHistory(msg);
      case "fetch_recent_provider_sessions_request":
        return this.handleFetchRecentProviderSessions(msg);
      case "fetch_agent_request":
        return this.handleFetchAgent(msg.agentId, msg.requestId);
      case "delete_agent_request":
        return this.handleDeleteAgentRequest(msg.agentId, msg.requestId);
      case "archive_agent_request":
        return this.handleArchiveAgentRequest(msg.agentId, msg.requestId);
      case "close_items_request":
        return this.handleCloseItemsRequest(msg);
      case "update_agent_request":
        return this.handleUpdateAgentRequest(msg.agentId, msg.name, msg.labels, msg.requestId);
      case "project.rename.request":
        return this.handleProjectRenameRequest(msg.projectId, msg.customName, msg.requestId);
      case "project.icon.set.request":
        return this.handleProjectIconSetRequest(msg);
      case "send_agent_message_request":
        return this.handleSendAgentMessageRequest(msg);
      case "wait_for_finish_request":
        return this.handleWaitForFinish(msg.agentId, msg.requestId, msg.timeoutMs);
      case "create_agent_request":
        return this.handleCreateAgentRequest(msg);
      case "resume_agent_request":
        return this.handleResumeAgentRequest(msg);
      case "import_agent_request":
        return this.handleImportAgentRequest(msg);
      case "refresh_agent_request":
        return this.handleRefreshAgentRequest(msg);
      case "cancel_agent_request":
        return this.handleCancelAgentRequest(msg.agentId, msg.requestId);
      case "agent_permission_response":
        return this.handleAgentPermissionResponse(msg.agentId, msg.requestId, msg.response);
      case "clear_agent_attention":
        return this.handleClearAgentAttention(msg.agentId, msg.requestId);
      default:
        return undefined;
    }
  }

  private dispatchAgentConfigMessage(msg: SessionInboundMessage): Promise<void> | undefined {
    const hostRpc = this.handleHostRpc(msg);
    if (hostRpc !== undefined) {
      return hostRpc;
    }
    if (isDaemonMessage(msg)) {
      return this.dispatchDaemonMessage(msg);
    }
    switch (msg.type) {
      case "set_agent_mode_request":
        return this.agentConfigSession.handleSetAgentModeRequest(msg);
      case "set_agent_model_request":
        return this.agentConfigSession.handleSetAgentModelRequest(msg);
      case "set_agent_feature_request":
        return this.agentConfigSession.handleSetAgentFeatureRequest(msg);
      case "set_agent_thinking_request":
        return this.agentConfigSession.handleSetAgentThinkingRequest(msg);
      case "agent.config.apply.request":
        return this.agentConfigSession.handleAgentConfigApplyRequest(msg);
      case "read_project_config_request":
        return this.projectConfigSession.handleReadProjectConfigRequest(msg);
      case "write_project_config_request":
        return this.projectConfigSession.handleWriteProjectConfigRequest(msg);
      default:
        return undefined;
    }
  }

  /** The daemon's own configuration and lifecycle messages. */
  private dispatchDaemonMessage(msg: DaemonMessage): Promise<void> | undefined {
    switch (msg.type) {
      case "get_daemon_config_request":
        this.emit({
          type: "get_daemon_config_response",
          payload: { requestId: msg.requestId, config: this.daemonConfigStore.get() },
        });
        return undefined;
      case "daemon.get_status.request":
        return this.daemonSession.handleGetStatusRequest(msg);
      case "daemon.get_pairing_offer.request":
        return this.daemonSession.handleGetPairingOfferRequest(msg);
      case "daemon.config.reload.request":
        return this.daemonSession.handleConfigReloadRequest(msg);
      case "daemon.path.reveal.request":
        return this.daemonSession.handlePathRevealRequest(msg);
      case "daemon.web_page.get.request":
        this.emit({
          type: "daemon.web_page.get.response",
          payload: { requestId: msg.requestId, page: webPageWire(currentWebPageState()) },
        });
        return undefined;
      case "daemon.web_page.set.request":
        return this.updateWebPage(msg);
      case "hub.management.daemon.connect.request":
      case "hub.management.daemon.get_status.request":
      case "hub.management.daemon.disconnect.request":
      case "hub.management.daemon.permissions.update.request":
        return this.daemonSession.handleHubRelationshipRequest(msg);
      case "diagnostics.request":
        return this.daemonSession.handleDiagnosticsRequest(msg);
      case "daemon.diagnostics.heap.request":
        return this.daemonSession.handleHeapSnapshotRequest(msg);
      case "daemon.diagnostics.cpu.request":
        return this.daemonSession.handleCpuProfileRequest(msg);
      case "daemon.diagnostics.handles.request":
        return this.daemonSession.handleHandlesDumpRequest(msg);
      case "daemon.update.request":
        return this.daemonSession.handleUpdateRequest(msg);
      case "set_daemon_config_request":
        return this.applyDaemonConfigPatch(msg);
    }
  }

  // eslint-disable-next-line complexity
  private dispatchCheckoutMessage(msg: SessionInboundMessage): Promise<void> | undefined {
    switch (msg.type) {
      case "checkout_status_request":
        return this.checkoutSession.handleStatusRequest(msg);
      case "checkout.commits.list.request":
        return this.checkoutSession.handleCommitsListRequest(msg);
      case "checkout.commits.file_diff.request":
        return this.checkoutSession.handleCommitFileDiffRequest(msg, this.delivery.requestSignal);
      case "validate_branch_request":
        return this.checkoutSession.handleValidateBranchRequest(msg);
      case "branch_suggestions_request":
        return this.checkoutSession.handleBranchSuggestionsRequest(msg);
      case "directory_suggestions_request":
        return this.handleDirectorySuggestionsRequest(msg);
      case "checkout.diff.get.request":
        return this.checkoutSession.handleReadDiffRequest(msg);
      case "subscribe_checkout_diff_request":
        return this.checkoutSession.handleSubscribeDiffRequest(msg, this.delivery);
      case "unsubscribe_checkout_diff_request":
        return this.checkoutSession.handleUnsubscribeDiffRequest(msg, this.delivery);
      case "checkout_switch_branch_request":
        return this.checkoutSession.handleCheckoutSwitchBranchRequest(msg);
      case "checkout.rename_branch.request":
        return this.checkoutSession.handleCheckoutRenameBranchRequest(msg);
      case "checkout_commit_request":
        return this.checkoutSession.handleCheckoutCommitRequest(msg);
      case "checkout_merge_request":
        return this.checkoutSession.handleCheckoutMergeRequest(msg);
      case "checkout_merge_from_base_request":
        return this.checkoutSession.handleCheckoutMergeFromBaseRequest(msg);
      case "checkout_pull_request":
        return this.checkoutSession.handleCheckoutPullRequest(msg);
      case "checkout_push_request":
        return this.checkoutSession.handleCheckoutPushRequest(msg);
      case "checkout.refresh.request":
        return this.checkoutSession.handleRefreshRequest(msg);
      case "checkout.discard_changes.request":
        return this.checkoutSession.handleCheckoutDiscardChangesRequest(msg);
      case "checkout_pr_create_request":
        return this.checkoutSession.handleCheckoutPrCreateRequest(msg);
      case "checkout_pr_merge_request":
        return this.checkoutSession.handleCheckoutPrMergeRequest(msg);
      case "checkout.forge.set_auto_merge.request":
      case "checkout.github.set_auto_merge.request":
        return this.checkoutSession.handleCheckoutForgeSetAutoMergeRequest(msg);
      case "checkout.forge.get_check_details.request":
      case "checkout.github.get_check_details.request":
        return this.checkoutSession.handleCheckoutForgeGetCheckDetailsRequest(msg);
      case "checkout_pr_status_request":
        return this.checkoutSession.handleCheckoutPrStatusRequest(msg);
      case "pull_request_timeline_request":
        return this.checkoutSession.handlePullRequestTimelineRequest(msg);
      case "forge.search.request":
      case "github_search_request":
        return this.checkoutSession.handleForgeSearchRequest(msg);
      case "stash_save_request":
        return this.checkoutSession.handleStashSaveRequest(msg);
      case "stash_pop_request":
        return this.checkoutSession.handleStashPopRequest(msg);
      case "stash_list_request":
        return this.checkoutSession.handleStashListRequest(msg);
      default:
        return undefined;
    }
  }

  private dispatchWorkspaceAndProjectMessage(
    msg: SessionInboundMessage,
  ): Promise<void> | undefined {
    switch (msg.type) {
      case "fetch_workspaces_request":
        return this.handleFetchWorkspacesRequest(msg);
      case "project.list.request":
        return this.handleProjectListRequest(msg);
      case "project.suggestions.request":
        return this.handleProjectSuggestionsRequest(msg);
      case "neolix_worktree_list_request":
        return this.handleNeolixWorktreeListRequest(msg);
      case "neolix_worktree_archive_request":
        return this.handleNeolixWorktreeArchiveRequest(msg);
      case "create_neolix_worktree_request":
        return this.handleCreateNeolixWorktreeRequest(msg);
      // COMPAT(desktopEditorBridge): added in v0.1.88, remove after 2026-12-03 once old clients no longer call daemon editor RPCs.
      case "list_available_editors_request":
        return this.handleLegacyListAvailableEditorsRequest(msg);
      case "open_in_editor_request":
        return this.handleLegacyOpenInEditorRequest(msg);
      case "open_project_request":
        return this.handleOpenProjectRequest(msg);
      case "project.add.request":
        return this.handleProjectAddRequest(msg);
      case "project.create_directory.request":
        return this.handleProjectCreateDirectoryRequest(msg);
      case "workspace.github.search_repositories.request":
        return this.handleWorkspaceGithubSearchRepositoriesRequest(msg);
      case "project.github.clone.request":
        return this.handleProjectGithubCloneRequest(msg);
      case "archive_workspace_request":
        return this.handleArchiveWorkspaceRequest(msg);
      case "project.remove.request":
        return this.handleProjectRemoveRequest(msg);
      case "workspace.title.set.request":
        return this.handleWorkspaceTitleSetRequest(msg.workspaceId, msg.title, msg.requestId);
      case "workspace.pin.set.request":
        return this.handleWorkspacePinSetRequest(msg.workspaceId, msg.pinned, msg.requestId);
      default:
        return undefined;
    }
  }

  private dispatchWorkspaceSetupMessage(msg: SessionInboundMessage): Promise<void> | undefined {
    if (msg.type === "workspace_setup_status_request") {
      return this.handleWorkspaceSetupStatusRequest(msg);
    }
    if (msg.type === "workspace.setup.run.request") {
      return this.handleWorkspaceSetupRunRequest(msg);
    }
    return undefined;
  }

  private dispatchWorkspaceLabelMessage(msg: SessionInboundMessage): Promise<void> | undefined {
    switch (msg.type) {
      case "workspace.label.list.request":
        return this.handleWorkspaceLabelList(msg);
      case "workspace.label.assignment.set.request":
        return this.handleWorkspaceLabelAssignment(msg);
      case "workspace.label.update.request":
        return this.handleWorkspaceLabelUpdate(msg);
      case "workspace.label.delete.request":
        return this.handleWorkspaceLabelDelete(msg);
      case "workspace.label.delete.inspect.request":
        return this.handleWorkspaceLabelDeleteInspection(msg);
      default:
        return undefined;
    }
  }

  private dispatchSyncMessage(msg: SessionInboundMessage): Promise<void> | undefined {
    if (!msg.type.startsWith("sync.") && !msg.type.startsWith("backup.")) {
      return undefined;
    }
    return this.handleSyncRequest(
      msg as Extract<SessionInboundMessage, { type: `sync.${string}` | `backup.${string}` }>,
    );
  }

  private handleSyncRequest(
    msg: Extract<SessionInboundMessage, { type: `sync.${string}` | `backup.${string}` }>,
  ): Promise<void> {
    if (isSyncRpcRequest(msg)) {
      return this.handleSyncRpc(msg);
    }
    return this.handleBackupRpc(msg as BackupRpcRequest);
  }

  /** The app's settings sync: its config, status, and remote versions. */
  private handleSyncRpc(msg: SyncRpcRequest): Promise<void> {
    if (isSyncConfigRpcRequest(msg)) {
      return this.handleSyncConfigRpc(msg);
    }
    return this.handleSyncHistoryRpc(msg as SyncHistoryRpcRequest);
  }

  /** The sync's own configuration and its runs. */
  private async handleSyncConfigRpc(msg: SyncConfigRpcRequest): Promise<void> {
    const fail = (error: unknown): string =>
      error instanceof Error ? error.message : String(error);
    switch (msg.type) {
      case "sync.config.get.request": {
        const config = await this.syncService.config();
        this.emit({
          type: "sync.config.get.response",
          payload: { requestId: msg.requestId, config },
        });
        return;
      }
      case "sync.config.set.request": {
        try {
          const config = await this.syncService.configure(msg.config);
          this.emit({
            type: "sync.config.set.response",
            payload: { requestId: msg.requestId, config },
          });
        } catch (error) {
          this.emit({
            type: "sync.config.set.response",
            payload: { requestId: msg.requestId, error: fail(error) },
          });
        }
        return;
      }
      case "sync.status.get.request": {
        const status = await this.syncService.status();
        this.emit({
          type: "sync.status.get.response",
          payload: { requestId: msg.requestId, status },
        });
        return;
      }
      case "sync.run.request": {
        try {
          // A sync asked for from the app is manual: myna's SyncNow shares usage
          // whatever the 15-minute clock says.
          const status = await this.syncService.run({ force: msg.force !== false });
          this.emit({
            type: "sync.run.response",
            payload: {
              requestId: msg.requestId,
              status,
              ...(status.error ? { error: status.error } : {}),
            },
          });
        } catch (error) {
          this.emit({
            type: "sync.run.response",
            payload: {
              requestId: msg.requestId,
              status: await this.syncService.status(),
              error: fail(error),
            },
          });
        }
        return;
      }
    }
  }

  /** Remote versions, restore and undo, and the app's settings copies. */
  private handleSyncHistoryRpc(msg: SyncHistoryRpcRequest): Promise<void> {
    switch (msg.type) {
      case "sync.list_remote.request":
        return this.handleSyncListRemote(msg);
      case "sync.restore.request":
      case "sync.undo.request":
      case "sync.upload.request":
      case "sync.follow.request":
        return this.handleSyncAction(msg);
      case "sync.notice.dismiss.request":
        return this.handleSyncDismiss(msg);
      case "sync.usage.get.request":
        return this.handleSyncUsageGet(msg);
      case "sync.app_settings.export.request":
      case "sync.app_settings.get.request":
      case "sync.app_settings.patch.request":
        return this.handleSyncAppSettingsRpc(msg);
    }
  }

  private async handleSyncListRemote(
    msg: Extract<SyncHistoryRpcRequest, { type: "sync.list_remote.request" }>,
  ): Promise<void> {
    try {
      const versions = await this.syncService.listRemote();
      this.emit({
        type: "sync.list_remote.response",
        payload: { requestId: msg.requestId, versions },
      });
    } catch (error) {
      this.emit({
        type: "sync.list_remote.response",
        payload: { requestId: msg.requestId, versions: [], error: getErrorMessage(error) },
      });
    }
  }

  private async handleSyncAction(
    msg: Extract<
      SyncHistoryRpcRequest,
      {
        type:
          | "sync.restore.request"
          | "sync.undo.request"
          | "sync.upload.request"
          | "sync.follow.request";
      }
    >,
  ): Promise<void> {
    if (msg.type === "sync.restore.request") {
      try {
        const status = await this.syncService.restoreRemote();
        this.emit({
          type: "sync.restore.response",
          payload: { requestId: msg.requestId, status },
        });
      } catch (error) {
        this.emit({
          type: "sync.restore.response",
          payload: { requestId: msg.requestId, error: getErrorMessage(error) },
        });
      }
      return;
    }
    if (msg.type === "sync.undo.request") {
      try {
        const status = await this.syncService.undo();
        this.emit({
          type: "sync.undo.response",
          payload: { requestId: msg.requestId, status },
        });
      } catch (error) {
        this.emit({
          type: "sync.undo.response",
          payload: { requestId: msg.requestId, error: getErrorMessage(error) },
        });
      }
      return;
    }
    if (msg.type === "sync.upload.request") {
      try {
        const status = await this.syncService.upload();
        this.emit({
          type: "sync.upload.response",
          payload: { requestId: msg.requestId, status },
        });
      } catch (error) {
        this.emit({
          type: "sync.upload.response",
          payload: { requestId: msg.requestId, error: getErrorMessage(error) },
        });
      }
      return;
    }
    try {
      const status = await this.syncService.follow();
      this.emit({
        type: "sync.follow.response",
        payload: { requestId: msg.requestId, status },
      });
    } catch (error) {
      this.emit({
        type: "sync.follow.response",
        payload: { requestId: msg.requestId, error: getErrorMessage(error) },
      });
    }
  }

  private async handleSyncDismiss(
    msg: Extract<SyncHistoryRpcRequest, { type: "sync.notice.dismiss.request" }>,
  ): Promise<void> {
    try {
      await this.syncService.dismissNotice();
      this.emit({
        type: "sync.notice.dismiss.response",
        payload: { requestId: msg.requestId },
      });
    } catch (error) {
      this.emit({
        type: "sync.notice.dismiss.response",
        payload: { requestId: msg.requestId, error: getErrorMessage(error) },
      });
    }
  }

  private async handleSyncUsageGet(
    msg: Extract<SyncHistoryRpcRequest, { type: "sync.usage.get.request" }>,
  ): Promise<void> {
    try {
      const report = await this.syncService.usage();
      this.emit({
        type: "sync.usage.get.response",
        payload: { requestId: msg.requestId, ...report },
      });
    } catch (error) {
      this.emit({
        type: "sync.usage.get.response",
        payload: {
          requestId: msg.requestId,
          period: "90d",
          since: new Date(0).toISOString(),
          calls: 0,
          errors: 0,
          input: 0,
          output: 0,
          cache_read: 0,
          cache_write: 0,
          reasoning: 0,
          cost: 0,
          unpriced: 0,
          bucket: "day",
          series: [],
          rows: [],
          total: 0,
          offset: 0,
          devices: [],
          quotas: [],
          quotaHistory: [],
          error: getErrorMessage(error),
        },
      });
    }
  }

  private async handleSyncAppSettingsRpc(
    msg: Extract<
      SyncHistoryRpcRequest,
      {
        type:
          | "sync.app_settings.export.request"
          | "sync.app_settings.get.request"
          | "sync.app_settings.patch.request";
      }
    >,
  ): Promise<void> {
    if (msg.type === "sync.app_settings.export.request") {
      try {
        await this.syncService.saveAppSettings(msg.settings);
        this.emit({
          type: "sync.app_settings.export.response",
          payload: { requestId: msg.requestId },
        });
      } catch (error) {
        this.emit({
          type: "sync.app_settings.export.response",
          payload: { requestId: msg.requestId, error: getErrorMessage(error) },
        });
      }
      return;
    }
    if (msg.type === "sync.app_settings.get.request") {
      const settings = await this.syncService.appSettings();
      this.emit({
        type: "sync.app_settings.get.response",
        payload: {
          requestId: msg.requestId,
          settings: (settings as Record<string, unknown> | null) ?? null,
          patchedAt: await this.syncService.appSettingsPatchedAt(),
        },
      });
      return;
    }
    try {
      await this.syncService.patchAppSettings(msg.key, msg.value);
      this.emitSyncEvent({
        type: "sync.app_settings.apply",
        value: { [msg.key]: msg.value },
      });
      this.emit({
        type: "sync.app_settings.patch.response",
        payload: { requestId: msg.requestId },
      });
    } catch (error) {
      this.emit({
        type: "sync.app_settings.patch.response",
        payload: { requestId: msg.requestId, error: getErrorMessage(error) },
      });
    }
  }

  /** The app's backups: export, list, restore, delete, and their schedule. */
  private handleBackupRpc(msg: BackupRpcRequest): Promise<void> {
    switch (msg.type) {
      case "backup.export.request":
        return this.handleBackupExport(msg);
      case "backup.list.request":
        return this.handleBackupList(msg);
      case "backup.restore.request":
        return this.handleBackupRestore(msg);
      case "backup.import.request":
        return this.handleBackupImport(msg);
      case "backup.download.request":
        return this.workspaceFilesSession.handleBackupDownloadTokenRequest(msg);
      case "backup.reveal.request":
        return this.handleBackupReveal(msg);
      case "backup.delete.request":
        return this.handleBackupDelete(msg);
      case "backup.auto.get.request":
      case "backup.auto.set.request":
      case "backup.auto.run.request":
        return this.handleBackupAutoRpc(msg);
    }
  }

  private async handleBackupExport(
    msg: Extract<BackupRpcRequest, { type: "backup.export.request" }>,
  ): Promise<void> {
    try {
      const entry = await this.syncService.exportBackup({
        passphrase: msg.passphrase,
        keys: msg.keys,
        signIns: msg.signIns,
      });
      this.emit({
        type: "backup.export.response",
        payload: {
          requestId: msg.requestId,
          backup: { name: entry.name, size: entry.size, at: entry.at, auto: entry.auto },
        },
      });
    } catch (error) {
      this.emit({
        type: "backup.export.response",
        payload: { requestId: msg.requestId, error: getErrorMessage(error) },
      });
    }
  }

  private async handleBackupList(
    msg: Extract<BackupRpcRequest, { type: "backup.list.request" }>,
  ): Promise<void> {
    const backups = await this.syncService.backups();
    this.emit({
      type: "backup.list.response",
      payload: {
        requestId: msg.requestId,
        backups: backups.map((entry) => ({
          name: entry.name,
          size: entry.size,
          at: entry.at,
          auto: entry.auto,
        })),
      },
    });
  }

  private async handleBackupRestore(
    msg: Extract<BackupRpcRequest, { type: "backup.restore.request" }>,
  ): Promise<void> {
    try {
      const result = await this.syncService.restore({
        name: msg.name,
        passphrase: msg.passphrase,
        keys: msg.keys,
        signIns: msg.signIns,
      });
      this.emit({
        type: "backup.restore.response",
        payload: {
          requestId: msg.requestId,
          parts: result.parts,
          ...(result.saved ? { saved: result.saved } : {}),
        },
      });
    } catch (error) {
      this.emit({
        type: "backup.restore.response",
        payload: { requestId: msg.requestId, error: getErrorMessage(error) },
      });
    }
  }

  private async handleBackupImport(
    msg: Extract<BackupRpcRequest, { type: "backup.import.request" }>,
  ): Promise<void> {
    try {
      const result = await this.syncService.importBackup({
        id: msg.id,
        passphrase: msg.passphrase,
        keys: msg.keys,
        signIns: msg.signIns,
      });
      this.emit({
        type: "backup.import.response",
        payload: {
          requestId: msg.requestId,
          parts: result.parts,
          ...(result.saved ? { saved: result.saved } : {}),
        },
      });
    } catch (error) {
      this.emit({
        type: "backup.import.response",
        payload: { requestId: msg.requestId, error: getErrorMessage(error) },
      });
    }
  }

  private async handleBackupReveal(
    msg: Extract<BackupRpcRequest, { type: "backup.reveal.request" }>,
  ): Promise<void> {
    const result = await this.syncService.revealBackups();
    this.emit({
      type: "backup.reveal.response",
      payload: {
        requestId: msg.requestId,
        ok: result.ok,
        ...(result.error ? { error: result.error } : {}),
      },
    });
  }

  private async handleBackupDelete(
    msg: Extract<BackupRpcRequest, { type: "backup.delete.request" }>,
  ): Promise<void> {
    try {
      await this.syncService.removeBackup(msg.name);
      this.emit({
        type: "backup.delete.response",
        payload: { requestId: msg.requestId },
      });
    } catch (error) {
      this.emit({
        type: "backup.delete.response",
        payload: { requestId: msg.requestId, error: getErrorMessage(error) },
      });
    }
  }

  private async handleBackupAutoRpc(
    msg: Extract<
      BackupRpcRequest,
      {
        type: "backup.auto.get.request" | "backup.auto.set.request" | "backup.auto.run.request";
      }
    >,
  ): Promise<void> {
    if (msg.type === "backup.auto.get.request") {
      const config = await this.syncService.autoConfig();
      this.emit({
        type: "backup.auto.get.response",
        payload: { requestId: msg.requestId, config },
      });
      return;
    }
    if (msg.type === "backup.auto.set.request") {
      try {
        const config = await this.syncService.setAutoConfig(msg.config);
        this.emit({
          type: "backup.auto.set.response",
          payload: { requestId: msg.requestId, config },
        });
      } catch (error) {
        this.emit({
          type: "backup.auto.set.response",
          payload: { requestId: msg.requestId, error: getErrorMessage(error) },
        });
      }
      return;
    }
    try {
      const backup = await this.syncService.runAuto(msg.passphrase);
      this.emit({
        type: "backup.auto.run.response",
        payload: {
          requestId: msg.requestId,
          backup: backup
            ? { name: backup.name, size: backup.size, at: backup.at, auto: backup.auto }
            : null,
        },
      });
    } catch (error) {
      this.emit({
        type: "backup.auto.run.response",
        payload: { requestId: msg.requestId, error: getErrorMessage(error) },
      });
    }
  }

  private emitSyncEvent(event: SyncEvent): void {
    if (event.type === "sync.status.changed") {
      this.emit({ type: "sync.status.changed", payload: { status: event.status } });
    } else if (event.type === "sync.app_settings.apply") {
      this.emit({
        type: "sync.app_settings.apply",
        payload: { settings: (event.value as Record<string, unknown>) ?? {} },
      });
    }
  }

  private dispatchLibraryMessage(msg: SessionInboundMessage): Promise<void> | undefined {
    if (!msg.type.startsWith("library.")) {
      return undefined;
    }
    const request = msg as Extract<SessionInboundMessage, { type: `library.${string}` }>;
    if (request.type === "library.get.request") {
      return this.handleLibraryGet(request);
    }
    if (request.type === "library.sync.request") {
      return this.handleLibrarySync(request);
    }
    if (request.type === "library.instructions.save.request") {
      return this.handleLibraryInstructions(request);
    }
    if (request.type.startsWith("library.mcp.")) {
      return this.handleLibraryMcp(
        request as Extract<SessionInboundMessage, { type: `library.mcp.${string}` }>,
      );
    }
    if (request.type.startsWith("library.skill.")) {
      return this.handleLibrarySkills(
        request as Extract<SessionInboundMessage, { type: `library.skill.${string}` }>,
      );
    }
    if (request.type.startsWith("library.hook.")) {
      return this.handleLibraryHooks(
        request as Extract<SessionInboundMessage, { type: `library.hook.${string}` }>,
      );
    }
    if (request.type.startsWith("library.subagent.")) {
      return this.handleLibrarySubagents(
        request as Extract<SessionInboundMessage, { type: `library.subagent.${string}` }>,
      );
    }
    if (
      request.type.startsWith("library.rtk.") ||
      request.type.startsWith("library.github_token.")
    ) {
      return this.handleLibraryRtk(
        request as Extract<
          SessionInboundMessage,
          { type: `library.rtk.${string}` | `library.github_token.${string}` }
        >,
      );
    }
    if (request.type.startsWith("library.discover.")) {
      return this.handleLibraryDiscover(
        request as Extract<SessionInboundMessage, { type: `library.discover.${string}` }>,
      );
    }
    if (request.type.startsWith("library.market.")) {
      return this.handleLibraryMarket(
        request as Extract<SessionInboundMessage, { type: `library.market.${string}` }>,
      );
    }
    if (request.type.startsWith("library.myna.")) {
      return this.handleLibraryMynaImport(
        request as Extract<SessionInboundMessage, { type: `library.myna.${string}` }>,
      );
    }
    if (request.type.startsWith("library.backup.")) {
      return this.handleLibraryBackups(
        request as Extract<SessionInboundMessage, { type: `library.backup.${string}` }>,
      );
    }
    return undefined;
  }

  private async handleLibraryGet(
    msg: Extract<SessionInboundMessage, { type: "library.get.request" }>,
  ): Promise<void> {
    const library = await this.libraryService.getSnapshot();
    this.emit({
      type: "library.get.response",
      payload: { requestId: msg.requestId, library },
    });
  }

  private async handleLibrarySync(
    msg: Extract<SessionInboundMessage, { type: "library.sync.request" }>,
  ): Promise<void> {
    const result = await this.libraryService.syncNow();
    this.emit({
      type: "library.sync.response",
      payload: { requestId: msg.requestId, ...result },
    });
  }

  private async handleLibraryInstructions(
    msg: Extract<SessionInboundMessage, { type: "library.instructions.save.request" }>,
  ): Promise<void> {
    const result = await this.libraryService.saveInstructions({
      ...(msg.shared !== undefined ? { shared: msg.shared } : {}),
      ...(msg.agents !== undefined ? { agents: msg.agents } : {}),
      ...(msg.extra !== undefined ? { extra: msg.extra } : {}),
      ...(msg.texts !== undefined ? { texts: msg.texts } : {}),
      ...(msg.activate !== undefined ? { activate: msg.activate } : {}),
      ...(msg.create !== undefined ? { create: msg.create } : {}),
      ...(msg.rename !== undefined ? { rename: msg.rename } : {}),
      ...(msg.remove !== undefined ? { remove: msg.remove } : {}),
      ...(msg.importOwn !== undefined ? { importOwn: msg.importOwn } : {}),
      ...(msg.rewrite !== undefined ? { rewrite: msg.rewrite } : {}),
    });
    this.emit({
      type: "library.instructions.save.response",
      payload: { requestId: msg.requestId, ...result },
    });
  }

  private async handleLibraryMcp(
    msg: Extract<
      SessionInboundMessage,
      {
        type:
          | "library.mcp.save.request"
          | "library.mcp.remove.request"
          | "library.mcp.set_agents.request"
          | "library.mcp.health.request"
          | "library.mcp.hub.request"
          | "library.mcp.signin.request"
          | "library.mcp.signin_status.request"
          | "library.mcp.signin_cancel.request"
          | "library.mcp.signout.request";
      }
    >,
  ): Promise<void> {
    if (msg.type === "library.mcp.save.request") {
      const result = await this.libraryService.saveMcpServer(msg.oldName ?? null, msg.server);
      this.emit({
        type: "library.mcp.save.response",
        payload: { requestId: msg.requestId, ...result },
      });
      return;
    }
    if (msg.type === "library.mcp.remove.request") {
      const result = await this.libraryService.removeMcpServer(msg.name);
      this.emit({
        type: "library.mcp.remove.response",
        payload: { requestId: msg.requestId, ...result },
      });
      return;
    }
    if (msg.type === "library.mcp.hub.request") {
      const result = await this.libraryService.setMcpHub(msg.on);
      this.emit({
        type: "library.mcp.hub.response",
        payload: { requestId: msg.requestId, ...result },
      });
      return;
    }
    if (msg.type === "library.mcp.health.request") {
      const health = await this.libraryService.checkMcp(msg.name);
      this.emit({
        type: "library.mcp.health.response",
        payload: { requestId: msg.requestId, health },
      });
      return;
    }
    if (msg.type === "library.mcp.signin.request") {
      const state = await this.libraryService.signInMcp(msg.name);
      this.emit({
        type: "library.mcp.signin.response",
        payload: { requestId: msg.requestId, state },
      });
      return;
    }
    if (msg.type === "library.mcp.signin_status.request") {
      const state = this.libraryService.signInProgress(msg.id);
      this.emit({
        type: "library.mcp.signin_status.response",
        payload: { requestId: msg.requestId, ...(state ? { state } : {}) },
      });
      return;
    }
    if (msg.type === "library.mcp.signin_cancel.request") {
      this.libraryService.cancelSignIn(msg.id);
      this.emit({
        type: "library.mcp.signin_cancel.response",
        payload: { requestId: msg.requestId },
      });
      return;
    }
    if (msg.type === "library.mcp.signout.request") {
      const result = await this.libraryService.signOutMcp(msg.name);
      this.emit({
        type: "library.mcp.signout.response",
        payload: { requestId: msg.requestId, ...result },
      });
      return;
    }
    const result = await this.libraryService.setMcpAgents(msg.name, msg.agents);
    this.emit({
      type: "library.mcp.set_agents.response",
      payload: { requestId: msg.requestId, ...result },
    });
  }

  private async controlLibrarySkill(
    msg: Extract<SessionInboundMessage, { type: "library.skill.control.request" }>,
  ) {
    if (msg.action === "here") {
      if (msg.name === undefined || msg.on === undefined) {
        throw new Error("here needs a skill name and on");
      }
      return this.libraryService.setSkillHere(msg.name, msg.on);
    }
    if (msg.action === "handover") {
      const names = msg.all === true ? null : (msg.names ?? (msg.name ? [msg.name] : []));
      if (names !== null && names.length === 0) {
        throw new Error("hand-over needs one or more skill names, or --all");
      }
      return this.libraryService.handOverSkills(names);
    }
    if (msg.action === "handback") {
      if (msg.name === undefined) {
        throw new Error("hand-back needs a skill name");
      }
      return this.libraryService.handBackSkill(msg.name);
    }
    if (msg.name === undefined || msg.agent === undefined) {
      throw new Error("settle needs a skill name and an agent");
    }
    return this.libraryService.settleSkill(msg.name, msg.agent, msg.keepOwn === true);
  }

  private async handleLibrarySkills(
    msg: Extract<
      SessionInboundMessage,
      {
        type:
          | "library.skill.import.request"
          | "library.skill.control.request"
          | "library.skill.remove.request"
          | "library.skill.set_agents.request"
          | "library.skill.find.request"
          | "library.skill.install.request"
          | "library.skill.options.request"
          | "library.skill.note.request"
          | "library.skill.check.request"
          | "library.skill.update.request";
      }
    >,
  ): Promise<void> {
    if (msg.type === "library.skill.import.request") {
      const result = await this.libraryService.importSkill(msg.path);
      this.emit({
        type: "library.skill.import.response",
        payload: { requestId: msg.requestId, ...result },
      });
      return;
    }
    if (msg.type === "library.skill.control.request") {
      const result = await this.controlLibrarySkill(msg);
      this.emit({
        type: "library.skill.control.response",
        payload: { requestId: msg.requestId, ...result },
      });
      return;
    }
    if (msg.type === "library.skill.remove.request") {
      const result = await this.libraryService.removeSkill(msg.name);
      this.emit({
        type: "library.skill.remove.response",
        payload: { requestId: msg.requestId, ...result },
      });
      return;
    }
    if (msg.type === "library.skill.find.request") {
      const candidates = await this.libraryService.findSkills(msg.source);
      this.emit({
        type: "library.skill.find.response",
        payload: {
          requestId: msg.requestId,
          candidates: candidates.map((candidate) => ({
            name: candidate.name,
            description: candidate.description,
            path: candidate.dir,
            hash: candidate.hash,
          })),
        },
      });
      return;
    }
    if (msg.type === "library.skill.install.request") {
      const result = await this.libraryService.installSkills(msg.source, msg.names);
      this.emit({
        type: "library.skill.install.response",
        payload: { requestId: msg.requestId, ...result },
      });
      return;
    }
    if (msg.type === "library.skill.options.request") {
      const result = await this.libraryService.setSkillOptions({
        ...(msg.copySkills !== undefined ? { copySkills: msg.copySkills } : {}),
        ...(msg.skillHow !== undefined ? { skillHow: msg.skillHow } : {}),
        ...(msg.sharedSkills !== undefined ? { sharedSkills: msg.sharedSkills } : {}),
      });
      this.emit({
        type: "library.skill.options.response",
        payload: { requestId: msg.requestId, ...result },
      });
      return;
    }
    if (msg.type === "library.skill.note.request") {
      const result = await this.libraryService.setSkillNote(msg.name, msg.note);
      this.emit({
        type: "library.skill.note.response",
        payload: { requestId: msg.requestId, ...result },
      });
      return;
    }
    if (msg.type === "library.skill.check.request") {
      const updates = await this.libraryService.checkSkillUpdates();
      this.emit({
        type: "library.skill.check.response",
        payload: { requestId: msg.requestId, updates },
      });
      return;
    }
    if (msg.type === "library.skill.update.request") {
      const result = await this.libraryService.updateSkills(msg.names);
      this.emit({
        type: "library.skill.update.response",
        payload: { requestId: msg.requestId, ...result },
      });
      return;
    }
    const result = await this.libraryService.setSkillAgents(msg.name, msg.agents);
    this.emit({
      type: "library.skill.set_agents.response",
      payload: { requestId: msg.requestId, ...result },
    });
  }

  private async handleLibraryHooks(
    msg: Extract<
      SessionInboundMessage,
      {
        type:
          | "library.hook.save.request"
          | "library.hook.remove.request"
          | "library.hook.set_agents.request";
      }
    >,
  ): Promise<void> {
    if (msg.type === "library.hook.save.request") {
      const result = await this.libraryService.saveHook(msg.oldName ?? null, msg.hook);
      this.emit({
        type: "library.hook.save.response",
        payload: { requestId: msg.requestId, ...result },
      });
      return;
    }
    if (msg.type === "library.hook.remove.request") {
      const result = await this.libraryService.removeHook(msg.name);
      this.emit({
        type: "library.hook.remove.response",
        payload: { requestId: msg.requestId, ...result },
      });
      return;
    }
    const result = await this.libraryService.setHookAgents(msg.name, msg.agents);
    this.emit({
      type: "library.hook.set_agents.response",
      payload: { requestId: msg.requestId, ...result },
    });
  }

  private async handleLibrarySubagents(
    msg: Extract<
      SessionInboundMessage,
      {
        type:
          | "library.subagent.save.request"
          | "library.subagent.remove.request"
          | "library.subagent.set_agents.request";
      }
    >,
  ): Promise<void> {
    if (msg.type === "library.subagent.save.request") {
      const result = await this.libraryService.saveSubagent(msg.oldName ?? null, msg.subagent);
      this.emit({
        type: "library.subagent.save.response",
        payload: { requestId: msg.requestId, ...result },
      });
      return;
    }
    if (msg.type === "library.subagent.remove.request") {
      const result = await this.libraryService.removeSubagent(msg.name);
      this.emit({
        type: "library.subagent.remove.response",
        payload: { requestId: msg.requestId, ...result },
      });
      return;
    }
    const result = await this.libraryService.setSubagentAgents(msg.name, msg.agents);
    this.emit({
      type: "library.subagent.set_agents.response",
      payload: { requestId: msg.requestId, ...result },
    });
  }

  /** The Library's GitHub token: the page learns only whether one is set. */
  private async handleLibraryGithubToken(
    msg: Extract<SessionInboundMessage, { type: `library.github_token.${string}` }>,
  ): Promise<void> {
    if (msg.type === "library.github_token.get.request") {
      const token = await this.secretsStore.githubToken();
      const rejected = githubSettingsRefused(token);
      this.emit({
        type: "library.github_token.get.response",
        payload: {
          requestId: msg.requestId,
          configured: token !== null,
          ...(rejected === null
            ? {}
            : { rejected: true, rejectedAt: new Date(rejected.at).toISOString() }),
        },
      });
      return;
    }
    await this.secretsStore.setGithubToken(msg.token);
    this.emit({
      type: "library.github_token.set.response",
      payload: { requestId: msg.requestId, configured: msg.token.trim().length > 0 },
    });
  }

  private async handleLibraryRtk(
    msg: Extract<
      SessionInboundMessage,
      {
        type:
          | "library.rtk.get.request"
          | "library.rtk.set.request"
          | "library.rtk.run.request"
          | "library.rtk.gain.request"
          | `library.github_token.${string}`;
      }
    >,
  ): Promise<void> {
    if (
      msg.type === "library.github_token.get.request" ||
      msg.type === "library.github_token.set.request"
    ) {
      return this.handleLibraryGithubToken(
        msg as Extract<SessionInboundMessage, { type: `library.github_token.${string}` }>,
      );
    }
    if (msg.type === "library.rtk.get.request") {
      const rtk = await this.libraryService.getRtk();
      this.emit({
        type: "library.rtk.get.response",
        payload: { requestId: msg.requestId, rtk },
      });
      return;
    }
    if (msg.type === "library.rtk.run.request") {
      const result = await this.libraryService.runRtk(
        msg.action,
        msg.confirm,
        ...(msg.distro === undefined ? [] : [msg.distro]),
      );
      this.emit({
        type: "library.rtk.run.response",
        payload: { requestId: msg.requestId, ...result },
      });
      return;
    }
    if (msg.type === "library.rtk.gain.request") {
      const gain = await this.libraryService.getRtkGain();
      this.emit({
        type: "library.rtk.gain.response",
        payload: { requestId: msg.requestId, gain },
      });
      return;
    }
    const rtk = await this.libraryService.setRtk(msg.agent, msg.on);
    this.emit({
      type: "library.rtk.set.response",
      payload: { requestId: msg.requestId, rtk },
    });
  }

  private async handleLibraryDiscover(
    msg: Extract<
      SessionInboundMessage,
      {
        type:
          | "library.discover.get.request"
          | "library.discover.import.request"
          | "library.discover.remove.request";
      }
    >,
  ): Promise<void> {
    if (msg.type === "library.discover.get.request") {
      const discover = await this.libraryService.discover();
      this.emit({
        type: "library.discover.get.response",
        payload: { requestId: msg.requestId, discover },
      });
      return;
    }
    if (msg.type === "library.discover.remove.request") {
      const result = await this.libraryService.removeDiscovered({
        servers: msg.servers,
        skills: msg.skills,
      });
      this.emit({
        type: "library.discover.remove.response",
        payload: { requestId: msg.requestId, ...result },
      });
      return;
    }
    const result = await this.libraryService.importDiscovered({
      servers: msg.servers,
      skills: msg.skills,
    });
    this.emit({
      type: "library.discover.import.response",
      payload: { requestId: msg.requestId, ...result },
    });
  }

  private async handleLibraryMarket(
    msg: Extract<SessionInboundMessage, { type: `library.market.${string}` }>,
  ): Promise<void> {
    if (msg.type === "library.market.skills.request") {
      const skills = await this.libraryService.searchSkillMarket(msg.query);
      this.emit({
        type: "library.market.skills.response",
        payload: { requestId: msg.requestId, skills },
      });
      return;
    }
    if (msg.type === "library.market.servers.request") {
      const outcome = await this.libraryService.searchMarketServers(msg.query);
      this.emit({
        type: "library.market.servers.response",
        payload: {
          requestId: msg.requestId,
          servers: outcome.servers,
          ...(outcome.registryError ? { error: outcome.registryError } : {}),
        },
      });
      return;
    }
    const result = await this.libraryService.installMarketServer(msg.id, msg.values, msg.agents);
    this.emit({
      type: "library.market.install.response",
      payload: { requestId: msg.requestId, ...result },
    });
  }

  private async handleLibraryMynaImport(
    msg: Extract<
      SessionInboundMessage,
      { type: "library.myna.get.request" | "library.myna.import.request" }
    >,
  ): Promise<void> {
    if (msg.type === "library.myna.get.request") {
      const myna = await this.libraryService.getMynaLibrary();
      this.emit({
        type: "library.myna.get.response",
        payload: { requestId: msg.requestId, myna },
      });
      return;
    }
    const result = await this.libraryService.importMynaLibrary({
      servers: msg.servers,
      skills: msg.skills,
    });
    this.emit({
      type: "library.myna.import.response",
      payload: { requestId: msg.requestId, ...result },
    });
  }

  private async handleLibraryBackups(
    msg: Extract<
      SessionInboundMessage,
      { type: "library.backup.list.request" | "library.backup.restore.request" }
    >,
  ): Promise<void> {
    if (msg.type === "library.backup.list.request") {
      const backups = await this.libraryService.listBackups();
      this.emit({
        type: "library.backup.list.response",
        payload: { requestId: msg.requestId, backups },
      });
      return;
    }
    const library = await this.libraryService.restoreBackup(msg.agent, msg.stamp, msg.file);
    this.emit({
      type: "library.backup.restore.response",
      payload: { requestId: msg.requestId, library, restored: msg.file },
    });
  }

  private dispatchWorkspaceFileMessage(
    msg: SessionInboundMessage,
    source?: object,
  ): Promise<void> | undefined {
    switch (msg.type) {
      case "file_explorer_request":
        return this.workspaceFilesSession.handleFileExplorerRequest(msg, source);
      case "fs.file.subscribe.request":
        return this.workspaceFilesSession.handleFileSubscribeRequest(msg, this.delivery);
      case "fs.file.unsubscribe.request":
        return this.workspaceFilesSession.handleFileUnsubscribeRequest(msg, this.delivery);
      case "fs.file.write.request":
        return this.workspaceFilesSession.handleFileWriteRequest(msg);
      case "fs.entry.create.request":
        return this.workspaceFilesSession.handleFileEntryCreateRequest(msg);
      case "fs.entry.rename.request":
        return this.workspaceFilesSession.handleFileEntryRenameRequest(msg);
      case "fs.entry.duplicate.request":
        return this.workspaceFilesSession.handleFileEntryDuplicateRequest(msg);
      case "fs.entry.delete.request":
        return this.workspaceFilesSession.handleFileEntryDeleteRequest(msg);
      case "project_icon_request":
        return this.workspaceFilesSession.handleProjectIconRequest(msg);
      case "project.icon.get.request":
        return this.handleProjectIconGetRequest(msg.projectId, msg.requestId);
      case "file_download_token_request":
        return this.workspaceFilesSession.handleFileDownloadTokenRequest(msg);
      case "file.upload.request":
        this.workspaceFilesSession.handleFileUploadRequest(msg, this.delivery);
        return undefined;
      default:
        return undefined;
    }
  }

  private dispatchWorkspaceStateMessage(msg: SessionInboundMessage): Promise<void> | undefined {
    switch (msg.type) {
      case "workspace.recovery.inspect.request":
        return this.handleWorkspaceRecoveryInspectRequest(msg);
      case "workspace.recovery.restore.request":
        return this.handleWorkspaceRecoveryRestoreRequest(msg);
      case "workspace.clear_attention.request":
        return this.handleWorkspaceClearAttentionRequest(msg);
      case "workspace.mark_unread.request":
        return this.handleWorkspaceMarkUnreadRequest(msg);
      default:
        return undefined;
    }
  }

  private dispatchProviderMessage(msg: SessionInboundMessage): Promise<void> | undefined {
    switch (msg.type) {
      case "list_provider_models_request":
        return this.providerCatalogSession.handleListProviderModelsRequest(msg);
      case "list_provider_modes_request":
        return this.providerCatalogSession.handleListProviderModesRequest(msg);
      case "list_provider_features_request":
        return this.providerCatalogSession.handleListProviderFeaturesRequest(msg);
      case "list_available_providers_request":
        return this.providerCatalogSession.handleListAvailableProvidersRequest(msg);
      case "get_providers_snapshot_request":
        return this.providerCatalogSession.handleGetProvidersSnapshotRequest(msg);
      case "refresh_providers_snapshot_request":
        return this.providerCatalogSession.handleRefreshProvidersSnapshotRequest(msg);
      case "provider_diagnostic_request":
        return this.providerCatalogSession.handleProviderDiagnosticRequest(msg);
      case "provider.usage.list.request":
        return this.usageSession.handleLegacyList(msg);
      case "usage.list_reports.request":
        return this.usageSession.handleListReports(msg);
      default:
        return undefined;
    }
  }

  private dispatchTerminalMessage(msg: SessionInboundMessage): Promise<void> | undefined {
    switch (msg.type) {
      case "start_workspace_script_request":
        return this.handleStartWorkspaceScriptRequest(msg);
      case "workspace.script.list.request":
        return this.handleWorkspaceScriptListRequest(msg);
      case "workspace.script.start.request":
        return this.handleWorkspaceScriptStartRequest(msg);
      case "workspace.script.stop.request":
        return this.handleWorkspaceScriptStopRequest(msg);
      default:
        return this.terminalController.dispatch(msg, this.delivery);
    }
  }

  private dispatchScheduleMessage(msg: SessionInboundMessage): Promise<void> | undefined {
    switch (msg.type) {
      case "schedule/create":
        return this.scheduleSession.handleScheduleCreateRequest(msg);
      case "schedule/list":
        return this.scheduleSession.handleScheduleListRequest(msg);
      case "schedule/inspect":
        return this.scheduleSession.handleScheduleInspectRequest(msg);
      case "schedule/logs":
        return this.scheduleSession.handleScheduleLogsRequest(msg);
      case "schedule/pause":
        return this.scheduleSession.handleSchedulePauseRequest(msg);
      case "schedule/resume":
        return this.scheduleSession.handleScheduleResumeRequest(msg);
      case "schedule/delete":
        return this.scheduleSession.handleScheduleDeleteRequest(msg);
      case "schedule/run-once":
        return this.scheduleSession.handleScheduleRunOnceRequest(msg);
      case "schedule/update":
        return this.scheduleSession.handleScheduleUpdateRequest(msg);
      default:
        return undefined;
    }
  }

  private async dispatchMiscMessage(msg: SessionInboundMessage): Promise<void> {
    switch (msg.type) {
      case "stop_agent_task_request":
        await this.handleStopAgentTaskRequest(msg.agentId, msg.taskId, msg.requestId);
        return;
      case "list_commands_request":
        await this.handleListCommandsRequest(msg);
        return;
      case "register_push_token":
        this.handleRegisterPushToken(msg.token);
        return;
      case "push.unregister.request":
        this.pushNotifications.revoke(msg.token);
        if (this.currentClientMetadata().pushToken?.trim() === msg.token.trim()) {
          this.currentClientMetadata().pushToken = null;
        }
        this.emit({
          type: "push.unregister.response",
          payload: { requestId: msg.requestId },
        });
        return;
    }
  }

  public resetPeakInflight(): void {
    this.peakInflightRequests = this.inflightRequests;
  }

  public getSessionId(): string {
    return this.sessionId;
  }

  public async handleBinaryFrame(binaryFrame: BinaryFrame, source: object): Promise<void> {
    if (binaryFrame.kind === "host_route") {
      this.connectedHostSession?.binary(binaryFrame.frame, source);
      return;
    }
    if (binaryFrame.kind === "plugin") {
      const frame = binaryFrame.frame;
      // The binary form of plugin.rpc.invoke.request; it authorizes and replies like the JSON form.
      if (frame.opcode !== PluginFrameOpcode.Input) return;
      await this.handleMessage(
        {
          type: "plugin.rpc.invoke.request",
          requestId: frame.requestId,
          pluginId: frame.pluginId,
          method: frame.method,
          input: frame.payload,
        },
        source,
      );
      return;
    }
    if (!this.authorization.allowsPermission("workspace.write")) {
      return;
    }
    if (binaryFrame.kind === "file_transfer") {
      await this.workspaceFilesSession.handleFileTransferFrame(binaryFrame.frame, source);
      return;
    }
    this.terminalController.handleBinaryFrame(binaryFrame.frame, source);
  }

  private async handleRestartServerRequest(
    requestId: string,
    reason: string | undefined,
    options: { keepTerminals: boolean },
  ): Promise<void> {
    const lifecycleReason = normalizeClientRestartRpcReason(reason);
    const payload: { status: string } & Record<string, unknown> = {
      status: "restart_requested",
      clientId: this.clientId,
    };
    if (reason && reason.trim().length > 0) {
      payload.reason = reason;
    }
    payload.requestId = requestId;

    this.sessionLogger.warn(
      { reason: lifecycleReason, keepTerminals: options.keepTerminals },
      "Restart requested via websocket",
    );
    this.emit({
      type: "status",
      payload,
    });

    this.emitLifecycleIntent({
      type: "restart",
      clientId: this.clientId,
      requestId,
      reason: lifecycleReason,
      keepTerminals: options.keepTerminals,
    });
  }

  private async handleShutdownServerRequest(
    requestId: string,
    options: { keepTerminals: boolean },
  ): Promise<void> {
    const reason = CLIENT_SHUTDOWN_RPC_REASON;
    this.sessionLogger.warn(
      { reason, keepTerminals: options.keepTerminals },
      "Shutdown requested via websocket",
    );
    this.emit({
      type: "status",
      payload: {
        status: "shutdown_requested",
        clientId: this.clientId,
        requestId,
      },
    });

    this.emitLifecycleIntent({
      type: "shutdown",
      clientId: this.clientId,
      requestId,
      reason,
      keepTerminals: options.keepTerminals,
    });
  }

  private emitLifecycleIntent(intent: SessionLifecycleIntent): void {
    if (!this.onLifecycleIntent) {
      return;
    }
    try {
      this.onLifecycleIntent(intent);
    } catch (error) {
      this.sessionLogger.error({ err: error, intent }, "Lifecycle intent handler failed");
    }
  }

  private async handleDeleteAgentRequest(agentId: string, requestId: string): Promise<void> {
    this.sessionLogger.info({ agentId }, `Deleting agent ${agentId} from registry`);

    const knownAgent =
      this.agentManager.getAgent(agentId) ?? (await this.agentStorage.get(agentId));

    // File-backed storage still needs an early delete fence before closeAgent().
    beginAgentDeleteIfSupported(this.agentStorage, agentId);

    try {
      await closeAgentCommand({ agentManager: this.agentManager }, agentId);
    } catch (error) {
      this.sessionLogger.warn(
        { err: error, agentId },
        `Failed to close agent ${agentId} during delete`,
      );
    }

    // Drain queued persistence from the just-closed agent before removing its
    // durable snapshot, otherwise an in-flight background write can recreate it.
    await this.agentManager.flush();

    try {
      await this.agentStorage.remove(agentId);
      await this.agentManager.deleteAgentState(agentId);
      // Directory removal is daemon-wide; agent_deleted below stays a source-scoped RPC reply.
      if (knownAgent) this.agentManager.notifyAgentRemoved(knownAgent);
    } catch (error) {
      // Reporting success here would tell the client the agent is gone while
      // its stored record survives (and comes back on the next daemon start).
      this.sessionLogger.error({ err: error, agentId }, `Failed to fully delete agent ${agentId}`);
      this.emit({
        type: "rpc_error",
        payload: {
          requestId,
          requestType: "delete_agent_request",
          error: error instanceof Error ? error.message : "Failed to delete agent",
          code: "delete_agent_failed",
        },
      });
      return;
    }

    this.emit({
      type: "agent_deleted",
      payload: {
        agentId,
        requestId,
      },
    });
  }

  private async handleArchiveAgentRequest(agentId: string, requestId: string): Promise<void> {
    this.sessionLogger.info({ agentId }, `Archiving agent ${agentId}`);

    const { archivedAt } = await this.archiveAgentForClose(agentId);

    this.emit({
      type: "agent_archived",
      payload: {
        agentId,
        archivedAt,
        requestId,
      },
    });
  }

  private async archiveAgentForClose(
    agentId: string,
  ): Promise<{ agentId: string; archivedAt: string }> {
    const { archivedAt, record: archivedRecord } = await archiveAgentCommand(
      {
        agentManager: this.agentManager,
        agentStorage: this.agentStorage,
        logger: this.sessionLogger,
      },
      agentId,
    );

    if (archivedRecord && this.agentUpdates.hasSubscription()) {
      const payload = await this.agentUpdates.emitStoredRecord(archivedRecord);
      if (payload.workspaceId) {
        await this.emitWorkspaceUpdateForWorkspaceId(payload.workspaceId);
      }
    }

    return { agentId, archivedAt };
  }

  private async handleDetachAgentRequest(agentId: string, requestId: string): Promise<void> {
    this.sessionLogger.info({ agentId, requestId }, "Detaching agent from parent");

    try {
      const result = await detachAgentCommand({ agentManager: this.agentManager }, agentId);
      const affectedWorkspaceIds = new Set<string>();

      if (!result.live) {
        const payload = await this.agentUpdates.emitStoredRecord(result.record);
        if (payload.workspaceId) {
          affectedWorkspaceIds.add(payload.workspaceId);
        }
      } else if (result.record.workspaceId) {
        affectedWorkspaceIds.add(result.record.workspaceId);
      }

      if (result.previousParentAgentId) {
        const rootWorkspaceId = await this.resolveDelegationRootWorkspaceId(
          result.previousParentAgentId,
        );
        if (rootWorkspaceId) {
          affectedWorkspaceIds.add(rootWorkspaceId);
        }
      }

      await this.emitWorkspaceUpdatesForWorkspaceIds(affectedWorkspaceIds);

      this.emit({
        type: "agent.detach.response",
        payload: {
          requestId,
          agentId,
          accepted: true,
          error: null,
        },
      });
    } catch (error) {
      const message = getErrorMessageOr(error, "Failed to detach agent");
      this.sessionLogger.error({ err: error, agentId, requestId }, "Failed to detach agent");
      this.emit({
        type: "agent.detach.response",
        payload: {
          requestId,
          agentId,
          accepted: false,
          error: message,
        },
      });
    }
  }

  private async handleCloseItemsRequest(msg: CloseItemsRequest): Promise<void> {
    const archiveResults = await Promise.allSettled(
      msg.agentIds.map((agentId) => this.archiveAgentForClose(agentId)),
    );
    const agents = [];
    for (let i = 0; i < archiveResults.length; i += 1) {
      const result = archiveResults[i];
      if (result.status === "fulfilled") {
        agents.push(result.value);
      } else {
        this.sessionLogger.warn(
          { err: result.reason, agentId: msg.agentIds[i], requestId: msg.requestId },
          "Failed to archive agent during close_items batch",
        );
      }
    }

    const terminals = [];
    for (const terminalId of msg.terminalIds) {
      try {
        terminals.push(this.terminalController.killTerminalForClose(terminalId));
      } catch (error) {
        this.sessionLogger.warn(
          { err: error, terminalId, requestId: msg.requestId },
          "Failed to kill terminal during close_items batch",
        );
        terminals.push({
          terminalId,
          success: false,
        });
      }
    }

    this.emit({
      type: "close_items_response",
      payload: {
        agents,
        terminals,
        requestId: msg.requestId,
      },
    });
  }

  private async unarchiveAgentByHandle(handle: AgentPersistenceHandle): Promise<{
    record: StoredAgentRecord;
    didUnarchive: boolean;
    originalArchivedAt: string | null;
  } | null> {
    const records = await this.agentStorage.listByProviderSession(
      handle.provider,
      handle.sessionId,
    );
    const matched = records.reduce<StoredAgentRecord | null>((latest, candidate) => {
      if (!latest) {
        return candidate;
      }
      const updatedDelta =
        Date.parse(resolveStoredAgentUpdatedAt(candidate)) -
        Date.parse(resolveStoredAgentUpdatedAt(latest));
      if (updatedDelta !== 0) {
        return updatedDelta > 0 ? candidate : latest;
      }
      return Date.parse(candidate.createdAt) > Date.parse(latest.createdAt) ? candidate : latest;
    }, null);
    if (!matched) {
      return null;
    }
    const didUnarchive = await unarchiveAgentState(
      this.agentStorage,
      this.agentManager,
      matched.id,
    );
    return {
      record: matched,
      didUnarchive,
      originalArchivedAt: matched.archivedAt ?? null,
    };
  }

  private async handleUpdateAgentRequest(
    agentId: string,
    name: string | undefined,
    labels: Record<string, string> | undefined,
    requestId: string,
  ): Promise<void> {
    this.sessionLogger.info(
      {
        agentId,
        requestId,
        hasName: typeof name === "string",
        labelCount: labels ? Object.keys(labels).length : 0,
      },
      "session: update_agent_request",
    );

    try {
      const result = await updateAgentCommand(
        { agentManager: this.agentManager },
        { agentId, name, labels },
      );

      if (!result.accepted) {
        this.emit({
          type: "update_agent_response",
          payload: {
            requestId,
            agentId,
            accepted: false,
            error: result.error,
          },
        });
        return;
      }

      this.emit({
        type: "update_agent_response",
        payload: { requestId, agentId, accepted: true, error: null },
      });
    } catch (error) {
      this.sessionLogger.error(
        { err: error, agentId, requestId },
        "session: update_agent_request error",
      );
      this.emit({
        type: "activity_log",
        payload: {
          id: uuidv4(),
          timestamp: new Date(),
          type: "error",
          content: `Failed to update agent: ${getErrorMessage(error)}`,
        },
      });
      this.emit({
        type: "update_agent_response",
        payload: {
          requestId,
          agentId,
          accepted: false,
          error: getErrorMessageOr(error, "Failed to update agent"),
        },
      });
    }
  }

  private async handleProjectRenameRequest(
    projectId: string,
    customName: string | null,
    requestId: string,
  ): Promise<void> {
    this.sessionLogger.info(
      { projectId, requestId, hasCustomName: typeof customName === "string" },
      "session: project.rename.request",
    );

    try {
      const existing = await this.projectRegistry.get(projectId);
      if (!existing) {
        this.emit({
          type: "project.rename.response",
          payload: {
            requestId,
            projectId,
            accepted: false,
            customName: null,
            error: "Project not found",
          },
        });
        return;
      }

      const trimmed = customName?.trim() ?? "";
      const nextCustomName = trimmed.length === 0 ? null : trimmed;

      const updated = {
        ...existing,
        customName: nextCustomName,
        updatedAt: new Date().toISOString(),
      };
      await this.projectRegistry.upsert(updated);

      this.emit({
        type: "project.rename.response",
        payload: {
          requestId,
          projectId,
          accepted: true,
          customName: nextCustomName,
          error: null,
        },
      });

      // Emit a project.update so clients that track the project as an empty
      // project (no workspaces yet) receive the resolved name immediately.
      await this.emitProjectUpdate({ kind: "upsert", project: updated });

      // Re-emit descriptors for every workspace under this project so the new
      // resolved name lands in the UI immediately.
      const workspaces = await this.workspaceRegistry.listActive();
      const affectedWorkspaceIds = workspaces
        .filter((workspace) => workspace.projectId === existing.projectId)
        .map((workspace) => workspace.workspaceId);
      if (affectedWorkspaceIds.length > 0) {
        await this.emitWorkspaceUpdatesForWorkspaceIds(affectedWorkspaceIds);
      }
    } catch (error) {
      this.sessionLogger.error(
        { err: error, projectId, requestId },
        "session: project.rename.request error",
      );
      this.emit({
        type: "activity_log",
        payload: {
          id: uuidv4(),
          timestamp: new Date(),
          type: "error",
          content: `Failed to rename project: ${getErrorMessage(error)}`,
        },
      });
      this.emit({
        type: "project.rename.response",
        payload: {
          requestId,
          projectId,
          accepted: false,
          customName: null,
          error: getErrorMessageOr(error, "Failed to rename project"),
        },
      });
    }
  }

  private async handleProjectIconSetRequest(
    request: Extract<SessionInboundMessage, { type: "project.icon.set.request" }>,
  ): Promise<void> {
    const { projectId, requestId } = request;
    try {
      const updated = await setProjectCustomIcon({
        neolixHome: this.neolixHome,
        projectId,
        source: request.source,
        projects: this.projectRegistry,
      });

      this.emit({
        type: "project.icon.set.response",
        payload: { requestId, projectId, accepted: true, error: null },
      });
      await this.emitProjectUpdate({ kind: "upsert", project: updated });

      const affectedWorkspaceIds = (await this.workspaceRegistry.listActive())
        .filter((workspace) => workspace.projectId === projectId)
        .map((workspace) => workspace.workspaceId);
      if (affectedWorkspaceIds.length > 0) {
        await this.emitWorkspaceUpdatesForWorkspaceIds(affectedWorkspaceIds);
      }
    } catch (error) {
      this.emit({
        type: "project.icon.set.response",
        payload: {
          requestId,
          projectId,
          accepted: false,
          error: getErrorMessageOr(error, "Failed to update project icon"),
        },
      });
    }
  }

  private async handleProjectIconGetRequest(projectId: string, requestId: string): Promise<void> {
    try {
      const project = await this.projectRegistry.get(projectId);
      if (!project) throw new Error("Project not found");

      const icon = await this.projectIcons.read(project);
      this.emit({
        type: "project.icon.get.response",
        payload: { projectId, icon, error: null, requestId },
      });
    } catch (error) {
      this.emit({
        type: "project.icon.get.response",
        payload: { projectId, icon: null, error: getErrorMessage(error), requestId },
      });
    }
  }

  private async handleProjectRemoveRequest(
    request: Extract<SessionInboundMessage, { type: "project.remove.request" }>,
  ): Promise<void> {
    const { projectId, requestId } = request;
    this.sessionLogger.info({ projectId, requestId }, "session: project.remove.request");

    try {
      const project = await this.projectRegistry.get(projectId);
      const resolvedProjectId = project?.projectId ?? projectId;
      const projectWorkspaces = (await this.workspaceRegistry.listActive()).filter(
        (workspace) => workspace.projectId === resolvedProjectId,
      );
      const activeWorkspaceIds = projectWorkspaces
        .filter((workspace) => !workspace.archivedAt)
        .map((workspace) => workspace.workspaceId);

      if (activeWorkspaceIds.length > 0) {
        this.markWorkspaceArchiving(activeWorkspaceIds, new Date().toISOString());
        await this.emitWorkspaceUpdatesForWorkspaceIds(activeWorkspaceIds);
      }

      const removedWorkspaceIds: string[] = [];
      try {
        for (const workspaceId of activeWorkspaceIds) {
          await archiveWorkspaceContents(
            {
              agentManager: this.agentManager,
              agentStorage: this.agentStorage,
              killTerminalsForWorkspace: (id) =>
                this.terminalController.killTerminalsForWorkspace(id),
              sessionLogger: this.sessionLogger,
            },
            workspaceId,
          );
          await this.archiveWorkspaceRecord(workspaceId);
          removedWorkspaceIds.push(workspaceId);
        }

        await this.projectRegistry.remove(resolvedProjectId);
        await removeProjectCustomIcon({
          neolixHome: this.neolixHome,
          projectId: resolvedProjectId,
        }).catch((error) => {
          this.sessionLogger.warn(
            { err: error, projectId: resolvedProjectId },
            "Failed to clean up removed project icon",
          );
        });
      } finally {
        if (activeWorkspaceIds.length > 0) {
          this.clearWorkspaceArchiving(activeWorkspaceIds);
        }
      }

      const updateIds =
        removedWorkspaceIds.length > 0
          ? removedWorkspaceIds
          : [projectWorkspaces[0]?.workspaceId ?? projectId];
      await this.emitWorkspaceUpdatesForWorkspaceIds(updateIds, {
        removedProjectId: projectId,
      });

      this.emit({
        type: "project.remove.response",
        payload: {
          requestId,
          projectId,
          accepted: true,
          removedWorkspaceIds,
          error: null,
        },
      });
    } catch (error) {
      this.sessionLogger.error(
        { err: error, projectId, requestId },
        "session: project.remove.request error",
      );
      this.emit({
        type: "activity_log",
        payload: {
          id: uuidv4(),
          timestamp: new Date(),
          type: "error",
          content: `Failed to remove project: ${getErrorMessage(error)}`,
        },
      });
      this.emit({
        type: "project.remove.response",
        payload: {
          requestId,
          projectId,
          accepted: false,
          removedWorkspaceIds: [],
          error: getErrorMessageOr(error, "Failed to remove project"),
        },
      });
    }
  }

  private async handleWorkspaceTitleSetRequest(
    workspaceId: string,
    title: string | null,
    requestId: string,
  ): Promise<void> {
    this.sessionLogger.info(
      { workspaceId, requestId, hasTitle: typeof title === "string" },
      "session: workspace.title.set.request",
    );

    try {
      const trimmed = title?.trim() ?? "";
      const nextTitle = trimmed.length === 0 ? null : trimmed;
      const updatedAt = new Date().toISOString();
      const updated = await this.workspaceRegistry.update(workspaceId, (existing) => ({
        ...existing,
        title: nextTitle,
        updatedAt,
      }));
      if (!updated) {
        this.emit({
          type: "workspace.title.set.response",
          payload: {
            requestId,
            workspaceId,
            accepted: false,
            title: null,
            error: "Workspace not found",
          },
        });
        return;
      }

      this.emit({
        type: "workspace.title.set.response",
        payload: {
          requestId,
          workspaceId,
          accepted: true,
          title: nextTitle,
          error: null,
        },
      });

      await this.emitWorkspaceUpdatesForWorkspaceIds([workspaceId]);
    } catch (error) {
      this.sessionLogger.error(
        { err: error, workspaceId, requestId },
        "session: workspace.title.set.request error",
      );
      this.emit({
        type: "activity_log",
        payload: {
          id: uuidv4(),
          timestamp: new Date(),
          type: "error",
          content: `Failed to set workspace title: ${getErrorMessage(error)}`,
        },
      });
      this.emit({
        type: "workspace.title.set.response",
        payload: {
          requestId,
          workspaceId,
          accepted: false,
          title: null,
          error: getErrorMessageOr(error, "Failed to set workspace title"),
        },
      });
    }
  }

  private async handleWorkspacePinSetRequest(
    workspaceId: string,
    pinned: boolean,
    requestId: string,
  ): Promise<void> {
    const logContext = { workspaceId, pinned, requestId };
    this.sessionLogger.info(logContext, "session: workspace.pin.set.request");
    const emitResponse = (accepted: boolean, pinnedAt: string | null, error: string | null) => {
      this.emit({
        type: "workspace.pin.set.response",
        payload: { requestId, workspaceId, accepted, pinnedAt, error },
      });
    };

    try {
      const nextPinnedAt = pinned ? new Date().toISOString() : null;
      const updatedAt = new Date().toISOString();
      const updated = await this.workspaceRegistry.update(workspaceId, (existing) => ({
        ...existing,
        pinnedAt: nextPinnedAt,
        updatedAt,
      }));
      if (!updated) {
        emitResponse(false, null, "Workspace not found");
        return;
      }
      emitResponse(true, nextPinnedAt, null);
      await this.emitWorkspaceUpdatesForWorkspaceIds([workspaceId]);
    } catch (error) {
      this.sessionLogger.error(
        { ...logContext, err: error },
        "session: workspace.pin.set.request error",
      );
      this.emit({
        type: "activity_log",
        payload: {
          id: uuidv4(),
          timestamp: new Date(),
          type: "error",
          content: `Failed to pin workspace: ${getErrorMessage(error)}`,
        },
      });
      emitResponse(false, null, getErrorMessageOr(error, "Failed to pin workspace"));
    }
  }

  private async handleWorkspaceRecoveryInspectRequest(
    request: Extract<SessionInboundMessage, { type: "workspace.recovery.inspect.request" }>,
  ): Promise<void> {
    const state = await this.workspaceRecovery.inspect(request.workspaceId);
    this.emit({
      type: "workspace.recovery.inspect.response",
      payload: {
        requestId: request.requestId,
        state,
      },
    });
  }

  private async handleWorkspaceRecoveryRestoreRequest(
    request: Extract<SessionInboundMessage, { type: "workspace.recovery.restore.request" }>,
  ): Promise<void> {
    try {
      await this.restoreWorkspaceAndEmit(request.workspaceId);
      this.emit({
        type: "workspace.recovery.restore.response",
        payload: {
          requestId: request.requestId,
          workspaceId: request.workspaceId,
          accepted: true,
          error: null,
        },
      });
    } catch (error) {
      const message = getErrorMessageOr(error, "Failed to recover workspace");
      this.sessionLogger.warn(
        { err: error, workspaceId: request.workspaceId, requestId: request.requestId },
        "session: workspace.recovery.restore.request rejected",
      );
      this.emit({
        type: "workspace.recovery.restore.response",
        payload: {
          requestId: request.requestId,
          workspaceId: request.workspaceId,
          accepted: false,
          error: message,
        },
      });
    }
  }

  /**
   * Handle text message to agent (with optional image attachments)
   */
  private async handleSendAgentMessage(
    agentId: string,
    text: string,
    messageId?: string,
    images?: Array<{ data: string; mimeType: string }>,
    attachments?: AgentAttachment[],
    runOptions?: AgentRunOptions,
    options?: { spokenInput?: boolean },
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    this.sessionLogger.info(
      {
        agentId,
        textPreview: text.substring(0, 50),
        imageCount: images?.length ?? 0,
        attachmentCount: attachments?.length ?? 0,
      },
      `Sending text to agent ${agentId}${
        images && images.length > 0 ? ` with ${images.length} image attachment(s)` : ""
      }${
        attachments && attachments.length > 0
          ? ` and ${attachments.length} structured attachment(s)`
          : ""
      }`,
    );

    const promptText = options?.spokenInput ? wrapSpokenInput(text) : text;
    const prompt = buildAgentPrompt(promptText, images, attachments);

    try {
      await sendPromptToAgent({
        agentManager: this.agentManager,
        agentStorage: this.agentStorage,
        agentId,
        prompt,
        messageId,
        runOptions,
        // A typed or spoken message from the human answers any permission the
        // agent is blocked on.
        clearPendingPermissions: true,
        logger: this.sessionLogger,
      });
      return { ok: true };
    } catch (error) {
      this.handleAgentRunError(agentId, error, "Failed to send agent message");
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Handle create agent request
   */
  private creationUpdate(snapshot: CreationSnapshot): SessionOutboundMessage {
    return {
      type: snapshot.kind === "workspace" ? "workspace.create.update" : "agent.create.update",
      payload: snapshot,
    };
  }

  private async handleCreationSubscription(
    request: Extract<SessionInboundMessage, { type: "creation.subscribe.request" }>,
    source?: object,
  ): Promise<void> {
    let unsubscribe = () => {};
    const owner =
      request.subscribe === false
        ? undefined
        : this.delivery.begin(
            "creation",
            undefined,
            () => unsubscribe(),
            JSON.stringify([request.kind, request.idempotencyKey]),
          );
    try {
      const observation = await this.creationService.subscribe(
        request.kind,
        request.idempotencyKey,
        (snapshot) => owner?.emit(this.creationUpdate(snapshot)),
      );
      unsubscribe = observation.unsubscribe;
      if (!owner || owner.signal.aborted) unsubscribe();
      this.emitForSource(
        {
          type: "creation.subscribe.response",
          payload: {
            requestId: request.requestId,
            subscriptionId: owner?.responseId,
            snapshot: observation.snapshot,
            error: null,
          },
        },
        source,
      );
    } catch (error) {
      await owner?.release();
      this.emitForSource(
        {
          type: "creation.subscribe.response",
          payload: {
            requestId: request.requestId,
            snapshot: null,
            error: error instanceof Error ? error.message : String(error),
          },
        },
        source,
      );
    }
  }

  private creationResourceExists = async (
    kind: "workspace" | "agent",
    id: string,
  ): Promise<boolean> =>
    kind === "workspace"
      ? (await this.workspaceRegistry.get(id)) !== null
      : this.agentManager.getAgent(id) != null || (await this.agentStorage.get(id)) !== null;

  private createRequestedAgent(
    request: AgentCreateRequest,
    observer?: (snapshot: CreationSnapshot) => void,
  ): Promise<CreationSnapshot> {
    const { requestId, type: _type, subscribe: _subscribe, idempotencyKey, ...intent } = request;
    return this.creationService.create(
      {
        kind: "agent",
        key: idempotencyKey ?? requestId,
        request: intent,
        workspaceId: request.workspaceId,
        agentId: request.agentId,
        hasAgent: true,
        hasPrompt: hasInitialCreationPrompt(request),
        exists: this.creationResourceExists,
        readAgent: async (id) => {
          const record = await this.agentStorage.get(id);
          return record ? this.buildStoredAgentPayload(record) : null;
        },
        createAgent: async (id, _workspace, onReady) => {
          try {
            return await this.createSessionAgent(
              { ...request, type: "create_agent_request" },
              id,
              onReady,
            );
          } catch (error) {
            throw new WorktreeRequestError(toWorktreeWireError(error));
          }
        },
      },
      observer,
    );
  }

  private async handleAgentCreation(request: AgentCreateRequest, source?: object): Promise<void> {
    const { requestId, subscribe } = request;
    const progress = subscribe
      ? this.delivery.operation(
          (message) =>
            message.type === "workspace.create.update" || message.type === "agent.create.update",
          () => {},
        )
      : undefined;
    try {
      const creation = await this.createRequestedAgent(
        request,
        progress ? (snapshot) => progress.emit(this.creationUpdate(snapshot)) : undefined,
      );
      this.emitForSource(
        {
          type: "agent.create.response",
          payload: { requestId, agent: creation.agent ?? null, error: creation.error, creation },
        },
        source,
      );
    } catch (error) {
      this.emitForSource(
        {
          type: "agent.create.response",
          payload: {
            requestId,
            agent: null,
            error: error instanceof Error ? error.message : String(error),
          },
        },
        source,
      );
    } finally {
      await progress?.release();
    }
  }

  private async handleWorkspaceCreation(
    request: Extract<SessionInboundMessage, { type: "workspace.create.request" }>,
    source?: object,
  ): Promise<void> {
    const { requestId, subscribe, type: _type, idempotencyKey, ...intent } = request;
    const progress = subscribe
      ? this.delivery.operation(
          (message) =>
            message.type === "workspace.create.update" || message.type === "agent.create.update",
          () => {},
        )
      : undefined;
    try {
      if (
        request.agent &&
        !this.authorization.allowsPermission("workspace.write") &&
        !this.authorization.allowsPermission("hub.execute")
      ) {
        throw new Error("Session is not authorized to create an agent");
      }
      const agentInput = request.agent;
      const creation = await this.creationService.create(
        {
          kind: "workspace",
          key: idempotencyKey ?? requestId,
          request: intent,
          workspaceId: request.workspaceId,
          agentId: agentInput?.agentId,
          hasAgent: Boolean(agentInput),
          hasPrompt: hasInitialCreationPrompt(agentInput),
          exists: this.creationResourceExists,
          provision: async (id) => {
            const descriptor = await this.createRequestedWorkspace(
              {
                ...request,
                firstAgentContext: agentInput
                  ? { prompt: agentInput.initialPrompt, attachments: agentInput.attachments }
                  : request.firstAgentContext,
              },
              id,
            );
            const workspace = await this.workspaceRegistry.get(descriptor.id);
            return {
              workspace: descriptor,
              setupSkippedReason: workspace?.untrustedSource
                ? formatWorkspaceAutomationBlockedMessage(workspace.untrustedSource)
                : undefined,
            };
          },
          createAgent: agentInput
            ? async (id, workspace, onReady) => {
                if (!workspace?.workspaceDirectory)
                  throw new Error("Created workspace has no directory");
                const sourceCwd =
                  request.source.kind === "directory"
                    ? request.source.path
                    : await resolveWorktreeSourceCwd(request.source, this.projectRegistry);
                const relativeCwd = relative(resolve(sourceCwd), resolve(agentInput.config.cwd));
                if (
                  relativeCwd === ".." ||
                  relativeCwd.startsWith(`..${sep}`) ||
                  isAbsolute(relativeCwd)
                )
                  throw new Error("Agent directory must be inside the workspace source");
                return this.createSessionAgent(
                  {
                    ...agentInput,
                    type: "create_agent_request",
                    requestId,
                    config: {
                      ...agentInput.config,
                      cwd: resolve(workspace.workspaceDirectory, relativeCwd),
                    },
                    workspaceId: workspace.id,
                  },
                  id,
                  onReady,
                );
              }
            : undefined,
        },
        progress ? (snapshot) => progress.emit(this.creationUpdate(snapshot)) : undefined,
      );
      this.emitForSource(
        {
          type: "workspace.create.response",
          payload: {
            requestId,
            workspace: creation.workspace ?? null,
            agent: creation.agent,
            creation,
            setupSkippedReason: creation.setupSkippedReason,
            error: creation.error,
            errorCode: creation.errorCode,
            setupTerminalId: null,
          },
        },
        source,
      );
    } catch (error) {
      this.emitForSource(
        {
          type: "workspace.create.response",
          payload: {
            requestId,
            workspace: null,
            error: error instanceof Error ? error.message : String(error),
            errorCode:
              error instanceof Error && "code" in error && typeof error.code === "string"
                ? error.code
                : undefined,
            setupTerminalId: null,
          },
        },
        source,
      );
    } finally {
      await progress?.release();
    }
  }

  private async handleCreateAgentRequest(msg: CreateAgentRequestMessage): Promise<void> {
    try {
      let agent: AgentSnapshotPayload;
      if (msg.idempotencyKey !== undefined) {
        if (msg.initialPrompt !== undefined) {
          throw new Error("Idempotent creation requires sending the initial prompt separately");
        }
        const creation = await this.createRequestedAgent({ ...msg, type: "agent.create.request" });
        if (creation.error || !creation.agent)
          throw new SessionRequestError(
            creation.errorCode ?? "unknown",
            creation.error ?? "Agent creation failed",
          );
        const record = await this.agentStorage.get(creation.agent.id);
        if (!record) throw new Error("Previously created agent no longer exists");
        agent = this.buildStoredAgentPayload(record);
      } else {
        ({ agent } = await this.createSessionAgent(msg));
      }
      this.emit({
        type: "status",
        payload: {
          status: "agent_created",
          agentId: agent.id,
          requestId: msg.requestId,
          agent,
        },
      });
    } catch (error) {
      const wireError = error instanceof SessionRequestError ? error : toWorktreeWireError(error);
      this.sessionLogger.error({ err: error }, "Failed to create agent");
      this.emit({
        type: "status",
        payload: {
          status: "agent_create_failed",
          requestId: msg.requestId,
          error: wireError.message,
          errorCode: wireError.code,
        },
      });
      this.emit({
        type: "activity_log",
        payload: {
          id: uuidv4(),
          timestamp: new Date(),
          type: "error",
          content: `Failed to create agent: ${wireError.message}`,
        },
      });
    }
  }

  private validatePublicAgentWorkspaceIntent(request: CreateAgentRequestMessage): void {
    if (request.git !== undefined || request.worktreeName !== undefined) {
      throw new Error(
        "Legacy git/worktreeName agent placement was removed. Use createWorkspace({ source, agent, idempotencyKey }) to create a workspace with an agent, or create the workspace first and pass workspaceId.",
      );
    }
    if (request.internal)
      throw new Error(
        "Public internal agents were removed; create a background workspace instead.",
      );
  }

  private async createSessionAgent(
    msg: CreateAgentRequestMessage,
    agentId?: string,
    onAgentReady?: (agent: AgentSnapshotPayload) => Promise<void>,
  ): Promise<CreatedAgent> {
    const {
      config,
      worktreeName,
      initialPrompt,
      clientMessageId,
      outputSchema,
      worktree,
      autoArchive,
      images,
      attachments,
      env,
    } = msg;
    this.sessionLogger.info(
      { cwd: config.cwd, provider: config.provider, worktreeName },
      `Creating agent in ${config.cwd} (${config.provider})${
        worktreeName ? ` with worktree ${worktreeName}` : ""
      }`,
    );

    let createdWorktreeForCleanup: CreateNeolixWorktreeWorkflowResult | null = null;
    let createdAgentId: string | null = null;
    try {
      const requestedCwd = resolve(config.cwd);
      const needsRequestedDirectory = Boolean(worktree) || (!msg.workspaceId && !msg.callerAgentId);
      if (needsRequestedDirectory && !(await this.filesystem.isDirectory(requestedCwd))) {
        throw new Error(`Working directory does not exist or is not a directory: ${requestedCwd}`);
      }
      this.validatePublicAgentWorkspaceIntent(msg);
      const trimmedPrompt = initialPrompt?.trim();
      const { provisionalTitle } = resolveCreateAgentTitles({
        configTitle: config.title,
        initialPrompt: trimmedPrompt,
      });

      const firstAgentContext: FirstAgentContext = {
        ...(trimmedPrompt ? { prompt: trimmedPrompt } : {}),
        ...(attachments && attachments.length > 0 ? { attachments } : {}),
      };
      const workspacePromptTitle = resolveFirstAgentPromptTitle(firstAgentContext);
      const createdWorktree = await this.createAgentLifecycleDispatch.createWorktreeForRequest({
        cwd: config.cwd,
        target: worktree,
        firstAgentContext,
        ...(await this.workspaceBackgroundIntent(msg.background, msg.callerAgentId)),
      });
      createdWorktreeForCleanup = createdWorktree;
      const resolvedIntent = await this.resolveSessionCreateAgentIntent({
        request: msg,
        createdWorktree,
        workspacePromptTitle,
      });
      const resolvedCwd = resolve(resolvedIntent.config.cwd);
      if (!(await this.filesystem.isDirectory(resolvedCwd))) {
        throw new Error(`Working directory does not exist or is not a directory: ${resolvedCwd}`);
      }

      const { snapshot, liveSnapshot, initialPromptStarted } = await createAgentCommand(
        {
          agentManager: this.agentManager,
          agentStorage: this.agentStorage,
          logger: this.sessionLogger,
          neolixHome: this.neolixHome,
          worktreesRoot: this.worktreesRoot,
          providerSnapshotManager: this.providerSnapshotManager,
        },
        {
          kind: "session",
          onAgentReady: async (agent) => {
            createdAgentId = agent.id;
            await onAgentReady?.(await this.buildAgentPayload(agent));
          },
          agentId,
          config: resolvedIntent.config,
          workspaceId: resolvedIntent.intent.workspaceId,
          background: resolvedIntent.background,
          initialPrompt,
          source: msg.callerAgentId
            ? { kind: "agent-message", agentId: msg.callerAgentId }
            : undefined,
          clientMessageId,
          outputSchema,
          images,
          attachments,
          labels: resolvedIntent.intent.labels,
          env,
          provisionalTitle,
          firstAgentContext,
        },
      );
      createdAgentId = snapshot.id;
      // `snapshot` predates the initial prompt; subscribers keep the last state they receive.
      await this.agentUpdates.forwardLiveAgent(
        this.agentManager.getAgent(snapshot.id) ?? liveSnapshot,
      );
      if (resolvedIntent.createdDirectoryWorkspace && trimmedPrompt) {
        this.workspaceAutoName.scheduleForDirectory(
          {
            workspaceId: resolvedIntent.intent.workspaceId,
            cwd: resolvedIntent.config.cwd,
            firstAgentContext,
          },
          { currentSelection: this.getFocusedAgentSelectionForCwd(resolvedIntent.config.cwd) },
        );
      }
      this.createAgentLifecycleDispatch.registerAutoArchiveIfRequested({
        autoArchive,
        agentId: snapshot.id,
        createdWorktree,
      });
      this.sessionLogger.info(
        { agentId: snapshot.id, provider: snapshot.provider },
        "Created agent",
      );
      return { agent: await this.buildAgentPayload(liveSnapshot), initialPromptStarted };
    } catch (error) {
      await this.createAgentLifecycleDispatch.cleanupCreatedWorktreeAfterFailedAgentCreate({
        createdWorktree: createdWorktreeForCleanup,
        createdAgentId,
      });
      throw error;
    }
  }

  private async resolveSessionCreateAgentIntent(input: {
    request: CreateAgentRequestMessage;
    createdWorktree: CreateNeolixWorktreeWorkflowResult | null;
    workspacePromptTitle: string | null;
  }): Promise<ResolvedSessionCreateAgentIntent> {
    const { request, createdWorktree } = input;
    const callerAgent = await this.resolveCreationCaller(request.callerAgentId);

    let config = request.config;

    const intent = await resolveCreateAgentIntent({
      explicitWorkspaceId: createdWorktree?.workspace.workspaceId ?? request.workspaceId,
      caller: callerAgent,
      labels: request.labels,
      resolveWorkspace: async (workspaceId) => {
        if (createdWorktree?.workspace.workspaceId === workspaceId) {
          return { workspaceId, cwd: createdWorktree.workspace.cwd };
        }
        const workspace = await this.workspaceRegistry.get(workspaceId);
        if (!workspace || workspace.archivedAt) {
          throw new Error(`Workspace ${workspaceId} not found`);
        }
        return { workspaceId, cwd: workspace.cwd };
      },
      createWorkspace: async () => ({
        workspaceId: await this.workspaceProvisioning.resolveOrCreateWorkspaceIdForCreateAgent({
          createdWorktree: null,
          cwd: config.cwd,
          initialTitle: input.workspacePromptTitle,
          background: inheritWorkspaceBackground(request.background, callerAgent),
          callerWorkspaceId: callerAgent?.workspaceId,
        }),
        cwd: config.cwd,
      }),
    });
    config = { ...config, cwd: intent.cwd };

    return {
      config,
      intent,
      background: inheritAgentBackground(request.background, callerAgent),
      createdDirectoryWorkspace: !createdWorktree && !request.workspaceId && !callerAgent,
    };
  }

  private async handleResumeAgentRequest(
    msg: Extract<SessionInboundMessage, { type: "resume_agent_request" }>,
  ): Promise<void> {
    const { handle, overrides, requestId } = msg;
    if (!handle) {
      this.sessionLogger.warn("Resume request missing persistence handle");
      if (requestId) {
        this.emit({
          type: "rpc_error",
          payload: {
            requestId,
            requestType: msg.type,
            error: "Unable to resume agent: missing persistence handle",
            code: "agent_resume_failed",
          },
        });
      }
      this.emit({
        type: "activity_log",
        payload: {
          id: uuidv4(),
          timestamp: new Date(),
          type: "error",
          content: "Unable to resume agent: missing persistence handle",
        },
      });
      return;
    }
    this.sessionLogger.info(
      { sessionId: handle.sessionId, provider: handle.provider },
      `Resuming agent ${handle.sessionId} (${handle.provider})`,
    );
    try {
      const matched = await this.unarchiveAgentByHandle(handle);
      const effectiveOverrides = matched
        ? { ...buildConfigOverrides(matched.record), ...overrides }
        : overrides;
      let snapshot: ManagedAgent;
      try {
        snapshot = await this.agentManager.resumeAgentFromPersistence(handle, effectiveOverrides);
      } catch (error) {
        if (matched?.didUnarchive && matched.originalArchivedAt) {
          await this.agentManager.archiveSnapshot(matched.record.id, matched.originalArchivedAt);
        }
        throw error;
      }
      await unarchiveAgentState(this.agentStorage, this.agentManager, snapshot.id);
      await this.agentManager.hydrateTimelineFromProvider(snapshot.id);
      await this.agentUpdates.forwardLiveAgent(snapshot);
      const timelineSize = this.agentManager.getTimeline(snapshot.id).length;
      if (requestId) {
        const agentPayload = await this.buildAgentPayload(snapshot);
        this.emit({
          type: "status",
          payload: {
            status: "agent_resumed",
            agentId: snapshot.id,
            requestId,
            timelineSize,
            agent: agentPayload,
          },
        });
      }
    } catch (error) {
      const message = getErrorMessage(error);
      this.sessionLogger.error({ err: error }, "Failed to resume agent");
      if (requestId) {
        this.emit({
          type: "rpc_error",
          payload: {
            requestId,
            requestType: msg.type,
            error: message,
            code: "agent_resume_failed",
          },
        });
      }
      this.emit({
        type: "activity_log",
        payload: {
          id: uuidv4(),
          timestamp: new Date(),
          type: "error",
          content: `Failed to resume agent: ${message}`,
        },
      });
    }
  }

  private async handleImportAgentRequest(
    msg: Extract<SessionInboundMessage, { type: "import_agent_request" }>,
  ): Promise<void> {
    const normalized = normalizeImportAgentRequest(msg);
    if ("error" in normalized) {
      this.emit({
        type: "status",
        payload: {
          status: "agent_create_failed",
          requestId: msg.requestId,
          error: normalized.error,
        },
      });
      return;
    }
    const { provider, providerHandleId, requestId } = normalized;
    this.sessionLogger.info(
      { providerHandleId, provider },
      `Importing agent ${providerHandleId} (${provider})`,
    );

    try {
      if (!normalized.cwd) {
        throw new Error("Import requires cwd from the selected provider session");
      }
      const { snapshot, timelineSize, createdWorkspace } = await importProviderSession({
        request: normalized,
        workspaceProvisioning: this.workspaceProvisioning,
        agentManager: this.agentManager,
        agentStorage: this.agentStorage,
        logger: this.sessionLogger,
      });
      if (createdWorkspace) {
        await this.registerWorkspaceForImportedAgent(createdWorkspace);
      }
      const agentPayload = await this.buildAgentPayload(snapshot);
      this.emit({
        type: "status",
        payload: {
          status: "agent_resumed",
          agentId: snapshot.id,
          requestId,
          timelineSize,
          agent: agentPayload,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.sessionLogger.error({ err: error }, "Failed to import agent");
      this.emit({
        type: "status",
        payload: {
          status: "agent_create_failed",
          requestId,
          error: message,
        },
      });
      this.emit({
        type: "activity_log",
        payload: {
          id: uuidv4(),
          timestamp: new Date(),
          type: "error",
          content: `Failed to import agent: ${message}`,
        },
      });
    }
  }

  private async handleRefreshAgentRequest(
    msg: Extract<SessionInboundMessage, { type: "refresh_agent_request" }>,
  ): Promise<void> {
    const { agentId, requestId } = msg;
    this.sessionLogger.info({ agentId }, `Refreshing agent ${agentId} from persistence`);

    try {
      await this.restoreOwningWorkspaceForLegacyAgentRefresh(agentId);
      await unarchiveAgentState(this.agentStorage, this.agentManager, agentId);
      let snapshot: ManagedAgent;
      const existing = this.agentManager.getAgent(agentId);
      if (existing) {
        await this.interruptAgentIfRunning(agentId);
        snapshot = await this.agentManager.reloadAgentSession(agentId, undefined, {
          rehydrateFromDisk: true,
        });
      } else {
        const record = await this.agentStorage.get(agentId);
        if (!record) {
          throw new Error(`Agent not found: ${agentId}`);
        }
        const registeredProviderIds = this.providerSnapshotManager.listRegisteredProviderIds();
        if (!isStoredAgentProviderAvailable(record, registeredProviderIds)) {
          throw new Error(`Agent ${agentId} references unavailable provider '${record.provider}'`);
        }
        if (!toAgentPersistenceHandle(registeredProviderIds, record.persistence)) {
          throw new Error(`Agent ${agentId} cannot be refreshed because it lacks persistence`);
        }
        // Share the loader's per-agent in-flight operation with timeline fetches.
        // Unarchiving publishes the record before provider resume finishes, so
        // the agent pane can otherwise race this request and resume it twice.
        snapshot = await ensureAgentLoaded(agentId, {
          agentManager: this.agentManager,
          agentStorage: this.agentStorage,
          broadcastTimeline: true,
          logger: this.sessionLogger,
        });
      }
      await this.agentManager.hydrateTimelineFromProvider(agentId, { broadcast: true });
      await this.agentUpdates.forwardLiveAgent(snapshot);
      const timelineSize = this.agentManager.getTimeline(agentId).length;
      if (requestId) {
        this.emit({
          type: "status",
          payload: {
            status: "agent_refreshed",
            agentId,
            requestId,
            timelineSize,
          },
        });
      }
    } catch (error) {
      const message = getErrorMessage(error);
      this.sessionLogger.error({ err: error, agentId }, `Failed to refresh agent ${agentId}`);
      if (requestId) {
        this.emit({
          type: "rpc_error",
          payload: {
            requestId,
            requestType: msg.type,
            error: message,
            code: error instanceof WorktreeRequestError ? error.code : "agent_refresh_failed",
          },
        });
      }
      this.emit({
        type: "activity_log",
        payload: {
          id: uuidv4(),
          timestamp: new Date(),
          type: "error",
          content: `Failed to refresh agent: ${message}`,
        },
      });
    }
  }

  private async handleStopAgentTaskRequest(
    agentId: string,
    taskId: string,
    requestId: string,
  ): Promise<void> {
    try {
      await this.agentManager.stopAgentTask(agentId, taskId);
      this.emit({
        type: "stop_agent_task_response",
        payload: { requestId, agentId, taskId, error: null },
      });
    } catch (error) {
      this.sessionLogger.error(
        { err: error, agentId, taskId },
        "Failed to stop a background task on request",
      );
      this.emit({
        type: "stop_agent_task_response",
        payload: { requestId, agentId, taskId, error: errorToFriendlyMessage(error) },
      });
    }
  }

  private async handleCancelAgentRequest(agentId: string, requestId?: string): Promise<void> {
    this.sessionLogger.info({ agentId }, `Cancel request received for agent ${agentId}`);

    try {
      await cancelAgentRunCommand(
        { agentManager: this.agentManager, logger: this.sessionLogger },
        agentId,
      );
      if (requestId) {
        const agent = this.agentManager.getAgent(agentId);
        const payload = agent ? await this.buildAgentPayload(agent) : null;
        this.emit({
          type: "cancel_agent_response",
          payload: {
            requestId,
            agentId,
            agent: payload,
            error: null,
          },
        });
      }
    } catch (error) {
      if (requestId) {
        this.sessionLogger.error(
          { err: error, agentId },
          `Failed to cancel running agent on request for agent ${agentId}`,
        );
        const agent = this.agentManager.getAgent(agentId);
        const payload = agent ? await this.buildAgentPayload(agent) : null;
        this.emit({
          type: "cancel_agent_response",
          payload: {
            requestId,
            agentId,
            agent: payload,
            error: errorToFriendlyMessage(error),
          },
        });
      } else {
        this.handleAgentRunError(agentId, error, "Failed to cancel running agent on request");
      }
    }
  }

  private async handleAgentRewindRequest(
    msg: Extract<SessionInboundMessage, { type: "agent.rewind.request" }>,
    source?: object,
  ): Promise<void> {
    try {
      this.rewindInitiators.set(msg.agentId, source);
      await this.agentManager.rewind(msg.agentId, msg.messageId, msg.mode);
      this.emitForSource(
        {
          type: "agent.rewind.response",
          payload: {
            requestId: msg.requestId,
            agentId: msg.agentId,
            ok: true,
            error: null,
          },
        },
        source,
      );
    } catch (error) {
      this.emitForSource(
        {
          type: "agent.rewind.response",
          payload: {
            requestId: msg.requestId,
            agentId: msg.agentId,
            ok: false,
            error: error instanceof Error ? error.message : "Failed to rewind agent",
          },
        },
        source,
      );
    } finally {
      this.rewindInitiators.delete(msg.agentId);
    }
  }

  private deliverTimelineReplacement(agentId: string, initiatingSource?: object): void {
    const agent = this.agentManager.getAgent(agentId);
    if (!agent) return;
    const timeline = this.agentManager.fetchTimeline(agentId, { limit: 0 });
    const epoch = timeline.epoch;

    if (this.clientSources.size === 0 || !this.onMessageToSource) {
      if (!this.supports(CLIENT_CAPS.timelineReplacementInvalidation)) {
        this.emitReconstructedTimelineRows(agentId, agent.provider, timeline.rows, epoch);
      }
      return;
    }

    for (const subscription of this.timelineSubscriptions.values()) {
      const source = subscription.owner.source;
      if (!subscription.agentIds.has(agentId)) continue;
      const modern = this.delivery.isModern(source);
      if (
        modern ||
        (source !== initiatingSource &&
          this.supportsForSource(CLIENT_CAPS.timelineReplacementInvalidation, source))
      ) {
        subscription.owner.emit({
          type: "agent.timeline.replacement",
          payload: { agentId, epoch },
        });
      }
    }
    // COMPAT(timelineReplacementInvalidation): added in v0.5.0, remove reconstructed replay after 2027-02-21.
    for (const [source, { capabilities }] of this.clientSources) {
      if (
        !this.delivery.isModern(source) &&
        !capabilities.has(CLIENT_CAPS.timelineReplacementInvalidation)
      ) {
        this.emitReconstructedTimelineRows(agentId, agent.provider, timeline.rows, epoch, source);
      }
    }
  }

  private emitReconstructedTimelineRows(
    agentId: string,
    provider: ManagedAgent["provider"],
    rows: AgentTimelineFetchResult["rows"],
    epoch: string,
    source?: object,
  ): void {
    for (const row of rows) {
      if (!this.supportsTimelineItem(row.item, source)) {
        continue;
      }
      const event = serializeAgentStreamEvent({
        type: "timeline",
        provider,
        item: row.item,
        ...(row.turnId ? { turnId: row.turnId } : {}),
        timestamp: row.timestamp,
      });
      if (!event) continue;
      this.emitForSource(
        {
          type: "agent_stream",
          payload: { agentId, event, timestamp: row.timestamp, seq: row.seq, epoch },
        },
        source,
      );
    }
  }

  private isPathWithinRoot(rootPath: string, candidatePath: string): boolean {
    const resolvedRoot = resolve(rootPath);
    const resolvedCandidate = resolve(candidatePath);
    if (resolvedCandidate === resolvedRoot) {
      return true;
    }
    return resolvedCandidate.startsWith(resolvedRoot + sep);
  }

  /**
   * Handle clearing agent attention flag
   */
  private async handleClearAgentAttention(
    agentId: string | string[],
    requestId?: string,
  ): Promise<void> {
    const agentIds = Array.isArray(agentId) ? agentId : [agentId];

    try {
      await Promise.all(
        agentIds.map((id) =>
          ensureAgentLoaded(id, {
            agentManager: this.agentManager,
            agentStorage: this.agentStorage,
            logger: this.sessionLogger,
          }),
        ),
      );
      await Promise.all(agentIds.map((id) => this.agentManager.clearAgentAttention(id)));
      if (requestId) {
        const agents = (
          await Promise.all(
            agentIds.map(async (id) => {
              const agent = this.agentManager.getAgent(id);
              return agent ? this.buildAgentPayload(agent) : null;
            }),
          )
        ).filter((payload): payload is NonNullable<typeof payload> => payload !== null);
        this.emit({
          type: "clear_agent_attention_response",
          payload: {
            requestId,
            agentId,
            agents,
          },
        });
      }
    } catch (error) {
      this.sessionLogger.error({ err: error, agentIds }, "Failed to clear agent attention");
      // Don't throw - this is not critical
    }
  }

  /**
   * Handle client heartbeat for activity tracking
   */
  private handleClientHeartbeat(msg: {
    deviceType: "web" | "mobile";
    focusedAgentId: string | null;
    focusedTerminalId?: string | null;
    lastActivityAt: string;
    appVisible: boolean;
    appVisibilityChangedAt?: string;
  }): void {
    const focusedTerminalId = msg.focusedTerminalId?.trim() || null;
    const appVisibilityChangedAt = msg.appVisibilityChangedAt
      ? new Date(msg.appVisibilityChangedAt)
      : new Date(msg.lastActivityAt);
    const metadata = this.currentClientMetadata();
    metadata.activity = {
      deviceType: msg.deviceType,
      focusedAgentId: msg.focusedAgentId,
      focusedTerminalId,
      lastActivityAt: new Date(msg.lastActivityAt),
      appVisible: msg.appVisible,
      appVisibilityChangedAt,
    };
    if (msg.appVisible && focusedTerminalId) {
      void this.clearFocusedTerminalAttention(focusedTerminalId);
    }
    if (metadata.pushToken) {
      this.pushNotifications.renew(metadata.pushToken);
    }
  }

  private async clearFocusedTerminalAttention(terminalId: string): Promise<void> {
    const terminalManager = this.terminalManager;
    if (!terminalManager) {
      return;
    }
    try {
      await terminalManager.clearTerminalAttention(terminalId);
    } catch (error) {
      this.sessionLogger.warn({ err: error, terminalId }, "Failed to clear terminal attention");
    }
  }

  /**
   * Handle push token registration
   */
  private handleRegisterPushToken(token: string): void {
    this.currentClientMetadata().pushToken = token;
    this.pushNotifications.renew(token);
    this.sessionLogger.info("Registered push token");
  }

  /**
   * Handle list commands request for an agent
   */
  private async handleListCommandsRequest(
    msg: Extract<SessionInboundMessage, { type: "list_commands_request" }>,
  ): Promise<void> {
    const { agentId, requestId, draftConfig } = msg;
    this.sessionLogger.debug(
      { agentId, draftConfig },
      `Handling list commands request for agent ${agentId}`,
    );

    try {
      const existing = this.agentManager.getAgent(agentId);
      const stored = existing ? null : await this.agentStorage.get(agentId);
      const agent =
        existing || (stored && !stored.archivedAt)
          ? await ensureAgentLoaded(agentId, {
              agentManager: this.agentManager,
              agentStorage: this.agentStorage,
              logger: this.sessionLogger,
            })
          : null;

      if (agent?.session?.listCommands) {
        const commands = await agent.session.listCommands();
        this.emit({
          type: "list_commands_response",
          payload: {
            agentId,
            commands,
            error: null,
            requestId,
          },
        });
        return;
      }

      if (!agent && draftConfig) {
        const sessionConfig: AgentSessionConfig = {
          provider: draftConfig.provider,
          cwd: expandTilde(draftConfig.cwd),
          ...(draftConfig.modeId ? { modeId: draftConfig.modeId } : {}),
          ...(draftConfig.model ? { model: draftConfig.model } : {}),
          ...(draftConfig.thinkingOptionId
            ? { thinkingOptionId: draftConfig.thinkingOptionId }
            : {}),
        };

        const commands = await this.agentManager.listDraftCommands(sessionConfig);
        this.emit({
          type: "list_commands_response",
          payload: {
            agentId,
            commands,
            error: null,
            requestId,
          },
        });
        return;
      }

      this.emit({
        type: "list_commands_response",
        payload: {
          agentId,
          commands: [],
          error: agent ? `Agent does not support listing commands` : `Agent not found: ${agentId}`,
          requestId,
        },
      });
    } catch (error) {
      this.sessionLogger.error({ err: error, agentId, draftConfig }, "Failed to list commands");
      this.emit({
        type: "list_commands_response",
        payload: {
          agentId,
          commands: [],
          error: getErrorMessage(error),
          requestId,
        },
      });
    }
  }

  /**
   * Handle agent permission response from user
   */
  private async handleAgentPermissionResponse(
    agentId: string,
    requestId: string,
    response: AgentPermissionResponse,
  ): Promise<void> {
    try {
      await respondToAgentPermission({
        agentManager: this.agentManager,
        agentId,
        requestId,
        response,
        logger: this.sessionLogger,
      });
      // COMPAT(ownedSubscriptions): added in v0.8.0, remove after 2027-03-09.
      // Legacy clients consume the single domain resolution; modern request outcomes
      // are independent of whether this socket (or its logical Session) observes it.
      if (this.delivery.isModern(this.delivery.currentSource)) {
        this.delivery.reply({
          type: "agent_permission_resolved",
          payload: { agentId, requestId, resolution: response },
        });
      }
    } catch (error) {
      this.sessionLogger.error(
        { err: error, agentId, requestId },
        "Failed to respond to permission",
      );
      this.emit({
        type: "activity_log",
        payload: {
          id: uuidv4(),
          timestamp: new Date(),
          type: "error",
          content: `Failed to respond to permission: ${getErrorMessage(error)}`,
        },
      });
      throw error;
    }
  }

  private async handleDirectorySuggestionsRequest(msg: DirectorySuggestionsRequest): Promise<void> {
    const { query, limit, requestId, cwd, includeFiles, includeDirectories, matchMode } = msg;

    try {
      const workspaceCwd = cwd?.trim();
      const searchesWorkspace = Boolean(workspaceCwd);
      const homeRoot = process.env.HOME ?? homedir();
      // readdir on TCC-protected folders under ~/Library blocks forever for a process that cannot
      // show a consent prompt, and each blocked call holds a libuv threadpool thread.
      const excludedDiscoveryPaths =
        !searchesWorkspace && process.platform === "darwin" ? [join(homeRoot, "Library")] : [];
      const entries = await searchDirectoryEntries({
        root: workspaceCwd ? expandTilde(workspaceCwd) : homeRoot,
        query,
        pathFormat: searchesWorkspace ? "relative" : "absolute",
        pathQueryPolicy: searchesWorkspace ? "slashes" : "rooted",
        blankQueryBehavior: searchesWorkspace ? "children" : "none",
        rootAliases: searchesWorkspace ? [] : ["~"],
        traversableHiddenDirectoryNames: searchesWorkspace
          ? WORKSPACE_SEARCH_HIDDEN_DIRECTORIES
          : [],
        confidentResultScanThreshold: searchesWorkspace ? undefined : 5_000,
        respectGitIgnore: searchesWorkspace,
        excludedDiscoveryPaths,
        includeFiles,
        includeDirectories,
        matchMode,
        limit,
      });
      const directories = entries
        .filter((entry) => entry.kind === "directory")
        .map((entry) => entry.path);
      this.emit({
        type: "directory_suggestions_response",
        payload: {
          directories,
          entries,
          error: null,
          requestId,
        },
      });
    } catch (error) {
      this.emit({
        type: "directory_suggestions_response",
        payload: {
          directories: [],
          entries: [],
          error: error instanceof Error ? error.message : String(error),
          requestId,
        },
      });
    }
  }

  private async handleNeolixWorktreeListRequest(
    msg: Extract<SessionInboundMessage, { type: "neolix_worktree_list_request" }>,
  ): Promise<void> {
    return handleWorktreeListRequest(
      {
        emit: (message) => this.emit(message),
        neolixHome: this.neolixHome,
        workspaceGitService: this.workspaceGitService,
      },
      msg,
    );
  }

  private async handleNeolixWorktreeArchiveRequest(
    msg: Extract<SessionInboundMessage, { type: "neolix_worktree_archive_request" }>,
  ): Promise<void> {
    return handleWorktreeArchiveRequest(
      {
        neolixHome: this.neolixHome,
        neolixWorktreesBaseRoot: this.worktreesRoot,
        github: this.github,
        workspaceGitService: this.workspaceGitService,
        agentManager: this.agentManager,
        agentStorage: this.agentStorage,
        findWorkspaceIdForCwd: (cwd) => this.findWorkspaceIdForCwd(cwd),
        listActiveWorkspaces: () => this.listActiveWorkspaceRefs(),
        archiveWorkspaceRecord: (workspaceId) => this.archiveWorkspaceRecord(workspaceId),
        emit: (message) => this.emit(message),
        emitWorkspaceUpdatesForWorkspaceIds: (workspaceIds) =>
          this.emitWorkspaceUpdatesForWorkspaceIds(workspaceIds),
        markWorkspaceArchiving: (workspaceIds, archivingAt) =>
          this.markWorkspaceArchiving(workspaceIds, archivingAt),
        clearWorkspaceArchiving: (workspaceIds) => this.clearWorkspaceArchiving(workspaceIds),
        killTerminalsForWorkspace: (workspaceId) =>
          this.terminalController.killTerminalsForWorkspace(workspaceId),
        sessionLogger: this.sessionLogger,
      },
      msg,
    );
  }

  private async listTerminalActivityContributions(): Promise<
    Array<{ cwd: string; workspaceId?: string; activity: TerminalActivity | null }>
  > {
    const terminalManager = this.terminalManager;
    if (!terminalManager) {
      return [];
    }
    const directories = terminalManager.listDirectories();
    const terminalsByDirectory = await Promise.all(
      directories.map((cwd) => terminalManager.getTerminals(cwd)),
    );
    return terminalsByDirectory.flat().map((session) => {
      const contribution: { cwd: string; workspaceId?: string; activity: TerminalActivity | null } =
        {
          cwd: session.cwd,
          activity: session.getActivity(),
        };
      if (session.workspaceId) {
        contribution.workspaceId = session.workspaceId;
      }
      return contribution;
    });
  }

  /**
   * Build the current agent list payload (live + persisted), optionally filtered by labels.
   */
  private listAgentPayloads(
    filter?: Parameters<AgentDirectory["list"]>[0],
  ): Promise<AgentSnapshotPayload[]> {
    return this.agentDirectory.list(filter);
  }

  private async resolveAgentIdentifier(
    identifier: string,
  ): Promise<{ ok: true; agentId: string } | { ok: false; notFound: boolean; error: string }> {
    const trimmed = identifier.trim();
    if (!trimmed) {
      return { ok: false, notFound: false, error: "Agent identifier cannot be empty" };
    }

    // An internal agent, live or recently archived, is addressable by its exact
    // id and nothing else: the caller that created it holds the id, and no
    // listing ever includes it.
    if (this.agentManager.getAgent(trimmed) || this.agentManager.getRetiredInternalAgent(trimmed)) {
      return { ok: true, agentId: trimmed };
    }

    // Explicit identifier resolution admits archived agents by ID prefix.
    const stored = await this.agentStorage.listAll();
    const storedRecords = stored.filter((record) => !record.internal);
    const knownIds = new Set<string>();
    for (const record of storedRecords) {
      knownIds.add(record.id);
    }
    for (const agent of this.agentManager.listAgents()) {
      knownIds.add(agent.id);
    }

    if (knownIds.has(trimmed)) {
      return { ok: true, agentId: trimmed };
    }

    const prefixMatches = Array.from(knownIds).filter((id) => id.startsWith(trimmed));
    if (prefixMatches.length === 1) {
      return { ok: true, agentId: prefixMatches[0] };
    }
    if (prefixMatches.length > 1) {
      return {
        ok: false,
        notFound: false,
        error: `Agent identifier "${trimmed}" is ambiguous (${prefixMatches
          .slice(0, 5)
          .map((id) => id.slice(0, 8))
          .join(", ")}${prefixMatches.length > 5 ? ", …" : ""})`,
      };
    }

    const titleMatches = storedRecords.filter((record) => record.title === trimmed);
    if (titleMatches.length === 1) {
      return { ok: true, agentId: titleMatches[0].id };
    }
    if (titleMatches.length > 1) {
      return {
        ok: false,
        notFound: false,
        error: `Agent title "${trimmed}" is ambiguous (${titleMatches
          .slice(0, 5)
          .map((r) => r.id.slice(0, 8))
          .join(", ")}${titleMatches.length > 5 ? ", …" : ""})`,
      };
    }

    return { ok: false, notFound: true, error: `Agent not found: ${trimmed}` };
  }

  /**
   * An agent that is no longer live, in its settled form: the retained snapshot
   * of a recently archived internal agent, else its stored record. Null when
   * neither exists, and for a stored internal record, which is never served.
   */
  private async readSettledAgent(
    agentId: string,
  ): Promise<{ record: StoredAgentRecord; lastMessage: string | null } | null> {
    const retired = this.agentManager.getRetiredInternalAgent(agentId);
    if (retired) {
      return { record: retired.record, lastMessage: retired.lastMessage };
    }
    const record = await this.agentStorage.get(agentId);
    if (!record || record.internal) {
      return null;
    }
    return { record, lastMessage: await this.agentManager.getLastAssistantMessage(agentId) };
  }

  private async getAgentPayloadById(agentId: string): Promise<AgentSnapshotPayload | null> {
    const live = this.agentManager.getAgent(agentId);
    if (live) {
      const payload = await this.buildAgentPayload(live);
      return this.isProviderVisibleToClient(payload.provider) ? payload : null;
    }

    const settled = await this.readSettledAgent(agentId);
    if (!settled) {
      return null;
    }
    const payload = this.buildStoredAgentPayload(settled.record);
    return this.isProviderVisibleToClient(payload.provider) ? payload : null;
  }

  private async resolveDelegationRootWorkspaceId(agentId: string): Promise<string | null> {
    const seen = new Set<string>();
    let currentAgentId = agentId;

    while (true) {
      if (seen.has(currentAgentId)) {
        return null;
      }
      seen.add(currentAgentId);

      const live = this.agentManager.getAgent(currentAgentId);
      const source = live ?? (await this.agentStorage.get(currentAgentId));
      if (!source) {
        return null;
      }
      if ("archivedAt" in source && source.archivedAt) {
        return null;
      }

      const parentAgentId = getParentAgentIdFromLabels(source.labels);
      if (!parentAgentId) {
        return source.workspaceId ?? null;
      }
      currentAgentId = parentAgentId;
    }
  }

  private async buildActiveProjectPlacementsByWorkspaceId(): Promise<
    Map<string, ProjectPlacementPayload>
  > {
    const [persistedWorkspaces, persistedProjects] = await Promise.all([
      this.workspaceRegistry.listActive(),
      this.projectRegistry.list(),
    ]);
    const activeProjects = new Map(
      persistedProjects
        .filter((project) => !project.archivedAt)
        .map((project) => [project.projectId, project] as const),
    );
    const placementsByWorkspaceId = new Map<string, ProjectPlacementPayload>();

    const pairs = persistedWorkspaces.flatMap((workspace) => {
      if (workspace.archivedAt) return [];
      const project = activeProjects.get(workspace.projectId);
      if (!project) return [];
      return [{ workspace, project }];
    });
    const placements = await Promise.all(
      pairs.map(({ workspace, project }) =>
        this.buildProjectPlacementForWorkspace(workspace, project),
      ),
    );
    for (let i = 0; i < pairs.length; i += 1) {
      placementsByWorkspaceId.set(pairs[i].workspace.workspaceId, placements[i]);
    }

    return placementsByWorkspaceId;
  }

  private async collectFetchAgentsEntries(params: {
    candidates: AgentSnapshotPayload[];
    limit: number;
    getPlacement: (workspaceId: string | undefined) => Promise<ProjectPlacementPayload | null>;
    filter: AgentUpdatesFilter | undefined;
    search?: string;
  }): Promise<FetchAgentsResponseEntry[]> {
    const { candidates, limit, getPlacement, filter, search } = params;
    const matchedEntries: FetchAgentsResponseEntry[] = [];
    const batchSize = 25;
    for (
      let start = 0;
      start < candidates.length && matchedEntries.length <= limit;
      start += batchSize
    ) {
      const batch = candidates.slice(start, start + batchSize);
      const batchEntries = await Promise.all(
        batch.map(async (agent) => {
          const project = await getPlacement(agent.workspaceId);
          return project ? { agent, project } : null;
        }),
      );
      for (const entry of batchEntries) {
        if (!entry) {
          continue;
        }
        if (
          !matchesAgentUpdatesFilter({
            agent: entry.agent,
            project: entry.project,
            filter,
          })
        ) {
          continue;
        }
        if (search && !matchesAgentHistoryQuery(search, entry)) continue;
        matchedEntries.push(entry);
        if (matchedEntries.length > limit) {
          break;
        }
      }
    }
    return matchedEntries;
  }

  /**
   * Inclusive discovery for the requesting source. Exact-ID reads never pass through this.
   * COMPAT(backgroundAgents): added in v0.15.0, remove after 2027-05-03 once client floor
   * >= v0.15.0. Sources without the capability see background workspaces' agents only.
   */
  private resolveBackgroundVisibility(
    includeBackground: boolean | undefined,
  ): BackgroundVisibility {
    if (!includeBackground) return false;
    return this.supports(CLIENT_CAPS.backgroundAgents) ? true : "workspaces";
  }

  private async listFetchAgentsEntries(
    request: AgentDirectoryRequestMessage,
    backgroundVisibility: BackgroundVisibility,
  ): Promise<{
    entries: FetchAgentsResponseEntry[];
    pageInfo: FetchAgentsResponsePageInfo;
    searchTruncated?: boolean;
  }> {
    const filter =
      request.type === "fetch_agent_history_request" &&
      request.filter?.includeArchived === undefined
        ? { ...request.filter, includeArchived: true }
        : request.filter;
    const scope = request.type === "fetch_agents_request" ? request.scope : undefined;
    const sort = this.agentsPager.normalizeSort(request.sort);

    let agents = await this.listAgentPayloads({
      labels: filter?.labels,
      includeArchived: filter?.includeArchived,
      includeBackground: backgroundVisibility,
      includeUnavailablePersisted: request.type === "fetch_agent_history_request",
    });
    const activePlacementsByWorkspaceId =
      scope === "active" ? await this.buildActiveProjectPlacementsByWorkspaceId() : null;
    if (activePlacementsByWorkspaceId) {
      agents = agents.filter(
        (agent) =>
          !agent.archivedAt &&
          agent.workspaceId != null &&
          activePlacementsByWorkspaceId.has(agent.workspaceId),
      );
    }

    const placementByWorkspaceId = new Map<string, Promise<ProjectPlacementPayload | null>>();
    const getPlacement = (
      workspaceId: string | undefined,
    ): Promise<ProjectPlacementPayload | null> => {
      if (!workspaceId) {
        return Promise.resolve(null);
      }
      if (activePlacementsByWorkspaceId) {
        return Promise.resolve(activePlacementsByWorkspaceId.get(workspaceId) ?? null);
      }
      const existing = placementByWorkspaceId.get(workspaceId);
      if (existing) {
        return existing;
      }
      const placementPromise = this.buildProjectPlacementForWorkspaceId(workspaceId);
      placementByWorkspaceId.set(workspaceId, placementPromise);
      return placementPromise;
    };

    const search = agentDirectorySearchQuery(request);
    let candidates = [...agents];
    candidates.sort((left, right) => this.agentsPager.compare(left, right, sort));
    const cursorToken = request.page?.cursor;
    if (cursorToken) {
      const cursor = this.decodeAgentCursor(cursorToken, sort);
      candidates = candidates.filter(
        (agent) => this.agentsPager.compareWithCursor(agent, cursor, sort) > 0,
      );
    }

    const limit = request.page?.limit ?? 200;

    const matchedEntries = await this.collectFetchAgentsEntries({
      candidates,
      limit,
      getPlacement,
      filter,
      search,
    });

    const pagedEntries = matchedEntries.slice(0, limit);
    const hasMore = matchedEntries.length > limit;
    const nextCursor =
      hasMore && pagedEntries.length > 0
        ? this.agentsPager.encode(pagedEntries[pagedEntries.length - 1].agent, sort)
        : null;

    return {
      entries: pagedEntries,
      pageInfo: {
        nextCursor,
        prevCursor: request.page?.cursor ?? null,
        hasMore,
      },
    };
  }

  private readonly agentsPager = new SortablePager<
    AgentSnapshotPayload,
    FetchAgentsRequestSort["key"]
  >({
    validKeys: FETCH_AGENTS_SORT_KEYS,
    defaultSort: [{ key: "updated_at", direction: "desc" }],
    label: "fetch_agents",
    getId: (agent) => agent.id,
    getSortValue: (agent, key): number | string => {
      switch (key) {
        case "status_priority":
          return getAgentStatusPriority({
            status: agent.status,
            pendingPermissionCount: agent.pendingPermissions?.length ?? 0,
            requiresAttention: agent.requiresAttention,
            attentionReason: agent.attentionReason ?? null,
          });
        case "created_at":
          return Date.parse(agent.createdAt);
        case "updated_at":
          return Date.parse(agent.updatedAt);
        case "title":
          return agent.title?.toLocaleLowerCase() ?? "";
      }
    },
  });

  private decodeAgentCursor(token: string, sort: SortSpec<FetchAgentsRequestSort["key"]>[]) {
    try {
      return this.agentsPager.decode(token, sort);
    } catch (error) {
      if (error instanceof CursorError) {
        throw new SessionRequestError("invalid_cursor", error.message);
      }
      throw error;
    }
  }

  private async describeWorkspaceRecord(
    workspace: PersistedWorkspaceRecord,
    projectRecord?: PersistedProjectRecord | null,
  ): Promise<WorkspaceDescriptorPayload> {
    const resolvedProjectRecord =
      projectRecord ?? (await this.projectRegistry.get(workspace.projectId));

    let diffStat: { additions: number; deletions: number } | null = null;
    const snapshot = this.workspaceRuntimeStore.get(workspace.cwd);
    if (snapshot?.git.diffStat) {
      diffStat = snapshot.git.diffStat;
    }

    const worktreeSlug =
      workspace.isNeolixOwnedWorktree && workspace.worktreeRoot
        ? basename(workspace.worktreeRoot)
        : undefined;

    return {
      id: workspace.workspaceId,
      projectId: workspace.projectId,
      projectDisplayName: resolvedProjectRecord
        ? resolveProjectDisplayName(resolvedProjectRecord)
        : workspace.projectId,
      projectCustomName: resolvedProjectRecord?.customName ?? null,
      projectCustomIconRevision: resolvedProjectRecord?.customIconRevision ?? null,
      projectRootPath: resolvedProjectRecord?.rootPath ?? workspace.cwd,
      workspaceDirectory: workspace.cwd,
      setupStatus: this.workspaceSetupObservation.status(workspace),
      worktreeSlug,
      projectKind: (resolvedProjectRecord?.kind ?? "directory") === "git" ? "git" : "non_git",
      workspaceKind: workspace.kind,
      name: resolveWorkspaceDisplayName(workspace),
      title: workspace.title,
      pinnedAt: workspace.pinnedAt,
      ...(workspace.labels && workspace.labels.length > 0 ? { labels: workspace.labels } : {}),
      background: workspace.background,
      archivingAt: null,
      status: "done",
      statusEnteredAt: null,
      activityAt: null,
      createdAt: workspace.createdAt,
      diffStat,
      scripts: await this.buildWorkspaceScriptPayloadSnapshot(workspace, resolvedProjectRecord),
      ...(resolvedProjectRecord
        ? {
            project: await this.buildProjectPlacementForWorkspace(workspace, resolvedProjectRecord),
          }
        : {}),
    };
  }

  private buildWorkspaceGitRuntimePayload(
    snapshot: WorkspaceGitRuntimeSnapshot,
  ): NonNullable<WorkspaceDescriptorPayload["gitRuntime"]> | null {
    if (!snapshot.git.isGit) {
      return null;
    }

    return {
      currentBranch: snapshot.git.currentBranch,
      remoteUrl: snapshot.git.remoteUrl,
      isNeolixOwnedWorktree: snapshot.git.isNeolixOwnedWorktree,
      isDirty: snapshot.git.isDirty,
      aheadBehind: snapshot.git.aheadBehind,
      aheadOfOrigin: snapshot.git.aheadOfOrigin,
      behindOfOrigin: snapshot.git.behindOfOrigin,
    };
  }

  private buildWorkspaceGitHubRuntimePayload(
    snapshot: WorkspaceGitRuntimeSnapshot,
  ): NonNullable<WorkspaceDescriptorPayload["githubRuntime"]> {
    return {
      featuresEnabled: snapshot.forge.featuresEnabled,
      pullRequest: snapshot.forge.pullRequest,
      error: snapshot.forge.error,
    };
  }

  private async describeWorkspaceRecordWithGitData(
    workspace: PersistedWorkspaceRecord,
    projectRecord?: PersistedProjectRecord | null,
  ): Promise<WorkspaceDescriptorPayload> {
    const base = await this.describeWorkspaceRecord(workspace, projectRecord);
    const snapshot = this.workspaceRuntimeStore.get(workspace.cwd);
    if (!snapshot) {
      return base;
    }

    const checkout = checkoutLiteFromGitSnapshot(workspace.cwd, snapshot.git);
    const displayName = deriveWorkspaceDisplayName({ cwd: workspace.cwd, checkout });

    return {
      ...base,
      name: resolveWorkspaceName({ title: workspace.title, derivedDisplayName: displayName }),
      diffStat: snapshot.git.diffStat ?? null,
      gitRuntime: this.buildWorkspaceGitRuntimePayload(snapshot) ?? undefined,
      githubRuntime: this.buildWorkspaceGitHubRuntimePayload(snapshot),
      // Reuse the forge already resolved on the snapshot (probe-aware; GitHub-only
      // resolves to "github") so the sidebar/hover-card brand mark matches the
      // status projection without a second resolve.
      forge: snapshot.forge.forge,
    };
  }

  private async describeCreatedWorktreeWorkspace(
    result: CreateNeolixWorktreeResult,
  ): Promise<WorkspaceDescriptorPayload> {
    const projectRecord = await this.projectRegistry.get(result.workspace.projectId);
    return {
      id: result.workspace.workspaceId,
      projectId: result.workspace.projectId,
      projectDisplayName: projectRecord
        ? resolveProjectDisplayName(projectRecord)
        : result.workspace.projectId,
      projectCustomName: projectRecord?.customName ?? null,
      projectCustomIconRevision: projectRecord?.customIconRevision ?? null,
      projectRootPath: projectRecord?.rootPath ?? result.repoRoot,
      workspaceDirectory: result.workspace.cwd,
      setupStatus: this.workspaceSetupObservation.status(result.workspace),
      worktreeSlug: basename(result.worktree.worktreePath),
      projectKind: projectRecord?.kind ?? "git",
      workspaceKind: result.workspace.kind,
      background: result.workspace.background,
      name: resolveWorkspaceName({
        title: result.workspace.title,
        derivedDisplayName: result.worktree.branchName || result.workspace.displayName,
      }),
      title: result.workspace.title,
      pinnedAt: result.workspace.pinnedAt,
      ...(result.workspace.labels && result.workspace.labels.length > 0
        ? { labels: result.workspace.labels }
        : {}),
      archivingAt: null,
      status: "done",
      statusEnteredAt: result.workspace.createdAt,
      activityAt: null,
      createdAt: result.workspace.createdAt,
      lastUserMessageAt: null,
      diffStat: { additions: 0, deletions: 0 },
      scripts: [],
      gitRuntime: {
        currentBranch: result.worktree.branchName || null,
        remoteUrl: null,
        isNeolixOwnedWorktree: true,
        isDirty: false,
        aheadBehind: null,
        aheadOfOrigin: null,
        behindOfOrigin: null,
      },
      githubRuntime: null,
    };
  }

  private async buildWorkspaceDescriptor(input: {
    workspace: PersistedWorkspaceRecord;
    projectRecord?: PersistedProjectRecord | null;
    includeGitData: boolean;
  }): Promise<WorkspaceDescriptorPayload> {
    if (input.includeGitData && input.workspace.kind !== "directory") {
      return this.describeWorkspaceRecordWithGitData(input.workspace, input.projectRecord);
    }
    return this.describeWorkspaceRecord(input.workspace, input.projectRecord);
  }

  markWorkspaceArchiving(workspaceIds: Iterable<string>, archivingAt: string): void {
    this.workspaceDirectory.markArchiving(workspaceIds, archivingAt);
  }

  clearWorkspaceArchiving(workspaceIds: Iterable<string>): void {
    this.workspaceDirectory.clearArchiving(workspaceIds);
  }

  private async buildWorkspaceDescriptorMap(options: {
    includeGitData: boolean;
    workspaceIds?: Iterable<string>;
  }): Promise<Map<string, WorkspaceDescriptorPayload>> {
    return this.workspaceDirectory.buildDescriptorMap(options);
  }

  // external path→workspace adapter, not ownership. Used by archive-by-path flows
  // where the request carries a worktree path (unique to one workspace) rather
  // than a workspaceId. This is a directory lookup for an archive target, not a
  // status/ownership attribution.
  private async findWorkspaceIdForCwd(cwd: string): Promise<string | null> {
    // Explicit archive administration must prefer an archived exact match to an active ancestor.
    const workspaces = await this.workspaceRegistry.listAll();
    return resolveWorkspaceIdForPath(cwd, workspaces);
  }

  private matchesWorkspaceFilter(input: {
    workspace: WorkspaceDescriptorPayload;
    filter: FetchWorkspacesRequestFilter | undefined;
  }): boolean {
    return this.workspaceDirectory.matchesFilter(input);
  }

  private async listFetchWorkspacesEntries(
    request: Extract<SessionInboundMessage, { type: "fetch_workspaces_request" }>,
  ): Promise<{
    entries: FetchWorkspacesResponseEntry[];
    emptyProjects: WorkspaceProjectDescriptorPayload[];
    pageInfo: FetchWorkspacesResponsePageInfo;
  }> {
    try {
      return await this.workspaceDirectory.listFetchEntries({
        ...request,
        filter: {
          ...request.filter,
          ...(request.includeBackground ? { includeBackground: true } : {}),
        },
      });
    } catch (error) {
      if (error instanceof CursorError) {
        throw new SessionRequestError("invalid_cursor", error.message);
      }
      throw error;
    }
  }

  private bufferOrEmitWorkspaceUpdate(
    subscription: WorkspaceUpdatesSubscriptionState,
    payload: WorkspaceUpdatePayload,
  ): void {
    if (this.workspaceUpdatesSubscriptions.get(subscription.subscriptionId) !== subscription)
      return;
    if (payload.kind === "upsert") {
      subscription.visibleEmptyProjectIds?.delete(payload.workspace.projectId);
    } else {
      if (payload.emptyProject) {
        subscription.visibleEmptyProjectIds?.add(payload.emptyProject.projectId);
      }
      if (payload.removedProjectId) {
        subscription.visibleEmptyProjectIds?.delete(payload.removedProjectId);
      }
    }
    if (subscription.isBootstrapping) {
      const workspaceId = payload.kind === "upsert" ? payload.workspace.id : payload.id;
      subscription.pendingUpdatesByWorkspaceId.set(workspaceId, payload);
      return;
    }
    const workspaceId = payload.kind === "upsert" ? payload.workspace.id : payload.id;
    subscription.lastEmittedByWorkspaceId.set(workspaceId, payload);
    subscription.owner.emit({ type: "workspace_update", payload });
  }

  private flushBootstrappedWorkspaceUpdates(
    subscription: WorkspaceUpdatesSubscriptionState,
    options?: {
      snapshotByWorkspaceId?: Map<
        string,
        { status: string; statusEnteredAt: string | null; activityAtMs: number | null }
      >;
    },
  ): void {
    if (
      this.workspaceUpdatesSubscriptions.get(subscription.subscriptionId) !== subscription ||
      !subscription.isBootstrapping
    ) {
      return;
    }

    subscription.isBootstrapping = false;
    const pending = Array.from(subscription.pendingUpdatesByWorkspaceId.values());
    subscription.pendingUpdatesByWorkspaceId.clear();

    for (const payload of pending) {
      if (payload.kind === "upsert") {
        const snapshot = options?.snapshotByWorkspaceId?.get(payload.workspace.id);
        const updateActivityAtMs = payload.workspace.activityAt
          ? Date.parse(payload.workspace.activityAt)
          : null;
        const shouldEmit = shouldEmitPendingBootstrapUpdate({
          snapshot: snapshot
            ? {
                status: snapshot.status,
                statusEnteredAt: snapshot.statusEnteredAt,
                activityAtMs: snapshot.activityAtMs,
              }
            : null,
          update: {
            status: payload.workspace.status,
            statusEnteredAt: payload.workspace.statusEnteredAt ?? null,
            activityAtMs: Number.isNaN(updateActivityAtMs) ? null : updateActivityAtMs,
          },
        });
        if (!shouldEmit) {
          continue;
        }
      }
      const workspaceId = payload.kind === "upsert" ? payload.workspace.id : payload.id;
      subscription.lastEmittedByWorkspaceId.set(workspaceId, payload);
      subscription.owner.emit({ type: "workspace_update", payload });
    }
  }

  private async buildProjectDescriptor(
    project: PersistedProjectRecord,
  ): Promise<WorkspaceProjectDescriptorPayload> {
    const icon = await this.projectIcons.snapshot(project);
    return {
      projectId: project.projectId,
      ...(project.projectKey ? { projectKey: project.projectKey } : {}),
      projectDisplayName: resolveProjectDisplayName(project),
      projectCustomName: project.customName ?? null,
      projectCustomIconRevision: project.customIconRevision ?? null,
      projectIconRevision: icon.revision,
      projectRootPath: project.rootPath,
      projectKind: project.kind,
    };
  }

  private async restoreWorkspaceAndEmit(workspaceId: string): Promise<void> {
    await this.workspaceRecovery.restore(workspaceId);
    const workspace = await this.workspaceRegistry.get(workspaceId);
    if (!workspace) {
      throw new Error(`Recovered workspace record not found: ${workspaceId}`);
    }
    if (this.onWorkspaceRecovered) {
      try {
        await this.onWorkspaceRecovered(workspace);
        return;
      } catch (error) {
        this.sessionLogger.warn(
          { err: error, workspaceId },
          "Failed to publish workspace recovery to active sessions",
        );
      }
    }
    await this.refreshRecoveredWorkspaceForExternalMutation(workspace);
  }

  private async restoreOwningWorkspaceForLegacyAgentRefresh(agentId: string): Promise<void> {
    // COMPAT(worktreeRestore): clients older than v0.1.105 used refresh_agent_request
    // as their explicit recovery RPC. Remove after 2027-01-11.
    if (!clientUsesLegacyWorkspaceRestore(this.appVersion)) {
      return;
    }
    const record = await this.agentStorage.get(agentId);
    if (!record?.workspaceId) {
      return;
    }
    const recovery = await this.workspaceRecovery.inspect(record.workspaceId);
    if (recovery.kind !== "recoverable") {
      return;
    }
    await this.restoreWorkspaceAndEmit(record.workspaceId);
  }

  private async createNeolixWorktree(
    input: CreateNeolixWorktreeInput,
    options?: {
      resolveDefaultBranch?: (repoRoot: string) => Promise<string>;
    },
  ): Promise<CreateNeolixWorktreeResult> {
    const result = await createNeolixWorktree(input, {
      lifecycle: this.pluginRuntime,
      github: this.github,
      ...(options?.resolveDefaultBranch
        ? { resolveDefaultBranch: options.resolveDefaultBranch }
        : {}),
      workspaceGitService: this.workspaceGitService,
      workspaceProvisioning: this.workspaceProvisioning,
    });
    void Promise.all([
      this.gitMutation.notifyGitMutation(input.cwd, "create-worktree"),
      this.gitMutation.notifyGitMutation(result.worktree.worktreePath, "create-worktree"),
    ]).catch((error) => {
      this.sessionLogger.warn(
        { err: error, cwd: input.cwd, worktreePath: result.worktree.worktreePath },
        "Failed to warm git snapshots after creating worktree",
      );
    });
    return result;
  }

  private async listActiveWorkspaceRefs(): Promise<ActiveWorkspaceRef[]> {
    const workspaces = await this.workspaceRegistry.listActive();
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
  }

  private async archiveWorkspaceRecord(workspaceId: string, archivedAt?: string): Promise<void> {
    const archiveTimestamp = archivedAt ?? new Date().toISOString();
    const existingWorkspace = await archivePersistedWorkspaceRecord({
      workspaceId,
      archivedAt: archiveTimestamp,
      workspaceRegistry: this.workspaceRegistry,
    });
    if (!existingWorkspace) {
      this.workspaceGitObserver.removeForWorkspaceId(workspaceId);
      return;
    }

    if (!existingWorkspace.archivedAt) {
      const activeSiblings = (await this.workspaceRegistry.listActive()).filter(
        (workspace) => workspace.projectId === existingWorkspace.projectId && !workspace.archivedAt,
      );
      this.sessionLogger.info(
        {
          workspaceId,
          workspaceCwd: existingWorkspace.cwd,
          projectId: existingWorkspace.projectId,
          projectArchived: activeSiblings.length === 0,
          archivedAt: archiveTimestamp,
        },
        "Workspace archived",
      );
    }

    await this.teardownArchivedWorkspace(existingWorkspace.workspaceId);
  }

  private async teardownArchivedWorkspace(workspaceId: string): Promise<void> {
    this.workspaceGitObserver.removeForWorkspaceId(workspaceId);
    this.scriptRuntimeStore?.removeForWorkspace(workspaceId);
    releaseWorkspaceServicePortPlan(workspaceId);
  }

  private async emitWorkspaceUpdatesForWorkspaceIds(
    workspaceIds: Iterable<string>,
    options?: WorkspaceUpdateOptions,
  ): Promise<void> {
    const uniqueWorkspaceIds = new Set(workspaceIds);
    if (uniqueWorkspaceIds.size === 0) return;
    for (const subscription of this.workspaceUpdatesSubscriptions.values()) {
      await this.enqueueWorkspaceUpdates(uniqueWorkspaceIds, subscription, options);
    }
  }

  private enqueueWorkspaceUpdates(
    workspaceIds: ReadonlySet<string>,
    subscription: WorkspaceUpdatesSubscriptionState,
    options: WorkspaceUpdateOptions | undefined,
  ): Promise<void> {
    const previous = Array.from(workspaceIds, (workspaceId) =>
      (this.workspaceUpdateTails.get(workspaceId) ?? Promise.resolve()).catch(() => undefined),
    );
    const next = Promise.all(previous).then(() =>
      this.delivery.forSource(subscription.owner.source, () =>
        this.emitWorkspaceUpdateBatch(workspaceIds, subscription, options),
      ),
    );
    for (const workspaceId of workspaceIds) {
      this.workspaceUpdateTails.set(workspaceId, next);
    }

    const clearTail = () => {
      for (const workspaceId of workspaceIds) {
        if (this.workspaceUpdateTails.get(workspaceId) === next) {
          this.workspaceUpdateTails.delete(workspaceId);
        }
      }
    };
    void next.then(clearTail, clearTail);
    return next;
  }

  private async emitWorkspaceUpdateBatch(
    workspaceIds: ReadonlySet<string>,
    subscription: WorkspaceUpdatesSubscriptionState,
    options: WorkspaceUpdateOptions | undefined,
  ): Promise<void> {
    if (this.workspaceUpdatesSubscriptions.get(subscription.subscriptionId) !== subscription) {
      return;
    }

    const descriptorsByWorkspaceId = await this.buildWorkspaceDescriptorMap({
      workspaceIds,
      includeGitData: true,
    });

    for (const workspaceId of workspaceIds) {
      if (this.workspaceUpdatesSubscriptions.get(subscription.subscriptionId) !== subscription) {
        return;
      }
      const workspace = descriptorsByWorkspaceId.get(workspaceId);
      const filteredWorkspace =
        workspace && this.matchesWorkspaceFilter({ workspace, filter: subscription.filter })
          ? workspace
          : null;
      const nextWorkspace = this.applyOptimisticWorkspaceStatus(
        filteredWorkspace,
        options?.optimisticStatus,
      );
      const lastEmitted = subscription.lastEmittedByWorkspaceId.get(workspaceId);
      this.workspaceGitObserver.recordDescriptorState(workspaceId, nextWorkspace);
      if (!nextWorkspace) {
        if (this.shouldSkipWorkspaceRemoval(lastEmitted, options?.removedProjectId)) {
          continue;
        }
        if (this.workspaceUpdatesSubscriptions.get(subscription.subscriptionId) !== subscription) {
          return;
        }
        subscription.lastEmittedByWorkspaceId.delete(workspaceId);
        const removePayload = await this.buildWorkspaceRemoveUpdatePayload(
          workspaceId,
          options?.removedProjectId,
        );
        this.bufferOrEmitWorkspaceUpdate(
          subscription,
          this.directorySync.sequenceWorkspaceUpdate(
            removePayload,
            workspace ?? null,
            workspaceId,
            subscription.syncEnabled === true,
            subscription.filter?.includeBackground,
          ),
        );
        continue;
      }

      const nextPayload: WorkspaceUpdatePayload = this.directorySync.sequenceWorkspaceUpdate(
        { kind: "upsert", workspace: nextWorkspace },
        workspace ?? null,
        workspaceId,
        subscription.syncEnabled === true,
        subscription.filter?.includeBackground,
      );

      if (
        lastEmitted &&
        lastEmitted.kind === "upsert" &&
        equal(lastEmitted.workspace, nextWorkspace)
      ) {
        continue;
      }

      this.bufferOrEmitWorkspaceUpdate(subscription, nextPayload);
    }
  }

  private applyOptimisticWorkspaceStatus(
    workspace: WorkspaceDescriptorPayload | null,
    optimisticStatus: WorkspaceDescriptorPayload["status"] | undefined,
  ): WorkspaceDescriptorPayload | null {
    if (!workspace || !optimisticStatus) {
      return workspace;
    }
    return { ...workspace, status: optimisticStatus };
  }

  private shouldSkipWorkspaceRemoval(
    lastEmitted: WorkspaceUpdatePayload | undefined,
    removedProjectId: string | undefined,
  ): boolean {
    if (lastEmitted?.kind === "remove") {
      return !removedProjectId || lastEmitted.removedProjectId === removedProjectId;
    }
    return !lastEmitted && !removedProjectId;
  }

  private async buildWorkspaceRemoveUpdatePayload(
    workspaceId: string,
    removedProjectId?: string,
  ): Promise<WorkspaceUpdatePayload> {
    if (removedProjectId) {
      return { kind: "remove", id: workspaceId, removedProjectId };
    }
    return {
      kind: "remove",
      id: workspaceId,
      ...(await this.resolveProjectWithoutActiveWorkspacesForArchivedWorkspace(workspaceId)),
    };
  }

  // When a workspace is archived its project may have no active workspaces left.
  // Resolve that project parent so the `remove` update can carry it, keeping the
  // sidebar in sync without a full re-hydration.
  private async resolveProjectWithoutActiveWorkspacesForArchivedWorkspace(
    workspaceId: string,
  ): Promise<{ emptyProject: WorkspaceProjectDescriptorPayload } | null> {
    const archivedWorkspace = await this.workspaceRegistry.get(workspaceId);
    if (!archivedWorkspace) {
      return null;
    }
    const projectWithoutActiveWorkspaces = (await this.workspaceDirectory.listEmptyProjects()).find(
      (project) => project.projectId === archivedWorkspace.projectId,
    );
    return projectWithoutActiveWorkspaces ? { emptyProject: projectWithoutActiveWorkspaces } : null;
  }

  private async emitWorkspaceUpdateForTerminalContribution(
    event: TerminalWorkspaceContributionChangedEvent,
  ): Promise<void> {
    // A terminal's activity contributes only to the workspace it carries. A
    // terminal with no workspaceId attributes to nothing — status is per-id.
    if (!event.workspaceId) {
      return;
    }
    await this.emitWorkspaceUpdatesForWorkspaceIds([event.workspaceId]);
  }

  // A git fact (branch, diff, dirty, PR) changed at `cwd`. Every workspace whose
  // OWN cwd is this folder re-derives its git facts from that folder (id → cwd)
  // and emits its own per-id descriptor. This is a deliberate same-folder fan,
  // not a cwd → id ownership lookup: git never resolves which workspace owns a
  // path. See `workspaceIdsOnCheckout`.
  private async emitWorkspaceUpdateForCwd(cwd: string, options?: {}): Promise<void> {
    if (this.workspaceUpdatesSubscriptions.size === 0) return;
    const workspaceIds = workspaceIdsOnCheckout(await this.workspaceRegistry.listActive(), cwd);
    if (workspaceIds.length === 0) {
      return;
    }
    await this.emitWorkspaceUpdatesForWorkspaceIds(workspaceIds, options);
  }

  private async handleFetchAgents(
    request: Extract<SessionInboundMessage, { type: "fetch_agents_request" }>,
  ): Promise<void> {
    const owner = request.subscribe
      ? this.delivery.begin("agents", request.subscribe.subscriptionId, (id) => {
          this.agentUpdates.clearSubscription(id);
          this.refreshObservationProducers();
        })
      : null;
    const subscriptionId = owner?.responseId;
    const backgroundVisibility = this.resolveBackgroundVisibility(
      request.includeBackground || request.filter?.includeBackground,
    );
    try {
      if (owner) {
        this.agentUpdates.beginSubscription({
          subscriptionId: owner.id,
          isProviderVisible: (provider) =>
            this.delivery.forSource(owner.source, () => this.isProviderVisibleToClient(provider)),
          filter: request.filter,
          backgroundVisibility,
          syncEnabled: Boolean(request.sync),
          emit: (message) => {
            if (message.type === "agent_update") owner.emit(message);
          },
        });
        this.refreshObservationProducers();
      }

      const payload = request.sync
        ? await this.readAgentDirectorySync(request, backgroundVisibility)
        : await this.listFetchAgentsEntries(request, backgroundVisibility);
      const snapshotUpdatedAtByAgentId = new Map<string, number>();
      for (const entry of payload.entries) {
        const parsedUpdatedAt = Date.parse(entry.agent.updatedAt);
        if (!Number.isNaN(parsedUpdatedAt)) {
          snapshotUpdatedAtByAgentId.set(entry.agent.id, parsedUpdatedAt);
        }
      }

      this.emit({
        type: "fetch_agents_response",
        payload: {
          requestId: request.requestId,
          ...(subscriptionId ? { subscriptionId } : {}),
          ...payload,
        },
      });

      if (subscriptionId) {
        this.agentUpdates.flushBootstrapped(owner!.id, { snapshotUpdatedAtByAgentId });
      }
    } catch (error) {
      if (subscriptionId) {
        await owner?.release();
      }
      const code = error instanceof SessionRequestError ? error.code : "fetch_agents_failed";
      const message = error instanceof Error ? error.message : "Failed to fetch agents";
      this.sessionLogger.error({ err: error }, "Failed to handle fetch_agents_request");
      this.emit({
        type: "rpc_error",
        payload: {
          requestId: request.requestId,
          requestType: request.type,
          error: message,
          code,
        },
      });
    }
  }

  private async handleFetchAgentHistory(
    request: Extract<SessionInboundMessage, { type: "fetch_agent_history_request" }>,
  ): Promise<void> {
    try {
      const payload = await this.listFetchAgentsEntries(
        request,
        this.resolveBackgroundVisibility(request.filter?.includeBackground),
      );
      this.emit({
        type: "fetch_agent_history_response",
        payload: {
          requestId: request.requestId,
          ...payload,
        },
      });
    } catch (error) {
      const code = error instanceof SessionRequestError ? error.code : "fetch_agent_history_failed";
      const message = error instanceof Error ? error.message : "Failed to fetch agent history";
      this.sessionLogger.error({ err: error }, "Failed to handle fetch_agent_history_request");
      this.emit({
        type: "rpc_error",
        payload: {
          requestId: request.requestId,
          requestType: request.type,
          error: message,
          code,
        },
      });
    }
  }

  private async handleFetchRecentProviderSessions(
    request: Extract<SessionInboundMessage, { type: "fetch_recent_provider_sessions_request" }>,
  ): Promise<void> {
    try {
      const result = await listImportableProviderSessions({
        request,
        agentManager: this.agentManager,
        agentStorage: this.agentStorage,
        providerSnapshotManager: this.providerSnapshotManager,
      });
      this.emit({
        type: "fetch_recent_provider_sessions_response",
        payload: {
          requestId: request.requestId,
          entries: result.entries,
          ...(result.filteredAlreadyImportedCount > 0
            ? { filteredAlreadyImportedCount: result.filteredAlreadyImportedCount }
            : {}),
          ...(result.providerErrors.length > 0 ? { providerErrors: result.providerErrors } : {}),
        },
      });
    } catch (error) {
      const code =
        error instanceof ImportSessionsRequestError
          ? error.code
          : "fetch_recent_provider_sessions_failed";
      const message =
        error instanceof Error ? error.message : "Failed to fetch recent provider sessions";
      this.sessionLogger.error(
        { err: error },
        "Failed to handle fetch_recent_provider_sessions_request",
      );
      this.emit({
        type: "rpc_error",
        payload: {
          requestId: request.requestId,
          requestType: request.type,
          error: message,
          code,
        },
      });
    }
  }

  private async handleFetchWorkspacesRequest(
    request: Extract<SessionInboundMessage, { type: "fetch_workspaces_request" }>,
  ): Promise<void> {
    const owner = request.subscribe
      ? this.delivery.begin("workspaces", request.subscribe.subscriptionId, async (id) => {
          this.workspaceUpdatesSubscriptions.delete(id);
          this.refreshObservationProducers();
          await this.reconcileWorkspaceGitObservers();
        })
      : null;
    const subscriptionId = owner?.responseId;
    const subscription: WorkspaceUpdatesSubscriptionState | null = owner
      ? {
          subscriptionId: owner.id,
          owner,
          syncEnabled: Boolean(request.sync),
          filter: {
            ...request.filter,
            ...(request.includeBackground ? { includeBackground: true } : {}),
          },
          isBootstrapping: true,
          pendingUpdatesByWorkspaceId: new Map(),
          lastEmittedByWorkspaceId: new Map(),
          visibleEmptyProjectIds: new Set(),
        }
      : null;
    if (subscription) {
      this.workspaceUpdatesSubscriptions.set(subscription.subscriptionId, subscription);
      this.refreshObservationProducers();
    }
    try {
      this.sessionLogger.debug(
        {
          requestId: request.requestId,
          subscribeRequested: Boolean(request.subscribe),
          filter: request.filter ?? null,
          sort: request.sort ?? null,
          page: request.page ?? null,
        },
        "fetch_workspaces_request_received",
      );
      const payload = request.sync
        ? await this.readWorkspaceDirectorySync(request)
        : await this.listFetchWorkspacesEntries(request);

      this.sessionLogger.debug(
        {
          requestId: request.requestId,
          subscriptionId,
          pageInfo: payload.pageInfo,
          payload: summarizeFetchWorkspacesEntries(payload.entries),
        },
        "fetch_workspaces_response_ready",
      );
      const snapshot = this.buildBootstrapSnapshot(payload.entries);
      if (subscription) {
        this.seedWorkspaceSubscriptionSnapshot(
          subscription,
          payload.entries,
          payload.emptyProjects,
        );
      }

      this.emit({
        type: "fetch_workspaces_response",
        payload: {
          requestId: request.requestId,
          ...(subscriptionId ? { subscriptionId } : {}),
          ...payload,
        },
      });

      if (subscription) {
        await this.reconcileWorkspaceGitObservers();
        this.flushBootstrappedWorkspaceUpdates(subscription, snapshot);
      }
    } catch (error) {
      await owner?.release();
      const code = error instanceof SessionRequestError ? error.code : "fetch_workspaces_failed";
      const message = error instanceof Error ? error.message : "Failed to fetch workspaces";
      this.sessionLogger.error({ err: error }, "Failed to handle fetch_workspaces_request");
      this.emit({
        type: "rpc_error",
        payload: {
          requestId: request.requestId,
          requestType: request.type,
          error: message,
          code,
        },
      });
    }
  }

  private async handleProjectListRequest(
    request: Extract<SessionInboundMessage, { type: "project.list.request" }>,
  ): Promise<void> {
    try {
      const projects = await Promise.all(
        (await this.projectRegistry.list())
          .filter((project) => !project.archivedAt)
          .map((project) => this.buildProjectDescriptor(project)),
      );
      const synchronized = request.sync
        ? this.directorySync.synchronizeProjects(projects, request.sync)
        : null;
      this.emit({
        type: "project.list.response",
        payload: {
          requestId: request.requestId,
          ...(synchronized ?? { projects }),
        },
      });
    } catch (error) {
      this.sessionLogger.error({ err: error }, "Failed to handle project.list.request");
      this.emit({
        type: "rpc_error",
        payload: {
          requestId: request.requestId,
          requestType: "project.list.request",
          error: error instanceof Error ? error.message : "Failed to list projects",
          code: "project_list_failed",
        },
      });
    }
  }

  private async handleProjectSuggestionsRequest(
    request: Extract<SessionInboundMessage, { type: "project.suggestions.request" }>,
  ): Promise<void> {
    try {
      const result = await listProjectSuggestions({
        request,
        agentManager: this.agentManager,
        projectRegistry: this.projectRegistry,
        workspaceGitService: this.workspaceGitService,
      });
      this.emit({
        type: "project.suggestions.response",
        payload: { requestId: request.requestId, ...result },
      });
    } catch (error) {
      this.sessionLogger.error({ err: error }, "Failed to handle project.suggestions.request");
      this.emit({
        type: "rpc_error",
        payload: {
          requestId: request.requestId,
          requestType: request.type,
          error: error instanceof Error ? error.message : "Failed to list project suggestions",
          code:
            error instanceof ProjectSuggestionsRequestError
              ? error.code
              : "project_suggestions_failed",
        },
      });
    }
  }

  private requireWorkspaceLabels(): WorkspaceLabelService {
    if (!this.workspaceLabelService) {
      throw new SessionRequestError("workspace_labels_unavailable", "Workspace labels unavailable");
    }
    return this.workspaceLabelService;
  }

  private emitWorkspaceLabelError(
    request: { requestId: string; type: string },
    error: unknown,
  ): void {
    this.emit({
      type: "rpc_error",
      payload: {
        requestId: request.requestId,
        requestType: request.type,
        code: workspaceLabelErrorCode(error),
        error: error instanceof Error ? error.message : "Workspace label operation failed",
      },
    });
  }

  private async handleWorkspaceLabelList(
    request: Extract<SessionInboundMessage, { type: "workspace.label.list.request" }>,
  ): Promise<void> {
    const service = this.requireWorkspaceLabels();
    if (!request.subscribe) {
      this.emit({
        type: "workspace.label.list.response",
        payload: { requestId: request.requestId, ...(await service.list(request.sync)) },
      });
      return;
    }
    let bootstrap: ReturnType<typeof service.subscribe> | undefined;
    const owner = this.delivery.begin("labels", request.subscribe.subscriptionId, async () => {
      await bootstrap?.then(
        (subscription) => subscription.unsubscribe(),
        () => undefined,
      );
    });
    try {
      type LiveChange = Parameters<Parameters<typeof service.subscribe>[0]["onChange"]>[0];
      const pending = new Map<string, LiveChange>();
      let ready = false;
      const emitChange = (change: LiveChange): void => {
        owner.emit({
          type: "workspace.label.update",
          payload: change,
        });
      };
      bootstrap = service.subscribe({
        cursor: request.sync,
        onChange: (change) => {
          if (owner.signal.aborted) return;
          if (!ready)
            pending.set(change.kind === "upsert" ? change.label.name : change.name, change);
          else emitChange(change);
        },
      });
      const subscription = await bootstrap;
      if (owner.signal.aborted) return;
      this.emit({
        type: "workspace.label.list.response",
        payload: {
          requestId: request.requestId,
          subscriptionId: owner.responseId,
          ...subscription.snapshot,
        },
      });
      ready = true;
      for (const change of pending.values()) {
        if (change.seq > subscription.snapshot.sync.headSeq) emitChange(change);
      }
      pending.clear();
    } catch (error) {
      await owner.release();
      this.emitWorkspaceLabelError(request, error);
    }
  }

  private async handleWorkspaceLabelAssignment(
    request: Extract<SessionInboundMessage, { type: "workspace.label.assignment.set.request" }>,
  ): Promise<void> {
    try {
      const result = await this.requireWorkspaceLabels().setAssignment(request);
      this.emit({
        type: "workspace.label.assignment.set.response",
        payload: { requestId: request.requestId, ...result },
      });
    } catch (error) {
      this.emitWorkspaceLabelError(request, error);
    }
  }

  private async handleWorkspaceLabelUpdate(
    request: Extract<SessionInboundMessage, { type: "workspace.label.update.request" }>,
  ): Promise<void> {
    try {
      const result = await this.requireWorkspaceLabels().update(request);
      this.emit({
        type: "workspace.label.update.response",
        payload: { requestId: request.requestId, ...result },
      });
    } catch (error) {
      this.emitWorkspaceLabelError(request, error);
    }
  }

  private async handleWorkspaceLabelDelete(
    request: Extract<SessionInboundMessage, { type: "workspace.label.delete.request" }>,
  ): Promise<void> {
    try {
      const result = await this.requireWorkspaceLabels().delete(request.name);
      this.emit({
        type: "workspace.label.delete.response",
        payload: { requestId: request.requestId, ...result },
      });
    } catch (error) {
      this.emitWorkspaceLabelError(request, error);
    }
  }

  private async handleWorkspaceLabelDeleteInspection(
    request: Extract<SessionInboundMessage, { type: "workspace.label.delete.inspect.request" }>,
  ): Promise<void> {
    try {
      const affectedWorkspaceCount = await this.requireWorkspaceLabels().countAffectedWorkspaces(
        request.name,
      );
      this.emit({
        type: "workspace.label.delete.inspect.response",
        payload: { requestId: request.requestId, affectedWorkspaceCount },
      });
    } catch (error) {
      this.emitWorkspaceLabelError(request, error);
    }
  }

  private async readAgentDirectorySync(
    request: Extract<SessionInboundMessage, { type: "fetch_agents_request" }>,
    backgroundVisibility: BackgroundVisibility,
  ) {
    if (request.scope !== "active" || request.filter) {
      throw new SessionRequestError(
        "invalid_request",
        "Sequenced agent directory reads require scope=active and no filter.",
      );
    }
    // The canonical collection is complete; only the read below is scoped.
    const snapshot = await this.listFetchAgentsEntries(
      { ...request, page: { limit: Number.MAX_SAFE_INTEGER } },
      true,
    );
    const result = this.directorySync.synchronizeAgents(
      snapshot.entries,
      request.sync ?? {},
      backgroundVisibility,
    );
    const entries = await Promise.all(
      result.entries.map(async (entry) =>
        (await this.agentDirectory.includes(entry.agent, backgroundVisibility)) ? entry : null,
      ),
    );
    return { ...result, entries: entries.filter((entry) => entry !== null) };
  }

  private async readWorkspaceDirectorySync(
    request: Extract<SessionInboundMessage, { type: "fetch_workspaces_request" }>,
  ) {
    if (request.filter)
      throw new SessionRequestError(
        "invalid_request",
        "Sequenced workspace directory reads do not support filters.",
      );
    const result = this.directorySync.synchronizeWorkspaces(
      await this.workspaceDirectory.listDescriptors(),
      request.sync ?? {},
      request.includeBackground,
    );
    return {
      ...result,
      entries: result.entries.filter(
        (workspace) => request.includeBackground || !workspace.background,
      ),
    };
  }

  // Build the bootstrap snapshot used by `flushBootstrappedWorkspaceUpdates`
  // to decide which pending updates to drop. Captures the status,
  // statusEnteredAt, and activityAt (parsed to ms) for each workspace entry
  // so a status-only change (e.g. the unmask case), a statusEnteredAt-only
  // change (e.g. a fresh unmask time), AND a fresher activity all still
  // ship to the client.
  private buildBootstrapSnapshot(entries: FetchWorkspacesResponseEntry[]): {
    snapshotByWorkspaceId: Map<
      string,
      { status: string; statusEnteredAt: string | null; activityAtMs: number | null }
    >;
  } {
    const snapshotByWorkspaceId = new Map<
      string,
      { status: string; statusEnteredAt: string | null; activityAtMs: number | null }
    >();
    for (const entry of entries) {
      const parsedActivity = entry.activityAt ? Date.parse(entry.activityAt) : null;
      snapshotByWorkspaceId.set(entry.id, {
        status: entry.status,
        statusEnteredAt: entry.statusEnteredAt ?? null,
        activityAtMs: Number.isNaN(parsedActivity) ? null : parsedActivity,
      });
    }
    return { snapshotByWorkspaceId };
  }

  private async reconcileWorkspaceGitObservers(): Promise<void> {
    const all = this.wantsEvent("checkout_status_update")
      ? await this.workspaceDirectory.listObservationTargets()
      : [];
    const entries = [...this.workspaceUpdatesSubscriptions.values()].flatMap((subscription) =>
      [...subscription.lastEmittedByWorkspaceId.values()].flatMap((update) =>
        update.kind === "upsert" ? [update.workspace] : [],
      ),
    );
    this.workspaceGitObserver.reconcileObservers(
      this.wantsEvent("checkout_status_update") ? [...entries, ...all] : entries,
    );
  }

  private seedWorkspaceSubscriptionSnapshot(
    subscription: WorkspaceUpdatesSubscriptionState,
    entries: FetchWorkspacesResponseEntry[],
    emptyProjects: WorkspaceProjectDescriptorPayload[],
  ): void {
    if (this.workspaceUpdatesSubscriptions.get(subscription.subscriptionId) !== subscription)
      return;
    for (const entry of entries) {
      subscription.lastEmittedByWorkspaceId.set(entry.id, {
        kind: "upsert",
        workspace: entry,
      });
    }
    for (const project of emptyProjects) {
      subscription.visibleEmptyProjectIds?.add(project.projectId);
    }
  }

  private async registerWorkspaceForImportedAgent(
    workspace: PersistedWorkspaceRecord,
  ): Promise<void> {
    try {
      await this.syncWorkspaceGitObserverForWorkspace(workspace);
      await this.describeWorkspaceRecord(workspace);
      await this.emitWorkspaceUpdateForWorkspaceId(workspace.workspaceId);
    } catch (error) {
      this.sessionLogger.warn(
        { err: error, workspaceId: workspace.workspaceId, cwd: workspace.cwd },
        "Failed to register workspace for imported agent",
      );
    }
  }

  private async resolveCreationCaller(
    callerAgentId?: string,
  ): Promise<(CreateAgentCaller & { background?: boolean }) | null> {
    if (!callerAgentId) return null;
    let caller: (CreateAgentCaller & { background?: boolean }) | null =
      this.agentManager.getAgent(callerAgentId);
    if (!caller) {
      const stored = await this.agentStorage.get(callerAgentId);
      if (stored && !stored.archivedAt) caller = stored;
    }
    if (!caller) throw new Error(`Caller agent ${callerAgentId} not found`);
    return {
      id: caller.id,
      cwd: caller.cwd,
      workspaceId: caller.workspaceId,
      background: caller.background,
    };
  }

  private async workspaceBackgroundIntent(
    background: boolean | undefined,
    callerAgentId: string | undefined,
  ): Promise<{ background?: boolean; callerWorkspaceId?: string }> {
    const caller = await this.resolveCreationCaller(callerAgentId);
    return {
      background: inheritWorkspaceBackground(background, caller),
      callerWorkspaceId: caller?.workspaceId,
    };
  }

  private async createRequestedWorkspace(
    request: Extract<SessionInboundMessage, { type: "workspace.create.request" }>,
    workspaceId?: string,
  ): Promise<WorkspaceDescriptorPayload> {
    if (request.internal)
      throw new Error(
        "Public internal workspaces were removed; use background workspace creation.",
      );
    if (request.agent?.background !== undefined)
      throw new Error("Configure background on the workspace, not its initial agent.");
    let creationRequest = request;
    // Hooks belong to the operation: retries fingerprint the caller's input
    // and must not rerun hooks or compare their potentially changing output.
    if (this.pluginRuntime) {
      const { type, requestId, ...input } = request;
      const transformed = await this.pluginRuntime.before("workspace.create.before", input);
      creationRequest = { ...transformed, type, requestId };
    }
    return creationRequest.source.kind === "directory"
      ? this.handleWorkspaceCreateLocal(creationRequest, workspaceId)
      : this.handleWorkspaceCreateWorktree(creationRequest, workspaceId);
  }

  private async handleWorkspaceCreateLocal(
    request: Extract<SessionInboundMessage, { type: "workspace.create.request" }>,
    workspaceId?: string,
  ): Promise<WorkspaceDescriptorPayload> {
    if (request.source.kind !== "directory") {
      throw new Error("Unexpected workspace source");
    }

    const cwd = expandTilde(request.source.path);
    const directoryExists = await this.filesystem.isDirectory(cwd).catch(() => false);
    if (!directoryExists) {
      throw new SessionRequestError("directory_not_found", `Directory not found: ${cwd}`);
    }

    const explicitTitle = request.title?.trim() || null;
    const promptTitle = resolveFirstAgentPromptTitle(request.firstAgentContext);
    const workspace = await this.workspaceProvisioning.createWorkspaceForDirectory(
      cwd,
      explicitTitle ?? promptTitle,
      request.source.projectId,
      {
        expectsInitialAgent: Boolean(request.firstAgentContext),
        workspaceId,
        ...(await this.workspaceBackgroundIntent(request.background, request.callerAgentId)),
      },
    );
    await this.syncWorkspaceGitObserverForWorkspace(workspace);
    const descriptor = await this.describeWorkspaceRecord(workspace);
    await this.emitCreatedWorkspaceUpdate(
      descriptor,
      request.firstAgentContext ? "running" : undefined,
    );
    void this.workspaceGitService
      .getSnapshot(workspace.cwd, { force: true, includeForge: true, reason: "open_project" })
      .catch((error) => {
        this.sessionLogger.warn(
          { err: error, cwd: workspace.cwd },
          "Background snapshot refresh failed after workspace.create",
        );
      });
    if (request.firstAgentContext) {
      const firstAgentContext = request.firstAgentContext;
      this.workspaceAutoName.scheduleForDirectory(
        {
          workspaceId: workspace.workspaceId,
          cwd: workspace.cwd,
          firstAgentContext,
        },
        { currentSelection: this.getFocusedAgentSelectionForCwd(workspace.cwd) },
      );
    }
    return descriptor;
  }

  private async handleWorkspaceCreateWorktree(
    request: Extract<SessionInboundMessage, { type: "workspace.create.request" }>,
    workspaceId?: string,
  ): Promise<WorkspaceDescriptorPayload> {
    if (request.source.kind !== "worktree") {
      throw new Error("Unexpected workspace source");
    }

    const source = request.source;

    if (!source.cwd && !source.projectId) {
      throw new SessionRequestError(
        "source_required",
        "cwd or projectId is required for a worktree-backed workspace",
      );
    }

    const sourceCwd = await resolveWorktreeSourceCwd(source, this.projectRegistry);

    const result = await this.createNeolixWorktreeWorkflow(
      {
        cwd: sourceCwd,
        workspaceId,
        projectId: source.projectId,
        worktreeSlug: source.worktreeSlug,
        action: source.action,
        refName: source.refName,
        branchName: source.branchName,
        checkoutSource: source.checkoutSource,
        githubPrNumber: source.githubPrNumber,
        firstAgentContext: request.firstAgentContext,
        title: request.title,
        ...(await this.workspaceBackgroundIntent(request.background, request.callerAgentId)),
      },
      source.baseBranch
        ? { resolveDefaultBranch: async () => source.baseBranch as string }
        : undefined,
    );

    const descriptor = await this.describeCreatedWorktreeWorkspace(result);
    await this.emitCreatedWorkspaceUpdate(
      descriptor,
      request.firstAgentContext ? "running" : undefined,
    );
    return descriptor;
  }

  private async handleOpenProjectRequest(
    request: Extract<SessionInboundMessage, { type: "open_project_request" }>,
  ): Promise<void> {
    const requestedCwd = request.cwd;
    const cwd = expandTilde(requestedCwd);
    const directoryExists = await this.filesystem.isDirectory(cwd).catch(() => false);
    if (!directoryExists) {
      this.sessionLogger.info(
        { requestedCwd, resolvedCwd: cwd, reason: "directory_not_found" },
        "Open project rejected",
      );
      this.emit({
        type: "open_project_response",
        payload: {
          requestId: request.requestId,
          workspace: null,
          error: `Directory not found: ${cwd}`,
          errorCode: "directory_not_found",
        },
      });
      return;
    }

    try {
      const projectsBefore = new Map<string, PersistedProjectRecord>();
      for (const project of await this.projectRegistry.list()) {
        projectsBefore.set(project.projectId, project);
      }
      const workspacesBefore = new Map<string, PersistedWorkspaceRecord>();
      for (const workspaceRecord of await this.workspaceRegistry.listActive()) {
        workspacesBefore.set(workspaceRecord.workspaceId, workspaceRecord);
      }
      const workspace = await this.workspaceProvisioning.findOrCreateWorkspaceForDirectory(cwd);
      const project = await this.projectRegistry.get(workspace.projectId);
      await this.syncWorkspaceGitObserverForWorkspace(workspace);
      const descriptor = await this.describeWorkspaceRecord(workspace);
      await this.emitWorkspaceUpdateForWorkspaceId(workspace.workspaceId);
      this.sessionLogger.info(
        {
          requestedCwd,
          resolvedCwd: cwd,
          workspaceCwd: workspace.cwd,
          workspaceId: workspace.workspaceId,
          workspaceKind: workspace.kind,
          workspaceTransition: describeRegistryTransition(
            workspacesBefore.get(workspace.workspaceId) ?? null,
          ),
          projectId: workspace.projectId,
          projectKind: project?.kind ?? null,
          projectTransition: describeRegistryTransition(
            projectsBefore.get(workspace.projectId) ?? null,
          ),
        },
        "Project opened",
      );
      this.emit({
        type: "open_project_response",
        payload: {
          requestId: request.requestId,
          workspace: descriptor,
          error: null,
        },
      });
      void this.workspaceGitService
        .getSnapshot(workspace.cwd, {
          force: true,
          includeForge: true,
          reason: "open_project",
        })
        .catch((error) => {
          this.sessionLogger.warn(
            { err: error, cwd: workspace.cwd },
            "Background snapshot refresh failed after open_project",
          );
        });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to open project";
      this.sessionLogger.error({ err: error, cwd }, "Failed to open project");
      this.emit({
        type: "open_project_response",
        payload: {
          requestId: request.requestId,
          workspace: null,
          error: message,
        },
      });
    }
  }

  private async handleProjectAddRequest(
    request: Extract<SessionInboundMessage, { type: "project.add.request" }>,
  ): Promise<void> {
    const requestedCwd = request.cwd;
    const cwd = expandTilde(requestedCwd);
    const directoryExists = await this.filesystem.isDirectory(cwd).catch(() => false);
    if (!directoryExists) {
      this.sessionLogger.info(
        { requestedCwd, resolvedCwd: cwd, reason: "directory_not_found" },
        "Add project rejected",
      );
      this.emit({
        type: "project.add.response",
        payload: {
          requestId: request.requestId,
          project: null,
          error: `Directory not found: ${cwd}`,
          errorCode: "directory_not_found",
        },
      });
      return;
    }

    try {
      const projectsBefore = new Map<string, PersistedProjectRecord>();
      for (const project of await this.projectRegistry.list()) {
        projectsBefore.set(project.projectId, project);
      }
      const project = await this.workspaceProvisioning.findOrCreateProjectForDirectory(cwd);
      this.sessionLogger.info(
        {
          requestedCwd,
          resolvedCwd: cwd,
          projectId: project.projectId,
          projectKind: project.kind,
          projectTransition: describeRegistryTransition(
            projectsBefore.get(project.projectId) ?? null,
          ),
        },
        "Project added",
      );
      this.emit({
        type: "project.add.response",
        payload: {
          requestId: request.requestId,
          project: await this.buildProjectDescriptor(project),
          error: null,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to add project";
      this.sessionLogger.error({ err: error, cwd }, "Failed to add project");
      this.emit({
        type: "project.add.response",
        payload: {
          requestId: request.requestId,
          project: null,
          error: message,
        },
      });
    }
  }

  private async handleProjectCreateDirectoryRequest(
    request: Extract<SessionInboundMessage, { type: "project.create_directory.request" }>,
  ): Promise<void> {
    try {
      const result = await createProjectDirectory(
        { parentPath: request.parentPath, name: request.name },
        {
          registerProject: (directoryPath) =>
            this.workspaceProvisioning.findOrCreateProjectForDirectory(directoryPath),
        },
      );
      this.emit({
        type: "project.create_directory.response",
        payload: {
          requestId: request.requestId,
          directoryPath: result.directoryPath,
          project: await this.buildProjectDescriptor(result.project),
          error: null,
          errorCode: null,
        },
      });
    } catch (error) {
      const requestError =
        error instanceof ProjectDirectoryRequestError
          ? error
          : new ProjectDirectoryRequestError(
              "registration_failed",
              error instanceof Error ? error.message : "Failed to create project directory",
            );
      this.sessionLogger.error(
        {
          err: error,
          parentPath: request.parentPath,
          name: request.name,
          errorCode: requestError.code,
        },
        "Failed to create project directory",
      );
      this.emit({
        type: "project.create_directory.response",
        payload: {
          requestId: request.requestId,
          directoryPath: requestError.directoryPath,
          project: null,
          error: requestError.message,
          errorCode: requestError.code,
        },
      });
    }
  }

  private async handleWorkspaceGithubSearchRepositoriesRequest(
    request: Extract<
      SessionInboundMessage,
      { type: "workspace.github.search_repositories.request" }
    >,
  ): Promise<void> {
    try {
      const searchRepositories = (this.github as Partial<GitHubService>).searchRepositories;
      if (!searchRepositories) {
        throw new Error("GitHub repository search is unavailable");
      }
      const repositories = await searchRepositories.call(this.github, {
        cwd: homedir(),
        query: request.query,
        limit: request.limit,
      });
      this.emit({
        type: "workspace.github.search_repositories.response",
        payload: {
          requestId: request.requestId,
          repositories,
          status: "success",
          available: true,
          error: null,
        },
      });
    } catch (error) {
      const missing = error instanceof GitHubCliMissingError;
      const unauthenticated = error instanceof GitHubAuthenticationError;
      const commandError = error instanceof GitHubCommandError ? error.stderr.trim() : "";
      let message: string;
      if (missing) {
        message = "GitHub CLI (gh) is not installed or not in PATH";
      } else if (unauthenticated) {
        message = "GitHub CLI is not authenticated. Run gh auth login on the host.";
      } else if (commandError) {
        message = commandError;
      } else {
        message = error instanceof Error ? error.message : "GitHub search failed";
      }
      let payload: WorkspaceGithubSearchRepositoriesResponsePayload;
      if (missing) {
        payload = {
          status: "unavailable",
          requestId: request.requestId,
          repositories: [],
          reason: "gh_missing",
          available: false,
          error: message,
        };
      } else if (unauthenticated) {
        payload = {
          status: "unauthenticated",
          requestId: request.requestId,
          repositories: [],
          available: false,
          error: message,
        };
      } else {
        payload = {
          status: "error",
          requestId: request.requestId,
          repositories: [],
          available: true,
          error: message,
        };
      }
      this.sessionLogger.warn({ err: error }, "GitHub repository search failed");
      this.emit({
        type: "workspace.github.search_repositories.response",
        payload,
      });
    }
  }

  private async handleProjectGithubCloneRequest(
    request: Extract<SessionInboundMessage, { type: "project.github.clone.request" }>,
  ): Promise<void> {
    let normalizedRepo = request.repo;
    let checkoutPath: string | null = null;
    try {
      const repo = normalizeCloneRepository({
        repo: request.repo,
        cloneProtocol: request.cloneProtocol,
      });
      normalizedRepo = repo.displayName;
      const targetParent = resolve(expandTilde(request.targetDirectory.trim()));
      checkoutPath = resolve(targetParent, repo.name);
      if (!this.isPathWithinRoot(targetParent, checkoutPath)) {
        throw new Error("Resolved checkout path must stay inside the target directory");
      }

      await mkdir(targetParent, { recursive: true });
      try {
        await lstat(checkoutPath);
        throw new Error(`Checkout path already exists: ${checkoutPath}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }

      const cloneStagingPath = await mkdtemp(resolve(targetParent, ".neolix-clone-"));
      try {
        await runGitCommand(["clone", repo.cloneUrl, cloneStagingPath], {
          cwd: targetParent,
          timeout: 5 * 60 * 1000,
          maxOutputBytes: 1024 * 1024,
          logger: this.sessionLogger,
        });
        await rename(cloneStagingPath, checkoutPath);
      } catch (error) {
        await rm(cloneStagingPath, { recursive: true, force: true }).catch((cleanupError) => {
          this.sessionLogger.warn(
            { err: cleanupError, cloneStagingPath },
            "Failed to clean up partial GitHub clone",
          );
        });
        throw error;
      }

      const project =
        await this.workspaceProvisioning.findOrCreateProjectForDirectory(checkoutPath);

      this.emit({
        type: "project.github.clone.response",
        payload: {
          requestId: request.requestId,
          repo: repo.displayName,
          checkoutPath,
          project: await this.buildProjectDescriptor(project),
          error: null,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to clone GitHub repo";
      this.sessionLogger.error(
        { err: error, repo: request.repo, targetDirectory: request.targetDirectory },
        "Failed to clone GitHub project",
      );
      this.emit({
        type: "project.github.clone.response",
        payload: {
          requestId: request.requestId,
          repo: normalizedRepo,
          checkoutPath,
          project: null,
          error: message,
        },
      });
    }
  }

  // Named accessor: the workspace descriptor builder and the git-watch test both read a workspace's
  // scripts snapshot through here; the workspace-scripts module owns the payload assembly.
  private buildWorkspaceScriptPayloadSnapshot(
    workspace: PersistedWorkspaceRecord,
    project: PersistedProjectRecord | null,
  ): Promise<WorkspaceDescriptorPayload["scripts"]> {
    return this.workspaceScripts.buildSnapshot(workspace, project);
  }

  private handleStartWorkspaceScriptRequest(request: StartWorkspaceScriptRequest): Promise<void> {
    return this.workspaceScripts.start(request);
  }

  private async handleWorkspaceScriptListRequest(
    request: WorkspaceScriptListRequest,
  ): Promise<void> {
    try {
      const scripts = await this.workspaceScripts.list(request.workspaceId);
      this.emit({
        type: "workspace.script.list.response",
        payload: {
          requestId: request.requestId,
          workspaceId: request.workspaceId,
          scripts,
          error: null,
        },
      });
    } catch (error) {
      this.emit({
        type: "workspace.script.list.response",
        payload: {
          requestId: request.requestId,
          workspaceId: request.workspaceId,
          scripts: [],
          error: error instanceof Error ? error.message : "Failed to list workspace scripts",
        },
      });
    }
  }

  private async handleWorkspaceScriptStartRequest(
    request: WorkspaceScriptStartRequest,
  ): Promise<void> {
    try {
      const script = await this.workspaceScripts.launch(request);
      this.emit({
        type: "workspace.script.start.response",
        payload: {
          requestId: request.requestId,
          workspaceId: request.workspaceId,
          scriptName: request.scriptName,
          script,
          error: null,
        },
      });
    } catch (error) {
      this.emit({
        type: "workspace.script.start.response",
        payload: {
          requestId: request.requestId,
          workspaceId: request.workspaceId,
          scriptName: request.scriptName,
          script: null,
          error: error instanceof Error ? error.message : "Failed to start workspace script",
        },
      });
    }
  }

  private async handleWorkspaceScriptStopRequest(
    request: WorkspaceScriptStopRequest,
  ): Promise<void> {
    try {
      const script = await this.workspaceScripts.stop(request);
      this.emit({
        type: "workspace.script.stop.response",
        payload: {
          requestId: request.requestId,
          workspaceId: request.workspaceId,
          scriptName: request.scriptName,
          script,
          error: null,
        },
      });
    } catch (error) {
      this.emit({
        type: "workspace.script.stop.response",
        payload: {
          requestId: request.requestId,
          workspaceId: request.workspaceId,
          scriptName: request.scriptName,
          script: null,
          error: error instanceof Error ? error.message : "Failed to stop workspace script",
        },
      });
    }
  }

  // COMPAT(desktopEditorBridge): added in v0.1.88, remove after 2026-12-03 once old clients no longer call daemon editor RPCs.
  private async handleLegacyListAvailableEditorsRequest(
    request: Extract<SessionInboundMessage, { type: "list_available_editors_request" }>,
  ): Promise<void> {
    this.emit({
      type: "list_available_editors_response",
      payload: {
        requestId: request.requestId,
        editors: [],
        error: "Editor opening moved to the desktop app and is no longer supported by the daemon",
      },
    });
  }

  private async handleLegacyOpenInEditorRequest(
    request: Extract<SessionInboundMessage, { type: "open_in_editor_request" }>,
  ): Promise<void> {
    this.emit({
      type: "open_in_editor_response",
      payload: {
        requestId: request.requestId,
        error: "Editor opening moved to the desktop app and is no longer supported by the daemon",
      },
    });
  }

  private async handleCreateNeolixWorktreeRequest(
    request: Extract<SessionInboundMessage, { type: "create_neolix_worktree_request" }>,
  ): Promise<void> {
    return handleCreateWorktreeRequest(
      {
        neolixHome: this.neolixHome,
        worktreesRoot: this.worktreesRoot,
        describeWorkspaceRecord: (result) => this.describeCreatedWorktreeWorkspace(result),
        emit: (message) => this.emit(message),
        sessionLogger: this.sessionLogger,
        createNeolixWorktreeWorkflow: (input) => this.createNeolixWorktreeWorkflow(input),
      },
      request,
    );
  }

  private async createNeolixWorktreeWorkflow(
    input: CreateNeolixWorktreeInput,
    options?: {
      resolveDefaultBranch?: (repoRoot: string) => Promise<string>;
    },
  ): Promise<CreateNeolixWorktreeWorkflowResult> {
    return createWorktreeWorkflow(
      {
        neolixHome: this.neolixHome,
        worktreesRoot: this.worktreesRoot,
        createNeolixWorktree: (workflowInput, serviceOptions) =>
          this.createNeolixWorktree(workflowInput, serviceOptions),
        warmWorkspaceGitData: (workspace) => this.warmWorkspaceGitDataForWorkspace(workspace),
        autoNameWorkspaceBranchForFirstAgent: (autoNameInput) =>
          this.workspaceAutoName.scheduleForWorktree(autoNameInput, {
            currentSelection: this.getFocusedAgentSelectionForCwd(autoNameInput.workspace.cwd),
          }),
        startWorkspaceSetup: (workspaceId, operation) =>
          this.workspaceSetupRuntime.start(workspaceId, operation),
        assertWorkspaceAutomationAllowed: (workspaceId) =>
          assertWorkspaceAutomationAllowedForWorkspace(this.workspaceRegistry, workspaceId),
        emitWorkspaceUpdateForWorkspaceId: (workspaceId) =>
          this.emitWorkspaceUpdateForWorkspaceId(workspaceId),
        cacheWorkspaceSetupSnapshot: (workspaceId, snapshot) => {
          this.workspaceSetupObservation.cache(workspaceId, snapshot);
        },
        emit: (message) => this.emit(message),
        sessionLogger: this.sessionLogger,
        terminalManager: this.terminalManager,
        serviceProxy: this.serviceProxy,
        scriptRuntimeStore: this.scriptRuntimeStore,
        getDaemonTcpPort: this.getDaemonTcpPort,
        getDaemonTcpHost: this.getDaemonTcpHost,
        serviceProxyPublicBaseUrl: this.serviceProxyPublicBaseUrl,
        onScriptsChanged: (workspaceId, workspaceDirectory) => {
          this.workspaceScripts.emitStatusUpdate(workspaceId, workspaceDirectory);
        },
      },
      input,
      options,
    );
  }

  private async handleWorkspaceSetupStatusRequest(
    request: Extract<SessionInboundMessage, { type: "workspace_setup_status_request" }>,
  ): Promise<void> {
    return handleWorkspaceSetupStatusRequestMessage(
      {
        emit: (message) => this.emit(message),
        workspaceSetupSnapshots: this.workspaceSetupObservation,
        getWorkspace: (workspaceId) => this.workspaceRegistry.get(workspaceId),
      },
      request,
    );
  }

  private async handleWorkspaceSetupRunRequest(
    request: Extract<SessionInboundMessage, { type: "workspace.setup.run.request" }>,
  ): Promise<void> {
    return handleWorkspaceSetupRunRequestMessage(
      {
        getWorkspace: (workspaceId) => this.workspaceRegistry.get(workspaceId),
        clearAutomationBlock: (workspaceId) =>
          clearWorkspaceAutomationBlock(this.workspaceRegistry, workspaceId),
        startWorkspaceSetup: (workspaceId, operation) =>
          this.workspaceSetupRuntime.start(workspaceId, operation),
        neolixHome: this.neolixHome,
        worktreesRoot: this.worktreesRoot,
        emitWorkspaceUpdateForWorkspaceId: (workspaceId) =>
          this.emitWorkspaceUpdateForWorkspaceId(workspaceId),
        cacheWorkspaceSetupSnapshot: (workspaceId, snapshot) =>
          this.workspaceSetupObservation.cache(workspaceId, snapshot),
        emit: (message) => this.emit(message),
        sessionLogger: this.sessionLogger,
        terminalManager: this.terminalManager,
        serviceProxy: this.serviceProxy,
        scriptRuntimeStore: this.scriptRuntimeStore,
        getDaemonTcpPort: this.getDaemonTcpPort,
        getDaemonTcpHost: this.getDaemonTcpHost,
        serviceProxyPublicBaseUrl: this.serviceProxyPublicBaseUrl,
        onScriptsChanged: (workspaceId, workspaceDirectory) =>
          this.workspaceScripts.emitStatusUpdate(workspaceId, workspaceDirectory),
      },
      request,
    );
  }

  private async handleArchiveWorkspaceRequest(
    request: Extract<SessionInboundMessage, { type: "archive_workspace_request" }>,
  ): Promise<void> {
    try {
      const existing = await this.workspaceRegistry.get(request.workspaceId);
      if (!existing) {
        throw new Error(`Workspace not found: ${request.workspaceId}`);
      }

      await archiveByScope(
        {
          neolixHome: this.neolixHome,
          neolixWorktreesBaseRoot: this.worktreesRoot,
          github: this.github,
          workspaceGitService: this.workspaceGitService,
          agentManager: this.agentManager,
          agentStorage: this.agentStorage,
          findWorkspaceIdForCwd: (cwd) => this.findWorkspaceIdForCwd(cwd),
          getWorkspace: (workspaceId) => this.workspaceRegistry.get(workspaceId),
          listActiveWorkspaces: () => this.listActiveWorkspaceRefs(),
          archiveWorkspaceRecord: (workspaceId) => this.archiveWorkspaceRecord(workspaceId),
          emitWorkspaceUpdatesForWorkspaceIds: (workspaceIds) =>
            this.emitWorkspaceUpdatesForWorkspaceIds(workspaceIds),
          markWorkspaceArchiving: (workspaceIds, archivingAt) =>
            this.markWorkspaceArchiving(workspaceIds, archivingAt),
          clearWorkspaceArchiving: (workspaceIds) => this.clearWorkspaceArchiving(workspaceIds),
          assertWorkspaceAutomationAllowed: (workspaceId) =>
            assertWorkspaceAutomationAllowedForWorkspace(this.workspaceRegistry, workspaceId),
          killTerminalsForWorkspace: (workspaceId) =>
            this.terminalController.killTerminalsForWorkspace(workspaceId),
          stopWorkspaceSetup: (workspaceId) => this.workspaceSetupRuntime.stop(workspaceId),
          sessionLogger: this.sessionLogger,
        },
        {
          scope: { kind: "workspace", workspaceId: existing.workspaceId },
          requestId: request.requestId,
        },
      );

      const archivedWorkspace = await this.workspaceRegistry.get(request.workspaceId);
      const archivedAt = archivedWorkspace?.archivedAt ?? new Date().toISOString();
      this.emit({
        type: "archive_workspace_response",
        payload: {
          requestId: request.requestId,
          workspaceId: request.workspaceId,
          archivedAt,
          error: null,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to archive workspace";
      this.sessionLogger.error(
        { err: error, workspaceId: request.workspaceId },
        "Failed to archive workspace",
      );
      this.emit({
        type: "archive_workspace_response",
        payload: {
          requestId: request.requestId,
          workspaceId: request.workspaceId,
          archivedAt: null,
          error: message,
        },
      });
    }
  }

  private async handleWorkspaceClearAttentionRequest(
    request: Extract<SessionInboundMessage, { type: "workspace.clear_attention.request" }>,
  ): Promise<void> {
    const { requestId, workspaceId } = request;
    const requestedWorkspaceIds = Array.isArray(workspaceId) ? workspaceId : [workspaceId];
    let agents: AgentSnapshotPayload[];
    try {
      agents = await this.listAgentPayloads({
        workspaceIds: requestedWorkspaceIds,
        includeBackground: true,
      });
    } catch (error) {
      const message = getErrorMessage(error);
      const results = requestedWorkspaceIds.map((requestedWorkspaceId) => ({
        workspaceId: requestedWorkspaceId,
        clearedAgentIds: [],
        success: false,
        error: message,
      }));
      this.emit({
        type: "workspace.clear_attention.response",
        payload: {
          requestId,
          workspaceId,
          clearedAgentIds: [],
          results,
          success: false,
          error: message,
        },
      });
      return;
    }
    const results: Array<{
      workspaceId: string;
      clearedAgentIds: string[];
      success: boolean;
      error: string | null;
    }> = [];

    for (const requestedWorkspaceId of requestedWorkspaceIds) {
      const clearedAgentIds: string[] = [];
      try {
        const workspace = await this.workspaceRegistry.get(requestedWorkspaceId);
        if (!workspace || workspace.archivedAt) {
          throw new Error(`Workspace not found: ${requestedWorkspaceId}`);
        }

        // Clearing attention is scoped to the workspace that OWNS the agent, by
        // workspaceId — never by comparing cwd strings. A sibling workspace
        // sharing the same directory keeps its own agents' attention.
        const clearableAgentIds = agents
          .filter((agent) => !agent.archivedAt)
          .filter((agent) => agent.workspaceId === workspace.workspaceId)
          .filter((agent) => agent.requiresAttention === true)
          .filter((agent) => (agent.pendingPermissions?.length ?? 0) === 0)
          .filter((agent) => agent.attentionReason !== "permission")
          .map((agent) => agent.id);

        for (const agentId of clearableAgentIds) {
          const liveAgent = this.agentManager.getAgent(agentId);
          if (liveAgent) {
            await this.agentManager.clearAgentAttention(agentId);
            clearedAgentIds.push(agentId);
            continue;
          }

          const record = await this.agentStorage.get(agentId);
          if (
            !record ||
            record.internal ||
            record.archivedAt ||
            record.requiresAttention !== true
          ) {
            continue;
          }
          const nextRecord: StoredAgentRecord = {
            ...record,
            updatedAt: new Date().toISOString(),
            requiresAttention: false,
            attentionReason: null,
            attentionTimestamp: null,
          };
          await this.agentStorage.upsert(nextRecord);
          const agent = this.buildStoredAgentPayload(nextRecord);
          const project = await this.buildProjectPlacementForWorkspace(workspace);
          this.emit({
            type: "agent_update",
            payload: {
              kind: "upsert",
              agent,
              project,
            },
          });
          clearedAgentIds.push(agentId);
        }

        await this.emitWorkspaceUpdateForWorkspaceId(workspace.workspaceId);
        results.push({
          workspaceId: requestedWorkspaceId,
          clearedAgentIds,
          success: true,
          error: null,
        });
      } catch (error) {
        const message = getErrorMessage(error);
        this.sessionLogger.error(
          { err: error, workspaceId: requestedWorkspaceId },
          "Failed to clear workspace attention",
        );
        results.push({
          workspaceId: requestedWorkspaceId,
          clearedAgentIds,
          success: false,
          error: message,
        });
      }
    }

    const clearedAgentIds = results.flatMap((result) => result.clearedAgentIds);
    const failedResults = results.filter((result) => !result.success);
    this.emit({
      type: "workspace.clear_attention.response",
      payload: {
        requestId,
        workspaceId,
        clearedAgentIds,
        results,
        success: failedResults.length === 0,
        error:
          failedResults.length === 0
            ? null
            : failedResults
                .map((result) => result.error)
                .filter((error) => error !== null)
                .join("; "),
      },
    });
  }

  private async handleWorkspaceMarkUnreadRequest(
    request: Extract<SessionInboundMessage, { type: "workspace.mark_unread.request" }>,
  ): Promise<void> {
    const { requestId, workspaceId } = request;
    let markedAgentId: string | null = null;
    try {
      const workspace = await this.workspaceRegistry.get(workspaceId);
      if (!workspace || workspace.archivedAt) {
        throw new Error(`Workspace not found: ${workspaceId}`);
      }

      const agents = (
        await this.listAgentPayloads({
          workspaceIds: [workspaceId],
          includeBackground: true,
          includeAncestors: true,
        })
      ).filter((agent) => this.isProviderVisibleToClient(agent.provider));
      const agentsById = new Map(agents.map((agent) => [agent.id, agent] as const));
      const candidates = agents
        .filter((agent) => !agent.archivedAt && !agent.background)
        .filter((agent) => agent.workspaceId === workspace.workspaceId)
        .filter((agent) => resolveWorkspaceRootAgent(agent, agentsById)?.id === agent.id)
        .filter((agent) => agent.status === "idle" || agent.status === "closed")
        .filter((agent) => agent.requiresAttention !== true)
        .filter((agent) => (agent.pendingPermissions?.length ?? 0) === 0)
        .sort(
          (left, right) =>
            right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id),
        );
      const candidate = candidates[0];
      if (!candidate) {
        throw new Error(`Workspace has no finished agent to mark unread: ${workspaceId}`);
      }

      await this.agentManager.markAgentUnread(candidate.id);
      markedAgentId = candidate.id;
      this.emit({
        type: "workspace.mark_unread.response",
        payload: {
          requestId,
          workspaceId,
          markedAgentId,
          success: true,
          error: null,
        },
      });
    } catch (error) {
      const message = getErrorMessage(error);
      this.sessionLogger.error({ err: error, workspaceId }, "Failed to mark workspace unread");
      this.emit({
        type: "workspace.mark_unread.response",
        payload: {
          requestId,
          workspaceId,
          markedAgentId,
          success: false,
          error: message,
        },
      });
    }
  }

  private async handleFetchAgent(agentIdOrIdentifier: string, requestId: string): Promise<void> {
    // An unknown agent is a null agent, not an error. Errors are for empty or ambiguous identifiers.
    const resolved = await this.resolveAgentIdentifier(agentIdOrIdentifier);
    if (!resolved.ok) {
      this.emit({
        type: "fetch_agent_response",
        payload: {
          requestId,
          agent: null,
          project: null,
          error: resolved.notFound ? null : resolved.error,
        },
      });
      return;
    }

    const agent = await this.getAgentPayloadById(resolved.agentId);
    if (!agent) {
      this.emit({
        type: "fetch_agent_response",
        payload: { requestId, agent: null, project: null, error: null },
      });
      return;
    }

    const project = agent.workspaceId
      ? await this.buildProjectPlacementForWorkspaceId(agent.workspaceId)
      : null;
    this.emit({
      type: "fetch_agent_response",
      payload: { requestId, agent, project, error: null },
    });
  }

  private async handleFetchAgentTimelineRequest(
    msg: Extract<SessionInboundMessage, { type: "fetch_agent_timeline_request" }>,
    source?: object,
  ): Promise<void> {
    const direction: AgentTimelineFetchDirection = msg.direction ?? (msg.cursor ? "after" : "tail");
    const projection = "projected" as const;
    const cursor: AgentTimelineCursor | undefined = msg.cursor
      ? {
          epoch: msg.cursor.epoch,
          seq: msg.cursor.seq,
        }
      : undefined;

    try {
      const snapshot = await ensureAgentLoaded(msg.agentId, {
        agentManager: this.agentManager,
        agentStorage: this.agentStorage,
        logger: this.sessionLogger,
        purpose: "history",
      });
      const agentPayload = await this.buildAgentPayload(snapshot);

      const fetchedControlTimeline = this.agentManager.fetchTimeline(msg.agentId, {
        direction,
        cursor,
        limit: msg.limit,
        wholeTurns: msg.wholeTurns,
      });
      const selectedTimeline = {
        timeline: fetchedControlTimeline,
        entries: fetchedControlTimeline.rows,
        startSeq: fetchedControlTimeline.startSeq,
        endSeq: fetchedControlTimeline.endSeq,
        hasOlder: fetchedControlTimeline.hasOlder,
        hasNewer: fetchedControlTimeline.hasNewer,
      };
      const startCursor =
        selectedTimeline.startSeq !== null
          ? { epoch: selectedTimeline.timeline.epoch, seq: selectedTimeline.startSeq }
          : null;
      const endCursor =
        selectedTimeline.endSeq !== null
          ? { epoch: selectedTimeline.timeline.epoch, seq: selectedTimeline.endSeq }
          : null;
      const entries = selectedTimeline.entries.filter((entry) =>
        this.supportsTimelineItem(entry.item, source),
      );

      this.emitForSource(
        {
          type: "fetch_agent_timeline_response",
          payload: {
            requestId: msg.requestId,
            agentId: msg.agentId,
            agent: agentPayload,
            direction,
            projection,
            epoch: selectedTimeline.timeline.epoch,
            reset: fetchedControlTimeline.reset,
            staleCursor: fetchedControlTimeline.staleCursor,
            gap: fetchedControlTimeline.gap,
            window: selectedTimeline.timeline.window,
            startCursor,
            endCursor,
            hasOlder: selectedTimeline.hasOlder,
            hasNewer: selectedTimeline.hasNewer,
            ...(msg.mergeWindow === true ? { mergeWindow: true } : {}),
            entries: entries.map((entry) => {
              const payloadEntry = {
                provider: snapshot.provider,
                item: entry.item,
                timestamp: entry.timestamp,
                seqStart: entry.seqStart,
                seqEnd: entry.seqEnd,
                sourceSeqRanges: entry.sourceSeqRanges,
                turnId: undefined as string | undefined,
                collapsed: (
                  source
                    ? this.supportsForSource(CLIENT_CAPS.reasoningMergeEnum, source)
                    : this.supports(CLIENT_CAPS.reasoningMergeEnum)
                )
                  ? entry.collapsed
                  : entry.collapsed.filter((value) => value !== "reasoning_merge"),
              };
              payloadEntry.turnId = entry.turnId;
              return payloadEntry;
            }),
            error: null,
          },
        },
        source,
      );
    } catch (error) {
      this.sessionLogger.error(
        { err: error, agentId: msg.agentId },
        "Failed to handle fetch_agent_timeline_request",
      );
      this.emitForSource(
        {
          type: "fetch_agent_timeline_response",
          payload: {
            requestId: msg.requestId,
            agentId: msg.agentId,
            agent: null,
            direction,
            projection,
            epoch: "",
            reset: false,
            staleCursor: false,
            gap: false,
            window: { minSeq: 0, maxSeq: 0, nextSeq: 0 },
            startCursor: null,
            endCursor: null,
            hasOlder: false,
            hasNewer: false,
            ...(msg.mergeWindow === true ? { mergeWindow: true } : {}),
            entries: [],
            error: error instanceof Error ? error.message : String(error),
          },
        },
        source,
      );
    }
  }

  private async handleAgentTimelineAppendRequest(
    msg: Extract<SessionInboundMessage, { type: "agent.timeline.append.request" }>,
  ): Promise<void> {
    const pluginId = parsePluginClientId(this.clientId);
    if (!pluginId) throw new Error("Only plugin sessions can append plugin timeline items");
    assertPluginTimelineDataSize(msg.item.data);
    const { seq, epoch } = await this.agentManager.appendTimelineItem(msg.agentId, {
      ...msg.item,
      pluginId,
    });
    this.emit({
      type: "agent.timeline.append.response",
      payload: { requestId: msg.requestId, seq, epoch },
    });
  }

  private async handleAgentTimelineSearchRequest(
    msg: Extract<SessionInboundMessage, { type: "agent.timeline.search.request" }>,
    source?: object,
  ): Promise<void> {
    try {
      await ensureAgentLoaded(msg.agentId, {
        agentManager: this.agentManager,
        agentStorage: this.agentStorage,
        logger: this.sessionLogger,
      });
      const rows = await this.agentManager.getTimelineRows(msg.agentId);
      const { epoch } = this.agentManager.fetchTimeline(msg.agentId, {
        direction: "tail",
        limit: 1,
      });
      const result = await searchTimeline({ rows, query: msg.query, cursor: msg.cursor });
      if (
        this.agentManager.fetchTimeline(msg.agentId, { direction: "tail", limit: 1 }).epoch !==
        epoch
      ) {
        throw new Error("History changed; search again");
      }
      this.emitForSource(
        {
          type: "agent.timeline.search.response",
          payload: {
            requestId: msg.requestId,
            agentId: msg.agentId,
            epoch,
            ...result,
            error: null,
          },
        },
        source,
      );
    } catch (error) {
      this.emitForSource(
        {
          type: "agent.timeline.search.response",
          payload: {
            requestId: msg.requestId,
            agentId: msg.agentId,
            epoch: "",
            locations: [],
            nextCursor: null,
            error: error instanceof Error ? error.message : String(error),
          },
        },
        source,
      );
    }
  }

  private async handleAgentTimelineListPromptsRequest(
    msg: Extract<SessionInboundMessage, { type: "agent.timeline.list_prompts.request" }>,
    source?: object,
  ): Promise<void> {
    try {
      await ensureAgentLoaded(msg.agentId, {
        agentManager: this.agentManager,
        agentStorage: this.agentStorage,
        logger: this.sessionLogger,
      });
      const rows = await this.agentManager.getTimelineRows(msg.agentId);
      const timeline = this.agentManager.fetchTimeline(msg.agentId, {
        direction: "tail",
        limit: 1,
      });
      const index = buildTimelinePromptIndex(timeline.epoch, rows);
      this.emitForSource(
        {
          type: "agent.timeline.list_prompts.response",
          payload: {
            requestId: msg.requestId,
            agentId: msg.agentId,
            ...index,
            error: null,
          },
        },
        source,
      );
    } catch (error) {
      this.sessionLogger.error(
        { err: error, agentId: msg.agentId },
        "Failed to handle agent.timeline.list_prompts.request",
      );
      this.emitForSource(
        {
          type: "agent.timeline.list_prompts.response",
          payload: {
            requestId: msg.requestId,
            agentId: msg.agentId,
            epoch: "",
            prompts: [],
            error: error instanceof Error ? error.message : String(error),
          },
        },
        source,
      );
    }
  }

  private async handleProviderSubagentListRequest(
    msg: Extract<SessionInboundMessage, { type: "agent.provider_subagents.list.request" }>,
  ): Promise<void> {
    try {
      await ensureUnarchivedAgentLoaded(msg.parentAgentId, {
        agentManager: this.agentManager,
        agentStorage: this.agentStorage,
        logger: this.sessionLogger,
      });
      this.emit({
        type: "agent.provider_subagents.list.response",
        payload: {
          requestId: msg.requestId,
          parentAgentId: msg.parentAgentId,
          subagents: this.agentManager.listProviderSubagents(msg.parentAgentId),
          error: null,
        },
      });
    } catch (error) {
      this.emit({
        type: "agent.provider_subagents.list.response",
        payload: {
          requestId: msg.requestId,
          parentAgentId: msg.parentAgentId,
          subagents: [],
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  private async handleProviderSubagentTimelineRequest(
    msg: Extract<SessionInboundMessage, { type: "agent.provider_subagents.timeline.get.request" }>,
    source?: object,
  ): Promise<void> {
    const direction: AgentTimelineFetchDirection = msg.direction ?? (msg.cursor ? "after" : "tail");
    try {
      await ensureUnarchivedAgentLoaded(msg.parentAgentId, {
        agentManager: this.agentManager,
        agentStorage: this.agentStorage,
        logger: this.sessionLogger,
      });
      const descriptor = this.agentManager.getProviderSubagent(msg.parentAgentId, msg.subagentId);
      if (!descriptor) {
        throw new Error("Provider subagent not found");
      }
      // COMPAT(projectedSubagentTimeline): added after v0.8.0, remove after 2027-03-14.
      const supportsProjection = source
        ? this.supportsForSource(CLIENT_CAPS.projectedSubagentTimeline, source)
        : this.supports(CLIENT_CAPS.projectedSubagentTimeline);
      const timeline = this.agentManager.fetchProviderSubagentTimeline(
        msg.parentAgentId,
        msg.subagentId,
        {
          direction,
          cursor: msg.cursor,
          limit: msg.limit ?? (direction === "after" ? 0 : 200),
        },
      );
      const rows = timeline.rows.filter((row) => this.supportsTimelineItem(row.item, source));
      this.emitForSource(
        {
          type: "agent.provider_subagents.timeline.get.response",
          payload: {
            requestId: msg.requestId,
            parentAgentId: msg.parentAgentId,
            subagentId: msg.subagentId,
            provider: descriptor.provider,
            direction,
            epoch: timeline.epoch,
            projection: "projected",
            startCursor:
              timeline.startSeq === null ? null : { epoch: timeline.epoch, seq: timeline.startSeq },
            endCursor:
              timeline.endSeq === null ? null : { epoch: timeline.epoch, seq: timeline.endSeq },
            reset: timeline.reset,
            staleCursor: timeline.staleCursor,
            gap: timeline.gap,
            window: timeline.window,
            hasOlder: supportsProjection && timeline.hasOlder,
            hasNewer: supportsProjection && timeline.hasNewer,
            rows: supportsProjection
              ? rows.map((row) => ({
                  item: row.item,
                  timestamp: row.timestamp,
                  seq: row.seqEnd,
                  seqStart: row.seqStart,
                  seqEnd: row.seqEnd,
                  sourceSeqRanges: row.sourceSeqRanges,
                }))
              : [
                  {
                    seq: timeline.window.maxSeq,
                    timestamp: new Date().toISOString(),
                    item: {
                      type: "assistant_message",
                      text: "Please upgrade the Neox app to view this subagent conversation.",
                    },
                  },
                ],
            error: null,
          },
        },
        source,
      );
    } catch (error) {
      this.emitForSource(
        {
          type: "agent.provider_subagents.timeline.get.response",
          payload: {
            requestId: msg.requestId,
            parentAgentId: msg.parentAgentId,
            subagentId: msg.subagentId,
            provider: null,
            direction,
            epoch: "",
            reset: false,
            staleCursor: false,
            gap: false,
            window: { minSeq: 0, maxSeq: 0, nextSeq: 0 },
            hasOlder: false,
            hasNewer: false,
            rows: [],
            error: error instanceof Error ? error.message : String(error),
          },
        },
        source,
      );
    }
  }

  private async handleAgentForkContextRequest(
    msg: Extract<SessionInboundMessage, { type: "agent.fork_context.request" }>,
  ): Promise<void> {
    try {
      const snapshot = await ensureAgentLoaded(msg.agentId, {
        agentManager: this.agentManager,
        agentStorage: this.agentStorage,
        logger: this.sessionLogger,
      });
      const agentPayload = await this.buildAgentPayload(snapshot);
      const timeline = this.agentManager.fetchTimeline(msg.agentId, {
        direction: "tail",
        limit: 0,
      });
      const forkContext = buildAgentForkContextAttachment({
        rows: timeline.rows,
        cursorBoundary: msg.boundaryCursor
          ? { timelineEpoch: timeline.epoch, cursor: msg.boundaryCursor }
          : null,
        boundaryMessageId: msg.boundaryMessageId,
        agentTitle: agentPayload.title,
        cwd: snapshot.cwd,
      });

      this.emit({
        type: "agent.fork_context.response",
        payload: {
          requestId: msg.requestId,
          agentId: msg.agentId,
          attachment: forkContext.attachment,
          itemCount: forkContext.itemCount,
          boundaryCursor: forkContext.boundaryCursor,
          boundaryMessageId: forkContext.boundaryMessageId,
          error: null,
        },
      });
    } catch (error) {
      this.sessionLogger.error(
        { err: error, agentId: msg.agentId },
        "Failed to handle agent.fork_context.request",
      );
      this.emit({
        type: "agent.fork_context.response",
        payload: {
          requestId: msg.requestId,
          agentId: msg.agentId,
          attachment: null,
          itemCount: 0,
          boundaryCursor: msg.boundaryCursor ?? null,
          boundaryMessageId: msg.boundaryMessageId ?? null,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  private async prepareAgentMessage(agentId: string, text: string): Promise<void> {
    await ensureAgentLoaded(agentId, {
      agentManager: this.agentManager,
      agentStorage: this.agentStorage,
      logger: this.sessionLogger,
    });
    const stored = await this.agentStorage.get(agentId);
    if (stored && !stored.title && !stored.lastUserMessageAt) {
      const { provisionalTitle } = resolveCreateAgentTitles({ initialPrompt: text });
      if (provisionalTitle) await this.agentManager.setTitle(agentId, provisionalTitle);
    }
  }

  private async handleSendAgentMessageRequest(
    msg: Extract<SessionInboundMessage, { type: "send_agent_message_request" }>,
  ): Promise<void> {
    const resolved = await this.resolveAgentIdentifier(msg.agentId);
    if (!resolved.ok) {
      this.emit({
        type: "send_agent_message_response",
        payload: {
          requestId: msg.requestId,
          agentId: msg.agentId,
          accepted: false,
          error: resolved.error,
        },
      });
      return;
    }

    try {
      const agentId = resolved.agentId;

      const prompt = buildAgentPrompt(msg.text, msg.images, msg.attachments);
      this.sessionLogger.trace(
        {
          agentId,
          messageId: msg.messageId,
          activeTurnBehavior: msg.activeTurnBehavior,
          textPrefix: msg.text.slice(0, 80),
        },
        "agent.session.send_agent_message",
      );
      let queued!: () => void;
      const admitted = new Promise<void>((acceptAdmission) => {
        queued = acceptAdmission;
      });
      let deliveryStatus: "queued" | undefined;
      const send = async () => {
        if (msg.sourceAgentId) {
          const receipt = this.agentMessages.enqueue({
            recipientId: agentId,
            messageId: msg.messageId,
            prompt,
            source: {
              kind: "agent-message",
              agentId: msg.sourceAgentId,
              serverId: msg.sourceAgentServerId,
              title: !msg.sourceAgentServerId
                ? (this.agentManager.getAgent(msg.sourceAgentId)?.config.title ?? undefined)
                : undefined,
            },
            activeTurnBehavior: msg.activeTurnBehavior ?? "steer",
            sessionMode: msg.sessionMode,
            clearPendingPermissions: false,
          });
          deliveryStatus = "queued";
          queued();
          await receipt.dispatched;
          return;
        }
        const result = await sendPromptToAgent({
          agentManager: this.agentManager,
          agentStorage: this.agentStorage,
          agentId,
          prompt,
          messageId: msg.messageId,
          activeTurnBehavior: msg.activeTurnBehavior ?? "interrupt",
          sessionMode: msg.sessionMode,
          clearPendingPermissions: true,
          logger: this.sessionLogger,
        });
        if (result.disposition === "turn_started") {
          await waitForAgentRunStartWithTimeout(
            this.agentManager,
            agentId,
            this.delivery.requestSignal,
          );
        }
      };
      const sent = msg.messageId
        ? this.messageReceipts.send({
            agentId,
            messageId: msg.messageId,
            request: {
              prompt,
              sourceAgentId: msg.sourceAgentId,
              sourceAgentServerId: msg.sourceAgentServerId,
              sessionMode: msg.sessionMode,
              activeTurnBehavior:
                msg.activeTurnBehavior ?? (msg.sourceAgentId ? "steer" : "interrupt"),
            },
            prepare: async () => {
              if (!msg.sourceAgentId) await this.prepareAgentMessage(agentId, msg.text);
            },
            send,
          })
        : send();
      void sent.catch((error) => {
        if (deliveryStatus === "queued") {
          this.handleAgentRunError(agentId, error, "Failed to dispatch queued agent message");
        }
      });
      await Promise.race([sent, admitted]);

      this.emit({
        type: "send_agent_message_response",
        payload: {
          requestId: msg.requestId,
          agentId,
          accepted: true,
          ...(deliveryStatus ? { deliveryStatus } : {}),
          error: null,
        },
      });
    } catch (error) {
      if (this.delivery.requestSignal.aborted) return;
      this.handleAgentRunError(resolved.agentId, error, "Failed to send agent message");
      this.emit({
        type: "send_agent_message_response",
        payload: {
          requestId: msg.requestId,
          agentId: resolved.agentId,
          accepted: false,
          error: errorToFriendlyMessage(error),
        },
      });
    }
  }

  private async handleWaitForFinish(
    agentIdOrIdentifier: string,
    requestId: string,
    timeoutMs?: number,
  ): Promise<void> {
    const sourceSignal = this.delivery.requestSignal;
    sourceSignal.throwIfAborted();
    const resolved = await this.resolveAgentIdentifier(agentIdOrIdentifier);
    if (!resolved.ok) {
      this.emit({
        type: "wait_for_finish_response",
        payload: {
          requestId,
          status: "error",
          final: null,
          error: resolved.error,
          lastMessage: null,
        },
      });
      return;
    }

    const agentId = resolved.agentId;
    const abortController = new AbortController();
    const hasTimeout = typeof timeoutMs === "number" && timeoutMs > 0;
    const timeoutHandle = hasTimeout
      ? setTimeout(() => {
          abortController.abort("timeout");
        }, timeoutMs)
      : null;

    try {
      await this.agentMessages.waitForDispatch(
        agentId,
        AbortSignal.any([abortController.signal, sourceSignal]),
      );

      const live = this.agentManager.getAgent(agentId);
      if (!live) {
        const settled = await this.readSettledAgent(agentId);
        if (!settled) {
          this.emit({
            type: "wait_for_finish_response",
            payload: {
              requestId,
              status: "error",
              final: null,
              error: `Agent not found: ${agentId}`,
              lastMessage: null,
            },
          });
          return;
        }
        const { record, lastMessage } = settled;
        const final = this.buildStoredAgentPayload(record);
        let status: "permission" | "error" | "idle";
        if (record.attentionReason === "permission") {
          status = "permission";
        } else if (record.lastStatus === "error") {
          status = "error";
        } else {
          status = "idle";
        }
        const error = resolveWaitForFinishError({ status, final });
        this.emit({
          type: "wait_for_finish_response",
          payload: { requestId, status, final, error, lastMessage },
        });
        return;
      }

      let result = await this.agentManager.waitForAgentEvent(agentId, {
        signal: AbortSignal.any([abortController.signal, sourceSignal]),
        waitForActive: true,
      });
      let final = await this.getAgentPayloadById(agentId);
      if (!final) {
        throw new Error(`Agent ${agentId} disappeared while waiting`);
      }

      let status: "permission" | "error" | "idle";
      if (result.permission) {
        status = "permission";
      } else if (result.status === "error") {
        status = "error";
      } else {
        status = "idle";
      }
      const error = resolveWaitForFinishError({ status, final });

      this.emit({
        type: "wait_for_finish_response",
        payload: { requestId, status, final, error, lastMessage: result.lastMessage },
      });
    } catch (error) {
      if (sourceSignal.aborted) return;
      const isAbort =
        error instanceof Error &&
        (error.name === "AbortError" || error.message.toLowerCase().includes("aborted"));
      if (!isAbort) {
        const message = errorToFriendlyMessage(error);
        this.sessionLogger.error({ err: error, agentId }, "wait_for_finish_request failed");
        const final = await this.getAgentPayloadById(agentId);
        this.emit({
          type: "wait_for_finish_response",
          payload: {
            requestId,
            status: "error",
            final,
            error: message,
            lastMessage: null,
          },
        });
        return;
      }

      const final = await this.getAgentPayloadById(agentId);
      if (!final) {
        throw new Error(`Agent ${agentId} disappeared while waiting`, { cause: error });
      }
      this.emit({
        type: "wait_for_finish_response",
        payload: { requestId, status: "timeout", final, error: null, lastMessage: null },
      });
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  /**
   * Emit a message to the client
   */
  // COMPAT(explicitEventSubscriptions): added in v0.8.0, remove legacy broadcasts after 2027-03-08.
  private wantsEvent(event: SessionEventSubscription, source?: object): boolean {
    // COMPAT(workspaceSetupObservation): added in v0.12.0, remove global setup delivery after 2027-04-19 once client floor >= v0.12.0.
    if (
      event === "workspace_setup_progress" &&
      source &&
      this.supportsForSource(CLIENT_CAPS.workspaceSetupObservation, source)
    )
      return false;
    for (const subscription of this.eventSubscriptions.values()) {
      if (
        (!source || subscription.owner.source === source) &&
        subscription.events.has(event) &&
        !(
          event === "workspace_setup_progress" &&
          this.supportsForSource(CLIENT_CAPS.workspaceSetupObservation, subscription.owner.source)
        )
      )
        return true;
    }
    if (!source && this.clientSources.size > 0) {
      return [...this.clientSources.keys()].some((candidate) => this.wantsEvent(event, candidate));
    }
    if (source && this.delivery.isModern(source)) return false;
    if (!source && !this.delivery.hasLegacySources()) return false;
    // COMPAT(ownedSubscriptions): added in v0.8.0, remove implicit event delivery after 2027-03-09.
    const capabilities = source
      ? (this.clientSources.get(source)?.capabilities ?? this.clientCapabilities)
      : this.clientCapabilities;
    return legacyWantsEvent(event, capabilities);
  }

  private emitEventToOwner(
    subscription: { owner: OwnedSubscription; notifications: boolean },
    message: SessionOutboundMessage,
    notified: Set<object>,
  ): void {
    if (
      message.type !== "agent_attention_required" &&
      message.type !== "terminal_attention_required"
    ) {
      subscription.owner.emit(message);
      return;
    }
    const shouldNotify =
      message.payload.shouldNotify &&
      subscription.notifications &&
      !notified.has(subscription.owner.source);
    subscription.owner.emit(
      message.type === "agent_attention_required"
        ? { ...message, payload: { ...message.payload, shouldNotify } }
        : { ...message, payload: { ...message.payload, shouldNotify } },
    );
    if (shouldNotify) notified.add(subscription.owner.source);
  }

  private emitSubscribedEvent(message: SessionOutboundMessage, onlySource?: object): boolean {
    const event = sessionEventCategory(message);
    if (!event) return false;
    if (!this.authorization.allowsOutbound(message)) return true;
    const delivered = new Set<object>();
    const notified = new Set<object>();
    for (const subscription of this.eventSubscriptions.values()) {
      if (
        !subscription.events.has(event) ||
        (event === "workspace_setup_progress" &&
          this.supportsForSource(
            CLIENT_CAPS.workspaceSetupObservation,
            subscription.owner.source,
          )) ||
        (onlySource && subscription.owner.source !== onlySource)
      )
        continue;
      this.emitEventToOwner(subscription, message, notified);
      delivered.add(subscription.owner.source);
    }
    // COMPAT(ownedSubscriptions): added in v0.8.0, remove implicit event delivery after 2027-03-09.
    if (this.onMessageToSource && this.clientSources.size > 0) {
      for (const source of this.clientSources.keys()) {
        if (
          (!onlySource || source === onlySource) &&
          !delivered.has(source) &&
          !this.delivery.isModern(source) &&
          this.wantsEvent(event, source)
        )
          this.onMessageToSource(source, this.workspaceSetupMessageForClient(message, source));
      }
    } else if (delivered.size === 0 && this.wantsEvent(event)) this.onMessage(message);
    return true;
  }

  private emit(msg: SessionOutboundMessage): void {
    if (!this.authorization.allowsOutbound(msg)) return;
    if (msg.type === "workspace_setup_progress") {
      const { workspaceId, subscriptionId: _subscriptionId, ...snapshot } = msg.payload;
      this.workspaceSetupObservation.publish(workspaceId, snapshot);
      return;
    }
    if (this.delivery.reply(msg)) return;
    if (this.emitSubscribedEvent(msg)) return;
    // JSON.stringify(msg) is only computed when trace is enabled — it runs for
    // every outbound message otherwise, and trace is disabled by default.
    // Optional-chained because test logger stubs don't implement isLevelEnabled.
    if (this.sessionLogger.isLevelEnabled?.("trace")) {
      this.sessionLogger.trace(
        {
          messageType: msg.type,
          payloadBytes: JSON.stringify(msg).length,
        },
        "agent.session.outbound",
      );
    }
    if (msg.type === "workspace_setup_status_response") {
      if (this.clientSources.size > 0 && this.onMessageToSource) {
        for (const [source] of this.clientSources) {
          this.onMessageToSource(source, this.workspaceSetupMessageForClient(msg, source));
        }
        return;
      }
      msg = this.workspaceSetupMessageForClient(msg);
    }
    this.onMessage(msg);
  }

  // COMPAT(workspaceSetupBlocked): added in v0.8.0, remove after 2027-03-07 once client floor >= v0.8.0.
  private workspaceSetupMessageForClient(
    message: SessionOutboundMessage,
    source?: object,
  ): SessionOutboundMessage {
    if (
      message.type !== "workspace_setup_progress" &&
      message.type !== "workspace_setup_status_response"
    )
      return message;
    const supportsBlocked = source
      ? this.supportsForSource(CLIENT_CAPS.workspaceSetupBlocked, source)
      : this.supports(CLIENT_CAPS.workspaceSetupBlocked);
    const snapshot =
      message.type === "workspace_setup_progress" ? message.payload : message.payload.snapshot;
    if (supportsBlocked || snapshot?.status !== "blocked") return message;
    const legacySnapshot = {
      ...snapshot,
      status: "failed" as const,
      error:
        "Workspace setup is blocked pending approval of code from a fork pull request. Update Neox to review and run setup.",
    };
    return message.type === "workspace_setup_progress"
      ? { ...message, payload: { ...message.payload, ...legacySnapshot } }
      : { ...message, payload: { ...message.payload, snapshot: legacySnapshot } };
  }

  private emitBinary(frame: Uint8Array): void {
    if (!this.onBinaryMessage) {
      return;
    }
    try {
      this.onBinaryMessage(frame);
    } catch (error) {
      this.sessionLogger.error({ err: error }, "Failed to emit binary frame");
    }
  }

  private async emitBinaryReply(frame: Uint8Array, source?: object): Promise<void> {
    if (source && this.onBinaryMessageToSource) {
      this.delivery.authorizeBinaryReply(frame, source);
      await this.onBinaryMessageToSource(source, frame);
      return;
    }
    this.emitBinary(frame);
  }

  private observeSourceSend(send: () => void | Promise<void>): Promise<void> {
    let pending: Promise<void>;
    try {
      pending = Promise.resolve(send());
    } catch (error) {
      pending = Promise.reject(error);
    }
    // Legacy producers fire and forget; owned streams await the same failure.
    void pending.catch((error) =>
      this.sessionLogger.warn({ err: error }, "Failed to emit source frame"),
    );
    return pending;
  }

  private emitForSource(msg: SessionOutboundMessage, source?: object): void {
    if (source && this.onMessageToSource) {
      msg = this.delivery.authorizeReply(msg, source);
      this.onMessageToSource(source, msg);
      return;
    }
    this.emit(msg);
  }

  /**
   * Clean up session resources
   */
  public async cleanup(): Promise<void> {
    this.sessionLogger.trace({}, "agent.session.lifecycle.cleanup");
    this.isCleanedUp = true;
    this.unsubscribeSetupObservation();
    await this.delivery.close();

    if (this.unsubscribeAgentEvents) {
      this.unsubscribeAgentEvents();
      this.unsubscribeAgentEvents = null;
    }
    this.unsubscribeProjectMutations?.();
    this.unsubscribeProjectMutations = null;
    this.unsubscribePluginChanges?.();
    this.unsubscribePluginChanges = null;
    this.unsubscribeAgentConnect?.();
    this.unsubscribeAgentConnect = null;
    this.unsubscribeWorkspaceMutations?.();
    this.unsubscribeWorkspaceMutations = null;
    this.agentUpdates.dispose();
    await this.hubExecutionController?.cleanup();
    if (this.unsubscribeTerminalWorkspaceContributionEvents) {
      this.unsubscribeTerminalWorkspaceContributionEvents();
      this.unsubscribeTerminalWorkspaceContributionEvents = null;
    }
    this.providerCatalogSession.dispose();

    this.terminalController.dispose();

    this.checkoutSession.cleanup();

    this.workspaceGitObserver.dispose();
  }
}

interface CloneRepositoryInput {
  name: string;
  displayName: string;
  cloneUrl: string;
}

function normalizeCloneRepository(input: {
  repo: string;
  cloneProtocol?: "https" | "ssh";
}): CloneRepositoryInput {
  const trimmed = input.repo.trim();
  if (!trimmed) {
    throw new Error("Repository is required");
  }

  const remote = parseGitRemoteLocation(trimmed);
  if (remote) {
    const segments = remote.path.split("/").filter(Boolean);
    const name = segments.at(-1);
    if (!name || !isValidGitHubRepoSegment(name)) {
      throw new Error("Repository name contains invalid characters");
    }
    return { name, displayName: remote.path, cloneUrl: trimmed };
  }

  const [owner, rawName, ...extra] = trimmed.split("/");
  if (!owner || !rawName || extra.length > 0) {
    throw new Error("Repository must use owner/repo format or a git remote URL");
  }
  const name = rawName.endsWith(".git") ? rawName.slice(0, -4) : rawName;
  if (!isValidGitHubRepoSegment(owner) || !isValidGitHubRepoSegment(name)) {
    throw new Error("Repository contains invalid characters");
  }
  if (!input.cloneProtocol) {
    throw new Error("Clone protocol is required for owner/repo repository names");
  }
  const cloneUrl =
    input.cloneProtocol === "ssh"
      ? `git@github.com:${owner}/${name}.git`
      : `https://github.com/${owner}/${name}.git`;
  return {
    name,
    displayName: `${owner}/${name}`,
    cloneUrl,
  };
}

function isValidGitHubRepoSegment(value: string): boolean {
  return /^[A-Za-z0-9._-]+$/u.test(value);
}

function sessionEventCategory(message: SessionOutboundMessage): SessionEventSubscription | null {
  switch (message.type) {
    case "project.update":
    case "providers_snapshot_update":
    case "agent_attention_required":
    case "agent_permission_request":
    case "agent_permission_resolved":
    case "checkout_status_update":
    case "script_status_update":
    case "workspace_setup_progress":
    case "agent.provider_subagents.update":
    case "terminal_attention_required":
    case "activity_log":
    case "hub.execution.agent.update":
    case "hub.execution.agent.stream":
    case "agent.connect.changed":
      return message.type;
    case "status":
      switch (message.payload.status) {
        case "server_info":
          return "status.server_info";
        case "daemon_config_changed":
          return "status.daemon_config_changed";
        case "plugin_catalog_changed":
          return "status.plugin_catalog_changed";
        case "plugin_settings_changed":
          return "status.plugin_settings_changed";
        default:
          return null;
      }
    default:
      return null;
  }
}

// COMPAT(ownedSubscriptions): added in v0.8.0, remove implicit event delivery after 2027-03-09.
function legacyWantsEvent(
  event: SessionEventSubscription,
  capabilities: ReadonlySet<ClientCapability>,
): boolean {
  if (event === "project.update" && !capabilities.has(CLIENT_CAPS.projectUpdates)) return false;
  switch (event) {
    case "project.update":
    case "providers_snapshot_update":
    case "agent_attention_required":
    case "agent_permission_request":
    case "agent_permission_resolved":
      return !capabilities.has(CLIENT_CAPS.explicitEventSubscriptions);
    case "agent.provider_subagents.update":
      return capabilities.has(CLIENT_CAPS.providerSubagents);
    default:
      return true;
  }
}

function createHostSession(options: SessionOptions, session: Session): ConnectedHostSession | null {
  if (!options.connectedHosts) return null;
  return new ConnectedHostSession(
    options.connectedHosts,
    session.delivery,
    { sourceId: options.sourceId ?? "owner", manageSources: false },
    () => session.getPermissions(),
    (message) => session.publish(message),
    () => session.isRouted(),
    session.getSessionId(),
    () => options.getConnectedHostBufferedAmount?.() ?? 0,
  );
}

function hostSource(options: SessionOptions): string {
  return options.sourceId ?? "owner";
}

type GatewaySnapshotRpcRequest = Extract<
  SessionInboundMessage,
  { type: "gateway.status.get.request" | "gateway.trace.get.request" }
>;

function isGatewaySnapshotRpcRequest(
  message: SessionInboundMessage,
): message is GatewaySnapshotRpcRequest {
  return (
    message.type === "gateway.status.get.request" || message.type === "gateway.trace.get.request"
  );
}

type GatewayDiagnosticsRpcRequest = Extract<
  SessionInboundMessage,
  {
    type:
      | "gateway.routing.history.request"
      | "gateway.archive.get.request"
      | "gateway.prompt_text.get.request"
      | "gateway.route_events.get.request"
      | "gateway.prompt_reply.get.request"
      | "gateway.tune.get.request"
      | "gateway.tune.apply.request"
      | "gateway.tune.undo.request";
  }
>;

type GatewayReadRpcRequest = GatewaySnapshotRpcRequest | GatewayDiagnosticsRpcRequest;

type SyncRpcRequest = Extract<SessionInboundMessage, { type: `sync.${string}` }>;
type SyncConfigRpcRequest = Extract<
  SyncRpcRequest,
  {
    type:
      | "sync.config.get.request"
      | "sync.config.set.request"
      | "sync.status.get.request"
      | "sync.run.request";
  }
>;
type SyncHistoryRpcRequest = Exclude<SyncRpcRequest, SyncConfigRpcRequest>;

function isSyncConfigRpcRequest(message: SyncRpcRequest): message is SyncConfigRpcRequest {
  return (
    message.type === "sync.config.get.request" ||
    message.type === "sync.config.set.request" ||
    message.type === "sync.status.get.request" ||
    message.type === "sync.run.request"
  );
}
type BackupRpcRequest = Extract<SessionInboundMessage, { type: `backup.${string}` }>;

/** Wraps a source send in the observation the session does for every send. */
function sourceSendHandler<Payload>(
  send: ((source: object, payload: Payload) => void | Promise<void>) | undefined,
  observe: (work: () => void | Promise<void>) => Promise<void>,
): ((source: object, payload: Payload) => Promise<void>) | null {
  if (send === undefined) {
    return null;
  }
  return (source, payload) => observe(() => send(source, payload));
}

function isSyncRpcRequest(message: { type: string }): message is SyncRpcRequest {
  return message.type.startsWith("sync.");
}

function isGatewayReadRpcRequest(message: SessionInboundMessage): message is GatewayReadRpcRequest {
  return isGatewaySnapshotRpcRequest(message) || isGatewayDiagnosticsRpcRequest(message);
}

function isGatewayDiagnosticsRpcRequest(
  message: SessionInboundMessage,
): message is GatewayDiagnosticsRpcRequest {
  return (
    message.type === "gateway.routing.history.request" ||
    message.type === "gateway.archive.get.request" ||
    message.type === "gateway.prompt_text.get.request" ||
    message.type === "gateway.route_events.get.request" ||
    message.type === "gateway.prompt_reply.get.request" ||
    message.type === "gateway.tune.get.request" ||
    message.type === "gateway.tune.apply.request" ||
    message.type === "gateway.tune.undo.request"
  );
}

type CodexAccountRpcRequest = Extract<
  SessionInboundMessage,
  {
    type:
      | "gateway.codex.accounts.request"
      | "gateway.codex.account.remove.request"
      | "gateway.codex.account.arrange.request"
      | "gateway.codex.account.set.request"
      | "gateway.codex.account.import.request";
  }
>;

function isCodexAccountRpcRequest(
  message: SessionInboundMessage,
): message is CodexAccountRpcRequest {
  return (
    message.type === "gateway.codex.accounts.request" ||
    message.type === "gateway.codex.account.remove.request" ||
    message.type === "gateway.codex.account.arrange.request" ||
    message.type === "gateway.codex.account.set.request" ||
    message.type === "gateway.codex.account.import.request"
  );
}

/** Sign-ins from Codex's own auth.json, or JSON the app read from a file and pasted. */
function importRequestOf(
  msg: Extract<CodexAccountRpcRequest, { type: "gateway.codex.account.import.request" }>,
  accountsFile: string,
): Promise<CodexImportResult> {
  if (msg.fromCodex === true) {
    const home = codexHomePath();
    return importCodexAccounts([join(home, "auth.json")], accountsFile, { home });
  }
  // COMPAT(codexImportPaths): added in v0.15.0, remove after 2027-11-06.
  // `paths` stayed on the wire but is ignored: a remote client could
  // otherwise make the daemon read any file on this host. The app reads a
  // file it chose and sends its contents as `text`.
  return importCodexAccountsFromText(msg.text ?? "", accountsFile);
}

type SignInRpcRequest =
  | Extract<SessionInboundMessage, { type: `gateway.signin.${string}.request` }>
  | Extract<SessionInboundMessage, { type: "gateway.subscription.add.request" }>
  | Extract<SessionInboundMessage, { type: "gateway.subscription.switch.request" }>
  | Extract<SessionInboundMessage, { type: "gateway.subscription.import.request" }>
  | Extract<SessionInboundMessage, { type: "gateway.subscription.list.request" }>
  | Extract<SessionInboundMessage, { type: "gateway.subscription.remove.request" }>;

function isSignInRpcRequest(message: SessionInboundMessage): message is SignInRpcRequest {
  return (
    message.type === "gateway.subscription.add.request" ||
    message.type === "gateway.subscription.switch.request" ||
    message.type === "gateway.subscription.import.request" ||
    message.type === "gateway.subscription.list.request" ||
    message.type === "gateway.subscription.remove.request" ||
    message.type === "gateway.signin.start.request" ||
    message.type === "gateway.signin.status.request" ||
    message.type === "gateway.signin.cancel.request" ||
    message.type === "gateway.signin.callback.request"
  );
}

type GatewayProviderRpcRequest = Extract<
  SessionInboundMessage,
  {
    type:
      | "gateway.provider.get_models.request"
      | "gateway.provider.test_model.request"
      | "gateway.provider.detect.request"
      | "gateway.provider.upstream_status.request"
      | "gateway.pricing.get.request"
      | "gateway.provider.balance.request"
      | "gateway.codex.status.request"
      | "gateway.codex.accounts.request"
      | "gateway.signin.start.request"
      | "gateway.signin.status.request"
      | "gateway.signin.cancel.request"
      | "gateway.signin.callback.request"
      | "gateway.subscription.add.request"
      | "gateway.subscription.switch.request"
      | "gateway.subscription.import.request"
      | "gateway.subscription.list.request"
      | "gateway.subscription.remove.request"
      | "gateway.claude.mode.get.request"
      | "gateway.codex.account.remove.request"
      | "gateway.codex.account.arrange.request"
      | "gateway.codex.account.set.request"
      | "gateway.codex.account.import.request"
      | "gateway.provider.preview_import.request";
  }
>;

function isGatewayProviderRpcRequest(
  message: SessionInboundMessage,
): message is GatewayProviderRpcRequest {
  return (
    message.type === "gateway.provider.get_models.request" ||
    message.type === "gateway.provider.test_model.request" ||
    message.type === "gateway.provider.detect.request" ||
    message.type === "gateway.provider.upstream_status.request" ||
    message.type === "gateway.pricing.get.request" ||
    message.type === "gateway.provider.balance.request" ||
    message.type === "gateway.claude.mode.get.request" ||
    message.type === "gateway.codex.status.request" ||
    isCodexAccountRpcRequest(message) ||
    isSignInRpcRequest(message) ||
    message.type === "gateway.provider.preview_import.request"
  );
}

type GatewayRpcRequest = Extract<
  SessionInboundMessage,
  {
    type:
      | "gateway.config.get.request"
      | "gateway.config.set.request"
      | "gateway.status.get.request"
      | "gateway.trace.get.request"
      | "gateway.routing.history.request"
      | "gateway.archive.get.request"
      | "gateway.prompt_text.get.request"
      | "gateway.route_events.get.request"
      | "gateway.prompt_reply.get.request"
      | "gateway.tune.get.request"
      | "gateway.tune.apply.request"
      | "gateway.tune.undo.request"
      | "gateway.usage.get.request"
      | "gateway.quota.get.request"
      | "gateway.quota.reset.request"
      | "gateway.quota.warm.request"
      | "gateway.warmup.warm-at.request"
      | "gateway.warmup.account-warm-at.request"
      | "gateway.masking.summary.request"
      | "gateway.masking.records.request"
      | "gateway.masking.record.request"
      | "gateway.masking.preview.request"
      | "gateway.masking.clear.request"
      | "gateway.checkin.status.request"
      | "gateway.checkin.run.request"
      | "gateway.checkin.switch.request"
      | "gateway.checkin.account.request"
      | "gateway.plugin.subscription.list.request"
      | "gateway.plugin.subscription.models.request"
      | "gateway.plugin.subscription.sign_in.request"
      | "gateway.plugin.subscription.sign_in.poll.request"
      | "gateway.held.list.request"
      | "gateway.held.read.request"
      | "gateway.catalog.refresh.request"
      | "gateway.provider.get_models.request"
      | "gateway.provider.test_model.request"
      | "gateway.provider.detect.request"
      | "gateway.provider.upstream_status.request"
      | "gateway.provider.balance.request"
      | "gateway.codex.status.request"
      | "gateway.codex.accounts.request"
      | "gateway.signin.start.request"
      | "gateway.signin.status.request"
      | "gateway.signin.cancel.request"
      | "gateway.signin.callback.request"
      | "gateway.subscription.add.request"
      | "gateway.subscription.switch.request"
      | "gateway.subscription.import.request"
      | "gateway.subscription.list.request"
      | "gateway.subscription.remove.request"
      | "gateway.claude.mode.get.request"
      | "gateway.codex.account.remove.request"
      | "gateway.codex.account.arrange.request"
      | "gateway.codex.account.set.request"
      | "gateway.codex.account.import.request"
      | "gateway.provider.preview_import.request";
  }
>;

type AgentConnectRpcRequest = Extract<
  SessionInboundMessage,
  { type: `agent.connect.${string}.request` }
>;

function isAgentConnectRpcRequest(
  message: SessionInboundMessage,
): message is AgentConnectRpcRequest {
  return (
    message.type === "agent.connect.get.request" ||
    message.type === "agent.connect.set.request" ||
    message.type === "agent.connect.profile.list.request" ||
    message.type === "agent.connect.profile.save.request" ||
    message.type === "agent.connect.profile.apply.request" ||
    message.type === "agent.connect.profile.delete.request" ||
    message.type === "agent.connect.layout.set.request" ||
    message.type === "agent.connect.shell.request" ||
    message.type === "agent.connect.models.request" ||
    message.type === "agent.connect.stale.restart.request"
  );
}

type AgentInstallRpcRequest = Extract<
  SessionInboundMessage,
  { type: `agent.install.${string}.request` }
>;

function isAgentInstallRpcRequest(
  message: SessionInboundMessage,
): message is AgentInstallRpcRequest {
  return (
    message.type === "agent.install.list.request" ||
    message.type === "agent.install.run.request" ||
    message.type === "agent.install.uninstall.request"
  );
}

/** The fields a probe request carries, in the shape the probe module takes. */
/** A catalog price as the wire carries it, every optional field kept apart. */
/**
 * A catalog price as the model editor shows it, marked when its vendor bills
 * it by the hour: the price is the off-peak one and its peak hours double it.
 */
function modelPriceWire(
  catalog: PricingCatalog | undefined,
  providerId: string,
  provider: GatewayProvider | undefined,
  model: string,
): GatewayPriceWire | null {
  const price = catalog?.priceFor(providerId, model) ?? null;
  if (price === null) {
    return null;
  }
  // A provider not saved yet, or gone since, is told by its id.
  const peak = peakOf(provider ?? { id: providerId, baseUrl: "" }, model);
  return peak === null ? priceWire(price) : { ...priceWire(price), peak };
}

function priceWire(price: PricedModel): GatewayPriceWire {
  return {
    inputPerMTok: price.inputPerMTok,
    outputPerMTok: price.outputPerMTok,
    ...(price.cacheReadPerMTok === undefined ? {} : { cacheReadPerMTok: price.cacheReadPerMTok }),
    ...(price.cacheWritePerMTok === undefined
      ? {}
      : { cacheWritePerMTok: price.cacheWritePerMTok }),
    ...(price.cacheWrite1hPerMTok === undefined
      ? {}
      : { cacheWrite1hPerMTok: price.cacheWrite1hPerMTok }),
    ...(price.tiers === undefined
      ? {}
      : {
          tiers: price.tiers.map((tier) => ({
            aboveTokens: tier.aboveTokens,
            inputPerMTok: tier.inputPerMTok,
            outputPerMTok: tier.outputPerMTok,
            ...(tier.cacheReadPerMTok === undefined
              ? {}
              : { cacheReadPerMTok: tier.cacheReadPerMTok }),
            ...(tier.cacheWritePerMTok === undefined
              ? {}
              : { cacheWritePerMTok: tier.cacheWritePerMTok }),
            ...(tier.cacheWrite1hPerMTok === undefined
              ? {}
              : { cacheWrite1hPerMTok: tier.cacheWrite1hPerMTok }),
          })),
        }),
  };
}

function probeTargetOf(msg: {
  protocol?: GatewayProviderWire["protocol"];
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  insecureTls?: boolean;
  modelsUrl?: string;
  model?: string;
}) {
  return {
    // A detection asks every protocol; the protocol here is only its default.
    protocol: msg.protocol ?? "openai",
    baseUrl: msg.baseUrl,
    ...(msg.apiKey === undefined ? {} : { apiKey: msg.apiKey }),
    ...(msg.headers === undefined ? {} : { headers: msg.headers }),
    ...(msg.insecureTls === true ? { insecureTls: true } : {}),
    ...(msg.modelsUrl === undefined ? {} : { modelsUrl: msg.modelsUrl }),
  };
}

type DaemonMessage = Extract<
  SessionInboundMessage,
  {
    type:
      | "get_daemon_config_request"
      | "daemon.get_status.request"
      | "daemon.get_pairing_offer.request"
      | "daemon.config.reload.request"
      | "daemon.path.reveal.request"
      | "daemon.web_page.get.request"
      | "daemon.web_page.set.request"
      | "hub.management.daemon.connect.request"
      | "hub.management.daemon.get_status.request"
      | "hub.management.daemon.disconnect.request"
      | "hub.management.daemon.permissions.update.request"
      | "diagnostics.request"
      | "daemon.diagnostics.heap.request"
      | "daemon.diagnostics.cpu.request"
      | "daemon.diagnostics.handles.request"
      | "daemon.update.request"
      | "set_daemon_config_request";
  }
>;

function isDaemonMessage(message: SessionInboundMessage): message is DaemonMessage {
  return (
    message.type === "get_daemon_config_request" ||
    message.type === "daemon.get_status.request" ||
    message.type === "daemon.get_pairing_offer.request" ||
    message.type === "daemon.config.reload.request" ||
    message.type === "daemon.path.reveal.request" ||
    message.type === "daemon.web_page.get.request" ||
    message.type === "daemon.web_page.set.request" ||
    message.type.startsWith("hub.management.daemon.") ||
    message.type === "diagnostics.request" ||
    message.type === "daemon.diagnostics.heap.request" ||
    message.type === "daemon.diagnostics.cpu.request" ||
    message.type === "daemon.diagnostics.handles.request" ||
    message.type === "daemon.update.request" ||
    message.type === "set_daemon_config_request"
  );
}

/** Says how the agent has each advised setting now, from its own files. */
async function enrichTuneAdvice(entry: TuneAdvice, neolixHome: string): Promise<TuneAdvice> {
  const agent = entry.agent as TuneAgent;
  const next: TuneAdvice = { ...entry };
  if (entry.compact !== undefined) {
    next.compact = {
      ...entry.compact,
      setting: await readTuneSetting({
        agent,
        knob: "compact",
        model: entry.compact.model,
        neolixHome,
      }),
    };
  }
  if (entry.ttl !== undefined) {
    next.ttl = {
      ...entry.ttl,
      setting: await readTuneSetting({ agent, knob: "cache_ttl", neolixHome }),
    };
  }
  return next;
}

function tuneErrorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function isGatewayRpcRequest(message: SessionInboundMessage): message is GatewayRpcRequest {
  return (
    message.type === "gateway.config.get.request" ||
    message.type === "gateway.config.set.request" ||
    message.type === "gateway.tune.get.request" ||
    message.type === "gateway.warmup.warm-at.request" ||
    message.type === "gateway.warmup.account-warm-at.request" ||
    message.type === "gateway.catalog.refresh.request" ||
    isGatewayQuotaRpcRequest(message) ||
    isGatewayMaskingRpcRequest(message) ||
    isGatewayCheckinRpcRequest(message) ||
    isGatewayPluginSubscriptionRpcRequest(message) ||
    isGatewayPluginAgentRpcRequest(message) ||
    isGatewayReadRpcRequest(message) ||
    isGatewayProviderRpcRequest(message)
  );
}

/** Usage and quota reads, and warming a window by hand. */
function isGatewayQuotaRpcRequest(message: { type: string }): message is Extract<
  SessionInboundMessage,
  {
    type:
      | "gateway.usage.get.request"
      | "gateway.search.quota.request"
      | "gateway.quota.get.request"
      | "gateway.quota.reset.request"
      | "gateway.quota.warm.request";
  }
> {
  return (
    message.type === "gateway.usage.get.request" ||
    message.type === "gateway.search.quota.request" ||
    message.type === "gateway.quota.get.request" ||
    message.type === "gateway.quota.reset.request" ||
    message.type === "gateway.quota.warm.request"
  );
}

/** What masking swapped, for the settings page. */
function isGatewayMaskingRpcRequest(message: { type: string }): message is Extract<
  SessionInboundMessage,
  {
    type:
      | "gateway.masking.summary.request"
      | "gateway.masking.records.request"
      | "gateway.masking.record.request"
      | "gateway.masking.preview.request"
      | "gateway.masking.clear.request"
      | "gateway.masking.local_model.status.request"
      | "gateway.masking.local_model.download.request"
      | "gateway.masking.local_model.cancel.request"
      | "gateway.masking.local_model.remove.request";
  }
> {
  return (
    message.type === "gateway.masking.summary.request" ||
    message.type === "gateway.masking.records.request" ||
    message.type === "gateway.masking.record.request" ||
    message.type === "gateway.masking.preview.request" ||
    message.type === "gateway.masking.clear.request" ||
    message.type === "gateway.masking.local_model.status.request" ||
    message.type === "gateway.masking.local_model.download.request" ||
    message.type === "gateway.masking.local_model.cancel.request" ||
    message.type === "gateway.masking.local_model.remove.request"
  );
}

/** The daily check-ins the Usage card shows, and a press asks for. */
function isGatewayCheckinRpcRequest(message: { type: string }): message is Extract<
  SessionInboundMessage,
  {
    type:
      | "gateway.checkin.status.request"
      | "gateway.checkin.run.request"
      | "gateway.checkin.switch.request"
      | "gateway.checkin.account.request";
  }
> {
  return (
    message.type === "gateway.checkin.status.request" ||
    message.type === "gateway.checkin.run.request" ||
    message.type === "gateway.checkin.switch.request" ||
    message.type === "gateway.checkin.account.request"
  );
}

/** A plugin subscription provider's list, models and sign-in. */
function isGatewayPluginSubscriptionRpcRequest(message: { type: string }): message is Extract<
  SessionInboundMessage,
  {
    type:
      | "gateway.plugin.subscription.list.request"
      | "gateway.plugin.subscription.models.request"
      | "gateway.plugin.subscription.sign_in.request"
      | "gateway.plugin.subscription.sign_in.poll.request";
  }
> {
  return (
    message.type === "gateway.plugin.subscription.list.request" ||
    message.type === "gateway.plugin.subscription.models.request" ||
    message.type === "gateway.plugin.subscription.sign_in.request" ||
    message.type === "gateway.plugin.subscription.sign_in.poll.request"
  );
}

/** A plugin's agent wiring: the list and the write. */
function isGatewayPluginAgentRpcRequest(message: { type: string }): message is Extract<
  SessionInboundMessage,
  {
    type: "gateway.plugin.agent.list.request" | "gateway.plugin.agent.wire.request";
  }
> {
  return (
    message.type === "gateway.plugin.agent.list.request" ||
    message.type === "gateway.plugin.agent.wire.request"
  );
}

/** The held-request report RPCs (myna's routing page's Copy Report). */
function isHeldReportRequest(message: { type: string }): message is Extract<
  SessionInboundMessage,
  {
    type: "gateway.held.list.request" | "gateway.held.read.request" | "gateway.held.reveal.request";
  }
> {
  return (
    message.type === "gateway.held.list.request" ||
    message.type === "gateway.held.read.request" ||
    message.type === "gateway.held.reveal.request"
  );
}

/** The OIDC rule management RPCs (myna's gateway-key oidc list/add/remove). */
function isOidcRuleRequest(message: { type: string }): message is Extract<
  SessionInboundMessage,
  {
    type:
      | "gateway.oidc.rules.list.request"
      | "gateway.oidc.rule.save.request"
      | "gateway.oidc.rule.remove.request";
  }
> {
  return (
    message.type === "gateway.oidc.rules.list.request" ||
    message.type === "gateway.oidc.rule.save.request" ||
    message.type === "gateway.oidc.rule.remove.request"
  );
}

function createExternalSessionsSession(input: {
  neolixHome: string;
  llmGateway: SessionOptions["llmGateway"];
  logger: pino.Logger;
  emit: (message: SessionOutboundMessage) => void;
  isWslEnabled: () => boolean;
  sessionTerminal: () => string;
}): ExternalSessionsSession {
  const gateway = input.llmGateway;
  const conversations =
    gateway === undefined
      ? undefined
      : new GatewayConversations({
          neolixHome: input.neolixHome,
          configStore: gateway.configStore,
          logger: input.logger,
          scrub: (text) => gateway.masker.maskText(text),
        });
  const pricing = gateway?.runtime.pricing;
  return new ExternalSessionsSession({
    service: new ExternalSessionsService({
      neolixHome: input.neolixHome,
      wslEnabled: input.isWslEnabled,
      // gateway.json is watched, so `neolix sessions read` is in force at once.
      reads: () => sessionReadsOf(gateway?.configStore.get()),
      ...(conversations === undefined ? {} : { conversations }),
      ...(pricing === undefined ? {} : { pricer: (model: string) => pricing.priceFor("", model) }),
    }),
    conversations,
    terminals: {
      list: () => listTerminals(),
      open: (terminal: { command: string; cwd: string; label: string }) =>
        openInTerminal({ ...terminal, app: input.sessionTerminal() }),
    },
    ...(gateway === undefined
      ? {}
      : {
          reads: {
            snapshot: async () =>
              sessionReadsSnapshot(
                sessionReadsOf(gateway.configStore.get()),
                await foundSessionAgents(),
              ),
            set: async (change: {
              all?: boolean | undefined;
              agents?: Record<string, boolean> | undefined;
            }) => {
              const next = setSessionReads(
                sessionReadsOf(gateway.configStore.get()),
                change.all,
                change.agents ?? {},
              );
              await gateway.configStore.write({
                ...gateway.configStore.get(),
                codexSessionReads: next,
              });
              return sessionReadsSnapshot(next, await foundSessionAgents());
            },
          },
        }),
    emit: input.emit,
  });
}

/** The page state as the wire schema has it: plain fields, no extra keys. */
function webPageWire(page: ReturnType<typeof currentWebPageState>): {
  mode: "off" | "local" | "lan";
  port: number;
  tls?: boolean;
  addr?: string | null;
  serving: boolean;
  link: string | null;
  network: string[];
  error: string | null;
} {
  return {
    mode: page.mode,
    port: page.port,
    tls: page.tls,
    addr: page.addr,
    serving: page.serving,
    link: page.link,
    network: page.network,
    error: page.error,
  };
}
