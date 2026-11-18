// Settings › Skills: a sync that reports an agent's own skill by the library's
// name surfaces the conflict row and both resolution actions; the desktop-only
// folder buttons reveal the Library and its backups through the shell bridge.

import "../../index.css";

import type { LibraryProblem, LibrarySnapshot } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterAll, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const bridge = vi.hoisted(() => {
  const showInFolder = vi.fn(async () => undefined);
  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    value: { showInFolder },
  });
  Object.defineProperty(window, "nativeApi", {
    configurable: true,
    value: { shell: { showInFolder } },
  });
  return { showInFolder };
});

const api = vi.hoisted(() => ({
  get: vi.fn(),
  sync: vi.fn(),
  settleSkill: vi.fn(),
}));

vi.mock("~/lib/neolixLibraryClient", () => ({ neolixLibraryApi: api }));

import { SkillsSettingsPanel } from "./SkillsSettingsPanel";

const snapshot: LibrarySnapshot = {
  dir: "/home/xxxu/.neox/library",
  backupsDir: "/home/xxxu/.neox/library-backups",
  homeDir: "/home/xxxu",
  agents: [
    {
      id: "claude",
      name: "Claude",
      icon: "claude",
      instructionsPath: "/home/xxxu/.claude/CLAUDE.md",
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

const conflict: LibraryProblem = {
  agent: "claude",
  what: "skill:deploy",
  error: "agent has its own deploy skill",
  own: true,
};

function mutation(problems: LibraryProblem[] = []) {
  return { library: snapshot, result: { changed: [], problems } };
}

async function renderPanel() {
  api.get.mockResolvedValue({ library: snapshot });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={client}>
      <SkillsSettingsPanel />
    </QueryClientProvider>,
  );
}

afterAll(() => {
  Reflect.deleteProperty(window, "desktopBridge");
  Reflect.deleteProperty(window, "nativeApi");
});

it("shows an agent's own skill as a conflict and settles it both ways", async () => {
  api.sync.mockResolvedValue(mutation([conflict]));
  api.settleSkill.mockResolvedValue(mutation([conflict]));
  const screen = await renderPanel();
  try {
    await expect.element(screen.getByRole("button", { name: "Write to agents" })).toBeVisible();
    await screen.getByRole("button", { name: "Write to agents" }).click();

    await expect.element(screen.getByText("Skill conflicts")).toBeVisible();
    await expect.element(screen.getByText("Claude's own skill")).toBeVisible();
    await expect.element(screen.getByText("deploy", { exact: true })).toBeVisible();

    await screen.getByRole("button", { name: "Use Library" }).click();
    await expect
      .poll(() => api.settleSkill.mock.calls.at(-1)?.[0])
      .toEqual({ name: "deploy", agent: "claude", keepOwn: false });

    await expect.element(screen.getByRole("button", { name: "Keep Claude's own" })).toBeVisible();
    await screen.getByRole("button", { name: "Keep Claude's own" }).click();
    await expect
      .poll(() => api.settleSkill.mock.calls.at(-1)?.[0])
      .toEqual({ name: "deploy", agent: "claude", keepOwn: true });
  } finally {
    await screen.unmount();
    vi.clearAllMocks();
  }
});

it("reveals the Library folder and its backups through the desktop shell", async () => {
  const screen = await renderPanel();
  // The hoisted mock is typed without parameters; the path is its first argument.
  const lastShownPath = () =>
    (bridge.showInFolder.mock.calls as unknown as Array<[string]>).at(-1)?.[0];
  try {
    await expect.element(screen.getByRole("button", { name: "Open Library folder" })).toBeVisible();
    await screen.getByRole("button", { name: "Open Library folder" }).click();
    await expect.poll(lastShownPath).toBe(snapshot.dir);

    await screen.getByRole("button", { name: "Open backups" }).click();
    await expect.poll(lastShownPath).toBe(snapshot.backupsDir);
  } finally {
    await screen.unmount();
    vi.clearAllMocks();
  }
});
