import { describe, expect, it } from "vitest";

import { shouldClearThreadAttention } from "./threadAttentionClear.logic";

describe("shouldClearThreadAttention", () => {
  it("clears on every trigger while the document is visible", () => {
    for (const trigger of ["focus-entry", "input-focus", "prompt-send", "agent-blur"] as const) {
      expect(
        shouldClearThreadAttention({ threadId: "agent-1", isDocumentVisible: true, trigger }),
      ).toBe(true);
    }
  });

  it("does not clear a hidden document", () => {
    expect(
      shouldClearThreadAttention({
        threadId: "agent-1",
        isDocumentVisible: false,
        trigger: "input-focus",
      }),
    ).toBe(false);
  });

  it("suppresses a deferred focus-entry clear", () => {
    expect(
      shouldClearThreadAttention({
        threadId: "agent-1",
        isDocumentVisible: true,
        trigger: "focus-entry",
        hasDeferredFocusEntryClear: true,
      }),
    ).toBe(false);
    expect(
      shouldClearThreadAttention({
        threadId: "agent-1",
        isDocumentVisible: true,
        trigger: "prompt-send",
        hasDeferredFocusEntryClear: true,
      }),
    ).toBe(true);
  });

  it("does not clear while an approval or question is pending", () => {
    for (const trigger of ["focus-entry", "input-focus", "prompt-send", "agent-blur"] as const) {
      expect(
        shouldClearThreadAttention({
          threadId: "agent-1",
          isDocumentVisible: true,
          trigger,
          hasPendingPermission: true,
        }),
      ).toBe(false);
    }
  });

  it("needs a real thread id", () => {
    expect(
      shouldClearThreadAttention({
        threadId: null,
        isDocumentVisible: true,
        trigger: "focus-entry",
      }),
    ).toBe(false);
    expect(
      shouldClearThreadAttention({
        threadId: "   ",
        isDocumentVisible: true,
        trigger: "focus-entry",
      }),
    ).toBe(false);
  });
});
