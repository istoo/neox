// Plugins › installed and market cards: a provider's sign-in state comes from
// the host's provider statuses, both for an installed plugin and for the market
// listing whose plugin is already installed (the only place a listing can know).

import "../index.css";

import type { NeolixPlugin, NeolixPluginListing } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const api = vi.hoisted(() => ({
  list: vi.fn(),
  builtin: vi.fn(),
  market: vi.fn(),
  searchMarket: vi.fn(),
  install: vi.fn(),
  manage: vi.fn(),
  logs: vi.fn(),
  settings: vi.fn(),
  readme: vi.fn(),
}));

const host = vi.hoisted(() => ({
  enabled: false,
  patchConfig: vi.fn(),
}));

const toastAdd = vi.hoisted(() => vi.fn());

const providerStatuses = vi.hoisted(() => ({
  values: [] as Array<{ provider: string; driver: string; status: string }>,
}));

vi.mock("~/nativeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../nativeApi")>()),
  ensureNativeApi: () => ({
    neolix: {
      plugins: {
        list: api.list,
        builtin: api.builtin,
        market: api.market,
        searchMarket: api.searchMarket,
        install: api.install,
        manage: api.manage,
        logs: api.logs,
        settings: api.settings,
        readme: api.readme,
      },
    },
  }),
}));

vi.mock("~/hooks/useProviderStatusesForLocalConfig", () => ({
  useProviderStatusesForLocalConfig: () => providerStatuses.values,
}));

vi.mock("~/lib/neolixHostApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/neolixHostApi")>()),
  patchHostConfig: host.patchConfig,
}));

vi.mock("~/components/ui/toast", () => ({ toastManager: { add: toastAdd } }));

vi.mock("~/hooks/useDesktopTopBarGutter", () => ({
  useDesktopTopBarTrafficLightGutterClassName: () => "",
  useDesktopTopBarWindowControlsGutterClassName: () => "",
}));

import { PluginLibrary } from "./PluginLibrary";

const signedInPlugin: NeolixPlugin = {
  id: "acme-tools",
  name: "Acme Tools",
  description: "Acme's provider plugin",
  providers: ["acme"],
  path: "/home/xxxu/.neox/plugins/acme-tools",
  enabled: true,
  status: "running",
};

const signedOutPlugin: NeolixPlugin = {
  id: "other-tools",
  name: "Other Tools",
  description: "Another provider plugin",
  providers: ["other"],
  path: "/home/xxxu/.neox/plugins/other-tools",
  enabled: true,
  status: "running",
};

function listing(id: string, name: string): NeolixPluginListing {
  return {
    id,
    name,
    description: `${name} listing`,
    categories: [],
    author: { github: "example" },
    repository: { url: `https://github.com/example/${id}` },
    artifact: {
      kind: "git",
      remote: `https://github.com/example/${id}`,
      commit: "0123456789abcdef0123456789abcdef01234567",
    },
    media: [],
    submittedAt: "2026-01-01T00:00:00.000Z",
    reviewedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    publishedAt: "2026-01-01T00:00:00.000Z",
  };
}

function renderLibrary() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={client}>
      <PluginLibrary embedded />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  providerStatuses.values = [];
  host.enabled = false;
});

it("marks each installed plugin's provider sign-in state", async () => {
  api.list.mockResolvedValue({ plugins: [signedInPlugin, signedOutPlugin] });
  api.builtin.mockResolvedValue({ plugins: [] });
  providerStatuses.values = [
    { provider: "acme", driver: "acme", status: "ready" },
    { provider: "other", driver: "other", status: "disconnected" },
  ];
  const screen = await renderLibrary();
  try {
    await expect.poll(() => document.body.textContent ?? "").toContain("Acme Tools");
    await expect.poll(() => document.body.textContent ?? "").toContain("Signed in");
    await expect.poll(() => document.body.textContent ?? "").toContain("Not signed in");
  } finally {
    await screen.unmount();
  }
});

it("explains the global switch without blocking installation", async () => {
  api.list.mockResolvedValue({
    plugins: [{ ...signedInPlugin, status: "disabled" }],
    pluginsEnabled: false,
  });
  api.builtin.mockResolvedValue({ plugins: [] });
  const screen = await renderLibrary();
  try {
    await expect
      .poll(() => document.body.textContent ?? "")
      .toContain("Plugins are turned off for this computer.");
    await expect.poll(() => document.body.textContent ?? "").toContain("Acme Tools");
    await expect.poll(() => document.body.textContent ?? "").toContain("Disabled");
    await screen.getByRole("textbox").fill("owner/plugin");
    await expect
      .element(screen.getByRole("button", { name: "Install", exact: true }))
      .not.toBeDisabled();
  } finally {
    await screen.unmount();
  }
});

it("marks market listings whose installed plugin has a provider sign-in state", async () => {
  api.list.mockResolvedValue({ plugins: [signedInPlugin, signedOutPlugin] });
  api.builtin.mockResolvedValue({ plugins: [] });
  api.market.mockResolvedValue({
    registry: { name: "Plugin market", url: "https://plugins.example.com" },
    categories: [],
    plugins: [listing("acme-tools", "Acme Tools"), listing("other-tools", "Other Tools")],
  });
  providerStatuses.values = [
    { provider: "acme", driver: "acme", status: "ready" },
    { provider: "other", driver: "other", status: "needs_auth" },
  ];
  const screen = await renderLibrary();
  try {
    await screen.getByRole("button", { name: "Market", exact: true }).click();
    await expect.element(screen.getByText("Acme Tools listing", { exact: true })).toBeVisible();
    await expect.element(screen.getByText("Signed in", { exact: true })).toBeVisible();
    await expect.element(screen.getByText("Not signed in", { exact: true })).toBeVisible();
  } finally {
    await screen.unmount();
  }
});

