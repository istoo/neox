// FILE: neolixLibrary.ts
// Purpose: RPC schemas for Neolix's Library (instructions, MCP, skills, hooks,
//   subagents, RTK). The bridge maps these one-to-one onto the daemon's
//   `library.*` requests; the web settings panels call them through
//   `neolix.library.*`.
// Layer: Contracts

import { Schema } from "effect";

export const NEOLIX_LIBRARY_WS_METHODS = {
  get: "neolix.library.get",
  sync: "neolix.library.sync",
  saveInstructions: "neolix.library.instructions.save",
  saveMcpServer: "neolix.library.mcp.save",
  removeMcpServer: "neolix.library.mcp.remove",
  setMcpAgents: "neolix.library.mcp.setAgents",
  checkMcpServer: "neolix.library.mcp.health",
  setMcpHub: "neolix.library.mcp.hub",
  setMcpLocal: "neolix.library.mcp.setLocal",
  setMcpRouter: "neolix.library.mcp.setRouter",
  signInMcpServer: "neolix.library.mcp.signIn",
  mcpSignInStatus: "neolix.library.mcp.signInStatus",
  cancelMcpSignIn: "neolix.library.mcp.cancelSignIn",
  signOutMcpServer: "neolix.library.mcp.signOut",
  importSkill: "neolix.library.skill.import",
  findSkills: "neolix.library.skill.find",
  installSkills: "neolix.library.skill.install",
  setSkillOptions: "neolix.library.skill.options",
  setSkillNote: "neolix.library.skill.note",
  checkSkillUpdates: "neolix.library.skill.check",
  updateSkills: "neolix.library.skill.update",
  removeSkill: "neolix.library.skill.remove",
  setSkillAgents: "neolix.library.skill.setAgents",
  setSkillHere: "neolix.library.skill.here",
  handOverSkills: "neolix.library.skill.handover",
  handBackSkill: "neolix.library.skill.handback",
  settleSkill: "neolix.library.skill.settle",
  searchMarket: "neolix.library.market.servers",
  installMarketServer: "neolix.library.market.install",
  searchSkillMarket: "neolix.library.market.skills",
  saveHook: "neolix.library.hook.save",
  removeHook: "neolix.library.hook.remove",
  setHookAgents: "neolix.library.hook.setAgents",
  saveSubagent: "neolix.library.subagent.save",
  removeSubagent: "neolix.library.subagent.remove",
  setSubagentAgents: "neolix.library.subagent.setAgents",
  getRtk: "neolix.library.rtk.get",
  setRtk: "neolix.library.rtk.set",
  runRtk: "neolix.library.rtk.run",
  getRtkGain: "neolix.library.rtk.gain",
  getDiscover: "neolix.library.discover.get",
  importDiscovered: "neolix.library.discover.import",
  removeDiscovered: "neolix.library.discover.remove",
  getMynaLibrary: "neolix.library.myna.get",
  importMynaLibrary: "neolix.library.myna.import",
  listBackups: "neolix.library.backup.list",
  restoreBackup: "neolix.library.backup.restore",
  getNeolixTools: "neolix.library.neolixTools.get",
  setNeolixTools: "neolix.library.neolixTools.set",
} as const;

export type NeolixLibraryWsMethod =
  (typeof NEOLIX_LIBRARY_WS_METHODS)[keyof typeof NEOLIX_LIBRARY_WS_METHODS];

// ── Snapshot ────────────────────────────────────────────────────────────────

export const LibraryTransport = Schema.Literals(["stdio", "http", "sse"]);
export type LibraryTransport = typeof LibraryTransport.Type;

export const LibraryMcpSignInStatus = Schema.Struct({
  signedIn: Schema.Boolean,
  dead: Schema.optional(Schema.Boolean),
  at: Schema.optional(Schema.Number),
});
export type LibraryMcpSignInStatus = typeof LibraryMcpSignInStatus.Type;

