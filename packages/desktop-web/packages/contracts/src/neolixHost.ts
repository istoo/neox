// Neolix-only host settings RPCs the bridge serves beside the Synara contract. They map
// straight onto the Neolix daemon's own requests (daemon config, lifecycle, speech models,
// external sessions, sync and backup, gateway config); Synara has no equivalent surface, so
// they live in their own namespace instead of widening WS_METHODS.
//
// The Rpc definitions themselves live in `rpc.ts` with the other groups: `WsRpcError` is
// declared there, and defining them here would make the two modules import each other during
// initialisation.
import { Schema } from "effect";

export const NEOLIX_HOST_WS_METHODS = {
  getFeatures: "neolix.host.getFeatures",
  subscribeFeatures: "neolix.host.subscribeFeatures",
  getConfig: "neolix.host.getConfig",
  patchConfig: "neolix.host.patchConfig",
  getStatus: "neolix.host.getStatus",
  listSessionTerminals: "neolix.host.listSessionTerminals",
  restart: "neolix.host.restart",
  update: "neolix.host.update",
  subscribeUpdateProgress: "neolix.host.subscribeUpdateProgress",
  getDiagnostics: "neolix.host.getDiagnostics",
  getProviderDiagnostic: "neolix.host.getProviderDiagnostic",
  revealPath: "neolix.host.revealPath",
  listSpeechModels: "neolix.host.listSpeechModels",
  downloadSpeechModel: "neolix.host.downloadSpeechModel",
  deleteSpeechModel: "neolix.host.deleteSpeechModel",
  getSessionReads: "neolix.host.getSessionReads",
  setSessionReads: "neolix.host.setSessionReads",
  listExternalSessions: "neolix.host.listExternalSessions",
  searchExternalSessions: "neolix.host.searchExternalSessions",
  openSessionInTerminal: "neolix.host.openSessionInTerminal",
  deleteExternalSessions: "neolix.host.deleteExternalSessions",
  restoreExternalSession: "neolix.host.restoreExternalSession",
  purgeExternalSessions: "neolix.host.purgeExternalSessions",
  getExternalSessionTranscript: "neolix.host.getExternalSessionTranscript",
  exportExternalSession: "neolix.host.exportExternalSession",
  resumeExternalSession: "neolix.host.resumeExternalSession",
  moveExternalCodexProvider: "neolix.host.moveExternalCodexProvider",
  relocateClaudeProject: "neolix.host.relocateClaudeProject",
  setConversationRecording: "neolix.host.setConversationRecording",
  resolveProvider: "neolix.host.resolveProvider",
  getSyncConfig: "neolix.host.getSyncConfig",
  setSyncConfig: "neolix.host.setSyncConfig",
  getSyncStatus: "neolix.host.getSyncStatus",
  getSyncUsage: "neolix.host.getSyncUsage",
  listSyncRemote: "neolix.host.listSyncRemote",
  runSync: "neolix.host.runSync",
  restoreSync: "neolix.host.restoreSync",
  undoSync: "neolix.host.undoSync",
  uploadSync: "neolix.host.uploadSync",
  followSync: "neolix.host.followSync",
  dismissSyncNotice: "neolix.host.dismissSyncNotice",
  listBackups: "neolix.host.listBackups",
  getBackupAuto: "neolix.host.getBackupAuto",
  setBackupAuto: "neolix.host.setBackupAuto",
  exportBackup: "neolix.host.exportBackup",
  importBackup: "neolix.host.importBackup",
  downloadBackup: "neolix.host.downloadBackup",
  restoreBackup: "neolix.host.restoreBackup",
  deleteBackup: "neolix.host.deleteBackup",
  revealBackups: "neolix.host.revealBackups",
  getWebPage: "neolix.host.getWebPage",
  setWebPage: "neolix.host.setWebPage",
  getThirdPartyNotices: "neolix.host.getThirdPartyNotices",
  getLibraryGithubToken: "neolix.host.getLibraryGithubToken",
  setLibraryGithubToken: "neolix.host.setLibraryGithubToken",
} as const;

