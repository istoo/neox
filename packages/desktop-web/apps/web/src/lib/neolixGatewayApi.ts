// FILE: neolixGatewayApi.ts
// Purpose: Typed calls into the bridge's `neolix.gateway.*` surface. The bridge
//          forwards each call to the Neox daemon's gateway requests, so these
//          wrappers stay thin; the document shapes live in `gatewayTypes.ts`.
// Layer: Web transport adapter

import {
  NEOLIX_GATEWAY_WS_METHODS,
  type GatewayAccountWarmAtInput,
  type GatewayArchiveInput,
  type GatewayCheckinAccountInput,
  type GatewayCheckinRunInput,
  type GatewayCheckinSwitchInput,
  type GatewayDaysInput,
  type GatewayPricingInput,
  type GatewayRecordsInput,
  type GatewayResetQuotaInput,
  type GatewaySubscriptionAccountInput,
  type GatewaySubscriptionAddInput,
  type GatewaySubscriptionImportInput,
  type GatewayTuneApplyInput,
  type GatewayTuneUndoInput,
  type GatewayUsageInput,
  type GatewayWarmAtInput,
  type GatewayWarmInput,
} from "@synara/contracts";

import { getConnectionClients } from "~/lib/hosts/connectionClients";
import type {
  GatewayArchiveRecord,
  GatewayCheckin,
  GatewayClaudeModeResult,
  GatewayCodexAccountsResult,
  GatewayCodexImportResult,
  GatewayConfig,
  GatewayConfigResult,
  GatewayImportSource,
  GatewayLocalModelStatus,
  GatewayMaskingPreview,
  GatewayMaskingRecord,
  GatewayMaskingSummary,
  GatewayOidcRule,
  GatewayPluginSubscriptionSignInResult,
  GatewayPluginSubscriptionsResult,
  GatewayPricingResult,
  GatewayProbeTarget,
  GatewayProviderBalanceResult,
  GatewayProviderDetectResult,
  GatewayProviderModelsResult,
  GatewayProviderPreset,
  GatewayProviderTestResult,
  GatewayPromptText,
  GatewayQuota,
  GatewayReply,
  GatewayRouteHistoryRow,
  GatewaySearchQuotaResult,
  GatewaySignInState,
  GatewayStatus,
  GatewaySubscriptionAccount,
  GatewayTrace,
  GatewayTuneAdvice,
  GatewayUpstreamStatus,
  GatewayUsageReport,
} from "~/lib/gatewayTypes";

function request<T>(method: string, payload?: unknown): Promise<T> {
  // Optional fields the editor cleared are `undefined` in memory. `Schema.Json`
  // rejects those, so send the JSON form the daemon would receive anyway.
  const body = payload === undefined ? {} : JSON.parse(JSON.stringify(payload));
  return getConnectionClients().execution.request<T>(method, body);
}

export interface GatewayUsageResponse {
  report: GatewayUsageReport | null;
  error?: string;
}

export interface GatewayQuotaResetResult {
  spent: boolean;
  code: string;
  windows: number;
  error?: string | null;
}

export interface GatewayWarmResult {
  status: number | null;
  error?: string;
}

export interface GatewayOidcRulesResult {
  rules: GatewayOidcRule[];
}

export interface GatewaySubscriptionListResult {
  accounts: GatewaySubscriptionAccount[];
}

export interface GatewaySubscriptionChangeResult {
  error?: string | null;
  [key: string]: unknown;
}

