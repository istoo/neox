import { describe, expect, test } from "vitest";
import type { ProviderNeolixToolsPolicy } from "@neolix/protocol/provider-config";

import { isNeolixToolEnabled, resolveNeolixToolPolicy } from "./neolix-tool-policy.js";

describe("Neox tool policy", () => {
  test("defaults to all Neox tools and resolves only the exact provider ID", () => {
    const customPolicy = {
      enabled: true,
      disabledTools: ["list_agents"],
    } satisfies ProviderNeolixToolsPolicy;

    expect(
      resolveNeolixToolPolicy("custom-claude", {
        claude: { neolixTools: { enabled: false } },
        "custom-claude": { neolixTools: customPolicy },
      }),
    ).toBe(customPolicy);
    expect(resolveNeolixToolPolicy("other-custom", { claude: { neolixTools: customPolicy } })).toBe(
      undefined,
    );
    expect(isNeolixToolEnabled(undefined, "list_agents")).toBe(true);
  });

  test("applies the provider gate and sparse disabled tools without filtering speak", () => {
    expect(isNeolixToolEnabled({ enabled: false }, "list_agents")).toBe(false);
    expect(isNeolixToolEnabled({ enabled: false }, "speak")).toBe(true);
    expect(
      isNeolixToolEnabled({ enabled: true, disabledTools: ["list_agents"] }, "list_agents"),
    ).toBe(false);
    expect(
      isNeolixToolEnabled({ enabled: true, disabledTools: ["list_agents"] }, "create_agent"),
    ).toBe(true);
  });
});
