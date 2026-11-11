export type { TerminalReplayEvent, TerminalStreamEvent } from "./terminal-stream-router.js";
import type { AgentAddress } from "@neolix/protocol/addresses";
import { parentAddressLabels } from "@neolix/protocol/agent-labels";
export type { AgentAddress } from "@neolix/protocol/addresses";
import { createHostActions, type NeolixHostActions } from "./hosts/index.js";
export type { NeolixHostActions } from "./hosts/index.js";
export type { HostAdd, HostUpdate, HostSummary, HostDirectory } from "@neolix/protocol/hosts";
import type { OwnedSubscription } from "./connection/index.js";
export type { OwnedSubscription, SubscriptionObserver } from "./connection/index.js";
import type { DaemonClientConfig } from "./daemon-client.js";
import type { AgentPermissionResponse } from "@neolix/protocol/agent-types";
import type {
  AgentSnapshotPayload,
  CreationSnapshot,
  CreateAgentRequestMessage,
  FetchWorkspacesRequestMessage,
  FetchWorkspacesResponseMessage,
  GetProvidersSnapshotResponseMessage,
  ListAvailableProvidersResponse,
  ListCommandsResponse,
  ListProviderFeaturesRequestMessage,
  ListProviderFeaturesResponseMessage,
  ListProviderModelsResponseMessage,
  ProjectListRequestMessage,
  ProjectListResponseMessage,
  ListProviderModesResponseMessage,
  MutableDaemonConfig,
  MutableDaemonConfigPatch,
  ProviderDiagnosticResponseMessage,
  ProviderUsageListResponseMessage,
  ProjectPlacementPayload,
  WorkspaceProjectDescriptorPayload,
  RefreshProvidersSnapshotResponseMessage,
  SessionOutboundMessage,
  WorkspaceDescriptorPayload,
  WorkspaceCreateRequest,
} from "@neolix/protocol/messages";
import { DaemonClient, type CreateAgentRequestOptions } from "./daemon-client.js";
import {
  createTerminalActions,
  type NeolixTerminalActions,
  type NeolixWorkspaceTerminalActions,
} from "./terminals/index.js";
export type {
  NeolixTerminal,
  NeolixTerminalActions,
  NeolixTerminalHandle,
  NeolixTerminalCreateOptions,
  NeolixTerminalListOptions,
  NeolixTerminalListResult,
  NeolixTerminalCaptureOptions,
  NeolixTerminalCaptureResult,
  NeolixWorkspaceTerminalActions,
} from "./terminals/index.js";
import type { PluginTimelineItem } from "@neolix/protocol/agent-types";
import type {
  FetchAgentsEntry,
  FetchAgentsOptions,
  FetchAgentsPageInfo,
  FetchAgentTimelineCursor,
  FetchAgentTimelineDirection,
  FetchAgentTimelinePayload,
  FetchAgentTimelineProjection,
  SendMessageOptions,
  WaitForFinishResult,
} from "./daemon-client.js";

/**
 * Coding turns routinely run for minutes, so the handle waits far longer than
 * the transport's own conservative default.
 */
const DEFAULT_WAIT_FOR_FINISH_MS = 10 * 60_000;

export type ConnectionState =
  | { status: "idle" }
  | { status: "connecting"; attempt: number }
  | { status: "connected" }
  | { status: "disconnected"; reason?: string }
  | { status: "disposed" };

