import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeBridge } from "./bridge.js";
import { installFakeClaude } from "./testing/fake-claude.js";
import { ClaudeTuiRun, interactiveArgs } from "./tui-run.js";
import type { ClaudeStreamEvent } from "./stream.js";

const dirs: string[] = [];
const runs: Array<{ abort(): void }> = [];

afterEach(async () => {
  for (const run of runs.splice(0)) {
    run.abort();
  }
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

const SCRIPT = `
sid=""
prev=""
for a in "$@"; do
  [ "$prev" = "--session-id" ] && sid="$a"
  prev="$a"
done
f="$TUI_PROJECTS/$sid.jsonl"
stty raw -echo
printf '❯ '
while :; do
  head=""
  while :; do
    c=$(dd bs=1 count=1 2>/dev/null) || exit 0
    head="$head$c"
    case "$head" in *'[200~'*) break;; esac
  done
  body=""
  while :; do
    c=$(dd bs=1 count=1 2>/dev/null) || exit 0
    body="$body$c"
    case "$body" in *'[201~'*) break;; esac
  done
  body=\${body%'[201~'}
  body=$(printf '%s' "$body" | tr -d '\\033')
  while :; do
    c=$(dd bs=1 count=1 2>/dev/null) || exit 0
    [ "$c" = "$(printf '\r')" ] && break
  done
  printf '{"type":"user","message":{"content":[{"type":"text","text":"%s"}]}}\\n' "$body" >> "$f"
  printf '{"type":"assistant","uuid":"u1","message":{"id":"msg_1","model":"m","content":[{"type":"text","text":"reply:%s"}]}}\\n' "$body" >> "$f"
  printf '{"type":"system","subtype":"turn_duration"}\\n' >> "$f"
  printf '❯ '
done
`;

async function setup(): Promise<{
  binary: string;
  work: string;
  projects: string;
}> {
  const fake = await installFakeClaude(SCRIPT);
  dirs.push(fake.dir);
  const dir = await mkdtemp(path.join(os.tmpdir(), "neolix-claude-tui-run-"));
  dirs.push(dir);
  const work = path.join(dir, "work");
  const projects = path.join(dir, "projects", "-work");
  await mkdir(work, { recursive: true, mode: 0o700 });
  await mkdir(projects, { recursive: true, mode: 0o700 });
  return { binary: fake.binary, work, projects };
}

describe("interactiveArgs", () => {
  it("keeps what the interactive mode takes and drops what only -p does", () => {
    expect(
      interactiveArgs([
        "-p",
        "--output-format",
        "stream-json",
        "--include-partial-messages",
        "--verbose",
        "--model",
        "claude-haiku",
        "--json-schema",
        "{}",
        "--tools",
        "WebSearch",
        "--mcp-config",
        "{}",
        "--dangerously-skip-permissions",
      ]),
    ).toEqual([
      "--model",
      "claude-haiku",
      "--tools",
      "WebSearch",
      "--mcp-config",
      "{}",
      "--permission-mode",
      "default",
      "--allowedTools",
      "mcp__neox,WebSearch",
      "--no-chrome",
    ]);
  });
});

describe("ClaudeTuiRun through the bridge", { timeout: 20_000 }, () => {
  it("types the turn into Claude Code's prompt and tells its transcript, with no tap to tell it whole", async () => {
    const { binary, work, projects } = await setup();
    const bridge = new ClaudeBridge({
      resolveBinary: async () => binary,
      createRun: (options, input, sessionDirs) =>
        new ClaudeTuiRun({
          ...options,
          sessionDirs,
          createTap: async () => null,
          readyTimeoutMs: 10_000,
        }),
    });
    const handle = await bridge.startTurn({
      owner: "p/a",
      model: "claude-haiku",
      request: {
        messages: [{ role: "user", parts: [{ kind: "text", text: "hello" }] }],
      },
      cwd: work,
      env: { PATH: "/usr/bin:/bin", TUI_PROJECTS: projects },
      mcpConfig: "{}",
      sessionDirs: [projects],
      tui: { listedFile: path.join(work, "listed") },
    });
    runs.push(handle.run);
    const events: ClaudeStreamEvent[] = [];
    for await (const event of handle.events) {
      events.push(event);
    }
    expect(events).toContainEqual({ kind: "text", text: "reply:Human: hello" });
    expect(handle.run.sessionId).not.toBe("");
    expect(await readFile(path.join(projects, `${handle.run.sessionId}.jsonl`), "utf8")).toContain(
      "reply:Human: hello",
    );
  });

  it("fails the turn when the interactive mode does not come up, never running -p instead", async () => {
    const fake = await installFakeClaude(`printf 'not a terminal Claude Code\\n'\nexit 1\n`);
    dirs.push(fake.dir);
    const dir = await mkdtemp(path.join(os.tmpdir(), "neolix-claude-tui-run-"));
    dirs.push(dir);
    const projects = path.join(dir, "projects", "-work");
    await mkdir(projects, { recursive: true, mode: 0o700 });
    const bridge = new ClaudeBridge({
      resolveBinary: async () => fake.binary,
      createRun: (options, input, sessionDirs) =>
        new ClaudeTuiRun({
          ...options,
          sessionDirs,
          createTap: async () => null,
          readyTimeoutMs: 5_000,
        }),
    });
    const handle = await bridge.startTurn({
      owner: "p/a",
      model: "claude-haiku",
      request: { messages: [{ role: "user", parts: [{ kind: "text", text: "hello" }] }] },
      cwd: dir,
      env: { PATH: "/usr/bin:/bin", TUI_PROJECTS: projects },
      mcpConfig: "{}",
      sessionDirs: [projects],
      tui: { listedFile: path.join(dir, "listed") },
    });
    runs.push(handle.run);
    const events: ClaudeStreamEvent[] = [];
    for await (const event of handle.events) {
      events.push(event);
    }
    expect(events.some((event) => event.kind === "error")).toBe(true);
    expect(events.some((event) => event.kind === "text")).toBe(false);
  });

  it("fails the turn when the tools are never listed, after its ready wait", async () => {
    const fake = await installFakeClaude(`printf '❯ '\nwhile :; do sleep 1; done\n`);
    dirs.push(fake.dir);
    const dir = await mkdtemp(path.join(os.tmpdir(), "neolix-claude-tui-run-"));
    dirs.push(dir);
    const projects = path.join(dir, "projects", "-work");
    await mkdir(projects, { recursive: true, mode: 0o700 });
    const bridge = new ClaudeBridge({
      resolveBinary: async () => fake.binary,
      createRun: (options, input, sessionDirs) =>
        new ClaudeTuiRun({
          ...options,
          sessionDirs,
          createTap: async () => null,
          // the prompt must be drawn before this ends: the turn under test
          // fails because its tools are never listed, not because the
          // pseudo terminal was slow to start
          readyTimeoutMs: 5_000,
          ...(input.tui === undefined ? {} : { listedFile: input.tui.listedFile }),
        }),
    });
    const handle = await bridge.startTurn({
      owner: "p/a",
      model: "claude-haiku",
      request: { messages: [{ role: "user", parts: [{ kind: "text", text: "hello" }] }] },
      cwd: dir,
      env: { PATH: "/usr/bin:/bin", TUI_PROJECTS: projects },
      mcpConfig: "{}",
      sessionDirs: [projects],
      tui: { listedFile: path.join(dir, "never-listed") },
    });
    runs.push(handle.run);
    const events: ClaudeStreamEvent[] = [];
    for await (const event of handle.events) {
      events.push(event);
    }
    expect(events).toContainEqual({
      kind: "error",
      message: expect.stringContaining("had not listed its MCP tools"),
    });
    expect(events.some((event) => event.kind === "text")).toBe(false);
  });
});
