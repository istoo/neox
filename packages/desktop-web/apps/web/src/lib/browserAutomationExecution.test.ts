import { describe, expect, it, vi } from "vitest";

import type { BrowserAutomationHostRequest } from "@synara/contracts";

import {
  executeBrowserAutomationRequest,
  type BrowserAutomationBridge,
  type BrowserAutomationExecutorDeps,
} from "./browserAutomationExecution";

function request(
  command: unknown,
  overrides: {
    readonly [K in keyof BrowserAutomationHostRequest]?:
      | BrowserAutomationHostRequest[K]
      | undefined;
  } = {},
): BrowserAutomationHostRequest {
  const base: Record<string, unknown> = {
    requestId: "req-1",
    workspaceId: "ws-1",
    command,
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete base[key];
    else base[key] = value;
  }
  return base as BrowserAutomationHostRequest;
}

function makeBridge(overrides: Partial<BrowserAutomationBridge> = {}): BrowserAutomationBridge {
  return {
    executeAutomationCommand: vi.fn(async () => ({
      requestId: "req-1",
      ok: true,
      result: { command: "snapshot", browserId: "tab-1" },
    })),
    open: vi.fn(async () => ({})),
    newTab: vi.fn(async () => ({
      activeTabId: "tab-new",
      tabs: [{ id: "tab-existing" }, { id: "tab-new" }],
    })),
    closeTab: vi.fn(async () => ({})),
    ...overrides,
  };
}

function makeDeps(
  overrides: Partial<BrowserAutomationExecutorDeps> = {},
): BrowserAutomationExecutorDeps {
  return {
    bridge: makeBridge(),
    resolveThreadId: () => "thread-1",
    findTabThreadId: (browserId) => (browserId === "tab-1" ? "thread-1" : null),
    workspaceIdForThread: (threadId) => (threadId === "thread-1" ? "ws-1" : "ws-2"),
    openPanel: vi.fn(),
    waitForTabRegistration: vi.fn(async () => true),
    ...overrides,
  };
}

