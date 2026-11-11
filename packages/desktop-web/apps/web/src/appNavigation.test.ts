// FILE: appNavigation.test.ts
// Purpose: Verifies browser-style route navigation state without rendering the app shell.
// Layer: Web routing utility tests
// Depends on: TanStack memory history and appNavigation helpers

import { createMemoryHistory } from "@tanstack/react-router";
import { describe, expect, it, vi } from "vitest";

import {
  goBackInAppHistory,
  goForwardInAppHistory,
  resolveAppNavigationState,
  resolveScopedInitialRoute,
  syncAppNavigationState,
} from "./appNavigation";

describe("resolveScopedInitialRoute", () => {
  const base = { scope: "local", remembered: "/draft-thread" };

  it("keeps a deep link to a thread instead of resuming the last route", () => {
    expect(
      resolveScopedInitialRoute({
        ...base,
        previousScope: undefined,
        currentHref: "/thread-1?panel=diff",
        currentPathname: "/thread-1",
      }),
    ).toBe("/thread-1?panel=diff");
  });

  it("resumes the last route when the app opens on the root", () => {
    expect(
      resolveScopedInitialRoute({
        ...base,
        previousScope: undefined,
        currentHref: "/",
        currentPathname: "/",
      }),
    ).toBe("/draft-thread");
  });

  it("resumes the scope's last route when switching in from another scope", () => {
    expect(
      resolveScopedInitialRoute({
        ...base,
        previousScope: "remote-host",
        currentHref: "/thread-on-other-host",
        currentPathname: "/thread-on-other-host",
      }),
    ).toBe("/draft-thread");
    expect(
      resolveScopedInitialRoute({
        ...base,
        remembered: null,
        previousScope: "remote-host",
        currentHref: "/thread-on-other-host",
        currentPathname: "/thread-on-other-host",
      }),
    ).toBe("/");
  });

  it("keeps the current route on a reload inside the same scope", () => {
    expect(
      resolveScopedInitialRoute({
        ...base,
        previousScope: "local",
        currentHref: "/thread-1",
        currentPathname: "/thread-1",
      }),
    ).toBe("/thread-1");
  });

  it("ignores a remembered route that is not app-relative", () => {
    expect(
      resolveScopedInitialRoute({
        ...base,
        remembered: "//evil.example/path",
        previousScope: undefined,
        currentHref: "/",
        currentPathname: "/",
      }),
    ).toBe("/");
  });
});

describe("resolveAppNavigationState", () => {
  it("tracks back and forward availability from the TanStack history index", () => {
    const history = createMemoryHistory({ initialEntries: ["/"] });

    expect(syncAppNavigationState(history)).toEqual({
      canGoBack: false,
      canGoForward: false,
    });

    history.push("/settings");
    expect(syncAppNavigationState(history, { type: "PUSH" })).toEqual({
      canGoBack: true,
      canGoForward: false,
    });

    history.back();
    expect(resolveAppNavigationState(history)).toEqual({
      canGoBack: false,
      canGoForward: true,
    });
  });

  it("does not use browser-global history length to enable forward on first app load", () => {
    const history = createMemoryHistory({ initialEntries: ["/"] });
    Object.defineProperty(history, "length", {
      configurable: true,
      get: () => 2,
    });

    expect(syncAppNavigationState(history)).toEqual({
      canGoBack: false,
      canGoForward: false,
    });
  });

  it("clears stale forward availability when pushing a new route after going back", () => {
    const history = createMemoryHistory({ initialEntries: ["/"] });

    history.push("/settings");
    syncAppNavigationState(history, { type: "PUSH" });
    history.push("/plugins");
    syncAppNavigationState(history, { type: "PUSH" });
    history.back();
    syncAppNavigationState(history, { type: "BACK" });
    history.back();
    expect(syncAppNavigationState(history, { type: "BACK" })).toEqual({
      canGoBack: false,
      canGoForward: true,
    });

    history.push("/automations");
    expect(syncAppNavigationState(history, { type: "PUSH" })).toEqual({
      canGoBack: true,
      canGoForward: false,
    });
  });

  it("flushes pending URL writes before native back and forward navigation", () => {
    const history = createMemoryHistory({ initialEntries: ["/", "/settings"] });
    const calls: string[] = [];
    vi.spyOn(history, "flush").mockImplementation(() => {
      calls.push("flush");
    });
    vi.spyOn(history, "back").mockImplementation(() => {
      calls.push("back");
    });
    vi.spyOn(history, "forward").mockImplementation(() => {
      calls.push("forward");
    });

    goBackInAppHistory(history);
    goForwardInAppHistory(history);

    expect(calls).toEqual(["flush", "back", "flush", "forward"]);
  });
});
