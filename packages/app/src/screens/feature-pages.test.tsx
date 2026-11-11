// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  params: {} as { view?: string },
  compact: false,
  connected: true,
  supported: true,
  refresh: vi.fn(),
  setParams: vi.fn(),
  configError: null as Error | null,
  quotaError: null as Error | null,
  usageError: null as Error | null,
  enabled: true,
}));

vi.mock("expo-router", () => ({
  useLocalSearchParams: () => state.params,
  router: { setParams: state.setParams },
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: { count?: number }) =>
      values?.count === undefined ? key : `${key}:${values.count}`,
    i18n: { language: "en-US" },
  }),
}));
vi.mock("react-native-unistyles", () => ({
  StyleSheet: { create: () => new Proxy({}, { get: () => ({}) }) },
  withUnistyles: (component: unknown) => component,
}));
vi.mock("@/styles/settings", () => ({ settingsStyles: {} }));
vi.mock("@/constants/layout", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/constants/layout")>();
  return {
    ...actual,
    useIsCompactFormFactor: () => state.compact,
  };
});
vi.mock("@/components/sidebar/library-sidebar", () => ({
  LibrarySidebar: () => <div data-testid="library-sidebar" />,
}));
vi.mock("@/hooks/use-active-host-server-id", () => ({ useActiveHostServerId: () => "host-a" }));
vi.mock("@/runtime/host-runtime", () => ({ useHostRuntimeIsConnected: () => state.connected }));
vi.mock("@/runtime/host-features", () => ({ useHostFeature: () => state.supported }));
vi.mock("@/hooks/use-gateway-config", () => ({
  useGatewayConfig: () => ({
    config: { providers: [{ models: [{ id: "model-a" }, { id: "model-b" }] }] },
    status: { enabled: state.enabled, monthSpendUsd: 99, served: [{ key: "history-only" }] },
    isLoading: false,
    error: state.configError,
    refresh: state.refresh,
  }),
}));
vi.mock("@/screens/settings/gateway/usage-data", () => ({
  formatCompact: (value: number) => String(value),
  formatUsd: (value: number) => `$${value.toFixed(2)}`,
  useGatewayUsage: () => ({
    report: {
      totals: {
        calls: 3,
        failed: 1,
        costUsd: 2.5,
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 2,
      },
    },
    isLoading: false,
    error: state.usageError,
    refresh: state.refresh,
  }),
  useGatewayQuota: () => ({
    quota: null,
    isLoading: false,
    error: state.quotaError,
    refresh: state.refresh,
  }),
}));
vi.mock("@/components/page-layout", () => ({
  PageLayout: ({ title, children }: { title: string; children: React.ReactNode }) => (
    <div>
      <h1>{title}</h1>
      {children}
    </div>
  ),
}));
vi.mock("@/components/settings", () => ({
  SettingsCard: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SettingsRow: ({
    label,
    hint,
    children,
  }: {
    label: string;
    hint?: string;
    children?: React.ReactNode;
  }) => (
    <div>
      {label}
      {hint}
      {children}
    </div>
  ),
}));
vi.mock("@/components/ui/status-badge", () => ({
  StatusBadge: ({ label }: { label: string }) => <span>{label}</span>,
}));
vi.mock("@/components/ui/button", () => ({
  Button: ({ onPress, children }: { onPress: () => void; children: React.ReactNode }) => (
    <button type="button" onClick={onPress}>
      {children}
    </button>
  ),
}));
vi.mock("@/components/ui/alert", () => ({
  Alert: ({ title, description }: { title?: string; description?: React.ReactNode }) => (
    <div role="alert">{title ?? description}</div>
  ),
}));
vi.mock("@/components/ui/loading-spinner", () => ({ LoadingSpinner: () => <span>加载中</span> }));
vi.mock("@/components/ui/segmented-control", () => ({
  SegmentedControl: ({
    options,
    onValueChange,
  }: {
    options: { value: string; label: string }[];
    onValueChange: (value: string) => void;
  }) => {
    const select = React.useCallback(
      (event: React.MouseEvent<HTMLButtonElement>) => {
        onValueChange(event.currentTarget.value);
      },
      [onValueChange],
    );
    return (
      <div>
        {options.map((option) => (
          <button type="button" key={option.value} value={option.value} onClick={select}>
            {option.label}
          </button>
        ))}
      </div>
    );
  },
}));
vi.mock("@/screens/settings/library/library-page", () => ({
  LIBRARY_VIEWS: ["instructions", "mcp", "skills", "hooks", "subagents", "rtk"],
  HostLibraryPage: ({
    view,
    showTabs,
    onViewChange,
  }: {
    view?: string;
    showTabs?: boolean;
    onViewChange?: (value: string) => void;
  }) => {
    const select = React.useCallback(() => onViewChange?.("skills"), [onViewChange]);
    return (
      <div data-testid="library-body" data-view={view} data-tabs={String(showTabs)}>
        <button type="button" onClick={select}>
          选择技能
        </button>
      </div>
    );
  },
}));