export const LibraryMcpServer = Schema.Struct({
  name: Schema.String,
  transport: LibraryTransport,
  command: Schema.optional(Schema.String),
  args: Schema.optional(Schema.Array(Schema.String)),
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  url: Schema.optional(Schema.String),
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  agents: Schema.Array(Schema.String),
  disabledTools: Schema.optional(Schema.Array(Schema.String)),
  signIn: Schema.optional(LibraryMcpSignInStatus),
  oauth: Schema.optional(
    Schema.Struct({
      clientId: Schema.String,
      clientSecret: Schema.optional(Schema.String),
      callbackPort: Schema.optional(Schema.Number),
    }),
  ),
  startupTimeout: Schema.optional(Schema.Number),
  note: Schema.optional(Schema.String),
  icon: Schema.optional(Schema.String),
  local: Schema.optional(Schema.Boolean),
  router: Schema.optional(Schema.Literals(["shared", "direct"])),
});
export type LibraryMcpServer = typeof LibraryMcpServer.Type;

export const LibraryMcpHealth = Schema.Struct({
  ok: Schema.Boolean,
  tools: Schema.Array(Schema.String),
  error: Schema.optional(Schema.String),
  ms: Schema.Number,
});
export type LibraryMcpHealth = typeof LibraryMcpHealth.Type;

export const LibraryHook = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  event: Schema.String,
  matcher: Schema.optional(Schema.String),
  command: Schema.String,
  timeout: Schema.optional(Schema.Number),
  agents: Schema.Array(Schema.String),
});
export type LibraryHook = typeof LibraryHook.Type;

export const LibrarySubagent = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  prompt: Schema.String,
  skills: Schema.optional(Schema.Array(Schema.String)),
  mcp: Schema.optional(Schema.Array(Schema.String)),
  agents: Schema.Array(Schema.String),
});
export type LibrarySubagent = typeof LibrarySubagent.Type;

export const LibraryAgentView = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  icon: Schema.String,
  instructionsPath: Schema.String,
  mcpPath: Schema.NullOr(Schema.String),
  skillsDir: Schema.NullOr(Schema.String),
  hooksPath: Schema.NullOr(Schema.String),
  subagentsDir: Schema.NullOr(Schema.String),
  distro: Schema.optional(Schema.String),
});
export type LibraryAgentView = typeof LibraryAgentView.Type;

export const LibraryInstructionSetView = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  text: Schema.String,
  active: Schema.Boolean,
});
export type LibraryInstructionSetView = typeof LibraryInstructionSetView.Type;

export const LibraryAgentInstructionsView = Schema.Struct({
  agent: Schema.String,
  name: Schema.String,
  icon: Schema.String,
  path: Schema.String,
  on: Schema.Boolean,
  extra: Schema.String,
  own: Schema.Number,
  edited: Schema.Boolean,
  override: Schema.optional(Schema.String),
});
export type LibraryAgentInstructionsView = typeof LibraryAgentInstructionsView.Type;

export const LibraryInstructionsView = Schema.Struct({
  shared: Schema.String,
  sets: Schema.Array(LibraryInstructionSetView),
  agents: Schema.Array(LibraryAgentInstructionsView),
});
export type LibraryInstructionsView = typeof LibraryInstructionsView.Type;

export const LibrarySkillSource = Schema.Struct({
  kind: Schema.Literals(["folder", "git", "github"]),
  repo: Schema.optional(Schema.String),
  ref: Schema.optional(Schema.String),
  path: Schema.optional(Schema.String),
  dir: Schema.optional(Schema.String),
});
export type LibrarySkillSource = typeof LibrarySkillSource.Type;

export const LibrarySkillView = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  agents: Schema.Array(Schema.String),
  path: Schema.String,
  note: Schema.optional(Schema.String),
  source: Schema.optional(LibrarySkillSource),
  hash: Schema.optional(Schema.String),
  commit: Schema.optional(Schema.String),
  gone: Schema.optional(Schema.Boolean),
  modified: Schema.optional(Schema.Boolean),
  offHere: Schema.optional(Schema.Boolean),
  shared: Schema.optional(Schema.String),
  sharedElsewhere: Schema.optional(Schema.Boolean),
  always: Schema.optional(Schema.Array(Schema.String)),
});
export type LibrarySkillView = typeof LibrarySkillView.Type;

export const LibraryProblem = Schema.Struct({
  agent: Schema.String,
  what: Schema.String,
  error: Schema.String,
  own: Schema.optional(Schema.Boolean),
});
export type LibraryProblem = typeof LibraryProblem.Type;

export const LibrarySyncResult = Schema.Struct({
  changed: Schema.Array(Schema.String),
  problems: Schema.Array(LibraryProblem),
  backup: Schema.optional(Schema.String),
});
export type LibrarySyncResult = typeof LibrarySyncResult.Type;

