// App settings sync → Synara RPCs (`neolix.appSettings.*`).
//
// The daemon keeps the app's settings blob (the app's storage is a local file it
// cannot read). `get` answers the blob and the per-key times the CLI wrote;
// `export` replaces the blob with the app's merged settings; `subscribe` relays
// `sync.app_settings.apply` so an edit made elsewhere lands in the open app.
import {
  NEOLIX_APP_SETTINGS_WS_METHODS,
  type AppSettingsExportInput,
  type AppSettingsApplyEvent,
} from "@synara/contracts";
import { Effect, Queue, Stream } from "effect";

import type { BridgeModel } from "./model.ts";
import { fromPromise } from "./rpcErrors.ts";
import type { AnyHandler } from "./stubs.ts";

function supportsSync(client: BridgeModel["client"]): boolean {
  return client.getLastServerInfoMessage()?.features?.sync === true;
}

export function makeAppSettingsHandlers(model: BridgeModel): Record<string, AnyHandler> {
  const client = model.client;

  return {
    [NEOLIX_APP_SETTINGS_WS_METHODS.get]: () =>
      fromPromise("neolix.appSettings.get", async () => {
        if (!supportsSync(client)) {
          return { settings: null, supportsSync: false };
        }
        const copy = await client.getSyncAppSettings();
        return {
          settings: copy.settings,
          ...(copy.patchedAt === undefined ? {} : { patchedAt: copy.patchedAt }),
          supportsSync: true,
        };
      }),

    [NEOLIX_APP_SETTINGS_WS_METHODS.export]: (payload) =>
      fromPromise("neolix.appSettings.export", async () => {
        if (!supportsSync(client)) return { saved: false };
        const input = payload as AppSettingsExportInput;
        const result = await client.exportSyncAppSettings(input.settings);
        if (result.error) throw new Error(result.error);
        return { saved: true };
      }),

    [NEOLIX_APP_SETTINGS_WS_METHODS.subscribe]: () =>
      Stream.callback<AppSettingsApplyEvent>((queue) =>
        Effect.acquireRelease(
          Effect.sync(() =>
            client.subscribeRawMessages((message) => {
              if (message.type !== "sync.app_settings.apply") return;
              Queue.offerUnsafe(queue, { settings: message.payload.settings });
            }),
          ),
          (unsubscribe) => Effect.sync(unsubscribe),
        ),
      ),
  };
}
