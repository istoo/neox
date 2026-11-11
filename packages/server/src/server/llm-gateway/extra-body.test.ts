import { describe, expect, it } from "vitest";
import { applyExtraBody } from "./extra-body.js";

describe("applyExtraBody", () => {
  it("returns the body unchanged without extra fields", () => {
    const body = { model: "m", stream: true };
    expect(applyExtraBody(body, undefined)).toBe(body);
  });

  it("adds a field the request does not have", () => {
    expect(applyExtraBody({ model: "m" }, { prompt_cache_key: "abc" })).toEqual({
      model: "m",
      prompt_cache_key: "abc",
    });
  });

  it("keeps a field the request already carries", () => {
    expect(applyExtraBody({ temperature: 1 }, { temperature: 0.2 })).toEqual({ temperature: 1 });
  });

  it("replaces with a !name key", () => {
    expect(applyExtraBody({ temperature: 1 }, { "!temperature": 0.2 })).toEqual({
      temperature: 0.2,
    });
  });
});
