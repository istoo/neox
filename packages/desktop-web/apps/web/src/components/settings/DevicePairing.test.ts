import { describe, expect, it } from "vitest";

import { offerRequiresProtected } from "./DevicePairing";

function offerLink(offer: Record<string, unknown>): string {
  const encoded = Buffer.from(JSON.stringify(offer), "utf8").toString("base64url");
  return `https://app.example/#offer=${encoded}`;
}

describe("offerRequiresProtected", () => {
  it("reads the protected pin out of the connection offer", () => {
    expect(offerRequiresProtected(offerLink({ v: 2, minimumSecurityMode: "protected" }))).toBe(
      true,
    );
  });

  it("is false when the offer does not pin a security mode", () => {
    expect(offerRequiresProtected(offerLink({ v: 2 }))).toBe(false);
  });

  it("is false for a missing or malformed link", () => {
    expect(offerRequiresProtected(null)).toBe(false);
    expect(offerRequiresProtected("https://app.example/")).toBe(false);
    expect(offerRequiresProtected("https://app.example/#offer=not-json")).toBe(false);
  });
});