export type NeolixHostWsMethod =
  (typeof NEOLIX_HOST_WS_METHODS)[keyof typeof NEOLIX_HOST_WS_METHODS];

// The daemon's config is an open, versioned schema; the bridge forwards it verbatim so a
// newer daemon's fields survive a round trip through an older bridge. `Schema.Json`, not
// `Schema.Unknown`: the RPC JSON codec encodes Unknown as null.
export const NeolixHostConfig = Schema.Json;
export type NeolixHostConfig = unknown;

export const NeolixHostConfigPatch = Schema.Json;
export type NeolixHostConfigPatch = unknown;

/**
 * The capability flags the daemon advertises on `server_info.features`. The front end gates a
 * feature on one flag and either runs it or asks the user to update the host; an absent flag is
 * an older daemon, not a reason to fall back.
 */
export const NeolixHostFeatures = Schema.Struct({
  serverVersion: Schema.NullOr(Schema.String),
  features: Schema.Record(Schema.String, Schema.Boolean),
});
export type NeolixHostFeatures = typeof NeolixHostFeatures.Type;

export const NeolixHostStatus = Schema.Struct({
  serverId: Schema.String,
  version: Schema.NullOr(Schema.String),
  pid: Schema.Number,
  startedAt: Schema.NullOr(Schema.String),
  listen: Schema.NullOr(Schema.String),
  container: Schema.optional(Schema.Boolean),
  /** NEOLIX_PUBLIC_URL: where other computers reach this host's page and gateway. */
  publicUrl: Schema.optional(Schema.NullOr(Schema.String)),
  /** The daemon's config folder (its home), when the daemon reports one. */
  home: Schema.optional(Schema.NullOr(Schema.String)),
  /** The daemon's own log file; null when it writes none. */
  logPath: Schema.optional(Schema.NullOr(Schema.String)),
});
export type NeolixHostStatus = typeof NeolixHostStatus.Type;

/** The phases the daemon reports while it replaces its own install. */
export const NeolixHostUpdateProgressPhase = Schema.Literals([
  "starting",
  "downloading",
  "installing",
  "complete",
]);
export type NeolixHostUpdateProgressPhase = typeof NeolixHostUpdateProgressPhase.Type;

/** One `daemon.update.progress` event, forwarded by the bridge while an update runs. */
export const NeolixHostUpdateProgress = Schema.Struct({
  phase: NeolixHostUpdateProgressPhase,
});
export type NeolixHostUpdateProgress = typeof NeolixHostUpdateProgress.Type;

/** The third-party license list every build carries (Settings › About). */
export const NeolixThirdPartyNotices = Schema.Struct({
  notices: Schema.String,
});
export type NeolixThirdPartyNotices = typeof NeolixThirdPartyNotices.Type;

/** One Mac terminal that can open a resumed session (the daemon's terminal_apps). */
export const NeolixSessionTerminalApp = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
});
export type NeolixSessionTerminalApp = typeof NeolixSessionTerminalApp.Type;

/** The host's answer to `sessions.terminals.list`; `supported: false` off macOS. */
export const NeolixSessionTerminals = Schema.Struct({
  supported: Schema.Boolean,
  apps: Schema.Array(NeolixSessionTerminalApp),
  defaultId: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
});
export type NeolixSessionTerminals = typeof NeolixSessionTerminals.Type;

/** The diagnostics text the daemon writes for Settings › Diagnostics. */
export const NeolixHostDiagnostics = Schema.Struct({
  diagnostic: Schema.String,
});
export type NeolixHostDiagnostics = typeof NeolixHostDiagnostics.Type;

/** One provider's self-check text, as Settings › Agent providers › Diagnostics shows it. */
export const NeolixProviderDiagnostic = Schema.Struct({
  provider: Schema.String,
  diagnostic: Schema.String,
});
export type NeolixProviderDiagnostic = typeof NeolixProviderDiagnostic.Type;

