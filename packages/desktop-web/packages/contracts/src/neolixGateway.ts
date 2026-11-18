// FILE: neolixGateway.ts
// Purpose: RPC schemas for Neolix's model gateway settings surface (providers,
//   groups, keys, usage, quotas, masking, diagnostics). The bridge maps these
//   one-to-one onto the daemon's `gateway.*` requests; the web settings pages
//   call them through `neolix.gateway.*`.
// Layer: Contracts
//
// Gateway documents are large and grow with the daemon, so results that the
// bridge forwards verbatim are `Schema.Json` (never `Schema.Unknown`: the RPC
// JSON codec encodes Unknown as null). Inputs the bridge destructures are
// typed.

import { Schema } from "effect";

export const NEOLIX_GATEWAY_WS_METHODS = {
  getConfig: "neolix.gateway.getConfig",
  presets: "neolix.gateway.presets",
  setConfig: "neolix.gateway.setConfig",
  getStatus: "neolix.gateway.getStatus",
  getUsage: "neolix.gateway.getUsage",
  getQuota: "neolix.gateway.getQuota",
  resetQuota: "neolix.gateway.resetQuota",
  warmAccount: "neolix.gateway.warmAccount",
  setWarmAt: "neolix.gateway.setWarmAt",
  setAccountWarmAt: "neolix.gateway.setAccountWarmAt",
  getRoutingHistory: "neolix.gateway.getRoutingHistory",
  getTrace: "neolix.gateway.getTrace",
  getArchive: "neolix.gateway.getArchive",
  promptText: "neolix.gateway.promptText",
  promptReply: "neolix.gateway.promptReply",
  getRouteEvents: "neolix.gateway.getRouteEvents",
  getPricing: "neolix.gateway.getPricing",
  providerModels: "neolix.gateway.provider.models",
  providerTestModel: "neolix.gateway.provider.testModel",
  providerDetect: "neolix.gateway.provider.detect",
  providerPreviewImport: "neolix.gateway.provider.previewImport",
  providerBalance: "neolix.gateway.provider.balance",
  providerUpstreamStatus: "neolix.gateway.provider.upstreamStatus",
  refreshCatalog: "neolix.gateway.catalog.refresh",
  maskingSummary: "neolix.gateway.masking.summary",
  maskingRecords: "neolix.gateway.masking.records",
  maskingRecord: "neolix.gateway.masking.record",
  maskingPreview: "neolix.gateway.masking.preview",
  maskingClear: "neolix.gateway.masking.clear",
  maskingLocalModelStatus: "neolix.gateway.masking.localModel.status",
  maskingLocalModelDownload: "neolix.gateway.masking.localModel.download",
  maskingLocalModelCancel: "neolix.gateway.masking.localModel.cancel",
  maskingLocalModelRemove: "neolix.gateway.masking.localModel.remove",
  oidcRules: "neolix.gateway.oidc.rules",
  oidcSave: "neolix.gateway.oidc.save",
  oidcRemove: "neolix.gateway.oidc.remove",
  checkinStatus: "neolix.gateway.checkin.status",
  checkinRun: "neolix.gateway.checkin.run",
  checkinSwitch: "neolix.gateway.checkin.switch",
  checkinAccount: "neolix.gateway.checkin.account",
  searchQuota: "neolix.gateway.search.quota",
  claudeMode: "neolix.gateway.claude.mode",
  heldList: "neolix.gateway.held.list",
  heldRead: "neolix.gateway.held.read",
  heldReveal: "neolix.gateway.held.reveal",
  tuneGet: "neolix.gateway.tune.get",
  tuneApply: "neolix.gateway.tune.apply",
  tuneUndo: "neolix.gateway.tune.undo",
  subscriptionAccounts: "neolix.gateway.subscription.accounts",
  subscriptionImport: "neolix.gateway.subscription.import",
  subscriptionAdd: "neolix.gateway.subscription.add",
  subscriptionSwitch: "neolix.gateway.subscription.switch",
  subscriptionRemove: "neolix.gateway.subscription.remove",
  codexStatus: "neolix.gateway.codex.status",
  codexAccounts: "neolix.gateway.codex.accounts",
  codexAccountSet: "neolix.gateway.codex.account.set",
  codexAccountArrange: "neolix.gateway.codex.account.arrange",
  codexAccountImport: "neolix.gateway.codex.account.import",
  codexAccountRemove: "neolix.gateway.codex.account.remove",
  pluginSubscriptions: "neolix.gateway.plugin.subscriptions",
  pluginSubscriptionModels: "neolix.gateway.plugin.subscription.models",
  pluginSubscriptionSignIn: "neolix.gateway.plugin.subscription.signIn",
  pluginSubscriptionSignInPoll: "neolix.gateway.plugin.subscription.signInPoll",
  signInStart: "neolix.gateway.signin.start",
  signInStatus: "neolix.gateway.signin.status",
  signInCancel: "neolix.gateway.signin.cancel",
  signInCallback: "neolix.gateway.signin.callback",
} as const;

