// FILE: SidebarThreadRowFields.browser.tsx
// Purpose: Covers the display-options row fields on connected-host rows — host switch,
//          branch field, pull-request switch, and the host appearance badge.
// Layer: Browser UI test

import "../index.css";

import { ProjectId, ThreadId } from "@synara/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";

import type { Project, SidebarThreadSummary } from "../types";
import { DEFAULT_SIDEBAR_ROW_ITEMS, type SidebarRowItems } from "../appSettings";
import type { WorkspaceSession } from "../lib/hosts/workspaceSessions";
import type { WorkspaceNavigation } from "../lib/hosts/workspaceFrame";
import type { WorkspaceThreadEntry } from "../lib/hosts/workspaceSidebar";
import { FolderOpenIcon } from "../lib/icons";
import {
  SIDEBAR_HEADER_ROW_CLASS_NAME,
  SIDEBAR_THREAD_ROW_BASE_CLASS_NAME,
} from "../sidebarRowStyles";
import { WorkspaceProjectItem, WorkspaceThreadRow } from "./hosts/WorkspaceProjects";
import { SidebarProjectRowContent } from "./SidebarProjectRowContent";
import { SidebarThreadRowContent } from "./SidebarThreadRowContent";
import { SidebarThreadRowFields } from "./SidebarThreadRowFields";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
} from "./ui/sidebar";

const state = vi.hoisted(() => ({
  rowItems: {
    branch: false,
    project: false,
    host: false,
    changeRequest: true,
    checks: false,
    services: false,
    labels: true,
  } as SidebarRowItems,
  hostAppearance: {} as Record<
    string,
    { color: string; badgeDisplay?: "name" | "icon" | "hidden" | undefined }
  >,
}));

vi.mock("../appSettings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../appSettings")>()),
  useAppSettings: () => ({
    settings: {
      sidebarRowItems: state.rowItems,
      hostAppearance: state.hostAppearance,
      sidebarTitleSource: "title",
    },
    updateSettings: vi.fn(),
    updateSettingsAndWait: vi.fn(),
  }),
}));

const remoteFixture = vi.hoisted(() => ({
  available: new Map<WorkspaceSession, WorkspaceNavigation>(),
  open: vi.fn(),
}));

vi.mock("../lib/hosts/workspaceSessions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/hosts/workspaceSessions")>()),
  readAvailableWorkspaceNavigation: (session: WorkspaceSession) =>
    remoteFixture.available.get(session),
  readWorkspaceSessions: () => [...remoteFixture.available.keys()],
}));
vi.mock("../lib/hosts/workspaceCommands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/hosts/workspaceCommands")>()),
  openWorkspacePath: remoteFixture.open,
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useLocation: ({ select }: { select: (location: { href: string }) => unknown }) =>
    select({ href: "/" }),
}));

const PROJECT_ID = ProjectId.makeUnsafe("w20-project");
const ENVIRONMENT_ID = "w20-mini";

function makeProject(): Project & { readonly section: "projects" } {
  return {
    id: PROJECT_ID,
    kind: "project",
    name: "Remote checkout",
    remoteName: "Remote checkout",
    folderName: "Remote checkout",
    localName: null,
    cwd: "/srv/remote/checkout",
    defaultModelSelection: null,
    expanded: true,
    scripts: [],
    section: "projects",
  };
}

function makeThread(
  overrides: Partial<WorkspaceThreadEntry["thread"]> = {},
): WorkspaceThreadEntry["thread"] {
  return {
    id: ThreadId.makeUnsafe("w20-thread"),
    projectId: PROJECT_ID,
    title: "Remote agent thread",
    modelSelection: { provider: "codex", model: "gpt-5" },
    interactionMode: "default",
    branch: "feature/w20-row-fields",
    worktreePath: null,
    session: null,
    createdAt: "2026-11-16T09:00:00.000Z",
    updatedAt: "2026-11-16T10:00:00.000Z",
    latestTurn: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    hasLiveTailWork: false,
    pendingBackgroundWorkCount: 0,
    lastKnownPr: {
      number: 42,
      title: "Remote row fields",
      url: "https://github.com/acme/neox/pull/42",
      baseBranch: "main",
      headBranch: "feature/w20-row-fields",
      state: "open",
    },
    status: null,
    ...overrides,
  };
}