/** Whether the daemon opened its config folder or log on its own computer. */
export const NeolixHostRevealResult = Schema.Struct({
  ok: Schema.Boolean,
  error: Schema.optional(Schema.NullOr(Schema.String)),
});
export type NeolixHostRevealResult = typeof NeolixHostRevealResult.Type;

export const NeolixSpeechModel = Schema.Struct({
  id: Schema.String,
  // "stt" or "tts".
  kind: Schema.String,
  label: Schema.String,
  description: Schema.String,
  languages: Schema.Array(Schema.String),
  downloadSizeBytes: Schema.Number,
  isDefault: Schema.Boolean,
  inUse: Schema.Boolean,
  // "installed" | "not_installed" | "downloading" | "extracting" | "failed".
  status: Schema.String,
  receivedBytes: Schema.optional(Schema.Number),
  totalBytes: Schema.optional(Schema.Number),
});
export type NeolixSpeechModel = typeof NeolixSpeechModel.Type;

export const NeolixSessionReadAgent = Schema.Struct({
  agent: Schema.String,
  name: Schema.String,
  on: Schema.Boolean,
});
export type NeolixSessionReadAgent = typeof NeolixSessionReadAgent.Type;

export const NeolixSessionReads = Schema.Struct({
  asked: Schema.Boolean,
  all: Schema.Boolean,
  found: Schema.Array(NeolixSessionReadAgent),
});
export type NeolixSessionReads = typeof NeolixSessionReads.Type;

export const NeolixExternalSession = Schema.Struct({
  id: Schema.String,
  agent: Schema.String,
  cwd: Schema.String,
  title: Schema.String,
  start: Schema.String,
  last: Schema.String,
  messages: Schema.Number,
  size: Schema.Number,
  cost: Schema.Number,
  priced: Schema.Boolean,
  resume: Schema.String,
  path: Schema.String,
  deletable: Schema.Boolean,
  gateway: Schema.optional(Schema.Boolean),
  provider: Schema.optional(Schema.String),
  /** The provider the Codex of this session's folder uses now. */
  usesProvider: Schema.optional(Schema.String),
});
export type NeolixExternalSession = typeof NeolixExternalSession.Type;

export const NeolixExternalSessionTrash = Schema.Struct({
  key: Schema.String,
  agent: Schema.String,
  id: Schema.String,
  title: Schema.String,
  cwd: Schema.String,
  last: Schema.String,
  deleted: Schema.String,
  size: Schema.Number,
  gateway: Schema.optional(Schema.Boolean),
});
export type NeolixExternalSessionTrash = typeof NeolixExternalSessionTrash.Type;

export const NeolixExternalSessionAgent = Schema.Struct({
  agent: Schema.String,
  name: Schema.String,
  count: Schema.Number,
  deletable: Schema.Boolean,
});
export type NeolixExternalSessionAgent = typeof NeolixExternalSessionAgent.Type;

export const NeolixExternalSessions = Schema.Struct({
  agents: Schema.Array(NeolixExternalSessionAgent),
  agent: Schema.String,
  sessions: Schema.Array(NeolixExternalSession),
  trash: Schema.Array(NeolixExternalSessionTrash),
  trashDir: Schema.String,
  home: Schema.String,
  recording: Schema.Boolean,
  recorded: Schema.Boolean,
  /** Rows from file headers while the daemon still reads their files in full. */
  partial: Schema.optional(Schema.Boolean),
  error: Schema.NullOr(Schema.String),
});
export type NeolixExternalSessions = typeof NeolixExternalSessions.Type;

export const NeolixExternalSessionSearch = Schema.Struct({
  hits: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      role: Schema.String,
      kind: Schema.String,
      before: Schema.String,
      match: Schema.String,
      after: Schema.String,
    }),
  ),
  searched: Schema.Number,
  total: Schema.Number,
  cut: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
});
export type NeolixExternalSessionSearch = typeof NeolixExternalSessionSearch.Type;

