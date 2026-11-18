// FILE: neolixAgentConnect.ts
// Purpose: RPC schemas for the daemon's Agent Connect surface: whether an
//   installed agent's own config points at the model gateway, the models its
//   list hides, the shell function, and the saved setups (profiles). The bridge
//   forwards each method to the daemon's `agent.connect.*` request.
// Layer: Contracts

import { Schema } from "effect";

export const NEOLIX_AGENT_CONNECT_WS_METHODS = {
  get: "neolix.agentConnect.get",
  set: "neolix.agentConnect.set",
  profileList: "neolix.agentConnect.profile.list",
  profileSave: "neolix.agentConnect.profile.save",
  profileApply: "neolix.agentConnect.profile.apply",
  profileDelete: "neolix.agentConnect.profile.delete",
  profileRename: "neolix.agentConnect.profile.rename",
  layoutSet: "neolix.agentConnect.layout.set",
  modelsSet: "neolix.agentConnect.models.set",
  shellSet: "neolix.agentConnect.shell.set",
  staleRestart: "neolix.agentConnect.stale.restart",
} as const;

export type NeolixAgentConnectWsMethod =
  (typeof NEOLIX_AGENT_CONNECT_WS_METHODS)[keyof typeof NEOLIX_AGENT_CONNECT_WS_METHODS];

/** Why a provider cannot be switched on; `null` means it can. */
export const AgentConnectReason = Schema.NullOr(
  Schema.Literals(["unsupported", "gateway_unavailable", "no_gateway_models"]),
);
export type AgentConnectReason = typeof AgentConnectReason.Type;

/** `unwired`/`stale` mean the agent still points at the gateway through something out of date. */
export const AgentConnectDrift = Schema.Literals(["unwired", "stale"]);
export type AgentConnectDrift = typeof AgentConnectDrift.Type;

export const AgentConnectStaleKind = Schema.Literals(["app", "ide", "daemon", "cli"]);
export type AgentConnectStaleKind = typeof AgentConnectStaleKind.Type;

export const AgentConnectModel = Schema.Struct({
  id: Schema.String,
  label: Schema.optional(Schema.String),
  contextWindow: Schema.optional(Schema.Number),
  maxOutputTokens: Schema.optional(Schema.Number),
  kind: Schema.optional(Schema.Literals(["chat", "image", "video"])),
  images: Schema.optional(Schema.Boolean),
});
export type AgentConnectModel = typeof AgentConnectModel.Type;

/** An agent's own setting (myna's `myna <agent> <field>`). */
export const AgentConnectSetting = Schema.Struct({
  key: Schema.String,
  label: Schema.String,
  value: Schema.String,
  options: Schema.optional(Schema.Array(Schema.String)),
});
export type AgentConnectSetting = typeof AgentConnectSetting.Type;

/** One of the four model roles an agent carries in its own row. */
export const AgentConnectField = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  model: Schema.NullOr(Schema.String),
});
export type AgentConnectField = typeof AgentConnectField.Type;

/** The gateway models an agent's own list carries and the ones it leaves out. */
export const AgentConnectModels = Schema.Struct({
  listed: Schema.Number,
  shown: Schema.Number,
  hidden: Schema.Array(Schema.String),
});
export type AgentConnectModels = typeof AgentConnectModels.Type;

export const AgentConnectStaleCopy = Schema.Struct({
  kind: AgentConnectStaleKind,
  since: Schema.Number,
  bundle: Schema.optional(Schema.String),
});
export type AgentConnectStaleCopy = typeof AgentConnectStaleCopy.Type;

export const AgentConnectEntry = Schema.Struct({
  provider: Schema.String,
  configPath: Schema.NullOr(Schema.String),
  connected: Schema.Boolean,
  model: Schema.NullOr(Schema.String),
  modelCount: Schema.Number,
  fields: Schema.optional(Schema.Array(AgentConnectField)),
  settings: Schema.optional(Schema.Array(AgentConnectSetting)),
  models: Schema.optional(AgentConnectModels),
  cliVersion: Schema.optional(Schema.String),
  staleCopies: Schema.optional(Schema.Array(AgentConnectStaleCopy)),
  reason: AgentConnectReason,
  drift: Schema.optional(Schema.NullOr(AgentConnectDrift)),
  launchCommand: Schema.optional(Schema.NullOr(Schema.String)),
  kind: Schema.optional(Schema.Literals(["provider", "external"])),
  name: Schema.optional(Schema.String),
  icon: Schema.optional(Schema.String),
  shellInstalled: Schema.optional(Schema.Boolean),
  importLink: Schema.optional(Schema.String),
});
export type AgentConnectEntry = typeof AgentConnectEntry.Type;

