// Host-level settings the desktop-web settings pages need: the daemon's own config and
// lifecycle, speech models, provider session history, sync/backup, and gateway config. Every
// handler forwards to the Neox daemon; the bridge adds no policy of its own, except that a
// restart or update is only ever run when the client explicitly asks for it.
import {
  NEOLIX_HOST_WS_METHODS,
  WS_METHODS,
  WsRpcError,
  type NeolixBackupFile,
  type NeolixExternalSessions,
  type NeolixHostStatus,
  type NeolixSessionReads,
  type NeolixWebPage,
} from "@synara/contracts";
import { Effect } from "effect";

import type { BridgeModel } from "./model.ts";
import type { DaemonClient } from "./neolix.ts";
import { ProviderDirectory } from "./providers.ts";
import { bridgeError, rpcError } from "./rpcErrors.ts";
import type { AnyHandler } from "./stubs.ts";

function fromPromise<A>(_method: string, run: () => Promise<A>): Effect.Effect<A, WsRpcError> {
  return Effect.tryPromise({
    try: run,
    catch: (cause) => rpcError(cause),
  });
}

function requireNoError<T>(_method: string, payload: T & { error: string | null }): T {
  if (payload.error !== null) {
    throw bridgeError("host.request-failed", payload.error, { detail: payload.error });
  }
  return payload;
}

interface NeolixProjectRoot {
  readonly projectRootPath: string;
}

interface NeolixManagedWorktree {
  readonly worktreePath: string;
}

/**
 * Synara's worktree panel groups by the repository a worktree came from. Neox lists
 * worktrees per repository, so the bridge asks each registered project and keeps the root it
 * queried as `workspaceRoot`.
 */
async function listWorktrees(client: DaemonClient): Promise<{
  worktrees: Array<{ path: string; workspaceRoot: string }>;
}> {
  const projects = await client.listProjects();
  const roots = new Set<string>();
  for (const project of projects.projects as NeolixProjectRoot[]) {
    if (project.projectRootPath) roots.add(project.projectRootPath);
  }
  const worktrees: Array<{ path: string; workspaceRoot: string }> = [];
  for (const root of roots) {
    const listed = await client.getNeolixWorktreeList({ repoRoot: root });
    for (const worktree of listed.worktrees as NeolixManagedWorktree[]) {
      worktrees.push({ path: worktree.worktreePath, workspaceRoot: root });
    }
  }
  return { worktrees };
}

async function daemonStatus(client: DaemonClient): Promise<NeolixHostStatus> {
  try {
    const status = await client.getDaemonStatus();
    const home = status.configDir ?? null;
    const logPath = status.logPath ?? null;
    return {
      serverId: status.serverId,
      version: status.version ?? null,
      pid: status.pid,
      startedAt: status.startedAt ?? null,
      listen: status.listen ?? null,
      ...(status.container === undefined ? {} : { container: status.container }),
      ...(home === null ? {} : { home }),
      ...(logPath === null ? {} : { logPath }),
    };
  } catch (error) {
    // Older daemons answer no status RPC; the identity from server_info still lets the host
    // page show which daemon these settings belong to.
    const info = client.getLastServerInfoMessage();
    if (!info) throw error;
    return {
      serverId: info.serverId,
      version: info.version ?? null,
      pid: 0,
      startedAt: null,
      listen: null,
    };
  }
}

/** The shape every sync action answers with: the new status when the host has one. */
function syncStatusResult(payload: { status?: unknown; error?: string | undefined }) {
  return {
    ...(payload.status ? { status: payload.status } : {}),
    ...(payload.error ? { error: payload.error } : {}),
  };
}

