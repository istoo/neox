import type { AgentModelDefinition } from "@neolix/protocol/agent-types";
import { describe, expect, it } from "vitest";
import { findModelByReference, formatModelDisplayName } from "./model-catalog";

describe("findModelByReference", () => {
  it("prefers an exact model id over another model's alias", () => {
    const models: AgentModelDefinition[] = [
      {
        provider: "claude",
        id: "canonical-model",
        label: "Canonical model",
        aliases: ["gateway-model"],
      },
      {
        provider: "claude",
        id: "gateway-model",
        label: "Exact gateway model",
      },
    ];

    expect(findModelByReference(models, "gateway-model")?.label).toBe("Exact gateway model");
  });
});

describe("formatModelDisplayName", () => {
  it("strips the routing prefix and names the 1M marker", () => {
    expect(
      formatModelDisplayName(
        { id: "ghcp/claude-opus-5-5[1m]", label: "claude-opus-5-5[1m]" },
        "1M context",
      ),
    ).toEqual({
      label: "claude-opus-5-5 · 1M context",
      source: "ghcp",
      contextLabel: "1M context",
      rawId: "ghcp/claude-opus-5-5[1m]",
    });
  });

  it("keeps a friendly provider label and appends the 1M tag", () => {
    expect(
      formatModelDisplayName({ id: "ghcp/claude-opus-5-5[1m]", label: "Opus 5.5" }, "1M 上下文"),
    ).toEqual({
      label: "Opus 5.5 · 1M 上下文",
      source: "ghcp",
      contextLabel: "1M 上下文",
      rawId: "ghcp/claude-opus-5-5[1m]",
    });
  });

  it("leaves ids without a prefix or marker alone", () => {
    expect(formatModelDisplayName({ id: "gpt-5.4", label: "gpt-5.4" }, "1M context")).toEqual({
      label: "gpt-5.4",
      source: null,
      contextLabel: null,
      rawId: "gpt-5.4",
    });
  });

  it("names a routing group without its group/ prefix", () => {
    expect(
      formatModelDisplayName({ id: "group/auto-gpt-5.4", label: "auto-gpt-5.4" }, "1M context"),
    ).toEqual({
      label: "auto-gpt-5.4",
      source: "group",
      contextLabel: null,
      rawId: "group/auto-gpt-5.4",
    });
  });

  it("removes a 1M marker carried by the label", () => {
    expect(formatModelDisplayName({ id: "sonnet", label: "Sonnet[1m]" }, "1M context")).toEqual({
      label: "Sonnet · 1M context",
      source: null,
      contextLabel: "1M context",
      rawId: "sonnet",
    });
  });
});
