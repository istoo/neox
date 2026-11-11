import { Readable, Writable } from "node:stream";
import { render } from "ink";
import { createElement, type ReactElement } from "react";
import { describe, expect, it } from "vitest";
import type { AgentConnectSnapshot } from "@neolix/protocol/agent-connect";
import type { GatewayConfigWire, GatewayUsageReportWire } from "@neolix/protocol/gateway";
import type { LibraryRtkStatus, LibrarySnapshot } from "@neolix/protocol/library";
import type { ExternalSession } from "@neolix/protocol/messages";
import {
  AgentsPage,
  GroupsPage,
  LibraryPage,
  ProvidersPage,
  SessionsPage,
  UsagePage,
} from "./pages.js";
import { makeTheme } from "./ui.js";

class FakeStdout extends Writable {
  columns = 120;
  rows = 40;
  isTTY = false;
  text = "";
  _write(chunk: Buffer, _encoding: BufferEncoding, callback: () => void): void {
    this.text += chunk.toString("utf8");
    callback();
  }
}

class FakeStdin extends Readable {
  isTTY = false;
  _read(): void {}
}

async function draw(element: ReactElement): Promise<string> {
  const stdout = new FakeStdout();
  const stderr = new FakeStdout();
  const instance = render(element, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stderr as unknown as NodeJS.WriteStream,
    stdin: new FakeStdin() as unknown as NodeJS.ReadStream,
    interactive: false,
    patchConsole: false,
  });
  setTimeout(() => instance.unmount(), 100);
  await instance.waitUntilExit();
  return stdout.text + stderr.text;
}

const theme = makeTheme(false);

const snapshot: AgentConnectSnapshot = {
  gatewayBaseUrl: "http://127.0.0.1:6768/v1",
  models: [{ id: "deepseek/chat", label: "Chat" }],
  entries: [
    {
      provider: "claude",
      configPath: "/Users/me/.claude/settings.json",
      connected: true,
      model: "deepseek/chat",
      modelCount: 1,
      settings: [{ key: "effort", label: "effort", value: "high", options: ["low", "high"] }],
      reason: null,
    },
    {
      provider: "codex",
      configPath: null,
      connected: false,
      model: null,
      modelCount: 0,
      reason: "unsupported",
    },
  ],
  profiles: [{ name: "work", savedAt: 1, agents: {}, inUse: true }],
  order: ["claude", "codex"],
  hidden: [],
  error: null,
};

const config: GatewayConfigWire = {
  version: 1,
  providers: [
    {
      id: "deepseek",
      label: "DeepSeek",
      protocol: "openai",
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: "sk-0123456789",
      models: [{ id: "chat", picked: true }],
      family: "relay",
    },
  ],
  groups: [
    {
      id: "opus-anywhere",
      label: "opus anywhere",
      members: ["deepseek/chat"],
      strategy: "order",
      rules: [{ use: "deepseek/chat", tokens: 2000 }],
      auto: false,
    },
  ],
  hiddenGroups: ["old-found"],
};

const usage: GatewayUsageReportWire = {
  period: "7d",
  since: "2026-11-01T00:00:00.000Z",
  until: "2026-11-06T00:00:00.000Z",
  bucket: "day",
  totals: {
    calls: 3,
    failed: 1,
    retried: 0,
    inputTokens: 1200,
    outputTokens: 800,
    cacheReadTokens: 100,
    cacheWriteTokens: 20,
    reasoningTokens: 0,
    costUsd: 0.5,
    unpricedCalls: 0,
    handedOn: 0,
    cacheHitRate: 0.1,
    meanTtftMs: 100,
  },
  prompt: { tokens: 1200, calls: 3, parts: [] },
  series: [
    { label: "Nov 5", start: "", calls: 1, inputTokens: 400, outputTokens: 200, costUsd: 0.1 },
    { label: "Nov 6", start: "", calls: 2, inputTokens: 800, outputTokens: 600, costUsd: 0.4 },
  ],
  byClient: [
    {
      id: "claude",
      name: "Claude Code",
      calls: 3,
      failed: 1,
      retried: 0,
      inputTokens: 1200,
      outputTokens: 800,
      cacheReadTokens: 100,
      cacheWriteTokens: 20,
      reasoningTokens: 0,
      costUsd: 0.5,
      unpricedCalls: 0,
      handedOn: 0,
      cacheHitRate: 0.1,
      meanTtftMs: 100,
    },
  ],
  byModel: [],
  byProvider: [],
  byAccount: [],
  byKey: [],
  bySession: [],
  requests: { rows: [], total: 0, offset: 0, limit: 20 },
  path: "~/.neox/usage",
};

const session: ExternalSession = {
  id: "s1",
  agent: "claude",
  cwd: "/work/acme",
  title: "Fix the build",
  start: "2026-11-06T08:00:00.000Z",
  last: "2026-11-06T09:00:00.000Z",
  messages: 4,
  size: 100,
  tokens: { input: 1000, output: 500, cacheRead: 100, cacheWrite: 20 },
  models: [
    {
      model: "deepseek/chat",
      tokens: { input: 1000, output: 500, cacheRead: 100, cacheWrite: 20 },
      cost: 0.2,
      priced: true,
    },
  ],
  cost: 0.2,
  priced: true,
  resume: "claude --resume s1",
  path: "/tmp/s1.jsonl",
  deletable: true,
  activity: [
    {
      date: "2026-11-06",
      tokens: { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0 },
      activeSeconds: 600,
    },
  ],
};