export const NeolixExternalSessionRefusal = Schema.Struct({
  id: Schema.String,
  error: Schema.String,
  active: Schema.Boolean,
});
export type NeolixExternalSessionRefusal = typeof NeolixExternalSessionRefusal.Type;

export const NeolixExternalSessionDelete = Schema.Struct({
  deleted: Schema.Array(Schema.String),
  refused: Schema.Array(NeolixExternalSessionRefusal),
  error: Schema.NullOr(Schema.String),
});
export type NeolixExternalSessionDelete = typeof NeolixExternalSessionDelete.Type;

export const NeolixExternalSessionRestore = Schema.Struct({
  agent: Schema.String,
  id: Schema.String,
  title: Schema.String,
  error: Schema.NullOr(Schema.String),
});
export type NeolixExternalSessionRestore = typeof NeolixExternalSessionRestore.Type;

export const NeolixExternalSessionPurge = Schema.Struct({
  purged: Schema.Array(Schema.String),
  refused: Schema.Array(
    Schema.Struct({
      key: Schema.String,
      error: Schema.String,
    }),
  ),
  error: Schema.NullOr(Schema.String),
});
export type NeolixExternalSessionPurge = typeof NeolixExternalSessionPurge.Type;

export const NeolixTranscriptPart = Schema.Struct({
  role: Schema.String,
  kind: Schema.String,
  name: Schema.optional(Schema.String),
  text: Schema.String,
  model: Schema.optional(Schema.String),
  cut: Schema.optional(Schema.Number),
});
export type NeolixTranscriptPart = typeof NeolixTranscriptPart.Type;

export const NeolixExternalTranscript = Schema.Struct({
  parts: Schema.Array(NeolixTranscriptPart),
  total: Schema.Number,
  cut: Schema.Boolean,
  source: Schema.String,
  error: Schema.NullOr(Schema.String),
});
export type NeolixExternalTranscript = typeof NeolixExternalTranscript.Type;

export const NeolixExternalExport = Schema.Struct({
  fileName: Schema.String,
  markdown: Schema.String,
  error: Schema.NullOr(Schema.String),
});
export type NeolixExternalExport = typeof NeolixExternalExport.Type;

export const NeolixCodexMove = Schema.Struct({
  id: Schema.String,
  from: Schema.String,
  to: Schema.String,
  backup: Schema.String,
});
export type NeolixCodexMove = typeof NeolixCodexMove.Type;

export const NeolixCodexMoveResult = Schema.Struct({
  moved: Schema.Array(NeolixCodexMove),
  refused: Schema.Array(NeolixExternalSessionRefusal),
  error: Schema.NullOr(Schema.String),
});
export type NeolixCodexMoveResult = typeof NeolixCodexMoveResult.Type;

export const NeolixRelocatePreview = Schema.Struct({
  from: Schema.String,
  to: Schema.String,
  sessions: Schema.Number,
  bytes: Schema.Number,
});
export type NeolixRelocatePreview = typeof NeolixRelocatePreview.Type;

export const NeolixRelocateResult = Schema.Struct({
  preview: Schema.NullOr(NeolixRelocatePreview),
  token: Schema.NullOr(Schema.String),
  backup: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
});
export type NeolixRelocateResult = typeof NeolixRelocateResult.Type;

export const NeolixConversationRecording = Schema.Struct({
  recording: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
});
export type NeolixConversationRecording = typeof NeolixConversationRecording.Type;

export const NeolixResolvedProvider = Schema.Struct({
  /** The Neolix provider id the instance resolves to, or null when it is not available. */
  provider: Schema.NullOr(Schema.String),
});
export type NeolixResolvedProvider = typeof NeolixResolvedProvider.Type;

// ── Sync and backup ────────────────────────────────────────────────────────

export const NeolixSyncParts = Schema.Struct({
  sources: Schema.Boolean,
  settings: Schema.Boolean,
  profiles: Schema.Boolean,
  models: Schema.Boolean,
  library: Schema.Boolean,
  usage: Schema.optional(Schema.Boolean),
});
export type NeolixSyncParts = typeof NeolixSyncParts.Type;

