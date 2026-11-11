import { beforeEach, describe, expect, it } from "vitest";
import {
  askedBetas,
  fitBetas,
  isBedrockHost,
  isVertexHost,
  refuseBetas,
  refusedBetas,
  resetBetas,
  withoutRefusedBodyBetas,
} from "./betas.js";

describe("betas a provider turns away", () => {
  beforeEach(() => {
    resetBetas();
  });

  it("reads the betas an agent asked, but not its own sign-in's", () => {
    expect(
      askedBetas(["oauth-2025-04-20, tool-search-tool-2025-10-19", "context-1m-2025-08-07"]),
    ).toEqual(["tool-search-tool-2025-10-19", "context-1m-2025-08-07"]);
    expect(askedBetas([" ", ""])).toEqual([]);
  });

  it("remembers the betas a refusal names, once", () => {
    const message =
      "Unexpected value(s) `prompt-caching-scope-2026-01-05` and `redact-thinking-2026-02-12` for the `anthropic-beta` header";
    expect(refuseBetas("relay", message)).toEqual([
      "prompt-caching-scope-2026-01-05",
      "redact-thinking-2026-02-12",
    ]);
    expect(refuseBetas("relay", message)).toEqual([]);
    expect(refusedBetas("relay").size).toBe(2);
    expect(refusedBetas("other").size).toBe(0);
  });

  it("reads Copilot's wording", () => {
    expect(
      refuseBetas("copilot", "unsupported beta header(s): tool-search-tool-2025-10-19"),
    ).toEqual(["tool-search-tool-2025-10-19"]);
  });

  it("fits a list to what the provider takes", () => {
    refuseBetas("relay", "Unexpected value(s) `a` for the `anthropic-beta` header");
    expect(fitBetas("relay", ["a", "b", "b", " c "])).toEqual(["b", "c"]);
    expect(fitBetas("other", ["a", "b"])).toEqual(["a", "b"]);
  });

  it("leaves refused betas out of a body", () => {
    refuseBetas("relay", "Unexpected value(s) `a` for the `anthropic-beta` header");
    expect(withoutRefusedBodyBetas("relay", { anthropic_beta: ["a", "b"] })).toEqual({
      anthropic_beta: ["b"],
    });
    expect(withoutRefusedBodyBetas("relay", { anthropic_beta: ["a"] })).toEqual({});
    const kept = { anthropic_beta: ["b"] };
    expect(withoutRefusedBodyBetas("relay", kept)).toBe(kept);
    expect(withoutRefusedBodyBetas("relay", { messages: [] })).toEqual({ messages: [] });
  });

  it("renames and drops what Bedrock and Vertex name another way", () => {
    expect(isBedrockHost("https://bedrock-runtime.us-east-1.amazonaws.com")).toBe(true);
    expect(isBedrockHost("https://bedrock-mantle.us-east-1.api.aws")).toBe(true);
    expect(isBedrockHost("https://api.anthropic.com")).toBe(false);
    expect(isVertexHost("https://aiplatform.googleapis.com/v1/projects/p")).toBe(true);
    expect(isVertexHost("https://us-east5-aiplatform.googleapis.com")).toBe(true);
    expect(isVertexHost("https://aiplatform.eu.rep.googleapis.com")).toBe(true);
    expect(isVertexHost("https://api.anthropic.com")).toBe(false);

    const asked = [
      "advanced-tool-use-2025-11-20",
      "prompt-caching-scope-2026-01-05",
      "redact-thinking-2026-02-12",
      "context-1m-2025-08-07",
    ];
    expect(fitBetas("bedrock", asked, "https://bedrock-runtime.us-east-1.amazonaws.com")).toEqual([
      "tool-search-tool-2025-10-19",
      "context-1m-2025-08-07",
    ]);
    expect(fitBetas("vertex", asked, "https://us-east5-aiplatform.googleapis.com")).toEqual([
      "tool-search-tool-2025-10-19",
      "prompt-caching-scope-2026-01-05",
      "redact-thinking-2026-02-12",
      "context-1m-2025-08-07",
    ]);
    expect(fitBetas("relay", asked, "https://api.anthropic.com")).toEqual(asked);
  });

  it("ignores a refusal that names no beta", () => {
    expect(refuseBetas("relay", "Invalid request body")).toEqual([]);
  });
});