export const LibrarySnapshot = Schema.Struct({
  dir: Schema.String,
  backupsDir: Schema.String,
  homeDir: Schema.String,
  agents: Schema.Array(LibraryAgentView),
  instructions: LibraryInstructionsView,
  mcp: Schema.Array(LibraryMcpServer),
  skills: Schema.Array(LibrarySkillView),
  hooks: Schema.Array(LibraryHook),
  subagents: Schema.Array(LibrarySubagent),
  mcpHub: Schema.optional(Schema.Boolean),
  skillOptions: Schema.optional(
    Schema.Struct({
      copySkills: Schema.Boolean,
      skillHow: Schema.Record(Schema.String, Schema.Literals(["link", "copy"])),
      sharedSkills: Schema.Boolean,
    }),
  ),
  counts: Schema.Struct({
    mcp: Schema.Number,
    skills: Schema.Number,
    hooks: Schema.Number,
    subagents: Schema.Number,
    rtk: Schema.Number,
  }),
});
export type LibrarySnapshot = typeof LibrarySnapshot.Type;

export const LibraryMutationResult = Schema.Struct({
  library: LibrarySnapshot,
  result: LibrarySyncResult,
});
export type LibraryMutationResult = typeof LibraryMutationResult.Type;

export const LibraryMcpSignInState = Schema.Struct({
  id: Schema.String,
  server: Schema.String,
  url: Schema.optional(Schema.String),
  state: Schema.Literals(["waiting", "done", "failed", "canceled"]),
  error: Schema.optional(Schema.String),
});
export type LibraryMcpSignInState = typeof LibraryMcpSignInState.Type;

export const LibrarySkillMarketHit = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  source: Schema.String,
  installs: Schema.Number,
  url: Schema.String,
});
export type LibrarySkillMarketHit = typeof LibrarySkillMarketHit.Type;

export const LibraryMarketInput = Schema.Struct({
  key: Schema.String,
  where: Schema.Literals(["env", "header", "arg"]),
  label: Schema.String,
  description: Schema.optional(Schema.String),
  placeholder: Schema.optional(Schema.String),
  secret: Schema.optional(Schema.Boolean),
  required: Schema.optional(Schema.Boolean),
});
export type LibraryMarketInput = typeof LibraryMarketInput.Type;

export const LibraryMarketServer = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  title: Schema.String,
  description: Schema.String,
  publisher: Schema.optional(Schema.String),
  icon: Schema.optional(Schema.String),
  homepage: Schema.optional(Schema.String),
  transport: LibraryTransport,
  runs: Schema.optional(Schema.String),
  featured: Schema.optional(Schema.Boolean),
  optIn: Schema.optional(Schema.Boolean),
  inputs: Schema.Array(LibraryMarketInput),
  have: Schema.optional(Schema.String),
});
export type LibraryMarketServer = typeof LibraryMarketServer.Type;

export const LibraryRtkAgent = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  icon: Schema.String,
  on: Schema.Boolean,
  distro: Schema.optional(Schema.String),
});
export type LibraryRtkAgent = typeof LibraryRtkAgent.Type;

export const LibraryRtkDistro = Schema.Struct({
  distro: Schema.String,
  installed: Schema.Boolean,
  path: Schema.NullOr(Schema.String),
  version: Schema.NullOr(Schema.String),
});
export type LibraryRtkDistro = typeof LibraryRtkDistro.Type;

export const LibraryRtkStatus = Schema.Struct({
  installed: Schema.Boolean,
  path: Schema.NullOr(Schema.String),
  version: Schema.NullOr(Schema.String),
  url: Schema.String,
  installCommand: Schema.optional(Schema.String),
  upgradeCommand: Schema.optional(Schema.String),
  pathHint: Schema.optional(Schema.String),
  distros: Schema.optional(Schema.Array(LibraryRtkDistro)),
  agents: Schema.Array(LibraryRtkAgent),
});
export type LibraryRtkStatus = typeof LibraryRtkStatus.Type;

export const LibraryRtkRun = Schema.Struct({
  ok: Schema.Boolean,
  command: Schema.String,
  output: Schema.String,
  error: Schema.optional(Schema.String),
});
export type LibraryRtkRun = typeof LibraryRtkRun.Type;

export const LibraryRtkGain = Schema.Struct({
  available: Schema.Boolean,
  raw: Schema.String,
  total: Schema.NullOr(Schema.Number),
  days: Schema.Array(Schema.Struct({ date: Schema.String, value: Schema.Number })),
});
export type LibraryRtkGain = typeof LibraryRtkGain.Type;