export interface NeolixLogger {
  debug(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface NeolixClientConfig {
  capabilities?: DaemonClientConfig["capabilities"];
  url: string;
  clientId?: string;
  appVersion?: string;
  runtimeGeneration?: number | null;
  password?: string;
  authHeader?: string;
  suppressSendErrors?: boolean;
  logger?: NeolixLogger;
  connectTimeoutMs?: number;
  e2ee?: {
    enabled?: boolean;
    daemonPublicKeyB64?: string;
  };
  reconnect?: {
    enabled?: boolean;
    baseDelayMs?: number;
    maxDelayMs?: number;
  };
  runtimeMetricsIntervalMs?: number;
  runtimeMetricsWindowMs?: number;
}

export type NeolixWorkspace = WorkspaceDescriptorPayload;
export type NeolixAgent = AgentSnapshotPayload;
export type NeolixAgentListOptions = FetchAgentsOptions;
export type NeolixProject = WorkspaceProjectDescriptorPayload;
export type NeolixProjectListOptions = Omit<ProjectListRequestMessage, "type" | "requestId"> & {
  requestId?: string;
};
export type NeolixProjectListResult = ProjectListResponseMessage["payload"];
export type NeolixProjectUpdate = Extract<
  SessionOutboundMessage,
  { type: "project.update" }
>["payload"];
export type NeolixProjectUpdateHandler = (update: NeolixProjectUpdate) => void;

export interface NeolixAgentListResult {
  subscription?: OwnedSubscription<NeolixAgentListResult>;
  requestId: string;
  subscriptionId?: string | null;
  entries: FetchAgentsEntry[];
  pageInfo: FetchAgentsPageInfo;
}
export type NeolixWorkspaceListOptions = Omit<
  FetchWorkspacesRequestMessage,
  "type" | "requestId"
> & {
  requestId?: string;
};

export interface NeolixWorkspaceListResult {
  subscription?: OwnedSubscription<NeolixWorkspaceListResult>;
  requestId: string;
  subscriptionId?: string | null;
  entries: NeolixWorkspace[];
  pageInfo: FetchWorkspacesResponseMessage["payload"]["pageInfo"];
}

export interface NeolixWorkspaceOpenOptions {
  cwd: string;
  requestId?: string;
}

export type NeolixWorkspaceCreateOptions = Omit<
  WorkspaceCreateRequest,
  "type" | "requestId" | "agent" | "subscribe"
> & {
  requestId?: string;
  agent?: Omit<
    NeolixAgentCreateOptions,
    "worktree" | "git" | "onEvent" | "idempotencyKey" | "requestId"
  >;
  onEvent?: (snapshot: CreationSnapshot) => void;
};

export interface NeolixWorkspaceArchiveResult {
  requestId: string;
  workspaceId: string;
  archivedAt: string | null;
  error: string | null;
}

export type NeolixWorkspaceUpdate = Extract<
  SessionOutboundMessage,
  { type: "workspace_update" }
>["payload"];

export type NeolixWorkspaceUpdateHandler = (update: NeolixWorkspaceUpdate) => void;

export interface NeolixWorkspaceHandle {
  readonly id: string;
  readonly projectId: string | null;
  readonly directory: string | null;
  readonly name: string | null;
  readonly status: NeolixWorkspace["status"] | null;
  readonly agents: {
    create(options: NeolixWorkspaceAgentCreateOptions): Promise<NeolixAgentHandle>;
  };
  readonly terminals: NeolixWorkspaceTerminalActions;
  current(): NeolixWorkspace | null;
  refresh(options?: { requestId?: string }): Promise<NeolixWorkspace | null>;
  setTitle(title: string | null, requestId?: string): Promise<{ title: string | null }>;
  archive(requestId?: string): Promise<NeolixWorkspaceArchiveResult>;
  /**
   * Subscribes to already-emitted daemon workspace_update events for this id.
   * This returns a local unsubscribe function; it does not own app cache state or
   * send a daemon unsubscribe RPC. Call `workspaces.list({ subscribe: {} })` when
   * the daemon should start streaming workspace directory updates.
   */
  subscribe(handler: (update: NeolixWorkspaceUpdate) => void): () => void;
}

export interface NeolixProjectActions {
  list(options?: NeolixProjectListOptions): Promise<NeolixProjectListResult>;
  subscribe(handler: NeolixProjectUpdateHandler): () => void;
}

export interface NeolixWorkspaceActions {
  list(options: NeolixWorkspaceListOptions & { subscribe: {} }): Promise<
    NeolixWorkspaceListResult & {
      subscriptionId: string;
      subscription: OwnedSubscription<NeolixWorkspaceListResult>;
    }
  >;
  list(options?: NeolixWorkspaceListOptions): Promise<NeolixWorkspaceListResult>;
  ref(workspace: string | NeolixWorkspace): NeolixWorkspaceHandle;
  open(
    input: string | NeolixWorkspaceOpenOptions,
    requestId?: string,
  ): Promise<NeolixWorkspaceHandle>;
  create(options: NeolixWorkspaceCreateOptions): Promise<NeolixWorkspaceHandle>;
  archive(
    workspace: string | NeolixWorkspaceHandle,
    requestId?: string,
  ): Promise<NeolixWorkspaceArchiveResult>;
  /**
   * Local event subscription over the low-level driver's workspace_update stream.
   * The returned function only removes this SDK listener.
   */
  subscribe(handler: NeolixWorkspaceUpdateHandler): () => void;
}

type NeolixAgentSessionConfig = CreateAgentRequestMessage["config"];
export type NeolixAgentProvider = NeolixAgentSessionConfig["provider"];

export type NeolixProviderFeatureValues = Record<string, unknown>;

export interface NeolixAgentConfig {
  /** Provider and model in `provider/model` format. */
  provider: string;
  modeId?: NeolixAgentSessionConfig["modeId"];
  thinkingOptionId?: NeolixAgentSessionConfig["thinkingOptionId"];
  featureValues?: NeolixProviderFeatureValues;
  /** JSON-safe provider-native settings, validated by the selected provider. */
  options?: NeolixAgentSessionConfig["providerOptions"];
  systemPrompt?: NeolixAgentSessionConfig["systemPrompt"];
  toolPolicy?: NeolixAgentSessionConfig["toolPolicy"];
  mcpServers?: NeolixAgentSessionConfig["mcpServers"];
}

export interface NeolixAgentCreateOptions {
  idempotencyKey?: string;
  agentId?: string;
  onEvent?: (snapshot: CreationSnapshot) => void;
  config: NeolixAgentConfig;
  cwd: string;
  parent?: string | AgentAddress | NeolixAgentHandle;
  title?: NeolixAgentSessionConfig["title"];
  env?: CreateAgentRequestMessage["env"];
  prompt?: string;
  clientMessageId?: string;
  outputSchema?: Record<string, unknown>;
  images?: CreateAgentRequestMessage["images"];
  attachments?: CreateAgentRequestMessage["attachments"];
  git?: CreateAgentRequestMessage["git"];
  worktree?: CreateAgentRequestMessage["worktree"];
  autoArchive?: CreateAgentRequestMessage["autoArchive"];
  /**
   * Creates a background agent: hidden from default lists, tabs, the parent's subagent track
   * and notifications, and still addressable by id. A workspace this call creates is
   * background too. With a parent and no value, the parent's own background applies.
   */
  background?: CreateAgentRequestMessage["background"];
  requestId?: string;
  labels?: Record<string, string>;
}

export type NeolixWorkspaceAgentCreateOptions = Omit<NeolixAgentCreateOptions, "cwd">;

export interface NeolixAgentRefetchResult {
  agent: NeolixAgent;
  project: ProjectPlacementPayload | null;
}

export interface NeolixAgentTimelineRefetchOptions {
  direction?: FetchAgentTimelineDirection;
  cursor?: FetchAgentTimelineCursor;
  limit?: number;
  projection?: FetchAgentTimelineProjection;
  requestId?: string;
}

export type NeolixAgentSendOptions = SendMessageOptions;

export interface NeolixAgentRunOptions extends NeolixAgentSendOptions {
  timeoutMs?: number;
}

export type NeolixAgentRunResult = WaitForFinishResult;
export type NeolixAgentPermissionResponse = AgentPermissionResponse;

export interface NeolixAgentRespondToPermissionOptions {
  requestId: string;
  response: NeolixAgentPermissionResponse;
}

export interface NeolixAgentCommandsOptions {
  requestId?: string;
}

export type NeolixAgentCommandsResult = ListCommandsResponse["payload"];

export type NeolixAgentUpdate = Extract<
  SessionOutboundMessage,
  { type: "agent_update" }
>["payload"];

export type NeolixAgentStream = Extract<
  SessionOutboundMessage,
  { type: "agent_stream" }
>["payload"];

export type NeolixAgentUpdateHandler = (update: NeolixAgentUpdate) => void;

export type NeolixAgentTimelineEvent =
  | NeolixAgentStream
  | {
      agentId: string;
      event: { type: "replacement"; epoch: string };
    }
  | {
      agentId: string;
      subscriptionId: string;
      event: { type: "subscription_restored" };
    }
  | { agentId: string; event: { type: "error"; error: string } };

export type NeolixAgentTimelineSubscription = ReturnType<DaemonClient["subscribeAgentTimeline"]>;

export interface NeolixAgentTimelineHandle {
  append(item: Omit<PluginTimelineItem, "pluginId">): Promise<{ seq: number; epoch: string }>;
  /**
   * Fetches a fresh timeline page through the existing daemon RPC. If the daemon
   * includes an agent snapshot in the response, the parent handle is updated to
   * that value.
   */
  refetch(options?: NeolixAgentTimelineRefetchOptions): Promise<FetchAgentTimelinePayload>;
  /**
   * Delivers live events only. After reconnect, subscription_restored precedes
   * subsequent updates. History may have been missed; use refetch() to request
   * the range you need. No history is fetched automatically. A replacement event
   * invalidates the previous epoch. Subscription errors release this observation.
   * Await the returned unsubscribe function's `ready` promise before starting
   * work that must be observed. It rejects if establishment fails.
   */
  subscribe(handler: (event: NeolixAgentTimelineEvent) => void): NeolixAgentTimelineSubscription;
}

export interface NeolixAgentHandle {
  readonly id: string;
  readonly address: AgentAddress;
  /**
   * `workspaceId` through `archivedAt` mirror the last snapshot this handle
   * observed. A handle from `ref()` reads `null` for all of them until
   * `refresh()`, `run()`, `waitForFinish()`, a timeline refetch, or
   * `subscribe()` delivers a snapshot. Optional snapshot values also read as
   * `null`; use `current()` when you need to distinguish those states.
   */
  readonly workspaceId: string | null;
  readonly cwd: string | null;
  readonly status: NeolixAgent["status"] | null;
  readonly capabilities: NeolixAgent["capabilities"] | null;
  readonly availableModes: NeolixAgent["availableModes"] | null;
  readonly pendingPermissions: NeolixAgent["pendingPermissions"] | null;
  readonly activeTurn: NonNullable<NeolixAgent["activeTurn"]> | null;
  readonly lastUsage: NonNullable<NeolixAgent["lastUsage"]> | null;
  readonly lastError: NonNullable<NeolixAgent["lastError"]> | null;
  readonly features: NonNullable<NeolixAgent["features"]> | null;
  readonly runtimeInfo: NonNullable<NeolixAgent["runtimeInfo"]> | null;
  readonly archivedAt: NonNullable<NeolixAgent["archivedAt"]> | null;
  readonly timeline: NeolixAgentTimelineHandle;
  current(): NeolixAgent | null;
  refresh(requestId?: string): Promise<NeolixAgentRefetchResult | null>;
  /**
   * Reopens the provider session with current configuration, rerunning session-open hooks.
   * Interrupts a running turn and returns the refreshed snapshot.
   */
  reload(options?: { requestId?: string }): Promise<NeolixAgentRefetchResult | null>;
  send(text: string, options?: NeolixAgentSendOptions): Promise<void>;
  respondToPermission(options: NeolixAgentRespondToPermissionOptions): Promise<void>;
  /** Sends a prompt and resolves when that turn finishes or needs attention. */
  run(text: string, options?: NeolixAgentRunOptions): Promise<NeolixAgentRunResult>;
  /** Waits for the current turn, including one started with `prompt`. */
  waitForFinish(timeoutMs?: number): Promise<NeolixAgentRunResult>;
  /**
   * Asks the running session for the slash commands and skills it actually
   * loaded. Providers answer from the live session, so this sees built-in and
   * bundled entries that no directory scan can find. The payload carries its own
   * `error` string; a provider that cannot answer reports it there rather than
   * rejecting.
   */
  commands(options?: NeolixAgentCommandsOptions): Promise<NeolixAgentCommandsResult>;
  archive(): Promise<{ archivedAt: string }>;
  detach(): Promise<void>;
  subscribe(handler: (update: NeolixAgentUpdate) => void): () => void;
}

export interface NeolixAgentActions {
  list(options: NeolixAgentListOptions & { subscribe: {} }): Promise<
    NeolixAgentListResult & {
      subscriptionId: string;
      subscription: OwnedSubscription<NeolixAgentListResult>;
    }
  >;
  list(options?: NeolixAgentListOptions): Promise<NeolixAgentListResult>;
  ref(agent: string | NeolixAgent): NeolixAgentHandle;
  create(options: NeolixAgentCreateOptions): Promise<NeolixAgentHandle>;
  /**
   * Local event subscription over the low-level driver's agent_update stream.
   * The returned function only removes this SDK listener.
   */
  subscribe(handler: NeolixAgentUpdateHandler): () => void;
}

export type NeolixProviderModelsResult = ListProviderModelsResponseMessage["payload"];
export type NeolixProviderModesResult = ListProviderModesResponseMessage["payload"];
type NeolixProviderFeaturesDraft = ListProviderFeaturesRequestMessage["draftConfig"];
export interface NeolixProviderFeaturesInput extends Omit<
  NeolixProviderFeaturesDraft,
  "provider" | "model"
> {
  /** Provider and model in `provider/model` format. */
  provider: string;
}
export type NeolixProviderFeaturesResult = ListProviderFeaturesResponseMessage["payload"];
export type NeolixProviderAvailabilityResult = ListAvailableProvidersResponse["payload"];
export type NeolixProviderSnapshotResult = GetProvidersSnapshotResponseMessage["payload"];
export type NeolixProviderSnapshotUpdate = Extract<
  SessionOutboundMessage,
  { type: "providers_snapshot_update" }
>["payload"];
export type NeolixProviderRefreshResult = RefreshProvidersSnapshotResponseMessage["payload"];
export type NeolixProviderDiagnosticResult = ProviderDiagnosticResponseMessage["payload"];
export type NeolixProviderUsageResult = ProviderUsageListResponseMessage["payload"];
export interface NeolixProviderUsageOptions {
  requestId?: string;
}

export interface NeolixProviderListOptions {
  cwd?: string;
  requestId?: string;
}

export interface NeolixProviderRefreshOptions {
  cwd?: string;
  providers?: NeolixAgentProvider[];
  requestId?: string;
}

export interface NeolixProviderWaitOptions extends NeolixProviderListOptions {
  timeoutMs?: number;
}

export interface NeolixProviderActions {
  listModels(
    provider: NeolixAgentProvider,
    options?: NeolixProviderListOptions,
  ): Promise<NeolixProviderModelsResult>;
  listModes(
    provider: NeolixAgentProvider,
    options?: NeolixProviderListOptions,
  ): Promise<NeolixProviderModesResult>;
  listFeatures(
    draftConfig: NeolixProviderFeaturesInput,
    options?: { requestId?: string },
  ): Promise<NeolixProviderFeaturesResult>;
  listAvailable(options?: { requestId?: string }): Promise<NeolixProviderAvailabilityResult>;
  snapshot(options?: NeolixProviderListOptions): Promise<NeolixProviderSnapshotResult>;
  /** Resolves after the daemon's lazy provider discovery has finished. */
  waitForReady(options?: NeolixProviderWaitOptions): Promise<NeolixProviderSnapshotResult>;
  refresh(options?: NeolixProviderRefreshOptions): Promise<NeolixProviderRefreshResult>;
  diagnostic(
    provider: NeolixAgentProvider,
    options?: { requestId?: string },
  ): Promise<NeolixProviderDiagnosticResult>;
  listUsage(options?: NeolixProviderUsageOptions): Promise<NeolixProviderUsageResult>;
  subscribe(handler: (update: NeolixProviderSnapshotUpdate) => void): () => void;
}

export interface NeolixConfigActions {
  /**
   * Reads daemon config through the existing config RPC. Provider profiles,
   * custom provider entries, keys/env, custom binaries, and provider enablement
   * are currently config-file-shaped daemon state, so the SDK exposes this raw
   * typed surface instead of pretending there are higher-level provider-settings
   * RPCs.
   */
  get(requestId?: string): Promise<{ requestId: string; config: MutableDaemonConfig }>;
  /**
   * Patches daemon config through the existing config RPC. The daemon validates
   * and persists supported fields; unsupported provider/settings workflows remain
   * daemon gaps until first-class RPCs exist.
   */
  patch(
    config: MutableDaemonConfigPatch,
    requestId?: string,
  ): Promise<{ requestId: string; config: MutableDaemonConfig }>;
}

export interface NeolixGatewayProvider {
  id: string;
  name: string;
}

export type NeolixGatewayUsageResult = Extract<
  SessionOutboundMessage,
  { type: "gateway.usage.get.response" }
>["payload"];

export interface NeolixGatewayUsageQuery {
  period?: "today" | "7d" | "30d" | "all" | "custom";
  from?: string;
  to?: string;
  timezoneOffsetMinutes?: number;
}

export interface NeolixGatewayActions {
  /** The model gateway's providers, by id and label: no key, account or address. */
  providers(): Promise<NeolixGatewayProvider[]>;
  /** The gateway's token and cost usage for a period. */
  usage(query?: NeolixGatewayUsageQuery): Promise<NeolixGatewayUsageResult>;
}

export interface NeolixApi {
  readonly hosts: NeolixHostActions;
  dispose(): Promise<void>;
  observeEvents: DaemonClient["observeEvents"];
  readonly terminals: NeolixTerminalActions;
  readonly workspaces: NeolixWorkspaceActions;
  readonly projects: NeolixProjectActions;
  readonly agents: NeolixAgentActions;
  readonly providers: NeolixProviderActions;
  readonly config: NeolixConfigActions;
  readonly gateway: NeolixGatewayActions;
}

export interface NeolixClient extends NeolixApi {
  connect(): Promise<void>;
  close(): Promise<void>;
  ensureConnected(): void;
  getConnectionState(): ConnectionState;
}

export function createNeolixClient(config: NeolixClientConfig): NeolixClient {
  const daemonClient = new DaemonClient({
    ...config,
    clientId: config.clientId ?? createGeneratedClientId(),
    clientType: "cli",
  });
  const api = createNeolixApi(daemonClient);
  return {
    ...api,
    connect: () => daemonClient.connect(),
    close: async () => {
      try {
        await api.dispose();
      } finally {
        await daemonClient.close();
      }
    },
    ensureConnected: () => daemonClient.ensureConnected(),
    getConnectionState: () => daemonClient.getConnectionState(),
  };
}

function toDaemonAgentCreateOptions(
  options: NeolixAgentCreateOptions,
  placement?: { workspaceId: string; cwd: string },
  serverId?: string,
): CreateAgentRequestOptions {
  const { config: agentConfig, cwd, parent, title, prompt, ...requestOptions } = options;
  const { provider: providerModel, options: providerOptions, ...runtimeConfig } = agentConfig;
  const { provider, model } = parseProviderModel(providerModel);
  const relationship = parent ? encodeParent(parent, serverId) : {};
  return {
    ...requestOptions,
    config: {
      ...runtimeConfig,
      provider,
      model,
      cwd: placement?.cwd ?? cwd,
      ...(title !== undefined ? { title } : {}),
      ...(providerOptions !== undefined ? { providerOptions } : {}),
    },
    ...(placement ? { workspaceId: placement.workspaceId } : {}),
    ...(parent
      ? {
          ...relationship,
          labels: { ...requestOptions.labels, ...relationship.labels },
        }
      : {}),
    ...(prompt !== undefined ? { initialPrompt: prompt } : {}),
  };
}

export function createNeolixApi(
  daemonClient: DaemonClient,
  scopeOptions?: { signal?: AbortSignal },
): NeolixApi {
  const handles = new Set<{ release(): Promise<void> }>();
  const agentListeners = new Set<NeolixAgentUpdateHandler>();
  const workspaceListeners = new Set<NeolixWorkspaceUpdateHandler>();
  const lifetime = new AbortController();
  const own = <T extends { release(): Promise<void> }>(create: () => T): T => {
    if (lifetime.signal.aborted) throw new Error("Neolix API is disposed");
    const handle = create();
    handles.add(handle);
    const release = handle.release.bind(handle);
    handle.release = async () => {
      await release();
      handles.delete(handle);
    };
    return handle;
  };
  const listenAgents = (handler: NeolixAgentUpdateHandler) => {
    if (lifetime.signal.aborted) throw new Error("Neolix API is disposed");
    agentListeners.add(handler);
    return () => {
      agentListeners.delete(handler);
    };
  };
  const listenWorkspaces = (handler: NeolixWorkspaceUpdateHandler) => {
    if (lifetime.signal.aborted) throw new Error("Neolix API is disposed");
    workspaceListeners.add(handler);
    return () => {
      workspaceListeners.delete(handler);
    };
  };
  const createAgentHandle = createAgentHandleFactory(
    daemonClient,
    listenAgents,
    (agentId, handler) => own(() => daemonClient.subscribeAgentTimeline(agentId, handler)),
  );
  const createAgent = async (
    options: NeolixAgentCreateOptions,
    placement?: { workspaceId: string; cwd: string },
  ) => {
    const serverId = daemonClient.getLastServerInfoMessage()?.serverId;
    const foreignParent =
      options.background === undefined ? foreignParentHandle(options.parent, serverId) : null;
    const resolved = foreignParent
      ? await inheritParentBackground(options, foreignParent)
      : options;
    const agent = await daemonClient.createAgent(
      toDaemonAgentCreateOptions(resolved, placement, serverId),
    );
    return createAgentHandle(agent);
  };
  const terminals = createTerminalActions(daemonClient, async (workspaceId) => {
    const workspace = await createWorkspaceHandle(workspaceId).refresh();
    if (!workspace?.workspaceDirectory) {
      throw new Error(`Workspace ${workspaceId} is not active or has no available directory`);
    }
    return workspace.workspaceDirectory;
  });
  const createWorkspaceHandle = createWorkspaceHandleFactory(
    daemonClient,
    createAgent,
    terminals,
    listenWorkspaces,
  );

  let disposal: Promise<void> | null = null;
  const dispose = (): Promise<void> => {
    if (disposal) return disposal;
    lifetime.abort();
    scopeOptions?.signal?.removeEventListener("abort", abort);
    agentListeners.clear();
    workspaceListeners.clear();
    disposal = Promise.allSettled([...handles].map((handle) => handle.release())).then(
      (results) => {
        handles.clear();
        const failures = results.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        );
        if (failures.length)
          throw new AggregateError(failures, "Failed to release API subscriptions");
        return undefined;
      },
    );
    return disposal;
  };
  const abort = () => {
    void dispose().catch((error) => console.error("API subscription cleanup failed", error));
  };
  if (scopeOptions?.signal?.aborted) abort();
  else scopeOptions?.signal?.addEventListener("abort", abort, { once: true });

  const observeEvents: DaemonClient["observeEvents"] = (events, options) =>
    own(() => daemonClient.observeEvents(events, options));

  const subscribeEvent = (
    event: "project.update" | "providers_snapshot_update",
    update: (message: SessionOutboundMessage) => void,
  ): (() => void) => {
    const observation = observeEvents([event]);
    observation.subscribe({ snapshot: () => {}, update });
    return () => {
      void observation
        .release()
        .catch((error) => console.error("Event subscription cleanup failed", error));
    };
  };

  function listWorkspaces(options: NeolixWorkspaceListOptions & { subscribe: {} }): Promise<
    NeolixWorkspaceListResult & {
      subscriptionId: string;
      subscription: OwnedSubscription<NeolixWorkspaceListResult>;
    }
  >;
  function listWorkspaces(options?: NeolixWorkspaceListOptions): Promise<NeolixWorkspaceListResult>;
  async function listWorkspaces(
    options?: NeolixWorkspaceListOptions,
  ): Promise<NeolixWorkspaceListResult> {
    if (!options?.subscribe) return daemonClient.fetchWorkspaces(options);
    if (options.subscribe.subscriptionId !== undefined)
      throw new Error("Subscription IDs are assigned by the host");
    const subscription = own(() => daemonClient.observeWorkspaces(options));
    subscription.subscribe({
      snapshot: () => {},
      update: (message) => {
        if (message.type === "workspace_update")
          for (const listener of workspaceListeners) listener(message.payload);
      },
    });
    return { ...(await subscription.ready), subscription };
  }

  function listAgents(options: NeolixAgentListOptions & { subscribe: {} }): Promise<
    NeolixAgentListResult & {
      subscriptionId: string;
      subscription: OwnedSubscription<NeolixAgentListResult>;
    }
  >;
  function listAgents(options?: NeolixAgentListOptions): Promise<NeolixAgentListResult>;
  async function listAgents(options?: NeolixAgentListOptions): Promise<NeolixAgentListResult> {
    if (!options?.subscribe) return daemonClient.fetchAgents(options);
    if (options.subscribe.subscriptionId !== undefined)
      throw new Error("Subscription IDs are assigned by the host");
    const subscription = own(() => daemonClient.observeAgents(options));
    subscription.subscribe({
      snapshot: () => {},
      update: (message) => {
        if (message.type === "agent_update")
          for (const listener of agentListeners) listener(message.payload);
      },
    });
    return { ...(await subscription.ready), subscription };
  }

  return {
    dispose,
    hosts: createHostActions(daemonClient, { own, signal: lifetime.signal, api: createNeolixApi }),
    observeEvents,
    terminals,
    projects: {
      list: (options) => daemonClient.listProjects(options),
      subscribe: (handler) => {
        return subscribeEvent("project.update", (message) => {
          if (message.type === "project.update") handler(message.payload);
        });
      },
    },
    workspaces: {
      list: listWorkspaces,
      ref: (workspace) => createWorkspaceHandle(workspace),
      open: (input, requestId) =>
        openWorkspace(daemonClient, createWorkspaceHandle, input, requestId),
      create: async ({ requestId, agent, ...options }) => {
        const result = await daemonClient.createWorkspace(
          {
            ...options,
            ...(agent
              ? {
                  agent: toDaemonAgentCreateOptions(
                    agent,
                    undefined,
                    daemonClient.getLastServerInfoMessage()?.serverId,
                  ),
                }
              : {}),
          },
          requestId,
        );
        if (result.error || !result.workspace) {
          throw new Error(result.error ?? "The daemon did not create a workspace");
        }
        return createWorkspaceHandle(result.workspace);
      },
      archive: (workspace, requestId) =>
        daemonClient.archiveWorkspace(resolveWorkspaceId(workspace), requestId),
      subscribe: listenWorkspaces,
    },
    agents: {
      list: listAgents,
      ref: (agent) => createAgentHandle(agent),
      create: (options) => createAgent(options),
      subscribe: listenAgents,
    },
    providers: {
      listModels: (provider, options) => daemonClient.listProviderModels(provider, options),
      listModes: (provider, options) => daemonClient.listProviderModes(provider, options),
      listFeatures: ({ provider: providerModel, ...draftConfig }, options) => {
        const { provider, model } = parseProviderModel(providerModel);
        return daemonClient.listProviderFeatures({ ...draftConfig, provider, model }, options);
      },
      listAvailable: (options) => daemonClient.listAvailableProviders(options),
      snapshot: (options) => daemonClient.getProvidersSnapshot(options),
      waitForReady: (options) =>
        waitForProvidersReady(
          daemonClient,
          observeEvents(["providers_snapshot_update"]),
          lifetime.signal,
          options,
        ),
      refresh: (options) => daemonClient.refreshProvidersSnapshot(options),
      diagnostic: (provider, options) => daemonClient.getProviderDiagnostic(provider, options),
      listUsage: (options) => listProviderUsage(daemonClient, options),
      subscribe: (handler) => {
        return subscribeEvent("providers_snapshot_update", (message) => {
          if (message.type === "providers_snapshot_update") handler(message.payload);
        });
      },
    },
    config: {
      get: (requestId) => daemonClient.getDaemonConfig(requestId),
      patch: (patch, requestId) => daemonClient.patchDaemonConfig(patch, requestId),
    },
    gateway: {
      async providers() {
        const { config } = await daemonClient.getGatewayConfig();
        return (config.providers ?? []).map((provider) => ({
          id: provider.id,
          name: provider.label ?? provider.id,
        }));
      },
      usage: (query) => daemonClient.getGatewayUsage(query),
    },
  };
}

type WorkspaceHandleFactory = (workspace: string | NeolixWorkspace) => NeolixWorkspaceHandle;
type AgentHandleFactory = (agent: string | NeolixAgent) => NeolixAgentHandle;
type CreateAgent = (
  options: NeolixAgentCreateOptions,
  placement?: { workspaceId: string; cwd: string },
) => Promise<NeolixAgentHandle>;

function createWorkspaceHandleFactory(
  daemonClient: DaemonClient,
  createAgent: CreateAgent,
  terminals: NeolixTerminalActions,
  listen: (handler: NeolixWorkspaceUpdateHandler) => () => void,
): WorkspaceHandleFactory {
  return (workspace) => {
    const id = typeof workspace === "string" ? workspace : workspace.id;
    let current = typeof workspace === "string" ? null : workspace;

    const refresh = async (options?: { requestId?: string }) => {
      current = await daemonClient.findWorkspace(id, options);
      return current;
    };

    return {
      id,
      get projectId() {
        return current?.projectId ?? null;
      },
      get directory() {
        return current?.workspaceDirectory ?? null;
      },
      get name() {
        return current?.name ?? null;
      },
      get status() {
        return current?.status ?? null;
      },
      agents: {
        create: async (options) => {
          const snapshot = current ?? (await refresh());
          if (!snapshot?.workspaceDirectory) {
            throw new Error(`Workspace ${id} has no available directory`);
          }
          return createAgent(
            { ...options, cwd: snapshot.workspaceDirectory },
            { workspaceId: id, cwd: snapshot.workspaceDirectory },
          );
        },
      },
      terminals: {
        create: (options) => terminals.create({ ...options, workspaceId: id }),
        list: (options) => terminals.list({ ...options, workspaceId: id }),
      },
      current: () => current,
      refresh,
      setTitle: (title, requestId) => daemonClient.setWorkspaceTitle(id, title, requestId),
      archive: async (requestId) => {
        const result = await daemonClient.archiveWorkspace(id, requestId);
        if (current) {
          current = { ...current, archivingAt: result.archivedAt };
        }
        return result;
      },
      subscribe: (handler) =>
        listen((update) => {
          if (update.kind === "upsert" && update.workspace.id === id) {
            current = update.workspace;
            handler(update);
          }
          if (update.kind === "remove" && update.id === id) {
            handler(update);
          }
        }),
    };
  };
}

function createAgentHandleFactory(
  daemonClient: DaemonClient,
  listen: (handler: NeolixAgentUpdateHandler) => () => void,
  subscribeTimeline: DaemonClient["subscribeAgentTimeline"],
): AgentHandleFactory {
  return (agent) => {
    const id = typeof agent === "string" ? agent : agent.id;
    let current = typeof agent === "string" ? null : agent;

    let serverId = daemonClient.getLastServerInfoMessage()?.serverId;
    const handle: NeolixAgentHandle = {
      id,
      get address() {
        serverId ??= daemonClient.getLastServerInfoMessage()?.serverId;
        if (!serverId) throw new Error("Connect to a host before obtaining an agent address");
        return { serverId, agentId: id };
      },
      timeline: {
        append: (item) => daemonClient.appendAgentTimelineItem(id, item),
        refetch: async (options) => {
          const result = await daemonClient.fetchAgentTimeline(id, options);
          if (result.agent) {
            current = result.agent;
          }
          return result;
        },
        subscribe: (handler) =>
          subscribeTimeline(id, (message) => {
            switch (message.type) {
              case "agent_stream":
                return handler(message.payload);
              case "agent.timeline.subscription_restored":
                return handler({
                  agentId: id,
                  subscriptionId: message.payload.subscriptionId,
                  event: { type: "subscription_restored" },
                });
              case "agent.timeline.error":
                return handler({
                  agentId: id,
                  event: { type: "error", error: message.payload.error },
                });
              case "agent.timeline.replacement":
                return handler({
                  agentId: id,
                  event: { type: "replacement", epoch: message.payload.epoch },
                });
            }
          }),
      },
      get workspaceId() {
        return current?.workspaceId ?? null;
      },
      get cwd() {
        return current?.cwd ?? null;
      },
      get status() {
        return current?.status ?? null;
      },
      get capabilities() {
        return current?.capabilities ?? null;
      },
      get availableModes() {
        return current?.availableModes ?? null;
      },
      get pendingPermissions() {
        return current?.pendingPermissions ?? null;
      },
      get activeTurn() {
        return current?.activeTurn ?? null;
      },
      get lastUsage() {
        return current?.lastUsage ?? null;
      },
      get lastError() {
        return current?.lastError ?? null;
      },
      get features() {
        return current?.features ?? null;
      },
      get runtimeInfo() {
        return current?.runtimeInfo ?? null;
      },
      get archivedAt() {
        return current?.archivedAt ?? null;
      },
      current: () => current,
      refresh: async (requestId) => {
        const result = await daemonClient.fetchAgent({ agentId: id, requestId });
        current = result?.agent ?? null;
        return result;
      },
      reload: async (options) => {
        await daemonClient.refreshAgent(id, options?.requestId);
        const result = await daemonClient.fetchAgent({ agentId: id });
        current = result?.agent ?? null;
        return result;
      },
      send: async (text, options) => {
        await daemonClient.sendAgentMessage(id, text, options);
      },
      respondToPermission: async ({ requestId, response }) => {
        await daemonClient.respondToPermission(id, requestId, response);
      },
      run: async (text, options) => {
        const { timeoutMs, ...sendOptions } = options ?? {};
        await daemonClient.sendAgentMessage(id, text, sendOptions);
        const result = await daemonClient.waitForFinish(
          id,
          timeoutMs ?? DEFAULT_WAIT_FOR_FINISH_MS,
        );
        if (result.final) {
          current = result.final;
        }
        return result;
      },
      waitForFinish: async (timeoutMs) => {
        const result = await daemonClient.waitForFinish(
          id,
          timeoutMs ?? DEFAULT_WAIT_FOR_FINISH_MS,
        );
        if (result.final) {
          current = result.final;
        }
        return result;
      },
      commands: (options) => daemonClient.listCommands({ agentId: id, ...options }),
      archive: async () => {
        const result = await daemonClient.archiveAgent(id);
        if (current) {
          current = { ...current, archivedAt: result.archivedAt };
        }
        return result;
      },
      detach: async () => {
        await daemonClient.detachAgent(id);
      },
      subscribe: (handler) =>
        listen((update) => {
          if (update.kind === "upsert" && update.agent.id === id) {
            current = update.agent;
            handler(update);
          }
          if (update.kind === "remove" && update.agentId === id) {
            handler(update);
          }
        }),
    };

    return handle;
  };
}

async function openWorkspace(
  daemonClient: DaemonClient,
  createWorkspaceHandle: WorkspaceHandleFactory,
  input: string | NeolixWorkspaceOpenOptions,
  requestId?: string,
): Promise<NeolixWorkspaceHandle> {
  const options = typeof input === "string" ? { cwd: input, requestId } : input;
  const result = await daemonClient.openProject(options.cwd, options.requestId);
  if (result.error || !result.workspace) {
    throw new Error(result.error ?? `The daemon did not open a workspace for ${options.cwd}`);
  }
  return createWorkspaceHandle(result.workspace);
}

function resolveWorkspaceId(workspace: string | NeolixWorkspaceHandle): string {
  return typeof workspace === "string" ? workspace : workspace.id;
}

function foreignParentHandle(
  parent: NeolixAgentCreateOptions["parent"],
  serverId: string | undefined,
): NeolixAgentHandle | null {
  if (!parent || typeof parent === "string" || !("address" in parent)) return null;
  return parent.address.serverId === serverId ? null : parent;
}

// A host inherits background from a caller it can see. A parent on another host is invisible to
// it, so a handle passes its own value on. A bare foreign address can't; pass background then.
async function inheritParentBackground(
  options: NeolixAgentCreateOptions,
  parent: NeolixAgentHandle,
): Promise<NeolixAgentCreateOptions> {
  const snapshot = parent.current() ?? (await parent.refresh())?.agent;
  return snapshot?.background ? { ...options, background: true } : options;
}

function encodeParent(
  parent: string | AgentAddress | NeolixAgentHandle,
  serverId?: string,
): Pick<CreateAgentRequestOptions, "callerAgentId" | "labels"> {
  if (typeof parent === "string") return { callerAgentId: parent };
  const address = "address" in parent ? parent.address : parent;
  if (!serverId) throw new Error("Connect to a host before creating a child");
  return address.serverId === serverId
    ? { callerAgentId: address.agentId, labels: parentAddressLabels(address) }
    : { labels: parentAddressLabels(address) };
}

function parseProviderModel(selection: string): { provider: string; model: string } {
  const separator = selection.indexOf("/");
  if (separator <= 0 || separator === selection.length - 1) {
    throw new Error('Expected config.provider in "provider/model" format');
  }
  return {
    provider: selection.slice(0, separator),
    model: selection.slice(separator + 1),
  };
}

function listProviderUsage(
  daemonClient: DaemonClient,
  options?: NeolixProviderUsageOptions,
): Promise<NeolixProviderUsageResult> {
  daemonClient.ensureConnected();
  // COMPAT(providerUsageList): added in v0.1.98, remove after 2027-02-28 once daemon floor >= v0.1.98.
  if (daemonClient.getLastServerInfoMessage()?.features?.providerUsageList !== true) {
    return Promise.reject(new Error("Update the host to list provider usage."));
  }
  return daemonClient.listProviderUsage(options);
}

async function waitForProvidersReady(
  daemonClient: DaemonClient,
  observation: ReturnType<DaemonClient["observeEvents"]>,
  signal: AbortSignal,
  options: NeolixProviderWaitOptions = {},
): Promise<NeolixProviderSnapshotResult> {
  const { timeoutMs = 60_000, ...snapshotOptions } = options;

  try {
    await observation.ready;
    if (signal.aborted) throw new Error("Neolix API is disposed");
    return await new Promise<NeolixProviderSnapshotResult>((resolve, reject) => {
      let settled = false;
      let requestId: string | null = null;
      let snapshotCwd: string | undefined;
      const pendingUpdates = new Map<string | undefined, NeolixProviderSnapshotUpdate>();
      let latestEntries: NeolixProviderSnapshotResult["entries"] = [];

      const cleanup = () => {
        clearTimeout(timeout);
        unsubscribe();
        signal.removeEventListener("abort", abort);
      };
      const finish = (snapshot: NeolixProviderSnapshotResult) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(snapshot);
      };
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      const updateMatches = (update: NeolixProviderSnapshotUpdate) => update.cwd === snapshotCwd;

      const unsubscribe = observation.subscribe({
        snapshot: () => {},
        update: (message) => {
          if (message.type !== "providers_snapshot_update") return;
          const update = message.payload;
          if (!requestId) {
            pendingUpdates.set(update.cwd, update);
            return;
          }
          if (!updateMatches(update)) return;
          latestEntries = update.entries;
          if (update.entries.some((entry) => entry.status === "loading")) return;
          finish({ ...update, requestId });
        },
      });
      const abort = () => fail(new Error("Neolix API is disposed"));
      signal.addEventListener("abort", abort, { once: true });

      const timeout = setTimeout(() => {
        const loading = latestEntries
          .filter((entry) => entry.status === "loading")
          .map((entry) => entry.provider)
          .join(", ");
        fail(
          new Error(
            loading
              ? `Timed out waiting for providers: ${loading}`
              : "Timed out waiting for provider discovery",
          ),
        );
      }, timeoutMs);

      void daemonClient
        .getProvidersSnapshot(snapshotOptions)
        .then((snapshot) => {
          requestId = snapshot.requestId;
          snapshotCwd = snapshot.cwd;
          latestEntries = snapshot.entries;
          if (!snapshot.entries.some((entry) => entry.status === "loading")) {
            finish(snapshot);
            return;
          }
          const pendingUpdate = pendingUpdates.get(snapshotCwd);
          if (pendingUpdate && !pendingUpdate.entries.some((entry) => entry.status === "loading")) {
            finish({ ...pendingUpdate, requestId });
          }
          return undefined;
        })
        .catch(fail);
    });
  } finally {
    await observation.release();
  }
}

function createGeneratedClientId(): string {
  const randomId =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  return `neolix-sdk-${randomId}`;
}
