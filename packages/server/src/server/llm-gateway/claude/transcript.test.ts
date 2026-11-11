import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeTapReader } from "./tap-reader.js";
import { ClaudeTranscriptTranslator, isPrompt, type ClaudeTranscriptOutput } from "./transcript.js";

interface Lines extends ClaudeTranscriptOutput {
  out: Array<Record<string, unknown>>;
  rows: number;
  turns: number;
}

function lines(): Lines {
  const l: Lines = {
    out: [],
    rows: 0,
    turns: 0,
    emit(value) {
      l.out.push(value);
    },
    sawRow() {
      l.rows += 1;
    },
    turnOver() {
      l.turns += 1;
    },
  };
  return l;
}

/** What l was told: a stream's events by their type, the rest by type. */
function kinds(l: Lines): string[] {
  return l.out.map((m) => {
    if (m.type === "stream_event") {
      return (m.event as { type: string }).type;
    }
    return m.type as string;
  });
}

const streamedTurn = [
  "message_start",
  "content_block_start",
  "content_block_delta",
  "content_block_stop",
  "message_delta",
  "message_stop",
  "assistant",
  "result",
];

function tapReply(n: number, id: string): string[] {
  const events = [
    `{"type":"message_start","message":{"id":"${id}"}}`,
    `{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
    `{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}`,
    `{"type":"content_block_stop","index":0}`,
    `{"type":"message_delta","delta":{"stop_reason":"end_turn"}}`,
    `{"type":"message_stop"}`,
  ];
  return [...events.map((event) => `{"s":${n},"e":${event}}`), `{"s":${n},"end":"done"}`];
}

function whole(id: string): string {
  return JSON.stringify({
    type: "assistant",
    requestId: "req_1",
    message: {
      id,
      model: "claude-haiku",
      content: [{ type: "text", text: "hi" }],
    },
  });
}

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function tapFile(): Promise<{ file: string; write: (...lines: string[]) => Promise<void> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "neolix-claude-tap-read-"));
  dirs.push(dir);
  const file = path.join(dir, "tap.jsonl");
  await writeFile(file, "");
  return {
    file,
    write: async (...written: string[]) => {
      await writeFile(file, `${written.join("\n")}\n`, { flag: "a" });
    },
  };
}

async function setup(options: { waitMs?: number; pollMs?: number } = {}): Promise<{
  l: Lines;
  write: (...lines: string[]) => Promise<void>;
  translator: ClaudeTranscriptTranslator;
  reader: ClaudeTapReader;
}> {
  const { file, write } = await tapFile();
  const l = lines();
  const reader = new ClaudeTapReader({
    file,
    sessionId: "sid",
    out: l,
    waitMs: options.waitMs ?? 1_000,
    pollMs: options.pollMs ?? 10,
  });
  const translator = new ClaudeTranscriptTranslator(l);
  translator.tap = reader;
  return { l, write, translator, reader };
}

describe("ClaudeTranscriptTranslator", () => {
  it("tells a streamed reply as its stream goes, its whole message after, then the result", async () => {
    const { l, write, translator } = await setup();
    await write('{"tap":"on"}', '{"s":1,"open":true}');
    await write(...tapReply(1, "msg_1"));
    await translator.row(whole("msg_1"));
    await translator.row('{"type":"system","subtype":"turn_duration"}');
    expect(kinds(l)).toEqual(streamedTurn);
    expect(l.out[0].session_id).toBe("sid");
    expect(l.out[0].parent_tool_use_id).toBeNull();
  });

  it("holds a message until its stream begins", async () => {
    const { l, write, translator } = await setup();
    await write('{"tap":"on"}', '{"s":1,"open":true}');
    const reply = new Promise<void>((resolve) => {
      setTimeout(() => {
        void write(...tapReply(1, "msg_1")).then(resolve);
      }, 100);
    });
    await translator.row(whole("msg_1"));
    await reply;
    await translator.row('{"type":"system","subtype":"turn_duration"}');
    const got = kinds(l);
    expect(got[0]).toBe("message_start");
    const assistantAt = got.indexOf("assistant");
    expect(assistantAt).toBeGreaterThan(0);
    expect(got.at(-1)).toBe("result");
  });

  it("tells a message with no stream open at once", async () => {
    const { write, translator } = await setup();
    await write('{"tap":"on"}');
    const start = Date.now();
    await translator.row(whole("msg_9"));
    expect(Date.now() - start).toBeLessThan(500);
  });

  it("tells a message whole when its open stream sends no message, and drops the late stream", async () => {
    const { l, write, translator } = await setup({ waitMs: 200, pollMs: 10 });
    await write('{"tap":"on"}', '{"s":1,"open":true}');
    const start = Date.now();
    await translator.row(whole("msg_1"));
    expect(Date.now() - start).toBeGreaterThanOrEqual(150);
    await write(...tapReply(1, "msg_1"));
    await translator.row('{"type":"system","subtype":"turn_duration"}');
    expect(kinds(l)).toEqual(["assistant", "result"]);
  });

  it("tells a cut stream's end with a message_stop and no message_delta", async () => {
    const { l, write, translator } = await setup();
    await write('{"tap":"on"}', '{"s":1,"open":true}');
    await write('{"s":1,"e":{"type":"message_start","message":{"id":"msg_1"}}}');
    await write('{"s":1,"end":"cut"}');
    await translator.row('{"type":"system","subtype":"turn_duration"}');
    expect(kinds(l)).toEqual(["message_start", "message_stop", "result"]);
  });

  it("tells a typed message as a row, and a tool's result as one", async () => {
    const { l, translator } = await setup();
    await translator.row('{"type":"user","message":{"content":[{"type":"text","text":"hi"}]}}');
    await translator.row('{"type":"user","message":{"content":"hi"}}');
    await translator.row('{"type":"queue-operation","operation":"enqueue"}');
    await translator.row(
      '{"type":"user","toolUseResult":{"stdout":"x"},"message":{"content":[{"type":"tool_result"}]}}',
    );
    expect(l.rows).toBe(3);
    expect(l.out).toEqual([{ type: "user", tool_use_result: { stdout: "x" } }]);
  });

  it("ignores sidechain rows and metadata", async () => {
    const { l, translator } = await setup();
    await translator.row('{"type":"assistant","isSidechain":true,"message":{"id":"m"}}');
    await translator.row('{"type":"user","isMeta":true,"message":{"content":"x"}}');
    expect(l.out).toEqual([]);
    expect(l.rows).toBe(0);
  });

  it("tells a synthetic API error as the turn's error result, not a success after", async () => {
    const { l, translator } = await setup();
    await translator.row(
      JSON.stringify({
        type: "assistant",
        isApiErrorMessage: true,
        apiErrorStatus: 429,
        message: {
          id: "msg_1",
          model: "<synthetic>",
          content: [{ type: "text", text: "rate limited" }],
        },
        apiErrorParams: { rate_limit_info: { status: "rejected" } },
      }),
    );
    await translator.row('{"type":"system","subtype":"turn_duration"}');
    expect(kinds(l)).toEqual(["assistant", "rate_limit_event", "result"]);
    expect(l.out.at(-1)).toMatchObject({
      subtype: "error_during_execution",
      is_error: true,
      result: "rate limited",
      api_error_status: 429,
    });
    expect(l.turns).toBe(2);
  });

  it("keeps the row's uuid and request id, as -p tells them", async () => {
    const { l, translator } = await setup();
    await translator.row(
      '{"type":"assistant","uuid":"u1","requestId":"r1","message":{"id":"m1","model":"m","content":[]}}',
    );
    expect(l.out[0]).toMatchObject({ type: "assistant", uuid: "u1", request_id: "r1" });
  });

  it("tells no turn end for a row that is not turn_duration", async () => {
    const { l, translator } = await setup();
    await translator.row('{"type":"system","subtype":"init"}');
    expect(l.out).toEqual([]);
    expect(l.turns).toBe(0);
  });
});

describe("isPrompt", () => {
  it("is true for text, false for a tool's result", () => {
    expect(isPrompt({ content: "hi" })).toBe(true);
    expect(isPrompt({ content: [{ type: "text", text: "hi" }] })).toBe(true);
    expect(isPrompt({ content: [{ type: "tool_result", content: "x" }] })).toBe(false);
    expect(isPrompt({})).toBe(false);
    expect(isPrompt("x")).toBe(false);
  });
});