import { GatewayAllowancesView, GatewayOverviewView } from "./myna-screen";
import { LibraryScreen } from "./library-screen";

afterEach(cleanup);
beforeEach(() => {
  state.params = {};
  state.compact = false;
  state.connected = true;
  state.supported = true;
  state.enabled = true;
  state.configError = null;
  state.quotaError = null;
  state.usageError = null;
  vi.clearAllMocks();
});

describe("模型与额度视图回归", () => {
  it("今日花费取今日账本，而非本月状态", () => {
    render(<GatewayOverviewView serverId="host-a" />);
    expect(screen.getByText("$2.50")).toBeTruthy();
    expect(screen.queryByText("$99.00")).toBeNull();
  });
  it("模型数取模型来源配置，而非历史调用过的模型", () => {
    render(<GatewayOverviewView serverId="host-a" />);
    expect(screen.getByText(/featurePages.myna.models:2/)).toBeTruthy();
  });
  it("网关关闭时不显示运行中", () => {
    state.enabled = false;
    render(<GatewayOverviewView serverId="host-a" />);
    expect(screen.getByText("featurePages.myna.disabled")).toBeTruthy();
    expect(screen.queryByText("featurePages.myna.connected")).toBeNull();
  });
  it("额度读取失败显示错误并允许重试，不伪装成空数据", () => {
    state.quotaError = new Error("额度请求失败");
    render(<GatewayAllowancesView serverId="host-a" />);
    expect(screen.getByRole("alert").textContent).toBe("额度请求失败");
    expect(screen.queryByText("featurePages.myna.noAllowances")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "common.actions.retry" }));
    expect(state.refresh).toHaveBeenCalledOnce();
  });
  it.each(["configError", "usageError"] as const)("概览展示 %s 并提供重试", (key) => {
    state[key] = new Error("读取失败");
    render(<GatewayOverviewView serverId="host-a" />);
    expect(screen.getByRole("alert").textContent).toBe("读取失败");
    fireEvent.click(screen.getByRole("button", { name: "common.actions.retry" }));
    expect(state.refresh).toHaveBeenCalledOnce();
  });
  it("主机离线不展示缓存为实时状态", () => {
    state.connected = false;
    render(<GatewayOverviewView serverId="host-a" />);
    expect(screen.getByText("settings.gatewayPages.usage.errors.disconnected")).toBeTruthy();
    expect(screen.queryByText("$2.50")).toBeNull();
  });
  it("不支持所需能力的主机显示更新提示", () => {
    state.supported = false;
    render(<GatewayOverviewView serverId="host-a" />);
    expect(screen.getByText("settings.gatewayPages.usage.errors.updateHost")).toBeTruthy();
  });
});

describe("资源库宽窄屏状态回归", () => {
  it.each([false, true])("compact=%s 时路由、标题、内容保持同一分区", (compact) => {
    state.compact = compact;
    state.params = { view: "hooks" };
    render(<LibraryScreen />);
    expect(screen.getByRole("heading").textContent).toBe("settings.usePages.library.tabs.hooks");
    expect(screen.getByTestId("library-body").getAttribute("data-view")).toBe("hooks");
    expect(screen.getByTestId("library-body").getAttribute("data-tabs")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "选择技能" }));
    expect(state.setParams).toHaveBeenCalledWith({ view: "skills" });
  });
});
