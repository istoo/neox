import { subscriptionFixture } from "@/runtime/subscription-fixture";
/**
 * @vitest-environment jsdom
 */
import { i18n as testI18n } from "@/i18n/i18next";
import React, { type ReactElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { DaemonClient } from "@neolix/client/internal/daemon-client";
import type {
  PluginListItem,
  PluginLogEntry,
  PluginMarketSearchHit,
} from "@neolix/protocol/messages";
import { BUILTIN_FEATURE_IDS } from "@neolix/protocol/plugin-features";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostPluginsPage, type PluginsView } from "./plugins-page";

void testI18n;

const runtime = vi.hoisted(() => ({
  connected: true,
  supported: true,
  logsSupported: true,
  client: null as DaemonClient | null,
  providerEntries: [] as { provider: string; status: string }[],
}));

vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => runtime.client,
  useHostRuntimeIsConnected: () => runtime.connected,
}));

vi.mock("@/hooks/use-providers-snapshot", () => ({
  useProvidersSnapshot: () => ({
    entries: runtime.providerEntries,
    isLoading: false,
    isFetching: false,
    isRefreshing: false,
    error: null,
    supportsSnapshot: true,
    refresh: async () => {},
    refetchIfStale: () => {},
  }),
}));

vi.mock("@/runtime/host-features", () => ({
  useHostFeature: (_serverId: string, feature: string) => {
    if (feature === "pluginLogs") return runtime.logsSupported;
    return runtime.supported;
  },
}));

vi.mock("@/components/adaptive-modal-sheet", async () => {
  const ReactModule = await vi.importActual<typeof import("react")>("react");
  const actual = await vi.importActual<typeof import("@/components/adaptive-modal-sheet")>(
    "@/components/adaptive-modal-sheet",
  );
  return {
    ...actual,
    AdaptiveModalSheet: ({
      header,
      children,
      onClose,
    }: {
      header: { title: string; actions?: React.ReactNode };
      children: React.ReactNode;
      onClose(): void;
    }) =>
      ReactModule.createElement(
        "div",
        { role: "dialog" },
        ReactModule.createElement("h2", null, header.title),
        header.actions,
        ReactModule.createElement("button", { type: "button", onClick: onClose }, "Close"),
        children,
      ),
  };
});

vi.mock("react-native-reanimated", () => ({
  default: { View: "div" },
  Keyframe: class {
    duration() {
      return this;
    }
  },
  Easing: { ease: "ease", inOut: (value: unknown) => value },
  interpolateColor: (value: number, _input: number[], output: string[]) =>
    value >= 1 ? output[1] : output[0],
  useAnimatedStyle: (factory: () => unknown) => factory(),
  useDerivedValue: (factory: () => unknown) => ({ value: factory() }),
  withTiming: (value: unknown) => value,
}));

vi.mock("@gorhom/bottom-sheet", async () => {
  const ReactModule = await vi.importActual<typeof import("react")>("react");
  const { ScrollView, TextInput } =
    await vi.importActual<typeof import("react-native")>("react-native");
  return {
    BottomSheetBackdrop: () => null,
    BottomSheetHandle: () => null,
    BottomSheetModal: ReactModule.forwardRef(() => null),
    BottomSheetScrollView: ScrollView,
    BottomSheetTextInput: TextInput,
    useBottomSheetInternal: () => null,
  };
});

vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

function plugin(enabled = true): PluginListItem {
  return {
    id: "example",
    description: "Reviews changes before merge",
    path: "/plugins/example",
    enabled,
    status: enabled ? "running" : "disabled",
  };
}

async function selectPluginAction(action: string): Promise<void> {
  fireEvent.click(await screen.findByRole("button", { name: "Actions for example" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: action }));
}

function createClient() {
  return {
    observeEvents: () =>
      subscriptionFixture(
        Promise.resolve({ events: ["status.plugin_catalog_changed"] }),
        () => () => {},
      ),
    getDaemonConfig: vi.fn(async () => ({ config: { pluginsEnabled: true } })),
    patchDaemonConfig: vi.fn(async () => ({ config: { pluginsEnabled: true } })),
    listPlugins: vi.fn(async (): Promise<PluginListItem[]> => []),
    installPluginSource: vi.fn(async () => plugin()),
    reloadPlugin: vi.fn(async () => plugin()),
    enablePlugin: vi.fn(async () => plugin()),
    disablePlugin: vi.fn(async () => plugin(false)),
    removePlugin: vi.fn(async () => undefined),
    getPluginLogs: vi.fn(async (): Promise<PluginLogEntry[]> => []),
    getPluginMarket: vi.fn(async () => marketPayload()),
    searchPluginMarket: vi.fn(async (): Promise<PluginMarketSearchHit[]> => []),
    listBuiltinPlugins: vi.fn(async (): Promise<string[]> => []),
  };
}

