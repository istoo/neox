import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConnectSnapshot } from "@neolix/protocol/agent-connect";
import { createGroupCommand } from "./index.js";
import { setAgentConnectSource, setAgentMoveApplier, type AgentMove } from "./agent-uses.js";

// each case drives several commands, each starting a config store
vi.setConfig({ testTimeout: 60_000 });

let home: string;
let printed: string[];

interface GroupShape {
  id: string;
  label?: string;
  members: string[];
  strategy: string;
  weighted?: boolean;
  weights?: Record<string, number>;
  fast?: string[];
  match?: string[];
  levels?: string[];
  context?: number;
  pick?: string;
  classifier?: string;
  rules?: Array<Record<string, unknown>>;
  auto?: boolean;
  manual?: boolean;
  affinity?: string;
  patience?: number;
  unlists?: boolean;
  effort?: string;
  family?: string;
}

interface ConfigShape {
  groups: GroupShape[];
  hiddenGroups?: string[];
  autoGroups?: boolean;
  autoGroupSkip?: string[];
  groupOrder?: string[];
}

function writeConfig(value: unknown): void {
  writeFileSync(join(home, "gateway.json"), JSON.stringify(value));
}

function config(): ConfigShape {
  return JSON.parse(readFileSync(join(home, "gateway.json"), "utf8")) as ConfigShape;
}

async function run(...args: string[]): Promise<string[]> {
  printed = [];
  const write = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: string | Uint8Array) => {
      printed.push(String(chunk));
      return true;
    });
  try {
    await createGroupCommand().parseAsync(args, { from: "user" });
  } finally {
    write.mockRestore();
  }
  return printed
    .join("")
    .split("\n")
    .filter((line) => line !== "");
}

const base = {
  providers: [
    {
      id: "alpha",
      label: "Alpha",
      protocol: "openai",
      baseUrl: "https://alpha.test/v1",
      models: [
        { id: "opus-5", label: "Opus 5", contextWindow: 200_000, released: "2026-01-01" },
        { id: "small-9b", contextWindow: 100_000, released: "2025-01-01" },
        { id: "shared", contextWindow: 64_000 },
      ],
    },
    {
      id: "beta",
      protocol: "openai",
      baseUrl: "https://beta.test/v1",
      models: [
        { id: "shared", contextWindow: 32_000 },
        { id: "opus-5", label: "Opus 5", contextWindow: 200_000, released: "2026-01-01" },
      ],
    },
  ],
  pricing: {
    "alpha/opus-5": { inputPerMTok: 5, outputPerMTok: 25 },
    "beta/opus-5": { inputPerMTok: 5, outputPerMTok: 25 },
    "alpha/small-9b": { inputPerMTok: 0.1, outputPerMTok: 0.5 },
  },
};

function groupBy(id: string): GroupShape {
  const group = config().groups.find((candidate) => candidate.id === id);
  expect(group).toBeDefined();
  return group!;
}

function snapshotOf(models: string[]): AgentConnectSnapshot {
  return {
    gatewayBaseUrl: null,
    models: [],
    profiles: [],
    error: null,
    entries: [
      {
        provider: "claude",
        configPath: null,
        connected: true,
        model: models[0] ?? null,
        modelCount: 0,
        reason: null,
        name: "Claude Code",
      },
    ],
  };
}

let agentSnapshot: AgentConnectSnapshot;
let moves: AgentMove[];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "neolix-group-cli-"));
  process.env.NEOLIX_HOME = home;
  writeConfig(base);
  agentSnapshot = snapshotOf(["group/pool"]);
  moves = [];
  setAgentConnectSource(async () => agentSnapshot);
  setAgentMoveApplier(async (planned) => {
    moves.push(...planned);
    return planned.map((move) => `${move.name} is on ${move.to} now`);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.NEOLIX_HOME;
});

