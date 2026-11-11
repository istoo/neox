import { describe, expect, it } from "vitest";
import { holdsPlaceholder, PLACEHOLDER_NOTE, withPlaceholderNote } from "./placeholder-note.js";

const PLACEHOLDER = "{{SECRET_ab12cd34}}";
const NOTE_BLOCK = `\n\n${PLACEHOLDER_NOTE}`;

describe("placeholder note", () => {
  it("is not itself taken for a placeholder", () => {
    expect(PLACEHOLDER_NOTE).toContain("{{NAME_ab12cdg4}}");
    expect(holdsPlaceholder(PLACEHOLDER_NOTE)).toBe(false);
    expect(holdsPlaceholder({ text: PLACEHOLDER })).toBe(true);
  });

  it("tells Anthropic's system, a string or blocks", () => {
    const fromString = withPlaceholderNote("anthropic", {
      system: `be terse ${PLACEHOLDER}`,
      messages: [],
    });
    expect(fromString.system).toBe(`be terse ${PLACEHOLDER}${NOTE_BLOCK}`);

    const fromBlocks = withPlaceholderNote("anthropic", {
      system: [{ type: "text", text: PLACEHOLDER }],
      messages: [],
    });
    expect(fromBlocks.system).toEqual([
      { type: "text", text: PLACEHOLDER },
      { type: "text", text: NOTE_BLOCK },
    ]);

    const created = withPlaceholderNote("anthropic", {
      tools: [{ name: "x", description: PLACEHOLDER }],
      messages: [],
    });
    expect(created.system).toBe(PLACEHOLDER_NOTE);
  });

  it("tells the earliest Anthropic message with one", () => {
    const body = {
      system: "plain",
      messages: [
        { role: "user", content: "hi" },
        { role: "user", content: `key ${PLACEHOLDER}` },
        { role: "assistant", content: "ok" },
      ],
    };
    const told = withPlaceholderNote("anthropic", body);
    expect(told.system).toBe("plain");
    expect(told.messages).toEqual([
      { role: "user", content: "hi" },
      {
        role: "user",
        content: [
          { type: "text", text: `key ${PLACEHOLDER}` },
          { type: "text", text: NOTE_BLOCK },
        ],
      },
      { role: "assistant", content: "ok" },
    ]);

    const blocks = withPlaceholderNote("anthropic", {
      messages: [{ role: "user", content: [{ type: "text", text: PLACEHOLDER }] }],
    });
    expect(blocks.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: PLACEHOLDER },
          { type: "text", text: NOTE_BLOCK },
        ],
      },
    ]);
  });

  it("keeps a Chat message's string content a string", () => {
    const told = withPlaceholderNote("openai", {
      messages: [
        { role: "system", content: `rules ${PLACEHOLDER}` },
        { role: "user", content: "hi" },
      ],
    });
    expect(told.messages).toEqual([
      { role: "system", content: `rules ${PLACEHOLDER}${NOTE_BLOCK}` },
      { role: "user", content: "hi" },
    ]);
  });

  it("gives Chat instructions of its own when a tool holds one", () => {
    const told = withPlaceholderNote("openai", {
      tools: [{ type: "function", function: { name: "x", description: PLACEHOLDER } }],
      messages: [{ role: "user", content: "hi" }],
    });
    const messages = told.messages as unknown[];
    expect(messages[0]).toEqual({ role: "system", content: PLACEHOLDER_NOTE });
    expect(messages.length).toBe(2);
  });

  it("tells Responses through a developer item", () => {
    const developer = {
      type: "message",
      role: "developer",
      content: [{ type: "input_text", text: PLACEHOLDER_NOTE }],
    };
    const fromText = withPlaceholderNote("openai-responses", {
      input: `key ${PLACEHOLDER}`,
    });
    expect(fromText.input).toEqual([developer, { role: "user", content: `key ${PLACEHOLDER}` }]);

    const fromItems = withPlaceholderNote("openai-responses", {
      input: [
        { type: "message", role: "user", content: "hi" },
        { type: "function_call_output", call_id: "c1", output: PLACEHOLDER },
        { type: "message", role: "user", content: "next" },
      ],
    });
    expect(fromItems.input).toEqual([
      { type: "message", role: "user", content: "hi" },
      { type: "function_call_output", call_id: "c1", output: PLACEHOLDER },
      developer,
      { type: "message", role: "user", content: "next" },
    ]);

    const continuing = { previous_response_id: "resp_1", input: `key ${PLACEHOLDER}` };
    expect(withPlaceholderNote("openai-responses", continuing)).toBe(continuing);
  });

  it("tells Gemini in its system instruction or the earliest content", () => {
    const system = withPlaceholderNote("gemini", {
      systemInstruction: { parts: [{ text: PLACEHOLDER }] },
      contents: [],
    });
    expect(system.systemInstruction).toEqual({
      parts: [{ text: PLACEHOLDER }, { text: NOTE_BLOCK }],
    });

    const created = withPlaceholderNote("gemini", {
      tools: [{ functionDeclarations: [{ description: PLACEHOLDER }] }],
      contents: [],
    });
    expect(created.systemInstruction).toEqual({ parts: [{ text: PLACEHOLDER_NOTE }] });

    const content = withPlaceholderNote("gemini", {
      contents: [
        { role: "user", parts: [{ text: "hi" }] },
        { role: "user", parts: [{ text: PLACEHOLDER }] },
      ],
    });
    expect(content.contents).toEqual([
      { role: "user", parts: [{ text: "hi" }] },
      { role: "user", parts: [{ text: PLACEHOLDER }, { text: NOTE_BLOCK }] },
    ]);
  });

  it("leaves a request without a placeholder, or a client that must look untouched", () => {
    const plain = { messages: [{ role: "user", content: "hi" }] };
    expect(withPlaceholderNote("openai", plain)).toBe(plain);

    const masked = { system: PLACEHOLDER, messages: [] };
    expect(withPlaceholderNote("anthropic", masked, { agent: "claude-code" })).toBe(masked);
    expect(withPlaceholderNote("anthropic", masked, { agent: "chatgpt-api" })).toBe(masked);
    expect(withPlaceholderNote("anthropic", masked, { agent: "copilot" }).system).not.toBe(
      PLACEHOLDER,
    );
  });
});
