import {
  ImportProjectResult,
  ListProjectImportsResult,
  LoadProjectImportHistoryResult,
  ORCHESTRATION_WS_METHODS,
  OrchestrationImportThreadResult,
} from "@synara/contracts";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { makeImportHandlers } from "./importRpc.ts";
import type { BridgeModel } from "./model.ts";
import type { AnyHandler } from "./stubs.ts";

const AT = "2026-11-01T00:00:00.000Z";
const LATER = "2026-11-02T00:00:00.000Z";

const encode = <S extends Schema.Top>(schema: S, value: unknown) =>
  Schema.encodeUnknownSync(schema as never)(value);

function run<A>(handler: AnyHandler | undefined, payload: unknown): Promise<A> {
  if (handler === undefined) throw new Error("handler is missing");
  return Effect.runPromise(handler(payload, {}) as Effect.Effect<A, never>);
}

const sessionsByAgent: Record<string, unknown[]> = {
  codex: [
    {
      id: "s1",
      agent: "codex",
      cwd: "/repo",
      title: "Codex work",
      start: AT,
      last: LATER,
    },
  ],
  claude: [
    {
      id: "s2",
      agent: "claude",
      cwd: "/repo",
      title: "Claude work",
      start: AT,
      last: LATER,
    },
  ],
};

function makeHarness() {
  const calls: Array<[string, unknown]> = [];
  const client = {
    listExternalSessions: async (agent: string) => {
      calls.push(["listExternalSessions", agent]);
      return {
        requestId: "r",
        agents: [],
        agent,
        sessions: sessionsByAgent[agent] ?? [],
        trash: [],
        trashDir: "/trash",
        home: "/home",
        recording: false,
        recorded: false,
        error: null,
      };
    },
    fetchAgents: async () => ({
      entries: [
        {
          agent: {
            id: "a1",
            provider: "codex",
            persistence: { provider: "codex", sessionId: "s1" },
            createdAt: AT,
            updatedAt: LATER,
          },
          project: null,
        },
      ],
    }),
    listDirectory: async (cwd: string) => {
      if (cwd === "/missing") throw new Error("not found");
      return { entries: [] };
    },
    addProject: async (cwd: string) => {
      calls.push(["addProject", cwd]);
      return { project: { projectId: "prj_new", projectRootPath: cwd }, error: null };
    },
    importAgent: async (input: unknown) => {
      calls.push(["importAgent", input]);
      return { id: "agent_new" };
    },
    getExternalSessionTranscript: async (input: unknown) => {
      calls.push(["getExternalSessionTranscript", input]);
      return {
        requestId: "r",
        parts: [
          { role: "user", kind: "text", text: "hi" },
          { role: "assistant", kind: "text", text: "hello" },
          { role: "tool", kind: "tool", text: "ignored" },
        ],
        total: 4,
        cut: false,
        source: "codex",
        error: null,
      };
    },
  };
  const model = {
    client,
    shellSnapshot: () => ({ projects: [{ id: "prj_1", workspaceRoot: "/repo" }] }),
    draft: () => undefined,
    entry: (threadId: string) =>
      threadId === "thread_1"
        ? {
            agent: {
              id: "a1",
              provider: "codex",
              persistence: { provider: "codex", sessionId: "s1" },
              createdAt: AT,
              updatedAt: LATER,
            },
          }
        : undefined,
  } as unknown as BridgeModel;
  return { handlers: makeImportHandlers(model), calls };
}