export const LibraryFoundMcpServer = Schema.Struct({
  name: Schema.String,
  transport: LibraryTransport,
  command: Schema.optional(Schema.String),
  args: Schema.optional(Schema.Array(Schema.String)),
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  url: Schema.optional(Schema.String),
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  agents: Schema.Array(Schema.String),
  disabledTools: Schema.optional(Schema.Array(Schema.String)),
  signIn: Schema.optional(LibraryMcpSignInStatus),
  oauth: Schema.optional(
    Schema.Struct({
      clientId: Schema.String,
      clientSecret: Schema.optional(Schema.String),
      callbackPort: Schema.optional(Schema.Number),
    }),
  ),
  startupTimeout: Schema.optional(Schema.Number),
  note: Schema.optional(Schema.String),
  icon: Schema.optional(Schema.String),
  local: Schema.optional(Schema.Boolean),
  router: Schema.optional(Schema.Literals(["shared", "direct"])),
  otherAgents: Schema.Array(Schema.String),
  own: Schema.optional(Schema.Boolean),
});
export type LibraryFoundMcpServer = typeof LibraryFoundMcpServer.Type;

export const LibraryFoundSkill = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  path: Schema.String,
  agents: Schema.Array(Schema.String),
  otherAgents: Schema.Array(Schema.String),
});
export type LibraryFoundSkill = typeof LibraryFoundSkill.Type;

export const LibraryDiscoverView = Schema.Struct({
  servers: Schema.Array(LibraryFoundMcpServer),
  skills: Schema.Array(LibraryFoundSkill),
});
export type LibraryDiscoverView = typeof LibraryDiscoverView.Type;

export const LibraryMynaLibraryView = Schema.Struct({
  dir: Schema.String,
  available: Schema.Boolean,
  servers: Schema.Array(LibraryFoundMcpServer),
  skills: Schema.Array(LibraryFoundSkill),
});
export type LibraryMynaLibraryView = typeof LibraryMynaLibraryView.Type;

export const LibraryBackupFile = Schema.Struct({
  file: Schema.String,
  size: Schema.Number,
  target: Schema.NullOr(Schema.String),
});
export type LibraryBackupFile = typeof LibraryBackupFile.Type;

export const LibraryBackupSession = Schema.Struct({
  stamp: Schema.String,
  files: Schema.Record(Schema.String, Schema.Array(LibraryBackupFile)),
});
export type LibraryBackupSession = typeof LibraryBackupSession.Type;

// ── Inputs ──────────────────────────────────────────────────────────────────

export const LibraryEmptyInput = Schema.Struct({});
export type LibraryEmptyInput = typeof LibraryEmptyInput.Type;

export const LibrarySaveInstructionsInput = Schema.Struct({
  shared: Schema.optional(Schema.String),
  agents: Schema.optional(Schema.Array(Schema.String)),
  extra: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  texts: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  activate: Schema.optional(Schema.String),
  create: Schema.optional(Schema.Struct({ id: Schema.String, name: Schema.String })),
  rename: Schema.optional(Schema.Struct({ id: Schema.String, name: Schema.String })),
  remove: Schema.optional(Schema.String),
  importOwn: Schema.optional(Schema.Array(Schema.String)),
  rewrite: Schema.optional(Schema.Array(Schema.String)),
});
export type LibrarySaveInstructionsInput = typeof LibrarySaveInstructionsInput.Type;

export const LibrarySaveMcpServerInput = Schema.Struct({
  server: LibraryMcpServer,
  oldName: Schema.optional(Schema.String),
});
export type LibrarySaveMcpServerInput = typeof LibrarySaveMcpServerInput.Type;

export const LibraryMcpNameInput = Schema.Struct({ name: Schema.String });
export type LibraryMcpNameInput = typeof LibraryMcpNameInput.Type;

export const LibraryMcpSetAgentsInput = Schema.Struct({
  name: Schema.String,
  agents: Schema.Array(Schema.String),
});
export type LibraryMcpSetAgentsInput = typeof LibraryMcpSetAgentsInput.Type;

export const LibraryMcpHubInput = Schema.Struct({ on: Schema.Boolean });
export type LibraryMcpHubInput = typeof LibraryMcpHubInput.Type;