describe("group add and show", () => {
  it("prints its usage on --help", async () => {
    expect((await run("--help")).join("\n")).toContain("neox group add <name>");
  });

  it("makes a group whose id comes from its name", async () => {
    const lines = await run(
      "add",
      "Opus anywhere",
      "models=alpha/opus-5,beta/opus-5",
      "routing=order",
    );
    expect(lines.join("\n")).toContain(
      "added Opus anywhere · agents pick it as group/opus-anywhere",
    );
    const group = groupBy("opus-anywhere");
    expect(group.members).toEqual(["alpha/opus-5", "beta/opus-5"]);
    expect(group.strategy).toBe("order");
    expect(group.label).toBe("Opus anywhere");
  });

  it("routes smart by default, as myna does", async () => {
    await run("add", "Pool", "models=alpha/opus-5,beta/shared");
    expect(groupBy("pool").strategy).toBe("smart");
  });

  it("replaces a group of the same name rather than making name-2", async () => {
    await run("add", "Pool", "models=alpha/opus-5,beta/shared");
    await run("add", "Pool", "models=alpha/opus-5");
    expect(config().groups).toHaveLength(1);
    expect(groupBy("pool").members).toEqual(["alpha/opus-5"]);
  });

  it("resolves a bare model id one provider serves", async () => {
    await run("add", "Bare", "models=small-9b");
    expect(groupBy("bare").members).toEqual(["alpha/small-9b"]);
    await expect(run("add", "Bad", "models=shared")).rejects.toThrow(
      /served by 2 providers; name one: alpha\/shared, beta\/shared/,
    );
  });

  it("shows a group with its routing and models", async () => {
    await run("add", "Opus anywhere", "models=alpha/opus-5,beta/opus-5", "routing=order");
    const lines = await run("opus-anywhere");
    const text = lines.join("\n");
    expect(text).toContain("Opus anywhere");
    expect(text).toContain("group/opus-anywhere");
    expect(text).toContain("routing");
    expect(text).toContain("order");
    expect(text).toContain("1 alpha/opus-5");
    expect(text).toContain("2 beta/opus-5");
  });

  it("keeps myna's stays, listed, effort and family", async () => {
    await run("add", "Pool", "models=alpha/opus-5", "stays=session", "family=fast");
    expect(groupBy("pool").affinity).toBe("session");
    expect(groupBy("pool").family).toBe("fast");
    const shown = (await run("pool")).join("\n");
    expect(shown).toContain("stays");
    expect(shown).toContain("session");
    await run("set", "pool", "listed=no", "effort=auto");
    expect(groupBy("pool").unlists).toBe(true);
    expect(groupBy("pool").effort).toBe("auto");
    const text = (await run("pool")).join("\n");
    expect(text).toContain("listed");
    expect(text).toContain("auto");
    await run("set", "pool", "stays=auto", "listed=yes", "effort=agent");
    expect(groupBy("pool").affinity).toBeUndefined();
    expect(groupBy("pool").unlists).toBeUndefined();
    expect(groupBy("pool").effort).toBeUndefined();
  });

  it("sets a group's patience in the milliseconds the gateway keeps", async () => {
    await run("add", "Pool", "models=alpha/opus-5");
    expect(groupBy("pool").patience).toBeUndefined();
    await run("set", "pool", "patience=2m");
    expect(groupBy("pool").patience).toBe(120_000);
    expect((await run("pool")).join("\n")).toMatch(/patience\s+2m/);
    await run("set", "pool", "patience=90");
    expect(groupBy("pool").patience).toBe(90_000);
    await run("set", "pool", "patience=off");
    expect(groupBy("pool").patience).toBe(0);
    expect((await run("pool")).join("\n")).toMatch(/patience\s+off/);
    await run("set", "pool", "patience=default");
    expect(groupBy("pool").patience).toBeUndefined();
    await expect(run("set", "pool", "patience=5m")).rejects.toThrow(/at most 4m0s/);
    await expect(run("set", "pool", "patience=soon")).rejects.toThrow(/patience=off\|default/);
  });

  it("names the agents connected to a group", async () => {
    await run("add", "Pool", "models=alpha/opus-5");
    expect((await run("pool")).join("\n")).toMatch(/used by\s+Claude Code/);
  });
});