it("shows the host's global plugin switch state", async () => {
  api.list.mockResolvedValue({ plugins: [], pluginsEnabled: true });
  api.builtin.mockResolvedValue({ plugins: [] });
  const screen = await renderLibrary();
  try {
    await expect
      .element(screen.getByRole("switch", { name: "Enable plugins", exact: true }))
      .toBeChecked();
    await expect
      .element(screen.getByText("Global switch for every configured plugin.", { exact: true }))
      .toBeVisible();
  } finally {
    await screen.unmount();
  }
});

it("asks before enabling plugins and writes nothing on cancel", async () => {
  api.list.mockResolvedValue({ plugins: [signedInPlugin], pluginsEnabled: false });
  api.builtin.mockResolvedValue({ plugins: [] });
  const screen = await renderLibrary();
  try {
    const toggle = screen.getByRole("switch", { name: "Enable plugins", exact: true });
    await expect.element(toggle).not.toBeChecked();

    await toggle.click();
    const dialog = page.getByRole("alertdialog", { name: "Enable plugins?" });
    await expect.element(dialog).toBeVisible();
    await expect.element(dialog.getByText(/Plugins are trusted, unsandboxed code/u)).toBeVisible();

    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect.element(dialog).not.toBeInTheDocument();
    expect(host.patchConfig).not.toHaveBeenCalled();
    await expect.element(toggle).not.toBeChecked();
  } finally {
    await screen.unmount();
  }
});

it("enables plugins through the daemon and refreshes their state", async () => {
  host.patchConfig.mockImplementation(async (patch: Record<string, unknown>) => {
    host.enabled = patch.pluginsEnabled === true;
    return { config: { pluginsEnabled: host.enabled } };
  });
  api.list.mockImplementation(async () => ({
    plugins: [{ ...signedInPlugin, status: host.enabled ? "running" : "disabled" }],
    pluginsEnabled: host.enabled,
  }));
  api.builtin.mockResolvedValue({ plugins: [] });
  const screen = await renderLibrary();
  try {
    await expect
      .poll(() => document.body.textContent ?? "")
      .toContain("Plugins are turned off for this computer.");
    await expect.element(screen.getByText("Disabled", { exact: true })).toBeVisible();

    const toggle = screen.getByRole("switch", { name: "Enable plugins", exact: true });
    await toggle.click();
    await page
      .getByRole("alertdialog", { name: "Enable plugins?" })
      .getByRole("button", { name: "Enable plugins", exact: true })
      .click();

    await expect.poll(() => host.patchConfig.mock.calls[0]?.[0]).toEqual({ pluginsEnabled: true });
    await expect.element(toggle).toBeChecked();
    await expect
      .poll(() => document.body.textContent ?? "")
      .not.toContain("Plugins are turned off for this computer.");
    await expect.element(screen.getByText("Running", { exact: true })).toBeVisible();
    expect(toastAdd).toHaveBeenCalledWith({ type: "success", title: "Plugins enabled" });
  } finally {
    await screen.unmount();
  }
});

it("disables plugins without asking", async () => {
  host.enabled = true;
  host.patchConfig.mockImplementation(async (patch: Record<string, unknown>) => {
    host.enabled = patch.pluginsEnabled === true;
    return { config: { pluginsEnabled: host.enabled } };
  });
  api.list.mockImplementation(async () => ({
    plugins: [{ ...signedInPlugin, status: host.enabled ? "running" : "disabled" }],
    pluginsEnabled: host.enabled,
  }));
  api.builtin.mockResolvedValue({ plugins: [] });
  const screen = await renderLibrary();
  try {
    const toggle = screen.getByRole("switch", { name: "Enable plugins", exact: true });
    await expect.element(toggle).toBeChecked();

    await toggle.click();
    await expect.poll(() => host.patchConfig.mock.calls[0]?.[0]).toEqual({ pluginsEnabled: false });
    await expect.element(page.getByRole("alertdialog")).not.toBeInTheDocument();
    await expect.element(toggle).not.toBeChecked();
    await expect.element(screen.getByText("Disabled", { exact: true })).toBeVisible();
    expect(toastAdd).toHaveBeenCalledWith({ type: "success", title: "Plugins disabled" });
  } finally {
    await screen.unmount();
  }
});

it("reports a failed toggle and leaves the switch off", async () => {
  api.list.mockResolvedValue({ plugins: [], pluginsEnabled: false });
  api.builtin.mockResolvedValue({ plugins: [] });
  host.patchConfig.mockRejectedValue(new Error("daemon refused the change"));
  const screen = await renderLibrary();
  try {
    const toggle = screen.getByRole("switch", { name: "Enable plugins", exact: true });
    await expect.element(toggle).not.toBeChecked();

    await toggle.click();
    await page
      .getByRole("alertdialog", { name: "Enable plugins?" })
      .getByRole("button", { name: "Enable plugins", exact: true })
      .click();

    await expect.poll(() => host.patchConfig.mock.calls.length).toBe(1);
    expect(host.patchConfig).toHaveBeenCalledWith({ pluginsEnabled: true });
    await expect
      .element(screen.getByText("daemon refused the change", { exact: true }))
      .toBeVisible();
    await expect.element(toggle).not.toBeChecked();
    expect(toastAdd).toHaveBeenCalledWith({
      type: "error",
      title: "Could not save host settings",
      description: "daemon refused the change",
    });
  } finally {
    await screen.unmount();
  }
});
