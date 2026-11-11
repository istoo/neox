export type { SearchApiRegistration, SearchPage, SearchRequest } from "./search.js";
export {
  PluginAccountsError,
  assertPluginAccountAuth,
  assertPluginAccountId,
  type PluginAccounts,
} from "./accounts.js";
export type {
  SubscriptionLoaderInput,
  SubscriptionLoaderResult,
  SubscriptionModel,
  SubscriptionPrompt,
  SubscriptionProtocol,
  SubscriptionProviderMetadata,
  SubscriptionProviderRegistration,
  SubscriptionSignInFlow,
  SubscriptionSignInMethod,
  SubscriptionSignInOutcome,
} from "./subscription.js";
export {
  openCodeSubscriptionProvider,
  type OpenCodeAuthHooks,
  type OpenCodeContribution,
  type OpenCodeSubscriptionOptions,
} from "./opencode.js";
export type {
  UsageSourceRegistration,
  UsageReport,
  UsageWindow,
  UsageBalance,
  UsageDetail,
} from "./usage.js";
export type {
  GatewayAgentIntegrationRegistration,
  GatewayAgentWiringInput,
  GatewayMiddlewareAccount,
  GatewayMiddlewareAccountDecision,
  GatewayMiddlewareEvent,
  GatewayMiddlewareEventChange,
  GatewayMiddlewareProvider,
  GatewayMiddlewareProviderChange,
  GatewayMiddlewareRegistration,
  GatewayMiddlewareRequest,
  GatewayMiddlewareRequestChange,
  GatewayMiddlewareResponse,
  GatewayMiddlewareResponseChange,
  GatewayRoutingStrategyRegistration,
  GatewayStrategyInput,
  GatewayStrategySeat,
  GatewayUsageObserverRegistration,
  GatewayUsageRow,
  PluginHandlerContext,
  PluginServerContext,
  PluginServerContribution,
  PluginSettings,
  PluginSettingsState,
  PluginSubscriptionContext,
} from "./contracts.js";
export type {
  PluginHooks,
  PluginHookEvents,
  PluginHookRequests,
  PluginHookPayload,
  PluginHookResult,
  PluginHookContext,
  PluginHookWorkspace,
  PluginHookWorktree,
  PluginWorktreeCreateRequest,
  PluginHookAgent,
  PluginSessionOpenRequest,
  PluginTurnOutcome,
  PluginLifecycleEvents,
  PluginBeforeRequests,
  PluginLifecycleRegistration,
} from "./lifecycle.js";

export { spawnProcess, execCommand, terminateProcess } from "./process.js";

export { defineAgentTool } from "./agent-tools.js";
export type { AgentToolDefinition, AgentToolResult, AgentToolContext } from "./agent-tools.js";
