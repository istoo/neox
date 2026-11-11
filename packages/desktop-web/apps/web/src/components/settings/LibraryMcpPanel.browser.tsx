// Settings › MCP › Servers: the hub switch, the server editor payload and the health check
// all go through neolix.library.* with the fields the old Library tab wrote.

import "../../index.css";

import type { LibrarySnapshot } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { McpConnectorsSettingsPanel } from "./McpConnectorsSettingsPanel";

const snapshot: LibrarySnapshot = {
  dir: "/home/qa/.neox/library",
  backupsDir: "/home/qa/.neox/library-backups",
  homeDir: "/home/qa",
  agents: [
    {
      id: "claude",
      name: "Claude",
      icon: "claude",
      instructionsPath: "/home/qa/.claude/CLAUDE.md",
      mcpPath: null,
      skillsDir: null,
      hooksPath: null,
      subagentsDir: null,
    },
  ],
  instructions: { shared: "", sets: [], agents: [] },
  mcp: [],
  skills: [],
  hooks: [],
  subagents: [],
  counts: { mcp: 0, skills: 0, hooks: 0, subagents: 0, rtk: 0 },
};

const api = vi.hoisted(() => ({
  get: vi.fn(),
  setMcpHub: vi.fn(),
  saveMcpServer: vi.fn(),
  removeMcpServer: vi.fn(),
  setMcpAgents: vi.fn(),
  checkMcpServer: vi.fn(),
  signOutMcpServer: vi.fn(),
  listBackups: vi.fn(),
  restoreBackup: vi.fn(),
}));

vi.mock("~/lib/neolixLibraryClient", () => ({ neolixLibraryApi: api }));
vi.mock("~/nativeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../nativeApi")>()),
  ensureNativeApi: () => ({
    dialogs: { confirm: vi.fn(async () => true) },
    shell: { openExternal: vi.fn(async () => undefined) },
    server: { listMcpConnectorProposals: vi.fn(async () => []) },
  }),
}));

function mutation(library: LibrarySnapshot) {
  return { library, result: { changed: [], problems: [] } };
}

async function renderPanel() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return {
    queryClient,
    screen: await render(
      <QueryClientProvider client={queryClient}>
        <McpConnectorsSettingsPanel active />
      </QueryClientProvider>,
    ),
  };
}

it("lists each server once and hides its catalog entry", async () => {
  const linear = {
    name: "linear",
    transport: "http" as const,
    url: "https://mcp.linear.app/mcp",
    agents: [],
  };
  api.get.mockResolvedValue({ library: { ...snapshot, mcp: [linear] } });
  const { screen } = await renderPanel();
  try {
    await expect.element(screen.getByText("linear", { exact: true })).toBeVisible();
    expect(screen.getByText("linear", { exact: true }).elements()).toHaveLength(1);
    // The Linear preset shares the server's URL, so the catalog no longer offers it.
    expect(screen.getByRole("button", { name: /^Linear/ }).elements()).toHaveLength(0);
  } finally {
    await screen.unmount();
    vi.clearAllMocks();
  }
});

it("toggles the MCP hub", async () => {
  api.get.mockResolvedValue({ library: snapshot });
  api.setMcpHub.mockResolvedValue(mutation({ ...snapshot, mcpHub: true }));
  const { screen } = await renderPanel();
  try {
    const hub = screen.getByRole("switch", { name: "MCP hub" });
    await expect.element(hub).toBeVisible();
    await hub.click();
    await expect.poll(() => api.setMcpHub.mock.calls.at(-1)?.[0]).toEqual({ on: true });
  } finally {
    await screen.unmount();
    vi.clearAllMocks();
  }
});

