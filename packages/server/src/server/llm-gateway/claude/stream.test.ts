import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { spawnProcess } from "../../../utils/spawn.js";
import { ClaudeStreamParser, type ClaudeStreamEvent } from "./stream.js";
import { installFakeClaude, printLines } from "./testing/fake-claude.js";

const cleanup: string[] = [];

afterEach(async () => {
  for (const dir of cleanup.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

const START =
  '{"type":"stream_event","event":{"type":"message_start","message":{"id":"msg_1","model":"claude-sonnet-5","usage":{"input_tokens":10,"cache_creation_input_tokens":3,"cache_read_input_tokens":7}}}}';
const DELTA_HELLO =
  '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}}';
const DELTA_LO =
  '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"lo"}}}';
const STOP =
  '{"type":"stream_event","event":{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}}';
const MESSAGE_STOP = '{"type":"stream_event","event":{"type":"message_stop"}}';
const WHOLE =
  '{"type":"assistant","message":{"id":"msg_1","content":[{"type":"text","text":"Hello"}],"usage":{"input_tokens":10,"output_tokens":2},"stop_reason":"end_turn"}}';
const RESULT = '{"type":"result","subtype":"success","is_error":false,"result":"Hello"}';

describe("ClaudeStreamParser", () => {
  it("reads text and usage from stream events", () => {
    const parser = new ClaudeStreamParser();
    const events = parser.push(
      [START, DELTA_HELLO, DELTA_LO, STOP, MESSAGE_STOP].join("\n") + "\n",
    );
    expect(events).toEqual([
      { kind: "text", text: "Hel" },
      { kind: "text", text: "lo" },
      {
        kind: "usage",
        usage: {
          inputTokens: 10,
          outputTokens: 2,
          cacheCreationInputTokens: 3,
          cacheReadInputTokens: 7,
        },
      },
      { kind: "stop", stop: "end_turn" },
    ]);
  });

  it("waits for a line's rest across chunk boundaries", () => {
    const parser = new ClaudeStreamParser();
    const all = [START, DELTA_HELLO, STOP].join("\n") + "\n";
    const events: ClaudeStreamEvent[] = [];
    for (let at = 0; at < all.length; at += 7) {
      events.push(...parser.push(all.slice(at, at + 7)));
    }
    events.push(...parser.end());
    expect(events.filter((event) => event.kind === "text")).toEqual([
      { kind: "text", text: "Hel" },
    ]);
    expect(events.some((event) => event.kind === "stop")).toBe(true);
  });

  it("shows a message once when Claude Code sends it streamed and whole", () => {
    const parser = new ClaudeStreamParser();
    const events = parser.push(
      [START, DELTA_HELLO, DELTA_LO, STOP, WHOLE, RESULT].join("\n") + "\n",
    );
    expect(events.filter((event) => event.kind === "text")).toEqual([
      { kind: "text", text: "Hel" },
      { kind: "text", text: "lo" },
    ]);
  });

  it("takes a whole message when nothing streamed it", () => {
    const parser = new ClaudeStreamParser();
    expect(parser.push(WHOLE + "\n")).toEqual([
      { kind: "text", text: "Hello" },
      {
        kind: "usage",
        usage: {
          inputTokens: 10,
          outputTokens: 2,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
        },
      },
      { kind: "stop", stop: "end_turn" },
    ]);
  });

  it("falls back to the result's words when no message arrived", () => {
    const parser = new ClaudeStreamParser();
    expect(parser.push(RESULT + "\n")).toEqual([{ kind: "text", text: "Hello" }]);
  });

  it("reports an error result", () => {
    const parser = new ClaudeStreamParser();
    expect(
      parser.push(
        '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"boom"}\n',
      ),
    ).toEqual([{ kind: "error", message: "boom" }]);
  });

  it("takes a caller's tool call out of a streamed block", () => {
    const parser = new ClaudeStreamParser();
    const lines = [
      START,
      '{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"mcp__neox__read"}}}',
      '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":"}}}',
      '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"a\\"}"}}}',
      '{"type":"stream_event","event":{"type":"content_block_stop","index":0}}',
      '{"type":"stream_event","event":{"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":2}}}',
    ];
    expect(parser.push(lines.join("\n") + "\n")).toEqual([
      { kind: "toolCall", id: "toolu_1", name: "mcp__neox__read", arguments: '{"path":"a"}' },
      {
        kind: "usage",
        usage: {
          inputTokens: 10,
          outputTokens: 2,
          cacheCreationInputTokens: 3,
          cacheReadInputTokens: 7,
        },
      },
      { kind: "stop", stop: "tool_use" },
    ]);
  });

  it("ignores lines that are not JSON", () => {
    const parser = new ClaudeStreamParser();
    expect(parser.push("not json\n\n")).toEqual([]);
  });

  it("reads a fake Claude Code's output end to end", async () => {
    const { dir, binary } = await installFakeClaude(
      printLines([START, DELTA_HELLO, DELTA_LO, STOP, MESSAGE_STOP, RESULT]),
    );
    cleanup.push(dir);
    const output = await runToEnd(binary);
    const parser = new ClaudeStreamParser();
    const events = [...parser.push(output), ...parser.end()];
    expect(events.filter((event) => event.kind === "text")).toEqual([
      { kind: "text", text: "Hel" },
      { kind: "text", text: "lo" },
    ]);
    expect(events.at(-1)).toEqual({ kind: "stop", stop: "end_turn" });
  });
});

function runToEnd(binary: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // The fake is a `.cmd` on Windows, which only the shared launcher starts.
    const child = spawnProcess(binary, ["-p"], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`fake claude exited ${code ?? "null"}: ${stderr}`));
      }
    });
  });
}