describe("group set", () => {
  it("changes the models, routing, context, levels, weights and fast members", async () => {
    await run("add", "Pool", "models=alpha/opus-5,beta/opus-5");
    await run("set", "pool", "models+=alpha/small-9b");
    expect(groupBy("pool").members).toEqual(["alpha/opus-5", "beta/opus-5", "alpha/small-9b"]);
    await run("set", "pool", "models-=beta/opus-5");
    expect(groupBy("pool").members).toEqual(["alpha/opus-5", "alpha/small-9b"]);
    await run("set", "pool", "routing=weight", "weight=alpha/opus-5=3");
    expect(groupBy("pool").weighted).toBe(true);
    expect(groupBy("pool").weights).toEqual({ "alpha/opus-5": 3 });
    await run("set", "pool", "context=272k", "levels=low,high", "fast=alpha/small-9b");
    expect(groupBy("pool").context).toBe(272_000);
    expect(groupBy("pool").levels).toEqual(["low", "high"]);
    expect(groupBy("pool").fast).toEqual(["alpha/small-9b"]);
    await expect(run("set", "pool", "models-=beta/shared")).rejects.toThrow(/not in group\/pool/);
  });

  it("makes a found group the user's when changed", async () => {
    await run("set", "auto-shared", "routing=order");
    const stored = groupBy("auto-shared");
    expect(stored.strategy).toBe("order");
    expect(stored.auto).toBeUndefined();
    expect((await run("set", "auto-shared", "routing=smart")).join("\n")).toContain("saved");
  });

  it("renames a group, and the groups that name it", async () => {
    await run("add", "Pool", "models=alpha/opus-5,beta/opus-5");
    await run("add", "Top", "models=group/pool");
    await run("set", "pool", "id=big-pool");
    expect(groupBy("big-pool").members).toEqual(["alpha/opus-5", "beta/opus-5"]);
    expect(groupBy("top").members).toEqual(["group/big-pool"]);
    expect(config().groups.some((group) => group.id === "pool")).toBe(false);
  });

  it("sends every request to the model picked, and only it", async () => {
    await run("add", "Pool", "models=alpha/opus-5,beta/opus-5");
    const lines = await run("pick", "pool", "beta/opus-5");
    expect(lines.join("\n")).toContain("sends every request to beta/opus-5");
    expect(groupBy("pool").pick).toBe("beta/opus-5");
    expect(groupBy("pool").manual).toBe(true);
    expect((await run("pool")).join("\n")).toContain("manual");
    await run("set", "pool", "routing=order");
    expect(groupBy("pool").manual).toBeUndefined();
  });
});

describe("group rule", () => {
  it("adds a rule that sends long turns to a model", async () => {
    await run("add", "Pool", "models=alpha/opus-5,alpha/small-9b");
    await run("rule", "add", "pool", "use=alpha/small-9b", "tokens=200k");
    expect(groupBy("pool").rules).toEqual([{ use: "alpha/small-9b", tokens: 200_000 }]);
  });

  it("adds a time window and days", async () => {
    await run("add", "Pool", "models=alpha/opus-5,alpha/small-9b");
    await run(
      "rule",
      "add",
      "pool",
      "pause=alpha/opus-5",
      "time=14:00-18:00",
      "days=mon-fri",
      "tz=Asia/Shanghai",
    );
    expect(groupBy("pool").rules?.[0]).toMatchObject({
      use: "alpha/opus-5",
      pause: true,
      time: {
        from: "14:00",
        to: "18:00",
        days: ["mon", "tue", "wed", "thu", "fri"],
        zone: "Asia/Shanghai",
      },
    });
    const lines = await run("rule", "pool").catch(() => []);
    void lines;
    const shown = (await run("pool")).join("\n");
    expect(shown).toContain("time 14:00–18:00 mon-fri (Asia/Shanghai)");
  });

  it("refuses a pause with nothing to hold by", async () => {
    await run("add", "Pool", "models=alpha/opus-5,alpha/small-9b");
    await expect(run("rule", "add", "pool", "pause=alpha/opus-5")).rejects.toThrow(
      /needs time=, days=, agents=, folders= or except-folders=/,
    );
  });

  it("moves and removes rules", async () => {
    await run("add", "Pool", "models=alpha/opus-5,alpha/small-9b");
    await run("rule", "add", "pool", "use=alpha/small-9b", "tokens=1000");
    await run("rule", "add", "pool", "use=alpha/opus-5", "images");
    await run("rule", "mv", "pool", "2", "1");
    expect(groupBy("pool").rules?.map((rule) => rule.use)).toEqual([
      "alpha/opus-5",
      "alpha/small-9b",
    ]);
    await run("rule", "rm", "pool", "1");
    expect(groupBy("pool").rules).toHaveLength(1);
    await expect(run("rule", "rm", "pool", "9")).rejects.toThrow(/has rules 1 to 1/);
  });
});