function makeSession(): WorkspaceSession {
  return {
    host: {
      hostId: ENVIRONMENT_ID,
      hostName: "Computer mini",
      wsPath: `/rpc/remote/${ENVIRONMENT_ID}`,
      executionScope: {
        environmentId: ENVIRONMENT_ID,
        accountAuthority: "https://account.example.test",
        userId: "fixture-owner",
        organizationId: "fixture-org",
        channel: "beta",
      },
    },
    summary: {
      state: "open",
      path: "/",
      projects: [{ ...makeProject(), section: "projects" }],
      threads: [],
    },
  };
}

function renderThreadRow(entry: WorkspaceThreadEntry, topLevel = false) {
  return render(
    <SidebarProvider>
      <div className="w-80">
        <WorkspaceThreadRow entry={entry} topLevel={topLevel} />
      </div>
    </SidebarProvider>,
  );
}

function LocalProjectRows({ threads }: { threads: readonly SidebarThreadSummary[] }) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        size="sm"
        aria-label="Local checkout"
        className={SIDEBAR_HEADER_ROW_CLASS_NAME}
      >
        <SidebarProjectRowContent
          icon={<FolderOpenIcon className="size-4" />}
          label="Local checkout"
        />
      </SidebarMenuButton>
      <SidebarMenuSub className="mx-0 border-0 px-0">
        {threads.map((thread) => (
          <SidebarMenuSubItem key={thread.id}>
            <SidebarMenuSubButton
              render={<div />}
              size="sm"
              className={SIDEBAR_THREAD_ROW_BASE_CLASS_NAME}
            >
              <SidebarThreadRowContent
                thread={thread}
                terminalEntryPoint={false}
                terminalStatus={null}
                terminalCount={0}
                isActive={false}
                variant="standard"
                meta={
                  <SidebarThreadRowFields
                    branch={thread.branch}
                    projectName={null}
                    runningServiceCount={0}
                    rowItems={state.rowItems}
                  />
                }
              />
            </SidebarMenuSubButton>
          </SidebarMenuSubItem>
        ))}
      </SidebarMenuSub>
    </SidebarMenuItem>
  );
}

