import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { HistoryPage } from "./HistoryPage";

const fixture = vi.hoisted(() => ({
  sessionsEnabled: true,
  navigate: vi.fn(),
  localThreads: [
    {
      id: "local-thread",
      projectId: "local-project",
      title: "Fix the login flow",
      modelSelection: { provider: "claudeAgent", instanceId: "claudeAgent", model: "opus" },
      createdAt: "2026-11-01T00:00:00.000Z",
      updatedAt: "2026-11-02T00:00:00.000Z",
      archivedAt: null,
      messages: [],
    },
  ],
  projects: [{ id: "local-project", name: "Storefront", localName: null }],
  remoteSessions: [
    {
      host: {
        hostId: "host-2",
        hostName: "Studio Mac",
        executionScope: { environmentId: "remote-1" },
      },
      summary: {
        projects: [{ id: "remote-project", name: "Docs", section: "projects" }],
        threads: [
          {
            id: "remote-thread",
            projectId: "remote-project",
            title: "Write the guide",
            modelSelection: { provider: "codex", instanceId: "codex", model: "gpt" },
            createdAt: "2026-11-01T00:00:00.000Z",
            updatedAt: "2026-11-03T00:00:00.000Z",
          },
        ],
      },
    },
  ],
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => fixture.navigate,
  Navigate: () => null,
}));
vi.mock("~/store", () => ({
  useStore: (selector: (state: unknown) => unknown) =>
    selector({ threads: fixture.localThreads, projects: fixture.projects }),
}));
vi.mock("~/storeSelectors", () => ({
  createAllThreadsSelector: () => (state: { threads: unknown }) => state.threads,
}));
vi.mock("~/lib/hosts/workspaceSessions", () => ({
  useWorkspaceSessions: () => fixture.remoteSessions,
  readAvailableWorkspaceNavigation: () => undefined,
  readWorkspaceSessions: () => fixture.remoteSessions,
  subscribeWorkspaceSessions: () => () => undefined,
}));
vi.mock("~/lib/hosts/executionContext", () => ({
  readExecutionContext: () => ({
    execution: { environmentId: "local", label: "This Mac" },
  }),
  executionKey: (key: string) => key,
  executionNamespace: () => undefined,
  initializeExecutionContext: () => undefined,
}));
const remoteRequests = vi.hoisted(() => ({
  request: vi.fn(async (method: string) => {
    if (method === "orchestration.getShellSnapshot") {
      return {
        snapshotSequence: 1,
        spaces: [],
        projects: [{ id: "remote-project", title: "Docs" }],
        threads: [
          {
            id: "remote-thread",
            projectId: "remote-project",
            title: "Write the guide",
            modelSelection: { provider: "codex", instanceId: "codex", model: "gpt" },
            createdAt: "2026-11-01T00:00:00.000Z",
            updatedAt: "2026-11-03T00:00:00.000Z",
            archivedAt: null,
          },
          {
            id: "remote-archived",
            projectId: "remote-project",
            title: "Archived remote notes",
            modelSelection: { provider: "codex", instanceId: "codex", model: "gpt" },
            createdAt: "2026-10-01T00:00:00.000Z",
            updatedAt: "2026-10-02T00:00:00.000Z",
            archivedAt: "2026-10-03T00:00:00.000Z",
          },
        ],
        updatedAt: "2026-11-03T00:00:00.000Z",
      };
    }
    return {
      matches: [
        {
          threadId: "remote-thread",
          excerpt: "the needle appears in the body",
          matchCount: 2,
        },
      ],
    };
  }),
}));
vi.mock("~/lib/hosts/connectionClients", () => ({
  acquireEnvironment: async () => ({
    transport: remoteRequests,
    release: async () => undefined,
  }),
  getConnectionClients: () => ({ execution: remoteRequests, controller: remoteRequests }),
  forEnvironment: () => remoteRequests,
}));
vi.mock("~/nativeApi", () => ({
  readNativeApi: () => undefined,
  ensureNativeApi: () => {
    throw new Error("native API unavailable in this test");
  },
}));
vi.mock("~/hooks/useBuiltinFeatures", () => ({
  useBuiltinFeatures: () => ({
    isEnabled: (id: string) => (id === "sessions" ? fixture.sessionsEnabled : true),
  }),
}));
vi.mock("~/components/RouteInsetSurface", () => ({
  RouteInsetSurface: ({ children }: { children: import("react").ReactNode }) => (
    <div>{children}</div>
  ),
}));
vi.mock("~/components/RouteSurface", () => ({
  RouteSurfaceHeader: ({ children }: { children: import("react").ReactNode }) => (
    <header>{children}</header>
  ),
}));

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <HistoryPage />
    </QueryClientProvider>,
  );
}

it("lists sessions from this computer and connected computers", async () => {
  fixture.sessionsEnabled = true;
  const screen = await renderPage();
  await expect
    .element(screen.getByRole("button", { name: /Fix the login flow/ }))
    .toBeInTheDocument();
  await expect.element(screen.getByRole("button", { name: /Write the guide/ })).toBeInTheDocument();
  await expect
    .element(screen.getByRole("button", { name: "Studio Mac", exact: true }))
    .toBeInTheDocument();
});

it("narrows the list to one computer", async () => {
  fixture.sessionsEnabled = true;
  const screen = await renderPage();
  await screen.getByRole("button", { name: "Studio Mac", exact: true }).click();
  await expect.element(screen.getByRole("button", { name: /Write the guide/ })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Fix the login flow/ }).query()).toBeNull();
});

it("shows archived remote sessions and searches remote message bodies", async () => {
  fixture.sessionsEnabled = true;
  const screen = await renderPage();
  await expect
    .element(screen.getByRole("button", { name: /Archived remote notes/ }))
    .toBeInTheDocument();
  await expect.element(screen.getByText("Archived", { exact: true })).toBeInTheDocument();

  await screen.getByRole("searchbox").fill("needle");
  await expect.element(screen.getByText("the needle appears in the body")).toBeInTheDocument();
  expect(remoteRequests.request).toHaveBeenCalledWith("orchestration.searchThreads", {
    query: "needle",
    limit: 50,
  });
});

it("renders nothing when the sessions feature is off", async () => {
  fixture.sessionsEnabled = false;
  const screen = await renderPage();
  expect(screen.getByRole("button", { name: /Fix the login flow/ }).query()).toBeNull();
  expect(screen.getByRole("button", { name: /Write the guide/ }).query()).toBeNull();
});
