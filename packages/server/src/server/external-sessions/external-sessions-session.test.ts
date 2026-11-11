import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pino } from "pino";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionOutboundMessage } from "../messages.js";
import { GatewayConfigStore } from "../llm-gateway/config.js";
import { GatewayConversations } from "../llm-gateway/conversations.js";
import { ExternalSessionsService } from "./service.js";
import { ExternalSessionsSession } from "./external-sessions-session.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function harness(): Promise<{
  session: ExternalSessionsSession;
  messages: SessionOutboundMessage[];
  claudeDir: string;
  neolixHome: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "neolix-sessions-rpc-"));
  roots.push(root);
  const neolixHome = path.join(root, "neox-home");
  const claudeDir = path.join(root, "claude");
  await mkdir(neolixHome, { recursive: true });
  const store = new GatewayConfigStore({ neolixHome, logger: pino({ level: "silent" }) });
  await store.start();
  const conversations = new GatewayConversations({
    neolixHome,
    configStore: store,
    logger: pino({ level: "silent" }),
  });
  const messages: SessionOutboundMessage[] = [];
  const session = new ExternalSessionsSession({
    service: new ExternalSessionsService({
      neolixHome,
      homeDir: root,
      env: {
        CLAUDE_CONFIG_DIR: claudeDir,
        CODEX_HOME: path.join(root, "codex"),
        PI_CODING_AGENT_DIR: path.join(root, "pi"),
      },
      conversations,
    }),
    conversations,
    emit: (message) => messages.push(message),
  });
  return { session, messages, claudeDir, neolixHome };
}

async function writeSession(claudeDir: string): Promise<string> {
  const dir = path.join(claudeDir, "projects", "-work-app");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, "session-1.jsonl");
  await writeFile(
    file,
    `${JSON.stringify({
      type: "user",
      message: { content: "Fix the login bug" },
      timestamp: "2026-09-20T10:00:00.000Z",
      cwd: "/work/app",
    })}\n`,
    "utf8",
  );
  const old = new Date(Date.now() - 5 * 60_000);
  await utimes(file, old, old);
  return file;
}

type ListPayload = Extract<
  SessionOutboundMessage,
  { type: "sessions.external.list.response" }
>["payload"];
type SearchPayload = Extract<
  SessionOutboundMessage,
  { type: "sessions.external.search.response" }
>["payload"];
type DeletePayload = Extract<
  SessionOutboundMessage,
  { type: "sessions.external.delete.response" }
>["payload"];
type RestorePayload = Extract<
  SessionOutboundMessage,
  { type: "sessions.external.restore.response" }
>["payload"];
type RecordingPayload = Extract<
  SessionOutboundMessage,
  { type: "sessions.recording.set.response" }
>["payload"];

function lastList(messages: SessionOutboundMessage[]): ListPayload {
  const message = messages.at(-1);
  if (message?.type !== "sessions.external.list.response") {
    throw new Error("expected a list response");
  }
  return message.payload;
}

function lastSearch(messages: SessionOutboundMessage[]): SearchPayload {
  const message = messages.at(-1);
  if (message?.type !== "sessions.external.search.response") {
    throw new Error("expected a search response");
  }
  return message.payload;
}

function lastDelete(messages: SessionOutboundMessage[]): DeletePayload {
  const message = messages.at(-1);
  if (message?.type !== "sessions.external.delete.response") {
    throw new Error("expected a delete response");
  }
  return message.payload;
}

function lastRestore(messages: SessionOutboundMessage[]): RestorePayload {
  const message = messages.at(-1);
  if (message?.type !== "sessions.external.restore.response") {
    throw new Error("expected a restore response");
  }
  return message.payload;
}

function lastRecording(messages: SessionOutboundMessage[]): RecordingPayload {
  const message = messages.at(-1);
  if (message?.type !== "sessions.recording.set.response") {
    throw new Error("expected a recording response");
  }
  return message.payload;
}

