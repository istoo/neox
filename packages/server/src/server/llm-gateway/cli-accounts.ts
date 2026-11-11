/**
 * What `neolix accounts` reads and writes: the subscription accounts Neolix
 * signed in to itself, the stores they live in, and the refreshes and
 * imports that keep them current (`internal/cli/accounts_cli.go`). The
 * daemon reads the same stores; the CLI runs beside it or without it.
 */

export {
  isSubscriptionAgent,
  addSubscriptionAccount,
  loadAnySubscriptionAccounts,
  loadSubscriptionAccounts,
  redactedSubscriptionAccounts,
  saveSubscriptionAccounts,
  subscriptionAccountId,
  subscriptionAccountsFile,
  updateSubscriptionAccount,
  type ChatGptApiAccount,
  type CopilotAccount,
  type GoogleSubscriptionAccount,
  type SubscriptionAccount,
  type SubscriptionAccountStatus,
  type SubscriptionAgent,
} from "./subscription-store.js";
export { importGoogleAccounts, type ImportedSubscriptionAccount } from "./google-import.js";
export { refreshChatGptApiAccount } from "./chatgpt-api-signin.js";
export { refreshGoogleAccount } from "./google-signin.js";
export {
  FACTORY_API,
  FACTORY_API_EU,
  FACTORY_MODELS,
  addFactoryKey,
  factoryAuthHeaders,
  factoryBase,
  factoryGatewayModels,
  factoryKeyName,
  factoryKeysIn,
  factoryModel,
  factoryModelProtocols,
  factoryWhoami,
  type FactoryKeyOptions,
  type FactoryModel,
  type FactoryWho,
} from "./factory-accounts.js";
export {
  factoryUsageReading,
  factoryWhen,
  readFactoryLimits,
  readFactoryUsage,
  type FactoryLimitWindow,
  type FactoryLimits,
} from "./factory-usage.js";
export { loadCodexAccounts, saveCodexAccounts, type CodexOwnedAccount } from "./codex-accounts.js";
export {
  readCodexSignIn,
  writeCodexSignIn,
  type CodexSignIn,
  type CodexSignInWrite,
} from "./codex-user-data.js";
export {
  clearSignInReturn,
  readCodexPool,
  type CodexPoolOptions,
  type CodexPoolSnapshot,
} from "./sign-in-switch.js";
export {
  nextInOrder,
  spentShareOf,
  type NextInOrderResult,
  type SignInCaps,
  type SignInWindow,
} from "./switch-only.js";
export { creditsFromReports, windowsFromReports } from "./warm-windows.js";
export {
  claudeAccountsFile,
  claudeProfileEmail,
  loadClaudeAccounts,
  parseClaudeImport,
  readClaudeSignIn,
  redactedClaudeAccounts,
  saveClaudeAccounts,
  upsertClaudeAccounts,
  writeClaudeSignIn,
  type ClaudeAccount,
  type ClaudeAccountStatus,
  type ClaudeOptions,
} from "./claude-accounts.js";
