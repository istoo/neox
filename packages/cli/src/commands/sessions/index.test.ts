import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExternalSession, ExternalSessionAgent } from "@neolix/protocol/messages";
import {
  agoAt,
  createSessionsCommand,
  formatTokens,
  parseSessionsOptions,
  resolve,
  runRelocateClaudeCommand,
  runSessionReadCommand,
  runSessionsCommand,
  type SessionsIo,
} from "./index.js";

const roots: string[] = [];
const options = { daemonTarget: { kind: "endpoint" as const, host: "example.test:1234" } };

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempHome(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "neolix-sessions-cli-"));
  roots.push(root);
  return root;
}

function io(extra: Partial<SessionsIo> = {}): SessionsIo & { output(): string } {
  const chunks: string[] = [];
  return {
    write: (text) => chunks.push(text),
    output: () => chunks.join(""),
    ...extra,
  };
}

function tokens(input: number, output: number, cacheRead = 0, cacheWrite = 0) {
  return { input, output, cacheRead, cacheWrite };
}

function session(overrides: Partial<ExternalSession> = {}): ExternalSession {
  return {
    id: "session-one",
    agent: "claude",
    cwd: "/work/app",
    title: "Fix the login bug",
    start: "2026-09-20T10:00:00.000Z",
    last: "2026-09-20T10:05:00.000Z",
    messages: 4,
    size: 100,
    tokens: tokens(1_000, 500),
    models: [{ model: "claude-opus-5-5", tokens: tokens(1_000, 500), cost: 0.25, priced: true }],
    cost: 0.25,
    priced: true,
    resume: "claude --resume session-one",
    path: "/home/me/.claude/projects/-work-app/session-one.jsonl",
    deletable: true,
    ...overrides,
  };
}

function agent(agentId: string, count: number): ExternalSessionAgent {
  return { agent: agentId, name: agentId, count, deletable: true };
}

interface FakeCall {
  agent?: string;
  activityDays?: number;
}

interface FakePage {
  agents: ExternalSessionAgent[];
  agent: string;
  sessions: ExternalSession[];
  error: string | null;
}

function connectTo(
  pages: Record<string, ExternalSession[]>,
  calls: FakeCall[] = [],
): () => Promise<unknown> {
  const agents = Object.entries(pages).map(([id, sessions]) => agent(id, sessions.length));
  const first = agents[0]?.agent ?? "";
  return async () => ({
    getLastServerInfoMessage: () => ({ features: { externalSessions: true } }),
    listExternalSessions: async (
      requested?: string,
      requestOptions?: { activityDays?: number },
    ): Promise<FakePage> => {
      calls.push({ agent: requested, activityDays: requestOptions?.activityDays });
      const chosen = requested !== undefined && requested in pages ? requested : (first as string);
      return {
        agents,
        agent: chosen,
        sessions: pages[chosen] ?? [],
        trash: [],
        trashDir: "",
        home: "/home/me",
        recording: false,
        recorded: false,
        error: null,
      } as FakePage;
    },
    close: () => undefined,
  });
}

type Connect = NonNullable<Parameters<typeof runSessionsCommand>[1]>;
type RelocateConnect = NonNullable<Parameters<typeof runRelocateClaudeCommand>[1]>;

