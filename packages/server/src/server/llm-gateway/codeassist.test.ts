import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { antigravityCloak } from "./provider-shaping.js";
import {
  antigravityModelsOf,
  antigravityRefusal,
  antigravityTurnsAway,
  codeAssistAnswer,
  codeAssistEnvelope,
  codeAssistStream,
  codeAssistStreamFrame,
  codeAssistUrl,
  isCodeAssistAgent,
  mergeAntigravityModels,
} from "./codeassist.js";

describe("codeAssistUrl", () => {
  it("posts to the method Code Assist names, streaming by method", () => {
    expect(codeAssistUrl("https://cloudcode-pa.googleapis.com/", false)).toBe(
      "https://cloudcode-pa.googleapis.com/v1internal:generateContent",
    );
    expect(codeAssistUrl("https://daily-cloudcode-pa.googleapis.com", true)).toBe(
      "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
    );
  });
});

describe("codeAssistEnvelope", () => {
  it("wraps the request with the model and the project", () => {
    expect(
      codeAssistEnvelope({
        model: "gemini-2.5-pro",
        project: "proj-1",
        request: { contents: [] },
      }),
    ).toEqual({ model: "gemini-2.5-pro", project: "proj-1", request: { contents: [] } });
  });

  it("leaves out a project the account has not been given", () => {
    expect(
      codeAssistEnvelope({ model: "gemini-2.5-pro", project: "", request: { contents: [] } }),
    ).toEqual({ model: "gemini-2.5-pro", request: { contents: [] } });
  });

  it("names a Gemini prompt with the id the CLI sends", () => {
    const envelope = codeAssistEnvelope({
      model: "gemini-2.5-pro",
      project: "proj-1",
      request: { contents: [] },
      agent: "gemini",
    });
    expect(envelope.model).toBe("gemini-2.5-pro");
    expect(envelope.project).toBe("proj-1");
    expect(envelope.user_prompt_id).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(envelope.requestType).toBeUndefined();
    expect(envelope.requestId).toBeUndefined();
  });

  it("names an Antigravity conversation from its first user prompt", () => {
    const request = {
      contents: [
        { role: "user", parts: [{ text: "Fix the build" }] },
        { role: "model", parts: [{ text: "ok" }] },
        { role: "user", parts: [{ text: "and the tests" }] },
      ],
    };
    const first = codeAssistEnvelope({
      model: "claude-sonnet-4-6",
      project: "ag-proj",
      request,
      agent: "antigravity",
    });
    expect(first.userAgent).toBe("antigravity");
    expect(first.requestType).toBe("agent");
    expect(first.requestId).toMatch(/^agent-[A-Za-z0-9_-]{16}$/);
    expect(first.user_prompt_id).toBeUndefined();
    const session = (first.request as Record<string, unknown>).sessionId;
    expect(session).toBe(sessionOf("Fix the build"));
    expect(session).toMatch(/^-\d+$/);

    const again = codeAssistEnvelope({
      model: "claude-sonnet-4-6",
      project: "ag-proj",
      request,
      agent: "antigravity",
    });
    expect((again.request as Record<string, unknown>).sessionId).toBe(session);
    expect(again.requestId).not.toBe(first.requestId);
    // The caller's request keeps the shape it came with.
    expect(request.contents[0]).toEqual({ role: "user", parts: [{ text: "Fix the build" }] });
    expect((request as Record<string, unknown>).sessionId).toBeUndefined();
  });

  it("falls back to a random Antigravity session without user text", () => {
    const request = {
      contents: [{ role: "model", parts: [{ text: "only the model spoke" }] }],
    };
    const envelope = codeAssistEnvelope({
      model: "claude-sonnet-4-6",
      project: "ag-proj",
      request,
      agent: "antigravity",
    });
    const session = (envelope.request as Record<string, unknown>).sessionId;
    expect(session).toMatch(/^-\d+$/);
    expect(session).not.toBe(sessionOf("only the model spoke"));
  });

  it("does not borrow a later user turn's text for the session", () => {
    const request = {
      contents: [
        { role: "user", parts: [{ inlineData: { mimeType: "image/png", data: "AA==" } }] },
        { role: "user", parts: [{ text: "later" }] },
      ],
    };
    const envelope = codeAssistEnvelope({
      model: "claude-sonnet-4-6",
      project: "ag-proj",
      request,
      agent: "antigravity",
    });
    const session = (envelope.request as Record<string, unknown>).sessionId;
    expect(session).toMatch(/^-\d+$/);
    expect(session).not.toBe(sessionOf("later"));
  });
});

