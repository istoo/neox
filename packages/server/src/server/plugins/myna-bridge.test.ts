import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { MYNA_BRIDGE_SOURCE } from "./myna-bridge.js";

interface BridgeCall {
  method: string;
  params: unknown;
}

interface BridgeHarness {
  window: {
    myna: Record<string, unknown> & {
      ready: Promise<{ dark: boolean; lang: string; tokens: Record<string, string> }>;
      theme: { dark: boolean; lang: string; tokens: Record<string, string> } | null;
      context: Record<string, unknown>;
      onAction(listener: (action: unknown) => void): void;
      options: {
        get(): Promise<Record<string, unknown>>;
        set(values: Record<string, unknown>): Promise<Record<string, unknown>>;
      };
      read(name: string, params?: Record<string, unknown>): Promise<unknown>;
    };
  };
  root: {
    dataset: Record<string, string>;
    lang: string;
    style: { colorScheme: string };
    properties: Map<string, string>;
  };
  calls: BridgeCall[];
  applyContext(context: unknown): void;
  pushTheme(theme: { theme: "light" | "dark"; variables: Record<string, string> }): void;
}

function loadBridge(handlers: Record<string, (params: unknown) => unknown> = {}): BridgeHarness {
  const properties = new Map<string, string>();
  const root = {
    dataset: {} as Record<string, string>,
    lang: "",
    style: {
      colorScheme: "",
      setProperty(name: string, value: string) {
        properties.set(name, value);
      },
    },
    properties,
  };
  const calls: BridgeCall[] = [];
  let readyListener: ((context: unknown) => void) | null = null;
  let themeListener:
    | ((theme: { theme: "light" | "dark"; variables: Record<string, string> }) => void)
    | null = null;
  const sdk = {
    onReady(listener: (context: unknown) => void) {
      readyListener = listener;
    },
    onTheme(
      listener: (theme: { theme: "light" | "dark"; variables: Record<string, string> }) => void,
    ) {
      themeListener = listener;
    },
    rpc: {
      async invoke(method: string, params: unknown) {
        calls.push({ method, params });
        const handler = handlers[method];
        if (!handler) throw new Error(`unexpected method ${method}`);
        return handler(params);
      },
    },
  };
  const sandbox = {
    window: {
      neolix: sdk,
      console: { error() {} },
    } as Record<string, unknown>,
    document: { documentElement: root },
  };
  vm.runInNewContext(MYNA_BRIDGE_SOURCE, sandbox);
  const bridge = sandbox.window.myna as BridgeHarness["window"]["myna"];
  return {
    window: { myna: bridge },
    root,
    calls,
    applyContext(context) {
      if (!readyListener) throw new Error("The bridge did not subscribe to its context");
      readyListener(context);
    },
    pushTheme(theme) {
      if (!themeListener) throw new Error("The bridge did not subscribe to themes");
      themeListener(theme);
    },
  };
}

describe("myna page bridge", () => {
  it("answers hello from the frame context and queues an action for onAction", async () => {
    const harness = loadBridge();
    harness.applyContext({
      theme: "dark",
      locale: "zh-CN",
      params: { action: "check", providerId: "claude", providerName: "Claude Code" },
      permissions: ["rpc"],
    });

    const theme = await harness.window.myna.ready;
    expect(theme).toEqual({ dark: true, lang: "zh-CN", tokens: {} });
    expect(harness.window.myna.context).toEqual({
      provider: { id: "claude", name: "Claude Code" },
    });
    expect(harness.root.dataset.theme).toBe("dark");
    expect(harness.root.lang).toBe("zh-CN");

    const actions: unknown[] = [];
    harness.window.myna.onAction((action) => actions.push(action));
    await Promise.resolve();
    expect(actions).toEqual([{ id: "check", provider: { id: "claude", name: "Claude Code" } }]);
  });

  it("paints myna's and current myna's token prefixes from the host theme", () => {
    const harness = loadBridge();
    harness.applyContext({ theme: "light", locale: "en", params: {} });
    harness.pushTheme({
      theme: "dark",
      variables: {
        "--color-background": "#0e0e0e",
        "--color-foreground": "#f5f5f5",
        "--color-border": "#333333",
      },
    });

    expect(harness.root.dataset.theme).toBe("dark");
    expect(harness.root.style.colorScheme).toBe("dark");
    expect(harness.root.properties.get("--myna-bg")).toBe("#0e0e0e");
    expect(harness.root.properties.get("--owl-bg")).toBe("#0e0e0e");
    expect(harness.root.properties.get("--myna-line")).toBe("#333333");
    expect(harness.window.myna.theme).toEqual({
      dark: true,
      lang: "en",
      tokens: { bg: "#0e0e0e", fg: "#f5f5f5", line: "#333333" },
    });
  });

  it("reads and writes the plugin's own settings, retrying one conflict", async () => {
    let reads = 0;
    let writes = 0;
    const harness = loadBridge({
      "settings.options.read": () => {
        reads += 1;
        return { status: "ready", revision: `r${reads}`, values: { hideCost: true } };
      },
      "settings.options.write": () => {
        writes += 1;
        return writes === 1
          ? { status: "conflict", error: "Settings changed" }
          : { status: "saved", revision: "r2", values: { hideCost: false } };
      },
    });
    harness.applyContext({ theme: "light", locale: "en", params: {} });

    await expect(harness.window.myna.options.get()).resolves.toEqual({ hideCost: true });
    await expect(harness.window.myna.options.set({ hideCost: false })).resolves.toEqual({
      hideCost: false,
    });
    const writesToRpc = harness.calls.filter((call) => call.method === "settings.options.write");
    expect(writesToRpc.map((call) => call.params)).toEqual([
      { revision: "r2", values: { hideCost: false } },
      { revision: "r3", values: { hideCost: false } },
    ]);
    expect(harness.calls.filter((call) => call.method === "settings.options.read")).toHaveLength(3);
  });

  it("passes reads through the plugin's read RPC", async () => {
    const harness = loadBridge({
      "myna.read": (params) => ({ echoed: params }),
    });
    harness.applyContext({ theme: "light", locale: "en", params: {} });

    await expect(harness.window.myna.read("usage:summary", { period: "today" })).resolves.toEqual({
      echoed: { name: "usage:summary", params: { period: "today" } },
    });
    expect(harness.calls).toEqual([
      {
        method: "myna.read",
        params: { name: "usage:summary", params: { period: "today" } },
      },
    ]);
  });
});
