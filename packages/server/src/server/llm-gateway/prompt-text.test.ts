import { afterEach, describe, expect, it } from "vitest";
import { clearPromptBodies, keepPromptBody, promptBody } from "./prompt-text.js";

afterEach(() => clearPromptBodies());

describe("the prompt text kept in memory", () => {
  it("keeps a request's masked body by its id", () => {
    keepPromptBody("call-1", "openai", { model: "m", messages: [{ role: "user", content: "hi" }] });
    const kept = promptBody("call-1");
    expect(kept?.protocol).toBe("openai");
    expect(kept?.body).toContain('"hi"');
    expect(promptBody("other")).toBeNull();
  });

  it("keeps only the last ten requests", () => {
    for (let index = 0; index < 12; index += 1) {
      keepPromptBody(`call-${index}`, "openai", { index });
    }
    expect(promptBody("call-0")).toBeNull();
    expect(promptBody("call-11")).not.toBeNull();
  });

  it("replaces a request kept again", () => {
    keepPromptBody("call-1", "openai", { version: 1 });
    keepPromptBody("call-1", "openai", { version: 2 });
    expect(promptBody("call-1")?.body).toContain('"version":2');
  });
});
