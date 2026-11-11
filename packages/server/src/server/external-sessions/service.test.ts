import { access, mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ExternalSessionsService } from "./service.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface Fixture {
  neolixHome: string;
  claudeDir: string;
  codexHome: string;
  piHome: string;
  service: ExternalSessionsService;
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), "neolix-external-sessions-"));
  roots.push(root);
  const neolixHome = path.join(root, "neox-home");
  const claudeDir = path.join(root, "claude");
  const codexHome = path.join(root, "codex");
  const piHome = path.join(root, "pi");
  await mkdir(neolixHome, { recursive: true });
  const service = new ExternalSessionsService({
    neolixHome,
    homeDir: root,
    env: {
      CLAUDE_CONFIG_DIR: claudeDir,
      CODEX_HOME: codexHome,
      PI_CODING_AGENT_DIR: piHome,
    },
  });
  return { neolixHome, claudeDir, codexHome, piHome, service };
}

async function writeClaude(
  claudeDir: string,
  project: string,
  id: string,
  lines: readonly unknown[],
): Promise<string> {
  const dir = path.join(claudeDir, "projects", project);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  await writeFile(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
  return file;
}

describe("ExternalSessionsService", () => {
  it("lists an agent's sessions by folder with what each said and spent", async () => {
    const { service, claudeDir } = await fixture();
    await writeClaude(claudeDir, "-work-app", "11111111-2222-3333-4444-555555555555", [
      {
        type: "user",
        message: { role: "user", content: "Fix the   login\nbug" },
        timestamp: "2026-09-20T10:00:01.000Z",
        cwd: "/work/app",
      },
      {
        type: "assistant",
        message: {
          id: "m1",
          model: "claude-opus-5-5",
          content: [{ type: "text", text: "ok" }],
          usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 20 },
        },
        timestamp: "2026-09-20T10:00:05.000Z",
        cwd: "/work/app",
      },
    ]);

    const list = await service.list();

    expect(list.agent).toBe("claude");
    expect(list.agents).toEqual([
      { agent: "claude", name: "Claude Code", count: 1, deletable: true },
    ]);
    const [session] = list.sessions;
    expect(session).toMatchObject({
      id: "11111111-2222-3333-4444-555555555555",
      agent: "claude",
      cwd: "/work/app",
      title: "Fix the login bug",
      messages: 2,
      deletable: true,
      resume: "claude --resume 11111111-2222-3333-4444-555555555555",
    });
    expect(session?.tokens).toEqual({ input: 100, output: 50, cacheRead: 20, cacheWrite: 0 });
    expect(session?.models.map((model) => model.model)).toEqual(["claude-opus-5-5"]);
  });

  it("reads Codex rollouts and Pi sessions", async () => {
    const { service, codexHome, piHome } = await fixture();
    const codexDir = path.join(codexHome, "sessions", "2026", "09", "20");
    await mkdir(codexDir, { recursive: true });
    await writeFile(
      path.join(codexDir, "rollout-2026-09-20T15-48-28-01a0bdc9-b5fd-7e63-9658-68bc8dce5ecd.jsonl"),
      [
        JSON.stringify({
          timestamp: "2026-09-20T15:48:28.100Z",
          type: "session_meta",
          payload: { id: "01a0bdc9-b5fd-7e63-9658-68bc8dce5ecd", cwd: "/work/codex" },
        }),
        JSON.stringify({
          timestamp: "2026-09-20T15:48:29.100Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Add a README" }],
          },
        }),
        JSON.stringify({
          timestamp: "2026-09-20T15:48:29.300Z",
          type: "turn_context",
          payload: { cwd: "/work/codex", model: "gpt-6-astra", effort: "high" },
        }),
        JSON.stringify({
          timestamp: "2026-09-20T15:48:36.000Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: {
                input_tokens: 10000,
                cached_input_tokens: 4000,
                output_tokens: 300,
              },
            },
          },
        }),
      ].join("\n"),
      "utf8",
    );
    const piDir = path.join(piHome, "sessions", "--work-pi--");
    await mkdir(piDir, { recursive: true });
    await writeFile(
      path.join(piDir, "2026-09-24T08-00-00-000Z_0199aaaa-1111-7222-8333-444455556666.jsonl"),
      [
        JSON.stringify({
          type: "session",
          id: "0199aaaa-1111-7222-8333-444455556666",
          timestamp: "2026-09-24T08:00:00.000Z",
          cwd: "/work/pi",
        }),
        JSON.stringify({
          type: "thinking_level_change",
          timestamp: "2026-09-24T08:00:00.100Z",
          thinkingLevel: "high",
        }),
        JSON.stringify({
          type: "message",
          timestamp: "2026-09-24T08:00:01.000Z",
          message: {
            role: "user",
            content: [{ type: "text", text: "Refactor the parser" }],
          },
        }),
        JSON.stringify({
          type: "message",
          timestamp: "2026-09-24T08:00:05.000Z",
          message: {
            role: "assistant",
            model: "claude-opus-5-5",
            content: [{ type: "text", text: "ok" }],
            usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5 },
          },
        }),
      ].join("\n"),
      "utf8",
    );

    const codex = await service.list("codex");
    expect(codex.sessions[0]).toMatchObject({
      id: "01a0bdc9-b5fd-7e63-9658-68bc8dce5ecd",
      title: "Add a README",
      cwd: "/work/codex",
      messages: 1,
    });
    expect(codex.sessions[0]?.tokens).toEqual({
      input: 6000,
      output: 300,
      cacheRead: 4000,
      cacheWrite: 0,
    });
    expect(codex.sessions[0]?.models[0]?.effort).toBe("high");

    const pi = await service.list("pi");
    expect(pi.sessions[0]).toMatchObject({
      id: "0199aaaa-1111-7222-8333-444455556666",
      title: "Refactor the parser",
      cwd: "/work/pi",
      messages: 2,
      resume: "pi --session 0199aaaa-1111-7222-8333-444455556666",
    });
    expect(pi.sessions[0]?.tokens).toEqual({
      input: 100,
      output: 50,
      cacheRead: 10,
      cacheWrite: 5,
    });
  });

  it("searches what was said and reports the words around the match", async () => {
    const { service, claudeDir } = await fixture();
    await writeClaude(claudeDir, "-work-app", "session-one", [
      {
        type: "user",
        message: { content: "Fix the login bug" },
        timestamp: "2026-09-20T10:00:00.000Z",
      },
      {
        type: "user",
        message: { content: "Now add a test" },
        timestamp: "2026-09-20T10:00:10.000Z",
      },
    ]);

    const found = await service.search("claude", "LOGIN");

    expect(found.searched).toBe(1);
    expect(found.hits).toEqual([
      {
        id: "session-one",
        role: "user",
        kind: "text",
        before: "Fix the ",
        match: "login",
        after: " bug",
      },
    ]);
  });

  it("moves a session to the trash, restores it, and purges it only on request", async () => {
    const { service, claudeDir } = await fixture();
    const file = await writeClaude(claudeDir, "-work-app", "session-one", [
      { type: "user", message: { content: "Delete me" }, timestamp: "2026-09-20T10:00:00.000Z" },
    ]);
    const old = new Date(Date.now() - 5 * 60_000);
    await utimes(file, old, old);

    const { deleted, refused } = await service.delete("claude", ["session-one"]);
    expect(refused).toEqual([]);
    expect(deleted).toEqual(["session-one"]);
    await expect(access(file)).rejects.toThrow();

    const afterDelete = await service.list();
    expect(afterDelete.sessions).toEqual([]);
    expect(afterDelete.trash).toHaveLength(1);
    const trashed = afterDelete.trash[0];
    expect(trashed).toMatchObject({ agent: "claude", id: "session-one" });

    const restored = await service.restore(trashed?.key ?? "");
    expect(restored.id).toBe("session-one");
    await expect(access(file)).resolves.toBeUndefined();
    expect((await service.list()).trash).toEqual([]);

    const again = await service.delete("claude", ["session-one"]);
    const key = again.deleted[0] === undefined ? "" : (await service.list()).trash[0]?.key;
    expect(key).toBeTypeOf("string");
    expect(await service.purge([key ?? ""])).toEqual({ purged: [key], refused: [] });
    expect((await service.list()).trash).toEqual([]);
  });

  it("leaves a session written to in the last minute alone", async () => {
    const { service, claudeDir } = await fixture();
    const file = await writeClaude(claudeDir, "-work-app", "session-active", [
      {
        type: "user",
        message: { content: "Still running" },
        timestamp: "2026-09-20T10:00:00.000Z",
      },
    ]);
    const now = new Date();
    await utimes(file, now, now);

    const result = await service.delete("claude", ["session-active"]);

    expect(result.deleted).toEqual([]);
    expect(result.refused[0]?.active).toBe(true);
    await expect(stat(file)).resolves.toBeDefined();
  });
});