const AgentConnectSetup = Schema.Struct({
  connected: Schema.Boolean,
  model: Schema.NullOr(Schema.String),
});

export const AgentConnectLibrary = Schema.Struct({
  mcp: Schema.optional(Schema.Record(Schema.String, Schema.Array(Schema.String))),
  skills: Schema.optional(Schema.Record(Schema.String, Schema.Array(Schema.String))),
  hooks: Schema.optional(Schema.Record(Schema.String, Schema.Array(Schema.String))),
  subagents: Schema.optional(Schema.Record(Schema.String, Schema.Array(Schema.String))),
  instructions: Schema.optional(Schema.Array(Schema.String)),
  mcpHub: Schema.optional(Schema.Boolean),
});
export type AgentConnectLibrary = typeof AgentConnectLibrary.Type;

export const AgentConnectProfile = Schema.Struct({
  name: Schema.String,
  savedAt: Schema.Number,
  agents: Schema.Record(Schema.String, AgentConnectSetup),
  library: Schema.optional(AgentConnectLibrary),
  inUse: Schema.optional(Schema.Boolean),
});
export type AgentConnectProfile = typeof AgentConnectProfile.Type;

export const AgentConnectPluginProvider = Schema.Struct({
  pluginId: Schema.String,
  providers: Schema.Array(Schema.String),
});
export type AgentConnectPluginProvider = typeof AgentConnectPluginProvider.Type;

export const AgentConnectSnapshot = Schema.Struct({
  gatewayBaseUrl: Schema.NullOr(Schema.String),
  models: Schema.Array(AgentConnectModel),
  entries: Schema.Array(AgentConnectEntry),
  profiles: Schema.Array(AgentConnectProfile),
  order: Schema.optional(Schema.Array(Schema.String)),
  hidden: Schema.optional(Schema.Array(Schema.String)),
  pluginProviders: Schema.optional(Schema.Array(AgentConnectPluginProvider)),
  error: Schema.NullOr(Schema.String),
});
export type AgentConnectSnapshot = typeof AgentConnectSnapshot.Type;

export const AgentConnectResult = Schema.Struct({ snapshot: AgentConnectSnapshot });
export type AgentConnectResult = typeof AgentConnectResult.Type;

export const AgentConnectEmptyInput = Schema.Struct({});
export type AgentConnectEmptyInput = typeof AgentConnectEmptyInput.Type;

export const AgentConnectSetInput = Schema.Struct({
  provider: Schema.String,
  connected: Schema.Boolean,
  model: Schema.optional(Schema.String),
  /** An entry `settings` key to write instead; `value: ""` restores the default. */
  field: Schema.optional(Schema.String),
  value: Schema.optional(Schema.String),
});
export type AgentConnectSetInput = typeof AgentConnectSetInput.Type;

export const AgentConnectNameInput = Schema.Struct({ name: Schema.String });
export type AgentConnectNameInput = typeof AgentConnectNameInput.Type;

export const AgentConnectRenameInput = Schema.Struct({
  name: Schema.String,
  to: Schema.String,
});
export type AgentConnectRenameInput = typeof AgentConnectRenameInput.Type;

export const AgentConnectLayoutInput = Schema.Struct({
  order: Schema.Array(Schema.String),
  hidden: Schema.Array(Schema.String),
});
export type AgentConnectLayoutInput = typeof AgentConnectLayoutInput.Type;

export const AgentConnectModelsInput = Schema.Struct({
  provider: Schema.String,
  hidden: Schema.Array(Schema.String),
});
export type AgentConnectModelsInput = typeof AgentConnectModelsInput.Type;

export const AgentConnectShellInput = Schema.Struct({
  provider: Schema.String,
  enabled: Schema.Boolean,
});
export type AgentConnectShellInput = typeof AgentConnectShellInput.Type;

export const AgentConnectStaleRestartInput = Schema.Struct({
  provider: Schema.String,
  kind: AgentConnectStaleKind,
});
export type AgentConnectStaleRestartInput = typeof AgentConnectStaleRestartInput.Type;
