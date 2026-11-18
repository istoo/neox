// FILE: neolixAppSettingsApi.ts
// Purpose: Typed calls into the bridge's `neolix.appSettings.*` surface: the
//          daemon's copy of this app's settings, the export that replaces it,
//          and the stream of edits made elsewhere.
// Layer: Web transport adapter

import {
  NEOLIX_APP_SETTINGS_WS_METHODS,
  type AppSettingsApplyEvent,
  type AppSettingsExportResult,
  type AppSettingsGetResult,
  type AppSettingsRecord,
} from "@synara/contracts";

import { getConnectionClients } from "~/lib/hosts/connectionClients";

function request<T>(method: string, payload?: unknown): Promise<T> {
  const body = payload === undefined ? {} : JSON.parse(JSON.stringify(payload));
  return getConnectionClients().execution.request<T>(method, body);
}

export const neolixAppSettingsApi = {
  get: () => request<AppSettingsGetResult>(NEOLIX_APP_SETTINGS_WS_METHODS.get),
  export: (settings: AppSettingsRecord) =>
    request<AppSettingsExportResult>(NEOLIX_APP_SETTINGS_WS_METHODS.export, { settings }),
  subscribe: (listener: (event: AppSettingsApplyEvent) => void) =>
    getConnectionClients().execution.subscribeAppSettings(listener),
};
