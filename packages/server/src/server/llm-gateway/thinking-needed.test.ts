import { beforeEach, describe, expect, it } from "vitest";
import {
  markNeedsThinking,
  needsThinking,
  refusedThinkingNeeded,
  resetThinkingNeeded,
  withThinkingEnabled,
} from "./thinking-needed.js";

describe("thinking needed", () => {
  beforeEach(() => {
    resetThinkingNeeded();
  });

  it("reads the refusal", () => {
    expect(refusedThinkingNeeded('thinking.type must be "enabled"')).toBe(true);
    expect(refusedThinkingNeeded("thinking_type should be enabled")).toBe(true);
    expect(refusedThinkingNeeded("messages: invalid")).toBe(false);
  });

  it("sends thinking at the least budget, past the reply limit", () => {
    const { body, changed } = withThinkingEnabled({
      max_tokens: 1,
      temperature: 0.2,
      top_p: 0.9,
      top_k: 5,
    });
    expect(changed).toBe(true);
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 1024 });
    expect(body.max_tokens).toBe(1025);
    expect(body.temperature).toBeUndefined();
    expect(body.top_p).toBeUndefined();
    expect(body.top_k).toBeUndefined();
    // A body that already thinks is left as it is.
    const asked = { thinking: { type: "enabled", budget_tokens: 2056 }, max_tokens: 4096 };
    expect(withThinkingEnabled(asked).changed).toBe(false);
    expect(withThinkingEnabled({ thinking: { type: "adaptive" } }).changed).toBe(false);
    // A limit already past the budget stays.
    expect(withThinkingEnabled({ max_tokens: 8192 }).body.max_tokens).toBe(8192);
  });

  it("remembers the provider's model", () => {
    expect(needsThinking("relay", "m")).toBe(false);
    markNeedsThinking("relay", "m");
    expect(needsThinking("relay", "m")).toBe(true);
    expect(needsThinking("relay", "other")).toBe(false);
  });
});
