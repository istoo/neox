/* eslint-disable react-perf/jsx-no-new-object-as-prop -- each test passes one literal view prop; there is no parent to memoise it in. */
/**
 * @vitest-environment jsdom
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import SettingsScreen from "./settings-screen";
import {
  LEGACY_SETTINGS_SECTION_SLUGS,
  SETTINGS_SECTION_SLUGS,
  resolveSettingsSectionParam,
} from "@/utils/host-routes";

const state = vi.hoisted(() => ({
  compact: false,
}));

/**
 * Each host section renders a distinct content component. The probes stand in
 * for those components so a blank content pane fails the test without mounting
 * every page's runtime.
 */
vi.mock("@/screens/settings/host-page", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  const probe = (name: string) => (props: { serverId: string }) =>
    React.createElement("div", { "data-testid": `content-${name}` }, props.serverId);
  return {
    HostConnectionsPage: probe("host-connections"),
    HostPairDevicePage: probe("host-pair-device"),
    HostAgentsPage: probe("host-agents"),
    HostWorkspacesPage: probe("host-workspaces"),
    HostProvidersPage: probe("host-providers"),
    HostUsagePage: probe("host-usage"),
    HostTerminalsPage: probe("host-terminals"),
    HostSettingsPage: probe("host-settings"),
  };
});

vi.mock("@/screens/settings/plugins-page", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  return {
    HostPluginsPage: (props: { serverId: string }) =>
      React.createElement("div", { "data-testid": "content-host-plugins" }, props.serverId),
  };
});

vi.mock("@/screens/settings/metadata-generation-page", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  return {
    MetadataGenerationPage: (props: { serverId: string }) =>
      React.createElement("div", { "data-testid": "content-metadata" }, props.serverId),
  };
});

vi.mock("@/screens/settings/voice/voice-page", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  return {
    HostVoicePage: (props: { serverId: string }) =>
      React.createElement("div", { "data-testid": "content-host-voice" }, props.serverId),
  };
});

vi.mock("@/screens/settings/sessions/sessions-page", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  return {
    HostSessionsPage: (props: { serverId: string }) =>
      React.createElement("div", { "data-testid": "content-host-sessions" }, props.serverId),
  };
});

vi.mock("@/screens/settings/library/library-page", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  return {
    HostLibraryPage: (props: { serverId: string; view: string }) =>
      React.createElement(
        "div",
        { "data-testid": "content-host-library", "data-view": props.view },
        props.serverId,
      ),
  };
});

vi.mock("@/screens/settings/gateway-section", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  return {
    GatewaySettingsSection: (props: { serverId: string; pane: string; focusRecord?: string }) =>
      React.createElement(
        "div",
        {
          "data-testid": "content-gateway",
          "data-pane": props.pane,
          "data-record": props.focusRecord,
        },
        props.serverId,
      ),
  };
});

vi.mock("@/screens/projects-screen", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  return {
    default: (props: { serverId: string }) =>
      React.createElement("div", { "data-testid": "content-projects" }, props.serverId),
  };
});

vi.mock("@/screens/project-settings-screen", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  return {
    default: (props: { serverId: string; projectId: string }) =>
      React.createElement("div", { "data-testid": "content-project-settings" }, props.projectId),
  };
});

vi.mock("@/plugins/settings", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  return {
    PluginSettingsContent: (props: { pluginId: string; screenId: string }) =>
      React.createElement(
        "div",
        { "data-testid": "content-plugin-settings" },
        `${props.pluginId}/${props.screenId}`,
      ),
  };
});

vi.mock("@/plugins/plugin-list", () => ({
  usePluginDisplayName: () => "Plugin Name",
}));