export const LibraryMcpLocalInput = Schema.Struct({
  name: Schema.String,
  local: Schema.Boolean,
});
export type LibraryMcpLocalInput = typeof LibraryMcpLocalInput.Type;

export const LibraryMcpRouterInput = Schema.Struct({
  name: Schema.String,
  direct: Schema.Boolean,
});
export type LibraryMcpRouterInput = typeof LibraryMcpRouterInput.Type;

export const LibrarySkillImportInput = Schema.Struct({ path: Schema.String });
export type LibrarySkillImportInput = typeof LibrarySkillImportInput.Type;

export const LibraryIdInput = Schema.Struct({ id: Schema.String });
export type LibraryIdInput = typeof LibraryIdInput.Type;

export const LibrarySkillSourceInput = Schema.Struct({ source: LibrarySkillSource });
export type LibrarySkillSourceInput = typeof LibrarySkillSourceInput.Type;

export const LibrarySkillInstallInput = Schema.Struct({
  source: LibrarySkillSource,
  names: Schema.Array(Schema.String),
});
export type LibrarySkillInstallInput = typeof LibrarySkillInstallInput.Type;

export const LibrarySkillOptionsInput = Schema.Struct({
  copySkills: Schema.optional(Schema.Boolean),
  skillHow: Schema.optional(Schema.Record(Schema.String, Schema.Literals(["link", "copy"]))),
  sharedSkills: Schema.optional(Schema.Boolean),
});
export type LibrarySkillOptionsInput = typeof LibrarySkillOptionsInput.Type;

export const LibrarySkillNoteInput = Schema.Struct({
  name: Schema.String,
  note: Schema.String,
});
export type LibrarySkillNoteInput = typeof LibrarySkillNoteInput.Type;

export const LibrarySkillNameInput = Schema.Struct({ name: Schema.String });
export type LibrarySkillNameInput = typeof LibrarySkillNameInput.Type;

export const LibrarySkillSetAgentsInput = Schema.Struct({
  name: Schema.String,
  agents: Schema.Array(Schema.String),
});
export type LibrarySkillSetAgentsInput = typeof LibrarySkillSetAgentsInput.Type;

export const LibrarySkillHereInput = Schema.Struct({
  name: Schema.String,
  on: Schema.Boolean,
});
export type LibrarySkillHereInput = typeof LibrarySkillHereInput.Type;

export const LibrarySkillHandOverInput = Schema.Struct({
  names: Schema.NullOr(Schema.Array(Schema.String)),
});
export type LibrarySkillHandOverInput = typeof LibrarySkillHandOverInput.Type;

export const LibrarySkillSettleInput = Schema.Struct({
  name: Schema.String,
  agent: Schema.String,
  keepOwn: Schema.Boolean,
});
export type LibrarySkillSettleInput = typeof LibrarySkillSettleInput.Type;

export const LibrarySkillUpdateInput = Schema.Struct({
  names: Schema.NullOr(Schema.Array(Schema.String)),
});
export type LibrarySkillUpdateInput = typeof LibrarySkillUpdateInput.Type;

export const LibraryMarketSearchInput = Schema.Struct({ query: Schema.String });
export type LibraryMarketSearchInput = typeof LibraryMarketSearchInput.Type;

export const LibraryMarketInstallInput = Schema.Struct({
  id: Schema.String,
  values: Schema.Record(Schema.String, Schema.String),
  agents: Schema.Array(Schema.String),
});
export type LibraryMarketInstallInput = typeof LibraryMarketInstallInput.Type;

export const LibrarySaveHookInput = Schema.Struct({
  hook: LibraryHook,
  oldName: Schema.optional(Schema.String),
});
export type LibrarySaveHookInput = typeof LibrarySaveHookInput.Type;

export const LibrarySaveSubagentInput = Schema.Struct({
  subagent: LibrarySubagent,
  oldName: Schema.optional(Schema.String),
});
export type LibrarySaveSubagentInput = typeof LibrarySaveSubagentInput.Type;

export const LibraryRtkSetInput = Schema.Struct({
  agent: Schema.String,
  on: Schema.Boolean,
});
export type LibraryRtkSetInput = typeof LibraryRtkSetInput.Type;

export const LibraryRtkRunInput = Schema.Struct({
  action: Schema.Literals(["install", "upgrade"]),
  distro: Schema.optional(Schema.String),
});
export type LibraryRtkRunInput = typeof LibraryRtkRunInput.Type;

