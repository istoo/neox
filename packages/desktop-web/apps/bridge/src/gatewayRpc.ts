// Neox model gateway → Synara settings RPCs (`neolix.gateway.*`).
//
// Each handler forwards one-to-one to the daemon's `gateway.*` request. The
// bridge adds no policy: gateway.json is the daemon's file, and validation is
// the daemon's job. Error messages are wrapped so the settings page can show
// what the host said instead of a bare RPC failure.
import { NEOLIX_GATEWAY_WS_METHODS } from "@synara/contracts";
import { Effect } from "effect";

// The vendor catalog the Neox app, `neolix presets` and the daemon all use.
// Reading it here keeps one source of truth instead of a copy in the web app.
import { GATEWAY_PROVIDER_PRESETS } from "../../../../protocol/dist/gateway-presets.js";

import type { BridgeModel } from "./model.ts";
import { fromPromise } from "./rpcErrors.ts";
import type { AnyHandler } from "./stubs.ts";

export function makeGatewayHandlers(model: BridgeModel): Record<string, AnyHandler> {
  const client = model.client;

  return {
    [NEOLIX_GATEWAY_WS_METHODS.presets]: () =>
      Effect.succeed({ presets: GATEWAY_PROVIDER_PRESETS }),

    [NEOLIX_GATEWAY_WS_METHODS.getConfig]: () =>
      fromPromise("neolix.gateway.getConfig", async () => {
        const result = await client.getGatewayConfig();
        return {
          config: result.config,
          status: result.status,
          ...(result.searchVendors ? { searchVendors: result.searchVendors } : {}),
        };
      }),

    [NEOLIX_GATEWAY_WS_METHODS.setConfig]: (payload) =>
      fromPromise("neolix.gateway.setConfig", async () => {
        const result = await client.setGatewayConfig(
          (payload as { config: never }).config as never,
        );
        return {
          config: result.config,
          status: result.status,
          ...(result.searchVendors ? { searchVendors: result.searchVendors } : {}),
        };
      }),

    [NEOLIX_GATEWAY_WS_METHODS.getStatus]: () =>
      fromPromise("neolix.gateway.getStatus", () => client.getGatewayStatus()),

    [NEOLIX_GATEWAY_WS_METHODS.getUsage]: (payload) =>
      fromPromise("neolix.gateway.getUsage", () =>
        client.getGatewayUsage((payload ?? {}) as never),
      ),

    [NEOLIX_GATEWAY_WS_METHODS.getQuota]: (payload) =>
      fromPromise("neolix.gateway.getQuota", () =>
        client.getGatewayQuota((payload ?? {}) as never),
      ),

    [NEOLIX_GATEWAY_WS_METHODS.resetQuota]: (payload) =>
      fromPromise("neolix.gateway.resetQuota", () =>
        client.resetGatewayQuota((payload ?? {}) as never),
      ),

    [NEOLIX_GATEWAY_WS_METHODS.warmAccount]: (payload) =>
      fromPromise("neolix.gateway.warmAccount", () =>
        client.warmGatewayAccount((payload ?? {}) as never),
      ),

    [NEOLIX_GATEWAY_WS_METHODS.setWarmAt]: (payload) =>
      fromPromise("neolix.gateway.setWarmAt", () => {
        const input = payload as { agent: "codex" | "claude"; ats: string[] };
        return client.setGatewayWarmAt(input.agent, input.ats);
      }),

    [NEOLIX_GATEWAY_WS_METHODS.setAccountWarmAt]: (payload) =>
      fromPromise("neolix.gateway.setAccountWarmAt", () =>
        client.setGatewayAccountWarmAt((payload ?? {}) as never),
      ),

    [NEOLIX_GATEWAY_WS_METHODS.getRoutingHistory]: (payload) =>
      fromPromise("neolix.gateway.getRoutingHistory", () =>
        client.getGatewayRoutingHistory((payload as { day?: string } | undefined)?.day),
      ),

    [NEOLIX_GATEWAY_WS_METHODS.getTrace]: () =>
      fromPromise("neolix.gateway.getTrace", () => client.getGatewayTrace()),

    [NEOLIX_GATEWAY_WS_METHODS.getArchive]: (payload) =>
      fromPromise("neolix.gateway.getArchive", () => {
        const input = payload as { date: string; id: string };
        return client.getGatewayArchivedCall(input.date, input.id);
      }),

    [NEOLIX_GATEWAY_WS_METHODS.getRouteEvents]: (payload) =>
      fromPromise("neolix.gateway.getRouteEvents", () =>
        client.getGatewayRouteEvents((payload as { after?: number } | undefined)?.after),
      ),

    [NEOLIX_GATEWAY_WS_METHODS.getPricing]: (payload) =>
      fromPromise("neolix.gateway.getPricing", () => {
        const input = payload as { provider: string; models: string[] };
        return client.getGatewayModelPrices(input.provider, input.models);
      }),

    [NEOLIX_GATEWAY_WS_METHODS.providerModels]: (payload) =>
      fromPromise("neolix.gateway.provider.models", () =>
        client.getGatewayProviderModels((payload as { target: never }).target as never),
      ),

    [NEOLIX_GATEWAY_WS_METHODS.providerTestModel]: (payload) =>
      fromPromise("neolix.gateway.provider.testModel", () => {
        const input = payload as { target: never; model: string };
        return client.testGatewayProviderModel(input.target as never, input.model);
      }),

    [NEOLIX_GATEWAY_WS_METHODS.providerDetect]: (payload) =>
      fromPromise("neolix.gateway.provider.detect", () => {
        const input = payload as { target: never; model?: string };
        return client.detectGatewayProviderProtocols(input.target as never, input.model);
      }),

    [NEOLIX_GATEWAY_WS_METHODS.providerPreviewImport]: () =>
      fromPromise("neolix.gateway.provider.previewImport", () =>
        client.previewGatewayProviderImport(),
      ),

    [NEOLIX_GATEWAY_WS_METHODS.providerBalance]: (payload) =>
      fromPromise("neolix.gateway.provider.balance", () =>
        client.getGatewayProviderBalance((payload as { target: never }).target as never),
      ),

    [NEOLIX_GATEWAY_WS_METHODS.providerUpstreamStatus]: () =>
      fromPromise("neolix.gateway.provider.upstreamStatus", () =>
        client.getGatewayUpstreamStatus(),
      ),

    [NEOLIX_GATEWAY_WS_METHODS.refreshCatalog]: () =>
      fromPromise("neolix.gateway.catalog.refresh", () => client.refreshGatewayCatalog()),

    [NEOLIX_GATEWAY_WS_METHODS.maskingSummary]: (payload) =>
      fromPromise("neolix.gateway.masking.summary", () =>
        client.getGatewayMaskingSummary((payload as { days: number }).days),
      ),

    [NEOLIX_GATEWAY_WS_METHODS.maskingRecords]: (payload) =>
      fromPromise("neolix.gateway.masking.records", () =>
        client.getGatewayMaskingRecords((payload as { query: never }).query as never),
      ),

    [NEOLIX_GATEWAY_WS_METHODS.maskingRecord]: (payload) =>
      fromPromise("neolix.gateway.masking.record", () =>
        client.getGatewayMaskingRecord((payload as { key: string }).key),
      ),

    [NEOLIX_GATEWAY_WS_METHODS.maskingPreview]: (payload) =>
      fromPromise("neolix.gateway.masking.preview", () =>
        client.previewGatewayMasking((payload as { text: string }).text),
      ),

    [NEOLIX_GATEWAY_WS_METHODS.maskingClear]: () =>
      fromPromise("neolix.gateway.masking.clear", () => client.clearGatewayMaskingRecords()),

    [NEOLIX_GATEWAY_WS_METHODS.maskingLocalModelStatus]: () =>
      fromPromise("neolix.gateway.masking.localModel.status", () =>
        client.getGatewayMaskingLocalModelStatus(),
      ),

    [NEOLIX_GATEWAY_WS_METHODS.maskingLocalModelDownload]: () =>
      fromPromise("neolix.gateway.masking.localModel.download", () =>
        client.downloadGatewayMaskingLocalModel(),
      ),

    [NEOLIX_GATEWAY_WS_METHODS.maskingLocalModelCancel]: () =>
      fromPromise("neolix.gateway.masking.localModel.cancel", () =>
        client.cancelGatewayMaskingLocalModelDownload(),
      ),

    [NEOLIX_GATEWAY_WS_METHODS.maskingLocalModelRemove]: () =>
      fromPromise("neolix.gateway.masking.localModel.remove", () =>
        client.removeGatewayMaskingLocalModel(),
      ),

    [NEOLIX_GATEWAY_WS_METHODS.oidcRules]: () =>
      fromPromise("neolix.gateway.oidc.rules", () => client.listGatewayOidcRules()),

    [NEOLIX_GATEWAY_WS_METHODS.oidcSave]: (payload) =>
      fromPromise("neolix.gateway.oidc.save", () =>
        client.saveGatewayOidcRule((payload as { rule: never }).rule as never),
      ),

    [NEOLIX_GATEWAY_WS_METHODS.oidcRemove]: (payload) =>
      fromPromise("neolix.gateway.oidc.remove", () =>
        client.removeGatewayOidcRule((payload as { id: string }).id),
      ),

    [NEOLIX_GATEWAY_WS_METHODS.checkinStatus]: () =>
      fromPromise("neolix.gateway.checkin.status", () => client.getGatewayCheckin()),

    [NEOLIX_GATEWAY_WS_METHODS.checkinRun]: (payload) =>
      fromPromise("neolix.gateway.checkin.run", () =>
        client.runGatewayCheckin((payload ?? {}) as never),
      ),

    [NEOLIX_GATEWAY_WS_METHODS.checkinSwitch]: (payload) =>
      fromPromise("neolix.gateway.checkin.switch", () => {
        const input = payload as { by: string; on: boolean };
        return client.setGatewayCheckinSwitch(input.by, input.on);
      }),

    [NEOLIX_GATEWAY_WS_METHODS.checkinAccount]: (payload) =>
      fromPromise("neolix.gateway.checkin.account", () => {
        const input = payload as { key: string; on: boolean };
        return client.setGatewayCheckinAccount(input.key, input.on);
      }),

    [NEOLIX_GATEWAY_WS_METHODS.searchQuota]: (payload) =>
      fromPromise("neolix.gateway.search.quota", () => {
        const input = payload as { vendor: string; fresh?: boolean };
        return input.fresh === undefined
          ? client.getGatewaySearchQuota(input.vendor)
          : client.getGatewaySearchQuota(input.vendor, { fresh: input.fresh });
      }),

    [NEOLIX_GATEWAY_WS_METHODS.claudeMode]: () =>
      fromPromise("neolix.gateway.claude.mode", () => client.getGatewayClaudeMode()),

    [NEOLIX_GATEWAY_WS_METHODS.heldList]: () =>
      fromPromise("neolix.gateway.held.list", () => client.getGatewayHeldReports()),

    [NEOLIX_GATEWAY_WS_METHODS.heldRead]: (payload) =>
      fromPromise("neolix.gateway.held.read", () =>
        client.getGatewayHeldReport((payload as { name: string }).name),
      ),

    [NEOLIX_GATEWAY_WS_METHODS.heldReveal]: (payload) =>
      fromPromise("neolix.gateway.held.reveal", () =>
        client.revealGatewayHeldReport((payload as { name?: string } | undefined)?.name),
      ),

    [NEOLIX_GATEWAY_WS_METHODS.tuneGet]: (payload) =>
      fromPromise("neolix.gateway.tune.get", () =>
        client.getGatewayTune((payload as { days?: number } | undefined)?.days),
      ),

    [NEOLIX_GATEWAY_WS_METHODS.tuneApply]: (payload) =>
      fromPromise("neolix.gateway.tune.apply", () =>
        client.applyGatewayTune((payload ?? {}) as never),
      ),

    [NEOLIX_GATEWAY_WS_METHODS.tuneUndo]: (payload) =>
      fromPromise("neolix.gateway.tune.undo", () =>
        client.undoGatewayTune((payload ?? {}) as never),
      ),

    [NEOLIX_GATEWAY_WS_METHODS.subscriptionAccounts]: (payload) =>
      fromPromise("neolix.gateway.subscription.accounts", () =>
        client.listGatewaySubscriptionAccounts((payload ?? {}) as never),
      ),

    [NEOLIX_GATEWAY_WS_METHODS.subscriptionImport]: (payload) =>
      fromPromise("neolix.gateway.subscription.import", () =>
        client.importGatewaySubscriptionAccounts((payload ?? {}) as never),
      ),

    [NEOLIX_GATEWAY_WS_METHODS.subscriptionAdd]: (payload) =>
      fromPromise("neolix.gateway.subscription.add", () =>
        client.addGatewaySubscriptionAccount((payload ?? {}) as never),
      ),

    [NEOLIX_GATEWAY_WS_METHODS.subscriptionSwitch]: (payload) =>
      fromPromise("neolix.gateway.subscription.switch", () =>
        client.switchGatewaySubscriptionAccount((payload ?? {}) as never),
      ),

    [NEOLIX_GATEWAY_WS_METHODS.subscriptionRemove]: (payload) =>
      fromPromise("neolix.gateway.subscription.remove", () =>
        client.removeGatewaySubscriptionAccount((payload ?? {}) as never),
      ),

    [NEOLIX_GATEWAY_WS_METHODS.codexStatus]: () =>
      fromPromise("neolix.gateway.codex.status", () => client.getGatewayCodexStatus()),

    [NEOLIX_GATEWAY_WS_METHODS.codexAccounts]: () =>
      fromPromise("neolix.gateway.codex.accounts", () => client.getGatewayCodexAccounts()),

    [NEOLIX_GATEWAY_WS_METHODS.codexAccountSet]: (payload) =>
      fromPromise("neolix.gateway.codex.account.set", async () => {
        const input = payload as { id: string; enabled: boolean };
        await client.setGatewayCodexAccountEnabled(input.id, input.enabled);
        return {};
      }),

    [NEOLIX_GATEWAY_WS_METHODS.codexAccountArrange]: (payload) =>
      fromPromise("neolix.gateway.codex.account.arrange", async () => {
        await client.arrangeGatewayCodexAccounts((payload as { order: string[] }).order);
        return {};
      }),

    [NEOLIX_GATEWAY_WS_METHODS.codexAccountImport]: (payload) =>
      fromPromise("neolix.gateway.codex.account.import", () =>
        client.importGatewayCodexAccounts((payload ?? {}) as never),
      ),

    [NEOLIX_GATEWAY_WS_METHODS.codexAccountRemove]: (payload) =>
      fromPromise("neolix.gateway.codex.account.remove", async () => {
        await client.removeGatewayCodexAccount((payload as { id: string }).id);
        return {};
      }),

    [NEOLIX_GATEWAY_WS_METHODS.pluginSubscriptions]: () =>
      fromPromise("neolix.gateway.plugin.subscriptions", () =>
        client.getGatewayPluginSubscriptions(),
      ),

    [NEOLIX_GATEWAY_WS_METHODS.pluginSubscriptionModels]: (payload) =>
      fromPromise("neolix.gateway.plugin.subscription.models", () =>
        client.getGatewayPluginSubscriptionModels((payload ?? {}) as never),
      ),

    [NEOLIX_GATEWAY_WS_METHODS.pluginSubscriptionSignIn]: (payload) =>
      fromPromise("neolix.gateway.plugin.subscription.signIn", () =>
        client.signInGatewayPluginSubscription((payload ?? {}) as never),
      ),

    [NEOLIX_GATEWAY_WS_METHODS.pluginSubscriptionSignInPoll]: (payload) =>
      fromPromise("neolix.gateway.plugin.subscription.signInPoll", () =>
        client.pollGatewayPluginSubscriptionSignIn((payload ?? {}) as never),
      ),

    [NEOLIX_GATEWAY_WS_METHODS.signInStart]: (payload) =>
      fromPromise("neolix.gateway.signin.start", () =>
        client.startGatewaySignIn((payload ?? {}) as never),
      ),

    [NEOLIX_GATEWAY_WS_METHODS.signInStatus]: (payload) =>
      fromPromise("neolix.gateway.signin.status", () =>
        client.getGatewaySignIn((payload as { id: string }).id),
      ),

    [NEOLIX_GATEWAY_WS_METHODS.signInCancel]: (payload) =>
      fromPromise("neolix.gateway.signin.cancel", () =>
        client.cancelGatewaySignIn((payload as { id: string }).id),
      ),

    [NEOLIX_GATEWAY_WS_METHODS.signInCallback]: (payload) =>
      fromPromise("neolix.gateway.signin.callback", () => {
        const input = payload as { id: string; url: string };
        return client.callbackGatewaySignIn(input.id, input.url);
      }),
  };
}
