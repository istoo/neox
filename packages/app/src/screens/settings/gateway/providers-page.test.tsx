// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { GatewayConfigWire } from "@neolix/protocol/gateway";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/runtime/host-runtime", () => ({ useHostRuntimeClient: () => null }));
vi.mock("@/runtime/host-features", () => ({ useHostFeature: () => false }));
vi.mock("@/screens/settings/app/shared", () => ({ useSettingsNavigate: () => vi.fn() }));
vi.mock("@/plugins/row-actions", () => ({ useProviderRowActions: () => [] }));
vi.mock("@/plugins/icons", () => ({ PluginIconView: () => null }));
vi.mock("@/components/settings", () => ({
  SettingsAction: ({ label }: { label: string }) => <div>{label}</div>,
}));
vi.mock("@/components/settings/headings/settings-section", () => ({
  SettingsSection: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/components/ui/search-field", () => ({
  SearchField: ({ testID }: { testID?: string }) => <input data-testid={testID} />,
}));
vi.mock("@/components/ui/switch", () => ({
  Switch: ({ testID }: { testID?: string }) => <input data-testid={testID} type="checkbox" />,
}));
vi.mock("@/components/ui/button", () => ({
  Button: ({
    variant,
    onPress,
    testID,
    children,
  }: {
    variant?: string;
    onPress?: () => void;
    testID?: string;
    children: ReactNode;
  }) => (
    <button type="button" data-testid={testID} data-variant={variant} onClick={onPress}>
      {children}
    </button>
  ),
}));
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/components/ui/press-highlight", () => ({
  PressHighlight: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/components/ui/status-badge", () => ({ StatusBadge: () => null }));
vi.mock("./providers-add-sheet", () => ({ ProvidersAddSheet: () => null }));
vi.mock("./providers-import-sheet", () => ({ ProvidersImportSheet: () => null }));
vi.mock("./providers-editor", () => ({ ProviderEditor: () => null }));

import { GatewayProvidersPage } from "./providers-page";

const emptyConfig = { providers: [] } as unknown as GatewayConfigWire;
const noopApply = vi.fn().mockResolvedValue(undefined);
const noopEdit = vi.fn();

function renderPage(config: GatewayConfigWire = emptyConfig) {
  return render(
    <GatewayProvidersPage
      serverId="host-a"
      config={config}
      status={null}
      searchVendors={null}
      error={null}
      edit={noopEdit}
      apply={noopApply}
    />,
  );
}

afterEach(cleanup);

describe("GatewayProvidersPage empty state", () => {
  it("puts the only primary add action inside the zero-source empty state", () => {
    renderPage();

    const addInEmpty = screen.getByTestId("gateway-provider-add-empty");
    expect(addInEmpty.getAttribute("data-variant")).toBe("default");
    expect(screen.queryByTestId("gateway-provider-add")).toBeNull();
  });

  it("moves the masking switch out of the search row", () => {
    renderPage();

    const searchRow = screen.getByTestId("gateway-provider-search-row");
    const maskRow = screen.getByTestId("gateway-provider-mask-row");
    expect(searchRow.contains(maskRow)).toBe(false);
    expect(screen.getByTestId("gateway-provider-mask")).toBeTruthy();
  });
});
