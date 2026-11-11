import { GatewayMaskingPreviewWireSchema } from "@neolix/protocol/gateway";
import { describe, expect, it } from "vitest";
import { maskHitsToWire } from "./masking-wire.js";

describe("maskHitsToWire", () => {
  it("names the length `len` so a preview with hits passes the wire schema", () => {
    const hits = maskHitsToWire([
      { kind: "EMAIL", by: "rule", placeholder: "{{EMAIL_0a1b2c3d}}", head: "al", length: 17 },
    ]);

    expect(hits).toEqual([
      { kind: "EMAIL", by: "rule", placeholder: "{{EMAIL_0a1b2c3d}}", head: "al", len: 17 },
    ]);
    expect(
      GatewayMaskingPreviewWireSchema.safeParse({
        text: "{{EMAIL_0a1b2c3d}}",
        hits,
        blocked: false,
        off: false,
      }).success,
    ).toBe(true);
  });
});