describe("connected-host sidebar row fields", () => {
  beforeEach(() => {
    state.rowItems = { ...DEFAULT_SIDEBAR_ROW_ITEMS };
    state.hostAppearance = {};
    remoteFixture.available.clear();
    remoteFixture.open.mockClear();
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders the host badge, branch, and PR chip when their switches are on", async () => {
    state.rowItems = { ...DEFAULT_SIDEBAR_ROW_ITEMS, branch: true, host: true };
    state.hostAppearance = { [ENVIRONMENT_ID]: { color: "sky", badgeDisplay: "name" } };
    const session = makeSession();
    const entry: WorkspaceThreadEntry = { key: "row", thread: makeThread(), session };
    remoteFixture.available.set(session, {} as WorkspaceNavigation);

    const screen = await renderThreadRow(entry, true);

    await expect.element(screen.getByText("feature/w20-row-fields")).toBeVisible();
    const marker = document.querySelector<HTMLElement>('[data-slot="remote-thread-marker"]');
    expect(marker).not.toBeNull();
    expect(marker!.textContent).toContain("Computer mini");
    const badge = marker!.querySelector<HTMLElement>("[data-slot=sidebar-host-badge]")!;
    expect(badge.style.color).toBe("rgb(61, 126, 166)");
    expect(badge.getAttribute("title")).toBe("Computer mini");
    await expect.element(screen.getByTestId("remote-thread-pr-chip")).toBeVisible();
    expect(
      screen
        .getByTestId("remote-thread-pr-chip")
        .element()
        .querySelector("svg, [data-slot=central-icon]"),
    ).not.toBeNull();
  });

  it("captures the real sidebar shell with local and connected-host projects in light and dark", async () => {
    state.rowItems = {
      ...DEFAULT_SIDEBAR_ROW_ITEMS,
      branch: true,
      host: true,
      changeRequest: true,
    };
    state.hostAppearance = { [ENVIRONMENT_ID]: { color: "sky", badgeDisplay: "name" } };
    const baseSession = makeSession();
    const project = makeProject();
    const remoteThreads = [
      makeThread({
        id: ThreadId.makeUnsafe("w20-thread-1"),
        title: "Fix flaky remote runner",
        branch: "fix/flaky-remote-runner",
        lastKnownPr: {
          number: 43,
          title: "Fix flaky remote runner",
          url: "https://github.com/acme/neox/pull/43",
          baseBranch: "main",
          headBranch: "fix/flaky-remote-runner",
          state: "merged",
        },
      }),
      makeThread({
        id: ThreadId.makeUnsafe("w20-thread-2"),
        title: "Refresh sidebar row fields",
        branch: "feature/sidebar-row-fields",
      }),
      makeThread({
        id: ThreadId.makeUnsafe("w20-thread-3"),
        title: "Investigate branch cut",
        branch: "chore/remote-diagnostics",
        lastKnownPr: null,
      }),
    ];
    const session: WorkspaceSession = {
      ...baseSession,
      summary: { ...baseSession.summary!, threads: remoteThreads },
    };
    const localThreads = [
      makeThread({
        id: ThreadId.makeUnsafe("local-thread-1"),
        title: "Align local row fields",
        branch: "feature/local-row-fields",
        lastKnownPr: null,
      }),
      makeThread({
        id: ThreadId.makeUnsafe("local-thread-2"),
        title: "Local parity check",
        branch: "fix/local-parity",
        lastKnownPr: null,
      }),
    ];

    await page.viewport(1000, 480);
    await render(
      <SidebarProvider>
        <div
          data-testid="sidebar-shot"
          className="w-[300px] bg-sidebar p-2 text-sidebar-foreground"
        >
          <SidebarMenu className="gap-3">
            <LocalProjectRows threads={localThreads} />
            <WorkspaceProjectItem
              entry={{ key: "project", project, threads: remoteThreads, session }}
              expanded
              onToggle={() => {}}
              threadSortOrder="updated_at"
            />
          </SidebarMenu>
        </div>
      </SidebarProvider>,
    );
    const shot = page.getByTestId("sidebar-shot");
    await expect.element(shot).toHaveTextContent("Computer mini");

    // No overlap: every meta line stays inside its own row and rows stay disjoint.
    const rows = [...document.querySelectorAll<HTMLElement>('[data-sidebar="menu-sub-button"]')];
    expect(rows.length).toBeGreaterThanOrEqual(5);
    for (const row of rows) {
      const meta = row.querySelector<HTMLElement>("[data-slot=sidebar-thread-row-meta]");
      if (!meta) continue;
      expect(meta.getBoundingClientRect().bottom).toBeLessThanOrEqual(
        row.getBoundingClientRect().bottom + 1,
      );
    }
    for (let index = 1; index < rows.length; index += 1) {
      expect(rows[index - 1]!.getBoundingClientRect().bottom).toBeLessThanOrEqual(
        rows[index]!.getBoundingClientRect().top + 0.5,
      );
    }

    // The host badge lives on the workspace title only; rows do not repeat it.
    expect(document.querySelectorAll("[data-slot=sidebar-host-badge]")).toHaveLength(1);

    await shot.screenshot({
      path: "node_modules/.cache/sidebar-w20/v3-light.png",
    });
    document.documentElement.classList.add("dark");
    await shot.screenshot({
      path: "node_modules/.cache/sidebar-w20/v3-dark.png",
    });
    document.documentElement.classList.remove("dark");

    const branch = page.getByText("feature/sidebar-row-fields");
    expect(branch.element().getAttribute("title")).toBe("feature/sidebar-row-fields");
  });

  it("turns the host label and PR chip off with the two display switches", async () => {
    state.rowItems = {
      ...DEFAULT_SIDEBAR_ROW_ITEMS,
      branch: false,
      host: false,
      changeRequest: false,
    };
    const session = makeSession();
    const entry: WorkspaceThreadEntry = { key: "row", thread: makeThread(), session };

    const screen = await renderThreadRow(entry, true);

    await expect.element(screen.getByText("Remote agent thread")).toBeVisible();
    expect(document.querySelector('[data-slot="remote-thread-marker"]')).toBeNull();
    expect(screen.getByTestId("remote-thread-pr-chip").query()).toBeNull();
    expect(screen.getByText("feature/w20-row-fields").query()).toBeNull();
  });

  it("follows the host appearance icon and hidden choices", async () => {
    state.rowItems = { ...DEFAULT_SIDEBAR_ROW_ITEMS, host: true };
    const session = makeSession();
    const entry: WorkspaceThreadEntry = { key: "row", thread: makeThread(), session };
    state.hostAppearance = { [ENVIRONMENT_ID]: { color: "orange", badgeDisplay: "icon" } };

    const mounted = await renderThreadRow(entry, true);
    const marker = document.querySelector<HTMLElement>('[data-slot="remote-thread-marker"]')!;
    await expect
      .element(marker.querySelector("[data-slot=sidebar-host-badge]") as HTMLElement)
      .toHaveAttribute("role", "img");
    expect(marker.textContent).not.toContain("Computer mini");
    expect(marker.querySelector<HTMLElement>("[data-slot=sidebar-host-badge]")!.style.color).toBe(
      "rgb(164, 103, 58)",
    );
    await mounted.unmount();

    state.hostAppearance = { [ENVIRONMENT_ID]: { color: "orange", badgeDisplay: "hidden" } };
    await renderThreadRow(entry, true);
    expect(document.querySelector('[data-slot="remote-thread-marker"]')).toBeNull();
  });

  it("draws the workspace title badge from the same appearance setting", async () => {
    state.hostAppearance = { [ENVIRONMENT_ID]: { color: "emerald", badgeDisplay: "name" } };
    const session = makeSession();
    const mounted = await render(
      <SidebarProvider>
        <div className="w-80">
          <WorkspaceProjectItem
            entry={{ key: "project", project: makeProject(), threads: [], session }}
            expanded
            onToggle={() => {}}
            threadSortOrder="updated_at"
          />
        </div>
      </SidebarProvider>,
    );

    const label = mounted.getByLabelText("Remote checkout, Computer mini");
    await expect.element(label).toHaveTextContent("Computer mini");
    expect(label.element().querySelector("[data-slot=sidebar-host-badge]")).not.toBeNull();

    await mounted.unmount();
    state.hostAppearance = { [ENVIRONMENT_ID]: { color: "emerald", badgeDisplay: "hidden" } };
    const hidden = await render(
      <SidebarProvider>
        <div className="w-80">
          <WorkspaceProjectItem
            entry={{ key: "project", project: makeProject(), threads: [], session }}
            expanded
            onToggle={() => {}}
            threadSortOrder="updated_at"
          />
        </div>
      </SidebarProvider>,
    );
    await expect.element(hidden.getByLabelText("Remote checkout, Computer mini")).toBeVisible();
    expect(
      hidden.getByLabelText("Remote checkout, Computer mini").element().textContent,
    ).not.toContain("Computer mini");
  });
});
