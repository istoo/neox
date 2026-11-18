// A converted myna page end to end: its declarative sidebar row appears, opening its web view
// loads the real page in the sandboxed frame, and the page's `window.myna` bridge answers
// hello/options/read over the host's plugin RPC.

import "../index.css";

import type { NeolixPlugin } from "@synara/contracts";
import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

const PLUGIN: NeolixPlugin = {
  id: "acme-usage-glance",
  name: "Usage glance",
  path: "/plugins/acme-usage-glance",
  enabled: true,
  status: "running",
  contributions: {
    sidebarItems: [{ id: "page", title: "Usage glance", view: "page", section: "header" }],
  },
  web: {
    views: [
      {
        id: "page",
        title: "Usage glance",
        entry: "page/index.html",
        permissions: ["rpc"],
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
vi.mock("~/appSettings", () => ({
  useAppSettings: () => ({
    settings: { sidebarNavItems: [], sidebarFooterItems: [], showRailUsage: true },
    updateSettings: () => undefined,
  }),
}));
vi.mock("~/hooks/useBuiltinFeatures", () => ({
  useBuiltinFeatures: () => ({ isEnabled: () => true }),
}));

const { useSidebarNavItems } = await import("~/hooks/useSidebarNavItems");
const { PluginViewHost } = await import("~/plugins/PluginViewHost");

function Harness() {
  const { items } = useSidebarNavItems("header");
  const [open, setOpen] = useState(false);
  return (
    <div>
      <ul>
        {items
          .filter((item) => item.visible)
          .map((item) => (
            <li key={item.key}>
              {item.kind === "builtin" ? item.id : item.entry.contribution.title}
            </li>
          ))}
      </ul>
      <button type="button" onClick={() => setOpen(true)}>
        Open page
      </button>
      {open ? <PluginViewHost plugin={PLUGIN} viewId="page" /> : null}
    </div>
  );
}

let screen: Awaited<ReturnType<typeof render>> | null = null;
const probes: unknown[] = [];

window.addEventListener("message", (event) => {
  if ((event.data as { __mynaProbe?: boolean } | null)?.__mynaProbe) {
    probes.push(event.data);
  }
});

beforeEach(() => {
  fixture.plugins = [PLUGIN];
  probes.length = 0;
  rpc.mockReset();
  rpc.mockImplementation(async (_pluginId: string, method: string, input: unknown) => {
    if (method === "settings.options.read") {
      return { status: "ready", revision: "r1", values: { hideCost: true } };
    }
    if (method === "settings.options.write") {
      const values = (input as { values?: unknown } | undefined)?.values ?? {};
      return { status: "saved", revision: "r2", values };
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

it("shows the converted page in the sidebar and answers window.myna in the sandbox", async () => {
  screen = await render(<Harness />);

  await expect.element(page.getByText("Usage glance")).toBeVisible();
  await screen.getByRole("button", { name: "Open page" }).click();

  await vi.waitFor(() => expect(probes).toHaveLength(1), { timeout: 15_000 });
  expect(probes[0]).toMatchObject({
    calls: 3,
    hideCost: true,
    context: {},
  });
  expect(rpc.mock.calls.map((call) => call[1])).toEqual(
    expect.arrayContaining(["settings.options.read", "myna.read"]),
  );
});
