import { access, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claudeProjectDir } from "../agent/providers/claude/project-dir.js";
import { ExternalSessionsService } from "./service.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "neolix-relocate-"));
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
  return { root, neolixHome, claudeDir, codexHome, piHome, service };
}

async function oldTimes(...files: readonly string[]): Promise<void> {
  const old = new Date(Date.now() - 5 * 60_000);
  for (const file of files) {
    await utimes(file, old, old);
  }
}

const CODEX_ID = "01a0bdc9-b5fd-7e63-9658-68bc8dce5ecd";

async function writeCodexRollout(codexHome: string, provider: string): Promise<string> {
  const dir = path.join(codexHome, "sessions", "2026", "09", "20");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-09-20T15-48-28-${CODEX_ID}.jsonl`);
  await writeFile(
    file,
    [
      {
        timestamp: "2026-09-20T15:48:28.100Z",
        type: "session_meta",
        payload: { id: CODEX_ID, cwd: "/work/codex", model_provider: provider },
      },
      {
        timestamp: "2026-09-20T15:48:29.100Z",
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Hi" }] },
      },
    ]
      .map((line) => JSON.stringify(line))
      .join("\n"),
    "utf8",
  );
  await oldTimes(file);
  return file;
}

describe("ExternalSessionsService codex provider moves", () => {
  it("rewrites the rollout and Codex's thread row, keeping a copy first", async () => {
    const { service, codexHome, neolixHome } = await fixture();
    const file = await writeCodexRollout(codexHome, "custom");
    const { DatabaseSync } = await import("node:sqlite");
    const dbFile = path.join(codexHome, "state_1.sqlite");
    const db = new DatabaseSync(dbFile);
    db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, model_provider TEXT)");
    db.prepare("INSERT INTO threads (id, model_provider) VALUES (?, ?)").run(CODEX_ID, "custom");
    db.close();

    const result = await service.codexProvider([{ id: CODEX_ID, to: "neolix" }]);

    expect(result.refused).toEqual([]);
    expect(result.moved[0]).toMatchObject({ id: CODEX_ID, from: "custom", to: "neolix" });
    expect(await readFile(file, "utf8")).toContain('"model_provider":"neolix"');
    const check = new DatabaseSync(dbFile);
    const row = check.prepare("SELECT model_provider FROM threads WHERE id = ?").get(CODEX_ID) as {
      model_provider: string;
    };
    check.close();
    expect(row.model_provider).toBe("neolix");
    const backup = result.moved[0]?.backup ?? "";
    expect(backup.startsWith(path.join(neolixHome, "trash", "codex-provider"))).toBe(true);
    expect(
      await readFile(path.join(backup, "files", `0-${path.basename(file)}`), "utf8"),
    ).toContain('"model_provider":"custom"');
  });

  it("leaves a session written to in the last minute alone", async () => {
    const { service, codexHome } = await fixture();
    const file = await writeCodexRollout(codexHome, "custom");
    const now = new Date();
    await utimes(file, now, now);

    const result = await service.codexProvider([{ id: CODEX_ID, to: "neolix" }]);

    expect(result.moved).toEqual([]);
    expect(result.refused[0]?.active).toBe(true);
    expect(await readFile(file, "utf8")).toContain('"model_provider":"custom"');
  });
});

async function writeClaudeProject(
  claudeDir: string,
  projectPath: string,
): Promise<{
  storage: string;
  sessionId: string;
  transcript: string;
  subagent: string;
  index: string;
}> {
  const storage = path.join(claudeDir, "projects", projectPath.replace(/[^a-zA-Z0-9]/gu, "-"));
  await mkdir(path.join(storage, "session-one", "subagents"), { recursive: true });
  const sessionId = "session-one";
  const transcript = path.join(storage, `${sessionId}.jsonl`);
  await writeFile(
    transcript,
    [
      {
        type: "user",
        cwd: projectPath,
        message: { content: "Move me" },
        timestamp: "2026-09-20T10:00:00.000Z",
      },
      {
        type: "assistant",
        cwd: projectPath,
        message: { id: "m1", model: "claude-opus-5-5", content: [{ type: "text", text: "ok" }] },
        timestamp: "2026-09-20T10:00:05.000Z",
      },
    ]
      .map((line) => JSON.stringify(line))
      .join("\n"),
    "utf8",
  );
  const subagent = path.join(storage, sessionId, "subagents", "agent-sub1.jsonl");
  await writeFile(
    subagent,
    JSON.stringify({ type: "user", cwd: projectPath, message: { content: "Sub" } }),
    "utf8",
  );
  const index = path.join(storage, "sessions-index.json");
  await writeFile(
    index,
    JSON.stringify({
      originalPath: projectPath,
      entries: [{ projectPath, fullPath: storage }],
    }),
    "utf8",
  );
  await oldTimes(
    transcript,
    subagent,
    index,
    path.join(storage, sessionId, "subagents"),
    path.join(storage, sessionId),
    storage,
  );
  return { storage, sessionId, transcript, subagent, index };
}

describe("ExternalSessionsService Claude relocation", () => {
  it("previews, then moves a project's sessions, rewriting each cwd", async () => {
    const { service, claudeDir, root } = await fixture();
    const from = path.join(root, "old-project");
    const to = path.join(root, "new-project");
    await mkdir(to, { recursive: true });
    const files = await writeClaudeProject(claudeDir, from);

    const preview = await service.relocateClaude({ from, to });

    expect(preview.preview).toMatchObject({ from, to, sessions: 1 });
    expect(preview.preview?.bytes).toBeGreaterThan(0);
    expect(preview.token).toBeTypeOf("string");
    expect(preview.backup).toBeNull();
    await expect(access(files.storage)).resolves.toBeUndefined();

    const applied = await service.relocateClaude({ from, to, token: preview.token ?? "" });

    expect(applied.preview).toBeNull();
    expect(applied.token).toBeNull();
    expect(applied.backup).toBeTypeOf("string");
    await expect(access(files.storage)).rejects.toThrow();
    const dest = await claudeProjectDir(to, { configDir: claudeDir });
    const moved = path.join(dest, `${files.sessionId}.jsonl`);
    const movedText = await readFile(moved, "utf8");
    expect(movedText).toContain(JSON.stringify(to));
    expect(movedText).not.toContain(JSON.stringify(from));
    const movedSub = await readFile(
      path.join(dest, files.sessionId, "subagents", "agent-sub1.jsonl"),
      "utf8",
    );
    expect(movedSub).toContain(JSON.stringify(to));
    const index = JSON.parse(await readFile(path.join(dest, "sessions-index.json"), "utf8")) as {
      originalPath: string;
    };
    expect(index.originalPath).toBe(to);
    expect(await stat(path.join(applied.backup ?? "", "original"))).toBeDefined();
    expect(
      await readFile(
        path.join(applied.backup ?? "", "original", `${files.sessionId}.jsonl`),
        "utf8",
      ),
    ).toContain(JSON.stringify(from));

    const list = await service.list("claude");
    expect(list.sessions[0]?.cwd).toBe(to);
  });

  it("refuses a token it did not preview, a missing target, and existing storage", async () => {
    const { service, claudeDir, root } = await fixture();
    const from = path.join(root, "old-project");
    const to = path.join(root, "new-project");
    await writeClaudeProject(claudeDir, from);

    await expect(service.relocateClaude({ from, to })).rejects.toThrow(
      "the target project directory does not exist",
    );

    await mkdir(to, { recursive: true });
    const preview = await service.relocateClaude({ from, to });
    await expect(
      service.relocateClaude({ from, to, token: "not-a-preview-token" }),
    ).rejects.toThrow("preview the relocation again");

    const dest = await claudeProjectDir(to, { configDir: claudeDir });
    await mkdir(dest, { recursive: true });
    await expect(service.relocateClaude({ from, to, token: preview.token ?? "" })).rejects.toThrow(
      "target Claude project storage already exists",
    );
  });

  it("leaves a project written to in the last minute alone", async () => {
    const { service, claudeDir, root } = await fixture();
    const from = path.join(root, "old-project");
    const to = path.join(root, "new-project");
    await mkdir(to, { recursive: true });
    const files = await writeClaudeProject(claudeDir, from);
    const now = new Date();
    await utimes(files.transcript, now, now);

    await expect(service.relocateClaude({ from, to })).rejects.toThrow("still be running");
  });
});

describe("ExternalSessionsService packed Codex rollouts", () => {
  it("lists and moves one Codex packed after its last turn", async () => {
    const { service, codexHome } = await fixture();
    const dir = path.join(codexHome, "sessions", "2026", "09", "20");
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `rollout-2026-09-20T15-48-28-${CODEX_ID}.jsonl.zst`);
    const text = `${JSON.stringify({
      type: "session_meta",
      payload: { id: CODEX_ID, cwd: "/work/codex", model_provider: "custom" },
    })}\n`;
    await writeFile(file, zstdCompressSync(Buffer.from(text, "utf8")));
    await oldTimes(file);

    const list = await service.list("codex");
    expect(list.sessions[0]).toMatchObject({ id: CODEX_ID, provider: "custom" });

    const result = await service.codexProvider([{ id: CODEX_ID, to: "neolix" }]);

    expect(result.refused).toEqual([]);
    const rewritten = zstdDecompressSync(await readFile(file)).toString("utf8");
    expect(rewritten).toContain('"model_provider":"neolix"');
  });

  it("moves the thread row in the database config.toml names", async () => {
    const { service, codexHome } = await fixture();
    await mkdir(codexHome, { recursive: true });
    await writeFile(path.join(codexHome, "config.toml"), 'sqlite_home = "state"\n', "utf8");
    await writeCodexRollout(codexHome, "custom");
    const stateDir = path.join(codexHome, "state");
    await mkdir(stateDir, { recursive: true });
    const dbFile = path.join(stateDir, "state_1.sqlite");
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbFile);
    db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, model_provider TEXT)");
    db.prepare("INSERT INTO threads (id, model_provider) VALUES (?, ?)").run(CODEX_ID, "custom");
    db.close();

    const result = await service.codexProvider([{ id: CODEX_ID, to: "neolix" }]);

    expect(result.refused).toEqual([]);
    const check = new DatabaseSync(dbFile);
    const row = check.prepare("SELECT model_provider FROM threads WHERE id = ?").get(CODEX_ID) as {
      model_provider: string;
    };
    check.close();
    expect(row.model_provider).toBe("neolix");
  });
});
