import { describe, expect, it } from "vitest";

import { resolveComposerModelPickerProviderTabs } from "./ComposerModelPickerTabs";
import { type ProviderModelPickerInstance } from "./ProviderModelPicker";

const claude = (instance: Partial<ProviderModelPickerInstance> & { instanceId: string }) =>
  ({
    provider: "claudeAgent",
    label: instance.instanceId,
    enabled: true,
    isDefault: false,
    ...instance,
  }) as ProviderModelPickerInstance;

describe("resolveComposerModelPickerProviderTabs", () => {
  const options = [{ value: "claudeAgent" as const, label: "Claude" }];

  it("shows a plugin provider under its own name instead of as a Claude account", () => {
    const tabs = resolveComposerModelPickerProviderTabs({
      options,
      providers: undefined,
      providerInstances: [
        claude({ instanceId: "claudeAgent", label: "Claude", isDefault: true }),
        claude({ instanceId: "copilot", label: "GitHub Copilot", ownIdentity: true }),
      ],
    });
    expect(
      tabs.map(({ instanceId, label, name, dotted, ownIdentity }) => ({
        instanceId,
        label,
        name,
        dotted,
        ownIdentity,
      })),
    ).toEqual([
      { instanceId: "claudeAgent", label: "Claude", name: null, dotted: false, ownIdentity: false },
      {
        instanceId: "copilot",
        label: "GitHub Copilot",
        name: null,
        dotted: false,
        ownIdentity: true,
      },
    ]);
  });

  it("still qualifies a real second Claude account", () => {
    const tabs = resolveComposerModelPickerProviderTabs({
      options,
      providers: undefined,
      providerInstances: [
        claude({ instanceId: "claudeAgent", label: "Claude", isDefault: true }),
        claude({ instanceId: "neolix-gateway", label: "Neox Gateway" }),
        claude({ instanceId: "copilot", label: "GitHub Copilot", ownIdentity: true }),
      ],
    });
    const gateway = tabs.find((tab) => tab.instanceId === "neolix-gateway");
    expect(gateway).toMatchObject({ name: "Neox Gateway", dotted: true, ownIdentity: false });
    expect(gateway?.label).toContain("Neox Gateway");
    expect(tabs.find((tab) => tab.instanceId === "copilot")).toMatchObject({
      label: "GitHub Copilot",
      dotted: false,
    });
  });
});
