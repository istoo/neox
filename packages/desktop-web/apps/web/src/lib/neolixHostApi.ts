// Typed calls into the bridge's Neox host surface (neolix.host.*). These settings belong to
// the daemon rather than the Synara server contract, so they do not go through NativeApi.
import {
  NEOLIX_HOST_WS_METHODS,
  type NeolixBackupAuto,
  type NeolixBackupEntry,
  type NeolixBackupFile,
  type NeolixCodexMoveResult,
  type NeolixExternalExport,
  type NeolixExternalSessionDelete,
  type NeolixExternalSessionPurge,
  type NeolixExternalSessionRestore,
  type NeolixExternalSessions,
  type NeolixExternalSessionSearch,
  type NeolixExternalTranscript,
  type NeolixHostStatus,
  type NeolixRelocateResult,
  type NeolixSessionReads,
  type NeolixSessionTerminals,
  type NeolixSpeechModel,
  type NeolixSyncConfig,
  type NeolixSyncRemoteVersion,
  type NeolixSyncStatus,
  type NeolixWebPage,
} from "@synara/contracts";

import { getConnectionClients } from "~/lib/hosts/connectionClients";

function hostRequest<T>(method: string, payload?: unknown, timeoutMs?: number): Promise<T> {
  return getConnectionClients().execution.request<T>(
    method,
    payload,
    timeoutMs === undefined ? undefined : { timeoutMs },
  );
}

/**
 * A named launch bundle stored host-wide in the daemon config. Field names mirror the
 * daemon's `AgentProfile`; `providerOptions` is this front end's per-provider launch
 * options, kept beside the shared fields rather than folded into `featureValues` so the
 * native clients' feature ids and these option keys never collide.
 */
export interface NeolixAgentProfileWire {
  readonly id: string;
  readonly name: string;
  readonly provider: string;
  readonly model?: string;
  readonly modeId?: string;
  readonly thinkingOptionId?: string;
  readonly featureValues?: Readonly<Record<string, unknown>>;
  readonly providerOptions?: Readonly<Record<string, unknown>>;
  readonly notes?: string;
  readonly icon?: string;
  readonly color?: string;
}

/** One speech site under `features.*` in the daemon config. */
export interface NeolixSpeechSiteWire {
  readonly provider?: string;
  readonly model?: string;
  readonly language?: string;
  readonly hasApiKey?: boolean;
  readonly baseUrl?: string;
  readonly voice?: string;
}

/** The subset of the daemon config the host settings read. Unknown fields pass through. */
export interface NeolixHostConfigWire {
  readonly network?: {
    readonly port?: number;
    readonly lan?: boolean;
    readonly listen?: string;
    readonly lanUrls?: ReadonlyArray<string>;
  };
  readonly hostnames?: true | ReadonlyArray<string>;
  readonly cors?: { readonly allowedOrigins?: ReadonlyArray<string> };
  readonly relay?: {
    readonly enabled?: boolean;
    readonly requireProtectedSecurity?: boolean;
  };
  readonly usage?: { readonly enabled?: boolean };
  readonly telemetry?: { readonly enabled?: boolean; readonly shareUsage?: boolean };
  readonly usageAlertPercent?: number;
  readonly balanceAlert?: number;
  readonly autoArchiveAfterMerge?: boolean;
  readonly enableTerminalAgentHooks?: boolean;
  readonly idleRuntimeCleanup?: boolean;
  readonly resumeOnStartup?: boolean;
  readonly resumePrompt?: string;
  readonly appendSystemPrompt?: string;
  readonly noWslAgents?: boolean;
  readonly sessionTerminal?: string;
  readonly terminalProfiles?: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly command: string;
    readonly args?: ReadonlyArray<string>;
    readonly icon?: string;
  }>;
  readonly agentProfiles?: ReadonlyArray<NeolixAgentProfileWire>;
  readonly metadataGeneration?: {
    readonly providers: ReadonlyArray<{ readonly provider: string; readonly model?: string }>;
  };
  readonly codexSessionReads?: {
    readonly asked?: boolean;
    readonly all?: boolean;
    readonly agents?: Readonly<Record<string, boolean>>;
  };
  readonly features?: {
    readonly dictation?: {
      readonly enabled: boolean;
      readonly stt?: NeolixSpeechSiteWire;
    };
    readonly voiceMode?: {
      readonly enabled: boolean;
      readonly stt?: NeolixSpeechSiteWire;
      readonly tts?: NeolixSpeechSiteWire;
    };
  };
  readonly envOverrides?: Readonly<Record<string, string>>;
}

