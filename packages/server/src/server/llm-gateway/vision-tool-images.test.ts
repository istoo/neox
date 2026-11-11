import { describe, expect, it } from "vitest";
import type { IrPart, IrRequest } from "./ir.js";
import { codecFor } from "./protocols.js";

const image = { type: "image", mediaType: "image/png", data: "aGVsbG8=" } as const;

function toolResult(request: IrRequest): Extract<IrPart, { type: "tool_result" }> {
  const part = request.messages
    .flatMap((message) => message.parts)
    .find(
      (entry): entry is Extract<IrPart, { type: "tool_result" }> => entry.type === "tool_result",
    );
  if (part === undefined) {
    throw new Error("no tool result");
  }
  return part;
}

const call = { type: "tool_call", id: "call_1", name: "read", arguments: "{}" } as const;

describe("images a tool returned, across protocols", () => {
  it("keeps an Anthropic tool_result image, and sends it to Chat after the result", () => {
    const ir = codecFor("anthropic").parseRequest({
      model: "m",
      max_tokens: 16,
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "call_1", name: "read", input: {} }],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_1",
              content: [
                { type: "text", text: "Read image file" },
                {
                  type: "image",
                  source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" },
                },
              ],
            },
          ],
        },
      ],
    });
    expect(toolResult(ir).images).toEqual([image]);

    const chat = codecFor("openai").buildRequestBody(ir, "m");
    const messages = chat.messages as Array<Record<string, unknown>>;
    expect(messages.find((message) => message.role === "tool")).toMatchObject({
      tool_call_id: "call_1",
      content: "Read image file",
    });
    expect(messages.at(-1)).toEqual({
      role: "user",
      content: [
        { type: "text", text: "[From the result of call_1:]" },
        { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } },
      ],
    });
  });

  it("keeps a Chat tool message's image in the IR", () => {
    const ir = codecFor("openai").parseRequest({
      model: "m",
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "read", arguments: "{}" } },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_1",
          content: [
            { type: "text", text: "Read image file" },
            { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } },
          ],
        },
      ],
    });
    expect(toolResult(ir)).toMatchObject({ content: "Read image file", images: [image] });
  });

  it("keeps a Responses output image, and writes it into an Anthropic tool_result", () => {
    const ir = codecFor("openai-responses").parseRequest({
      model: "m",
      input: [
        { type: "function_call", call_id: "call_1", name: "read", arguments: "{}" },
        {
          type: "function_call_output",
          call_id: "call_1",
          output: [
            { type: "input_text", text: "Read image file" },
            { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" },
          ],
        },
      ],
    });
    expect(toolResult(ir)).toMatchObject({ content: "Read image file", images: [image] });

    const anthropic = codecFor("anthropic").buildRequestBody(ir, "m");
    const blocks = (anthropic.messages as Array<{ content: Array<Record<string, unknown>> }>)[1]
      ?.content;
    expect(blocks?.find((block) => block.type === "tool_result")).toMatchObject({
      content: [
        { type: "text", text: "Read image file" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } },
      ],
    });
  });

  it("sends a tool's image beside its function response to Gemini", () => {
    const request: IrRequest = {
      system: null,
      messages: [
        { role: "assistant", parts: [call] },
        {
          role: "user",
          parts: [
            {
              type: "tool_result",
              toolCallId: "call_1",
              content: "{}",
              isError: false,
              images: [image],
            },
          ],
        },
      ],
      tools: [],
      toolChoice: null,
      format: null,
      maxTokens: null,
      temperature: null,
      topP: null,
      stop: [],
      stream: false,
    };
    const gemini = codecFor("gemini").buildRequestBody(request, "m");
    const parts = (gemini.contents as Array<{ parts: Array<Record<string, unknown>> }>)[1]?.parts;
    expect(parts?.[0]).toHaveProperty("functionResponse");
    expect(parts?.[1]).toEqual({ inlineData: { mimeType: "image/png", data: "aGVsbG8=" } });
  });

  it("keeps a URL image as a URL rather than downloading it", () => {
    const ir = codecFor("anthropic").parseRequest({
      model: "m",
      max_tokens: 16,
      messages: [
        {
          role: "user",
          content: [{ type: "image", source: { type: "url", url: "https://example.com/a.png" } }],
        },
      ],
    });
    expect(ir.messages[0]?.parts[0]).toEqual({
      type: "image",
      mediaType: "image/*",
      data: "",
      url: "https://example.com/a.png",
    });
    const chat = codecFor("openai").buildRequestBody(ir, "m");
    expect(JSON.stringify(chat)).toContain('"url":"https://example.com/a.png"');
    const back = codecFor("anthropic").buildRequestBody(ir, "m");
    expect(JSON.stringify(back)).toContain('"type":"url"');
  });
});
