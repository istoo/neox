// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { AggregatedSchedule } from "@/hooks/use-schedules";

const state = vi.hoisted(() => ({
  loadState: { status: "loaded", data: [] as AggregatedSchedule[] } as
    | { status: "loaded"; data: AggregatedSchedule[] }
    | { status: "loading" }
    | { status: "offline" },
  isError: false as boolean,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/hooks/use-schedules", () => ({
  useSchedules: () => state,
}));
vi.mock("@/components/sidebar/feature-sidebar", () => ({
  FeatureSidebar: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  FeatureSidebarChevron: () => null,
}));
vi.mock("@/components/sidebar/sidebar-header-row", () => ({
  SidebarHeaderRow: ({ label, testID }: { label: string; testID?: string }) => (
    <div data-testid={testID}>{label}</div>
  ),
}));
vi.mock("@/components/ui/pane-content-toolbar", () => ({
  ToolbarButton: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/components/ui/search-field", () => ({ SearchField: () => <input /> }));
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/utils/schedule-format", () => ({
  filterSchedulesForSidebar: (
    schedules: AggregatedSchedule[],
    filter: "active" | "ended",
    query: string,
  ) =>
    schedules
      .filter((schedule) =>
        filter === "ended" ? schedule.status === "completed" : schedule.status !== "completed",
      )
      .filter((schedule) => (query.trim() ? schedule.name?.includes(query) : true)),
  formatCadence: () => "cadence",
  resolveScheduleTitle: (schedule: AggregatedSchedule) => schedule.name ?? "untitled",
}));

import { SchedulesSidebar } from "./schedules-sidebar";

const activeSchedule: AggregatedSchedule = {
  id: "schedule-a",
  name: "Nightly",
  prompt: "Run the tests",
  cadence: { type: "every", everyMs: 3_600_000 },
  target: { type: "new-agent", config: { provider: "claude-code", cwd: "/repo" } },
  status: "active",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  nextRunAt: null,
  lastRunAt: null,
  pausedAt: null,
  expiresAt: null,
  maxRuns: null,
  serverId: "host-a",
  serverName: "Host A",
};

const completedSchedule: AggregatedSchedule = {
  ...activeSchedule,
  id: "schedule-b",
  name: "Finished task",
  status: "completed",
};

afterEach(cleanup);
beforeEach(() => {
  state.loadState = { status: "loaded", data: [] };
  state.isError = false;
});

describe("SchedulesSidebar zero-task state", () => {
  it("hides the second create entry and shows the shared empty phrase", () => {
    render(<SchedulesSidebar />);

    expect(screen.queryByTestId("schedules-sidebar-new")).toBeNull();
    expect(screen.getByText("featurePages.schedules.emptyList")).toBeTruthy();
  });

  it("keeps the create row once a task exists", () => {
    state.loadState = { status: "loaded", data: [activeSchedule] };

    render(<SchedulesSidebar />);

    expect(screen.getByTestId("schedules-sidebar-new")).toBeTruthy();
    expect(screen.queryByText("featurePages.schedules.emptyList")).toBeNull();
  });

  it("uses the filtered-empty copy when tasks exist but the filter hides them", () => {
    state.loadState = { status: "loaded", data: [completedSchedule] };

    render(<SchedulesSidebar />);

    expect(screen.getByTestId("schedules-sidebar-new")).toBeTruthy();
    expect(screen.getByText("featurePages.schedules.emptyFiltered")).toBeTruthy();
    expect(screen.queryByText("featurePages.schedules.emptyList")).toBeNull();
  });
});