const rtk: LibraryRtkStatus = {
  installed: true,
  path: "/usr/local/bin/rtk",
  version: "1.2.0",
  url: "https://rtk.dev",
  agents: [{ id: "claude", name: "Claude Code", icon: "", on: true }],
};

const library: LibrarySnapshot = {
  dir: "/Users/me/.neox/library",
  backupsDir: "/Users/me/.neox/backups",
  homeDir: "/Users/me",
  agents: [
    {
      id: "claude",
      name: "Claude Code",
      icon: "claude",
      instructionsPath: "/Users/me/.claude/CLAUDE.md",
      mcpPath: "/Users/me/.claude.json",
      skillsDir: "/Users/me/.claude/skills",
      hooksPath: null,
      subagentsDir: null,
    },
  ],
  instructions: {
    shared: "# Rules\n\nBe brief.\n",
    sets: [],
    agents: [
      {
        agent: "claude",
        name: "Claude Code",
        icon: "claude",
        path: "/x",
        on: true,
        extra: "",
        own: 0,
        edited: false,
      },
    ],
  },
  mcp: [
    {
      name: "context7",
      transport: "http",
      url: "https://mcp.context7.com/mcp",
      agents: ["claude"],
    },
  ],
  skills: [{ name: "review", description: "Review code", agents: ["claude"], path: "/s" }],
  hooks: [{ name: "format", event: "PostToolUse", command: "prettier", agents: ["claude"] }],
  subagents: [{ name: "planner", description: "Plans", prompt: "", agents: ["claude"] }],
  counts: { mcp: 1, skills: 1, hooks: 1, subagents: 1, rtk: 1 },
};

describe("page layouts", () => {
  it("renders the agents page", async () => {
    const output = await draw(
      createElement(AgentsPage, {
        snapshot,
        row: 0,
        column: 0,
        width: 120,
        height: 30,
        theme,
      }),
    );
    expect(output).toContain("claude");
    expect(output).toContain("effort");
    expect(output).toContain("unsupported");
  });

  it("renders the providers page", async () => {
    const output = await draw(
      createElement(ProvidersPage, {
        config: { ...config, providers: config.providers ?? [], groups: config.groups ?? [] },
        balances: { deepseek: "12.50" },
        row: 0,
        width: 120,
        height: 30,
        theme,
      }),
    );
    expect(output).toContain("DeepSeek");
    expect(output).toContain("deepseek");
    expect(output).toContain("12.50");
  });

  it("renders the routing page", async () => {
    const output = await draw(
      createElement(GroupsPage, {
        config: { ...config, providers: config.providers ?? [], groups: config.groups ?? [] },
        row: 0,
        width: 120,
        height: 30,
        theme,
      }),
    );
    expect(output).toContain("opus-anywhere");
    expect(output).toContain("in order");
    expect(output).toContain("removed");
  });

  it("renders the usage page", async () => {
    const output = await draw(
      createElement(UsagePage, {
        report: usage,
        reports: [
          {
            id: "claude",
            account: { label: "me@example.com" },
            fetchedAt: "2026-11-06T00:00:00.000Z",
            sourceId: "claude",
            sourceLabel: "Claude",
            report: {
              status: "available",
              windows: [
                { id: "5h", label: "5 hours", usedPct: 42, resetsAt: "2026-11-06T14:00:00.000Z" },
              ],
            },
          },
        ],
        reportsError: null,
        reportsLoading: false,
        agents: snapshot,
        period: "7d",
        left: false,
        width: 120,
        height: 30,
        theme,
      }),
    );
    expect(output).toContain("7 days");
    expect(output).toContain("42% used");
    expect(output).toContain("tokens");
  });

  it("renders the sessions list and stats", async () => {
    const list = await draw(
      createElement(SessionsPage, {
        sessions: [session],
        names: { claude: "Claude Code" },
        range: 1,
        filter: { days: 7, model: "", folder: "" },
        stats: false,
        byCost: false,
        selected: 0,
        width: 120,
        height: 30,
        now: new Date("2026-11-06T12:00:00.000Z"),
        theme,
      }),
    );
    expect(list).toContain("Claude Code");
    expect(list).toContain("Fix the build");
    const stats = await draw(
      createElement(SessionsPage, {
        sessions: [session],
        names: { claude: "Claude Code" },
        range: 1,
        filter: { days: 7, model: "", folder: "" },
        stats: true,
        byCost: false,
        selected: 0,
        width: 120,
        height: 30,
        now: new Date("2026-11-06T12:00:00.000Z"),
        theme,
      }),
    );
    expect(stats).toContain("tokens");
    expect(stats).toContain("models");
  });

  it("renders the library page", async () => {
    const output = await draw(
      createElement(LibraryPage, {
        library,
        rtk,
        row: 0,
        width: 120,
        height: 30,
        theme,
      }),
    );
    expect(output).toContain("shared instructions");
    expect(output).toContain("context7");
    expect(output).toContain("RTK");
  });
});