vi.mock("@/screens/settings/app", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  const ids = [
    "general",
    "appearance",
    "quota",
    "network",
    "models",
    "privacy",
    "observability",
    "sync",
    "sidebar",
    "chat",
    "terminal",
    "browser",
    "editor",
    "files",
    "shortcuts",
    "integrations",
    "notifications",
    "permissions",
    "diagnostics",
    "about",
  ] as const;
  const pages = ids.map((id) => ({
    id,
    titleKey: `settings.sections.${id}`,
    icon: () => null,
    Component: () => React.createElement("div", { "data-testid": `content-page-${id}` }, id),
  }));
  return {
    SETTINGS_PAGES: pages,
    SETTINGS_PAGE_BY_ID: new Map(pages.map((page) => [page.id, page])),
    SETTINGS_PAGE_LEGACY_SECTION_MAP: {},
    isSettingsPageAvailable: () => true,
    useSettingsSearch: () => [],
  };
});

vi.mock("@/hosts/add-host", () => ({
  useAddHost: () => () => {},
}));

vi.mock("@/desktop/hooks/use-enable-built-in-daemon-option", () => ({
  useEnableBuiltInDaemonOption: () => ({ visible: false, onPress: () => {} }),
}));

vi.mock("@/keyboard", () => ({
  useHardwareKeyboardPresent: () => true,
}));

// The picker's Combobox pulls in @floating-ui/react-native, whose package entry
// Vitest cannot load; the host group is empty in these tests, so a stub is faithful.
vi.mock("@/components/hosts/host-picker", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  return {
    HostPicker: ({ children }: { children?: React.ReactNode }) =>
      React.createElement("div", null, children),
  };
});

vi.mock("@/navigation/settings-presentation", () => ({
  selectSettingsHost: () => {},
  useSettingsHostSelection: () => null,
  useSettingsSidebarScroll: () => ({}),
}));

vi.mock("@/navigation/settings-navigation", () => ({
  returnFromSettings: () => {},
}));

vi.mock("@/runtime/host-runtime", () => ({
  useHosts: () => [],
}));

vi.mock("@/hooks/use-is-local-daemon", () => ({
  useLocalDaemonServerId: () => null,
}));

vi.mock("@/constants/layout", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/constants/layout")>();
  return {
    ...actual,
    useIsCompactFormFactor: () => state.compact,
  };
});

vi.mock("@/stores/settings-subview-store", () => ({
  useSettingsSubviewStore: (selector: (value: unknown) => unknown) =>
    selector({ library: "mcp", setLibrary: () => {} }),
}));

vi.mock("@/components/page-layout", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  return {
    PageLayout: ({
      title,
      titleTestID,
      testID,
      children,
    }: {
      title?: string;
      titleTestID?: string;
      testID?: string;
      children?: React.ReactNode;
    }) =>
      React.createElement(
        "div",
        { "data-testid": testID },
        React.createElement("h1", { "data-testid": titleTestID }, title),
        children,
      ),
  };
});

vi.mock("@/components/headers/back-header", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  return {
    BackHeader: ({ title }: { title?: string }) =>
      React.createElement("h1", { "data-testid": "back-header-title" }, title),
  };
});

vi.mock("@/components/desktop/titlebar-drag-region", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  return {
    TitlebarDragRegion: () => React.createElement("div", null),
  };
});

vi.mock("@/utils/desktop-window", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  const passthrough = ({ children }: { children?: React.ReactNode }) =>
    React.createElement("div", null, children);
  return {
    WindowChromeRegion: passthrough,
    WindowChromeSafeArea: () => React.createElement("div", null),
  };
});

vi.mock("@/components/ui/text-input", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  const EditingTextInput = React.forwardRef((_props: unknown, _ref: unknown) =>
    React.createElement("input"),
  );
  return { EditingTextInput };
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en-US" },
  }),
}));

afterEach(cleanup);

beforeEach(() => {
  state.compact = false;
});

