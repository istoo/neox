import {
  NEOLIX_HOST_WS_METHODS,
  WS_METHODS,
  WsRpcError,
  type NeolixHostFeatures,
  type NeolixHostUpdateProgress,
} from "@synara/contracts";
import { Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";

import type { BridgeModel } from "./model.ts";
import { makeHostHandlers } from "./hostRpc.ts";
import { ProviderDirectory } from "./providers.ts";
import type { AnyHandler } from "./stubs.ts";

function run<A>(handler: AnyHandler | undefined, payload: unknown = {}): Promise<A> {
  if (!handler) throw new Error("handler is missing");
  return Effect.runPromise(handler(payload, {}) as Effect.Effect<A, never>);
}

function makeHarness() {
  const calls: Array<[string, unknown]> = [];
  const rawMessageListeners = new Set<(message: unknown) => void>();
  const config = {
    autoArchiveAfterMerge: false,
    enableTerminalAgentHooks: true,
    metadataGeneration: { providers: [] },
  };
  const client = {
    listProjects: async () => ({
      projects: [
        { projectId: "prj_1", projectDisplayName: "one", projectRootPath: "/repo/one" },
        { projectId: "prj_2", projectDisplayName: "two", projectRootPath: "/repo/two" },
      ],
    }),
    getNeolixWorktreeList: async (input: { repoRoot: string }) => {
      calls.push(["worktrees", input]);
      return {
        worktrees:
          input.repoRoot === "/repo/one"
            ? [{ worktreePath: "/work/one-a", createdAt: "2026-01-01" }]
            : [],
        error: null,
      };
    },
    archiveNeolixWorktree: async (input: unknown) => {
      calls.push(["archive", input]);
      return { success: true, error: null, requestId: "r0" };
    },
    getDaemonConfig: async () => ({ requestId: "r1", config }),
    patchDaemonConfig: async (patch: unknown) => {
      calls.push(["patch", patch]);
      return { requestId: "r2", config: { ...config, ...(patch as object) } };
    },
    getDaemonStatus: async () => ({
      requestId: "r3",
      serverId: "srv-1",
      version: "0.15.0",
      pid: 42,
      nodePath: "/node",
      startedAt: "2026-01-01T00:00:00.000Z",
      listen: "127.0.0.1:6768",
      container: false,
      publicUrl: "https://neox.example.com",
      configDir: "/home/neolix",
      logPath: "/home/neolix/daemon.log",
    }),
    collectDiagnostics: async () => ({ diagnostic: "daemon report" }),
    revealDaemonPath: async (target: string) => {
      calls.push(["reveal", target]);
      return { ok: true };
    },
    getLastServerInfoMessage: () => undefined,
    subscribeRawMessages: (handler: (message: unknown) => void) => {
      rawMessageListeners.add(handler);
      return () => rawMessageListeners.delete(handler);
    },
    emitRawMessage: (message: unknown) => {
      for (const handler of rawMessageListeners) handler(message);
    },
    restartServer: async (reason: string, _requestId: unknown, options: unknown) => {
      calls.push(["restart", { reason, options }]);
      return { requestId: "r4" };
    },
    updateDaemon: async () => ({
      requestId: "r5",
      success: true,
      error: null,
      previousVersion: "0.15.0",
      newVersion: "0.16.0",
    }),
    listLocalSpeechModels: async () => [
      {
        id: "whisper",
        kind: "stt",
        label: "Whisper",
        description: "local",
        languages: ["en"],
        downloadSizeBytes: 10,
        isDefault: true,
        inUse: false,
        status: "installed",
      },
    ],
    downloadLocalSpeechModel: async (modelId: string) => {
      calls.push(["download", modelId]);
    },
    deleteLocalSpeechModel: async (modelId: string) => {
      calls.push(["delete", modelId]);
    },
    getSessionReads: async () => ({
      requestId: "r6",
      snapshot: { asked: true, all: false, found: [{ agent: "codex", name: "Codex", on: true }] },
      error: null,
    }),
    setSessionReads: async (input: unknown) => {
      calls.push(["reads", input]);
      return { requestId: "r7", snapshot: { asked: true, all: true, found: [] }, error: null };
    },
    listExternalSessions: async (agent?: string, options?: { fast?: boolean }) => {
      calls.push(["sessions", { agent, options }]);
      return {
        agents: [{ agent: "codex", name: "Codex" }],
        agent: agent ?? "codex",
        sessions: [
          {
            id: "s1",
            agent: "codex",
            cwd: "/repo",
            title: "A session",
            start: "2026-01-01T00:00:00.000Z",
            last: "2026-01-02T00:00:00.000Z",
            messages: 3,
            size: 100,
            tokens: {},
            models: [],
            cost: 0,
            priced: false,
            resume: "codex resume s1",
            path: "/home/.codex/s1",
            deletable: true,
          },
        ],
        trash: [],
        trashDir: "/home/.trash",
        home: "/home",
        recording: false,
        recorded: false,
        ...(options?.fast === true ? { partial: true } : {}),
        error: null,
      };
    },
    searchExternalSessions: async () => ({
      requestId: "r8",
      hits: [{ id: "s1", role: "user", kind: "text", before: "", match: "needle", after: "" }],
      searched: 1,
      total: 1,
      cut: false,
      error: null,
    }),
    openSessionInTerminal: async (input: unknown) => {
      calls.push(["open", input]);
      return { requestId: "r9", opened: true, error: null };
    },
    getSyncConfig: async () => ({ requestId: "r10", config: { kind: "none" } }),
    setSyncConfig: async (config: unknown) => {
      calls.push(["sync-config", config]);
      return { requestId: "r11", config };
    },
    getSyncStatus: async () => ({ requestId: "r12", status: { state: "idle" } }),
    runSync: async () => ({ requestId: "r13", status: { state: "done" } }),
    restoreSync: async () => ({ requestId: "r14", status: { state: "done" } }),
    listBackups: async () => ({ requestId: "r15", backups: [] }),
    getBackupAuto: async () => ({ requestId: "r16", config: { enabled: false } }),
    setBackupAuto: async (config: unknown) => {
      calls.push(["backup-auto", config]);
      return { requestId: "r17", config };
    },
    getWebPage: async () => ({
      requestId: "r22",
      mode: "local" as const,
      port: 6769,
      serving: true,
      link: "http://127.0.0.1:6769/?k=test",
      network: [],
      error: null,
    }),
    setWebPage: async (patch: unknown) => {
      calls.push(["web-page", patch]);
      return {
        requestId: "r23",
        page: {
          mode: "lan" as const,
          port: 6769,
          serving: true,
          link: "http://127.0.0.1:6769/?k=test",
          network: ["http://192.0.2.10:6769/?k=test"],
          error: null,
        },
      };
    },
    getLibraryGithubToken: async () => ({
      requestId: "r24",
      configured: true,
      rejected: false,
    }),
    setLibraryGithubToken: async (token: string) => {
      calls.push(["github-token", token]);
      return { requestId: "r25", configured: token.length > 0 };
    },
    deleteExternalSessions: async (agent: string, ids: string[]) => {
      calls.push(["session-delete", { agent, ids }]);
      return { requestId: "r20", deleted: ids, refused: [], error: null };
    },
    restoreExternalSession: async (key: string) => {
      calls.push(["session-restore", key]);
      return { requestId: "r21", agent: "codex", id: "s1", title: "A session", error: null };
    },
    purgeExternalSessions: async (input: unknown) => {
      calls.push(["session-purge", input]);
      return { requestId: "r22", purged: ["s1"], refused: [], error: null };
    },
    getExternalSessionTranscript: async (input: unknown) => {
      calls.push(["session-transcript", input]);
      return {
        requestId: "r23",
        parts: [{ role: "user", kind: "text", text: "hello" }],
        total: 1,
        cut: false,
        source: "file",
        error: null,
      };
    },
    exportExternalSession: async (agent: string, id: string) => {
      calls.push(["session-export", { agent, id }]);
      return { requestId: "r24", fileName: "s1.md", markdown: "# s1", error: null };
    },
    importAgent: async (input: unknown) => {
      calls.push(["session-resume", input]);
      return { id: "agent-1" };
    },
    moveExternalCodexProvider: async (moves: unknown) => {
      calls.push(["codex-move", moves]);
      return { requestId: "r25", moved: [], refused: [], error: null };
    },
    relocateClaudeProject: async (input: unknown) => {
      calls.push(["relocate", input]);
      return { requestId: "r26", preview: null, token: null, backup: null, error: null };
    },
    setGatewayConversationRecording: async (input: unknown) => {
      calls.push(["recording", input]);
      return { requestId: "r27", recording: true, error: null };
    },
    listAvailableProviders: async () => ({
      providers: [
        { provider: "claude", available: true, error: null },
        { provider: "codex", available: true, error: null },
        { provider: "neolix-gateway", available: true, error: null },
      ],
    }),
    listSyncRemote: async () => ({
      requestId: "r28",
      versions: [{ part: "settings", takenAt: "2026-01-01", device: "a", files: 2 }],
      error: undefined,
    }),
    undoSync: async () => ({ requestId: "r29", status: { enabled: true } }),
    uploadSync: async () => ({ requestId: "r30", status: { enabled: true } }),
    followSync: async () => ({ requestId: "r31", status: { enabled: true } }),
    dismissSyncNotice: async () => ({ requestId: "r32" }),
    exportBackup: async (input: unknown) => {
      calls.push(["backup-export", input]);
      return {
        requestId: "r33",
        backup: { name: "b.tar", size: 10, at: "2026-01-01", auto: false },
      };
    },
    restoreBackup: async (input: unknown) => {
      calls.push(["backup-restore", input]);
      return { requestId: "r34", parts: ["settings"] };
    },
    importBackup: async (input: unknown) => {
      calls.push(["backup-import", input]);
      return { requestId: "r35", parts: ["settings"] };
    },
    uploadFile: async (input: { fileName: string }) => {
      calls.push(["upload", input.fileName]);
      return { requestId: "r36", file: { id: "file-1" }, error: null };
    },
    deleteBackup: async (name: string) => {
      calls.push(["backup-delete", name]);
      return { requestId: "r37" };
    },
    revealBackups: async () => ({ requestId: "r38", ok: true }),
    getProviderDiagnostic: async (provider: string) => {
      calls.push(["diagnostic", provider]);
      return {
        requestId: "r39",
        provider,
        diagnostic: `claude 2.1.0\nbinary: /usr/local/bin/claude`,
      };
    },
  };
  const model = { client } as unknown as BridgeModel;
  return { handlers: makeHostHandlers(model), calls, model };
}

describe("hostRpc config", () => {
  it("forwards the daemon config verbatim", async () => {
    const { handlers } = makeHarness();
    const result = await run<{ config: { enableTerminalAgentHooks: boolean } }>(
      handlers[NEOLIX_HOST_WS_METHODS.getConfig],
    );
    expect(result.config.enableTerminalAgentHooks).toBe(true);
  });

  it("patches only the requested fields", async () => {
    const { handlers, calls } = makeHarness();
    const result = await run<{ config: { autoArchiveAfterMerge: boolean } }>(
      handlers[NEOLIX_HOST_WS_METHODS.patchConfig],
      { patch: { autoArchiveAfterMerge: true } },
    );
    expect(calls).toContainEqual(["patch", { autoArchiveAfterMerge: true }]);
    expect(result.config.autoArchiveAfterMerge).toBe(true);
  });
});

describe("hostRpc lifecycle", () => {
  it("reports the daemon identity", async () => {
    const { handlers } = makeHarness();
    const result = await run<{
      serverId: string;
      pid: number;
      listen: string | null;
      publicUrl?: string | null;
      home?: string | null;
      logPath?: string | null;
    }>(handlers[NEOLIX_HOST_WS_METHODS.getStatus]);
    expect(result).toMatchObject({
      serverId: "srv-1",
      pid: 42,
      listen: "127.0.0.1:6768",
      publicUrl: "https://neox.example.com",
      home: "/home/neolix",
      logPath: "/home/neolix/daemon.log",
    });
  });

  it("serves the generated third-party license list", async () => {
    const { handlers } = makeHarness();
    const result = await run<{ notices: string }>(
      handlers[NEOLIX_HOST_WS_METHODS.getThirdPartyNotices],
    );
    expect(result.notices).toContain("Neox third-party notices");
    expect(result.notices).toContain("third-party packages");
    // The web app ships its own frontend dependencies; About must list them too.
    expect(result.notices).toMatch(/^mermaid \d/m);
    expect(result.notices).toMatch(/^monaco-editor \d/m);
  });

  it("forwards the daemon's diagnostics report", async () => {
    const { handlers } = makeHarness();
    await expect(run(handlers[NEOLIX_HOST_WS_METHODS.getDiagnostics])).resolves.toEqual({
      diagnostic: "daemon report",
    });
  });

  it("opens the daemon's own config folder or log", async () => {
    const { handlers, calls } = makeHarness();
    await expect(
      run(handlers[NEOLIX_HOST_WS_METHODS.revealPath], { target: "log" }),
    ).resolves.toEqual({ ok: true });
    expect(calls).toContainEqual(["reveal", "log"]);
  });

  it("only restarts when asked, and forwards the terminal choice", async () => {
    const { handlers, calls } = makeHarness();
    await run(handlers[NEOLIX_HOST_WS_METHODS.restart], { killTerminals: true });
    expect(calls).toContainEqual([
      "restart",
      {
        reason: "settings_daemon_restart",
        options: { killTerminals: true },
      },
    ]);
    expect(calls.filter(([name]) => name === "restart")).toHaveLength(1);
  });
});

describe("hostRpc worktrees", () => {
  it("keeps the repository root each worktree was listed under", async () => {
    const { handlers } = makeHarness();
    const result = await run<{ worktrees: Array<{ path: string; workspaceRoot: string }> }>(
      handlers[WS_METHODS.serverListWorktrees],
    );
    expect(result.worktrees).toEqual([{ path: "/work/one-a", workspaceRoot: "/repo/one" }]);
  });

  it("removes a managed worktree through the Neox archive request", async () => {
    const { handlers, calls } = makeHarness();
    await run(handlers[WS_METHODS.gitRemoveWorktree], {
      cwd: "/repo/one",
      path: "/work/one-a",
      force: true,
    });
    expect(calls).toContainEqual([
      "archive",
      {
        worktreePath: "/work/one-a",
        repoRoot: "/repo/one",
        scope: "worktree",
      },
    ]);
  });

  it("reports no local servers because Neox cannot enumerate them", async () => {
    const { handlers } = makeHarness();
    const result = await run<{ servers: unknown[] }>(handlers[WS_METHODS.serverListLocalServers]);
    expect(result.servers).toEqual([]);
  });
});

describe("hostRpc speech and sessions", () => {
  it("lists speech models and forwards downloads", async () => {
    const { handlers, calls } = makeHarness();
    const listed = await run<{ models: Array<{ id: string }> }>(
      handlers[NEOLIX_HOST_WS_METHODS.listSpeechModels],
    );
    expect(listed.models.map((model) => model.id)).toEqual(["whisper"]);
    await run(handlers[NEOLIX_HOST_WS_METHODS.downloadSpeechModel], { modelId: "whisper" });
    expect(calls).toContainEqual(["download", "whisper"]);
  });

  it("returns session reads and forwards changes", async () => {
    const { handlers, calls } = makeHarness();
    const reads = await run<{ reads: { all: boolean } }>(
      handlers[NEOLIX_HOST_WS_METHODS.getSessionReads],
    );
    expect(reads.reads.all).toBe(false);
    await run(handlers[NEOLIX_HOST_WS_METHODS.setSessionReads], { all: true });
    expect(calls).toContainEqual(["reads", { all: true }]);
  });

  it("surfaces a daemon error as an RPC failure", async () => {
    const { handlers } = makeHarness();
    const failing = makeHostHandlers({
      client: {
        getSessionReads: async () => ({
          requestId: "r",
          snapshot: null,
          error: "not supported",
        }),
      },
    } as unknown as BridgeModel);
    expect(handlers[NEOLIX_HOST_WS_METHODS.getSessionReads]).toBeDefined();
    await expect(run(failing[NEOLIX_HOST_WS_METHODS.getSessionReads])).rejects.toMatchObject({
      message: expect.stringContaining("not supported"),
    });
  });

  it("lists external sessions and opens one in a terminal", async () => {
    const { handlers, calls } = makeHarness();
    const listed = await run<{ sessions: Array<{ id: string }>; error: string | null }>(
      handlers[NEOLIX_HOST_WS_METHODS.listExternalSessions],
      {},
    );
    expect(listed.sessions.map((session) => session.id)).toEqual(["s1"]);
    expect(listed.error).toBeNull();
    await run(handlers[NEOLIX_HOST_WS_METHODS.openSessionInTerminal], {
      agent: "codex",
      id: "s1",
    });
    expect(calls).toContainEqual(["open", { agent: "codex", id: "s1" }]);
  });

  it("asks a daemon with the progress capability for the header-first list", async () => {
    const { handlers, calls, model } = makeHarness();
    (model.client as unknown as { getLastServerInfoMessage: unknown }).getLastServerInfoMessage =
      () => ({ features: { externalSessionsProgress: true } });
    const listed = await run<{ partial?: boolean }>(
      handlers[NEOLIX_HOST_WS_METHODS.listExternalSessions],
      { agent: "codex", fast: true },
    );
    expect(listed.partial).toBe(true);
    expect(calls).toContainEqual(["sessions", { agent: "codex", options: { fast: true } }]);

    const older = makeHarness();
    await run(older.handlers[NEOLIX_HOST_WS_METHODS.listExternalSessions], {
      agent: "codex",
      fast: true,
    });
    expect(older.calls).toContainEqual(["sessions", { agent: "codex", options: undefined }]);
  });

  it("deletes, restores and purges provider sessions", async () => {
    const { handlers, calls } = makeHarness();
    const removed = await run<{ deleted: string[] }>(
      handlers[NEOLIX_HOST_WS_METHODS.deleteExternalSessions],
      { agent: "codex", ids: ["s1"] },
    );
    expect(removed.deleted).toEqual(["s1"]);
    const restored = await run<{ title: string }>(
      handlers[NEOLIX_HOST_WS_METHODS.restoreExternalSession],
      { key: "trash-1" },
    );
    expect(restored.title).toBe("A session");
    const purged = await run<{ purged: string[] }>(
      handlers[NEOLIX_HOST_WS_METHODS.purgeExternalSessions],
      { keys: ["trash-1"] },
    );
    expect(purged.purged).toEqual(["s1"]);
    expect(calls).toContainEqual(["session-delete", { agent: "codex", ids: ["s1"] }]);
    expect(calls).toContainEqual(["session-restore", "trash-1"]);
    expect(calls).toContainEqual(["session-purge", { keys: ["trash-1"] }]);
  });

  it("reads transcripts, resumes a session and moves codex providers", async () => {
    const { handlers, calls } = makeHarness();
    const transcript = await run<{ parts: Array<{ text: string }> }>(
      handlers[NEOLIX_HOST_WS_METHODS.getExternalSessionTranscript],
      { agent: "codex", id: "s1" },
    );
    expect(transcript.parts[0]?.text).toBe("hello");
    const resumed = await run<{ agentId: string }>(
      handlers[NEOLIX_HOST_WS_METHODS.resumeExternalSession],
      { providerId: "codex", providerHandleId: "s1", cwd: "/repo" },
    );
    expect(resumed.agentId).toBe("agent-1");
    await run(handlers[NEOLIX_HOST_WS_METHODS.moveExternalCodexProvider], {
      moves: [{ id: "s1", to: "chatgpt" }],
    });
    expect(calls).toContainEqual(["codex-move", [{ id: "s1", to: "chatgpt" }]]);
    expect(calls).toContainEqual([
      "session-resume",
      { providerId: "codex", providerHandleId: "s1", cwd: "/repo" },
    ]);
  });

  it("resolves a Synara provider instance to the Neox provider", async () => {
    const { handlers } = makeHarness();
    const byDriver = await run<{ provider: string | null }>(
      handlers[NEOLIX_HOST_WS_METHODS.resolveProvider],
      { provider: "codex" },
    );
    expect(byDriver.provider).toBe("codex");
    const byInstance = await run<{ provider: string | null }>(
      handlers[NEOLIX_HOST_WS_METHODS.resolveProvider],
      { provider: "claudeAgent", instanceId: "neolix-gateway" },
    );
    expect(byInstance.provider).toBe("neolix-gateway");
  });
});

describe("hostRpc sync and gateway", () => {
  it("forwards sync reads and writes", async () => {
    const { handlers, calls } = makeHarness();
    const config = await run<{ config: unknown }>(handlers[NEOLIX_HOST_WS_METHODS.getSyncConfig]);
    expect(config.config).toEqual({ kind: "none" });
    await run(handlers[NEOLIX_HOST_WS_METHODS.setSyncConfig], {
      config: { kind: "webdav" },
    });
    expect(calls).toContainEqual(["sync-config", { kind: "webdav" }]);
  });

  it("returns the new status from a sync action", async () => {
    const { handlers } = makeHarness();
    const result = await run<{ status: { state: string } }>(
      handlers[NEOLIX_HOST_WS_METHODS.runSync],
    );
    expect(result.status.state).toBe("done");
  });

  it("lists remote versions and exports then imports backups", async () => {
    const { handlers, calls } = makeHarness();
    const remote = await run<{ versions: Array<{ part: string }> }>(
      handlers[NEOLIX_HOST_WS_METHODS.listSyncRemote],
    );
    expect(remote.versions.map((version) => version.part)).toEqual(["settings"]);

    const exported = await run<{ backup: { name: string } }>(
      handlers[NEOLIX_HOST_WS_METHODS.exportBackup],
      { passphrase: "secret", signIns: true },
    );
    expect(exported.backup.name).toBe("b.tar");
    expect(calls).toContainEqual(["backup-export", { passphrase: "secret", signIns: true }]);

    const imported = await run<{ parts: string[] }>(handlers[NEOLIX_HOST_WS_METHODS.importBackup], {
      fileName: "b.tar",
      mimeType: "application/octet-stream",
      bytesBase64: Buffer.from("backup").toString("base64"),
    });
    expect(imported.parts).toEqual(["settings"]);
    expect(calls).toContainEqual(["upload", "b.tar"]);
  });

  it("reads and writes the browser access page", async () => {
    const { handlers, calls } = makeHarness();
    const read = await run<{ page: { mode: string; port: number } }>(
      handlers[NEOLIX_HOST_WS_METHODS.getWebPage],
    );
    expect(read.page.mode).toBe("local");
    expect(read.page.port).toBe(6769);

    const written = await run<{ page: { mode: string; network: string[] } | null }>(
      handlers[NEOLIX_HOST_WS_METHODS.setWebPage],
      { mode: "lan" },
    );
    expect(written.page?.mode).toBe("lan");
    expect(written.page?.network).toHaveLength(1);
    expect(calls).toContainEqual(["web-page", { mode: "lan" }]);
  });

  it("reports the Library GitHub token without echoing it", async () => {
    const { handlers, calls } = makeHarness();
    const status = await run<{ configured: boolean; rejected?: boolean }>(
      handlers[NEOLIX_HOST_WS_METHODS.getLibraryGithubToken],
    );
    expect(status).toEqual({ configured: true, rejected: false });

    const saved = await run<{ configured: boolean }>(
      handlers[NEOLIX_HOST_WS_METHODS.setLibraryGithubToken],
      { token: "example-token" },
    );
    expect(saved.configured).toBe(true);
    expect(calls).toContainEqual(["github-token", "example-token"]);
  });

  it("uses a typed error when the daemon call fails", async () => {
    const handlers = makeHostHandlers({
      client: {
        patchDaemonConfig: async () => {
          throw new Error("daemon offline");
        },
      },
    } as unknown as BridgeModel);
    await expect(
      run(handlers[NEOLIX_HOST_WS_METHODS.patchConfig], { patch: {} }),
    ).rejects.toBeInstanceOf(WsRpcError);
  });

  it("runs one provider's diagnostic through the daemon provider it maps to", async () => {
    const { calls, model } = makeHarness();
    const directory = new ProviderDirectory();
    directory.update(["claude", "codex"]);
    const handlers = makeHostHandlers(model, { directory });
    const result = await run<{ provider: string; diagnostic: string }>(
      handlers[NEOLIX_HOST_WS_METHODS.getProviderDiagnostic],
      { provider: "claudeAgent", instanceId: "claudeAgent" },
    );
    expect(result.provider).toBe("claudeAgent");
    expect(result.diagnostic).toContain("claude 2.1.0");
    expect(calls).toContainEqual(["diagnostic", "claude"]);
  });

  it("refuses a provider diagnostic for a provider the daemon did not list", async () => {
    const { model } = makeHarness();
    const handlers = makeHostHandlers(model, { directory: new ProviderDirectory() });
    // The directory re-reads the daemon's list on a miss; Grok is not on it.
    await expect(
      run(handlers[NEOLIX_HOST_WS_METHODS.getProviderDiagnostic], { provider: "grok" }),
    ).rejects.toBeInstanceOf(WsRpcError);
  });

  it("answers a diagnostic before the config read has filled the provider directory", async () => {
    const { model } = makeHarness();
    const handlers = makeHostHandlers(model, { directory: new ProviderDirectory() });
    await expect(
      run(handlers[NEOLIX_HOST_WS_METHODS.getProviderDiagnostic], { provider: "claudeAgent" }),
    ).resolves.toMatchObject({ provider: "claudeAgent" });
  });

  it("reports the connected daemon's feature flags", async () => {
    const { model } = makeHarness();
    model.client.getLastServerInfoMessage = () =>
      ({
        serverId: "srv-1",
        version: "0.15.0",
        features: { sync: true, agentDetach: false, unknownFlag: "not-a-flag" },
      }) as unknown as ReturnType<typeof model.client.getLastServerInfoMessage>;
    const handlers = makeHostHandlers(model);
    // Only booleans are capability flags; other values never cross the wire as features.
    await expect(run(handlers[NEOLIX_HOST_WS_METHODS.getFeatures])).resolves.toEqual({
      serverVersion: "0.15.0",
      features: { sync: true, agentDetach: false },
    });
  });

  it("re-announces the flags when a new server_info arrives", async () => {
    const { model } = makeHarness();
    let info = {
      serverId: "srv-1",
      version: "0.15.0",
      features: { sync: false },
    };
    model.client.getLastServerInfoMessage = () =>
      info as unknown as ReturnType<typeof model.client.getLastServerInfoMessage>;
    const handlers = makeHostHandlers(model);
    const stream = handlers[NEOLIX_HOST_WS_METHODS.subscribeFeatures]!(
      {},
      {},
    ) as unknown as Stream.Stream<NeolixHostFeatures>;

    const emitted = await Effect.runPromise(
      Effect.gen(function* () {
        setTimeout(() => {
          info = { serverId: "srv-1", version: "0.16.0", features: { sync: true } };
          (model.client as unknown as { emitRawMessage(message: unknown): void }).emitRawMessage({
            type: "status",
            payload: { status: "server_info", serverId: "srv-1", version: "0.16.0" },
          });
        }, 0);
        return Array.from(yield* Stream.runCollect(Stream.take(stream, 2)));
      }),
    );

    expect(emitted).toEqual([
      { serverVersion: "0.15.0", features: { sync: false } },
      { serverVersion: "0.16.0", features: { sync: true } },
    ]);
  });

  it("reports no flags before the daemon's server_info arrives", async () => {
    const { model } = makeHarness();
    const handlers = makeHostHandlers(model);
    await expect(run(handlers[NEOLIX_HOST_WS_METHODS.getFeatures])).resolves.toEqual({
      serverVersion: null,
      features: {},
    });
  });

  it("forwards daemon update phases while an update runs", async () => {
    const { model } = makeHarness();
    const handlers = makeHostHandlers(model);
    const stream = handlers[NEOLIX_HOST_WS_METHODS.subscribeUpdateProgress]!(
      {},
      {},
    ) as unknown as Stream.Stream<NeolixHostUpdateProgress>;

    const emitted = await Effect.runPromise(
      Effect.gen(function* () {
        setTimeout(() => {
          const emit = (model.client as unknown as { emitRawMessage(message: unknown): void })
            .emitRawMessage;
          emit({
            type: "daemon.update.progress",
            payload: { requestId: "update-1", phase: "starting" },
          });
          // Another message type must not leak into the progress stream.
          emit({ type: "status", payload: { status: "server_info" } });
          emit({
            type: "daemon.update.progress",
            payload: { requestId: "update-1", phase: "downloading" },
          });
        }, 10);
        return Array.from(yield* Stream.runCollect(Stream.take(stream, 2)));
      }),
    );

    expect(emitted).toEqual([{ phase: "starting" }, { phase: "downloading" }]);
  });
});
