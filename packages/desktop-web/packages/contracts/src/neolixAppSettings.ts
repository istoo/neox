// FILE: neolixAppSettings.ts
// Purpose: RPC schemas for the daemon's copy of the app's settings. The host
//   keeps the blob and the time each key was last written from outside the app;
//   the app pushes its merged settings, adopts keys changed while it was closed,
//   and receives pushes for edits made elsewhere.
// Layer: Contracts

import { Schema } from "effect";

export const NEOLIX_APP_SETTINGS_WS_METHODS = {
  get: "neolix.appSettings.get",
  export: "neolix.appSettings.export",
  subscribe: "neolix.appSettings.subscribe",
} as const;

export type NeolixAppSettingsWsMethod =
  (typeof NEOLIX_APP_SETTINGS_WS_METHODS)[keyof typeof NEOLIX_APP_SETTINGS_WS_METHODS];

/** The app's settings as the daemon stores them: an opaque, schema-less record. */
export const AppSettingsRecord = Schema.Record(Schema.String, Schema.Unknown);
export type AppSettingsRecord = typeof AppSettingsRecord.Type;

export const AppSettingsGetResult = Schema.Struct({
  settings: Schema.NullOr(AppSettingsRecord),
  /** ISO time each key was last written outside the app (CLI, sync pull, restore). */
  patchedAt: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  /** False on hosts whose daemon predates the settings sync surface. */
  supportsSync: Schema.Boolean,
});
export type AppSettingsGetResult = typeof AppSettingsGetResult.Type;

export const AppSettingsExportInput = Schema.Struct({ settings: AppSettingsRecord });
export type AppSettingsExportInput = typeof AppSettingsExportInput.Type;

export const AppSettingsExportResult = Schema.Struct({ saved: Schema.Boolean });
export type AppSettingsExportResult = typeof AppSettingsExportResult.Type;

/** One push: every key in the payload is replaced in the app's settings. */
export const AppSettingsApplyEvent = Schema.Struct({ settings: AppSettingsRecord });
export type AppSettingsApplyEvent = typeof AppSettingsApplyEvent.Type;
