// CLI exports for @neolix/server
export { createNeolixDaemon, type NeolixDaemon, type NeolixDaemonConfig } from "./bootstrap.js";
export { loadConfig, type CliConfigOverrides } from "./config.js";
export { resolveNeolixHome } from "./neolix-home.js";
export {
  describeUninstallReport,
  isRemovablePath,
  isWithin,
  libraryKeepPath,
  removeAllBut,
  resolveNeolixDataDirectories,
  runUninstall,
  uninstallFailed,
  type UninstallAgent,
  type UninstallDeps,
  type UninstallReport,
  type UninstallStep,
} from "./uninstall.js";
export { getOrCreateServerId } from "./server-id.js";
export { createRootLogger, type LogLevel, type LogFormat } from "./logger.js";
export {
  loadPersistedConfig,
  savePersistedConfig,
  type PersistedConfig,
} from "./persisted-config.js";
export { hashDaemonPassword, isBearerTokenValidAsync } from "./auth.js";
export { generateLocalPairingOffer, type LocalPairingOffer } from "./pairing-offer.js";
export {
  ConnectionOfferSchema,
  decodeOfferFragmentPayload,
  parseConnectionOfferFromUrl,
  type ConnectionOffer,
} from "@neolix/protocol/connection-offer";
export { buildRelayWebSocketUrl } from "@neolix/protocol/daemon-endpoints";
export {
  buildDaemonWebSocketUrl,
  deriveLabelFromEndpoint,
  normalizeHostPort,
  parseConnectionUri,
  shouldUseTlsForDefaultHostedRelay,
} from "@neolix/protocol/daemon-endpoints";
export { PARENT_AGENT_ID_LABEL } from "@neolix/protocol/agent-labels";
export {
  DirectTcpHostConnectionSchema,
  type DirectTcpHostConnection,
  type NormalizedDirectTcpHostConnection,
} from "@neolix/protocol/host-connection-schema";
export {
  ensureLocalSpeechModels,
  listLocalSpeechModels,
  type LocalSpeechModelId,
  type LocalSttModelId,
  type LocalTtsModelId,
} from "./speech/providers/local/models.js";
export {
  applySherpaLoaderEnv,
  resolveSherpaLoaderEnv,
  sherpaLoaderEnvKey,
  sherpaPlatformArch,
  sherpaPlatformPackageName,
  type SherpaLoaderEnvKey,
  type SherpaLoaderEnvResolution,
} from "./speech/providers/local/sherpa/sherpa-runtime-env.js";

// Provider binary resolution
export {
  type ProviderOverride,
  type ProviderProfileModel,
} from "./agent/provider-launch-config.js";
export { findExecutable } from "../executable-resolution/executable-resolution.js";
export { execCommand, spawnProcess } from "../utils/spawn.js";

// Provider manifest (source of truth for provider definitions)
export {
  AGENT_PROVIDER_DEFINITIONS,
  BUILTIN_PROVIDER_IDS,
  type AgentProviderDefinition,
} from "@neolix/protocol/provider-manifest";

// Agent SDK types for CLI commands
export type {
  AgentMode,
  AgentUsage,
  AgentCapabilityFlags,
  AgentPermissionRequest,
  AgentTimelineItem,
  ProviderSnapshotEntry,
} from "./agent/agent-sdk-types.js";

// Agent activity curator for CLI logs
export { curateAgentActivity } from "./agent/activity-curator.js";
export {
  getStructuredAgentResponse,
  StructuredAgentResponseError,
  StructuredAgentFallbackError,
  DEFAULT_STRUCTURED_GENERATION_PROVIDERS,
  generateStructuredAgentResponseWithFallback,
  type AgentCaller,
  type JsonSchema,
  type StructuredGenerationAttempt,
  type StructuredGenerationProvider,
  type StructuredAgentGenerationOptions,
  type StructuredAgentGenerationWithFallbackOptions,
  type StructuredAgentResponseOptions,
} from "./agent/agent-response-loop.js";

// WebSocket message types for CLI streaming
export type {
  AgentSnapshotPayload,
  AgentStreamEventPayload,
  AgentStreamMessage,
} from "@neolix/protocol/messages";

export {
  readDaemonInstance,
  startDaemonInstance,
  stopDaemonInstance,
  waitForDaemonReady,
  daemonLogPath,
  daemonLaunchEnvironment,
  isSameDaemonInstance,
  DaemonInstanceError,
  type DaemonInstance,
} from "./daemon-instance.js";
export {
  readPersistedConfig,
  getPersistedConfigValue,
  editPersistedConfig,
} from "./persisted-config.js";
export { resolveConfigFromPersisted } from "./config.js";

export { ensurePrivateDirectory } from "./private-files.js";
export {
  runCodexRelay,
  leaveCodexRelay,
  startCodexRelay,
  codexProcessIds,
  readState as readCodexRelayState,
  RELAY_LEAVE_PATH,
  RELAY_TOKEN_HEADER,
  type CodexRelayHandle,
  type CodexRelayOptions,
  type CodexRelayState,
} from "./llm-gateway/codex-relay.js";
export {
  autoIncludedModels,
  matchesAutoInclude,
  nextDailyResetAt,
  quotaRestFor,
  restForFailure,
} from "./llm-gateway/provider-limits.js";
