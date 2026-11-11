import { describe, expect, it } from "vitest";
import {
  tokenFieldWanted,
  tokenFloor,
  withMaxOutput,
  withTokenField,
  withTokenFloor,
} from "./token-limits.js";

describe("token limits", () => {
  it("reads a provider's floor", () => {
    expect(tokenFloor("max_tokens must be greater than 2")).toBe(3);
    expect(tokenFloor("max_tokens: Expected a value >= 16")).toBe(16);
    expect(tokenFloor("max_completion_tokens: at least 1")).toBe(1);
    expect(tokenFloor("max_output_tokens must be more than 100")).toBe(101);
    expect(tokenFloor("max_tokens must be at most 32768")).toBe(0);
    expect(tokenFloor("Invalid request")).toBe(0);
  });

  it("raises a body's reply length to the floor, in any protocol", () => {
    expect(withTokenFloor({ max_tokens: 1 }, 3)).toEqual({ max_tokens: 3 });
    expect(withTokenFloor({ max_completion_tokens: 1 }, 3)).toEqual({ max_completion_tokens: 3 });
    expect(withTokenFloor({ max_output_tokens: 1 }, 3)).toEqual({ max_output_tokens: 3 });
    expect(withTokenFloor({ generationConfig: { maxOutputTokens: 1 } }, 3)).toEqual({
      generationConfig: { maxOutputTokens: 3 },
    });
    expect(withTokenFloor({ max_tokens: 9 }, 3)).toBeNull();
    expect(withTokenFloor({}, 3)).toBeNull();
  });

  it("renames the field a refusal names", () => {
    expect(
      tokenFieldWanted("Unsupported parameter: 'max_tokens'. Use 'max_completion_tokens' instead."),
    ).toBe("max_completion_tokens");
    expect(tokenFieldWanted("use max_tokens instead")).toBe("max_tokens");
    expect(tokenFieldWanted("max_tokens must be at most 32768")).toBeNull();

    expect(withTokenField({ max_tokens: 16 }, "max_completion_tokens")).toEqual({
      max_completion_tokens: 16,
    });
    expect(withTokenField({ max_completion_tokens: 16 }, "max_tokens")).toEqual({ max_tokens: 16 });
    expect(withTokenField({ temperature: 1 }, "max_tokens")).toBeNull();
  });

  it("lowers a reply asked for past the model's own limit", () => {
    expect(withMaxOutput("openai", { max_tokens: 128000 }, 64000)).toEqual({ max_tokens: 64000 });
    expect(withMaxOutput("openai-responses", { max_output_tokens: 128000 }, 64000)).toEqual({
      max_output_tokens: 64000,
    });
    expect(
      withMaxOutput(
        "anthropic",
        { max_tokens: 128000, thinking: { type: "enabled", budget_tokens: 32000 } },
        20000,
      ),
    ).toEqual({
      max_tokens: 20000,
      thinking: { type: "enabled", budget_tokens: 19999 },
    });
    expect(
      withMaxOutput(
        "anthropic",
        { max_tokens: 5000, thinking: { type: "enabled", budget_tokens: 2048 } },
        1024,
      ),
    ).toEqual({ max_tokens: 1024, thinking: { type: "disabled" } });
    expect(withMaxOutput("gemini", { generationConfig: { maxOutputTokens: 9000 } }, 8000)).toEqual({
      generationConfig: { maxOutputTokens: 8000 },
    });
    expect(withMaxOutput("openai", { max_tokens: 100 }, 64000)).toBeNull();
    expect(withMaxOutput("openai", { temperature: 1 }, 64000)).toBeNull();
  });
});