export type NeolixGatewayWsMethod =
  (typeof NEOLIX_GATEWAY_WS_METHODS)[keyof typeof NEOLIX_GATEWAY_WS_METHODS];

/** An opaque document the bridge forwards unchanged. */
export const GatewayJson = Schema.Json;
export type GatewayJson = typeof GatewayJson.Type;

export const GatewayEmptyInput = Schema.Struct({});
export type GatewayEmptyInput = typeof GatewayEmptyInput.Type;

export const GatewayConfigInput = Schema.Struct({ config: GatewayJson });
export type GatewayConfigInput = typeof GatewayConfigInput.Type;

export const GatewayPresetsResult = Schema.Struct({ presets: GatewayJson });
export type GatewayPresetsResult = typeof GatewayPresetsResult.Type;

export const GatewayConfigResult = Schema.Struct({
  config: GatewayJson,
  status: Schema.optional(GatewayJson),
  searchVendors: Schema.optional(GatewayJson),
});
export type GatewayConfigResult = typeof GatewayConfigResult.Type;

export const GatewayUsageInput = Schema.Struct({
  period: Schema.optional(Schema.Literals(["today", "7d", "30d", "all", "custom"])),
  from: Schema.optional(Schema.String),
  to: Schema.optional(Schema.String),
  since: Schema.optional(Schema.Number),
  until: Schema.optional(Schema.Number),
  offset: Schema.optional(Schema.Number),
  limit: Schema.optional(Schema.Number),
  client: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  provider: Schema.optional(Schema.String),
  account: Schema.optional(Schema.String),
  key: Schema.optional(Schema.String),
  failed: Schema.optional(Schema.Boolean),
  retried: Schema.optional(Schema.Boolean),
  query: Schema.optional(Schema.String),
  timezoneOffsetMinutes: Schema.optional(Schema.Number),
});
export type GatewayUsageInput = typeof GatewayUsageInput.Type;

export const GatewayUsageResult = Schema.Struct({
  report: Schema.NullOr(GatewayJson),
  error: Schema.optional(Schema.String),
});
export type GatewayUsageResult = typeof GatewayUsageResult.Type;

export const GatewayQuotaInput = Schema.Struct({
  historyDays: Schema.optional(Schema.Number),
  provider: Schema.optional(Schema.String),
  account: Schema.optional(Schema.String),
  read: Schema.optional(Schema.Boolean),
});
export type GatewayQuotaInput = typeof GatewayQuotaInput.Type;

export const GatewayResetQuotaInput = Schema.Struct({
  account: Schema.optional(Schema.String),
  card: Schema.optional(Schema.Number),
  confirm: Schema.Boolean,
});
export type GatewayResetQuotaInput = typeof GatewayResetQuotaInput.Type;

export const GatewayWarmInput = Schema.Struct({
  provider: Schema.String,
  account: Schema.String,
});
export type GatewayWarmInput = typeof GatewayWarmInput.Type;

