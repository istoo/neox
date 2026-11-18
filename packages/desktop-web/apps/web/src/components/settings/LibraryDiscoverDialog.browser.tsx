// Library › MCP › Discover: agents' own servers/skills and a myna install are
// listed for picking, and the import call carries exactly the picked names.

import "../../index.css";

import type { LibrarySnapshot } from "@synara/contracts";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const api = vi.hoisted(() => ({
  getDiscover: vi.fn(),
  getMynaLibrary: vi.fn(),
  importDiscovered: vi.fn(),
  importMynaLibrary: vi.fn(),
}));

vi.mock("~/lib/neolixLibraryClient", () => ({ neolixLibraryApi: api }));

import { LibraryDiscoverDialog } from "./LibraryDiscoverDialog";

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

const agentServer = {
  name: "agent-server",
  transport: "stdio" as const,
  command: "node",
  args: ["server.js"],
  agents: ["claude"],
  otherAgents: [],
};

const agentSkill = {
  name: "agent-skill",
  description: "Does agent things",
  path: "/home/xxxu/.claude/skills/agent-skill",
  agents: ["claude"],
  otherAgents: [],
};

const mynaServer = {
  name: "myna-server",
  transport: "http" as const,
  url: "https://myna.example.com/mcp",
  agents: ["claude"],
  otherAgents: [],
};

const mynaSkill = {
  name: "myna-skill",
  description: "Comes from myna",
  path: "/home/xxxu/.myna/skills/myna-skill",
  agents: ["claude"],
  otherAgents: [],
};

function result(changed: string[] = []) {
  return { library: snapshot, result: { changed, problems: [] } };
}

async function renderDialog() {
  const onOpenChange = vi.fn();
  const onChanged = vi.fn();
  api.getDiscover.mockResolvedValue({
    discover: { servers: [agentServer], skills: [agentSkill] },
  });
  api.getMynaLibrary.mockResolvedValue({
    myna: {
      dir: "/home/xxxu/.myna",
      available: true,
      servers: [mynaServer],
      skills: [mynaSkill],
    },
  });
  api.importDiscovered.mockResolvedValue(result(["agent-server"]));
  api.importMynaLibrary.mockResolvedValue(result(["myna-server"]));
  const screen = await render(
    <LibraryDiscoverDialog
      open
      onOpenChange={onOpenChange}
      library={snapshot}
      onChanged={onChanged}
    />,
  );
  return { screen, onOpenChange, onChanged };
}

it("imports the picked myna servers and skills through importMynaLibrary", async () => {
  const { screen, onOpenChange, onChanged } = await renderDialog();
  try {
    await expect.element(screen.getByText("/home/xxxu/.myna")).toBeVisible();

    await screen.getByRole("switch", { name: "myna-server" }).click();
    await screen.getByRole("switch", { name: "myna-skill" }).click();
    await screen.getByRole("button", { name: "Import", exact: true }).click();

    await expect
      .poll(() => api.importMynaLibrary.mock.calls.at(-1)?.[0])
      .toEqual({ servers: ["myna-server"], skills: ["myna-skill"] });
    expect(api.importDiscovered).not.toHaveBeenCalled();
    expect(onChanged).toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  } finally {
    await screen.unmount();
    vi.clearAllMocks();
  }
});

it("imports the picked agent discoveries through importDiscovered", async () => {
  const { screen } = await renderDialog();
  try {
    await expect.element(screen.getByRole("switch", { name: "agent-server" })).toBeVisible();

    await screen.getByRole("switch", { name: "agent-server" }).click();
    await screen.getByRole("button", { name: "Import", exact: true }).click();

    await expect
      .poll(() => api.importDiscovered.mock.calls.at(-1)?.[0])
      .toEqual({ servers: ["agent-server"], skills: [] });
    expect(api.importMynaLibrary).not.toHaveBeenCalled();
  } finally {
    await screen.unmount();
    vi.clearAllMocks();
  }
});
