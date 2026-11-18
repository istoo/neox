import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ExternalSessionsService } from "./service.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const CONVERSATION = "conv-1";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "neolix-agy-"));
  roots.push(root);
  const neolixHome = path.join(root, "neox-home");
  const agyDir = path.join(root, "antigravity-cli");
  await mkdir(neolixHome, { recursive: true });
  await mkdir(path.join(agyDir, "brain", CONVERSATION, ".system_generated", "logs"), {
    recursive: true,
  });
  const service = new ExternalSessionsService({
    neolixHome,
    homeDir: root,
    env: {
      CLAUDE_CONFIG_DIR: path.join(root, "claude"),
      CODEX_HOME: path.join(root, "codex"),
      PI_CODING_AGENT_DIR: path.join(root, "pi"),
      XDG_DATA_HOME: path.join(root, "data"),
      AGY_DIR: agyDir,
    },
  });
  return { root, agyDir, service };
}

async function writeSummaries(
  agyDir: string,
  rows: readonly { id: string; title: string; cwd: string; last: string }[],
): Promise<void> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path.join(agyDir, "conversation_summaries.db"));
  db.exec(
    `CREATE TABLE conversation_summaries (
       conversation_id text PRIMARY KEY, title text, workspace_uris text, last_modified_time text
     )`,
  );
  const insert = db.prepare(
    "INSERT INTO conversation_summaries (conversation_id, title, workspace_uris, last_modified_time) VALUES (?, ?, ?, ?)",
  );
  for (const row of rows) {
    insert.run(row.id, row.title, JSON.stringify([pathToFileURL(row.cwd).href]), row.last);
  }
  db.close();
}

async function writeTranscript(
  agyDir: string,
  lines: readonly Record<string, unknown>[],
): Promise<string> {
  const file = path.join(
    agyDir,
    "brain",
    CONVERSATION,
    ".system_generated",
    "logs",
    "transcript_full.jsonl",
  );
  await writeFile(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
  return file;
}

describe("ExternalSessionsService Antigravity", () => {
  it("lists a conversation from its transcript and its summary row", async () => {
    const { agyDir, service } = await fixture();
    // Antigravity resumes with a folder of this host's own shape.
    const cwd = process.platform === "win32" ? "C:\\work\\agy" : "/work/agy";
    await writeSummaries(agyDir, [
      {
        id: CONVERSATION,
        title: "Read a file",
        cwd,
        last: "2026-10-25 09:48:56.074501+00:00",
      },
    ]);
    await writeTranscript(agyDir, [
      {
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        created_at: "2026-10-25T09:48:50.000Z",
        content: "<USER_REQUEST>\nread a.txt\n</USER_REQUEST>\n<ADDITIONAL_METADATA>x",
      },
      {
        step_index: 1,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        created_at: "2026-10-25T09:48:52.000Z",
        input_tokens: 1500,
        cache_read_tokens: 500,
        output_tokens: 50,
        thinking: "Opening the file",
        tool_calls: [{ name: "read_file", args: { Path: "a.txt" } }],
      },
      {
        step_index: 2,
        source: "MODEL",
        type: "GENERIC",
        created_at: "2026-10-25T09:48:54.000Z",
        content: "Created At: now\nCompleted At: now\n1: hi",
      },
      {
        step_index: 3,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        created_at: "2026-10-25T09:48:55.000Z",
        input_tokens: 1600,
        output_tokens: 60,
        content: "The file says hi.",
      },
    ]);

    const list = await service.list("agy");

    expect(list.agents).toEqual([{ agent: "agy", name: "Antigravity", count: 1, deletable: true }]);
    expect(list.sessions[0]).toMatchObject({
      id: CONVERSATION,
      cwd,
      title: "Read a file",
      messages: 2,
      deletable: true,
      resume:
        process.platform === "win32"
          ? `Set-Location -LiteralPath '${cwd}'; agy --conversation conv-1`
          : `cd '${cwd}' && agy --conversation conv-1`,
    });
    expect(list.sessions[0]?.tokens).toEqual({
      input: 3100,
      output: 110,
      cacheRead: 500,
      cacheWrite: 0,
    });
  });

  it("reads a conversation's steps in order, last write first place", async () => {
    const { agyDir, service } = await fixture();
    await writeTranscript(agyDir, [
      {
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        created_at: "2026-10-25T09:48:50.000Z",
        content: "<USER_REQUEST>read a.txt</USER_REQUEST>",
      },
      {
        step_index: 1,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        created_at: "2026-10-25T09:48:52.000Z",
        thinking: "Opening the file",
        tool_calls: [{ name: "read_file", args: { Path: "a.txt" } }],
      },
      {
        step_index: 2,
        source: "MODEL",
        type: "GENERIC",
        created_at: "2026-10-25T09:48:54.000Z",
        content: "Created At: now\nCompleted At: now\n1: hi",
      },
      {
        step_index: 1,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        created_at: "2026-10-25T09:48:52.000Z",
        content: "I read it",
      },
    ]);

    const transcript = await service.transcript({ agent: "agy", id: CONVERSATION });

    expect(transcript.parts.map((part) => [part.role, part.kind, part.name ?? ""])).toEqual([
      ["user", "text", ""],
      ["assistant", "text", ""],
      ["tool", "tool_result", ""],
    ]);
    expect(transcript.parts[0]?.text).toBe("read a.txt");
    expect(transcript.parts[1]?.text).toBe("I read it");
    expect(transcript.parts[2]?.text).toBe("1: hi");
  });
});