export const neolixGatewayApi = {
  getConfig: () => request<GatewayConfigResult>(NEOLIX_GATEWAY_WS_METHODS.getConfig),
  presets: () =>
    request<{ presets: GatewayProviderPreset[] }>(NEOLIX_GATEWAY_WS_METHODS.presets).then(
      (result) => result.presets,
    ),
  setConfig: (config: GatewayConfig) =>
    request<GatewayConfigResult>(NEOLIX_GATEWAY_WS_METHODS.setConfig, { config }),
  getStatus: () =>
    request<{ status: GatewayStatus }>(NEOLIX_GATEWAY_WS_METHODS.getStatus).then(
      (result) => result.status,
    ),

  getUsage: (input: GatewayUsageInput) =>
    request<GatewayUsageResponse>(NEOLIX_GATEWAY_WS_METHODS.getUsage, input),
  getQuota: (input: {
    historyDays?: number;
    provider?: string;
    account?: string;
    read?: boolean;
  }) => request<{ quota: GatewayQuota }>(NEOLIX_GATEWAY_WS_METHODS.getQuota, input),
  resetQuota: (input: GatewayResetQuotaInput) =>
    request<GatewayQuotaResetResult>(NEOLIX_GATEWAY_WS_METHODS.resetQuota, input),
  warmAccount: (input: GatewayWarmInput) =>
    request<GatewayWarmResult>(NEOLIX_GATEWAY_WS_METHODS.warmAccount, input),
  setWarmAt: (input: GatewayWarmAtInput) =>
    request<{ ats?: string[]; error?: string }>(NEOLIX_GATEWAY_WS_METHODS.setWarmAt, input),
  setAccountWarmAt: (input: GatewayAccountWarmAtInput) =>
    request<{ at?: string; error?: string }>(NEOLIX_GATEWAY_WS_METHODS.setAccountWarmAt, input),

  getRoutingHistory: (day?: string) =>
    request<{ days: string[]; day: string; routes: GatewayRouteHistoryRow[] }>(
      NEOLIX_GATEWAY_WS_METHODS.getRoutingHistory,
      day === undefined ? {} : { day },
    ),
  getTrace: () =>
    request<{ trace: GatewayTrace }>(NEOLIX_GATEWAY_WS_METHODS.getTrace).then(
      (result) => result.trace,
    ),
  getArchive: (input: GatewayArchiveInput) =>
    request<{ archive: GatewayArchiveRecord | null }>(
      NEOLIX_GATEWAY_WS_METHODS.getArchive,
      input,
    ).then((result) => result.archive),
  getPromptText: (id: string) =>
    request<{ text: GatewayPromptText | null }>(NEOLIX_GATEWAY_WS_METHODS.promptText, {
      id,
    }).then((result) => result.text),
  getPromptReply: (date: string, id: string) =>
    request<{ reply: GatewayReply | null }>(NEOLIX_GATEWAY_WS_METHODS.promptReply, {
      date,
      id,
    }).then((result) => result.reply),
  getRouteEvents: (after?: number) =>
    request<Record<string, unknown>>(
      NEOLIX_GATEWAY_WS_METHODS.getRouteEvents,
      after === undefined ? {} : { after },
    ),
  getPricing: (input: GatewayPricingInput) =>
    request<GatewayPricingResult>(NEOLIX_GATEWAY_WS_METHODS.getPricing, input),

  providerModels: (target: GatewayProbeTarget) =>
    request<GatewayProviderModelsResult>(NEOLIX_GATEWAY_WS_METHODS.providerModels, { target }),
  providerTestModel: (input: { target: GatewayProbeTarget; model: string }) =>
    request<GatewayProviderTestResult>(NEOLIX_GATEWAY_WS_METHODS.providerTestModel, input),
  providerDetect: (input: { target: GatewayProbeTarget; model?: string | undefined }) =>
    request<GatewayProviderDetectResult>(NEOLIX_GATEWAY_WS_METHODS.providerDetect, input),
  providerPreviewImport: () =>
    request<{ sources: GatewayImportSource[] }>(NEOLIX_GATEWAY_WS_METHODS.providerPreviewImport),
  providerBalance: (input: { target: GatewayProbeTarget }) =>
    request<GatewayProviderBalanceResult>(NEOLIX_GATEWAY_WS_METHODS.providerBalance, input),
  providerUpstreamStatus: () =>
    request<GatewayUpstreamStatus>(NEOLIX_GATEWAY_WS_METHODS.providerUpstreamStatus),
  refreshCatalog: () => request<Record<string, unknown>>(NEOLIX_GATEWAY_WS_METHODS.refreshCatalog),

  maskingSummary: (input: GatewayDaysInput) =>
    request<{ summary: GatewayMaskingSummary }>(
      NEOLIX_GATEWAY_WS_METHODS.maskingSummary,
      input,
    ).then((result) => result.summary),
  maskingRecords: (input: GatewayRecordsInput) =>
    request<{ records: GatewayMaskingRecord[]; more: boolean }>(
      NEOLIX_GATEWAY_WS_METHODS.maskingRecords,
      input,
    ),
  maskingRecord: (key: string) =>
    request<{ record: GatewayMaskingRecord | null }>(NEOLIX_GATEWAY_WS_METHODS.maskingRecord, {
      key,
    }).then((result) => result.record),
  maskingPreview: (text: string) =>
    request<{ preview: GatewayMaskingPreview }>(NEOLIX_GATEWAY_WS_METHODS.maskingPreview, {
      text,
    }).then((result) => result.preview),
  maskingClear: () => request<Record<string, unknown>>(NEOLIX_GATEWAY_WS_METHODS.maskingClear),
  maskingLocalModelStatus: () =>
    request<{ status: GatewayLocalModelStatus }>(
      NEOLIX_GATEWAY_WS_METHODS.maskingLocalModelStatus,
    ).then((result) => result.status),
  maskingLocalModelDownload: () =>
    request<{ status: GatewayLocalModelStatus }>(
      NEOLIX_GATEWAY_WS_METHODS.maskingLocalModelDownload,
    ).then((result) => result.status),
  maskingLocalModelCancel: () =>
    request<{ status: GatewayLocalModelStatus }>(
      NEOLIX_GATEWAY_WS_METHODS.maskingLocalModelCancel,
    ).then((result) => result.status),
  maskingLocalModelRemove: () =>
    request<{ status: GatewayLocalModelStatus }>(
      NEOLIX_GATEWAY_WS_METHODS.maskingLocalModelRemove,
    ).then((result) => result.status),

  oidcRules: () => request<GatewayOidcRulesResult>(NEOLIX_GATEWAY_WS_METHODS.oidcRules),
  oidcSave: (rule: GatewayOidcRule) =>
    request<{ rule?: GatewayOidcRule | null; rules: GatewayOidcRule[]; error?: string }>(
      NEOLIX_GATEWAY_WS_METHODS.oidcSave,
      { rule },
    ),
  oidcRemove: (id: string) =>
    request<{ rules: GatewayOidcRule[] }>(NEOLIX_GATEWAY_WS_METHODS.oidcRemove, { id }),

  checkinStatus: () => request<GatewayCheckin>(NEOLIX_GATEWAY_WS_METHODS.checkinStatus),
  checkinRun: (input: GatewayCheckinRunInput) =>
    request<GatewayCheckin>(NEOLIX_GATEWAY_WS_METHODS.checkinRun, input),
  checkinSwitch: (input: GatewayCheckinSwitchInput) =>
    request<GatewayCheckin>(NEOLIX_GATEWAY_WS_METHODS.checkinSwitch, input),
  checkinAccount: (input: GatewayCheckinAccountInput) =>
    request<GatewayCheckin>(NEOLIX_GATEWAY_WS_METHODS.checkinAccount, input),

  searchQuota: (vendor: string, fresh?: boolean) =>
    request<GatewaySearchQuotaResult>(
      NEOLIX_GATEWAY_WS_METHODS.searchQuota,
      fresh === undefined ? { vendor } : { vendor, fresh },
    ),
  claudeMode: () => request<GatewayClaudeModeResult>(NEOLIX_GATEWAY_WS_METHODS.claudeMode),

  heldList: () => request<{ names: string[] }>(NEOLIX_GATEWAY_WS_METHODS.heldList),
  heldRead: (name: string) =>
    request<{ text: string | null }>(NEOLIX_GATEWAY_WS_METHODS.heldRead, { name }),
  heldReveal: (name?: string) =>
    request<{ ok: boolean; error?: string | null }>(
      NEOLIX_GATEWAY_WS_METHODS.heldReveal,
      name === undefined ? {} : { name },
    ),

  tuneGet: (days?: number) =>
    request<GatewayTuneAdvice>(
      NEOLIX_GATEWAY_WS_METHODS.tuneGet,
      days === undefined ? {} : { days },
    ),
  tuneApply: (input: GatewayTuneApplyInput) =>
    request<Record<string, unknown>>(NEOLIX_GATEWAY_WS_METHODS.tuneApply, input),
  tuneUndo: (input: GatewayTuneUndoInput) =>
    request<Record<string, unknown>>(NEOLIX_GATEWAY_WS_METHODS.tuneUndo, input),

  subscriptionAccounts: (agent?: string) =>
    request<GatewaySubscriptionListResult>(
      NEOLIX_GATEWAY_WS_METHODS.subscriptionAccounts,
      agent === undefined ? {} : { agent },
    ),
  subscriptionImport: (input: GatewaySubscriptionImportInput) =>
    request<GatewaySubscriptionChangeResult>(NEOLIX_GATEWAY_WS_METHODS.subscriptionImport, input),
  subscriptionAdd: (input: GatewaySubscriptionAddInput) =>
    request<GatewaySubscriptionChangeResult>(NEOLIX_GATEWAY_WS_METHODS.subscriptionAdd, input),
  subscriptionSwitch: (input: GatewaySubscriptionAccountInput) =>
    request<GatewaySubscriptionChangeResult>(NEOLIX_GATEWAY_WS_METHODS.subscriptionSwitch, input),
  subscriptionRemove: (input: GatewaySubscriptionAccountInput) =>
    request<GatewaySubscriptionChangeResult>(NEOLIX_GATEWAY_WS_METHODS.subscriptionRemove, input),

  codexStatus: () => request<Record<string, unknown>>(NEOLIX_GATEWAY_WS_METHODS.codexStatus),
  codexAccounts: () => request<GatewayCodexAccountsResult>(NEOLIX_GATEWAY_WS_METHODS.codexAccounts),
  codexAccountSet: (id: string, enabled: boolean) =>
    request<Record<string, unknown>>(NEOLIX_GATEWAY_WS_METHODS.codexAccountSet, {
      id,
      enabled,
    }),
  codexAccountArrange: (order: string[]) =>
    request<Record<string, unknown>>(NEOLIX_GATEWAY_WS_METHODS.codexAccountArrange, {
      order,
    }),
  codexAccountImport: (input: { text?: string; fromCodex?: boolean }) =>
    request<GatewayCodexImportResult>(NEOLIX_GATEWAY_WS_METHODS.codexAccountImport, input),
  codexAccountRemove: (id: string) =>
    request<Record<string, unknown>>(NEOLIX_GATEWAY_WS_METHODS.codexAccountRemove, { id }),

  pluginSubscriptions: () =>
    request<GatewayPluginSubscriptionsResult>(NEOLIX_GATEWAY_WS_METHODS.pluginSubscriptions),
  pluginSubscriptionModels: (input: { pluginId: string; providerId: string; accountId: string }) =>
    request<Record<string, unknown>>(NEOLIX_GATEWAY_WS_METHODS.pluginSubscriptionModels, input),
  pluginSubscriptionSignIn: (input: {
    pluginId: string;
    providerId: string;
    method: number;
    accountId: string;
    inputs?: Record<string, string>;
  }) =>
    request<GatewayPluginSubscriptionSignInResult>(
      NEOLIX_GATEWAY_WS_METHODS.pluginSubscriptionSignIn,
      input,
    ),
  pluginSubscriptionSignInPoll: (input: { pluginId: string; providerId: string; token: string }) =>
    request<GatewayPluginSubscriptionSignInResult>(
      NEOLIX_GATEWAY_WS_METHODS.pluginSubscriptionSignInPoll,
      input,
    ),

  signInStart: (input: { agent: string; site?: string; proxy?: string; user?: string }) =>
    request<{ state: GatewaySignInState }>(NEOLIX_GATEWAY_WS_METHODS.signInStart, input),
  signInStatus: (id: string) =>
    request<{ state: GatewaySignInState }>(NEOLIX_GATEWAY_WS_METHODS.signInStatus, { id }),
  signInCancel: (id: string) =>
    request<{ ok: boolean }>(NEOLIX_GATEWAY_WS_METHODS.signInCancel, { id }),
  signInCallback: (id: string, url: string) =>
    request<{ ok: boolean; error?: string | null }>(NEOLIX_GATEWAY_WS_METHODS.signInCallback, {
      id,
      url,
    }),
};
