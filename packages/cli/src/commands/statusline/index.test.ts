import { describe, expect, it } from "vitest";
import type { GatewayQuotaAccountWire } from "@neolix/protocol/gateway";
import { createCli } from "../../cli.js";
import { runStatuslineCommand, statuslineText } from "./index.js";

const account: GatewayQuotaAccountWire = {
  id: "anthropic/me",
  provider: "anthropic",
  providerLabel: "Claude",
  account: "me",
  accountLabel: "me@example.test",
  enabled: true,
  restingUntil: null,
  windows: [
    {
      id: "tokens5h",
      kind: "tokens5h",
      usedPercent: 62,
      remaining: null,
      limit: null,
      resetsAt: null,
      pacePct: null,
    },
    {
      id: "tokens7d",
      kind: "tokens7d",
      usedPercent: 41,
      remaining: null,
      limit: null,
      resetsAt: null,
      pacePct: null,
    },
  ],
  spendUsd: 0,
  monthlyUsdCap: null,
  canWarm: true,
  warmup: false,
  lastReadAt: null,
  history: [],
};

const other: GatewayQuotaAccountWire = {
  ...account,
  id: "codex/me",
  provider: "codex",
  providerLabel: "Codex",
  account: "me-codex",
  accountLabel: "me@codex.test",
  windows: [
    {
      id: "usage",
      kind: "allowance",
      usedPercent: 80,
      remaining: 20,
      limit: 100,
      resetsAt: 3_000,
      pacePct: null,
    },
  ],
};

describe("statusline text", () => {
  it("shows the model and each window, noting the account that answered last", () => {
    const line = statuslineText({
      model: "claude-sonnet",
      accounts: [account, other],
      only: [],
      now: 2_000,
      lastServedKey: "anthropic/me",
      servedKeys: new Set(["anthropic/me"]),
    });
    expect(line).toBe("→ claude-sonnet | Claude me@example.test* 5h 62% 7d 41%");
  });

  it("narrows to the names asked for", () => {
    const line = statuslineText({
      accounts: [account, other],
      only: ["codex"],
      now: 2_000,
    });
    expect(line).toBe("Codex me@codex.test usage 80%");
  });

  it("reads a window past its reset as 0% and an unknown share as -", () => {
    const line = statuslineText({
      accounts: [
        {
          ...other,
          windows: [
            { ...other.windows[0]!, resetsAt: 1_000 },
            { ...other.windows[0]!, id: "usage", usedPercent: null, resetsAt: null },
          ],
        },
      ],
      only: [],
      now: 2_000,
    });
    expect(line).toContain("usage 0% usage -");
  });
});

function host(
  accounts: GatewayQuotaAccountWire[],
  options: { diagnostics?: boolean; quotas?: boolean } = {},
) {
  return async () => ({
    getLastServerInfoMessage: () => ({
      features: {
        gatewayQuotas: options.quotas ?? true,
        gatewayDiagnostics: options.diagnostics ?? true,
      },
    }),
    getGatewayQuota: async () => ({ requestId: "request", quota: { accounts, until: 0 } }),
    getGatewayRouteEvents: async () => ({
      requestId: "request",
      cursor: 2,
      routes: [
        {
          cursor: 1,
          route: {
            id: "r1",
            time: "2026-11-05T10:00:00Z",
            model: "claude-opus",
            session: "other-session",
            tries: [{ provider: "anthropic", account: "me", status: 200 }],
          },
        },
        {
          cursor: 2,
          route: {
            id: "r2",
            time: "2026-11-05T10:01:00Z",
            asked: "claude-sonnet",
            session: "session-1",
            tries: [{ provider: "codex", account: "me-codex", status: 200 }],
          },
        },
      ],
    }),
    close: async () => {},
  });
}

const options = { daemonTarget: { kind: "endpoint" as const, host: "example.test:1234" } };

describe("statusline command", () => {
  it("shows the session's latest model and marks the account that answered last", async () => {
    const line = await runStatuslineCommand([], options, host([account, other]), {
      sessionId: "session-1",
      now: 2_000,
    });
    expect(line).toBe(
      "→ claude-sonnet | Claude me@example.test 5h 62% 7d 41% | Codex me@codex.test* usage 80%",
    );
  });

  it("keeps the windows when the route feed is unavailable", async () => {
    const line = await runStatuslineCommand([], options, host([account], { diagnostics: false }), {
      now: 2_000,
    });
    expect(line).toBe("Claude me@example.test 5h 62% 7d 41%");
  });

  it("prints nothing when the gateway can't be asked", async () => {
    expect(
      await runStatuslineCommand([], options, async () => {
        throw new Error("Connection failed");
      }),
    ).toBe("");
    expect(await runStatuslineCommand([], options, host([account], { quotas: false }))).toBe("");
  });

  it("is offered by the CLI with the names argument", () => {
    const statusline = createCli().commands.find((command) => command.name() === "statusline");
    expect(statusline).toBeDefined();
    expect(statusline!.helpInformation()).toContain("[names...]");
    expect(statusline!.helpInformation()).toContain("--host <host>");
  });
});
