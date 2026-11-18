// The daemon's browser automation host, served by the desktop-web renderer.
//
// The bridge is the process that holds a DaemonClient, but it has no webview. Pages in
// Electron windows do. This module keeps the two ends together:
//
//   daemon ──request──▶ bridge hub ──stream──▶ page (webview) ──IPC──▶ Electron main
//          ◀─response──         ◀─respond───
//
// A page enlists by subscribing; the daemon host is registered only while at least one
// page is subscribed and is released when the last one leaves. Because the bridge is a
// single host to the daemon, page selection, per-tab affinity and timeouts live here.
import { Effect, Queue, Stream } from "effect";

import { WS_METHODS, type BrowserAutomationHostRequest } from "@synara/contracts";
import {
  BROWSER_AUTOMATION_COMMAND_NAMES,
  type BrowserAutomationExecuteRequest,
  type BrowserAutomationExecuteResponse,
} from "../../../../protocol/dist/browser-automation/rpc-schemas.js";

import type { BridgeModel } from "./model.ts";
import type { AnyHandler } from "./stubs.ts";

/**
 * The daemon broker's default deadline is 15s and a `browser_wait` may raise it to the
 * command's own timeout. Answer a little earlier so the agent receives the precise
 * page-level timeout instead of the broker's generic one.
 */
const DEFAULT_PAGE_TIMEOUT_MS = 14_000;
const WAIT_TIMEOUT_MARGIN_MS = 750;

type BrowserAutomationResponsePayload = BrowserAutomationExecuteResponse["payload"];

interface BrowserAutomationHostObservation {
  subscribe(observer: {
    snapshot: (snapshot: unknown) => void;
    update: (message: { type: string }) => void;
  }): () => void;
  release(): Promise<void>;
}

/** The slice of DaemonClient this module needs; tests supply a fake. */
export interface BrowserAutomationDaemonClient {
  registerBrowserHost(registration: {
    hostKind: string;
    supportedCommands: readonly string[];
  }): BrowserAutomationHostObservation;
  sendBrowserAutomationExecuteResponse(response: BrowserAutomationExecuteResponse): void;
}

interface PageSession {
  readonly id: number;
  readonly emit: (request: BrowserAutomationHostRequest) => void;
  /** Monotonic activity counter; `new_tab` prefers the page used most recently. */
  activeAt: number;
  readonly browserIds: Set<string>;
}

interface PendingPageRequest {
  readonly pageId: number;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly resolve: (payload: BrowserAutomationResponsePayload) => void;
}

export interface BrowserAutomationHubOptions {
  readonly log?: (line: string) => void;
  /** Override the page deadline (tests use a short one). */
  readonly pageTimeoutMsForCommand?: (command: unknown) => number;
}

/** Picks the page-level deadline from the command the page was asked to run. */
export function browserAutomationPageTimeoutMs(command: unknown): number {
  if (typeof command === "object" && command !== null && !Array.isArray(command)) {
    const record = command as { command?: unknown; args?: unknown };
    if (record.command === "wait" && typeof record.args === "object" && record.args !== null) {
      const timeoutMs = (record.args as { timeoutMs?: unknown }).timeoutMs;
      if (typeof timeoutMs === "number" && timeoutMs > 0) {
        return timeoutMs + WAIT_TIMEOUT_MARGIN_MS;
      }
    }
  }
  return DEFAULT_PAGE_TIMEOUT_MS;
}

export class BrowserAutomationHub {
  private nextPageId = 1;
  private sequence = 0;
  private readonly pages = new Map<number, PageSession>();
  private readonly pending = new Map<string, PendingPageRequest>();
  /** browserId → page, learned from list_tabs/new_tab responses. */
  private readonly browserPage = new Map<string, number>();
  private daemonHost: BrowserAutomationHostObservation | null = null;
  private registering: Promise<void> | null = null;

  public constructor(
    private readonly client: BrowserAutomationDaemonClient,
    private readonly options: BrowserAutomationHubOptions = {},
  ) {}

  public addPage(emit: (request: BrowserAutomationHostRequest) => void): number {
    const id = this.nextPageId++;
    this.pages.set(id, { id, emit, activeAt: ++this.sequence, browserIds: new Set() });
    void this.ensureDaemonHost();
    return id;
  }

  public removePage(id: number): void {
    const page = this.pages.get(id);
    if (!page) return;
    this.pages.delete(id);
    for (const browserId of page.browserIds) {
      if (this.browserPage.get(browserId) === id) {
        this.browserPage.delete(browserId);
      }
    }
    // A response can no longer arrive: release the daemon's pending request now instead
    // of letting it burn its full deadline.
    for (const [requestId, pending] of [...this.pending]) {
      if (pending.pageId !== id) continue;
      this.pending.delete(requestId);
      clearTimeout(pending.timer);
      pending.resolve(
        failure(
          requestId,
          "browser_no_host",
          "The page running browser automation disconnected.",
          true,
        ),
      );
    }
    if (this.pages.size === 0) {
      void this.releaseDaemonHost();
    }
  }

