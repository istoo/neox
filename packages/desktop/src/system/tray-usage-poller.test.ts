import { describe, expect, it, vi } from "vitest";
import type { GatewayQuotaAccountWire, GatewayUsageReportWire } from "@neolix/protocol/gateway";

vi.mock("electron", () => ({
  app: { isPackaged: false, getVersion: () => "1.2.3", getLocale: () => "en-US" },
  Menu: { buildFromTemplate: vi.fn((template: unknown) => template) },
  Tray: class {
    setToolTip() {}
    on() {}
    setContextMenu() {}
    setTitle() {}
    setImage() {}
  },
  globalShortcut: { register: vi.fn(() => true), unregister: vi.fn() },
  nativeImage: {
    createFromPath: vi.fn(() => ({
      isEmpty: () => false,
      resize: vi.fn(() => ({ toDataURL: () => "data:image/png;base64,AA" })),
    })),
    createFromDataURL: vi.fn(() => ({ setTemplateImage() {} })),
    createEmpty: vi.fn(() => ({})),
  },
}));

import {
  daemonWebSocketTarget,
  readTrayUsageState,
  startTrayUsagePolling,
  type TrayUsageClient,
  type TrayUsagePollerSettings,
} from "./tray-usage-poller";

const SETTINGS: TrayUsagePollerSettings = {
  trayUsages: ["claude|a@b.c"],
  trayUsageEvery: 3,
  trayWindows: {},
  trayNoLogos: false,
  trayNoBird: false,
  trayPace: true,
  trayNoCost: false,
  trayDisplayAs: "used",
  trayCurrency: "usd",
  trayNumberUnits: "compact",
  trayCnyPerUsd: 7.2,
};

function account(provider = "claude", providerLabel = "Claude"): GatewayQuotaAccountWire {
  return {
    id: `${provider}|a@b.c`,
    provider,
    providerLabel,
    account: "a@b.c",
    accountLabel: "a@b.c",
    enabled: true,
    restingUntil: null,
    windows: [
      {
        id: "5h",
        kind: "tokens5h",
        usedPercent: 62,
        remaining: null,
        limit: null,
        resetsAt: 60_000,
        pacePct: 3,
        windowMs: 5 * 60 * 60_000,
        history: [],
      },
    ],
    spendUsd: 0,
    monthlyUsdCap: null,
    canWarm: false,
    warmup: false,
    lastReadAt: null,
    history: [],
  };
}

function report(costUsd: number): GatewayUsageReportWire {
  return {
    totals: {
      calls: 3,
      failed: 0,
      retried: 0,
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
      reasoningTokens: 0,
      costUsd,
    },
  } as GatewayUsageReportWire;
}

function fakeClient(): TrayUsageClient {
  return {
    getGatewayQuota: async () => ({ quota: { accounts: [account()], until: 0 } }),
    getGatewayUsage: async ({ period }) => ({ report: report(period === "today" ? 0.5 : 2) }),
    close: vi.fn(),
  };
}

describe("daemonWebSocketTarget", () => {
  it("builds the local TCP and Unix-socket targets the daemon listens on", () => {
    expect(daemonWebSocketTarget("127.0.0.1:6767")).toEqual({ url: "ws://127.0.0.1:6767/ws" });
    expect(daemonWebSocketTarget("unix:///tmp/neolix.sock")).toEqual({
      url: "ws+unix:///tmp/neolix.sock:/ws",
    });
    expect(daemonWebSocketTarget("/tmp/neolix.sock")).toEqual({
      url: "ws+unix:///tmp/neolix.sock:/ws",
    });
  });

  it("hands Windows named pipes to ws as a socket path, not a URL", () => {
    const namedPipe = "\\\\.\\pipe\\neolix-5f3a";

    // A pipe path in `ws+unix://…` is not a parseable URL: backslashes make
    // `new URL` throw before the socket ever connects.
    expect(daemonWebSocketTarget(namedPipe)).toEqual({
      url: "ws://localhost/ws",
      socketPath: namedPipe,
    });
    expect(daemonWebSocketTarget(`pipe://${namedPipe}`)).toEqual({
      url: "ws://localhost/ws",
      socketPath: namedPipe,
    });
  });

  it("refuses an address without a port or with a path", () => {
    expect(daemonWebSocketTarget("")).toBeNull();
    expect(daemonWebSocketTarget("localhost")).toBeNull();
    expect(daemonWebSocketTarget("http://localhost:1/elsewhere")).toBeNull();
  });
});

