import { describe, expect, it } from "vitest";
import { chatgptApiBody, chatGptApiSessionHeaders, conversationKey } from "./chatgpt-api-body.js";

describe("chatgptApiBody", () => {
  it("drops what a ChatGPT token refuses and stores nothing", () => {
    const body = chatgptApiBody({
      model: "gpt-5.6",
      instructions: "be brief",
      input: [{ type: "message", role: "user", content: "hi" }],
      store: true,
      stream: false,
      temperature: 0.2,
      max_output_tokens: 500,
      previous_response_id: "resp-1",
      metadata: { a: 1 },
    });
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("max_output_tokens");
    expect(body).not.toHaveProperty("previous_response_id");
    expect(body).not.toHaveProperty("metadata");
    expect(body.store).toBe(false);
    expect(body.stream).toBe(true);
    expect(body.model).toBe("gpt-5.6");
    expect(body.instructions).toBe("be brief");
  });

  it("wraps a string input as a user message", () => {
    const body = chatgptApiBody({ input: "hello" });
    expect(body.input).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
    ]);
  });

  it("sends a system message as the developer one", () => {
    const body = chatgptApiBody({
      input: [{ type: "message", role: "system", content: "rules" }],
    });
    expect(body.input).toEqual([{ type: "message", role: "developer", content: "rules" }]);
  });

  it("leaves out the tools OpenAI runs itself", () => {
    const body = chatgptApiBody({
      tools: [
        { type: "function", name: "read" },
        { type: "web_search" },
        { type: "code_interpreter" },
      ],
      tool_choice: "auto",
    });
    expect(body.tools).toEqual([{ type: "function", name: "read" }, { type: "web_search" }]);
    expect(body.tool_choice).toBe("auto");
  });

  it("takes out every tool, and the choice, when only hosted ones were offered", () => {
    const body = chatgptApiBody({ tools: [{ type: "mcp" }], tool_choice: "auto" });
    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("tool_choice");
  });

  it("filters Codex's additional_tools item too", () => {
    const body = chatgptApiBody({
      input: [
        {
          type: "additional_tools",
          role: "developer",
          tools: [{ type: "function", name: "read" }, { type: "tool_search" }],
        },
      ],
    });
    expect(body.input).toEqual([
      { type: "additional_tools", role: "developer", tools: [{ type: "function", name: "read" }] },
    ]);
  });

  it("names the conversation from how it starts, the same on every turn", () => {
    const first = chatgptApiBody({
      instructions: "be brief",
      input: [{ type: "message", role: "user", content: "first" }],
    });
    const later = chatgptApiBody({
      instructions: "be brief",
      input: [
        { type: "message", role: "user", content: "first" },
        { type: "message", role: "assistant", content: "hello" },
        { type: "message", role: "user", content: "second" },
      ],
    });
    expect(first.prompt_cache_key).toBe(later.prompt_cache_key);
    expect(String(first.prompt_cache_key)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("keeps a key the client sent", () => {
    const body = chatgptApiBody({ prompt_cache_key: "mine", input: "hi" });
    expect(body.prompt_cache_key).toBe("mine");
  });
});

describe("conversationKey", () => {
  it("says nothing when no user message starts the conversation", () => {
    expect(conversationKey("rules", [{ type: "message", role: "assistant" }])).toBe("");
  });
});

describe("chatGptApiSessionHeaders", () => {
  it("carries the conversation's key as the session and thread", () => {
    expect(chatGptApiSessionHeaders({ prompt_cache_key: "key-1" })).toEqual({
      "session-id": "key-1",
      "thread-id": "key-1",
    });
    expect(chatGptApiSessionHeaders({})).toEqual({});
  });
});