export const GatewayWarmAtInput = Schema.Struct({
  agent: Schema.Literals(["codex", "claude"]),
  ats: Schema.Array(Schema.String),
});
export type GatewayWarmAtInput = typeof GatewayWarmAtInput.Type;

export const GatewayAccountWarmAtInput = Schema.Struct({
  provider: Schema.String,
  account: Schema.String,
  at: Schema.String,
});
export type GatewayAccountWarmAtInput = typeof GatewayAccountWarmAtInput.Type;

export const GatewayDayInput = Schema.Struct({ day: Schema.optional(Schema.String) });
export type GatewayDayInput = typeof GatewayDayInput.Type;

export const GatewayArchiveInput = Schema.Struct({
  date: Schema.String,
  id: Schema.String,
});
export type GatewayArchiveInput = typeof GatewayArchiveInput.Type;

export const GatewayPromptTextInput = Schema.Struct({ id: Schema.String });
export type GatewayPromptTextInput = typeof GatewayPromptTextInput.Type;

/** The reply of one archived call, by `<date>/<id>`. */
export const GatewayReplyInput = Schema.Struct({
  date: Schema.String,
  id: Schema.String,
});
export type GatewayReplyInput = typeof GatewayReplyInput.Type;

export const GatewayAfterInput = Schema.Struct({ after: Schema.optional(Schema.Number) });
export type GatewayAfterInput = typeof GatewayAfterInput.Type;

export const GatewayPricingInput = Schema.Struct({
  provider: Schema.String,
  models: Schema.Array(Schema.String),
});
export type GatewayPricingInput = typeof GatewayPricingInput.Type;

/** The flattened provider probe target the daemon's gateway RPCs take. */
export const GatewayProbeInput = Schema.Struct({ target: GatewayJson });
export type GatewayProbeInput = typeof GatewayProbeInput.Type;

export const GatewayTestModelInput = Schema.Struct({
  target: GatewayJson,
  model: Schema.String,
});
export type GatewayTestModelInput = typeof GatewayTestModelInput.Type;

export const GatewayDetectInput = Schema.Struct({
  target: GatewayJson,
  model: Schema.optional(Schema.String),
});
export type GatewayDetectInput = typeof GatewayDetectInput.Type;

export const GatewayDaysInput = Schema.Struct({ days: Schema.Number });
export type GatewayDaysInput = typeof GatewayDaysInput.Type;

export const GatewayRecordsInput = Schema.Struct({ query: GatewayJson });
export type GatewayRecordsInput = typeof GatewayRecordsInput.Type;

export const GatewayKeyInput = Schema.Struct({ key: Schema.String });
export type GatewayKeyInput = typeof GatewayKeyInput.Type;

export const GatewayPreviewInput = Schema.Struct({ text: Schema.String });
export type GatewayPreviewInput = typeof GatewayPreviewInput.Type;

export const GatewayOidcSaveInput = Schema.Struct({ rule: GatewayJson });
export type GatewayOidcSaveInput = typeof GatewayOidcSaveInput.Type;

export const GatewayIdInput = Schema.Struct({ id: Schema.String });
export type GatewayIdInput = typeof GatewayIdInput.Type;

export const GatewayCheckinRunInput = Schema.Struct({
  by: Schema.optional(Schema.String),
  key: Schema.optional(Schema.String),
});
export type GatewayCheckinRunInput = typeof GatewayCheckinRunInput.Type;

export const GatewayCheckinSwitchInput = Schema.Struct({
  by: Schema.String,
  on: Schema.Boolean,
});
export type GatewayCheckinSwitchInput = typeof GatewayCheckinSwitchInput.Type;

export const GatewayCheckinAccountInput = Schema.Struct({
  key: Schema.String,
  on: Schema.Boolean,
});
export type GatewayCheckinAccountInput = typeof GatewayCheckinAccountInput.Type;

export const GatewaySearchQuotaInput = Schema.Struct({
  vendor: Schema.String,
  fresh: Schema.optional(Schema.Boolean),
});
export type GatewaySearchQuotaInput = typeof GatewaySearchQuotaInput.Type;