/** Antigravity's session id for a conversation: myna's antigravitySession. */
function sessionOf(first: string): string {
  const sum = createHash("sha256").update(first).digest();
  return `-${(sum.readBigUInt64BE(0) & 0x7fffffffffffffffn).toString()}`;
}

describe("codeAssistAnswer", () => {
  it("unwraps a chunk", () => {
    expect(codeAssistAnswer({ response: { candidates: [] } })).toEqual({
      chunk: { candidates: [] },
    });
  });

  it("takes a chunk written at the top level", () => {
    expect(codeAssistAnswer({ candidates: [] })).toEqual({ chunk: { candidates: [] } });
  });

  it("reads Google's error", () => {
    expect(codeAssistAnswer({ error: { message: "quota" } })).toEqual({ error: "quota" });
  });

  it("reads nothing as nothing", () => {
    expect(codeAssistAnswer({})).toEqual({ empty: true });
    expect(codeAssistAnswer("nope")).toEqual({ empty: true });
  });
});

describe("codeAssistStream", () => {
  it("unwraps every data frame and leaves other lines alone", () => {
    const stream = [
      "event: message",
      'data: {"response":{"candidates":[{"content":{"parts":[{"text":"hi"}]}}]}}',
      "",
      'data: {"response":{"usageMetadata":{"promptTokenCount":3}}}',
      "",
    ].join("\n");
    expect(codeAssistStream(stream)).toBe(
      [
        "event: message",
        'data: {"candidates":[{"content":{"parts":[{"text":"hi"}]}}]}',
        "",
        'data: {"usageMetadata":{"promptTokenCount":3}}',
        "",
      ].join("\n"),
    );
  });

  it("keeps an unreadable frame as it came", () => {
    expect(codeAssistStreamFrame(" not-json")).toBe(" not-json");
    expect(codeAssistStreamFrame(" [DONE]")).toBe(" [DONE]");
  });

  it("turns a wrapped error into a frame the codec reads", () => {
    expect(codeAssistStreamFrame(' {"error":{"message":"quota"}}')).toBe(
      '{"error":{"message":"quota"}}',
    );
  });
});

describe("isCodeAssistAgent", () => {
  it("names the two subscriptions Code Assist serves", () => {
    expect(isCodeAssistAgent("gemini")).toBe(true);
    expect(isCodeAssistAgent("antigravity")).toBe(true);
    expect(isCodeAssistAgent("copilot")).toBe(false);
  });
});

describe("antigravityCloak", () => {
  it("breaks each line Antigravity turns away after its first letter", () => {
    const system = "You are Codex, an agent based on GPT-5. You share one workspace.";
    expect(antigravityCloak(system)).toBe(
      "Y​ou are Codex, an agent based on GPT-5. You share one workspace.",
    );
  });

  it("leaves a prompt with none of those lines as it is", () => {
    const system = "You are a helpful assistant.";
    expect(antigravityTurnsAway(system)).toBe(false);
    expect(antigravityCloak(system)).toBe(system);
  });

  it("finds a line in whatever case it was written", () => {
    expect(antigravityCloak("BUILT ON ANTHROPIC'S CLAUDE AGENT SDK")).toBe(
      "B​UILT ON ANTHROPIC'S CLAUDE AGENT SDK",
    );
  });

  it("leaves a line already broken up alone", () => {
    const cloaked = "Y​ou are Codex, an agent based on GPT-5";
    expect(antigravityTurnsAway(cloaked)).toBe(false);
    expect(antigravityCloak(cloaked)).toBe(cloaked);
  });

  it("breaks every line, not only the first", () => {
    const system =
      "x-anthropic-billing-header: cc_version=2\nYou are Codex, an agent based on GPT-5.";
    const out = antigravityCloak(system);
    expect(out).toContain("x​-anthropic-billing-header:");
    expect(out).toContain("Y​ou are Codex, an agent based on GPT-5");
  });
});