describe("SettingsScreen host settings content", () => {
  const hostCases = [
    { section: "projects", testId: "content-projects" },
    { section: "connections", testId: "content-host-connections" },
    { section: "pair-device", testId: "content-host-pair-device" },
    { section: "agents", testId: "content-host-agents" },
    { section: "metadata", testId: "content-metadata" },
    { section: "voice", testId: "content-host-voice" },
    { section: "workspaces", testId: "content-host-workspaces" },
    { section: "providers", testId: "content-host-providers" },
    { section: "sessions", testId: "content-host-sessions" },
    { section: "library", testId: "content-host-library" },
    { section: "gateway", testId: "content-gateway" },
    { section: "gateway-providers", testId: "content-gateway" },
    { section: "gateway-routing", testId: "content-gateway" },
    { section: "gateway-keys", testId: "content-gateway" },
    { section: "gateway-advanced", testId: "content-gateway" },
    { section: "usage", testId: "content-host-usage" },
    { section: "terminals", testId: "content-host-terminals" },
    { section: "masking", testId: "content-gateway" },
    { section: "plugins", testId: "content-host-plugins" },
    { section: "host", testId: "content-host-settings" },
  ] as const;

  it.each(hostCases)("$section renders its page in the detail pane", ({ section, testId }) => {
    render(<SettingsScreen view={{ kind: "host", serverId: "host-a", section }} />);
    expect(screen.getByTestId(testId).textContent).toBe("host-a");
    expect(screen.getByTestId("settings-detail-header-title").textContent).not.toBe("");
  });

  it("masking keeps the focused record", () => {
    render(
      <SettingsScreen
        view={{ kind: "host", serverId: "host-a", section: "masking", focusRecord: "record-1" }}
      />,
    );
    expect(screen.getByTestId("content-gateway").getAttribute("data-record")).toBe("record-1");
  });

  it("library reads its subpage from the shared store", () => {
    render(<SettingsScreen view={{ kind: "host", serverId: "host-a", section: "library" }} />);
    expect(screen.getByTestId("content-host-library").getAttribute("data-view")).toBe("mcp");
  });
});

describe("SettingsScreen project and plugin content", () => {
  it("project settings render in the detail pane with their title", () => {
    render(
      <SettingsScreen view={{ kind: "project", serverId: "host-a", projectId: "project-1" }} />,
    );
    expect(screen.getByTestId("content-project-settings").textContent).toBe("project-1");
    expect(screen.getByTestId("settings-detail-header-title").textContent).toBe(
      "settings.projects",
    );
  });

  it("plugin settings render in the detail pane with the plugin title", () => {
    render(
      <SettingsScreen
        view={{
          kind: "plugin",
          serverId: "host-a",
          pluginId: "plugin-1",
          screenId: "screen-1",
        }}
      />,
    );
    expect(screen.getByTestId("content-plugin-settings").textContent).toBe("plugin-1/screen-1");
    expect(screen.getByTestId("settings-detail-header-title").textContent).toBe("Plugin Name");
  });
});

describe("SettingsScreen compact layouts", () => {
  beforeEach(() => {
    state.compact = true;
  });

  it("host settings keep their content and title", () => {
    render(<SettingsScreen view={{ kind: "host", serverId: "host-a", section: "connections" }} />);
    expect(screen.getByTestId("content-host-connections").textContent).toBe("host-a");
    expect(screen.getByRole("heading").textContent).toBe("settings.hostSections.connections");
  });

  it("project settings keep their content and title", () => {
    render(
      <SettingsScreen view={{ kind: "project", serverId: "host-a", projectId: "project-1" }} />,
    );
    expect(screen.getByTestId("content-project-settings").textContent).toBe("project-1");
    expect(screen.getByRole("heading").textContent).toBe("settings.projects");
  });
});

describe("SettingsScreen app sections", () => {
  it.each(SETTINGS_SECTION_SLUGS)("%s renders a non-empty page", (section) => {
    render(<SettingsScreen view={{ kind: "section", section }} />);
    expect(screen.getByTestId(`content-page-${section}`).textContent).toBe(section);
    expect(screen.getByTestId("settings-detail-header-title").textContent).not.toBe("");
  });
});

describe("SettingsScreen removed ChatGPT sections", () => {
  it.each(LEGACY_SETTINGS_SECTION_SLUGS)("%s redirects to /settings", (section) => {
    expect(resolveSettingsSectionParam(section)).toEqual({ kind: "redirect", href: "/settings" });
  });
});