export const NeolixSyncConfig = Schema.Struct({
  enabled: Schema.Boolean,
  backend: Schema.NullOr(Schema.String),
  url: Schema.String,
  user: Schema.String,
  passwordSet: Schema.Boolean,
  passphraseSet: Schema.Boolean,
  endpoint: Schema.String,
  region: Schema.String,
  pathStyle: Schema.Boolean,
  branch: Schema.String,
  keys: Schema.Boolean,
  parts: NeolixSyncParts,
  intervalMinutes: Schema.Number,
  device: Schema.String,
});
export type NeolixSyncConfig = typeof NeolixSyncConfig.Type;

export const NeolixSyncNotice = Schema.Struct({
  at: Schema.String,
  here: Schema.Array(Schema.String),
  there: Schema.Array(Schema.String),
  saved: Schema.optional(Schema.String),
  restored: Schema.optional(Schema.Boolean),
});
export type NeolixSyncNotice = typeof NeolixSyncNotice.Type;

export const NeolixSyncStatus = Schema.Struct({
  enabled: Schema.Boolean,
  last: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  notice: Schema.optional(NeolixSyncNotice),
  undo: Schema.Boolean,
  running: Schema.Boolean,
  own: Schema.optional(Schema.Array(Schema.Struct({ agent: Schema.String, field: Schema.String }))),
  usageError: Schema.optional(Schema.String),
  serverFile: Schema.optional(Schema.Struct({ replace: Schema.Boolean })),
});
export type NeolixSyncStatus = typeof NeolixSyncStatus.Type;

export const NeolixSyncRemoteVersion = Schema.Struct({
  part: Schema.String,
  takenAt: Schema.String,
  device: Schema.String,
  files: Schema.Number,
});
export type NeolixSyncRemoteVersion = typeof NeolixSyncRemoteVersion.Type;

/**
 * Every computer's shared usage, as the daemon's `sync.usage.get` answers it (myna's
 * Usage page). Top-level totals stay optional for an older host that still advertises
 * `sync`; the arrays are what the page draws.
 */
const NeolixSyncUsageTotals = {
  calls: Schema.optional(Schema.Number),
  errors: Schema.optional(Schema.Number),
  input: Schema.optional(Schema.Number),
  output: Schema.optional(Schema.Number),
  cache_read: Schema.optional(Schema.Number),
  cache_write: Schema.optional(Schema.Number),
  reasoning: Schema.optional(Schema.Number),
  cost: Schema.optional(Schema.Number),
  unpriced: Schema.optional(Schema.Number),
} as const;

const NeolixSyncUsagePointTotals = {
  calls: Schema.Number,
  errors: Schema.Number,
  input: Schema.Number,
  output: Schema.Number,
  cache_read: Schema.Number,
  cache_write: Schema.Number,
  reasoning: Schema.Number,
  cost: Schema.Number,
  unpriced: Schema.Number,
} as const;

/** One day of the shared series (myna `usage.Point`); zero days are kept. */
export const NeolixSyncUsageSeriesPoint = Schema.Struct({
  label: Schema.String,
  time: Schema.String,
  ...NeolixSyncUsagePointTotals,
});
export type NeolixSyncUsageSeriesPoint = typeof NeolixSyncUsageSeriesPoint.Type;

/** One computer's part of the period (myna `usage.Share`); this one is `this`. */
export const NeolixSyncUsageComputer = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  ...NeolixSyncUsagePointTotals,
});
export type NeolixSyncUsageComputer = typeof NeolixSyncUsageComputer.Type;