describe("session reads gate", () => {
  function gated(
    facts: { neolixHome: string; claudeDir: string; codexHome: string; piHome: string },
    reads: { asked: boolean; all: boolean; agents: Record<string, boolean> },
  ): ExternalSessionsService {
    return new ExternalSessionsService({
      neolixHome: facts.neolixHome,
      homeDir: path.dirname(facts.claudeDir),
      env: {
        CLAUDE_CONFIG_DIR: facts.claudeDir,
        CODEX_HOME: facts.codexHome,
        PI_CODING_AGENT_DIR: facts.piHome,
      },
      reads: () => reads,
    });
  }

  it("lists a disallowed agent's sessions nowhere and refuses to read them", async () => {
    const facts = await fixture();
    await writeClaude(facts.claudeDir, "-work-app", "11111111-2222-3333-4444-555555555555", [
      {
        type: "user",
        message: { content: "Fix the login bug" },
        timestamp: "2026-09-20T10:00:01.000Z",
        cwd: "/work/app",
      },
    ]);

    const open = gated(facts, { asked: true, all: true, agents: {} });
    expect((await open.list()).agents.map((agent) => agent.agent)).toEqual(["claude"]);

    const closed = gated(facts, { asked: true, all: false, agents: {} });
    const list = await closed.list();
    expect(list.agents).toEqual([]);
    expect(list.sessions).toEqual([]);
    await expect(closed.search("claude", "login")).rejects.toThrow(/not allowed to read/);
    await expect(
      closed.transcript({ agent: "claude", id: "11111111-2222-3333-4444-555555555555" }),
    ).rejects.toThrow(/not allowed to read/);
    await expect(closed.delete("claude", ["11111111-2222-3333-4444-555555555555"])).rejects.toThrow(
      /not allowed to read/,
    );
  });
});

