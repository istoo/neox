import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeBridge } from "./bridge.js";
import type { ClaudeRunLike } from "./run.js";
import { ANSWER_TOOL, answerAsk, claudeAnswer, compileClaudeAnswerSchema } from "./schema.js";
import type { ClaudeStreamEvent } from "./stream.js";

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

const schema = {
  type: "object",
  properties: { answer: { type: "string" } },
  required: ["answer"],
  additionalProperties: false,
};

function fakeRun(token: string): ClaudeRunLike {
  return {
    token,
    pid: 0,
    running: true,
    sessionId: "",
    callsMade: new Set<string>(),
    stderrTail: "",
    start() {},
    events: async function* (): AsyncGenerator<ClaudeStreamEvent> {},
    setEventListener() {},
    sendUserMessage() {},
    sendSaid() {},
    waitsFor: () => false,
    deliverToolResult: () => true,
    waitForToolResult: async () => null,
    abort() {},
    beginTurn: () => (async function* (): AsyncGenerator<ClaudeStreamEvent> {})(),
    waitForExit: () => new Promise<void>(() => undefined),
  };
}

describe("claudeAnswer", () => {
  it("names the tool apart from a client's", () => {
    expect(claudeAnswer([], schema).name).toBe(ANSWER_TOOL);
    expect(
      claudeAnswer([{ name: ANSWER_TOOL, description: "", inputSchema: {} }], schema).name,
    ).toBe(`${ANSWER_TOOL}2`);
  });

  it("checks a call's input against the caller's schema", () => {
    const answer = claudeAnswer([], schema);
    expect(answer.validate('{"answer":"hi"}')).toBeNull();
    expect(answer.validate('{"nope":1}')).toContain("required property 'answer'");
    expect(answer.validate("not json")).toBe("the input isn't JSON");
  });

  it("refuses a schema that isn't usable", () => {
    expect(() => compileClaudeAnswerSchema(null)).toThrow("isn't an object");
    expect(() => compileClaudeAnswerSchema({ type: "not-a-type" })).toThrow(
      "the JSON schema can't be used",
    );
  });

  it("asks a turn for its answer tool's call in the tool's name", () => {
    expect(answerAsk(ANSWER_TOOL)).toContain(ANSWER_TOOL);
  });
});

describe("a turn answered through the schema's tool", () => {
  async function start(answer = claudeAnswer([], schema)) {
    const dir = await mkdtemp(path.join(os.tmpdir(), "neolix-claude-answer-"));
    dirs.push(dir);
    const bridge = new ClaudeBridge({
      resolveBinary: async () => "/bin/true",
      createRun: (options) => fakeRun(options.token ?? "token"),
    });
    const handle = await bridge.startTurn({
      owner: "p/a",
      model: "claude-haiku",
      request: { messages: [], tools: [answer.spec] },
      cwd: dir,
      env: {},
      mcpConfig: "{}",
      answer,
    });
    return { bridge, handle, answer };
  }

  it("keeps the input that fits, and tells the model why another doesn't", async () => {
    const { bridge, handle, answer } = await start();
    const token = handle.run.token;
    const ok = await bridge.handleToolCall({
      token,
      toolCallId: "toolu_1",
      name: answer.name,
      arguments: '{"answer":"hi"}',
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({
      content: [{ type: "text", text: "Answer received." }],
      is_error: false,
    });
    expect(handle.takeAnswer()).toBe('{"answer":"hi"}');
    expect(handle.takeAnswer()).toBeNull();

    const bad = await bridge.handleToolCall({
      token,
      toolCallId: "toolu_2",
      name: answer.name,
      arguments: '{"nope":1}',
    });
    expect(bad.status).toBe(200);
    expect((bad.body as { is_error: boolean }).is_error).toBe(true);
    expect(handle.takeAnswer()).toBeNull();
  });
});