export type NeolixHostConfigPatch = Record<string, unknown>;

export function getHostConfig(): Promise<{ config: NeolixHostConfigWire }> {
  return hostRequest(NEOLIX_HOST_WS_METHODS.getConfig);
}

export function patchHostConfig(
  patch: NeolixHostConfigPatch,
): Promise<{ config: NeolixHostConfigWire }> {
  return hostRequest(NEOLIX_HOST_WS_METHODS.patchConfig, { patch });
}

export function getHostStatus(): Promise<NeolixHostStatus> {
  return hostRequest(NEOLIX_HOST_WS_METHODS.getStatus);
}

/** The Mac terminals a resumed session can open in; supported is false off macOS. */
export function listSessionTerminals(): Promise<NeolixSessionTerminals> {
  return hostRequest(NEOLIX_HOST_WS_METHODS.listSessionTerminals);
}

/** The daemon's diagnostics text for Settings › Diagnostics. */
export function getHostDiagnostics(): Promise<{ diagnostic: string }> {
  return hostRequest(NEOLIX_HOST_WS_METHODS.getDiagnostics, {}, 60_000);
}

/** Opens the daemon's config folder or log on the computer the daemon runs on. */
export function revealHostPath(target: "config" | "log"): Promise<{
  ok: boolean;
  error?: string | null;
}> {
  return hostRequest(NEOLIX_HOST_WS_METHODS.revealPath, { target });
}

export function restartHost(killTerminals = false): Promise<{ requestId: string }> {
  return hostRequest(NEOLIX_HOST_WS_METHODS.restart, { killTerminals });
}

export function updateHost(): Promise<{
  success: boolean;
  error: string | null;
  newVersion: string | null;
}> {
  return hostRequest(NEOLIX_HOST_WS_METHODS.update, {}, 300_000);
}

export function listSpeechModels(): Promise<{ models: ReadonlyArray<NeolixSpeechModel> }> {
  return hostRequest(NEOLIX_HOST_WS_METHODS.listSpeechModels);
}

export function downloadSpeechModel(modelId: string): Promise<void> {
  return hostRequest(NEOLIX_HOST_WS_METHODS.downloadSpeechModel, { modelId }, 10 * 60_000);
}

export function deleteSpeechModel(modelId: string): Promise<void> {
  return hostRequest(NEOLIX_HOST_WS_METHODS.deleteSpeechModel, { modelId });
}

export function getSessionReads(): Promise<{ reads: NeolixSessionReads | null }> {
  return hostRequest(NEOLIX_HOST_WS_METHODS.getSessionReads);
}

export function setSessionReads(input: {
  all?: boolean;
  agents?: Record<string, boolean>;
}): Promise<{ reads: NeolixSessionReads | null }> {
  return hostRequest(NEOLIX_HOST_WS_METHODS.setSessionReads, input);
}

export function listExternalSessions(agent?: string): Promise<NeolixExternalSessions> {
  return hostRequest(NEOLIX_HOST_WS_METHODS.listExternalSessions, agent ? { agent } : {});
}

export function searchExternalSessions(
  agent: string,
  query: string,
): Promise<NeolixExternalSessionSearch> {
  return hostRequest(NEOLIX_HOST_WS_METHODS.searchExternalSessions, { agent, query });
}