  /** Records a page's response. False means the id was not in flight (stale or foreign). */
  public respond(payload: unknown): boolean {
    const requestId = readPayloadRequestId(payload);
    if (!requestId) return false;
    const pending = this.pending.get(requestId);
    if (!pending) return false;
    this.pending.delete(requestId);
    clearTimeout(pending.timer);
    const page = this.pages.get(pending.pageId);
    if (page) page.activeAt = ++this.sequence;
    pending.resolve(payload as BrowserAutomationResponsePayload);
    return true;
  }

  public getPageCount(): number {
    return this.pages.size;
  }

  private async ensureDaemonHost(): Promise<void> {
    if (this.daemonHost || this.registering || this.pages.size === 0) return;
    const attempt = (async () => {
      const observation = this.client.registerBrowserHost({
        hostKind: "desktop web",
        // The panel owns its size; the daemon should answer `browser_unsupported` itself
        // instead of sending a resize the page cannot honour.
        supportedCommands: BROWSER_AUTOMATION_COMMAND_NAMES.filter((name) => name !== "resize"),
      });
      observation.subscribe({
        snapshot: () => undefined,
        update: (message) => {
          if (message.type === "browser.automation.execute.request") {
            this.dispatch(message as unknown as BrowserAutomationExecuteRequest);
          }
        },
      });
      // The last page may have left while registration was in flight.
      if (this.pages.size === 0) {
        await observation.release();
        return;
      }
      this.daemonHost = observation;
    })();
    this.registering = attempt;
    try {
      await attempt;
    } catch (error) {
      this.log(`browser automation host registration failed: ${errorText(error)}`);
    } finally {
      if (this.registering === attempt) this.registering = null;
    }
  }

  private async releaseDaemonHost(): Promise<void> {
    const host = this.daemonHost;
    this.daemonHost = null;
    this.browserPage.clear();
    for (const [requestId, pending] of [...this.pending]) {
      this.pending.delete(requestId);
      clearTimeout(pending.timer);
      pending.resolve(
        failure(requestId, "browser_no_host", "No page can run browser automation.", true),
      );
    }
    if (!host) return;
    try {
      await host.release();
    } catch (error) {
      this.log(`browser automation host release failed: ${errorText(error)}`);
    }
  }

  private dispatch(request: BrowserAutomationExecuteRequest): void {
    if (readCommandName(request.command) === "list_tabs") {
      void this.dispatchListTabs(request);
      return;
    }
    const page = this.selectPage(request);
    if (!page) {
      const browserId = readBrowserId(request.command);
      this.reply(
        browserId && this.pages.size > 0
          ? failure(
              request.requestId,
              "browser_tab_not_found",
              `Browser tab ${browserId} is not associated with a connected page. Call browser_list_tabs and use one of the returned browserId values.`,
            )
          : noHostFailure(request.requestId),
      );
      return;
    }
    void this.executeOnPage(page, request).then((payload) => this.reply(payload));
  }

  private async dispatchListTabs(request: BrowserAutomationExecuteRequest): Promise<void> {
    const pages = [...this.pages.values()];
    if (pages.length === 0) {
      this.reply(noHostFailure(request.requestId));
      return;
    }
    if (pages.length === 1) {
      this.reply(await this.executeOnPage(pages[0]!, request));
      return;
    }

    // Each window can only see the webviews it owns, so ask every page and merge. The
    // request ids are namespaced because pages answer independently.
    const results = await Promise.all(
      pages.map(async (page) => ({
        page,
        payload: await this.sendToPage(page, {
          ...request,
          requestId: `${request.requestId}:${page.id}`,
        }),
      })),
    );
    for (const { page, payload } of results) {
      this.rememberPayload(page, payload);
    }

    const failed = results.find(({ payload }) => !payload.ok);
    if (failed && !failed.payload.ok) {
      this.reply({ ...failed.payload, requestId: request.requestId });
      return;
    }

    this.reply({
      requestId: request.requestId,
      ok: true,
      result: {
        command: "list_tabs",
        tabs: results.flatMap(({ payload }) =>
          payload.ok && payload.result.command === "list_tabs" ? payload.result.tabs : [],
        ),
      },
    });
  }

  private selectPage(request: BrowserAutomationExecuteRequest): PageSession | null {
    const command = request.command;
    const browserId = readBrowserId(command);
    if (!browserId || command.command === "new_tab") {
      return this.mostRecentPage();
    }
    const ownerId = this.browserPage.get(browserId);
    if (ownerId !== undefined) {
      return this.pages.get(ownerId) ?? null;
    }
    return this.pages.size === 1 ? (this.mostRecentPage() ?? null) : null;
  }

  private mostRecentPage(): PageSession | null {
    let selected: PageSession | null = null;
    for (const page of this.pages.values()) {
      if (!selected || page.activeAt > selected.activeAt) selected = page;
    }
    return selected;
  }

  private async executeOnPage(
    page: PageSession,
    request: BrowserAutomationExecuteRequest,
  ): Promise<BrowserAutomationResponsePayload> {
    const payload = await this.sendToPage(page, request);
    this.rememberPayload(page, payload);
    return { ...payload, requestId: request.requestId } as BrowserAutomationResponsePayload;
  }

