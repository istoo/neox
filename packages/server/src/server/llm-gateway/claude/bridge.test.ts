import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeBridge, type ClaudeTurnInput } from "./bridge.js";
import { ClaudeRoom, ClaudeRoomFullError } from "./room.js";
import type { ClaudePromptMessage } from "./prompt.js";
import type { ClaudeRun } from "./run.js";
import type { ClaudeStreamEvent } from "./stream.js";
import { installFakeClaude } from "./testing/fake-claude.js";

const cleanup: string[] = [];
const runs: ClaudeRun[] = [];
const bridges: ClaudeBridge[] = [];

afterEach(async () => {
  for (const bridge of bridges.splice(0)) {
    bridge.abortAll();
  }
  for (const dir of cleanup.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
  await Promise.all(runs.splice(0).map((run) => run.waitForExit()));
});

const user = (text: string): ClaudePromptMessage => ({
  role: "user",
  parts: [{ kind: "text", text }],
});

const reply = (text: string): ClaudePromptMessage => ({
  role: "assistant",
  parts: [{ kind: "text", text }],
});

function turnScript(): string {
  return `
n=0
while read -r line; do
  n=$((n+1))
  printf '%s\\n' \\
    '{"type":"stream_event","event":{"type":"message_start","message":{"id":"m","model":"claude-sonnet-5","usage":{"input_tokens":10}}}}' \\
    '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"pid '"$$"' turn '$n'"}}}' \\
    '{"type":"stream_event","event":{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}}' \\
    '{"type":"stream_event","event":{"type":"message_stop"}}'
done
`;
}

function callScript(): string {
  return `
n=0
while read -r line; do
  n=$((n+1))
  if [ "$n" = "1" ]; then
    printf '%s\\n' \\
      '{"type":"stream_event","event":{"type":"message_start","message":{"id":"m1","model":"claude-sonnet-5","usage":{"input_tokens":1}}}}' \\
      '{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"mcp__neox__read"}}}' \\
      '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"a\\"}"}}}' \\
      '{"type":"stream_event","event":{"type":"content_block_stop","index":0}}' \\
      '{"type":"stream_event","event":{"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":2}}}' \\
      '{"type":"stream_event","event":{"type":"message_stop"}}'
    while [ ! -f "$SIGNAL" ]; do sleep 0.01; done
    printf '%s\\n' \\
      '{"type":"stream_event","event":{"type":"message_start","message":{"id":"m2","model":"claude-sonnet-5","usage":{"input_tokens":2}}}}' \\
      '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"done"}}}' \\
      '{"type":"stream_event","event":{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}}' \\
      '{"type":"stream_event","event":{"type":"message_stop"}}'
  fi
done
`;
}

async function waitForText(file: string, needle: string): Promise<string> {
  for (let tries = 0; tries < 200; tries += 1) {
    const text = await readFile(file, "utf8").catch(() => "");
    if (text.includes(needle)) {
      return text;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${needle}`);
}

async function collect(events: AsyncIterable<ClaudeStreamEvent>): Promise<ClaudeStreamEvent[]> {
  const out: ClaudeStreamEvent[] = [];
  for await (const event of events) {
    out.push(event);
  }
  return out;
}

async function turnInput(
  messages: readonly ClaudePromptMessage[],
  env: Readonly<Record<string, string>> = {},
  sessionDirs?: readonly string[],
): Promise<ClaudeTurnInput> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "neolix-claude-turn-"));
  cleanup.push(dir);
  return {
    owner: "provider/account",
    model: "claude-sonnet-5",
    request: { messages },
    cwd: dir,
    env: { PATH: "/usr/bin:/bin", ...env },
    mcpConfig: "{}",
    sessionDirs,
  };
}

/** A fake that says its session id and records its argv and each stdin line. */
function sessionScript(): string {
  return `
if [ -n "$NEOLIX_ARGS" ]; then echo "$@" >> "$NEOLIX_ARGS"; fi
n=0
while read -r line; do
  n=$((n+1))
  if [ -n "$NEOLIX_INPUT" ]; then printf '%s\\n' "$line" >> "$NEOLIX_INPUT"; fi
  printf '%s\\n' \\
    '{"session_id":"ses-'"$$"'","type":"stream_event","event":{"type":"message_start","message":{"id":"m","model":"claude-sonnet-5","usage":{"input_tokens":1}}}}' \\
    '{"session_id":"ses-'"$$"'","type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"pid '"$$"' turn '$n'"}}}' \\
    '{"session_id":"ses-'"$$"'","type":"stream_event","event":{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}}' \\
    '{"session_id":"ses-'"$$"'","type":"stream_event","event":{"type":"message_stop"}}'
done
`;
}

function saidOf(events: readonly ClaudeStreamEvent[]): string {
  return events
    .filter((event) => event.kind === "text")
    .map((event) => (event.kind === "text" ? event.text : ""))
    .join("");
}

describe("ClaudeBridge", () => {
  it("keeps one process for a conversation's next turn", async () => {
    const { dir, binary } = await installFakeClaude(turnScript());
    cleanup.push(dir);
    const bridge = new ClaudeBridge({ resolveBinary: async () => binary });
    bridges.push(bridge);

    const first = await bridge.startTurn(await turnInput([user("hi")]));
    runs.push(first.run);
    const firstEvents = await collect(first.events);
    const said = firstEvents
      .filter((event) => event.kind === "text")
      .map((event) => (event.kind === "text" ? event.text : ""))
      .join("");
    expect(said).toBe(`pid ${first.run.pid} turn 1`);

    const second = await bridge.startTurn(await turnInput([user("hi"), reply(said), user("next")]));
    expect(second.run).toBe(first.run);
    const secondEvents = await collect(second.events);
    expect(secondEvents.filter((event) => event.kind === "text")).toEqual([
      { kind: "text", text: `pid ${first.run.pid} turn 2` },
    ]);
    bridge.abortAll();
  });

  it("starts another process for another conversation", async () => {
    const { dir, binary } = await installFakeClaude(turnScript());
    cleanup.push(dir);
    const bridge = new ClaudeBridge({ resolveBinary: async () => binary });
    bridges.push(bridge);
    const first = await bridge.startTurn(await turnInput([user("hi")]));
    runs.push(first.run);
    await collect(first.events);
    const other = await bridge.startTurn(await turnInput([user("something else")]));
    runs.push(other.run);
    await collect(other.events);
    expect(other.run.pid).not.toBe(first.run.pid);
    bridge.abortAll();
  });

  it("holds a tool call until the client's next request brings its result", async () => {
    const { dir, binary } = await installFakeClaude(callScript());
    cleanup.push(dir);
    const bridge = new ClaudeBridge({ resolveBinary: async () => binary });
    bridges.push(bridge);
    const signalDir = await mkdtemp(path.join(os.tmpdir(), "neolix-claude-signal-"));
    cleanup.push(signalDir);
    const signal = path.join(signalDir, "go");
    const ask = [user("read it")];
    const first = await bridge.startTurn(await turnInput(ask, { SIGNAL: signal }));
    runs.push(first.run);
    const firstEvents = await collect(first.events);
    expect(firstEvents).toEqual([
      { kind: "toolCall", id: "toolu_1", name: "mcp__neox__read", arguments: '{"path":"a"}' },
      {
        kind: "usage",
        usage: {
          inputTokens: 1,
          outputTokens: 2,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
        },
      },
      { kind: "stop", stop: "tool_use" },
    ]);

    const held = bridge.handleToolCall({
      token: first.run.token,
      toolCallId: "toolu_1",
      name: "mcp__neox__read",
      arguments: '{"path":"a"}',
    });
    const withResult: ClaudePromptMessage[] = [
      ...ask,
      {
        role: "assistant",
        parts: [{ kind: "toolCall", id: "toolu_1", name: "read", arguments: '{"path":"a"}' }],
      },
      { role: "user", parts: [{ kind: "toolResult", callId: "toolu_1", text: "contents" }] },
    ];
    const second = await bridge.startTurn(await turnInput(withResult));
    expect(second.run).toBe(first.run);
    await expect(held).resolves.toEqual({
      status: 200,
      body: { content: [{ type: "text", text: "contents" }], is_error: false },
    });
    await writeFile(signal, "");
    const secondEvents = await collect(second.events);
    expect(secondEvents).toContainEqual({ kind: "text", text: "done" });
    bridge.abortAll();
  });

  it("shelves a conversation let go past idleMost and resumes its session", async () => {
    const { dir, binary } = await installFakeClaude(sessionScript());
    cleanup.push(dir);
    const argsFile = path.join(dir, "args");
    const sessionDir = path.join(dir, "config", "projects", "-work");
    const bridge = new ClaudeBridge({ resolveBinary: async () => binary, idleMost: 1 });
    bridges.push(bridge);
    const env = { NEOLIX_ARGS: argsFile };

    const first = await bridge.startTurn(await turnInput([user("a")], env, [sessionDir]));
    runs.push(first.run);
    const replyA = saidOf(await collect(first.events));

    // Another conversation takes the only idle place; the first is shelved.
    const other = await bridge.startTurn(await turnInput([user("b")], env, [sessionDir]));
    runs.push(other.run);
    await collect(other.events);

    const again = await bridge.startTurn(
      await turnInput([user("a"), reply(replyA), user("more")], env, [sessionDir]),
    );
    runs.push(again.run);
    await collect(again.events);
    expect(again.run.pid).not.toBe(first.run.pid);
    const invocations = (await readFile(argsFile, "utf8")).trim().split("\n");
    const last = invocations.at(-1) ?? "";
    expect(last).toContain(`--resume ses-${first.run.pid}`);
    expect(last).not.toContain("--no-session-persistence");
  });

  it("writes a transcript for a conversation no run had", async () => {
    const { dir, binary } = await installFakeClaude(sessionScript());
    cleanup.push(dir);
    const argsFile = path.join(dir, "args");
    const inputFile = path.join(dir, "input");
    const sessionDir = path.join(dir, "config", "projects", "-work");
    const bridge = new ClaudeBridge({ resolveBinary: async () => binary });
    bridges.push(bridge);
    const turn = await bridge.startTurn(
      await turnInput(
        [user("hi"), reply("hello"), user("next")],
        { NEOLIX_ARGS: argsFile, NEOLIX_INPUT: inputFile },
        [sessionDir],
      ),
    );
    runs.push(turn.run);
    const args = await waitForText(argsFile, "--resume");
    expect(args).toContain("--resume");
    const typed = await waitForText(inputFile, "Human: next");
    expect(typed).not.toContain("Human: hi");
    await collect(turn.events);
  });

  it("lets an idle run go when another asks for room", async () => {
    const { dir, binary } = await installFakeClaude(turnScript());
    cleanup.push(dir);
    const room = new ClaudeRoom({ most: 1, waitMs: 500 });
    const bridge = new ClaudeBridge({ resolveBinary: async () => binary, room });
    bridges.push(bridge);
    const first = await bridge.startTurn(await turnInput([user("hi")]));
    runs.push(first.run);
    await collect(first.events);
    const second = await bridge.startTurn(await turnInput([user("other")]));
    runs.push(second.run);
    await collect(second.events);
    expect(second.run.pid).not.toBe(first.run.pid);
  });

  it("answers 503 when every place is busy", async () => {
    const { dir, binary } = await installFakeClaude("sleep 5");
    cleanup.push(dir);
    const room = new ClaudeRoom({ most: 1, waitMs: 20 });
    const bridge = new ClaudeBridge({ resolveBinary: async () => binary, room });
    bridges.push(bridge);
    const busy = await bridge.startTurn(await turnInput([user("hi")]));
    runs.push(busy.run);
    await expect(bridge.startTurn(await turnInput([user("other")]))).rejects.toBeInstanceOf(
      ClaudeRoomFullError,
    );
  });

  it("answers 404 for a run that is not there", async () => {
    const bridge = new ClaudeBridge({ resolveBinary: async () => "/nowhere/claude" });
    await expect(
      bridge.handleToolCall({ token: "missing", toolCallId: "c", name: "read", arguments: "{}" }),
    ).resolves.toEqual({ status: 404, body: { error: "unknown or expired Claude run" } });
  });
});
