// Plugin subscriptions: a plugin's provider renders its sign-in methods, the
// prompt form submits the typed inputs, and a pending sign-in is followed to
// completion.

import "../../../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { userEvent } from "vitest/browser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import type { GatewayConfig, GatewayPluginSubscriptionProvider } from "~/lib/gatewayTypes";

import { GatewayAdvancedPane } from "./GatewayAdvancedPane";

const fixture = vi.hoisted(() => ({
  pluginSubscriptions: vi.fn(),
  pluginSubscriptionSignIn: vi.fn(),
  pluginSubscriptionSignInPoll: vi.fn(),
  subscriptionAccounts: vi.fn(),
  codexAccounts: vi.fn(),
  heldList: vi.fn(),
  getConfig: vi.fn(),
}));

vi.mock("~/lib/neolixGatewayApi", () => ({
  neolixGatewayApi: {
    getConfig: fixture.getConfig,
    pluginSubscriptions: fixture.pluginSubscriptions,
    pluginSubscriptionSignIn: fixture.pluginSubscriptionSignIn,
    pluginSubscriptionSignInPoll: fixture.pluginSubscriptionSignInPoll,
    subscriptionAccounts: fixture.subscriptionAccounts,
    codexAccounts: fixture.codexAccounts,
    heldList: fixture.heldList,
  },
}));

vi.mock("~/hooks/useBuiltinFeatures", () => ({
  useBuiltinFeatures: () => ({
    isEnabled: () => true,
    isLoading: false,
    features: {},
    useCounts: {},
    setEnabled: async () => {},
    gatewayCallsPage: 50,
    setGatewayCallsPage: async () => {},
    settingsSections: [],
    gatewayTabs: [],
    railUsage: [],
  }),
}));

const PROVIDER: GatewayPluginSubscriptionProvider = {
  pluginId: "acme-plugin",
  id: "acme-account",
  label: "Acme Cloud",
  protocol: "anthropic",
  methods: [
    {
      type: "oauth",
      label: "Acme sign in",
      prompts: [{ key: "workspace", type: "text", message: "Workspace URL" }],
    },
    { type: "oauth", label: "Quick sign in" },
  ],
};

function Harness() {
  const [config, setConfig] = useState<GatewayConfig>({ version: 1 });
  return (
    <GatewayAdvancedPane
      config={config}
      searchVendors={null}
      edit={(mutate) =>
        setConfig((current) => {
          const draft = structuredClone(current);
          mutate(draft);
          return draft;
        })
      }
      apply={async () => {}}
    />
  );
}

async function renderPane() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={client}>
      <Harness />
    </QueryClientProvider>,
  );
}

function namedButtons(name: string): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll<HTMLButtonElement>("button")).filter(
    (button) => (button.textContent ?? "").trim() === name,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  fixture.pluginSubscriptions.mockResolvedValue({ providers: [PROVIDER] });
  fixture.subscriptionAccounts.mockResolvedValue({ accounts: [] });
  fixture.codexAccounts.mockResolvedValue({ owned: [], codex: null });
  fixture.heldList.mockResolvedValue({ names: [] });
});

describe("plugin subscription providers", () => {
  it("renders nothing when no plugin provides a subscription", async () => {
    fixture.pluginSubscriptions.mockResolvedValue({ providers: [] });
    const screen = await renderPane();
    try {
      await expect.poll(() => fixture.pluginSubscriptions.mock.calls.length).toBeGreaterThan(0);
      expect(document.body.textContent).not.toContain("Plugin subscriptions");
    } finally {
      await screen.unmount();
    }
  });

  it("shows the provider's methods, collects prompts, and submits the typed values", async () => {
    fixture.pluginSubscriptionSignIn.mockResolvedValue({ status: "signed_in" });
    const screen = await renderPane();
    try {
      await expect.element(screen.getByText("Acme Cloud")).toBeVisible();
      expect(document.body.textContent).toContain("acme-plugin/acme-account · anthropic");

      await userEvent.click(namedButtons("Acme sign in")[0]!);
      const input = screen.getByRole("textbox", { name: "Workspace URL" });
      await expect.element(input).toBeVisible();
      await input.fill("https://acme.example/team");

      // The form's submit repeats the method label, after the row's own button.
      const submits = namedButtons("Acme sign in");
      expect(submits).toHaveLength(2);
      await userEvent.click(submits[1]!);

      await expect
        .poll(() => fixture.pluginSubscriptionSignIn.mock.calls.at(-1)?.[0])
        .toEqual({
          pluginId: "acme-plugin",
          providerId: "acme-account",
          method: 0,
          accountId: "acme-account",
          inputs: { workspace: "https://acme.example/team" },
        });
      await expect.poll(() => document.body.textContent ?? "").toContain("Signed in to Acme Cloud");
    } finally {
      await screen.unmount();
    }
  });

  it("follows a pending sign-in to the signed-in state", async () => {
    fixture.pluginSubscriptionSignIn.mockResolvedValue({
      status: "pending",
      token: "token-1",
      url: "https://acme.example/sign-in",
    });
    fixture.pluginSubscriptionSignInPoll.mockResolvedValue({ status: "signed_in" });
    const screen = await renderPane();
    try {
      await expect.element(screen.getByText("Acme Cloud")).toBeVisible();
      await userEvent.click(namedButtons("Quick sign in")[0]!);

      await expect
        .element(screen.getByText("Waiting for Acme Cloud to finish signing in…"))
        .toBeVisible();
      expect(screen.getByText("https://acme.example/sign-in")).toBeVisible();
      await expect
        .poll(() => fixture.pluginSubscriptionSignInPoll.mock.calls.at(-1)?.[0], {
          timeout: 5_000,
        })
        .toEqual({
          pluginId: "acme-plugin",
          providerId: "acme-account",
          token: "token-1",
        });
      await expect
        .poll(() => document.body.textContent ?? "", { timeout: 5_000 })
        .toContain("Signed in to Acme Cloud");
      await expect
        .poll(() => document.body.textContent ?? "")
        .not.toContain("Waiting for Acme Cloud");
    } finally {
      await screen.unmount();
    }
  });
});
