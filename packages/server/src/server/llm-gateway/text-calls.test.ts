import { describe, expect, it } from "vitest";
import {
  AnthropicTextCalls,
  ChatTextCalls,
  GeminiTextCalls,
  offeredToolNames,
  parseTextCalls,
  ResponsesTextCalls,
  textCallAt,
  wholeChatTextCalls,
} from "./text-calls.js";

const TOOLS = new Set(["bash", "edit"]);

function chunkOf(text: string): string {
  return `data: ${JSON.stringify({
    id: "c1",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
  })}\n\n`;
}

const STOP_CHUNK = `data: ${JSON.stringify({
  id: "c1",
  object: "chat.completion.chunk",
  choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
})}\n\n`;

interface ChatRead {
  text: string;
  calls: Record<string, string>;
  finish: string | null;
  raw: string;
}

function runChat(pieces: string[]): ChatRead {
  const chatter = new ChatTextCalls(TOOLS);
  let raw = "";
  for (const piece of pieces) {
    raw += chatter.write(piece);
  }
  raw += chatter.flush();
  const calls: Record<string, string> = {};
  const names: string[] = [];
  let text = "";
  let finish: string | null = null;
  for (const line of raw.split("\n")) {
    if (!line.startsWith("data: ") || line === "data: [DONE]") {
      continue;
    }
    const event = JSON.parse(line.slice("data: ".length)) as {
      choices: Array<{
        delta: {
          content?: string;
          tool_calls?: Array<{ function: { name?: string; arguments?: string } }>;
        };
        finish_reason: string | null;
      }>;
    };
    for (const choice of event.choices) {
      text += choice.delta.content ?? "";
      for (const call of choice.delta.tool_calls ?? []) {
        if (call.function.name !== undefined && call.function.name !== "") {
          names.push(call.function.name);
        }
        const name = names[names.length - 1];
        if (name === undefined) {
          continue;
        }
        calls[name] = (calls[name] ?? "") + (call.function.arguments ?? "");
      }
      if (choice.finish_reason !== null) {
        finish = choice.finish_reason;
      }
    }
  }
  return { text, calls, finish, raw };
}

describe("calls written into the text", () => {
  it("finds where one begins, and what of a mark is only begun", () => {
    expect(textCallAt('你好 <tool_call>{"name":"bash"}')).toEqual({ at: 3, tail: 0 });
    expect(textCallAt("你好 <tool_ca")).toEqual({ at: -1, tail: 8 });
    expect(textCallAt("plain text")).toEqual({ at: -1, tail: 0 });
  });

  it("reads a Hermes block, keeping the text before it", () => {
    const parsed = parseTextCalls(
      '前文<tool_call>{"name":"bash","arguments":{"command":"ls"}}</tool_call>',
      TOOLS,
    );
    expect(parsed.ok).toBe(true);
    expect(parsed.calls).toHaveLength(1);
    expect(parsed.calls[0]?.name).toBe("bash");
    expect(JSON.parse(parsed.calls[0]?.args ?? "{}")).toEqual({ command: "ls" });
    expect(parsed.rest).toBe("前文");
  });

  it("reads GLM's name with its argument pairs", () => {
    const parsed = parseTextCalls(
      "<tool_call>bash<arg_key>command</arg_key><arg_value>ls -la</arg_value></tool_call>",
      TOOLS,
    );
    expect(parsed.ok).toBe(true);
    expect(JSON.parse(parsed.calls[0]?.args ?? "{}")).toEqual({ command: "ls -la" });
  });

  it("reads DeepSeek's DSML invoke", () => {
    const body = `<|DSML|invoke name="bash"><|DSML|parameter name="command" string="true">ls</|DSML|parameter></|DSML|invoke>`;
    const parsed = parseTextCalls(body, TOOLS);
    expect(parsed.ok).toBe(true);
    expect(JSON.parse(parsed.calls[0]?.args ?? "{}")).toEqual({ command: "ls" });
  });

  it("reads a name as JSON followed by parameter tags", () => {
    const parsed = parseTextCalls(
      '<tool_call>{"name":"bash"}<parameter name="command">ls</parameter></tool_call>',
      TOOLS,
    );
    expect(parsed.ok).toBe(true);
    expect(JSON.parse(parsed.calls[0]?.args ?? "{}")).toEqual({ command: "ls" });
  });

  it("leaves a call of a tool the request didn't offer as text", () => {
    const parsed = parseTextCalls('<tool_call>{"name":"rm_rf","arguments":{}}</tool_call>', TOOLS);
    expect(parsed.ok).toBe(false);
  });

  it("reads the tools a request offers", () => {
    expect(offeredToolNames("anthropic", { tools: [{ name: "bash" }, { name: "edit" }] })).toEqual(
      TOOLS,
    );
    expect(offeredToolNames("openai", { tools: [{ function: { name: "bash" } }] })).toEqual(
      new Set(["bash"]),
    );
    expect(
      offeredToolNames("gemini", {
        tools: [{ functionDeclarations: [{ name: "bash" }, { name: "edit" }] }],
      }),
    ).toEqual(TOOLS);
    expect(offeredToolNames("openai", { messages: [] })).toBeNull();
  });

  it("reads a whole Chat reply's text calls", () => {
    const read = wholeChatTextCalls(
      '前文<tool_call>{"name":"bash","arguments":{"command":"ls"}}</tool_call>',
      undefined,
      TOOLS,
    );
    expect(read.called).toBe(true);
    expect(read.content).toBe("前文");
    expect(read.calls?.[0]?.name).toBe("bash");
  });
});

