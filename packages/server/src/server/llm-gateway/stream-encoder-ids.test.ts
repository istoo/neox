import { describe, expect, it } from "vitest";
import { anthropicCodec } from "./anthropic-codec.js";
import { geminiCodec } from "./gemini-codec.js";
import { openAiChatCodec } from "./openai-chat-codec.js";
import { openAiResponsesCodec } from "./openai-responses-codec.js";

describe("a stream encoder's reply id", () => {
  it("names the reply it writes", () => {
    for (const codec of [anthropicCodec, openAiChatCodec, openAiResponsesCodec, geminiCodec]) {
      const encoder = codec.createStreamEncoder("local/model-a");
      const id = encoder.replyId?.();
      expect(typeof id).toBe("string");
      expect((id ?? "").length).toBeGreaterThan(0);
      const started = encoder.start();
      // Gemini's stream names it on the first chunk rather than a start event.
      if (started !== "") {
        expect(started).toContain(id ?? "none");
      }
    }
  });
});
