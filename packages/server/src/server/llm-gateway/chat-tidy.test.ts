import { describe, expect, it } from "vitest";
import { ChatTidy, chatWholeTidy, openAiUsage } from "./chat-tidy.js";

function tidyAll(text: string, piece = text.length): string {
  const tidy = new ChatTidy();
  let out = "";
  for (let at = 0; at < text.length; at += piece) {
    out += tidy.write(text.slice(at, at + piece));
  }
  return out + tidy.flush();
}

function line(chunk: unknown): string {
  return `data: ${JSON.stringify(chunk)}\n`;
}

function chunks(text: string): Record<string, unknown>[] {
  return text
    .split("\n")
    .filter((entry) => entry.startsWith("data: {"))
    .map((entry) => JSON.parse(entry.slice("data: ".length)) as Record<string, unknown>);
}

describe("ChatTidy", () => {
  it("drops an empty reasoning_content once thinking is over", () => {
    const input =
      line({
        id: "c1",
        object: "chat.completion.chunk",
        choices: [
          { index: 0, delta: { role: "assistant", reasoning_content: "The user said hi." } },
        ],
      }) +
      line({ id: "c1", choices: [{ index: 0, delta: { content: "Hi", reasoning_content: "" } }] }) +
      line({ id: "c1", choices: [{ index: 0, delta: { content: "!", reasoning_content: "" } }] }) +
      line({
        id: "c1",
        choices: [{ index: 0, delta: { reasoning_content: "" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      }) +
      "data: [DONE]\n";
    const out = tidyAll(input);
    expect(out).not.toContain('"reasoning_content":""');
    expect(out).toContain('"reasoning_content":"The user said hi."');
    expect(out).toContain('"content":"Hi"');
    expect(out).toContain('"content":"!"');
    expect(out).toContain('"finish_reason":"stop"');
    expect(out).toContain('"total_tokens":5');
    expect(out.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });

  it("mends CodeBuddy's empty finish reasons, names and tool_calls lists", () => {
    const input =
      line({
        choices: [
          {
            index: 0,
            delta: { content: "", reasoning_content: "The user", tool_calls: [] },
            finish_reason: "",
          },
        ],
      }) +
      line({
        choices: [
          {
            index: 0,
            delta: {
              content: "",
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: { name: "grep", arguments: "" },
                  index: 0,
                },
              ],
            },
            finish_reason: "",
          },
        ],
      }) +
      line({
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ function: { name: "", arguments: '{"pat' }, index: 0 }] },
            finish_reason: "tool_calls",
          },
        ],
      }) +
      "data: [DONE]\n";
    const out = tidyAll(input);
    expect(out).not.toContain('"finish_reason":""');
    expect(out).not.toContain('"name":""');
    expect(out).not.toContain('"reasoning_content":""');
    expect(out).toContain('"finish_reason":null');
    expect(out).toContain('"finish_reason":"tool_calls"');
    expect(out).toContain('"reasoning_content":"The user"');
    expect(out).toContain('"name":"grep"');
    expect(out.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });

  it("keeps split lines whole and untouched when nothing needs mending", () => {
    const input =
      'data: {"choices":[{"delta":{"content":"a","reasoning_content":""}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"b"}}],  "x":1}\r\n\r\ndata: [DONE]';
    expect(tidyAll(input, 7)).toBe(
      'data: {"choices":[{"delta":{"content":"a"}}]}\n\n' +
        'data: {"choices":[{"delta":{"content":"b"}}],  "x":1}\r\n\r\ndata: [DONE]',
    );
  });

  it("turns an empty finish_reason into null on every choice", () => {
    const tidy = new ChatTidy();
    const out = tidy.write(
      line({
        choices: [
          { index: 0, delta: { content: "a" }, finish_reason: "" },
          { index: 1, delta: { content: "b" }, finish_reason: "" },
        ],
      }),
    );
    expect(out.split('"finish_reason":null').length - 1).toBe(2);
    const same =
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n' +
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":null}]}\n';
    expect(tidy.write(same) + tidy.flush()).toBe(same);
  });

  it("drops repeated empty tool names but keeps the first real one", () => {
    const fragments = [
      { id: "call_1", type: "function", function: { name: "grep", arguments: "" }, index: 0 },
      { function: { name: "", arguments: '{"pat' }, index: 0 },
      { function: { name: "", arguments: 'tern"}' }, index: 0 },
    ];
    const tidy = new ChatTidy();
    let name = "";
    let args = "";
    for (const fragment of fragments) {
      const out = tidy.write(line({ choices: [{ index: 0, delta: { tool_calls: [fragment] } }] }));
      expect(out).not.toContain('"name":""');
      const prepared = chunks(out)[0];
      const choice = (
        prepared?.choices as { delta: { tool_calls: Record<string, unknown>[] } }[] | undefined
      )?.[0];
      const call = choice?.delta.tool_calls[0] as {
        function: { name?: string; arguments: string };
      };
      name = call?.function.name ?? name;
      args += call?.function.arguments ?? "";
    }
    expect(name).toBe("grep");
    expect(args).toBe('{"pattern"}');
  });

  it("gives a fragment with no index the index of its call", () => {
    const tidy = new ChatTidy();
    const out = tidy.write(
      line({
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ id: "a", function: { name: "f", arguments: "" } }] },
          },
        ],
      }) +
        line({
          choices: [
            {
              index: 0,
              delta: { tool_calls: [{ id: "b", function: { name: "g", arguments: "" } }] },
            },
          ],
        }),
    );
    const given = chunks(out).flatMap(
      (chunk) =>
        (chunk.choices as { delta: { tool_calls: { index: number }[] } }[])[0]?.delta.tool_calls ??
        [],
    );
    expect(given.map((call) => call.index)).toEqual([0, 1]);
  });

  it("gives an id to a call without one and drops it from later fragments", () => {
    const tidy = new ChatTidy();
    const first = tidy.write(
      line({
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ function: { name: "f", arguments: "" }, index: 0 }] },
          },
        ],
      }),
    );
    const second = tidy.write(
      line({
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ id: "", function: { arguments: "{}" }, index: 0 }] },
          },
        ],
      }),
    );
    const prepared = chunks(first)[0];
    const choice = (
      prepared?.choices as { delta: { tool_calls: Record<string, unknown>[] } }[] | undefined
    )?.[0];
    const firstCall = choice?.delta.tool_calls[0] as { id: string };
    expect(firstCall.id).toMatch(/^call_/);
    expect(second).not.toContain('"id":""');
  });

  it("drops a call that names no function and ends stop", () => {
    const tidy = new ChatTidy();
    const out =
      tidy.write(
        line({
          choices: [
            {
              index: 0,
              delta: { tool_calls: [{ function: { arguments: "{}" }, index: 0 }] },
            },
          ],
        }),
      ) +
      tidy.write(
        line({
          choices: [
            { index: 0, delta: { tool_calls: [{ function: { arguments: "x" }, index: 0 }] } },
          ],
        }),
      ) +
      tidy.write(line({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }));
    expect(out).not.toContain('"tool_calls"');
    expect(out).toContain('"finish_reason":"stop"');
  });

  it("ends tool_calls, not stop, for a choice that made a call", () => {
    const tidy = new ChatTidy();
    const out =
      tidy.write(
        line({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [{ id: "c1", function: { name: "f", arguments: "" }, index: 0 }],
              },
            },
          ],
        }),
      ) + tidy.write(line({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
    expect(out).toContain('"finish_reason":"tool_calls"');
  });

  it("mends a cache told in another vendor's names into OpenAI's", () => {
    const tidy = new ChatTidy();
    const out = tidy.write(
      line({
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 5,
          total_tokens: 105,
          prompt_cache_hit_tokens: 40,
        },
      }),
    );
    const usage = chunks(out)[0]?.usage as {
      prompt_tokens: number;
      total_tokens: number;
      prompt_tokens_details: { cached_tokens: number };
    };
    expect(usage.prompt_tokens_details.cached_tokens).toBe(40);
    // OpenAI's prompt_tokens counts what was cached too (myna's openAIUsage).
    expect(usage.prompt_tokens).toBe(100);
    expect(usage.total_tokens).toBe(105);
  });

  it("flattens typed content parts, thinking into reasoning_content", () => {
    const tidy = new ChatTidy();
    const out = tidy.write(
      line({
        choices: [
          {
            index: 0,
            delta: {
              content: [
                { type: "thinking", thinking: [{ type: "text", text: "hm" }] },
                { type: "text", text: "ok" },
              ],
            },
          },
        ],
      }),
    );
    expect(out).toContain('"content":"ok"');
    expect(out).toContain('"reasoning_content":"hm"');
  });
});