describe("antigravityRefusal", () => {
  const refused = "Resource has been exhausted (e.g. check quota).";

  it("names Codex's prompt as the reason for the 429", () => {
    expect(antigravityRefusal(429, refused, "You are Codex, an agent based on GPT-5")).toContain(
      "start a new chat on this model",
    );
  });

  it("names Hermes' persona and the Claude prompts apart", () => {
    expect(
      antigravityRefusal(
        429,
        refused,
        "You are Hermes Agent, an intelligent AI assistant created by Nous Research.",
      ),
    ).toContain("SOUL.md");
    expect(antigravityRefusal(429, refused, "x-anthropic-billing-header: cc_version=2")).toContain(
      "use another provider for these chats",
    );
  });

  it("takes the plan's own quota for what it says", () => {
    expect(
      antigravityRefusal(
        429,
        "You have exhausted your capacity on this model. Your quota will reset after 4h.",
        "You are Codex, an agent based on GPT-5",
      ),
    ).toBeNull();
  });

  it("says nothing of a 429 from another cause, or another status", () => {
    expect(antigravityRefusal(429, refused, "a normal prompt")).toBeNull();
    expect(antigravityRefusal(500, refused, "You are Codex, an agent based on GPT-5")).toBeNull();
  });
});

describe("antigravityModelsOf", () => {
  it("reads the picker's order, then the rest, with what each supports", () => {
    const models = antigravityModelsOf({
      models: {
        "gemini-later": { maxTokens: 50_000, maxOutputTokens: 5_000 },
        "gemini-first": {
          maxTokens: 200_000,
          maxOutputTokens: 10_000,
          supportsImages: true,
        },
      },
      agentModelSorts: [{ groups: [{ modelIds: ["gemini-first"] }] }],
    });
    expect(models).toEqual([
      { id: "gemini-first", context: 200_000, output: 10_000, images: true },
      { id: "gemini-later", context: 50_000, output: 5_000 },
    ]);
  });

  it("leaves out what isn't for chat and what Antigravity disabled", () => {
    const models = antigravityModelsOf({
      models: {
        "gemini-2.5-pro": {},
        chat_20706: {},
        tab_flash_lite_preview: {},
        tab_something: {},
        chat_something: {},
        "gemini-disabled": { disabled: true },
        "gemini-kept": {},
      },
    });
    expect(models.map((model) => model.id)).toEqual(["gemini-kept"]);
  });

  it("orders unwrapped picker entries by id", () => {
    const models = antigravityModelsOf({
      models: { "gemini-b": {}, "gemini-a": {} },
    });
    expect(models.map((model) => model.id)).toEqual(["gemini-a", "gemini-b"]);
  });
});

describe("mergeAntigravityModels", () => {
  it("keeps a shared model where it is, with what the least supports", () => {
    const pooled = [{ id: "a", context: 100_000, images: true }];
    const merged = mergeAntigravityModels(pooled, [{ id: "a", context: 80_000, images: false }]);
    expect(merged).toEqual([{ id: "a", context: 80_000, images: false }]);
  });

  it("puts a model only this account has where its own list has it", () => {
    const pooled = [{ id: "a" }, { id: "c" }];
    const merged = mergeAntigravityModels(pooled, [{ id: "a" }, { id: "b" }, { id: "c" }]);
    expect(merged.map((model) => model.id)).toEqual(["a", "b", "c"]);
  });

  it("leaves the pool alone when the account lists nothing new", () => {
    expect(mergeAntigravityModels([{ id: "a" }], [])).toEqual([{ id: "a" }]);
  });
});