describe("ExternalSessionsSession", () => {
  it("answers the list, search, delete, and restore requests", async () => {
    const { session, messages, claudeDir } = await harness();
    await writeSession(claudeDir);

    await session.handleList({ type: "sessions.external.list.request", requestId: "list" });
    const list = lastList(messages);
    expect(list.error).toBeNull();
    expect(list.agent).toBe("claude");
    expect(list.sessions[0]?.title).toBe("Fix the login bug");
    expect(list.recording).toBe(false);

    await session.handleSearch({
      type: "sessions.external.search.request",
      requestId: "search",
      agent: "claude",
      query: "login",
    });
    expect(lastSearch(messages).hits[0]?.match).toBe("login");

    await session.handleRecording({
      type: "sessions.recording.set.request",
      requestId: "recording",
      on: true,
    });
    expect(lastRecording(messages)).toMatchObject({ recording: true, error: null });

    await session.handleDelete({
      type: "sessions.external.delete.request",
      requestId: "delete",
      agent: "claude",
      ids: ["session-1"],
    });
    const deleted = lastDelete(messages);
    expect(deleted.deleted).toEqual(["session-1"]);
    expect(deleted.refused).toEqual([]);

    await session.handleList({ type: "sessions.external.list.request", requestId: "list-2" });
    const afterDelete = lastList(messages);
    expect(afterDelete.sessions).toEqual([]);
    const key = afterDelete.trash[0]?.key ?? "";

    await session.handleRestore({
      type: "sessions.external.restore.request",
      requestId: "restore",
      key,
    });
    expect(lastRestore(messages)).toMatchObject({ agent: "claude", id: "session-1", error: null });
  });
});

describe("session reads RPC", () => {
  function readsSession(
    initial: {
      asked: boolean;
      all: boolean;
      found: { agent: string; name: string; on: boolean }[];
    },
    messages: SessionOutboundMessage[],
    set?: (input: { all?: boolean; agents?: Record<string, boolean> }) => void,
  ): ExternalSessionsSession {
    let snapshot = initial;
    return new ExternalSessionsSession({
      service: {} as ExternalSessionsService,
      conversations: undefined,
      reads: {
        snapshot: async () => snapshot,
        set: async (input) => {
          set?.(input);
          snapshot = {
            ...snapshot,
            all: input.all ?? snapshot.all,
            found: snapshot.found.map((entry) => ({
              ...entry,
              on: input.agents?.[entry.agent] ?? entry.on,
            })),
          };
          return snapshot;
        },
      },
      emit: (message) => messages.push(message),
    });
  }

  it("answers which agents are read and found, and saves a change", async () => {
    const messages: SessionOutboundMessage[] = [];
    const changes: { all?: boolean; agents?: Record<string, boolean> }[] = [];
    const session = readsSession(
      {
        asked: true,
        all: true,
        found: [
          { agent: "claude", name: "Claude Code", on: true },
          { agent: "codex", name: "Codex", on: true },
        ],
      },
      messages,
      (input) => changes.push(input),
    );

    await session.handleReadsGet({ type: "sessions.reads.get.request", requestId: "get" });
    expect(messages.at(-1)).toMatchObject({
      type: "sessions.reads.get.response",
      payload: {
        requestId: "get",
        snapshot: { asked: true, all: true, found: [{ agent: "claude" }, { agent: "codex" }] },
        error: null,
      },
    });

    await session.handleReadsSet({
      type: "sessions.reads.set.request",
      requestId: "set",
      agents: { claude: false },
    });
    expect(changes).toEqual([{ all: undefined, agents: { claude: false } }]);
    const saved = messages.at(-1);
    if (saved?.type !== "sessions.reads.set.response") {
      throw new Error("expected a set response");
    }
    expect(saved.payload.snapshot?.found).toEqual([
      { agent: "claude", name: "Claude Code", on: false },
      { agent: "codex", name: "Codex", on: true },
    ]);
  });

  it("answers an error when the host keeps no setting", async () => {
    const messages: SessionOutboundMessage[] = [];
    const session = new ExternalSessionsSession({
      service: {} as ExternalSessionsService,
      conversations: undefined,
      emit: (message) => messages.push(message),
    });
    await session.handleReadsGet({ type: "sessions.reads.get.request", requestId: "get" });
    expect(messages.at(-1)).toMatchObject({
      type: "sessions.reads.get.response",
      payload: {
        requestId: "get",
        snapshot: null,
        error: "This host keeps no session history setting",
      },
    });
  });
});

