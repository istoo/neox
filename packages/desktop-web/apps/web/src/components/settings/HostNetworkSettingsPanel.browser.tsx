// FILE: HostNetworkSettingsPanel.browser.tsx
// Purpose: The container notice is rendered from the host status, not from config.
// Layer: Browser UI test

import "../../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";

const harness = vi.hoisted(() => ({
  status: {
    serverId: "srv-1",
    version: "0.16.5",
    pid: 42,
    startedAt: null as string | null,
    listen: "0.0.0.0:6768" as string | null,
    container: true as boolean | undefined,
  },
}));

vi.mock("~/lib/neolixHostApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/neolixHostApi")>()),
  getWebPage: async () => ({
    page: {
      mode: "off" as const,
      port: 6769,
      serving: false,
      link: null,
      network: [],
      error: null,
    },
  }),
  getLibraryGithubToken: async () => ({ configured: false }),
  setWebPage: async () => ({ page: undefined }),
  setLibraryGithubToken: async () => ({ configured: false }),
}));

vi.mock("./hostSettingsModel", () => ({
  hostConfigQueryKey: ["neolix-host-config"],
  hostStatusQueryKey: ["neolix-host-status"],
  useHostConfig: () => ({
    config: { network: { lan: false, port: 6768, listen: "0.0.0.0:6768" } },
    isLoading: false,
    error: null,
    saving: false,
    patch: vi.fn(async () => true),
  }),
  useHostStatus: () => ({
    data: harness.status,
    isLoading: false,
    isFetching: false,
    refetch: vi.fn(),
  }),
  useGatewayConfig: () => ({
    config: { allowIPs: [], corsOrigins: [] },
    isLoading: false,
    error: null,
    save: vi.fn(async () => null),
  }),
  formatBytes: (bytes: number) => `${bytes} B`,
}));

import { HostNetworkSettingsPanel } from "./HostSettingsPanels";

function renderPanel() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <HostNetworkSettingsPanel active />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  harness.status = {
    serverId: "srv-1",
    version: "0.16.5",
    pid: 42,
    startedAt: null,
    listen: "0.0.0.0:6768",
    container: true,
  };
});

it("explains that the daemon listens inside a container", async () => {
  renderPanel();

  await expect.element(page.getByText("In a container", { exact: true })).toBeVisible();
  await expect.element(page.getByText("0.0.0.0:6768", { exact: true }).first()).toBeVisible();
});

it("leaves the container row out on a host that is not containerized", async () => {
  harness.status = { ...harness.status, container: false };
  renderPanel();

  await expect.element(page.getByText("In a container", { exact: true })).not.toBeInTheDocument();
});
