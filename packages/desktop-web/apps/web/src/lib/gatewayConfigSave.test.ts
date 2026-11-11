import { describe, expect, it } from "vitest";

import { rebaseGatewayConfig } from "./gatewayConfigSave";

describe("rebaseGatewayConfig", () => {
  it("keeps a field another surface saved after this edit started", () => {
    const base = { allowIPs: ["10.0.0.1"], otel: { enabled: false }, providers: [] };
    // Settings › Gateway turned on OpenTelemetry from the old snapshot.
    const next = { ...base, otel: { enabled: true } };
    // Meanwhile Network saved a new allow-list.
    const latest = { ...base, allowIPs: ["10.0.0.1", "10.0.0.2"] };

    expect(rebaseGatewayConfig(base, next, latest)).toEqual({
      allowIPs: ["10.0.0.1", "10.0.0.2"],
      otel: { enabled: true },
      providers: [],
    });
  });

  it("applies a removed field and a new field from the edit", () => {
    const base: Record<string, unknown> = { corsOrigins: ["https://a"], keep: 1 };
    const next: Record<string, unknown> = { keep: 1, accountDiscovery: true };
    const latest: Record<string, unknown> = { corsOrigins: ["https://a"], keep: 2 };

    expect(rebaseGatewayConfig(base, next, latest)).toEqual({ keep: 2, accountDiscovery: true });
  });

  it("returns the latest document when the edit changed nothing", () => {
    const base = { a: 1 };
    const latest = { a: 3, b: 4 };
    expect(rebaseGatewayConfig(base, { a: 1 }, latest)).toEqual(latest);
  });
});