describe("group copy, rm and restore", () => {
  it("copies a group after it", async () => {
    await run("add", "Pool", "models=alpha/opus-5,beta/opus-5");
    await run("copy", "pool");
    const copy = groupBy("pool-copy");
    expect(copy.label).toBe("Pool copy");
    expect(copy.members).toEqual(["alpha/opus-5", "beta/opus-5"]);
  });

  it("removes a group of the user's, and hides one Neox found", async () => {
    await run("add", "Pool", "models=alpha/opus-5,beta/opus-5");
    await run("rm", "pool");
    expect(config().groups).toHaveLength(0);
    const lines = await run("rm", "auto-shared");
    expect(lines.join("\n")).toContain("Neox found it, so it's hidden");
    expect(config().hiddenGroups).toEqual(["auto-shared"]);
    await expect(run("rm", "auto-shared")).rejects.toThrow(/removed already/);
  });

  it("brings a found group back", async () => {
    await run("rm", "auto-shared");
    const lines = await run("restore", "auto-shared");
    expect(lines.join("\n")).toContain("is back");
    expect(config().hiddenGroups).toEqual([]);
    await expect(run("restore", "auto-shared")).rejects.toThrow(/isn't removed/);
  });
});

describe("group auto", () => {
  it("turns found groups off and on", async () => {
    expect((await run("auto")).join("\n")).toContain("found groups are on");
    expect((await run("auto", "off")).join("\n")).toContain("found groups are off");
    expect(config().autoGroups).toBe(false);
    await run("auto", "on");
    expect(config().autoGroups).toBe(true);
  });

  it("moves an agent off a found group that stops being served", async () => {
    agentSnapshot = snapshotOf(["group/auto-shared"]);
    const lines = await run("auto", "off");
    expect(moves).toEqual([
      {
        provider: "claude",
        name: "Claude Code",
        from: "group/auto-shared",
        to: "alpha/shared",
      },
    ]);
    expect(lines.join("\n")).toContain("Claude Code is on alpha/shared now");
  });

  it("keeps providers out of the found groups", async () => {
    expect((await run("auto", "skip")).join("\n")).toContain("no provider is left out");
    await run("auto", "skip", "alpha");
    expect(config().autoGroupSkip).toEqual(["alpha"]);
    expect((await run("auto", "skip")).join("\n")).toContain("left out of found groups: alpha");
    await expect(run("auto", "skip", "nope")).rejects.toThrow(/no provider/);
    await run("auto", "skip", "none");
    expect(config().autoGroupSkip).toEqual([]);
  });
});

describe("group template", () => {
  it("lists the templates and the models each would take", async () => {
    const lines = await run("template");
    const text = lines.join("\n");
    expect(text).toContain("smart · Hard to strong, easy to cheap");
    expect(text).toContain("alpha/opus-5 → alpha/small-9b");
    expect(text).toContain("steady · Never stuck");
  });

  it("adds a smart group with its rules and classifier", async () => {
    const lines = await run("template", "smart");
    expect(lines.join("\n")).toContain("added Hard to strong, easy to cheap");
    const group = groupBy("smart-split");
    expect(group.members).toEqual(["alpha/opus-5", "alpha/small-9b"]);
    expect(group.classifier).toBe("alpha/small-9b");
    expect(group.rules).toEqual([
      { use: "alpha/small-9b", compact: true },
      { use: "alpha/opus-5", intent: expect.stringContaining("a hard task") },
      { use: "alpha/small-9b", intent: expect.stringContaining("an easy task") },
    ]);
  });

  it("weighs a model a preset vendor makes as its maker's", async () => {
    writeConfig({
      providers: [
        {
          id: "myrelay",
          protocol: "openai",
          baseUrl: "https://relay.test/v1",
          models: [{ id: "solo-5" }, { id: "small-9b" }],
        },
        {
          id: "openrouter",
          protocol: "openai",
          baseUrl: "https://openrouter.test/v1",
          models: [{ id: "anthropic/claude-opus-5" }],
        },
      ],
      pricing: {
        "myrelay/solo-5": { inputPerMTok: 5, outputPerMTok: 25 },
        "openrouter/anthropic/claude-opus-5": { inputPerMTok: 5, outputPerMTok: 25 },
        "myrelay/small-9b": { inputPerMTok: 0.1, outputPerMTok: 0.5 },
      },
    });
    await run("template", "smart");
    expect(groupBy("smart-split").members[0]).toBe("openrouter/anthropic/claude-opus-5");
  });

  it("numbers a name and id in use", async () => {
    await run("template", "smart");
    await run("template", "smart");
    expect(groupBy("smart-split-2").label).toBe("Hard to strong, easy to cheap 2");
  });
});