describe("session activity over the RPC", () => {
  it("answers per-day activity when the list asks for it", async () => {
    const { session, messages, claudeDir } = await harness();
    const dir = path.join(claudeDir, "projects", "-work-app");
    await mkdir(dir, { recursive: true });
    const lines = [
      {
        type: "user",
        message: { content: "Fix the login bug" },
        timestamp: "2026-09-20T10:00:00.000Z",
        cwd: "/work/app",
      },
      {
        type: "assistant",
        message: {
          id: "m1",
          model: "claude-opus-5-5",
          content: [{ type: "text", text: "done" }],
          usage: { input_tokens: 10, output_tokens: 5 },
        },
        timestamp: "2026-09-20T10:01:00.000Z",
        cwd: "/work/app",
      },
    ];
    await writeFile(
      path.join(dir, "session-activity.jsonl"),
      `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
    );

    await session.handleList({
      type: "sessions.external.list.request",
      requestId: "list",
      activityDays: 0,
    });

    expect(lastList(messages).sessions[0]?.activity).toEqual([
      {
        date: "2026-09-20",
        tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
        activeSeconds: 60,
        models: [
          {
            model: "claude-opus-5-5",
            tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      },
    ]);
  });
});

describe("session terminal RPCs", () => {
  function terminalSession(
    messages: SessionOutboundMessage[],
    opened: unknown[],
    found: { command: string; cwd: string; title: string } | null,
  ): ExternalSessionsSession {
    return new ExternalSessionsSession({
      service: {
        sessionForTerminal: async () => found,
      } as unknown as ExternalSessionsService,
      conversations: undefined,
      terminals: {
        list: async () => ({
          supported: true,
          apps: [
            { id: "com.apple.Terminal", name: "Terminal" },
            { id: "com.googlecode.iterm2", name: "iTerm" },
          ],
          defaultId: "com.apple.Terminal",
        }),
        open: async (input) => {
          opened.push(input);
        },
      },
      emit: (message) => messages.push(message),
    });
  }

  it("lists the host's terminals", async () => {
    const messages: SessionOutboundMessage[] = [];
    const session = terminalSession(messages, [], null);
    await session.handleTerminalsList({
      type: "sessions.terminals.list.request",
      requestId: "list",
    });
    expect(messages.at(-1)).toMatchObject({
      type: "sessions.terminals.list.response",
      payload: {
        requestId: "list",
        supported: true,
        apps: [{ id: "com.apple.Terminal" }, { id: "com.googlecode.iterm2" }],
        defaultId: "com.apple.Terminal",
        error: null,
      },
    });
  });

  it("opens the session's own resume in the chosen terminal", async () => {
    const messages: SessionOutboundMessage[] = [];
    const opened: unknown[] = [];
    const session = terminalSession(messages, opened, {
      command: "claude --resume s1",
      cwd: "/work/app",
      title: "Fix the login bug",
    });
    await session.handleOpenInTerminal({
      type: "sessions.open_in_terminal.request",
      requestId: "open",
      agent: "claude",
      id: "s1",
    });
    expect(opened).toEqual([
      {
        command: "claude --resume s1",
        cwd: "/work/app",
        label: "Fix the login bug",
      },
    ]);
    expect(messages.at(-1)).toMatchObject({
      type: "sessions.open_in_terminal.response",
      payload: { requestId: "open", opened: true, error: null },
    });
  });

  it("says a session it cannot find was not opened", async () => {
    const messages: SessionOutboundMessage[] = [];
    const session = terminalSession(messages, [], null);
    await session.handleOpenInTerminal({
      type: "sessions.open_in_terminal.request",
      requestId: "open",
      agent: "claude",
      id: "missing",
    });
    expect(messages.at(-1)).toMatchObject({
      type: "sessions.open_in_terminal.response",
      payload: {
        requestId: "open",
        opened: false,
        error: expect.stringContaining("no such session"),
      },
    });
  });
});