  private sendToPage(
    page: PageSession,
    request: BrowserAutomationExecuteRequest,
  ): Promise<BrowserAutomationResponsePayload> {
    if (this.pending.has(request.requestId)) {
      return Promise.resolve(
        failure(
          request.requestId,
          "browser_unknown_error",
          `Duplicate browser automation request id: ${request.requestId}`,
        ),
      );
    }
    const timeoutMs = this.options.pageTimeoutMsForCommand
      ? this.options.pageTimeoutMsForCommand(request.command)
      : browserAutomationPageTimeoutMs(request.command);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(request.requestId)) return;
        resolve(
          failure(
            request.requestId,
            "browser_timeout",
            `Browser automation timed out after ${timeoutMs}ms.`,
            true,
          ),
        );
      }, timeoutMs);
      this.pending.set(request.requestId, { pageId: page.id, timer, resolve });
      try {
        page.emit(toPageRequest(request));
      } catch (error) {
        if (!this.pending.delete(request.requestId)) return;
        clearTimeout(timer);
        resolve(
          failure(
            request.requestId,
            "browser_no_host",
            `Could not deliver the browser automation request: ${errorText(error)}`,
            true,
          ),
        );
      }
    });
  }

  private rememberPayload(page: PageSession, payload: BrowserAutomationResponsePayload): void {
    if (!payload.ok) return;
    const result = payload.result;
    if (result.command === "list_tabs") {
      for (const browserId of page.browserIds) {
        if (this.browserPage.get(browserId) === page.id) this.browserPage.delete(browserId);
      }
      page.browserIds.clear();
      for (const tab of result.tabs) {
        this.browserPage.set(tab.browserId, page.id);
        page.browserIds.add(tab.browserId);
      }
      return;
    }
    if (result.command === "close_tab") {
      this.browserPage.delete(result.browserId);
      page.browserIds.delete(result.browserId);
      return;
    }
    if ("browserId" in result) {
      this.browserPage.set(result.browserId, page.id);
      page.browserIds.add(result.browserId);
    }
  }

  private reply(payload: BrowserAutomationResponsePayload): void {
    try {
      this.client.sendBrowserAutomationExecuteResponse({
        type: "browser.automation.execute.response",
        payload,
      });
    } catch (error) {
      this.log(`browser automation response failed to send: ${errorText(error)}`);
    }
  }

  private log(line: string): void {
    this.options.log?.(line);
  }
}

export function makeBrowserAutomationHandlers(
  model: Pick<BridgeModel, "client">,
  options: BrowserAutomationHubOptions = {},
): Record<string, AnyHandler> {
  const hub = new BrowserAutomationHub(
    model.client as unknown as BrowserAutomationDaemonClient,
    options,
  );
  return {
    [WS_METHODS.browserAutomationSubscribe]: () =>
      Stream.callback<BrowserAutomationHostRequest>((queue) =>
        Effect.acquireRelease(
          Effect.sync(() => hub.addPage((request) => Queue.offerUnsafe(queue, request))),
          (pageId) => Effect.sync(() => hub.removePage(pageId)),
        ),
      ),
    [WS_METHODS.browserAutomationRespond]: (payload) =>
      Effect.sync(() => hub.respond((payload as { payload?: unknown }).payload)),
  };
}

function toPageRequest(request: BrowserAutomationExecuteRequest): BrowserAutomationHostRequest {
  return {
    requestId: request.requestId,
    ...(request.agentId ? { agentId: request.agentId } : {}),
    ...(request.cwd ? { cwd: request.cwd } : {}),
    ...(request.workspaceId ? { workspaceId: request.workspaceId } : {}),
    command: request.command as never,
  };
}

function readCommandName(command: unknown): string | null {
  if (typeof command !== "object" || command === null || Array.isArray(command)) return null;
  const name = (command as { command?: unknown }).command;
  return typeof name === "string" ? name : null;
}

function readBrowserId(command: unknown): string | null {
  if (typeof command !== "object" || command === null || Array.isArray(command)) return null;
  const args = (command as { args?: unknown }).args;
  if (typeof args !== "object" || args === null || Array.isArray(args)) return null;
  const browserId = (args as { browserId?: unknown }).browserId;
  return typeof browserId === "string" && browserId.length > 0 ? browserId : null;
}

function readPayloadRequestId(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const requestId = (payload as { requestId?: unknown }).requestId;
  return typeof requestId === "string" && requestId.length > 0 ? requestId : null;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failure(
  requestId: string,
  code: "browser_no_host" | "browser_timeout" | "browser_unknown_error" | "browser_tab_not_found",
  message: string,
  retryable = false,
): BrowserAutomationResponsePayload {
  return { requestId, ok: false, error: { code, message, retryable } };
}

function noHostFailure(requestId: string): BrowserAutomationResponsePayload {
  return failure(requestId, "browser_no_host", "No browser automation host is connected.", true);
}