/** One call of the shared ledger (myna `usageapi.Row`). */
export const NeolixSyncUsageRow = Schema.Struct({
  t: Schema.String,
  agent: Schema.String,
  provider: Schema.String,
  providerAccount: Schema.optional(Schema.String),
  model: Schema.String,
  req: Schema.optional(Schema.String),
  in: Schema.Number,
  out: Schema.Number,
  cache_read: Schema.Number,
  cache_write: Schema.Number,
  reasoning: Schema.optional(Schema.Number),
  ms: Schema.Number,
  status: Schema.Number,
  cost: Schema.Number,
  priced: Schema.Boolean,
  source: Schema.optional(Schema.String),
  computer: Schema.optional(Schema.String),
  computerName: Schema.optional(Schema.String),
});
export type NeolixSyncUsageRow = typeof NeolixSyncUsageRow.Type;

export const NeolixSyncUsageModelDay = Schema.Struct({
  calls: Schema.Number,
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
  costUsd: Schema.Number,
});
export type NeolixSyncUsageModelDay = typeof NeolixSyncUsageModelDay.Type;

/** One computer's legacy per-day totals, kept for an older page shape. */
export const NeolixSyncUsageDay = Schema.Struct({
  day: Schema.String,
  calls: Schema.Number,
  failed: Schema.Number,
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
  cacheReadTokens: Schema.Number,
  cacheWriteTokens: Schema.Number,
  reasoningTokens: Schema.Number,
  costUsd: Schema.Number,
  unpricedCalls: Schema.Number,
  byModel: Schema.Record(Schema.String, NeolixSyncUsageModelDay),
  updatedAt: Schema.String,
});
export type NeolixSyncUsageDay = typeof NeolixSyncUsageDay.Type;

export const NeolixSyncUsageQuotaReading = Schema.Struct({
  at: Schema.Number,
  provider: Schema.String,
  account: Schema.String,
  remaining: Schema.NullOr(Schema.Number),
  limit: Schema.NullOr(Schema.Number),
  resetAt: Schema.NullOr(Schema.Number),
  usedPercent: Schema.NullOr(Schema.Number),
});
export type NeolixSyncUsageQuotaReading = typeof NeolixSyncUsageQuotaReading.Type;

/** One account's merged quota history (myna `provider.QuotaHistory`). */
export const NeolixSyncUsageQuotaHistory = Schema.Struct({
  provider: Schema.String,
  user: Schema.String,
  lines: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      points: Schema.Array(
        Schema.Struct({
          at: Schema.String,
          left: Schema.Number,
          resetsAt: Schema.optional(Schema.String),
        }),
      ),
    }),
  ),
});
export type NeolixSyncUsageQuotaHistory = typeof NeolixSyncUsageQuotaHistory.Type;

export const NeolixSyncUsageDevice = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  days: Schema.Array(NeolixSyncUsageDay),
});
export type NeolixSyncUsageDevice = typeof NeolixSyncUsageDevice.Type;

export const NeolixSyncUsageQuotas = Schema.Struct({
  device: Schema.String,
  account: Schema.String,
  entries: Schema.Array(NeolixSyncUsageQuotaReading),
});
export type NeolixSyncUsageQuotas = typeof NeolixSyncUsageQuotas.Type;

export const NeolixSyncUsage = Schema.Struct({
  period: Schema.optional(Schema.String),
  since: Schema.optional(Schema.String),
  ...NeolixSyncUsageTotals,
  bucket: Schema.optional(Schema.String),
  series: Schema.optional(Schema.Array(NeolixSyncUsageSeriesPoint)),
  computers: Schema.optional(Schema.Array(NeolixSyncUsageComputer)),
  rows: Schema.optional(Schema.Array(NeolixSyncUsageRow)),
  total: Schema.optional(Schema.Number),
  offset: Schema.optional(Schema.Number),
  quotaHistory: Schema.optional(Schema.Array(NeolixSyncUsageQuotaHistory)),
  devices: Schema.Array(NeolixSyncUsageDevice),
  quotas: Schema.Array(NeolixSyncUsageQuotas),
  error: Schema.optional(Schema.String),
});
export type NeolixSyncUsage = typeof NeolixSyncUsage.Type;