describe("importRpc catalog", () => {
  it("groups external sessions by cwd and marks imported ones", async () => {
    const { handlers } = makeHarness();
    const result = await run<ListProjectImportsResult>(
      handlers[ORCHESTRATION_WS_METHODS.listProjectImports],
      { providers: ["codex", "claudeAgent"] },
    );
    const encoded = encode(ListProjectImportsResult, result) as ListProjectImportsResult;
    expect(encoded.projects).toHaveLength(1);
    expect(encoded.projects[0]).toMatchObject({
      key: "/repo",
      workspaceRoot: "/repo",
      directoryExists: true,
      existingProjectId: "prj_1",
      providers: ["codex", "claudeAgent"],
    });
    expect(encoded.projects[0]?.threads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "codex:s1", alreadyImported: true }),
        expect.objectContaining({ key: "claude:s2", alreadyImported: false }),
      ]),
    );
    expect(encoded.sources).toEqual([
      { provider: "codex", error: null },
      { provider: "claudeAgent", error: null },
    ]);
  });
});

describe("importRpc project import", () => {
  it("links an empty project by registering its folder", async () => {
    const { handlers, calls } = makeHarness();
    const result = await run<ImportProjectResult>(
      handlers[ORCHESTRATION_WS_METHODS.importProject],
      { projectKey: "/new", threadKey: null, workspaceRoot: "/new", spaceId: null },
    );
    expect(encode(ImportProjectResult, result)).toEqual({
      projectId: "prj_new",
      threadId: null,
      status: "project-linked",
    });
    expect(calls).toContainEqual(["addProject", "/new"]);
  });

  it("reports the existing agent instead of importing twice", async () => {
    const { handlers, calls } = makeHarness();
    const result = await run<ImportProjectResult>(
      handlers[ORCHESTRATION_WS_METHODS.importProject],
      { projectKey: "/repo", threadKey: "codex:s1" },
    );
    expect(encode(ImportProjectResult, result)).toEqual({
      projectId: "prj_1",
      threadId: "a1",
      status: "already-present",
    });
    expect(calls.some(([name]) => name === "importAgent")).toBe(false);
  });

  it("imports a new thread as a daemon agent", async () => {
    const { handlers, calls } = makeHarness();
    const result = await run<ImportProjectResult>(
      handlers[ORCHESTRATION_WS_METHODS.importProject],
      { projectKey: "/repo", threadKey: "codex:unknown", workspaceRoot: "/repo" },
    );
    expect(encode(ImportProjectResult, result)).toEqual({
      projectId: "prj_1",
      threadId: "agent_new",
      status: "imported",
    });
    expect(calls).toContainEqual([
      "importAgent",
      { providerId: "codex", providerHandleId: "unknown", cwd: "/repo" },
    ]);
  });

  it("imports into the caller's draft thread via the daemon's external session", async () => {
    const { handlers } = makeHarness();
    const result = await run<OrchestrationImportThreadResult>(
      handlers[ORCHESTRATION_WS_METHODS.importThread],
      { threadId: "thread_1", externalId: "s1" },
    );
    expect(encode(OrchestrationImportThreadResult, result)).toEqual({ threadId: "agent_new" });
  });
});

describe("importRpc history", () => {
  it("pages the external transcript behind an imported thread", async () => {
    const { handlers, calls } = makeHarness();
    const result = await run<LoadProjectImportHistoryResult>(
      handlers[ORCHESTRATION_WS_METHODS.loadProjectImportHistory],
      { threadId: "thread_1" },
    );
    const encoded = encode(
      LoadProjectImportHistoryResult,
      result,
    ) as LoadProjectImportHistoryResult;
    expect(encoded.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(encoded.messages.map((message) => message.text)).toEqual(["hi", "hello"]);
    expect(encoded.nextCursor).toBe("3");
    expect(calls).toContainEqual([
      "getExternalSessionTranscript",
      { agent: "codex", id: "s1", offset: 0, limit: 50 },
    ]);
  });

  it("returns an empty page for a thread without import provenance", async () => {
    const { handlers } = makeHarness();
    const result = await run<LoadProjectImportHistoryResult>(
      handlers[ORCHESTRATION_WS_METHODS.loadProjectImportHistory],
      { threadId: "unknown" },
    );
    expect(encode(LoadProjectImportHistoryResult, result)).toEqual({
      nextCursor: null,
      messages: [],
    });
  });
});