export const LibraryDiscoverSelectionInput = Schema.Struct({
  servers: Schema.Array(Schema.String),
  skills: Schema.Array(Schema.String),
});
export type LibraryDiscoverSelectionInput = typeof LibraryDiscoverSelectionInput.Type;

export const LibraryBackupRestoreInput = Schema.Struct({
  stamp: Schema.String,
  agent: Schema.String,
  file: Schema.String,
});
export type LibraryBackupRestoreInput = typeof LibraryBackupRestoreInput.Type;

export const LibraryNeolixToolsInput = Schema.Struct({});
export type LibraryNeolixToolsInput = typeof LibraryNeolixToolsInput.Type;

export const LibrarySetNeolixToolsInput = Schema.Struct({
  injectIntoAgents: Schema.optional(Schema.Boolean),
  enabled: Schema.optional(Schema.Boolean),
});
export type LibrarySetNeolixToolsInput = typeof LibrarySetNeolixToolsInput.Type;

// ── Outputs ─────────────────────────────────────────────────────────────────

export const LibrarySnapshotResult = Schema.Struct({ library: LibrarySnapshot });
export type LibrarySnapshotResult = typeof LibrarySnapshotResult.Type;

export const LibraryMcpHealthResult = Schema.Struct({ health: LibraryMcpHealth });
export type LibraryMcpHealthResult = typeof LibraryMcpHealthResult.Type;

export const LibraryMcpSignInResult = Schema.Struct({ state: LibraryMcpSignInState });
export type LibraryMcpSignInResult = typeof LibraryMcpSignInResult.Type;

export const LibraryMcpSignInStatusResult = Schema.Struct({
  state: Schema.optional(LibraryMcpSignInState),
});
export type LibraryMcpSignInStatusResult = typeof LibraryMcpSignInStatusResult.Type;

export const LibrarySkillFindResult = Schema.Struct({
  candidates: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      description: Schema.String,
      path: Schema.String,
      hash: Schema.String,
    }),
  ),
});
export type LibrarySkillFindResult = typeof LibrarySkillFindResult.Type;

export const LibrarySkillCheckResult = Schema.Struct({
  updates: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      available: Schema.Boolean,
      gone: Schema.Boolean,
    }),
  ),
});
export type LibrarySkillCheckResult = typeof LibrarySkillCheckResult.Type;

export const LibraryMarketServersResult = Schema.Struct({
  servers: Schema.Array(LibraryMarketServer),
  error: Schema.optional(Schema.String),
});
export type LibraryMarketServersResult = typeof LibraryMarketServersResult.Type;

export const LibrarySkillMarketResult = Schema.Struct({
  skills: Schema.Array(LibrarySkillMarketHit),
});
export type LibrarySkillMarketResult = typeof LibrarySkillMarketResult.Type;

export const LibraryRtkResult = Schema.Struct({ rtk: LibraryRtkStatus });
export type LibraryRtkResult = typeof LibraryRtkResult.Type;

export const LibraryRtkRunResult = Schema.Struct({
  rtk: LibraryRtkStatus,
  run: LibraryRtkRun,
});
export type LibraryRtkRunResult = typeof LibraryRtkRunResult.Type;

export const LibraryRtkGainResult = Schema.Struct({ gain: LibraryRtkGain });
export type LibraryRtkGainResult = typeof LibraryRtkGainResult.Type;

export const LibraryDiscoverResult = Schema.Struct({ discover: LibraryDiscoverView });
export type LibraryDiscoverResult = typeof LibraryDiscoverResult.Type;

export const LibraryMynaResult = Schema.Struct({ myna: LibraryMynaLibraryView });
export type LibraryMynaResult = typeof LibraryMynaResult.Type;

export const LibraryBackupsResult = Schema.Struct({
  backups: Schema.Array(LibraryBackupSession),
});
export type LibraryBackupsResult = typeof LibraryBackupsResult.Type;

export const LibraryRestoreResult = Schema.Struct({
  library: LibrarySnapshot,
  restored: Schema.String,
});
export type LibraryRestoreResult = typeof LibraryRestoreResult.Type;

export const LibraryNeolixToolsResult = Schema.Struct({
  address: Schema.NullOr(Schema.String),
  injectIntoAgents: Schema.Boolean,
  enabled: Schema.Boolean,
});
export type LibraryNeolixToolsResult = typeof LibraryNeolixToolsResult.Type;