describe("neox sessions", () => {
  it("reads myna's flags: today, all, a number of days, --stats", () => {
    expect(parseSessionsOptions(options)).toMatchObject({ days: -1, limit: 20, json: false });
    expect(parseSessionsOptions({ ...options, days: "today" }).days).toBe(1);
    expect(parseSessionsOptions({ ...options, days: "1d" }).days).toBe(1);
    expect(parseSessionsOptions({ ...options, days: "all" }).days).toBe(0);
    expect(parseSessionsOptions({ ...options, days: "0" }).days).toBe(0);
    expect(parseSessionsOptions({ ...options, days: "30d" }).days).toBe(30);
    expect(parseSessionsOptions({ ...options, days: "14" }).days).toBe(14);
    expect(parseSessionsOptions({ ...options, stats: true }).days).toBe(7);
    expect(parseSessionsOptions({ ...options, days: true }).days).toBe(7);
    expect(
      parseSessionsOptions({ ...options, limit: "5", model: "m1", folder: "/w" }),
    ).toMatchObject({ limit: 5, model: "m1", folder: "/w" });
  });

  it("refuses a bad range or limit with myna's words", () => {
    expect(() => parseSessionsOptions({ ...options, days: "soon" })).toThrow(
      /--days takes a number of days, today or all/,
    );
    expect(() => parseSessionsOptions({ ...options, days: "-1" })).toThrow(/--days/);
    expect(() => parseSessionsOptions({ ...options, limit: "0" })).toThrow(
      /--limit takes a number/,
    );
  });

  it("lists the newest sessions across agents, under the limit", async () => {
    const claude = session();
    const codex = session({
      id: "codex-one",
      agent: "codex",
      cwd: "/work/other",
      title: "Write   the docs",
      last: "2026-09-21T10:05:00.000Z",
      resume: "codex resume codex-one",
    });
    const out = io({ now: () => new Date("2026-09-22T10:00:00.000Z") });

    await runSessionsCommand(
      { ...options, limit: "1" },
      connectTo({ claude: [claude], codex: [codex] }) as Connect,
      out,
    );

    expect(out.output()).toContain("codex");
    expect(out.output()).toContain("Write the docs");
    expect(out.output()).not.toContain("login bug");
    expect(out.output()).toContain("latest 1 · 1 more with --limit");
    expect(out.output()).toContain("--json for the resume commands");
  });

  it("writes myna's JSON for a list, with the home shortened", async () => {
    const out = io({ homeDir: "/home/me" });
    await runSessionsCommand(
      { ...options, json: true },
      connectTo({ claude: [session()] }) as Connect,
      out,
    );
    const parsed = JSON.parse(out.output()) as ExternalSession[];
    expect(parsed[0]?.path).toBe("~/.claude/projects/-work-app/session-one.jsonl");
    expect(parsed[0]?.resume).toBe("claude --resume session-one");
  });

  it("resolves a model or folder the same way, and refuses an unknown one", async () => {
    await expect(
      runSessionsCommand(
        { ...options, model: "nope" },
        connectTo({ claude: [session()] }) as Connect,
        io(),
      ),
    ).rejects.toThrow(/no model "nope"; there are: claude-opus-5-5/);
    expect(resolve("folder", "app", ["/work/app"], io())).toBe("/work/app");
  });

  it("prints what the range spent, its days, models and folders", async () => {
    const out = io({ now: () => new Date("2026-09-22T10:00:00.000Z") });
    await runSessionsCommand(
      { ...options, days: "7" },
      connectTo({ claude: [session()] }) as Connect,
      out,
    );
    const text = out.output();
    expect(text).toContain("1.5K tokens last 7 days");
    expect(text).toContain("cache read");
    expect(text).toContain("on 1 day");
    expect(text).toContain("in 1.0K  out 500");
    expect(text).toContain("2026-09-16 – 2026-09-22");
    expect(text).toContain("models");
    expect(text).toContain("claude-opus-5-5");
    expect(text).toContain("folders");
    expect(text).toContain("/work/app");
  });

  it("writes the range as JSON with myna's field names", async () => {
    const out = io({ now: () => new Date("2026-09-22T10:00:00.000Z") });
    await runSessionsCommand(
      { ...options, days: "today", json: true },
      connectTo({ claude: [session()] }) as Connect,
      out,
    );
    const parsed = JSON.parse(out.output()) as Record<string, unknown>;
    expect(parsed).toMatchObject({ from: "2026-09-22", to: "2026-09-22", days_used: 0 });
  });

  it("shows active time and the cache hit rate from the transcript's days", async () => {
    const traced = session({
      tokens: tokens(1_000, 500, 400),
      models: [{ model: "m1", tokens: tokens(1_000, 500, 400), cost: 0.25, priced: true }],
      activity: [
        {
          date: "2026-09-19",
          tokens: tokens(600, 300, 100),
          activeSeconds: 3_600,
        },
        {
          date: "2026-09-20",
          tokens: tokens(400, 200, 300),
          activeSeconds: 1_800,
        },
      ],
    });
    const calls: FakeCall[] = [];
    const out = io({ now: () => new Date("2026-09-22T10:00:00.000Z") });

    await runSessionsCommand(
      { ...options, days: "7" },
      connectTo({ claude: [traced] }, calls) as Connect,
      out,
    );

    const text = out.output();
    expect(text).toContain("cache read 400 (29% hit)");
    expect(text).toContain("active 1h 30m on 2 days");
    expect(text).toContain("Sat Sep 19");
    expect(text).toContain("1h 0m");
    expect(calls.every((call) => call.activityDays === 7)).toBe(true);
  });

  it("splits days by model, as myna does, when filtering by one", async () => {
    const traced = session({
      last: "2026-09-22T10:00:00.000Z",
      tokens: tokens(1_000, 500),
      models: [
        { model: "m1", tokens: tokens(600, 300), cost: 0.3, priced: true },
        { model: "m2", tokens: tokens(400, 200), cost: 0.2, priced: true },
      ],
      activity: [
        {
          date: "2026-09-21",
          tokens: tokens(400, 200),
          activeSeconds: 900,
          models: [
            { model: "m1", tokens: tokens(100, 50) },
            { model: "m2", tokens: tokens(300, 150) },
          ],
        },
        {
          date: "2026-09-22",
          tokens: tokens(600, 300),
          activeSeconds: 300,
          models: [
            { model: "m1", tokens: tokens(500, 250) },
            { model: "m2", tokens: tokens(100, 50) },
          ],
        },
      ],
    });
    const out = io({ now: () => new Date("2026-09-22T10:00:00.000Z") });

    await runSessionsCommand(
      { ...options, days: "2", model: "m2" },
      connectTo({ claude: [traced] }) as Connect,
      out,
    );

    const text = out.output();
    // m2's own work each day, not the whole day's tokens pro-rated.
    expect(text).toMatch(/Mon Sep 21\s+450\b/);
    expect(text).toMatch(/Tue Sep 22\s+150\b/);
    expect(text).toContain("$0.150");
    expect(text).toContain("$0.050");
  });

  it("asks for no activity when it only lists sessions", async () => {
    const calls: FakeCall[] = [];
    await runSessionsCommand(options, connectTo({ claude: [session()] }, calls) as Connect, io());
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call.activityDays === undefined)).toBe(true);
  });

  it("formats tokens and times as myna does", () => {
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1_500)).toBe("1.5K");
    expect(formatTokens(12_000)).toBe("12.0K");
    expect(agoAt(new Date("2026-09-20T10:00:00Z"), new Date("2026-09-20T10:05:00Z"))).toBe(
      "5m ago",
    );
    expect(agoAt(new Date("2026-09-01T10:00:00Z"), new Date("2026-09-22T10:00:00Z"))).toBe(
      "21d ago",
    );
  });
});

