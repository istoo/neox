import { describe, expect, it } from "vitest";
import type { AgentConnectSnapshot } from "@neolix/protocol/agent-connect";
import type {
  LibraryDiscoverView,
  LibraryRtkStatus,
  LibrarySnapshot,
} from "@neolix/protocol/library";
import type { TuiProvider } from "./data.js";
import {
  agentFields,
  arrangedAgents,
  exposedModelCount,
  foundLibraryRows,
  groupRouting,
  importSelectionOf,
  libraryRows,
} from "./pages.js";

const snapshot: AgentConnectSnapshot = {
  gatewayBaseUrl: null,
  models: [],
  entries: [
    {
      provider: "codex",
      configPath: null,
      connected: false,
      model: null,
      modelCount: 0,
      reason: null,
    },
    {
      provider: "claude",
      configPath: null,
      connected: true,
      model: "gpt",
      modelCount: 1,
      reason: null,
    },
    {
      provider: "pi",
      configPath: null,
      connected: false,
      model: null,
      modelCount: 0,
      reason: null,
    },
  ],
  profiles: [],
  order: ["claude", "codex"],
  hidden: ["pi"],
  error: null,
};

describe("agents page calculations", () => {
  it("lists visible agents in the arranged order and hidden ones last", () => {
    expect(arrangedAgents(snapshot).map((entry) => entry.provider)).toEqual([
      "claude",
      "codex",
      "pi",
    ]);
  });

  it("puts the model first, then the agent's own settings", () => {
    expect(
      agentFields({
        provider: "claude",
        configPath: null,
        connected: true,
        model: "gpt",
        modelCount: 1,
        settings: [{ key: "effort", label: "effort", value: "high", options: ["low", "high"] }],
        reason: null,
      }),
    ).toEqual([
      { key: "__model", label: "model", value: "gpt" },
      { key: "effort", label: "effort", value: "high", options: ["low", "high"] },
    ]);
  });
});

describe("provider calculations", () => {
  const provider = (overrides: Partial<TuiProvider> = {}): TuiProvider => ({
    id: "p",
    protocol: "openai",
    baseUrl: "https://api.example.com/v1",
    models: [{ id: "a" }, { id: "b", picked: true }],
    ...overrides,
  });

  it("counts the models each mode serves", () => {
    expect(exposedModelCount(provider())).toBe(2);
    expect(exposedModelCount(provider({ modelMode: "picked" }))).toBe(1);
    expect(exposedModelCount(provider({ modelMode: "none" }))).toBe(0);
    expect(
      exposedModelCount(
        provider({
          modelMode: "best",
          models: [{ id: "gpt-5.1" }, { id: "gpt-5.2" }, { id: "claude-4" }],
        }),
      ),
    ).toBe(2);
  });
});

describe("routing calculations", () => {
  it("names the strategy and the manual pick", () => {
    expect(groupRouting({ id: "g", members: ["p/a"], strategy: "least-used" })).toBe("least used");
    expect(groupRouting({ id: "g", members: ["p/a"], manual: true })).toBe("manual");
  });
});

describe("library rows", () => {
  const library: LibrarySnapshot = {
    dir: "/lib",
    backupsDir: "/bak",
    homeDir: "/home",
    agents: [
      {
        id: "claude",
        name: "Claude Code",
        icon: "",
        instructionsPath: "/i",
        mcpPath: "/m",
        skillsDir: "/s",
        hooksPath: null,
        subagentsDir: null,
      },
    ],
    instructions: {
      shared: "# a\n",
      sets: [],
      agents: [
        {
          agent: "claude",
          name: "Claude Code",
          icon: "",
          path: "/i",
          on: true,
          extra: "",
          own: 0,
          edited: false,
        },
      ],
    },
    mcp: [{ name: "m", transport: "http", url: "https://m", agents: ["claude"] }],
    skills: [{ name: "s", description: "S", agents: ["claude"], path: "/s" }],
    hooks: [],
    subagents: [],
    counts: { mcp: 1, skills: 1, hooks: 0, subagents: 0, rtk: 1 },
  };
  const rtk: LibraryRtkStatus = {
    installed: false,
    path: null,
    version: null,
    url: "https://rtk.dev",
    agents: [{ id: "claude", name: "Claude Code", icon: "", on: false }],
  };

  it("names agents and marks their state", () => {
    const rows = libraryRows(library, rtk);
    expect(rows.map((row) => row.kind)).toEqual(["instructions", "mcp", "skill", "rtk"]);
    expect(rows[1]?.on).toEqual(["Claude Code"]);
    expect(rows.at(-1)?.about).toContain("not installed");
  });

  it("lists found servers and skills after the library's skills", () => {
    const discover: LibraryDiscoverView = {
      servers: [
        {
          name: "fs",
          transport: "stdio",
          command: "npx",
          agents: ["claude"],
          otherAgents: [],
        },
        {
          name: "own-http",
          transport: "http",
          url: "https://own",
          agents: ["claude"],
          otherAgents: [],
        },
      ],
      skills: [
        { name: "x", description: "X skill", path: "/x", agents: ["claude"], otherAgents: [] },
      ],
    };
    const rows = libraryRows(library, rtk, discover);
    expect(rows.map((row) => row.kind)).toEqual([
      "instructions",
      "mcp",
      "skill",
      "found-mcp",
      "found-mcp",
      "found-skill",
      "rtk",
    ]);
    const found = rows.filter((row) => row.kind.startsWith("found-"));
    expect(found[0]).toMatchObject({
      name: "fs",
      about: "",
      on: ["Claude Code"],
    });
    expect(found[1]).toMatchObject({ name: "own-http", on: ["Claude Code"] });
    expect(found[2]).toMatchObject({
      name: "x",
      about: "X skill",
      on: ["Claude Code"],
    });
  });

  it("assembles found rows without a name map", () => {
    const rows = foundLibraryRows({
      servers: [
        {
          name: "fs",
          transport: "http",
          url: "https://m",
          agents: ["claude", "codex"],
          otherAgents: [],
        },
      ],
      skills: [],
    });
    expect(rows).toEqual([
      {
        kind: "found-mcp",
        name: "fs",
        about: "",
        on: ["claude", "codex"],
        bad: 0,
      },
    ]);
  });

  it("turns a found row into its import selection", () => {
    expect(importSelectionOf({ kind: "found-mcp", name: "fs", about: "", on: [], bad: 0 })).toEqual(
      { servers: ["fs"], skills: [] },
    );
    expect(
      importSelectionOf({ kind: "found-skill", name: "x", about: "", on: [], bad: 0 }),
    ).toEqual({ servers: [], skills: ["x"] });
    expect(importSelectionOf({ kind: "skill", name: "x", about: "", on: [], bad: 0 })).toBeNull();
  });
});
