import { describe, expect, it } from "vitest";
import { codexCatalogEntries, WORKING_WINDOW } from "./codex-catalog.js";

describe("codexCatalogEntries", () => {
  it("tells a longer window as the compacting one unless FullContext", () => {
    expect(codexCatalogEntries([{ id: "p/m", contextWindow: 1_000_000 }])[0]?.context_window).toBe(
      WORKING_WINDOW,
    );
    expect(
      codexCatalogEntries([{ id: "p/m", contextWindow: 1_000_000 }], { compactAt: 400_000 })[0]
        ?.context_window,
    ).toBe(400_000);
    expect(
      codexCatalogEntries([{ id: "p/m", contextWindow: 1_000_000 }], { fullContext: true })[0]
        ?.context_window,
    ).toBe(1_000_000);
    // A model of its own that is shorter keeps what it says.
    expect(codexCatalogEntries([{ id: "p/m", contextWindow: 100_000 }])[0]?.context_window).toBe(
      100_000,
    );
  });

  it("stamps multi-agent V1 on OpenAI's own models alone", () => {
    const entries = codexCatalogEntries([{ id: "codex/gpt-5" }, { id: "deepseek/v4" }], {
      agentsV1: true,
      openAiModels: ["codex/gpt-5"],
    });
    expect(entries[0]?.multi_agent_version).toBe("v1");
    expect(entries[1]?.multi_agent_version).toBeUndefined();
    expect(
      codexCatalogEntries([{ id: "codex/gpt-5" }], { openAiModels: ["codex/gpt-5"] })[0]
        ?.multi_agent_version,
    ).toBeUndefined();
  });

  it("names the auto-review model on every entry, or the entry itself for the session", () => {
    expect(
      codexCatalogEntries([{ id: "a/1" }, { id: "b/2" }], { autoReview: "a/1" }).map(
        (entry) => entry.auto_review_model_override,
      ),
    ).toEqual(["a/1", "a/1"]);
    expect(
      codexCatalogEntries([{ id: "a/1" }, { id: "b/2" }], { autoReview: "session" }).map(
        (entry) => entry.auto_review_model_override,
      ),
    ).toEqual(["a/1", "b/2"]);
    expect(codexCatalogEntries([{ id: "a/1" }])[0]?.auto_review_model_override).toBeUndefined();
  });

  it("offers the levels the user keeps of a model, and none for a reasonless one", () => {
    const [kept, reasonless, untouched] = codexCatalogEntries([
      { id: "a/1", efforts: ["low", "max", "custom"] },
      { id: "a/2", efforts: [] },
      { id: "a/3" },
    ]);
    expect(kept?.supported_reasoning_levels).toEqual([
      { effort: "low", description: "Fastest, least reasoning" },
      { effort: "max", description: "Most reasoning" },
      { effort: "custom", description: "custom" },
    ]);
    expect(kept?.supports_reasoning_summaries).toBe(true);
    expect(reasonless?.supported_reasoning_levels).toEqual([]);
    expect(reasonless?.supports_reasoning_summaries).toBe(false);
    expect(untouched?.supported_reasoning_levels.map((level) => level.effort)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });
});