function marketPayload(overrides: { replaces?: string[] } = {}) {
  return {
    registry: { name: "Neolix plugins", url: "https://plugins.neolix.sh" },
    categories: [
      { slug: "orchestration", label: "Orchestration", description: "Coordinate agents." },
    ],
    plugins: [
      {
        id: "37chengshan/goal-mode",
        name: "Goal Mode",
        description: "Keeps an agent on one objective across turns.",
        categories: ["orchestration"],
        author: { github: "37chengshan" },
        repository: { url: "https://github.com/37chengshan/neolix-goal-mode" },
        artifact: {
          kind: "git" as const,
          remote: "https://github.com/37chengshan/neolix-goal-mode.git",
          commit: "afd07503494c13746a5ca676f6990a9d3db71520",
        },
        media: [],
        submittedAt: "2026-10-19T13:26:05.000Z",
        reviewedAt: "2026-10-19T13:31:23.000Z",
        updatedAt: "2026-10-19T13:31:23.000Z",
        publishedAt: "2026-10-19T13:31:23.000Z",
        ...overrides,
      },
    ],
  };
}

function marketNpmHit() {
  return {
    package: "neolix-goal-mode",
    name: "neolix-goal-mode",
    description: "An npm-published Neolix plugin.",
    version: "1.2.3",
    weeklyDownloads: 1200,
    publisher: "someone",
  };
}

type PluginClient = ReturnType<typeof createClient>;

function ControlledPluginsPage() {
  const [view, setView] = React.useState<PluginsView>("installed");
  return <HostPluginsPage serverId="host-a" view={view} onViewChange={setView} />;
}

function renderPage(
  client: PluginClient | null,
  options: { uncontrolled?: boolean; fillViewport?: boolean } = {},
): void {
  runtime.client = client as unknown as DaemonClient | null;
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const element: ReactElement = (
    <QueryClientProvider client={queryClient}>
      {options.uncontrolled ? (
        <HostPluginsPage serverId="host-a" fillViewport={options.fillViewport} />
      ) : (
        <ControlledPluginsPage />
      )}
    </QueryClientProvider>
  );
  render(element);
}