describe("chatWholeTidy", () => {
  it("mends a whole reply's calls and finish", () => {
    const input = JSON.stringify({
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            tool_calls: [{ function: { name: "f", arguments: "{}" } }],
          },
          finish_reason: "stop",
        },
      ],
    });
    const out = JSON.parse(chatWholeTidy(input)) as {
      choices: { finish_reason: string; message: { tool_calls: { id: string }[] } }[];
    };
    expect(out.choices[0]?.finish_reason).toBe("tool_calls");
    expect(out.choices[0]?.message.tool_calls[0]?.id).toMatch(/^call_/);
  });

  it("leaves a reply that needs nothing byte for byte", () => {
    const input = '{"choices":[{"index":0,"message":{"role":"assistant","content":"hi"}}]}';
    expect(chatWholeTidy(input)).toBe(input);
  });

  it("makes the calls a whole reply wrote into its text real", () => {
    const input = JSON.stringify({
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: {
            role: "assistant",
            content: 'let me <tool_call>{"name":"read","arguments":{"p":1}}</tool_call>',
          },
        },
      ],
    });
    const out = JSON.parse(chatWholeTidy(input, new Set(["read"]))) as {
      choices: {
        finish_reason: string;
        message: { tool_calls: { function: { name: string } }[] };
      }[];
    };
    expect(out.choices[0]?.finish_reason).toBe("tool_calls");
    expect(out.choices[0]?.message.tool_calls[0]?.function.name).toBe("read");
    // Without the tools the request offered, the text goes as it came.
    expect(chatWholeTidy(input)).toBe(input);
  });

  it("flattens a whole reply's typed parts, and drops a nameless call", () => {
    const input = JSON.stringify({
      choices: [
        {
          index: 0,
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "hmm" },
              { type: "text", text: "ok" },
            ],
            tool_calls: [{ function: { arguments: "{}" } }],
          },
        },
      ],
    });
    const out = JSON.parse(chatWholeTidy(input)) as {
      choices: {
        finish_reason: string;
        message: { content: string; reasoning_content: string; tool_calls?: unknown };
      }[];
    };
    expect(out.choices[0]?.message.content).toBe("ok");
    expect(out.choices[0]?.message.reasoning_content).toBe("hmm");
    expect(out.choices[0]?.message.tool_calls).toBeUndefined();
    expect(out.choices[0]?.finish_reason).toBe("stop");
  });
});