export const NeolixBackupEntry = Schema.Struct({
  name: Schema.String,
  size: Schema.Number,
  at: Schema.String,
  auto: Schema.Boolean,
});
export type NeolixBackupEntry = typeof NeolixBackupEntry.Type;

export const NeolixBackupAuto = Schema.Struct({
  enabled: Schema.Boolean,
  everyHours: Schema.Number,
  keep: Schema.Number,
  keys: Schema.Boolean,
  signIns: Schema.optional(Schema.Boolean),
  dir: Schema.optional(Schema.String),
  folder: Schema.optional(Schema.String),
});
export type NeolixBackupAuto = typeof NeolixBackupAuto.Type;

export const NeolixBackupFile = Schema.Struct({
  fileName: Schema.String,
  mimeType: Schema.String,
  bytesBase64: Schema.String,
  error: Schema.NullOr(Schema.String),
});
export type NeolixBackupFile = typeof NeolixBackupFile.Type;

// ── Browser access page and Library GitHub token ───────────────────────────

/** Settings › Network › Browser access: where the daemon serves its page. */
export const NeolixWebPageMode = Schema.Union([
  Schema.Literal("off"),
  Schema.Literal("local"),
  Schema.Literal("lan"),
]);
export type NeolixWebPageMode = typeof NeolixWebPageMode.Type;

/** Settings › Network › Browser access: the page the daemon serves to a browser. */
export const NeolixWebPage = Schema.Struct({
  mode: NeolixWebPageMode,
  port: Schema.Number,
  /** Served over HTTPS when true. */
  tls: Schema.optional(Schema.Boolean),
  /** The address it listens on; absent when it serves nothing. */
  addr: Schema.optional(Schema.NullOr(Schema.String)),
  serving: Schema.Boolean,
  /** This computer's link, with the key; null until one is made. */
  link: Schema.NullOr(Schema.String),
  /** Other computers' links, on "lan" only. */
  network: Schema.Array(Schema.String),
  /** Why the page is not served where asked, if it is not. */
  error: Schema.NullOr(Schema.String),
});
export type NeolixWebPage = typeof NeolixWebPage.Type;

/** Whether the Library has a GitHub token; the token itself stays on the host. */
export const NeolixGithubTokenStatus = Schema.Struct({
  configured: Schema.Boolean,
  rejected: Schema.optional(Schema.Boolean),
});
export type NeolixGithubTokenStatus = typeof NeolixGithubTokenStatus.Type;

// ── Provider CLI installation ──────────────────────────────────────────────

/** One install line the daemon can run for an agent's CLI. */
export const NeolixAgentInstallCommand = Schema.Struct({
  id: Schema.String,
  via: Schema.Literals(["script", "powershell", "brew", "npm"]),
  command: Schema.String,
});
export type NeolixAgentInstallCommand = typeof NeolixAgentInstallCommand.Type;

export const NeolixAgentInstallEntry = Schema.Struct({
  provider: Schema.String,
  name: Schema.String,
  description: Schema.String,
  url: Schema.NullOr(Schema.String),
  commands: Schema.Array(NeolixAgentInstallCommand),
  installed: Schema.optional(Schema.Boolean),
});
export type NeolixAgentInstallEntry = typeof NeolixAgentInstallEntry.Type;

export const NeolixAgentInstallListResult = Schema.Struct({
  entries: Schema.Array(NeolixAgentInstallEntry),
});
export type NeolixAgentInstallListResult = typeof NeolixAgentInstallListResult.Type;

export const NeolixAgentInstallRunInput = Schema.Struct({
  provider: Schema.String,
  commandId: Schema.String,
});
export type NeolixAgentInstallRunInput = typeof NeolixAgentInstallRunInput.Type;

export const NeolixAgentInstallRunResult = Schema.Struct({
  provider: Schema.String,
  ok: Schema.Boolean,
  exitCode: Schema.NullOr(Schema.Number),
  output: Schema.String,
  error: Schema.NullOr(Schema.String),
});
export type NeolixAgentInstallRunResult = typeof NeolixAgentInstallRunResult.Type;