describe("executeBrowserAutomationRequest", () => {
  it("reports an unsupported runtime when the desktop bridge has no automation host", async () => {
    const result = await executeBrowserAutomationRequest(
      makeDeps({ bridge: null }),
      request({ command: "snapshot", args: { browserId: "tab-1" } }),
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "browser_unsupported", retryable: false },
    });
  });

  it("opens a tab in the request's workspace and waits for its webview", async () => {
    const native = makeBridge();
    const openPanel = vi.fn();
    const deps = makeDeps({ bridge: native, openPanel });

    const result = await executeBrowserAutomationRequest(
      deps,
      request({ command: "new_tab", args: { url: "https://example.test" } }),
    );

    expect(native.open).toHaveBeenCalledWith({
      threadId: "thread-1",
      initialUrl: "https://example.test",
    });
    expect(native.newTab).toHaveBeenCalledWith({
      threadId: "thread-1",
      url: "https://example.test",
      activate: true,
    });
    expect(openPanel).toHaveBeenCalledWith("thread-1");
    expect(deps.waitForTabRegistration).toHaveBeenCalledWith("tab-new");
    expect(result).toEqual({
      requestId: "req-1",
      ok: true,
      result: {
        command: "new_tab",
        browserId: "tab-new",
        workspaceId: "ws-1",
        url: "https://example.test",
      },
    });
  });

  it("reports a retryable timeout when the new tab never attaches", async () => {
    const result = await executeBrowserAutomationRequest(
      makeDeps({ waitForTabRegistration: vi.fn(async () => false) }),
      request({ command: "new_tab", args: {} }),
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "browser_timeout", retryable: true },
      requestId: "req-1",
    });
  });

  it("refuses to create a tab without a workspace", async () => {
    const native = makeBridge();
    const result = await executeBrowserAutomationRequest(
      makeDeps({ bridge: native }),
      request({ command: "new_tab", args: {} }, { workspaceId: undefined }),
    );
    expect(result).toMatchObject({ ok: false, error: { code: "browser_unsupported" } });
    expect(native.newTab).not.toHaveBeenCalled();
  });

  it("closes a tab through the renderer state", async () => {
    const native = makeBridge();
    const result = await executeBrowserAutomationRequest(
      makeDeps({ bridge: native }),
      request({ command: "close_tab", args: { browserId: "tab-1" } }),
    );
    expect(native.closeTab).toHaveBeenCalledWith({ threadId: "thread-1", tabId: "tab-1" });
    expect(result).toEqual({
      requestId: "req-1",
      ok: true,
      result: { command: "close_tab", browserId: "tab-1" },
    });
  });

  it("reports resize as unsupported instead of pretending it worked", async () => {
    const result = await executeBrowserAutomationRequest(
      makeDeps(),
      request({ command: "resize", args: { browserId: "tab-1", width: 800, height: 600 } }),
    );
    expect(result).toMatchObject({ ok: false, error: { code: "browser_unsupported" } });
  });

  it("forwards commands without the daemon workspace id", async () => {
    const execute = vi.fn(async (_request: Record<string, unknown>) => ({
      requestId: "req-1",
      ok: true,
      result: { command: "snapshot", browserId: "tab-1", snapshot: "tree", truncated: false },
    }));
    const result = await executeBrowserAutomationRequest(
      makeDeps({ bridge: makeBridge({ executeAutomationCommand: execute }) }),
      request(
        { command: "snapshot", args: { browserId: "tab-1" } },
        { agentId: "agent-1", cwd: "/repo" },
      ),
    );

    const forwarded = execute.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(forwarded).toMatchObject({
      type: "browser.automation.execute.request",
      requestId: "req-1",
      agentId: "agent-1",
      cwd: "/repo",
    });
    expect(forwarded).not.toHaveProperty("workspaceId");
    expect(result).toMatchObject({ ok: true, result: { command: "snapshot" } });
  });

  it("filters a window's tab list to the requesting workspace", async () => {
    const execute = vi.fn(async (_request: Record<string, unknown>) => ({
      requestId: "req-1",
      ok: true,
      result: {
        command: "list_tabs",
        tabs: [
          { browserId: "tab-a", workspaceId: "thread-1", url: "https://a.test" },
          { browserId: "tab-b", workspaceId: "thread-2", url: "https://b.test" },
        ],
      },
    }));
    const result = await executeBrowserAutomationRequest(
      makeDeps({ bridge: makeBridge({ executeAutomationCommand: execute }) }),
      request({ command: "list_tabs", args: {} }),
    );
    expect(result).toMatchObject({
      ok: true,
      result: { command: "list_tabs", tabs: [{ browserId: "tab-a" }] },
    });
  });

  it("refuses a tab owned by another workspace without touching the page", async () => {
    const execute = vi.fn();
    const result = await executeBrowserAutomationRequest(
      makeDeps({
        bridge: makeBridge({ executeAutomationCommand: execute }),
        workspaceIdForThread: () => "ws-other",
      }),
      request({ command: "snapshot", args: { browserId: "tab-1" } }),
    );
    expect(result).toMatchObject({ ok: false, error: { code: "browser_tab_not_found" } });
    expect(execute).not.toHaveBeenCalled();
  });

  it("passes through a typed browser failure and normalizes an exception", async () => {
    const typed = await executeBrowserAutomationRequest(
      makeDeps({
        bridge: makeBridge({
          executeAutomationCommand: async () => ({
            requestId: "req-1",
            ok: false,
            error: { code: "browser_stale_ref", message: "stale", retryable: false },
          }),
        }),
      }),
      request({ command: "click", args: { browserId: "tab-1", ref: "@e1" } }),
    );
    expect(typed).toMatchObject({ ok: false, error: { code: "browser_stale_ref" } });

    const thrown = await executeBrowserAutomationRequest(
      makeDeps({
        bridge: makeBridge({
          executeAutomationCommand: async () => {
            throw new Error("guest crashed");
          },
        }),
      }),
      request({ command: "click", args: { browserId: "tab-1", ref: "@e1" } }),
    );
    expect(thrown).toMatchObject({
      ok: false,
      error: { code: "browser_unknown_error", message: "guest crashed" },
    });
  });
});
