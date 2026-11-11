import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ExternalSessionsService } from "./service.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface Fixture {
  root: string;
  neolixHome: string;
  dbPath: string;
  service: ExternalSessionsService;
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), "neolix-opencode-"));
  roots.push(root);
  const neolixHome = path.join(root, "neox-home");
  const dataHome = path.join(root, "data");
  const dbPath = path.join(dataHome, "opencode", "opencode.db");
  await mkdir(neolixHome, { recursive: true });
  await mkdir(path.dirname(dbPath), { recursive: true });
  const service = new ExternalSessionsService({
    neolixHome,
    homeDir: root,
    env: {
      CLAUDE_CONFIG_DIR: path.join(root, "claude"),
      CODEX_HOME: path.join(root, "codex"),
      PI_CODING_AGENT_DIR: path.join(root, "pi"),
      XDG_DATA_HOME: dataHome,
    },
  });
  return { root, neolixHome, dbPath, service };
}

async function openDb(dbPath: string) {
  const { DatabaseSync } = await import("node:sqlite");
  return new DatabaseSync(dbPath);
}

const MAIN = "ses_main";
const CHILD = "ses_child";

async function writeV2Database(dbPath: string): Promise<void> {
  const db = await openDb(dbPath);
  db.exec(`
    CREATE TABLE session_v2 (
      id text PRIMARY KEY, parent_id text, directory text NOT NULL, title text,
      agent text, model text, cost real DEFAULT 0 NOT NULL,
      tokens_input integer DEFAULT 0 NOT NULL, tokens_output integer DEFAULT 0 NOT NULL,
      tokens_reasoning integer DEFAULT 0 NOT NULL, tokens_cache_read integer DEFAULT 0 NOT NULL,
      tokens_cache_write integer DEFAULT 0 NOT NULL,
      time_created integer NOT NULL, time_updated integer NOT NULL, time_archived integer
    );
    CREATE TABLE session_message (
      id text PRIMARY KEY, session_id text NOT NULL, type text NOT NULL, seq integer NOT NULL,
      time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL
    );
  `);
  const session = db.prepare(
    `INSERT INTO session_v2
      (id, parent_id, directory, title, agent, model, cost, tokens_input, tokens_output,
       tokens_reasoning, tokens_cache_read, tokens_cache_write, time_created, time_updated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  session.run(
    MAIN,
    null,
    "/work/oc",
    "Fix the login bug",
    "build",
    JSON.stringify({ id: "claude-opus-5", variant: "high" }),
    0.25,
    1000,
    200,
    50,
    30,
    40,
    1_790_000_000_000,
    1_790_000_060_000,
  );
  session.run(
    CHILD,
    MAIN,
    "/work/oc",
    "Find the router (@explore subagent)",
    "explore",
    JSON.stringify({ id: "claude-haiku-5-5" }),
    0,
    10,
    5,
    0,
    0,
    0,
    1_790_000_010_000,
    1_790_000_050_000,
  );
  const message = db.prepare(
    `INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  message.run("m1", MAIN, "user", 0, 1, 1, JSON.stringify({ text: "Fix the login bug" }));
  message.run(
    "m2",
    MAIN,
    "assistant",
    1,
    2,
    2,
    JSON.stringify({
      model: { id: "claude-opus-5", variant: "high" },
      content: [
        { type: "text", text: "Reading the form" },
        { type: "tool", name: "read", state: { input: { filePath: "login.ts" }, output: "x" } },
      ],
    }),
  );
  db.close();
}

describe("ExternalSessionsService OpenCode", () => {
  it("lists OpenCode 2's sessions and their subagents from its database", async () => {
    const { service, dbPath } = await fixture();
    await writeV2Database(dbPath);

    const list = await service.list("opencode");

    expect(list.agents).toEqual([
      { agent: "opencode", name: "OpenCode", count: 1, deletable: false },
    ]);
    const [session] = list.sessions;
    expect(session).toMatchObject({
      id: MAIN,
      cwd: "/work/oc",
      title: "Fix the login bug",
      messages: 2,
      cost: 0.25,
      priced: true,
      deletable: false,
      resume: `opencode --session ${MAIN}`,
    });
    expect(session?.tokens).toEqual({
      input: 1000,
      output: 250,
      cacheRead: 30,
      cacheWrite: 40,
    });
    expect(session?.models[0]).toMatchObject({ model: "claude-opus-5", effort: "high" });
    expect(session?.subagents).toEqual([
      {
        id: CHILD,
        title: "Find the router",
        kind: "explore",
        start: expect.any(String),
        last: expect.any(String),
      },
    ]);
  });

  it("reads a session's conversation, and its subagent's", async () => {
    const { service, dbPath } = await fixture();
    await writeV2Database(dbPath);

    const transcript = await service.transcript({ agent: "opencode", id: MAIN });

    expect(transcript.parts.map((part) => [part.role, part.kind, part.text.slice(0, 20)])).toEqual([
      ["user", "text", "Fix the login bug"],
      ["assistant", "text", "Reading the form"],
      ["assistant", "tool_use", '{\n  "filePath": "log'],
      ["tool", "tool_result", "x"],
    ]);
    const sub = await service.transcript({ agent: "opencode", id: MAIN, sub: CHILD });
    expect(sub.parts).toEqual([]);
  });

  it("reads the older databases, taking the title from the first prompt", async () => {
    const { service, dbPath } = await fixture();
    const db = await openDb(dbPath);
    db.exec(`
      CREATE TABLE session (
        id text PRIMARY KEY, parent_id text, directory text NOT NULL, title text NOT NULL,
        agent text, model text, cost real DEFAULT 0 NOT NULL,
        tokens_input integer DEFAULT 0 NOT NULL, tokens_output integer DEFAULT 0 NOT NULL,
        tokens_reasoning integer DEFAULT 0 NOT NULL, tokens_cache_read integer DEFAULT 0 NOT NULL,
        tokens_cache_write integer DEFAULT 0 NOT NULL,
        time_created integer NOT NULL, time_updated integer NOT NULL, time_archived integer
      );
      CREATE TABLE message (
        id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL,
        time_updated integer NOT NULL, data text NOT NULL
      );
      CREATE TABLE part (
        id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL,
        time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL
      );
    `);
    db.prepare(
      `INSERT INTO session
        (id, parent_id, directory, title, agent, model, time_created, time_updated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(MAIN, null, "/work/oc-old", "", "build", "", 1_790_000_000_000, 1_790_000_010_000);
    db.prepare(
      "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
    ).run("m1", MAIN, 1, 1, JSON.stringify({ role: "user" }));
    db.prepare(
      `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("p1", "m1", MAIN, 1, 1, JSON.stringify({ type: "text", text: "Older prompt" }));
    db.prepare(
      "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
    ).run("m2", MAIN, 2, 2, JSON.stringify({ role: "assistant", modelID: "claude-opus-5" }));
    db.prepare(
      `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("p2", "m2", MAIN, 2, 2, JSON.stringify({ type: "text", text: "Older reply" }));
    db.close();

    const list = await service.list("opencode");
    expect(list.sessions[0]).toMatchObject({ title: "Older prompt", cwd: "/work/oc-old" });

    const transcript = await service.transcript({ agent: "opencode", id: MAIN });
    expect(transcript.parts.map((part) => part.text)).toEqual(["Older prompt", "Older reply"]);
  });

  it("searches what was said in OpenCode's messages", async () => {
    const { service, dbPath } = await fixture();
    await writeV2Database(dbPath);

    const found = await service.search("opencode", "LOGIN");

    expect(found.searched).toBe(1);
    expect(found.hits).toEqual([
      {
        id: MAIN,
        role: "user",
        kind: "text",
        before: "Fix the ",
        match: "login",
        after: " bug",
      },
    ]);
  });
});