describe("neox sessions relocate-claude", () => {
  function relocator(calls: unknown[]): RelocateConnect {
    const client = {
      getLastServerInfoMessage: () => ({ features: { externalSessions: true } }),
      relocateClaudeProject: async (input: { from: string; to: string; token?: string }) => {
        calls.push(input);
        return {
          requestId: "relocate",
          preview:
            input.token === undefined
              ? { from: input.from, to: input.to, sessions: 3, bytes: 1200 }
              : null,
          token: input.token === undefined ? "preview-token" : null,
          backup: input.token === undefined ? null : "/home/me/.neox/backups/relocate",
          error: null,
        };
      },
      close: () => undefined,
    };
    return (async () => client) as unknown as RelocateConnect;
  }

  it("previews, then moves with the preview token", async () => {
    const calls: unknown[] = [];
    const out = io();
    await runRelocateClaudeCommand(
      { ...options, from: "/work/a", to: "/work/b" },
      relocator(calls),
      out,
    );
    expect(JSON.parse(out.output())).toEqual({
      from: "/work/a",
      to: "/work/b",
      sessions: 3,
      bytes: 1200,
      token: "preview-token",
    });
    expect(calls).toEqual([{ from: "/work/a", to: "/work/b" }]);

    const moved = io();
    await runRelocateClaudeCommand(
      { ...options, from: "/work/a", to: "/work/b", confirm: "preview-token" },
      relocator(calls),
      moved,
    );
    expect(JSON.parse(moved.output())).toEqual({
      from: "/work/a",
      to: "/work/b",
      backup: "/home/me/.neox/backups/relocate",
    });
    expect(calls[1]).toEqual({ from: "/work/a", to: "/work/b", token: "preview-token" });
  });

  it("refuses a path that is not absolute, before connecting", async () => {
    let connected = false;
    const connect = (async () => {
      connected = true;
      throw new Error("should not connect");
    }) as unknown as RelocateConnect;
    await expect(
      runRelocateClaudeCommand({ ...options, from: "work/a", to: "/work/b" }, connect, io()),
    ).rejects.toThrow(/--from takes an absolute path/);
    expect(connected).toBe(false);
  });
});

