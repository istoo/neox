// A plugin's declarative panels in each built-in slot: the view loads in the same sandboxed
// frame a sidebar page uses, and a provider-editor panel is told which provider it is in.

import "../index.css";

import type { NeolixPlugin, NeolixPluginPanelSlot } from "@synara/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

const SLOTS = ["agents", "usage", "settings", "provider"] as const;

const TITLES: Record<NeolixPluginPanelSlot, string> = {
  agents: "Agents strip",
  usage: "Usage strip",
  settings: "Settings strip",
  provider: "Provider strip",
};

const PLUGIN: NeolixPlugin = {
  id: "acme-usage-glance",
  name: "Usage glance",
  path: "/plugins/acme-usage-glance",
  enabled: true,
  status: "running",
  contributions: {
    panels: SLOTS.map((slot) => ({
      id: `panel-${slot}`,
      slot,
      title: TITLES[slot],
      view: "panel",
    })),
  },
  web: {
    views: [
      {
        id: "panel",
        title: "Usage glance panel",
        entry: "page/index.html",
        permissions: ["rpc", "resize"],
        rpcs: ["settings.options.read", "settings.options.write", "myna.read"],
      },
    ],
  },
};

const rpc = vi.hoisted(() => vi.fn());
const fixture = vi.hoisted(() => ({ plugins: [] as NeolixPlugin[] }));

vi.mock("~/plugins/catalog", () => ({ useRunningPlugins: () => fixture.plugins }));
vi.mock("~/plugins/contributions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/plugins/contributions")>()),
  invokePluginRpc: rpc,
}));

const { PluginSlotPanels } = await import("~/plugins/PluginSlotPanels");

const probes: Array<{ context?: unknown }> = [];
window.addEventListener("message", (event) => {
  if ((event.data as { __mynaProbe?: boolean } | null)?.__mynaProbe) {
    probes.push(event.data as { context?: unknown });
  }
});

let screen: Awaited<ReturnType<typeof render>> | null = null;

beforeEach(() => {
  fixture.plugins = [PLUGIN];
  probes.length = 0;
  rpc.mockReset();
  rpc.mockImplementation(async (_pluginId: string, method: string) => {
    if (method === "settings.options.read") {
      return { status: "ready", revision: "r1", values: { hideCost: true } };
    }
    if (method === "settings.options.write") {
      return { status: "saved", revision: "r2", values: { hideCost: true } };
    }
    if (method === "myna.read") {
      return {
        period: "today",
        since: "2026-11-14T00:00:00.000Z",
        calls: 3,
        errors: 0,
        input: 100,
        output: 20,
        cacheRead: 0,
        cost: 0.5,
        models: [],
      };
    }
    throw new Error(`unexpected plugin RPC ${method}`);
  });
});

afterEach(async () => {
  await screen?.unmount();
  screen = null;
});

it.each(SLOTS)("renders a %s panel from its declared web view", async (slot) => {
  screen = await render(
    <PluginSlotPanels
      slot={slot}
      provider={slot === "provider" ? { id: "acme-gateway", name: "Acme Gateway" } : undefined}
    />,
  );

  await expect.element(page.getByText(TITLES[slot])).toBeVisible();
  await vi.waitFor(() => expect(probes).toHaveLength(1), { timeout: 15_000 });

  if (slot === "provider") {
    expect(probes[0]?.context).toEqual({
      provider: { id: "acme-gateway", name: "Acme Gateway" },
    });
  } else {
    expect(probes[0]?.context).toEqual({});
  }
});
