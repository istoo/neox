import { describe, expect, it, vi } from "vitest";

import {
  BrowserAutomationHub,
  browserAutomationPageTimeoutMs,
  type BrowserAutomationDaemonClient,
} from "./browserAutomationRpc.ts";

interface PageMessage {
  readonly requestId: string;
  readonly command: unknown;
  readonly workspaceId?: string;
}

function daemonRequest(requestId: string, command: unknown, extra: { workspaceId?: string } = {}) {
  return {
    type: "browser.automation.execute.request",
    requestId,
    ...extra,
    command,
  };
}

class FakeDaemon implements BrowserAutomationDaemonClient {
  public registration: { hostKind: string; supportedCommands: readonly string[] } | null = null;
  public observer: { update: (message: { type: string }) => void } | null = null;
  public releases = 0;
  public responses: Array<Record<string, unknown>> = [];

  public registerBrowserHost(registration: {
    hostKind: string;
    supportedCommands: readonly string[];
  }) {
    this.registration = registration;
    return {
      subscribe: (observer: { update: (message: { type: string }) => void }) => {
        this.observer = observer;
        return () => undefined;
      },
      release: async () => {
        this.releases += 1;
      },
    };
  }

  public sendBrowserAutomationExecuteResponse(response: unknown): void {
    this.responses.push(response as Record<string, unknown>);
  }

  public send(message: ReturnType<typeof daemonRequest>): void {
    this.observer?.update(message);
  }

  public lastPayload(): Record<string, unknown> {
    return (this.responses.at(-1)?.payload ?? {}) as Record<string, unknown>;
  }
}

