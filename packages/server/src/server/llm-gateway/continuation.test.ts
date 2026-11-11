import { describe, expect, it } from "vitest";
import {
  ChatTail,
  Continuation,
  emptyRetries,
  finishChunk,
  geminiEnds,
  LOOP_REASKS,
  prefillMode,
  saysItsEnd,
  STREAM_RETRIES,
} from "./continuation.js";

describe("continuation", () => {
  it("knows where the upstream goes on from a prefill", () => {
    expect(prefillMode("anthropic", "api.anthropic.com", "claude-sonnet-5-5")).toBe("anthropic");
    expect(prefillMode("openai", "api.deepseek.com", "deepseek-v4")).toBe("prefix");
    expect(prefillMode("openai", "api.moonshot.cn", "kimi-k3")).toBe("partial");
    expect(prefillMode("openai", "localhost:11434", "deepseek-v4")).toBe("prefix");
    expect(prefillMode("openai", "192.168.1.9:8080", "kimi-k3")).toBe("partial");
    expect(prefillMode("openai", "api.example.com", "deepseek-v4")).toBe("");
    expect(prefillMode("openai", "localhost:11434", "glm-5")).toBe("");
    expect(prefillMode("openai-responses", "api.openai.com", "gpt-5")).toBe("");
  });

  it("asks again only where a cut reply can go on", () => {
    const full = new Continuation("anthropic");
    full.feed("text", "the answer so far");
    expect(full.possible()).toBe(true);
    expect(full.again(500, "", 0, false)).toBe(true);
    expect(full.resume).toBe(true);
    expect(new Continuation("").again(500, "", 0, false)).toBe(false);
    const refused = new Continuation("anthropic");
    refused.feed("text", "x");
    expect(refused.again(429, "refusal", 0, false)).toBe(false);
    expect(refused.again(400, "", 0, false)).toBe(false);
    expect(refused.again(404, "", 0, false)).toBe(false);
    expect(refused.again(500, "", STREAM_RETRIES, false)).toBe(false);
    expect(refused.again(500, "", 0, true)).toBe(false);

    const called = new Continuation("anthropic");
    called.feed("tool_start");
    expect(called.possible()).toBe(false);
  });

  it("sends what the client has back as the last assistant turn", () => {
    const cont = new Continuation("anthropic");
    cont.feed("think", "thinking it over");
    cont.feed("text", "the answer  \n");
    const anthropic = cont.withPrefill("anthropic", { messages: [{ role: "user", content: "q" }] });
    expect(anthropic.messages).toEqual([
      { role: "user", content: "q" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "thinking it over" },
          { type: "text", text: "the answer" },
        ],
      },
    ]);

    const prefix = new Continuation("prefix");
    prefix.feed("think", "hmm");
    prefix.feed("text", "go");
    const chat = prefix.withPrefill("openai", { messages: [] });
    expect(chat.messages).toEqual([
      { role: "assistant", content: "go", prefix: true, reasoning_content: "hmm" },
    ]);
    const partial = new Continuation("partial");
    partial.feed("text", "go");
    expect(partial.withPrefill("openai", { messages: [] }).messages).toEqual([
      { role: "assistant", content: "go", partial: true },
    ]);
  });

  it("drops a continuation's full echo of what it was prefilled with", () => {
    const cont = new Continuation("anthropic");
    cont.feed("text", "one two");
    expect(cont.again(500, "", 0, false)).toBe(true);
    expect(cont.unecho("one ")).toBe(""); // could still be the echo
    expect(cont.unecho("two three")).toBe(" three");
    expect(cont.unecho(" more")).toBe(" more");

    const other = new Continuation("anthropic");
    other.feed("text", "hello");
    other.again(500, "", 0, false);
    expect(other.unecho("something else")).toBe("something else");
  });

  it("reads a Gemini chunk's end", () => {
    expect(geminiEnds('{"candidates":[{"content":{}}]}')).toBe(false);
    expect(geminiEnds('{"candidates":[{"finishReason":"STOP"}]}')).toBe(true);
    expect(geminiEnds('{"response":{"candidates":[{"finishReason":"MAX_TOKENS"}]}}')).toBe(true);
    expect(geminiEnds('{"usageMetadata":{"totalTokenCount":3}}')).toBe(true);
    expect(geminiEnds("not json")).toBe(false);
  });

  it("knows which APIs say a reply ended", () => {
    expect(saysItsEnd("anthropic", "api.anthropic.com", "claude-sonnet-5-5")).toBe(true);
    expect(saysItsEnd("openai-responses", "api.openai.com", "gpt-5")).toBe(true);
    expect(saysItsEnd("gemini", "generativelanguage.googleapis.com", "gemini-3")).toBe(true);
    expect(saysItsEnd("openai", "generativelanguage.googleapis.com", "gemini-3")).toBe(true);
    expect(saysItsEnd("openai", "api.commandcode.ai", "claude-sonnet-5-5")).toBe(true);
    expect(saysItsEnd("openai", "localhost:11434", "gemini-3")).toBe(true);
    expect(saysItsEnd("openai", "api.openai.com", "gpt-5")).toBe(false);
  });

  it("fills a finish a Gemini-compatible Chat stream lost", () => {
    const tail = new ChatTail();
    tail.see('{"choices":[{"delta":{"tool_calls":[{},{}]}}]}');
    expect(tail.finish()).toBe("");
    tail.see('{"choices":[{"delta":{}}],"usage":{"prompt_tokens":5,"completion_tokens":1}}');
    expect(tail.finish()).toBe("tool_calls");
    const empty = new ChatTail();
    empty.see('{"usage":{"prompt_tokens":5,"completion_tokens":1}}');
    expect(empty.finish()).toBe("stop");
    expect(JSON.parse(finishChunk("stop")).choices[0].finish_reason).toBe("stop");
  });

  it("asks an empty reply again as often as the place it failed in allows", () => {
    expect(emptyRetries({ mayAskAgain: true, inGroup: false, thoughtOnly: false })).toBe(1);
    expect(emptyRetries({ mayAskAgain: false, inGroup: true, thoughtOnly: false })).toBe(1);
    expect(emptyRetries({ mayAskAgain: false, inGroup: false, thoughtOnly: true })).toBe(
      STREAM_RETRIES + 1,
    );
    expect(emptyRetries({ mayAskAgain: false, inGroup: false, thoughtOnly: false })).toBe(
      STREAM_RETRIES,
    );
    expect(LOOP_REASKS).toBe(1);
  });
});