export const GatewayNameInput = Schema.Struct({ name: Schema.String });
export type GatewayNameInput = typeof GatewayNameInput.Type;

export const GatewayOptionalNameInput = Schema.Struct({ name: Schema.optional(Schema.String) });
export type GatewayOptionalNameInput = typeof GatewayOptionalNameInput.Type;

export const GatewayTuneGetInput = Schema.Struct({ days: Schema.optional(Schema.Number) });
export type GatewayTuneGetInput = typeof GatewayTuneGetInput.Type;

export const GatewayTuneApplyInput = Schema.Struct({
  agent: Schema.Literals(["claude", "codex"]),
  knob: Schema.Literals(["compact", "cache_ttl"]),
  model: Schema.optional(Schema.String),
  value: Schema.String,
});
export type GatewayTuneApplyInput = typeof GatewayTuneApplyInput.Type;

export const GatewayTuneUndoInput = Schema.Struct({
  agent: Schema.Literals(["claude", "codex"]),
  knob: Schema.Literals(["compact", "cache_ttl"]),
  model: Schema.optional(Schema.String),
});
export type GatewayTuneUndoInput = typeof GatewayTuneUndoInput.Type;

export const GatewaySubscriptionListInput = Schema.Struct({
  agent: Schema.optional(Schema.String),
});
export type GatewaySubscriptionListInput = typeof GatewaySubscriptionListInput.Type;

export const GatewaySubscriptionImportInput = Schema.Struct({
  agent: Schema.String,
  files: Schema.Array(Schema.String),
});
export type GatewaySubscriptionImportInput = typeof GatewaySubscriptionImportInput.Type;

export const GatewaySubscriptionAddInput = Schema.Struct({
  agent: Schema.String,
  key: Schema.String,
});
export type GatewaySubscriptionAddInput = typeof GatewaySubscriptionAddInput.Type;

export const GatewaySubscriptionAccountInput = Schema.Struct({
  agent: Schema.String,
  user: Schema.String,
});
export type GatewaySubscriptionAccountInput = typeof GatewaySubscriptionAccountInput.Type;

export const GatewayCodexAccountSetInput = Schema.Struct({
  id: Schema.String,
  enabled: Schema.Boolean,
});
export type GatewayCodexAccountSetInput = typeof GatewayCodexAccountSetInput.Type;

export const GatewayCodexArrangeInput = Schema.Struct({ order: Schema.Array(Schema.String) });
export type GatewayCodexArrangeInput = typeof GatewayCodexArrangeInput.Type;

export const GatewayCodexImportInput = Schema.Struct({
  text: Schema.optional(Schema.String),
  fromCodex: Schema.optional(Schema.Boolean),
});
export type GatewayCodexImportInput = typeof GatewayCodexImportInput.Type;

export const GatewayPluginModelsInput = Schema.Struct({
  pluginId: Schema.String,
  providerId: Schema.String,
  accountId: Schema.String,
});
export type GatewayPluginModelsInput = typeof GatewayPluginModelsInput.Type;

export const GatewayPluginSignInInput = Schema.Struct({
  pluginId: Schema.String,
  providerId: Schema.String,
  method: Schema.Number,
  accountId: Schema.String,
  inputs: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
export type GatewayPluginSignInInput = typeof GatewayPluginSignInInput.Type;

export const GatewayPluginPollInput = Schema.Struct({
  pluginId: Schema.String,
  providerId: Schema.String,
  token: Schema.String,
});
export type GatewayPluginPollInput = typeof GatewayPluginPollInput.Type;

export const GatewaySignInStartInput = Schema.Struct({
  agent: Schema.String,
  site: Schema.optional(Schema.String),
  proxy: Schema.optional(Schema.String),
  user: Schema.optional(Schema.String),
});
export type GatewaySignInStartInput = typeof GatewaySignInStartInput.Type;

export const GatewaySignInCallbackInput = Schema.Struct({
  id: Schema.String,
  url: Schema.String,
});
export type GatewaySignInCallbackInput = typeof GatewaySignInCallbackInput.Type;
