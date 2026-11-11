import { describe, expect, test } from "vitest";

import { MutableDaemonConfigPatchSchema, MutableDaemonConfigSchema } from "./messages.js";
import { ProviderOverrideSchema, ProviderNeolixToolsPolicySchema } from "./provider-config.js";

describe("provider Neolix-tool policy", () => {
  test("accepts arbitrary tool IDs and leaves an empty policy enabled by default", () => {
    expect(
      ProviderNeolixToolsPolicySchema.parse({
        disabledTools: ["future_tool", "browser_future_tool"],
      }),
    ).toEqual({
      disabledTools: ["future_tool", "browser_future_tool"],
    });
    expect(ProviderNeolixToolsPolicySchema.parse({})).toEqual({});
    expect(ProviderOverrideSchema.parse({}).neolixTools).toBeUndefined();
  });

  test("accepts neolixTools on persisted provider overrides", () => {
    expect(
      ProviderOverrideSchema.parse({
        extends: "claude",
        neolixTools: {
          enabled: false,
          disabledTools: ["create_workspace"],
        },
      }).neolixTools,
    ).toEqual({
      enabled: false,
      disabledTools: ["create_workspace"],
    });
  });

  test("accepts neolixTools when reading and patching mutable daemon providers", () => {
    expect(
      MutableDaemonConfigSchema.parse({
        mcp: { injectIntoAgents: true },
        providers: {
          codex: {
            neolixTools: { enabled: false, disabledTools: ["future_tool"] },
          },
        },
      }).providers.codex?.neolixTools,
    ).toEqual({
      enabled: false,
      disabledTools: ["future_tool"],
    });

    expect(
      MutableDaemonConfigPatchSchema.parse({
        providers: {
          codex: {
            neolixTools: { disabledTools: ["browser_future_tool"] },
          },
        },
      }).providers?.codex?.neolixTools,
    ).toEqual({ disabledTools: ["browser_future_tool"] });
  });
});
