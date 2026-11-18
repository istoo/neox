import { describe, expect, it } from "vitest";

import { aboutGatewayRows, statuslineCommandFor } from "./aboutSettings.logic";

describe("aboutGatewayRows", () => {
  it("shows nothing beyond the gateway address when NEOLIX_PUBLIC_URL is unset", () => {
    expect(aboutGatewayRows("127.0.0.1:6768", undefined)).toEqual({
      gatewayOrigin: "http://127.0.0.1:6768",
      publicUrl: null,
      showPublicAddress: false,
      statuslineCommand: null,
    });
  });

  it("shows the public address and status line when a tunnel URL is set", () => {
    expect(aboutGatewayRows("127.0.0.1:6768", "https://neox.example.com/")).toEqual({
      gatewayOrigin: "http://127.0.0.1:6768",
      publicUrl: "https://neox.example.com",
      showPublicAddress: true,
      statuslineCommand:
        "curl -fsS -m 1 -H 'Authorization: Bearer <gateway key>' --data-binary @- https://neox.example.com/v1/myna/statusline || true",
    });
  });

  it("hides the public row when it names the same address this computer uses", () => {
    expect(aboutGatewayRows("0.0.0.0:6768", "http://127.0.0.1:6768")).toMatchObject({
      publicUrl: "http://127.0.0.1:6768",
      showPublicAddress: false,
    });
  });

  it("has no status line without a reachable public URL", () => {
    expect(statuslineCommandFor("https://neox.example.com")).toContain(
      "https://neox.example.com/v1/myna/statusline",
    );
    expect(aboutGatewayRows("/tmp/neox.sock", "  ")).toMatchObject({
      gatewayOrigin: null,
      publicUrl: null,
      showPublicAddress: false,
      statuslineCommand: null,
    });
  });
});