describe("neox sessions read", () => {
  async function home(): Promise<{ root: string; env: NodeJS.ProcessEnv }> {
    const root = await tempHome();
    await mkdir(path.join(root, ".claude", "projects"), { recursive: true });
    return { root, env: { NEOLIX_HOME: root, HOME: root } };
  }

  it("lists which agents are read, and which are found", async () => {
    const { root, env } = await home();
    const out = io({ homeDir: root, env });
    await runSessionReadCommand(undefined, [], out);
    expect(out.output()).toContain("Agents found later: read");
    expect(out.output()).toContain("on   Claude Code (claude)");
  });

  it("changes the setting in gateway.json without a daemon", async () => {
    const { root, env } = await home();
    const out = io({ homeDir: root, env });
    await runSessionReadCommand("off", ["all"], out);
    expect(out.output()).toContain("Agents found later: not read");
    expect(out.output()).toContain("off  Claude Code (claude)");

    const saved = JSON.parse(await readFile(path.join(root, "gateway.json"), "utf8")) as {
      codexSessionReads: unknown;
    };
    expect(saved.codexSessionReads).toEqual({
      asked: true,
      all: false,
      agents: { claude: false },
    });

    await runSessionReadCommand("on", ["claude"], io({ homeDir: root, env }));
    const after = JSON.parse(await readFile(path.join(root, "gateway.json"), "utf8")) as {
      codexSessionReads: unknown;
    };
    expect(after.codexSessionReads).toMatchObject({ agents: { claude: true } });
  });

  it("writes the gateway.json of the home it is given", async () => {
    const { root, env } = await home();
    const other = await tempHome();
    const previous = { NEOLIX_HOME: process.env.NEOLIX_HOME, HOME: process.env.HOME };
    process.env.NEOLIX_HOME = other;
    process.env.HOME = root;
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await createSessionsCommand().parseAsync(["read", "off", "all", "--home", root], {
        from: "user",
      });
    } finally {
      write.mockRestore();
      if (previous.NEOLIX_HOME === undefined) delete process.env.NEOLIX_HOME;
      else process.env.NEOLIX_HOME = previous.NEOLIX_HOME;
      if (previous.HOME === undefined) delete process.env.HOME;
      else process.env.HOME = previous.HOME;
    }
    const saved = JSON.parse(await readFile(path.join(root, "gateway.json"), "utf8")) as {
      codexSessionReads: { all: boolean };
    };
    expect(saved.codexSessionReads.all).toBe(false);
    await expect(readFile(path.join(other, "gateway.json"), "utf8")).rejects.toThrow();
    expect(env.NEOLIX_HOME).toBe(root);
  });

  it("prints the consent list as JSON on request", async () => {
    const { root, env } = await home();
    const out = io({ homeDir: root, env, json: true });
    await runSessionReadCommand(undefined, [], out);
    expect(JSON.parse(out.output())).toMatchObject({
      asked: true,
      all: true,
      agents: { claude: true },
    });
  });

  it("refuses an agent it does not know, and a change without agents", async () => {
    const { root, env } = await home();
    await expect(
      runSessionReadCommand("on", ["not-an-agent"], io({ homeDir: root, env })),
    ).rejects.toThrow(/unknown agent "not-an-agent"/);
    await expect(runSessionReadCommand("on", [], io({ homeDir: root, env }))).rejects.toThrow(
      /usage: neox sessions read/,
    );
    await expect(
      runSessionReadCommand("maybe", ["claude"], io({ homeDir: root, env })),
    ).rejects.toThrow(/usage: neox sessions read/);
  });
});
