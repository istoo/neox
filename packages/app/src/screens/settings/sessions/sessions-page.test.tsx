/**
 * @vitest-environment jsdom
 */
import { i18n as testI18n } from "@/i18n/i18next";
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ExternalSession, ExternalSessionTrashed } from "@neolix/protocol/messages";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostSessionsPage } from "./sessions-page";

void testI18n;

const runtime = vi.hoisted(() => ({
  supported: true,
  client: null as unknown,
  toast: { show: () => {}, error: () => {}, copied: () => {} },
  navigate: () => "",
}));

vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => runtime.client,
}));

vi.mock("@/runtime/host-features", () => ({
  useHostFeature: () => runtime.supported,
}));

vi.mock("@/stores/session-store", () => ({
  useSessionStore: (selector: (state: unknown) => unknown) =>
    selector({
      sessions: {
        "host-a": { serverInfo: { features: { externalSessions: runtime.supported } } },
      },
    }),
}));

vi.mock("@/components/provider-icons", () => ({
  useProviderIcon: () => () => null,
}));

vi.mock("@/contexts/toast-context", () => ({
  useToast: () => runtime.toast,
}));

vi.mock("@/utils/navigate-to-agent", () => ({
  navigateToAgent: runtime.navigate,
}));

vi.mock("@/utils/confirm-dialog", () => ({
  confirmDialog: async () => true,
}));

function session(overrides: Partial<ExternalSession>): ExternalSession {
  return {
    id: "session-1",
    agent: "claude",
    cwd: "/work/app",
    title: "Fix the login bug",
    start: "2026-09-20T10:00:00.000Z",
    last: "2026-09-20T10:05:00.000Z",
    messages: 2,
    size: 2048,
    tokens: { input: 1300, output: 2221, cacheRead: 7100, cacheWrite: 0 },
    models: [
      {
        model: "claude-opus-5-5",
        tokens: { input: 1300, output: 2221, cacheRead: 7100, cacheWrite: 0 },
        cost: 0.004,
        priced: true,
      },
    ],
    cost: 0.004,
    priced: true,
    resume: "claude --resume session-1",
    path: "/work/app/session-1.jsonl",
    deletable: true,
    ...overrides,
  };
}

const trashed: ExternalSessionTrashed = {
  key: "a".repeat(64),
  agent: "claude",
  id: "session-old",
  title: "Old session",
  cwd: "/work/app",
  last: "2026-09-19T10:00:00.000Z",
  deleted: "2026-09-20T10:00:00.000Z",
  size: 512,
};

function createClient(sessionsOverride?: ExternalSession[], agentName = "claude") {
  return {
    listExternalSessions: vi.fn(async () => ({
      requestId: "list",
      agents: [
        {
          agent: agentName,
          name: agentName === "codex" ? "Codex" : "Claude Code",
          count: 2,
          deletable: true,
        },
      ],
      agent: agentName,
      sessions: sessionsOverride ?? [
        session({ id: "session-1", title: "Fix the login bug" }),
        session({ id: "session-2", title: "Add a README", last: "2026-09-20T09:00:00.000Z" }),
      ],
      trash: [trashed],
      trashDir: "/home/me/.neox/trash/sessions",
      home: "/home/me",
      recording: false,
      recorded: false,
      error: null,
    })),
    searchExternalSessions: vi.fn(async () => ({
      requestId: "search",
      hits: [],
      searched: 0,
      total: 0,
      cut: false,
      error: null,
    })),
    deleteExternalSessions: vi.fn(async () => ({
      requestId: "delete",
      deleted: ["session-1"],
      refused: [],
      error: null,
    })),
    restoreExternalSession: vi.fn(async () => ({
      requestId: "restore",
      agent: "claude",
      id: "session-old",
      title: "Old session",
      error: null,
    })),
    purgeExternalSessions: vi.fn(async () => ({
      requestId: "purge",
      purged: [trashed.key],
      refused: [],
      error: null,
    })),
    setGatewayConversationRecording: vi.fn(async () => ({
      requestId: "recording",
      recording: true,
      error: null,
    })),
    getExternalSessionTranscript: vi.fn(async () => ({
      requestId: "transcript",
      parts: [{ role: "user", kind: "text", text: "Hello there" }],
      total: 1,
      cut: false,
      source: "file",
      error: null,
    })),
    exportExternalSession: vi.fn(async () => ({
      requestId: "export",
      fileName: "neolix-session-claude-session-1.md",
      markdown: "# Fix the login bug",
      error: null,
    })),
    listSessionTerminals: vi.fn(async () => ({
      requestId: "terminals",
      supported: false,
      apps: [],
      defaultId: null,
      error: null,
    })),
    moveExternalCodexProvider: vi.fn(async () => ({
      requestId: "codex",
      moved: [],
      refused: [],
      error: null,
    })),
    relocateClaudeProject: vi.fn(async () => ({
      requestId: "relocate",
      preview: null,
      token: null,
      backup: null,
      error: null,
    })),
    importAgent: vi.fn(async () => ({ id: "agent-imported" })),
  };
}