it("saves a new stdio server with its command, args and env", async () => {
  api.get.mockResolvedValue({ library: snapshot });
  api.saveMcpServer.mockImplementation(async (input: { server: LibrarySnapshot["mcp"][number] }) =>
    mutation({ ...snapshot, mcp: [input.server] }),
  );
  const { screen } = await renderPanel();
  try {
    await screen.getByRole("button", { name: "Add server" }).first().click();
    const dialog = screen.getByRole("dialog", { name: "New MCP server" });
    await dialog.getByRole("textbox", { name: "Name" }).fill("qa-server");
    await dialog.getByRole("textbox", { name: "Command" }).fill("node");
    await dialog.getByRole("textbox", { name: "Arguments (one per line)" }).fill("a.js\n--flag");
    await dialog.getByRole("textbox", { name: "Environment (KEY=value per line)" }).fill("A=1");
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect
      .poll(() => api.saveMcpServer.mock.calls.at(-1)?.[0])
      .toMatchObject({
        server: {
          name: "qa-server",
          transport: "stdio",
          command: "node",
          args: ["a.js", "--flag"],
          env: { A: "1" },
          agents: [],
        },
      });
  } finally {
    await screen.unmount();
    vi.clearAllMocks();
  }
});

it("shows the signed-in state and signs out", async () => {
  const saved = {
    name: "docs",
    transport: "http" as const,
    url: "https://mcp.example.com/mcp",
    agents: [],
    signIn: { signedIn: true },
  };
  api.get.mockResolvedValue({ library: { ...snapshot, mcp: [saved] } });
  api.signOutMcpServer.mockResolvedValue(mutation({ ...snapshot, mcp: [] }));
  const { screen } = await renderPanel();
  try {
    await expect.element(screen.getByText("Signed in", { exact: true })).toBeVisible();
    await screen.getByText("docs", { exact: true }).click();
    const dialog = screen.getByRole("dialog", { name: "Edit MCP server" });
    await dialog.getByRole("button", { name: "Sign out" }).click();
    await expect
      .poll(() => api.signOutMcpServer.mock.calls.at(-1)?.[0])
      .toEqual({
        name: "docs",
      });
  } finally {
    await screen.unmount();
    vi.clearAllMocks();
  }
});

it("browses library backups and restores one file", async () => {
  api.get.mockResolvedValue({ library: snapshot });
  api.listBackups.mockResolvedValue({
    backups: [
      {
        stamp: "2026-01-02_03-04-05-006",
        files: {
          claude: [{ file: "CLAUDE.md", size: 12, target: "/home/qa/.claude/CLAUDE.md" }],
        },
      },
    ],
  });
  api.restoreBackup.mockResolvedValue({ library: snapshot, restored: "CLAUDE.md" });
  const { screen } = await renderPanel();
  try {
    await screen.getByRole("button", { name: "Backups", exact: true }).click();
    const dialog = screen.getByRole("dialog", { name: "Library backups" });
    await expect.element(dialog.getByText("2026-01-02_03-04-05-006")).toBeVisible();
    await dialog.getByRole("button", { name: "Restore" }).click();
    await expect
      .poll(() => api.restoreBackup.mock.calls.at(-1)?.[0])
      .toEqual({
        stamp: "2026-01-02_03-04-05-006",
        agent: "claude",
        file: "CLAUDE.md",
      });
  } finally {
    await screen.unmount();
    vi.clearAllMocks();
  }
});

it("runs the health check on a saved server", async () => {
  const saved = {
    name: "docs",
    transport: "stdio" as const,
    command: "node",
    args: [],
    agents: [],
  };
  api.get.mockResolvedValue({ library: { ...snapshot, mcp: [saved] } });
  api.checkMcpServer.mockResolvedValue({ health: { ok: true, tools: ["search"], ms: 9 } });
  const { screen } = await renderPanel();
  try {
    await screen.getByText("docs", { exact: true }).click();
    const dialog = screen.getByRole("dialog", { name: "Edit MCP server" });
    await dialog.getByRole("button", { name: "Test connection" }).click();
    await expect.element(dialog.getByText("Connected · 1 tools · 9 ms")).toBeVisible();
    expect(api.checkMcpServer.mock.calls.at(-1)?.[0]).toEqual({ name: "docs" });
  } finally {
    await screen.unmount();
    vi.clearAllMocks();
  }
});
