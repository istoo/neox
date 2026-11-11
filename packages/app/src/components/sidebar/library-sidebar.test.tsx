// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/hooks/use-library", () => ({ useLibrary: () => ({ library: null }) }));
vi.mock("@/hooks/use-active-host-server-id", () => ({ useActiveHostServerId: () => "host-a" }));
vi.mock("@/screens/settings/library/library-page", () => ({
  LIBRARY_VIEWS: ["instructions", "mcp", "rtk"],
  libraryViewCounts: () => ({}),
}));
vi.mock("@/stores/keyboard-shortcuts-store", () => ({
  useKeyboardShortcutsStore: (selector: (state: { setCommandCenterOpen: () => void }) => unknown) =>
    selector({ setCommandCenterOpen: () => undefined }),
}));
vi.mock("@/components/sidebar/feature-sidebar", () => ({
  FeatureSidebar: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  FeatureSidebarChevron: () => <span data-testid="feature-sidebar-chevron" />,
}));
vi.mock("@/components/sidebar/sidebar-header-row", () => ({
  SidebarHeaderRow: ({
    label,
    trailing,
    testID,
  }: {
    label: string;
    trailing?: ReactNode;
    testID?: string;
  }) => (
    <div data-testid={testID} data-trailing={trailing ? "yes" : "no"}>
      {label}
    </div>
  ),
}));
vi.mock("@/components/ui/pane-content-toolbar", () => ({
  ToolbarButton: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

import { LibrarySidebar } from "./library-sidebar";

afterEach(cleanup);

describe("LibrarySidebar compact rows", () => {
  it("adds the navigation chevron on compact layouts", () => {
    render(<LibrarySidebar compact />);

    expect(screen.getByTestId("library-sidebar-instructions").getAttribute("data-trailing")).toBe(
      "yes",
    );
  });

  it("leaves the desktop list without a chevron", () => {
    render(<LibrarySidebar />);

    expect(screen.getByTestId("library-sidebar-instructions").getAttribute("data-trailing")).toBe(
      "no",
    );
  });
});