describe("Chat relayed stream", () => {
  it("turns a written call into a real one after the text before it", () => {
    const read = runChat([
      chunkOf("我先看看目录。\n\n<tool"),
      chunkOf('_call>{"name":"bash","arguments":{"command":"ls -la"}}'),
      chunkOf("</tool_call>"),
      STOP_CHUNK,
      "data: [DONE]\n\n",
    ]);
    expect(read.text).toBe("我先看看目录。\n\n");
    expect(JSON.parse(read.calls.bash ?? "{}")).toEqual({ command: "ls -la" });
    expect(read.finish).toBe("tool_calls");
    expect(read.raw).not.toContain("tool_call>");
    expect(read.raw).toContain('"total_tokens":5');
    expect(read.raw.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });

  it("leaves a written call to a tool the request never offered as text", () => {
    const read = runChat([
      chunkOf('<tool_call>{"name":"rm_rf","arguments":{}}</tool_call>'),
      STOP_CHUNK,
      "data: [DONE]\n\n",
    ]);
    expect(read.text).toContain("rm_rf");
    expect(read.calls).toEqual({});
    expect(read.finish).toBe("stop");
  });
});

describe("Messages relayed reply", () => {
  const start =
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n';

  it("makes a written call a tool_use block at message_delta", () => {
    const chatter = new AnthropicTextCalls(TOOLS, true);
    const delta = `event: content_block_delta\ndata: ${JSON.stringify({
      type: "content_block_delta",
      index: 0,
      delta: {
        type: "text_delta",
        text: '<invoke name="bash"><parameter name="command">ls</parameter></invoke>',
      },
    })}\n\n`;
    const stop = 'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n';
    const messageDelta = `event: message_delta\ndata: ${JSON.stringify({
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 2 },
    })}\n\n`;
    const out =
      chatter.write(start) +
      chatter.write(delta) +
      chatter.write(stop) +
      chatter.write(messageDelta) +
      chatter.flush();
    expect(out).toContain('"type":"tool_use"');
    expect(out).toContain('"name":"bash"');
    expect(out).toContain('"partial_json":"{\\"command\\":\\"ls\\"}"');
    expect(out).toContain('"stop_reason":"tool_use"');
    expect(out).not.toContain("invoke name=");
  });

  it("makes a whole reply's written call a tool_use block", () => {
    const chatter = new AnthropicTextCalls(TOOLS, false);
    const reply = {
      id: "msg_1",
      type: "message",
      role: "assistant",
      content: [
        {
          type: "text",
          text: '前文<tool_call>{"name":"bash","arguments":{"command":"ls"}}</tool_call>',
        },
      ],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    const out = chatter.write(JSON.stringify(reply)) + chatter.flush();
    const parsed = JSON.parse(out) as {
      content: Array<{ type: string; text?: string; name?: string; input?: unknown }>;
      stop_reason: string;
    };
    expect(parsed.stop_reason).toBe("tool_use");
    expect(parsed.content[0]).toMatchObject({ type: "text", text: "前文" });
    expect(parsed.content[1]).toMatchObject({ type: "tool_use", name: "bash" });
    expect(parsed.content[1]?.input).toEqual({ command: "ls" });
  });
});

describe("Responses relayed reply", () => {
  it("makes a written call a function_call item at the reply's end", () => {
    const chatter = new ResponsesTextCalls(TOOLS, true);
    const delta = `event: response.output_text.delta\ndata: ${JSON.stringify({
      type: "response.output_text.delta",
      item_id: "msg_1",
      output_index: 0,
      content_index: 0,
      delta: '<tool_call>{"name":"bash","arguments":{"command":"ls"}}</tool_call>',
    })}\n\n`;
    const textDone = `event: response.output_text.done\ndata: ${JSON.stringify({
      type: "response.output_text.done",
      item_id: "msg_1",
      output_index: 0,
      content_index: 0,
      text: '<tool_call>{"name":"bash","arguments":{"command":"ls"}}</tool_call>',
    })}\n\n`;
    const itemDone = `event: response.output_item.done\ndata: ${JSON.stringify({
      type: "response.output_item.done",
      output_index: 0,
      item: { type: "message", id: "msg_1", content: [{ type: "output_text", text: "x" }] },
    })}\n\n`;
    const completed = `event: response.completed\ndata: ${JSON.stringify({
      type: "response.completed",
      response: {
        id: "resp_1",
        object: "response",
        output: [{ type: "message", id: "msg_1", content: [{ type: "output_text", text: "x" }] }],
      },
    })}\n\n`;
    const held = chatter.write(delta) + chatter.write(textDone) + chatter.write(itemDone);
    const end = chatter.write(completed) + chatter.flush();
    expect(held).not.toContain("tool_call>");
    expect(end).toContain('"type":"function_call"');
    expect(end).toContain('"name":"bash"');
    expect(end).toContain('"arguments":"{\\"command\\":\\"ls\\"}"');
    const block = end.split("\n\n").find((entry) => entry.includes("response.completed")) ?? "";
    const parsed = JSON.parse(block.slice(block.indexOf("data: ") + 6)) as {
      response: { output: Array<{ type: string }> };
    };
    expect(parsed.response.output.map((item) => item.type)).toEqual(["message", "function_call"]);
  });
});

describe("Gemini relayed reply", () => {
  it("makes a written call a functionCall part at the finishReason", () => {
    const chatter = new GeminiTextCalls(TOOLS, true);
    const first = `data: ${JSON.stringify({
      candidates: [
        {
          content: {
            role: "model",
            parts: [
              { text: '<tool_call>{"name":"bash","arguments":{"command":"ls"}}</tool_call>' },
            ],
          },
        },
      ],
    })}\n\n`;
    const last = `data: ${JSON.stringify({
      candidates: [{ content: { role: "model", parts: [] }, finishReason: "STOP" }],
    })}\n\n`;
    const out = chatter.write(first) + chatter.write(last) + chatter.flush();
    const calls = out
      .split("\n")
      .filter((line) => line.startsWith("data: ") && line.includes("functionCall"))
      .map(
        (line) =>
          JSON.parse(line.slice("data: ".length)) as {
            candidates: Array<{ content: { parts: Array<{ functionCall?: unknown }> } }>;
          },
      );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.candidates[0]?.content.parts[0]?.functionCall).toEqual({
      name: "bash",
      args: { command: "ls" },
    });
  });

  it("makes a whole reply's written call a functionCall part", () => {
    const chatter = new GeminiTextCalls(TOOLS, false);
    const reply = {
      candidates: [
        {
          content: {
            role: "model",
            parts: [
              { text: '前文<tool_call>{"name":"bash","arguments":{"command":"ls"}}</tool_call>' },
            ],
          },
          finishReason: "STOP",
        },
      ],
    };
    const out = chatter.write(JSON.stringify(reply)) + chatter.flush();
    const parsed = JSON.parse(out) as {
      candidates: Array<{
        content: { parts: Array<{ text?: string; functionCall?: { name: string } }> };
      }>;
    };
    const parts = parsed.candidates[0]?.content.parts ?? [];
    expect(parts[0]?.text).toBe("前文");
    expect(parts[1]?.functionCall?.name).toBe("bash");
  });
});
