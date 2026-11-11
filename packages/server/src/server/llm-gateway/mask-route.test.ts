import { describe, expect, it } from "vitest";
import { maskedCount, maskRouteFor, unmaskedRoute, validRouteId } from "./mask-route.js";

describe("mask route", () => {
  it("counts the values masking would change, not the warned ones", () => {
    expect(maskedCount([])).toBe(0);
    expect(
      maskedCount([
        { kind: "EMAIL", by: "rule", placeholder: "{{EMAIL_00000000}}", head: "a", length: 3 },
        {
          kind: "API_KEY",
          by: "rule",
          placeholder: "{{API_KEY_00000000}}",
          head: "sk-",
          length: 3,
          action: "warn",
        },
        {
          kind: "SSN",
          by: "rule",
          placeholder: "{{SSN_00000000}}",
          head: "1",
          length: 3,
          action: "block",
        },
      ]),
    ).toBe(1);
  });

  it("knows a route that only goes unmasked", () => {
    expect(unmaskedRoute([])).toBe(false);
    expect(unmaskedRoute([{ unredacted: true }, { unredacted: true }])).toBe(true);
    expect(unmaskedRoute([{ unredacted: true }, {}])).toBe(false);
    expect(validRouteId("ollama/qwen3")).toBe(true);
    expect(validRouteId(" qwen3 ")).toBe(false);
    expect(validRouteId("/qwen3")).toBe(false);
  });

  it("sends a request masking would change to the model picked", () => {
    const hits = [
      {
        kind: "EMAIL",
        by: "rule" as const,
        placeholder: "{{EMAIL_00000000}}",
        head: "a",
        length: 3,
      },
    ];
    const base = {
      hits,
      agentTurn: true,
      routeTo: "ollama/qwen3",
      target: { id: "ollama/qwen3", unmasked: true },
      keyAllows: true,
    };
    expect(maskRouteFor(base)).toBe("ollama/qwen3");
    expect(maskRouteFor({ ...base, agentTurn: false })).toBeNull();
    expect(maskRouteFor({ ...base, hits: [] })).toBeNull();
    expect(maskRouteFor({ ...base, routeTo: "" })).toBeNull();
    expect(maskRouteFor({ ...base, target: null })).toBeNull();
    expect(maskRouteFor({ ...base, target: { id: "ollama/qwen3", unmasked: false } })).toBeNull();
    expect(maskRouteFor({ ...base, keyAllows: false })).toBeNull();
    expect(maskRouteFor({ ...base, hits: [{ ...hits[0]!, action: "warn" as const }] })).toBeNull();
  });
});