export function makeHostHandlers(
  model: BridgeModel,
  options: {
    readonly daemonHttpBase?: string | undefined;
    /** Resolves a Synara provider instance to the daemon provider it runs. */
    readonly directory?: ProviderDirectory | undefined;
  } = {},
): Record<string, AnyHandler> {
  const client = model.client;
  const patchConfig = async (patch: unknown) => {
    const saved = await client.patchDaemonConfig(
      patch as Parameters<DaemonClient["patchDaemonConfig"]>[0],
    );
    return { config: saved.config as unknown };
  };

  return {
    [WS_METHODS.serverListWorktrees]: () =>
      fromPromise("server.listWorktrees", () => listWorktrees(client)),

    // The settings panel deletes a managed worktree through Synara's git route; Neox owns
    // that lifecycle on its worktree archive request, scoped to the checkout alone.
    [WS_METHODS.gitRemoveWorktree]: (payload) =>
      fromPromise("git.removeWorktree", async () => {
        const input = payload as { cwd: string; path: string };
        const result = await client.archiveNeolixWorktree({
          worktreePath: input.path,
          repoRoot: input.cwd,
          scope: "worktree",
        });
        if (result.error) {
          throw bridgeError("host.worktree-remove-failed", result.error.message, {
            detail: result.error.message,
          });
        }
      }),

    // Neox has no Screen-App local server discovery; the front end renders nothing for an
    // empty list, so its "local servers" entry stays hidden rather than lying.
    [WS_METHODS.serverListLocalServers]: () =>
      Effect.succeed({ generatedAt: new Date().toISOString(), servers: [] }),

    [NEOLIX_HOST_WS_METHODS.getConfig]: () =>
      fromPromise("neolix.host.getConfig", async () => ({
        config: (await client.getDaemonConfig()).config as unknown,
      })),

    [NEOLIX_HOST_WS_METHODS.patchConfig]: (payload) =>
      fromPromise("neolix.host.patchConfig", () =>
        patchConfig((payload as { patch: unknown }).patch),
      ),

    [NEOLIX_HOST_WS_METHODS.getStatus]: () =>
      fromPromise("neolix.host.getStatus", () => daemonStatus(client)),

    // The Mac terminals a resumed session can open in (myna's terminal_apps). Off macOS the
    // daemon answers supported: false, and the settings row hides itself.
    [NEOLIX_HOST_WS_METHODS.listSessionTerminals]: () =>
      fromPromise("neolix.host.listSessionTerminals", async () => {
        const result = await client.listSessionTerminals();
        return {
          supported: result.supported,
          apps: result.apps,
          defaultId: result.defaultId,
          error: result.error,
        };
      }),

    // Destructive by nature; the confirmation lives in the UI. The request id is all the
    // caller needs: the daemon drops the connection while it replaces itself.
    [NEOLIX_HOST_WS_METHODS.restart]: (payload) =>
      fromPromise("neolix.host.restart", async () => {
        const options = payload as { killTerminals?: boolean };
        const result = await client.restartServer("settings_daemon_restart", undefined, {
          killTerminals: options.killTerminals === true,
        });
        return { requestId: result.requestId };
      }),

    [NEOLIX_HOST_WS_METHODS.update]: () =>
      fromPromise("neolix.host.update", async () => {
        const result = await client.updateDaemon();
        return {
          success: result.success,
          error: result.error,
          newVersion: result.newVersion,
        };
      }),

    [NEOLIX_HOST_WS_METHODS.getDiagnostics]: () =>
      fromPromise("neolix.host.getDiagnostics", async () => {
        const result = await client.collectDiagnostics();
        return { diagnostic: result.diagnostic };
      }),

    // The daemon runs the provider's own self-check, which is what the desktop settings
    // panel shows in "Diagnostics". Only providers the daemon listed can answer it.
    [NEOLIX_HOST_WS_METHODS.getProviderDiagnostic]: (payload) =>
      fromPromise("neolix.host.getProviderDiagnostic", async () => {
        const input = payload as { provider: string; instanceId?: string };
        const neolixProvider = options.directory
          ? await options.directory.resolve(client, input)
          : null;
        if (!neolixProvider) {
          throw bridgeError(
            "host.provider-diagnostic-unavailable",
            "This provider is not available on this host.",
            { detail: input.provider },
          );
        }
        const result = await client.getProviderDiagnostic(neolixProvider as never);
        return { provider: input.provider, diagnostic: result.diagnostic };
      }),

    // Opens a folder or the log on the computer the daemon runs on, so this works
    // for a remote host as well; the daemon answers why it could not.
    [NEOLIX_HOST_WS_METHODS.revealPath]: (payload) =>
      fromPromise("neolix.host.revealPath", async () => {
        const target = (payload as { target: "config" | "log" }).target;
        const result = await client.revealDaemonPath(target);
        return { ok: result.ok, ...(result.error === undefined ? {} : { error: result.error }) };
      }),

    [NEOLIX_HOST_WS_METHODS.listSpeechModels]: () =>
      fromPromise("neolix.host.listSpeechModels", async () => ({
        models: await client.listLocalSpeechModels(),
      })),

    [NEOLIX_HOST_WS_METHODS.downloadSpeechModel]: (payload) =>
      fromPromise("neolix.host.downloadSpeechModel", async () => {
        await client.downloadLocalSpeechModel((payload as { modelId: string }).modelId);
      }),

    [NEOLIX_HOST_WS_METHODS.deleteSpeechModel]: (payload) =>
      fromPromise("neolix.host.deleteSpeechModel", async () => {
        await client.deleteLocalSpeechModel((payload as { modelId: string }).modelId);
      }),

    [NEOLIX_HOST_WS_METHODS.getSessionReads]: () =>
      fromPromise("neolix.host.getSessionReads", async () => {
        const result = requireNoError(
          "neolix.host.getSessionReads",
          await client.getSessionReads(),
        );
        return { reads: result.snapshot as NeolixSessionReads | null };
      }),

    [NEOLIX_HOST_WS_METHODS.setSessionReads]: (payload) =>
      fromPromise("neolix.host.setSessionReads", async () => {
        const input = payload as { all?: boolean; agents?: Record<string, boolean> };
        const result = requireNoError(
          "neolix.host.setSessionReads",
          await client.setSessionReads(input),
        );
        return { reads: result.snapshot as NeolixSessionReads | null };
      }),

    [NEOLIX_HOST_WS_METHODS.listExternalSessions]: (payload) =>
      fromPromise("neolix.host.listExternalSessions", async () => {
        const result = await client.listExternalSessions((payload as { agent?: string }).agent);
        return {
          agents: result.agents,
          agent: result.agent,
          sessions: result.sessions,
          trash: result.trash,
          trashDir: result.trashDir,
          home: result.home,
          recording: result.recording,
          recorded: result.recorded,
          error: result.error,
        } as NeolixExternalSessions;
      }),

    [NEOLIX_HOST_WS_METHODS.searchExternalSessions]: (payload) =>
      fromPromise("neolix.host.searchExternalSessions", async () => {
        const input = payload as { agent: string; query: string };
        const result = await client.searchExternalSessions(input.agent, input.query);
        return {
          hits: result.hits,
          searched: result.searched,
          total: result.total,
          cut: result.cut,
          error: result.error,
        };
      }),

    [NEOLIX_HOST_WS_METHODS.openSessionInTerminal]: (payload) =>
      fromPromise("neolix.host.openSessionInTerminal", async () => {
        const input = payload as { agent: string; id: string };
        const result = await client.openSessionInTerminal(input);
        return { error: result.error };
      }),

    [NEOLIX_HOST_WS_METHODS.deleteExternalSessions]: (payload) =>
      fromPromise("neolix.host.deleteExternalSessions", async () => {
        const input = payload as { agent: string; ids: string[] };
        const result = await client.deleteExternalSessions(input.agent, input.ids);
        return { deleted: result.deleted, refused: result.refused, error: result.error };
      }),

    [NEOLIX_HOST_WS_METHODS.restoreExternalSession]: (payload) =>
      fromPromise("neolix.host.restoreExternalSession", async () => {
        const result = await client.restoreExternalSession((payload as { key: string }).key);
        return {
          agent: result.agent,
          id: result.id,
          title: result.title,
          error: result.error,
        };
      }),

    [NEOLIX_HOST_WS_METHODS.purgeExternalSessions]: (payload) =>
      fromPromise("neolix.host.purgeExternalSessions", async () => {
        const result = await client.purgeExternalSessions(
          payload as { keys?: string[]; all?: boolean },
        );
        return { purged: result.purged, refused: result.refused, error: result.error };
      }),

    [NEOLIX_HOST_WS_METHODS.getExternalSessionTranscript]: (payload) =>
      fromPromise("neolix.host.getExternalSessionTranscript", async () => {
        const input = payload as {
          agent: string;
          id: string;
          offset?: number;
          limit?: number;
        };
        const result = await client.getExternalSessionTranscript(input);
        return {
          parts: result.parts,
          total: result.total,
          cut: result.cut,
          source: result.source,
          error: result.error,
        };
      }),

    [NEOLIX_HOST_WS_METHODS.exportExternalSession]: (payload) =>
      fromPromise("neolix.host.exportExternalSession", async () => {
        const input = payload as { agent: string; id: string };
        const result = await client.exportExternalSession(input.agent, input.id);
        return {
          fileName: result.fileName,
          markdown: result.markdown,
          error: result.error,
        };
      }),

    [NEOLIX_HOST_WS_METHODS.resumeExternalSession]: (payload) =>
      fromPromise("neolix.host.resumeExternalSession", async () => {
        const input = payload as { providerId: string; providerHandleId: string; cwd?: string };
        const agent = await client.importAgent({
          providerId: input.providerId,
          providerHandleId: input.providerHandleId,
          ...(input.cwd ? { cwd: input.cwd } : {}),
        });
        return { agentId: agent.id };
      }),

    [NEOLIX_HOST_WS_METHODS.moveExternalCodexProvider]: (payload) =>
      fromPromise("neolix.host.moveExternalCodexProvider", async () => {
        const result = await client.moveExternalCodexProvider(
          (payload as { moves: { id: string; to: string }[] }).moves,
        );
        return { moved: result.moved, refused: result.refused, error: result.error };
      }),

    [NEOLIX_HOST_WS_METHODS.relocateClaudeProject]: (payload) =>
      fromPromise("neolix.host.relocateClaudeProject", async () => {
        const input = payload as { from: string; to: string; token?: string };
        const result = await client.relocateClaudeProject(input);
        return {
          preview: result.preview,
          token: result.token,
          backup: result.backup,
          error: result.error,
        };
      }),

    [NEOLIX_HOST_WS_METHODS.setConversationRecording]: (payload) =>
      fromPromise("neolix.host.setConversationRecording", async () => {
        const result = await client.setGatewayConversationRecording(
          payload as { on?: boolean; clear?: boolean },
        );
        return { recording: result.recording, error: result.error };
      }),

    [NEOLIX_HOST_WS_METHODS.resolveProvider]: (payload) =>
      fromPromise("neolix.host.resolveProvider", async () => {
        const input = payload as { provider: string; instanceId?: string };
        const { providers } = await client.listAvailableProviders();
        const directory = new ProviderDirectory();
        directory.update(
          (providers as ReadonlyArray<{ readonly provider: string }>).map(
            (entry) => entry.provider,
          ),
        );
        return { provider: directory.neolixProviderFor(input) };
      }),

    [NEOLIX_HOST_WS_METHODS.getSyncConfig]: () =>
      fromPromise("neolix.host.getSyncConfig", async () => ({
        config: (await client.getSyncConfig()).config,
      })),

    [NEOLIX_HOST_WS_METHODS.setSyncConfig]: (payload) =>
      fromPromise("neolix.host.setSyncConfig", async () => {
        const result = await client.setSyncConfig(
          (payload as { config: Parameters<DaemonClient["setSyncConfig"]>[0] }).config,
        );
        return {
          ...(result.config ? { config: result.config } : {}),
          ...(result.error ? { error: result.error } : {}),
        };
      }),

    [NEOLIX_HOST_WS_METHODS.getSyncStatus]: () =>
      fromPromise("neolix.host.getSyncStatus", async () => ({
        status: (await client.getSyncStatus()).status,
      })),

    [NEOLIX_HOST_WS_METHODS.listSyncRemote]: () =>
      fromPromise("neolix.host.listSyncRemote", async () => {
        const result = await client.listSyncRemote();
        return {
          versions: result.versions,
          ...(result.error ? { error: result.error } : {}),
        };
      }),

    [NEOLIX_HOST_WS_METHODS.runSync]: () =>
      fromPromise("neolix.host.runSync", async () => syncStatusResult(await client.runSync())),

    [NEOLIX_HOST_WS_METHODS.restoreSync]: () =>
      fromPromise("neolix.host.restoreSync", async () =>
        syncStatusResult(await client.restoreSync()),
      ),

    [NEOLIX_HOST_WS_METHODS.undoSync]: () =>
      fromPromise("neolix.host.undoSync", async () => syncStatusResult(await client.undoSync())),

    [NEOLIX_HOST_WS_METHODS.uploadSync]: () =>
      fromPromise("neolix.host.uploadSync", async () =>
        syncStatusResult(await client.uploadSync()),
      ),

    [NEOLIX_HOST_WS_METHODS.followSync]: () =>
      fromPromise("neolix.host.followSync", async () =>
        syncStatusResult(await client.followSync()),
      ),

    [NEOLIX_HOST_WS_METHODS.dismissSyncNotice]: () =>
      fromPromise("neolix.host.dismissSyncNotice", async () => {
        const result = await client.dismissSyncNotice();
        return result.error ? { error: result.error } : {};
      }),

    [NEOLIX_HOST_WS_METHODS.listBackups]: () =>
      fromPromise("neolix.host.listBackups", async () => ({
        backups: (await client.listBackups()).backups,
      })),

    [NEOLIX_HOST_WS_METHODS.getBackupAuto]: () =>
      fromPromise("neolix.host.getBackupAuto", async () => ({
        config: (await client.getBackupAuto()).config,
      })),

    [NEOLIX_HOST_WS_METHODS.setBackupAuto]: (payload) =>
      fromPromise("neolix.host.setBackupAuto", async () => {
        const result = await client.setBackupAuto(
          (payload as { config: Parameters<DaemonClient["setBackupAuto"]>[0] }).config,
        );
        return result.config ? { config: result.config } : {};
      }),

    [NEOLIX_HOST_WS_METHODS.exportBackup]: (payload) =>
      fromPromise("neolix.host.exportBackup", async () => {
        const input = payload as { passphrase?: string; signIns?: boolean };
        const result = await client.exportBackup({
          ...(input.passphrase ? { passphrase: input.passphrase } : {}),
          ...(input.signIns === undefined ? {} : { signIns: input.signIns }),
        });
        return {
          ...(result.backup ? { backup: result.backup } : {}),
          ...(result.error ? { error: result.error } : {}),
        };
      }),

    [NEOLIX_HOST_WS_METHODS.restoreBackup]: (payload) =>
      fromPromise("neolix.host.restoreBackup", async () => {
        const input = payload as {
          name: string;
          passphrase?: string;
          keys?: boolean;
          signIns?: boolean;
        };
        const result = await client.restoreBackup(input);
        return {
          ...(result.parts ? { parts: result.parts } : {}),
          ...(result.saved ? { saved: result.saved } : {}),
          ...(result.error ? { error: result.error } : {}),
        };
      }),

    // The browser cannot reach the daemon's download route, so the bridge uploads the picked
    // file through the daemon's own attachment route and imports the id it returns.
    [NEOLIX_HOST_WS_METHODS.importBackup]: (payload) =>
      fromPromise("neolix.host.importBackup", async () => {
        const input = payload as {
          fileName: string;
          mimeType: string;
          bytesBase64: string;
          passphrase?: string;
          signIns?: boolean;
        };
        const uploaded = await client.uploadFile({
          fileName: input.fileName,
          mimeType: input.mimeType,
          bytes: new Uint8Array(Buffer.from(input.bytesBase64, "base64")),
        });
        if (!uploaded.file) {
          throw bridgeError(
            "host.backup-upload-failed",
            uploaded.error ?? "The backup upload failed.",
            uploaded.error ? { detail: uploaded.error } : undefined,
          );
        }
        const result = await client.importBackup({
          id: uploaded.file.id,
          ...(input.passphrase ? { passphrase: input.passphrase } : {}),
          ...(input.signIns === undefined ? {} : { signIns: input.signIns }),
        });
        return {
          ...(result.parts ? { parts: result.parts } : {}),
          ...(result.saved ? { saved: result.saved } : {}),
          ...(result.error ? { error: result.error } : {}),
        };
      }),

    // The daemon issues a one-shot token for its own backups folder, and its
    // `/api/files/download` route consumes it. Using that path keeps the bridge out of the
    // daemon's filesystem: it works for a daemon on another machine as well as this one.
    [NEOLIX_HOST_WS_METHODS.downloadBackup]: (payload) =>
      fromPromise<NeolixBackupFile>("neolix.host.downloadBackup", async () => {
        const name = (payload as { name: string }).name;
        const base = options.daemonHttpBase;
        if (!base) {
          return {
            fileName: "",
            mimeType: "",
            bytesBase64: "",
            error: "This host is not reachable over HTTP, so its backups cannot be downloaded.",
          };
        }
        const issued = await client.requestBackupDownloadToken(name);
        if (!issued.token) {
          return {
            fileName: name,
            mimeType: "application/octet-stream",
            bytesBase64: "",
            error: issued.error ?? "The host refused to issue a download token.",
          };
        }
        const url = new URL("/api/files/download", base);
        url.searchParams.set("token", issued.token);
        let response: Response;
        try {
          // The token is the whole capability; the route is bearer-free by design.
          response = await fetch(url, { cache: "no-store" });
        } catch (cause) {
          return {
            fileName: name,
            mimeType: "application/octet-stream",
            bytesBase64: "",
            error: cause instanceof Error ? cause.message : String(cause),
          };
        }
        if (!response.ok) {
          return {
            fileName: name,
            mimeType: "application/octet-stream",
            bytesBase64: "",
            error: `The host answered the download with HTTP ${response.status}.`,
          };
        }
        const bytes = Buffer.from(await response.arrayBuffer());
        return {
          fileName: issued.fileName ?? name,
          mimeType: issued.mimeType ?? "application/octet-stream",
          bytesBase64: bytes.toString("base64"),
          error: null,
        };
      }),

    [NEOLIX_HOST_WS_METHODS.deleteBackup]: (payload) =>
      fromPromise("neolix.host.deleteBackup", async () => {
        const result = await client.deleteBackup((payload as { name: string }).name);
        return result.error ? { error: result.error } : {};
      }),

    [NEOLIX_HOST_WS_METHODS.revealBackups]: () =>
      fromPromise("neolix.host.revealBackups", async () => {
        const result = await client.revealBackups();
        return { ok: result.ok, ...(result.error ? { error: result.error } : {}) };
      }),

    // Settings › Network › Browser access: the page this daemon serves to a browser. The
    // daemon owns the page's mode, port and key; the bridge forwards them verbatim.
    [NEOLIX_HOST_WS_METHODS.getWebPage]: () =>
      fromPromise("neolix.host.getWebPage", async () => ({
        page: (await client.getWebPage()) as NeolixWebPage,
      })),

    [NEOLIX_HOST_WS_METHODS.setWebPage]: (payload) =>
      fromPromise("neolix.host.setWebPage", async () => {
        const input = payload as {
          mode?: "off" | "local" | "lan";
          port?: number;
          newKey?: boolean;
        };
        const result = await client.setWebPage(input);
        return {
          page: (result.page ?? null) as NeolixWebPage | null,
          ...(result.error === undefined ? {} : { error: result.error }),
        };
      }),

    // The token stays on the host; the settings row only learns whether one is set.
    [NEOLIX_HOST_WS_METHODS.getLibraryGithubToken]: () =>
      fromPromise("neolix.host.getLibraryGithubToken", async () => {
        const result = await client.getLibraryGithubToken();
        return {
          configured: result.configured,
          ...(result.rejected === undefined ? {} : { rejected: result.rejected }),
        };
      }),

    [NEOLIX_HOST_WS_METHODS.setLibraryGithubToken]: (payload) =>
      fromPromise("neolix.host.setLibraryGithubToken", async () => {
        const result = await client.setLibraryGithubToken((payload as { token: string }).token);
        return { configured: result.configured };
      }),
  };
}
