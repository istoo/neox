import { describe, expect, it } from "vitest";
import { chatTextParts } from "./chat-text-parts.js";

describe("chat text parts", () => {
  it("joins a list of plain text parts", () => {
    const body = {
      model: "m",
      messages: [
        { role: "user", content: [{ type: "text", text: "one" }] },
        {
          role: "user",
          content: [
            { type: "text", text: "two" },
            { type: "text", text: "three" },
          ],
        },
      ],
    };
    expect(chatTextParts(body).messages).toEqual([
      { role: "user", content: "one" },
      { role: "user", content: "two\nthree" },
    ]);
  });

  it("keeps a list with anything but plain text", () => {
    const cases: unknown[] = [
      [
        { type: "text", text: "a" },
        { type: "image_url", image_url: { url: "x" } },
      ],
      [{ type: "text", text: "a", cache_control: { type: "ephemeral" } }],
      [{ type: "thinking", thinking: "a" }],
      [{ type: "text" }],
      [],
    ];
    for (const content of cases) {
      const body = { messages: [{ role: "user", content }] };
      expect(chatTextParts(body)).toBe(body);
    }
  });

  it("leaves a body with no messages, or string content, as it was", () => {
    const noMessages = { model: "m" };
    expect(chatTextParts(noMessages)).toBe(noMessages);
    const stringContent = { messages: [{ role: "user", content: "hi" }] };
    expect(chatTextParts(stringContent)).toBe(stringContent);
  });
});