export function openSessionInTerminal(
  agent: string,
  id: string,
): Promise<{ error: string | null }> {
  return hostRequest(NEOLIX_HOST_WS_METHODS.openSessionInTerminal, { agent, id });
}

export function deleteExternalSessions(
  agent: string,
  ids: string[],
): Promise<NeolixExternalSessionDelete> {
  return hostRequest(NEOLIX_HOST_WS_METHODS.deleteExternalSessions, { agent, ids }, 60_000);
}

export function restoreExternalSession(key: string): Promise<NeolixExternalSessionRestore> {
  return hostRequest(NEOLIX_HOST_WS_METHODS.restoreExternalSession, { key }, 60_000);
}

export function purgeExternalSessions(input: {
  keys?: string[];
  all?: boolean;
}): Promise<NeolixExternalSessionPurge> {
  return hostRequest(NEOLIX_HOST_WS_METHODS.purgeExternalSessions, input, 60_000);
}

export function getExternalSessionTranscript(input: {
  agent: string;
  id: string;
  offset?: number;
  limit?: number;
}): Promise<NeolixExternalTranscript> {
  return hostRequest(NEOLIX_HOST_WS_METHODS.getExternalSessionTranscript, input, 60_000);
}

export function exportExternalSession(agent: string, id: string): Promise<NeolixExternalExport> {
  return hostRequest(NEOLIX_HOST_WS_METHODS.exportExternalSession, { agent, id }, 120_000);
}

export function resumeExternalSession(input: {
  providerId: string;
  providerHandleId: string;
  cwd?: string;
}): Promise<{ agentId: string }> {
  return hostRequest(NEOLIX_HOST_WS_METHODS.resumeExternalSession, input, 60_000);
}

export function moveExternalCodexProvider(
  moves: Array<{ id: string; to: string }>,
): Promise<NeolixCodexMoveResult> {
  return hostRequest(NEOLIX_HOST_WS_METHODS.moveExternalCodexProvider, { moves }, 120_000);
}

export function relocateClaudeProject(input: {
  from: string;
  to: string;
  token?: string;
}): Promise<NeolixRelocateResult> {
  return hostRequest(NEOLIX_HOST_WS_METHODS.relocateClaudeProject, input, 120_000);
}

export function setConversationRecording(input: {
  on?: boolean;
  clear?: boolean;
}): Promise<{ recording: boolean; error: string | null }> {
  return hostRequest(NEOLIX_HOST_WS_METHODS.setConversationRecording, input, 30_000);
}

export function resolveProvider(input: {
  provider: string;
  instanceId?: string;
}): Promise<{ provider: string | null }> {
  return hostRequest(NEOLIX_HOST_WS_METHODS.resolveProvider, input);
}

/**
 * One provider's own self-check, run by the daemon. Providers it cannot start answer with
 * an error instead, which the caller shows in place of the report.
 */
export function getProviderDiagnostic(input: {
  provider: string;
  instanceId?: string;
}): Promise<{ provider: string; diagnostic: string }> {
  return hostRequest(NEOLIX_HOST_WS_METHODS.getProviderDiagnostic, input, 180_000);
}

export function getSyncConfig(): Promise<{ config: NeolixSyncConfig }> {
  return hostRequest(NEOLIX_HOST_WS_METHODS.getSyncConfig);
}

export function setSyncConfig(config: Record<string, unknown>): Promise<{
  config?: NeolixSyncConfig;
  error?: string;
}> {
  return hostRequest(NEOLIX_HOST_WS_METHODS.setSyncConfig, { config });
}

export function getSyncStatus(): Promise<{ status: NeolixSyncStatus }> {
  return hostRequest(NEOLIX_HOST_WS_METHODS.getSyncStatus);
}

export function listSyncRemote(): Promise<{
  versions: ReadonlyArray<NeolixSyncRemoteVersion>;
  error?: string;
}> {
  return hostRequest(NEOLIX_HOST_WS_METHODS.listSyncRemote);
}

type SyncAction = Promise<{ status?: NeolixSyncStatus; error?: string }>;