describe("openAiUsage", () => {
  it("tells a cache in OpenAI's names, and leaves an OpenAI usage alone", () => {
    const mended = openAiUsage({
      prompt_tokens: 1000,
      completion_tokens: 10,
      total_tokens: 1010,
      prompt_cache_hit_tokens: 800,
    });
    expect(mended.changed).toBe(true);
    expect(mended.usage).toMatchObject({
      prompt_tokens: 1000,
      total_tokens: 1010,
      prompt_tokens_details: { cached_tokens: 800 },
    });
    const openai = {
      prompt_tokens: 1000,
      total_tokens: 1010,
      prompt_tokens_details: { cached_tokens: 800 },
    };
    expect(openAiUsage(openai)).toEqual({ usage: openai, changed: false });
    expect(openAiUsage({ prompt_tokens: 1 })).toEqual({
      usage: { prompt_tokens: 1 },
      changed: false,
    });
  });

  it("treats a null name and arguments on a legacy call as empty", () => {
    const tidy = new ChatTidy();
    const out = tidy.write(
      line({
        choices: [
          {
            index: 0,
            delta: { function_call: { name: null, arguments: null } },
            finish_reason: "",
          },
        ],
      }),
    );
    expect(out).not.toContain("function_call");
    expect(out).toContain('"finish_reason":null');
  });
});