describe("session activity", () => {
  it("reads per-day tokens and active time when the list asks for it", async () => {
    const { service, claudeDir } = await fixture();
    await writeClaude(claudeDir, "-work-app", "11111111-2222-3333-4444-555555555555", [
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
          content: [{ type: "text", text: "one" }],
          usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 20 },
        },
        timestamp: "2026-09-20T10:01:00.000Z",
        cwd: "/work/app",
      },
      {
        type: "assistant",
        message: {
          id: "m2",
          model: "claude-opus-5-5",
          content: [{ type: "text", text: "two" }],
          usage: { input_tokens: 10, output_tokens: 5 },
        },
        timestamp: "2026-09-20T10:03:00.000Z",
        cwd: "/work/app",
      },
    ]);

    const list = await service.list("claude", { activityDays: 0 });
    expect(list.sessions[0]?.activity).toEqual([
      {
        date: "2026-09-20",
        tokens: { input: 110, output: 55, cacheRead: 20, cacheWrite: 0 },
        activeSeconds: 180,
        models: [
          {
            model: "claude-opus-5-5",
            tokens: { input: 110, output: 55, cacheRead: 20, cacheWrite: 0 },
          },
        ],
      },
    ]);

    const plain = await service.list("claude");
    expect(plain.sessions[0]?.activity).toBeUndefined();
  });
});
