import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createExternalProcessEnv } from "../../neolix-env.js";
import { ClaudeBridge } from "./bridge.js";
import { installFakeClaude } from "./testing/fake-claude.js";
import { ClaudeTuiRun, interactiveArgs } from "./tui-run.js";
import type { ClaudeStreamEvent } from "./stream.js";

const dirs: string[] = [];
const runs: Array<{ abort(): void; waitForExit(): Promise<void> }> = [];

afterEach(async () => {
  const stopped = runs.splice(0);
  for (const run of stopped) {
    run.abort();
  }
  // The run's cwd is one of these temp dirs; Windows refuses to remove it
  // until the process behind cmd.exe has exited.
  await Promise.all(stopped.map((run) => run.waitForExit()));
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

const SCRIPT = `
const args = process.argv.slice(2);
let sid = "";
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--session-id" && i + 1 < args.length) {
    sid = args[i + 1];
  }
}
const file = path.join(process.env.TUI_PROJECTS, sid + ".jsonl");
let buffer = "";
let mode = "idle";
let body = "";
function writeRow(text) {
  fs.appendFileSync(file, JSON.stringify({ type: "user", message: { content: [{ type: "text", text: text }] } }) + "\\n");
  fs.appendFileSync(file, JSON.stringify({ type: "assistant", uuid: "u1", message: { id: "msg_1", model: "m", content: [{ type: "text", text: "reply:" + text }] } }) + "\\n");
  fs.appendFileSync(file, JSON.stringify({ type: "system", subtype: "turn_duration" }) + "\\n");
}
function pump(chunk) {
  buffer += chunk;
  if (mode === "sent") {
    const enter = buffer.indexOf("\\r");
    if (enter === -1) {
      return;
    }
    buffer = buffer.slice(enter + 1);
    writeRow(body.replace(/\\u001b/g, "").replace(/\\n+$/, ""));
    mode = "idle";
    outRaw("\\u276f ");
    return;
  }
  for (;;) {
    if (mode === "idle") {
      const start = buffer.indexOf("\\u001b[200~");
      if (start === -1) {
        if (buffer.length > 6) {
          buffer = buffer.slice(-6);
        }
        return;
      }
      buffer = buffer.slice(start + 6);
      body = "";
      mode = "body";
      continue;
    }
    const end = buffer.indexOf("\\u001b[201~");
    if (end === -1) {
      body += buffer;
      buffer = "";
      return;
    }
    body += buffer.slice(0, end);
    buffer = buffer.slice(end + 6);
    mode = "sent";
    pump("");
    return;
  }
}
outRaw("\\u276f ");
onKeys(pump);
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
      // A real turn's env starts from process.env, which Node on Windows
      // needs (SystemRoot among it) to start; keep the fixture's overrides.
      env: createExternalProcessEnv(process.env, {
        PATH: "/usr/bin:/bin",
        TUI_PROJECTS: projects,
      }),
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
    const fake = await installFakeClaude(`out("not a terminal Claude Code"); process.exit(1);`);
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
      // A real turn's env starts from process.env, which Node on Windows
      // needs (SystemRoot among it) to start; keep the fixture's overrides.
      env: createExternalProcessEnv(process.env, {
        PATH: "/usr/bin:/bin",
        TUI_PROJECTS: projects,
      }),
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
    const fake = await installFakeClaude(`outRaw("\\u276f "); keepAlive();`);
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
      // A real turn's env starts from process.env, which Node on Windows
      // needs (SystemRoot among it) to start; keep the fixture's overrides.
      env: createExternalProcessEnv(process.env, {
        PATH: "/usr/bin:/bin",
        TUI_PROJECTS: projects,
      }),
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
