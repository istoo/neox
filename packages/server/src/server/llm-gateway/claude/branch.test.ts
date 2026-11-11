import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeBridge } from "./bridge.js";
import type { ClaudePromptMessage } from "./prompt.js";
import {
  AsyncQueue,
  type ClaudeRunLike,
  type ClaudeRunOptions,
  type ClaudeToolResult,
} from "./run.js";
import type { ClaudeStreamEvent } from "./stream.js";

const dirs: string[] = [];
const bridges: ClaudeBridge[] = [];

afterEach(async () => {
  for (const bridge of bridges.splice(0)) {
    bridge.abortAll();
  }
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

class FakeRun implements ClaudeRunLike {
  public readonly token: string;
  public running = true;
  public readonly sessionId: string;
  public readonly callsMade = new Set<string>();
  public readonly stderrTail = "";
  private queue = new AsyncQueue<ClaudeStreamEvent>();
  private listener: ((event: ClaudeStreamEvent) => void) | null = null;

  public constructor(token: string, sessionId = "sess-1") {
    this.token = token;
    this.sessionId = sessionId;
  }

  public start(): void {}
  public events(): AsyncGenerator<ClaudeStreamEvent> {
    return this.queue.drain();
  }
  public setEventListener(listener: ((event: ClaudeStreamEvent) => void) | null): void {
    this.listener = listener;
  }
  public sendUserMessage(): void {}
  public sendSaid(): void {}
  public waitsFor(): boolean {
    return this.callsMade.has("c1");
  }
  public deliverToolResult(_id: string, _result: ClaudeToolResult): boolean {
    return true;
  }
  public waitForToolResult(): Promise<ClaudeToolResult | null> {
    return new Promise(() => undefined);
  }
  public abort(): void {
    this.running = false;
  }
  public beginTurn(): AsyncGenerator<ClaudeStreamEvent> {
    this.callsMade.clear();
    this.queue = new AsyncQueue();
    return this.queue.drain();
  }
  public waitForExit(): Promise<void> {
    return new Promise(() => undefined);
  }
  public callUuid(id: string): string | undefined {
    return id === "c1" ? "u-call-1" : undefined;
  }
  public emit(event: ClaudeStreamEvent): void {
    if (event.kind === "toolCall") {
      this.callsMade.add(event.id);
    }
    this.listener?.(event);
    this.queue.push(event);
    if (event.kind === "stop") {
      this.queue.close();
    }
  }
}

const firstTurn: ClaudePromptMessage[] = [
  { role: "user", parts: [{ kind: "text", text: "earlier" }] },
  { role: "assistant", parts: [{ kind: "text", text: "ok" }] },
  { role: "user", parts: [{ kind: "text", text: "hi" }] },
];

const resultsTurn: ClaudePromptMessage[] = [
  ...firstTurn,
  {
    role: "assistant",
    parts: [{ kind: "toolCall", id: "c1", name: "read", arguments: "{}" }],
  },
  {
    role: "user",
    parts: [{ kind: "toolResult", callId: "c1", text: "contents" }],
  },
];

async function setup(): Promise<{
  bridge: ClaudeBridge;
  work: string;
  projects: string;
  runs: ClaudeRunOptions[];
  turns: FakeRun[];
}> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "neolix-claude-branch-"));
  dirs.push(dir);
  const work = path.join(dir, "work");
  const projects = path.join(dir, "projects", "-work");
  await mkdir(work, { recursive: true, mode: 0o700 });
  await mkdir(projects, { recursive: true, mode: 0o700 });
  const runs: ClaudeRunOptions[] = [];
  const turns: FakeRun[] = [];
  const bridge = new ClaudeBridge({
    resolveBinary: async () => "/bin/true",
    createRun: (options) => {
      runs.push(options);
      const resumedAt = options.args.lastIndexOf("--resume");
      const session =
        resumedAt >= 0 && resumedAt + 1 < options.args.length
          ? (options.args[resumedAt + 1] ?? "sess-1")
          : "sess-1";
      const run = new FakeRun(`token-${turns.length + 1}`, session);
      turns.push(run);
      return run;
    },
  });
  bridges.push(bridge);
  return { bridge, work, projects, runs, turns };
}

function request(messages: ClaudePromptMessage[], projects: string) {
  return {
    owner: "p/a",
    model: "claude-haiku",
    request: { messages },
    cwd: path.dirname(projects),
    env: {},
    mcpConfig: "{}",
    sessionDirs: [projects],
    tui: { listedFile: path.join(projects, "listed") },
  };
}

describe("a turn whose tool results another request answered first", () => {
  async function tellCall(projects: string, run: FakeRun): Promise<void> {
    await writeFile(
      path.join(projects, `${run.sessionId}.jsonl`),
      `${JSON.stringify({
        type: "assistant",
        sessionId: run.sessionId,
        uuid: "u-call-1",
        message: { id: "m1", model: "m", content: [] },
      })}\n`,
      { flag: "a" },
    );
  }

  it("goes on from a copy of the run's session, cut after the reply that made the calls", async () => {
    const { bridge, projects, runs, turns } = await setup();
    const first = await bridge.startTurn(request(firstTurn, projects));
    const run = turns[0];
    if (run === undefined) {
      throw new Error("no run");
    }
    await tellCall(projects, run);
    run.emit({ kind: "toolCall", id: "c1", name: "read", arguments: "{}" });
    run.emit({ kind: "stop", stop: "tool_use" });
    expect(first.run).toBe(run);

    const second = await bridge.startTurn(request(resultsTurn, projects));
    expect(second.run).toBe(run);

    const third = await bridge.startTurn(request(resultsTurn, projects));
    expect(third.run).not.toBe(run);
    const branched = runs.at(-1);
    const resumedAt = branched?.args.indexOf("--resume") ?? -1;
    expect(resumedAt).toBeGreaterThanOrEqual(0);
    const resumed = branched?.args[resumedAt + 1] ?? "";
    expect(resumed).not.toBe(run.sessionId);
    // the cut copy is the run's own session through that line, not a
    // transcript replay wrote from the outside
    const copy = await readFile(path.join(projects, `${resumed}.jsonl`), "utf8");
    expect(copy).toContain('"uuid":"u-call-1"');
    expect(copy.trim().split("\n")).toHaveLength(3);
  });

  it("falls back to replay when the cut can't be made", async () => {
    const { bridge, projects, runs, turns } = await setup();
    await bridge.startTurn(request(firstTurn, projects));
    const run = turns[0];
    if (run === undefined) {
      throw new Error("no run");
    }
    run.emit({ kind: "toolCall", id: "c1", name: "read", arguments: "{}" });
    run.emit({ kind: "stop", stop: "tool_use" });
    await bridge.startTurn(request(resultsTurn, projects));

    const third = await bridge.startTurn(request(resultsTurn, projects));
    expect(third.run).not.toBe(run);
    const replayed = runs.at(-1);
    const resumedAt = replayed?.args.indexOf("--resume") ?? -1;
    expect(resumedAt).toBeGreaterThanOrEqual(0);
    const resumed = replayed?.args[resumedAt + 1] ?? "";
    expect(resumed).not.toBe(run.sessionId);
    const copy = await readFile(path.join(projects, `${resumed}.jsonl`), "utf8");
    expect(copy).not.toContain("u-call-1");
    expect(copy.trim().split("\n")).toHaveLength(2);
    expect(copy).toContain('"parentUuid":null');
  });
});
