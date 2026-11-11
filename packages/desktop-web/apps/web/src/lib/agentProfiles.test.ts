// FILE: agentProfiles.test.ts
// Purpose: Covers profile wire validation and option sanitizing before values reach a
//          provider process.
// Layer: Web settings tests

import { describe, expect, it } from "vitest";

import {
  agentProfileErrorMessage,
  agentProfileModel,
  agentProfileProvider,
  buildAgentProfileFromComposer,
  generateAgentProfileId,
  isAgentProfileRuntimeMode,
  sanitizeAgentProfileProviderOptions,
} from "./agentProfiles";

describe("agent profile providers", () => {
  it("accepts a known provider and rejects anything else", () => {
    expect(agentProfileProvider({ id: "1", name: "Work", provider: "claudeAgent" })).toBe(
      "claudeAgent",
    );
    expect(agentProfileProvider({ id: "1", name: "Work", provider: "unknown" })).toBeNull();
  });

  it("recognizes the four access modes and nothing else", () => {
    expect(isAgentProfileRuntimeMode("full-access")).toBe(true);
    expect(isAgentProfileRuntimeMode("plan")).toBe(false);
  });

  it("trims a model id and treats a blank one as the provider default", () => {
    expect(agentProfileModel({ id: "1", name: "Work", provider: "codex", model: " gpt-5 " })).toBe(
      "gpt-5",
    );
    expect(agentProfileModel({ id: "1", name: "Work", provider: "codex", model: "   " })).toBe("");
  });
});

describe("sanitizeAgentProfileProviderOptions", () => {
  it("keeps the option keys the composer sets for the provider", () => {
    expect(
      sanitizeAgentProfileProviderOptions("claudeAgent", {
        effort: "high",
        thinking: false,
        fastMode: true,
      }),
    ).toEqual({ effort: "high", thinking: false, fastMode: true });
  });

  it("drops keys belonging to another provider, wrong types, and unknown keys", () => {
    expect(
      sanitizeAgentProfileProviderOptions("codex", {
        reasoningEffort: "high",
        effort: "high",
        fastMode: "yes",
        env: { secret: true },
      }),
    ).toEqual({ reasoningEffort: "high" });
  });

  it("returns an empty object for a non-record", () => {
    expect(sanitizeAgentProfileProviderOptions("pi", null)).toEqual({});
    expect(sanitizeAgentProfileProviderOptions("pi", ["thinkingLevel"])).toEqual({});
  });
});

describe("profile ids and errors", () => {
  it("generates distinct ids", () => {
    const ids = new Set(Array.from({ length: 20 }, () => generateAgentProfileId()));
    expect(ids.size).toBe(20);
  });

  it("uses the error message when there is one", () => {
    expect(agentProfileErrorMessage(new Error("offline"))).toBe("offline");
    expect(agentProfileErrorMessage("nope")).toBe("nope");
  });
});

describe("buildAgentProfileFromComposer", () => {
  it("captures provider, model, mode, allowed options, and notes", () => {
    expect(
      buildAgentProfileFromComposer({
        id: "p1",
        name: "  Deep review ",
        provider: "claudeAgent",
        model: " claude-opus-5-5 ",
        modeId: "full-access",
        providerOptions: { effort: "high", fastMode: true, env: { secret: true } },
        notes: "  read carefully  ",
      }),
    ).toEqual({
      id: "p1",
      name: "Deep review",
      provider: "claudeAgent",
      model: "claude-opus-5-5",
      modeId: "full-access",
      providerOptions: { effort: "high", fastMode: true },
      notes: "read carefully",
    });
  });

  it("omits blank fields and unknown modes so applying leaves them alone", () => {
    expect(
      buildAgentProfileFromComposer({
        id: "p2",
        name: "Bare",
        provider: "codex",
        model: "   ",
        modeId: "plan",
        providerOptions: null,
        notes: "",
      }),
    ).toEqual({ id: "p2", name: "Bare", provider: "codex" });
  });
});