export function runSync(): SyncAction {
  return hostRequest(NEOLIX_HOST_WS_METHODS.runSync, {}, 10 * 60_000);
}

export function restoreSync(): SyncAction {
  return hostRequest(NEOLIX_HOST_WS_METHODS.restoreSync, {}, 10 * 60_000);
}

export function undoSync(): SyncAction {
  return hostRequest(NEOLIX_HOST_WS_METHODS.undoSync, {}, 10 * 60_000);
}

export function uploadSync(): SyncAction {
  return hostRequest(NEOLIX_HOST_WS_METHODS.uploadSync, {}, 10 * 60_000);
}

export function followSync(): SyncAction {
  return hostRequest(NEOLIX_HOST_WS_METHODS.followSync, {}, 10 * 60_000);
}

export function dismissSyncNotice(): Promise<{ error?: string }> {
  return hostRequest(NEOLIX_HOST_WS_METHODS.dismissSyncNotice);
}

export function listBackups(): Promise<{ backups: ReadonlyArray<NeolixBackupEntry> }> {
  return hostRequest(NEOLIX_HOST_WS_METHODS.listBackups);
}

export function getBackupAuto(): Promise<{ config: NeolixBackupAuto }> {
  return hostRequest(NEOLIX_HOST_WS_METHODS.getBackupAuto);
}

export function setBackupAuto(config: NeolixBackupAuto): Promise<{ config?: NeolixBackupAuto }> {
  return hostRequest(NEOLIX_HOST_WS_METHODS.setBackupAuto, { config });
}

export function exportBackup(input: {
  passphrase?: string;
  signIns?: boolean;
}): Promise<{ backup?: NeolixBackupEntry; error?: string }> {
  return hostRequest(NEOLIX_HOST_WS_METHODS.exportBackup, input, 10 * 60_000);
}

export function restoreBackup(input: {
  name: string;
  passphrase?: string;
  keys?: boolean;
  signIns?: boolean;
}): Promise<{ parts?: string[]; saved?: string; error?: string }> {
  return hostRequest(NEOLIX_HOST_WS_METHODS.restoreBackup, input, 10 * 60_000);
}

export function importBackup(input: {
  fileName: string;
  mimeType: string;
  bytesBase64: string;
  passphrase?: string;
  signIns?: boolean;
}): Promise<{ parts?: string[]; saved?: string; error?: string }> {
  return hostRequest(NEOLIX_HOST_WS_METHODS.importBackup, input, 10 * 60_000);
}

export function downloadBackup(name: string): Promise<NeolixBackupFile> {
  return hostRequest(NEOLIX_HOST_WS_METHODS.downloadBackup, { name }, 10 * 60_000);
}

export function deleteBackup(name: string): Promise<{ error?: string }> {
  return hostRequest(NEOLIX_HOST_WS_METHODS.deleteBackup, { name });
}

export function revealBackups(): Promise<{ ok: boolean; error?: string }> {
  return hostRequest(NEOLIX_HOST_WS_METHODS.revealBackups);
}

export type NeolixWebPagePatch = {
  mode?: NeolixWebPage["mode"];
  port?: number;
  newKey?: boolean;
};

export function getWebPage(): Promise<{ page: NeolixWebPage }> {
  return hostRequest(NEOLIX_HOST_WS_METHODS.getWebPage);
}

export function setWebPage(
  patch: NeolixWebPagePatch,
): Promise<{ page: NeolixWebPage | null; error?: string }> {
  return hostRequest(NEOLIX_HOST_WS_METHODS.setWebPage, patch);
}

export function getLibraryGithubToken(): Promise<{
  configured: boolean;
  rejected?: boolean;
}> {
  return hostRequest(NEOLIX_HOST_WS_METHODS.getLibraryGithubToken);
}

export function setLibraryGithubToken(token: string): Promise<{ configured: boolean }> {
  return hostRequest(NEOLIX_HOST_WS_METHODS.setLibraryGithubToken, { token });
}