function makeHub(daemon = new FakeDaemon()) {
  const hub = new BrowserAutomationHub(daemon, { pageTimeoutMsForCommand: () => 50 });
  return { daemon, hub };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const listTabs = { command: "list_tabs", args: {} };

describe("BrowserAutomationHub", () => {
  it("does not register a daemon host when no page is online", () => {
    const { daemon, hub } = makeHub();
    expect(hub.getPageCount()).toBe(0);
    expect(daemon.registration).toBeNull();
  });

  it("registers the daemon host only while a page is online", async () => {
    const { daemon, hub } = makeHub();

    const first = hub.addPage(() => undefined);
    const second = hub.addPage(() => undefined);
    expect(daemon.registration?.hostKind).toBe("desktop web");
    expect(daemon.registration?.supportedCommands).toContain("snapshot");
    expect(daemon.registration?.supportedCommands).not.toContain("resize");

    hub.removePage(first);
    await flush();
    expect(daemon.releases).toBe(0);

    hub.removePage(second);
    await flush();
    expect(daemon.releases).toBe(1);
  });

  it("forwards a command and posts the page's response", () => {
    const { daemon, hub } = makeHub();
    const sent: PageMessage[] = [];
    hub.addPage((request) => sent.push(request as PageMessage));

    daemon.send(daemonRequest("req-1", { command: "snapshot", args: { browserId: "tab-1" } }));
    expect(sent).toHaveLength(1);
    expect(sent[0]?.requestId).toBe("req-1");

    expect(
      hub.respond({
        requestId: "req-1",
        ok: true,
        result: { command: "snapshot", browserId: "tab-1" },
      }),
    ).toBe(true);
    return flush().then(() => {
      expect(daemon.lastPayload()).toMatchObject({
        requestId: "req-1",
        ok: true,
        result: { browserId: "tab-1" },
      });
    });
  });

  it("fails an in-flight request when its page disconnects", async () => {
    const { daemon, hub } = makeHub();
    const page = hub.addPage(() => undefined);

    daemon.send(daemonRequest("req-2", { command: "snapshot", args: { browserId: "tab-1" } }));
    hub.removePage(page);
    await flush();

    expect(daemon.lastPayload()).toMatchObject({
      requestId: "req-2",
      ok: false,
      error: { code: "browser_no_host", retryable: true },
    });
  });

  it("times out a page that never answers", async () => {
    vi.useFakeTimers();
    try {
      const { daemon, hub } = makeHub();
      hub.addPage(() => undefined);
      daemon.send(daemonRequest("req-3", { command: "snapshot", args: { browserId: "tab-1" } }));

      vi.advanceTimersByTime(51);
      await Promise.resolve();
      await Promise.resolve();
      expect(daemon.lastPayload()).toMatchObject({
        requestId: "req-3",
        ok: false,
        error: { code: "browser_timeout", retryable: true },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("merges list_tabs from every window and routes later commands by tab affinity", async () => {
    const { daemon, hub } = makeHub();
    const first: PageMessage[] = [];
    const second: PageMessage[] = [];
    hub.addPage((request) => first.push(request as PageMessage));
    hub.addPage((request) => second.push(request as PageMessage));

    daemon.send(daemonRequest("req-list", listTabs));
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);

    hub.respond({
      requestId: first[0]!.requestId,
      ok: true,
      result: { command: "list_tabs", tabs: [{ browserId: "tab-a", url: "https://a.test" }] },
    });
    hub.respond({
      requestId: second[0]!.requestId,
      ok: true,
      result: { command: "list_tabs", tabs: [{ browserId: "tab-b", url: "https://b.test" }] },
    });
    await flush();

    expect(daemon.lastPayload()).toMatchObject({
      requestId: "req-list",
      ok: true,
      result: { command: "list_tabs", tabs: [{ browserId: "tab-a" }, { browserId: "tab-b" }] },
    });

    daemon.send(daemonRequest("req-a", { command: "snapshot", args: { browserId: "tab-a" } }));
    expect(first.at(-1)?.requestId).toBe("req-a");
    expect(second.at(-1)?.requestId).not.toBe("req-a");

    daemon.send(daemonRequest("req-b", { command: "snapshot", args: { browserId: "tab-b" } }));
    expect(second.at(-1)?.requestId).toBe("req-b");
    expect(first.at(-1)?.requestId).toBe("req-a");
  });

  it("routes new_tab to the most recently active page", async () => {
    const { daemon, hub } = makeHub();
    const first: PageMessage[] = [];
    const second: PageMessage[] = [];
    hub.addPage((request) => first.push(request as PageMessage));
    hub.addPage((request) => second.push(request as PageMessage));

    daemon.send(daemonRequest("req-list", listTabs));
    hub.respond({
      requestId: second[0]!.requestId,
      ok: true,
      result: { command: "list_tabs", tabs: [{ browserId: "tab-b", url: "https://b.test" }] },
    });
    hub.respond({
      requestId: first[0]!.requestId,
      ok: true,
      result: { command: "list_tabs", tabs: [{ browserId: "tab-a", url: "https://a.test" }] },
    });
    await flush();

    daemon.send(daemonRequest("req-new", { command: "new_tab", args: {} }));
    expect(first.at(-1)?.requestId).toBe("req-new");
    expect(second.at(-1)?.requestId).not.toBe("req-new");
  });

  it("rejects tab-scoped commands when several pages are online and none owns the tab", () => {
    const { daemon, hub } = makeHub();
    hub.addPage(() => undefined);
    hub.addPage(() => undefined);

    daemon.send(
      daemonRequest("req-unknown", { command: "snapshot", args: { browserId: "tab-x" } }),
    );
    expect(daemon.lastPayload()).toMatchObject({
      requestId: "req-unknown",
      ok: false,
      error: { code: "browser_tab_not_found" },
    });
  });

  it("ignores responses for requests that are not in flight", () => {
    const { hub } = makeHub();
    hub.addPage(() => undefined);
    expect(hub.respond({ requestId: "never-sent", ok: true, result: {} })).toBe(false);
    expect(hub.respond(null)).toBe(false);
  });
});

describe("browserAutomationPageTimeoutMs", () => {
  it("uses a shorter default than the daemon broker", () => {
    expect(browserAutomationPageTimeoutMs(listTabs)).toBe(14_000);
  });

  it("lets a wait outlive its own deadline but not the broker's", () => {
    expect(
      browserAutomationPageTimeoutMs({
        command: "wait",
        args: { browserId: "tab-1", text: "done", timeoutMs: 20_000 },
      }),
    ).toBe(20_750);
  });
});
