import { describe, expect, it } from "vitest";
import { parseTtlSeconds } from "./index.js";

describe("gateway-key oidc --ttl", () => {
  it("reads the durations myna's time.ParseDuration reads", () => {
    expect(parseTtlSeconds("1h")).toBe(3_600);
    expect(parseTtlSeconds("30m")).toBe(1_800);
    expect(parseTtlSeconds("90s")).toBe(90);
    expect(parseTtlSeconds("1h30m")).toBe(5_400);
    expect(parseTtlSeconds("2d")).toBe(172_800);
  });

  it("refuses what is not a duration", () => {
    for (const value of ["soon", "1x", "h", "1h later", ""]) {
      expect(() => parseTtlSeconds(value)).toThrow(/--ttl is a duration/);
    }
  });
});