describe("HostPluginsPage", () => {
  beforeEach(() => {
    void AsyncStorage.clear();
    vi.stubGlobal("React", React);
    runtime.connected = true;
    runtime.supported = true;
    runtime.logsSupported = true;
    runtime.client = null;
    runtime.providerEntries = [];
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders the offline state", () => {
    runtime.connected = false;
    renderPage(null);

    expect(screen.getByRole("alert").textContent).toContain("Plugin host is offline");
  });

  it("renders a catalog error and retries through the real query", async () => {
    const client = createClient();
    client.listPlugins.mockRejectedValueOnce(new Error("catalog exploded"));
    renderPage(client);

    expect(await screen.findByText("Unable to load plugins")).toBeDefined();
    expect(screen.getByText("catalog exploded")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(client.listPlugins).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("No plugins configured")).toBeDefined();
  });

  it.each([
    ["reloadPlugin", "Reload"],
    ["removePlugin", "Remove"],
  ] as const)("runs %s from the plugin actions menu", async (method, action) => {
    const client = createClient();
    client.listPlugins.mockResolvedValue([plugin()]);
    renderPage(client);

    await selectPluginAction(action);

    await waitFor(() => expect(client[method]).toHaveBeenCalledTimes(1));
  });

  it("hides the logs action when the host does not advertise support", async () => {
    runtime.logsSupported = false;
    const client = createClient();
    client.listPlugins.mockResolvedValue([plugin()]);
    renderPage(client);

    await screen.findByText("example");
    fireEvent.click(screen.getByRole("button", { name: "Actions for example" }));
    expect(screen.queryByRole("menuitem", { name: "Logs" })).toBeNull();
  });

  it("opens readable stdout and stderr logs and refreshes them", async () => {
    const client = createClient();
    client.listPlugins.mockResolvedValue([plugin()]);
    client.getPluginLogs.mockResolvedValue([
      {
        sequence: 1,
        timestamp: "2026-08-16T12:00:00.000Z",
        stream: "stdout",
        message: "ready",
      },
      {
        sequence: 2,
        timestamp: "2026-08-16T12:00:01.000Z",
        stream: "stderr",
        message: "warning",
      },
    ]);
    renderPage(client);

    await selectPluginAction("Logs");

    expect(await screen.findByRole("dialog")).toBeDefined();
    expect(screen.getByText("Logs: example")).toBeDefined();
    expect(await screen.findByText("ready")).toBeDefined();
    expect(screen.getByText("warning")).toBeDefined();
    expect(screen.getByText(/stdout/)).toBeDefined();
    expect(screen.getByText(/stderr/)).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(client.getPluginLogs).toHaveBeenCalledTimes(2));
  });

  it("shows empty and recoverable error states for plugin logs", async () => {
    const client = createClient();
    client.listPlugins.mockResolvedValue([plugin()]);
    client.getPluginLogs.mockRejectedValueOnce(new Error("logs exploded"));
    renderPage(client);

    await selectPluginAction("Logs");
    expect(await screen.findByText("Unable to load plugin logs")).toBeDefined();
    expect(screen.getByText("logs exploded")).toBeDefined();

    fireEvent.click(screen.getAllByRole("button", { name: "Refresh" }).at(-1)!);
    await waitFor(() => expect(client.getPluginLogs).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("No plugin output yet")).toBeDefined();
  });

  it("lists the registry's plugins on Discover and installs one by its ID", async () => {
    const client = createClient();
    client.listPlugins.mockResolvedValue([]);
    renderPage(client);

    fireEvent.click(await screen.findByRole("button", { name: "Discover" }));

    expect(await screen.findByText("Goal Mode")).toBeDefined();
    expect(screen.getByText("Keeps an agent on one objective across turns.")).toBeDefined();
    expect(screen.getByText("Plugins extend Neox")).toBeDefined();

    const card = screen.getByTestId("plugin-market-card-37chengshan/goal-mode");
    fireEvent.click(within(card).getByRole("button", { name: "Install" }));

    await waitFor(() =>
      expect(client.installPluginSource).toHaveBeenCalledWith({
        source: "37chengshan/goal-mode",
      }),
    );
  });

  it("asks npm through the China mirror when the switch is on", async () => {
    const client = createClient();
    client.listPlugins.mockResolvedValue([]);
    renderPage(client);

    fireEvent.click(await screen.findByRole("button", { name: "Discover" }));
    expect(await screen.findByText("Goal Mode")).toBeDefined();

    fireEvent.click(screen.getByRole("switch", { name: "Mirrors in China" }));
    fireEvent.change(screen.getByTestId("plugin-search-input"), { target: { value: "goal" } });

    await waitFor(
      () => expect(client.searchPluginMarket).toHaveBeenCalledWith("goal", { mirror: true }),
      { timeout: 3_000 },
    );
  });

  it("searches npm for search terms of two letters or more", async () => {
    const client = createClient();
    client.listPlugins.mockResolvedValue([]);
    client.searchPluginMarket.mockResolvedValue([marketNpmHit()]);
    renderPage(client);

    fireEvent.click(await screen.findByRole("button", { name: "Discover" }));
    fireEvent.change(screen.getByTestId("plugin-search-input"), { target: { value: "goal" } });

    await waitFor(
      () => expect(client.searchPluginMarket).toHaveBeenCalledWith("goal", { mirror: false }),
      { timeout: 3_000 },
    );
    expect(await screen.findByText("An npm-published Neolix plugin.")).toBeDefined();
    expect(screen.getByText("On npm")).toBeDefined();
  });

  it("lists built-in plugins with their groups and myna's feature switches", async () => {
    const client = createClient();
    client.listPlugins.mockResolvedValue([]);
    client.listBuiltinPlugins.mockResolvedValue(["muse-provider", "claude-usage-source"]);
    renderPage(client);

    fireEvent.click(await screen.findByRole("button", { name: "Built-in" }));

    expect(await screen.findByText("Muse Code")).toBeDefined();
    expect(screen.getByText("Claude")).toBeDefined();
    expect(screen.getAllByText("Always on")).toHaveLength(2);
    expect(screen.getAllByRole("switch")).toHaveLength(BUILTIN_FEATURE_IDS.length);
    expect(screen.getByTestId("plugin-feature-sessions")).toBeDefined();
  });

  it("persists a built-in feature switch to the daemon config", async () => {
    const client = createClient();
    client.listPlugins.mockResolvedValue([]);
    renderPage(client);

    fireEvent.click(await screen.findByRole("button", { name: "Built-in" }));
    fireEvent.click(await screen.findByTestId("plugin-feature-switch-sessions"));

    await waitFor(() =>
      expect(client.patchDaemonConfig).toHaveBeenCalledWith({
        builtinFeatures: { sessions: false },
      }),
    );
  });

  it("stores the gateway's calls per page beside the switches", async () => {
    const client = createClient();
    client.listPlugins.mockResolvedValue([]);
    renderPage(client);

    fireEvent.click(await screen.findByRole("button", { name: "Built-in" }));
    fireEvent.click(await screen.findByText("50"));

    await waitFor(() =>
      expect(client.patchDaemonConfig).toHaveBeenCalledWith({
        builtinFeatureConfig: { gateway: { callsPage: 50 } },
      }),
    );
  });

  it("pins the install bar below the scrolling body in fill mode", async () => {
    const client = createClient();
    client.listPlugins.mockResolvedValue([]);
    renderPage(client, { uncontrolled: true, fillViewport: true });

    const scrollBody = await screen.findByTestId("plugin-fill-scroll");
    const footer = await screen.findByTestId("plugin-install-footer");
    expect(scrollBody.contains(footer)).toBe(false);
    expect(footer.contains(screen.getByTestId("plugin-install-input"))).toBe(true);
  });

  it("opens Discover by default when nothing was stored", async () => {
    const client = createClient();
    client.listPlugins.mockResolvedValue([]);
    renderPage(client, { uncontrolled: true });

    expect(await screen.findByText("Plugins extend Neox")).toBeDefined();
  });

  it("opens the last visited subpage when the page mounts", async () => {
    await AsyncStorage.setItem("@neolix:plugin-view", "builtin");
    const client = createClient();
    client.listPlugins.mockResolvedValue([]);
    client.listBuiltinPlugins.mockResolvedValue(["muse-provider"]);
    renderPage(client, { uncontrolled: true });

    expect(await screen.findByText("Muse Code")).toBeDefined();
  });

  it("marks a registry plugin whose author declares it replaces a built-in", async () => {
    const client = createClient();
    client.listPlugins.mockResolvedValue([]);
    client.getPluginMarket.mockResolvedValue(marketPayload({ replaces: ["claude"] }));
    renderPage(client);

    fireEvent.click(await screen.findByRole("button", { name: "Discover" }));

    expect(await screen.findByText("Replaces built-in")).toBeDefined();
  });

  it("shows a contributed provider's sign-in state on an installed plugin", async () => {
    runtime.providerEntries = [{ provider: "muse", status: "ready" }];
    const client = createClient();
    client.listPlugins.mockResolvedValue([{ ...plugin(), providers: ["muse"] }]);
    renderPage(client);

    expect(await screen.findByText("Signed in")).toBeDefined();
    expect(screen.getByText("Serves muse")).toBeDefined();
  });

  it("opens a plugin's details and installs it from the sheet", async () => {
    const client = createClient();
    client.listPlugins.mockResolvedValue([]);
    renderPage(client);

    fireEvent.click(await screen.findByRole("button", { name: "Discover" }));
    const card = await screen.findByTestId("plugin-market-card-37chengshan/goal-mode");
    fireEvent.click(card);

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getAllByText("Goal Mode").length).toBeGreaterThan(0);
    expect(within(dialog).getByText("Keeps an agent on one objective across turns.")).toBeDefined();
    expect(within(dialog).getByRole("link", { name: "Repository" })).toBeDefined();

    fireEvent.click(within(dialog).getByRole("button", { name: "Install" }));
    await waitFor(() =>
      expect(client.installPluginSource).toHaveBeenCalledWith({
        source: "37chengshan/goal-mode",
      }),
    );
  });
});