describe("readTrayUsageState", () => {
  it("composes the label and tooltip from the daemon's readings", async () => {
    const state = await readTrayUsageState(fakeClient(), SETTINGS, "en", 0);

    expect(state.label).toBe("Claude 62% +3%");
    expect(state.tooltip).toContain("Claude · a@b.c");
    expect(state.tooltip).toContain("5h: 62% used · +3% · resets in 1m");
  });

  it("clears the menu bar when Settings names no cards", async () => {
    const state = await readTrayUsageState(fakeClient(), { ...SETTINGS, trayUsages: [] }, "en", 0);

    expect(state).toEqual({ label: "", tooltip: "Neox", logoDataUrl: null });
  });

  it("keeps the provider's name when there is no mark to draw", async () => {
    const client: TrayUsageClient = {
      ...fakeClient(),
      getGatewayQuota: async () => ({ quota: { accounts: [account("zai", "Z.ai")], until: 0 } }),
    };
    const state = await readTrayUsageState(
      client,
      { ...SETTINGS, trayUsages: ["zai|a@b.c"], trayNoBird: true },
      "en",
      0,
    );

    expect(state.label).toBe("Z.ai 62% +3%");
    expect(state.logoDataUrl).toBeNull();
  });

  it("drops the name when the Mac can draw the provider's mark", async () => {
    const state = await readTrayUsageState(
      fakeClient(),
      { ...SETTINGS, trayNoBird: true },
      "en",
      0,
    );

    expect(state.label).toBe("62% +3%");
    expect(state.logoDataUrl).toMatch(/^data:image\/png;base64,/);
  });
});

describe("startTrayUsagePolling", () => {
  function scheduler() {
    const timers: { callback: () => void; delayMs: number }[] = [];
    return {
      timers,
      setTimeout: (callback: () => void, delayMs: number) => {
        const timer = { callback, delayMs };
        timers.push(timer);
        return timer;
      },
      clearTimeout: vi.fn(),
    };
  }

  const flush = async (): Promise<void> => {
    for (let index = 0; index < 6; index += 1) {
      await Promise.resolve();
    }
  };

  it("publishes the first reading and then waits trayUsageEvery minutes", async () => {
    const timers = scheduler();
    const publish = vi.fn();
    const poller = startTrayUsagePolling({
      readSettings: async () => SETTINGS,
      resolveTarget: async () => ({ url: "ws://127.0.0.1:1/ws", credential: null }),
      createClient: fakeClient,
      publish,
      getLanguage: () => "en",
      now: () => 0,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });

    await flush();
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0]?.[0].label).toBe("Claude 62% +3%");
    expect(timers.timers.at(-1)?.delayMs).toBe(3 * 60_000);
    poller.stop();
  });

  it("retries sooner while the daemon is not up yet", async () => {
    const timers = scheduler();
    const publish = vi.fn();
    const poller = startTrayUsagePolling({
      readSettings: async () => SETTINGS,
      resolveTarget: async () => null,
      createClient: fakeClient,
      publish,
      getLanguage: () => "en",
      now: () => 0,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });

    await flush();
    expect(publish).not.toHaveBeenCalled();
    expect(timers.timers.at(-1)?.delayMs).toBe(20_000);
    poller.stop();
  });

  it("closes the client and stops scheduling when stopped", async () => {
    const timers = scheduler();
    const client = fakeClient();
    const close = vi.spyOn(client, "close");
    const poller = startTrayUsagePolling({
      readSettings: async () => SETTINGS,
      resolveTarget: async () => ({ url: "ws://127.0.0.1:1/ws", credential: null }),
      createClient: () => client,
      publish: vi.fn(),
      getLanguage: () => "en",
      now: () => 0,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });

    await flush();
    poller.stop();
    expect(close).toHaveBeenCalled();
    expect(timers.clearTimeout).toHaveBeenCalled();
  });
});