type SessionsClient = ReturnType<typeof createClient>;

function renderPage(client: SessionsClient | null): void {
  runtime.client = client;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <HostSessionsPage serverId="host-a" />
    </QueryClientProvider>,
  );
}

describe("HostSessionsPage", () => {
  beforeEach(() => {
    runtime.supported = true;
    runtime.client = null;
    vi.stubGlobal("React", React);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("asks for a host update when the host does not offer sessions", () => {
    runtime.supported = false;
    renderPage(null);
    expect(screen.getByRole("alert").textContent).toContain("does not offer sessions");
  });

  it("lists sessions by folder with models, tokens and cost", async () => {
    const client = createClient();
    renderPage(client);

    expect((await screen.findAllByText("Fix the login bug")).length).toBeGreaterThan(0);
    expect((await screen.findAllByText("Add a README")).length).toBeGreaterThan(0);
    expect(screen.getByText("2 sessions")).toBeDefined();
    expect(screen.getAllByText("≈$0.0040").length).toBeGreaterThan(0);
    expect(client.listExternalSessions).toHaveBeenCalled();
  });

  it("filters what is shown as the reader types", async () => {
    const client = createClient();
    renderPage(client);
    await screen.findAllByText("Fix the login bug");

    fireEvent.change(screen.getByPlaceholderText("Search sessions"), {
      target: { value: "README" },
    });

    await waitFor(() => expect(screen.queryAllByText("Fix the login bug")).toHaveLength(0));
    expect(screen.getAllByText("Add a README").length).toBeGreaterThan(0);
  });

  it("opens selection with a count and a delete that waits for a pick", async () => {
    const client = createClient();
    renderPage(client);
    await screen.findAllByText("Fix the login bug");

    fireEvent.click(screen.getByRole("button", { name: "Select" }));

    expect((await screen.findAllByText("2 sessions")).length).toBeGreaterThan(1);
    expect(screen.getByRole("checkbox", { name: "Select every session shown" })).toBeDefined();
  });

  it("shows the trash with restore and permanent delete", async () => {
    const client = createClient();
    renderPage(client);
    await screen.findAllByText("Fix the login bug");

    fireEvent.click(screen.getByRole("button", { name: "Trash 1" }));

    expect(await screen.findByText("Old session")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));

    await waitFor(() => expect(client.restoreExternalSession).toHaveBeenCalledWith(trashed.key));
  });

  it("shows a session's conversation when asked, and its subagents'", async () => {
    const client = createClient([
      session({
        id: "session-1",
        subagents: [{ id: "sub1", title: "Find the router", kind: "Explore" }],
      }),
    ]);
    renderPage(client);
    await screen.findAllByText("Fix the login bug");

    fireEvent.click(screen.getAllByRole("button", { name: "Show conversation" })[0]);
    expect(await screen.findByText("Hello there")).toBeDefined();
    expect(client.getExternalSessionTranscript).toHaveBeenCalledWith({
      agent: "claude",
      id: "session-1",
      limit: 50,
    });

    fireEvent.click(screen.getByRole("button", { name: "1 subagent" }));
    expect(await screen.findByText("Find the router")).toBeDefined();
  });

  it("moves the Codex sessions another provider made, one ticked list", async () => {
    const client = createClient(
      [
        session({
          id: "codex-1",
          agent: "codex",
          provider: "custom",
          usesProvider: "neolix",
          resume: "codex resume codex-1",
        }),
      ],
      "codex",
    );
    renderPage(client);
    await screen.findAllByText("Fix the login bug");

    fireEvent.click(await screen.findByRole("button", { name: "Move to neolix…" }));
    expect(await screen.findByText("Move sessions to neolix?")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Move" }));

    await waitFor(() =>
      expect(client.moveExternalCodexProvider).toHaveBeenCalledWith([
        { id: "codex-1", to: "neolix" },
      ]),
    );
  });

  it("resumes a session as a Neolix agent", async () => {
    const client = createClient();
    renderPage(client);
    await screen.findAllByText("Fix the login bug");

    fireEvent.click(screen.getAllByRole("button", { name: "Resume" })[0]);

    await waitFor(() =>
      expect(client.importAgent).toHaveBeenCalledWith({
        providerId: "claude",
        providerHandleId: "session-1",
        cwd: "/work/app",
      }),
    );
  });
});
