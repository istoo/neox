import { describe, expect, it } from "vitest";
import {
  continueIfAssistantLast,
  CONTINUE_TEXT,
  dropBillingLine,
  fitAdvisor,
  fitAutomode,
  namesThread,
  withoutBillingHeader,
} from "./claude-compat.js";

const BILLING = "x-anthropic-billing-header: cc_version=2.1.3; cc_entrypoint=cli; cch=abc;";

describe("Claude Code request shapes", () => {
  it("cuts the billing line from another vendor's system prompt", () => {
    expect(withoutBillingHeader(`${BILLING}\nYou are Claude.`)).toBe("You are Claude.");
    expect(withoutBillingHeader("You are Claude.")).toBe("You are Claude.");

    const chat = dropBillingLine("openai", {
      messages: [
        { role: "system", content: `${BILLING}\nYou are Claude.` },
        { role: "user", content: "hi" },
      ],
    });
    expect(JSON.stringify(chat)).not.toContain("x-anthropic-billing-header");
    expect(JSON.stringify(chat)).toContain("You are Claude.");

    const block = dropBillingLine("openai", {
      messages: [
        {
          role: "system",
          content: [
            { type: "text", text: BILLING },
            { type: "text", text: "You are Claude." },
          ],
        },
      ],
    });
    expect(JSON.stringify(block)).not.toContain("x-anthropic-billing-header");

    const responses = dropBillingLine("openai-responses", {
      instructions: `${BILLING}\nYou are Claude.`,
    });
    expect(responses.instructions).toBe("You are Claude.");

    const gemini = dropBillingLine("gemini", {
      systemInstruction: { parts: [{ text: BILLING }, { text: "You are Claude." }] },
    });
    expect(JSON.stringify(gemini)).not.toContain("x-anthropic-billing-header");
  });

  it("keeps the billing line for Anthropic itself", () => {
    const body = {
      system: [{ type: "text", text: BILLING }],
      messages: [],
    };
    expect(dropBillingLine("anthropic", body)).toBe(body);
  });

  it("puts a user turn after a conversation ending with the assistant", () => {
    const chat = continueIfAssistantLast("openai", {
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ],
    });
    expect(chat.messages).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: CONTINUE_TEXT },
    ]);
    // A turn that ends with a tool call is not a prefill.
    const tools = { messages: [{ role: "assistant", tool_calls: [{ id: "1" }] }] };
    expect(continueIfAssistantLast("openai", tools)).toBe(tools);

    const responses = continueIfAssistantLast("openai-responses", {
      input: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ],
    });
    expect(JSON.stringify(responses.input)).toContain(CONTINUE_TEXT);
  });

  it("names a thread only when one is asked", () => {
    expect(namesThread({ thread: { type: "create" } })).toBe(true);
    expect(namesThread({ thread: null })).toBe(false);
    expect(namesThread({})).toBe(false);
  });
});

describe("Claude Code server features", () => {
  const advisorTool = { type: "advisor_20260301", name: "advisor", model: "claude-opus-4-6" };
  const history = [
    { role: "user", content: "hi" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "ask" },
        { type: "tool_use", id: "a1", name: "advisor", input: {} },
      ],
    },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "a1", content: "glad" }] },
  ];

  it("keeps an advisor the upstream's Claude can run", () => {
    const body = { model: "claude-sonnet-5", tools: [advisorTool], messages: history };
    const fitted = fitAdvisor({
      body,
      requestModel: "claude-sonnet-5",
      providerId: "anthropic",
      models: ["claude-opus-4-6"],
    });
    expect(fitted).toBe(body);
  });

  it("writes the provider's own id for its advisor model", () => {
    const fitted = fitAdvisor({
      body: { tools: [{ ...advisorTool, model: "relay/claude-opus-4-6" }] },
      requestModel: "claude-sonnet-5",
      providerId: "relay",
      models: ["claude-opus-4-6"],
    });
    expect((fitted.tools as Array<Record<string, unknown>>)[0]?.model).toBe("claude-opus-4-6");
  });

  it("drops an advisor the provider cannot run, with its conversation", () => {
    const fitted = fitAdvisor({
      body: {
        tools: [{ ...advisorTool, model: "gpt-5" }, { name: "read" }],
        tool_choice: { type: "auto" },
        messages: history,
      },
      requestModel: "claude-sonnet-5",
      providerId: "relay",
      models: ["gpt-5"],
    });
    expect(fitted.tools).toEqual([{ name: "read" }]);
    expect(JSON.stringify(fitted.messages)).not.toContain("advisor");
    expect(JSON.stringify(fitted.messages)).not.toContain("a1");
  });

  it("drops every advisor when the request model is not Claude's", () => {
    const fitted = fitAdvisor({
      body: { tools: [advisorTool], tool_choice: { type: "auto" }, messages: history },
      requestModel: "gpt-5",
      providerId: "anthropic",
      models: ["claude-opus-4-6"],
    });
    expect(fitted.tools).toBeUndefined();
    expect(fitted.tool_choice).toBeUndefined();
    expect(fitted.messages).toHaveLength(2);
  });

  it("keeps auto mode's safeguards only for a Claude model", () => {
    const body = { model: "claude-sonnet-5", safeguards: { auto: true } };
    expect(fitAutomode(body, "claude-sonnet-5")).toBe(body);
    expect(fitAutomode(body, "deepseek-v4").safeguards).toBeUndefined();
  });
});
