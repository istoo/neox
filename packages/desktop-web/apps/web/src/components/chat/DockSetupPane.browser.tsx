// FILE: DockSetupPane.browser.tsx
// Purpose: Browser regressions for the right-dock workspace setup pane: live state
//          rendering, the rerun action, and the no-workspace / no-commands cases.
// Layer: Browser UI test

import "../../index.css";

import type { NativeApi, WorkspaceSetupEvent, WorkspaceSetupSnapshot } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const hostFeatures = vi.hoisted(() => ({
  values: { workspaceSetupObservation: true } as Record<string, boolean>,
}));

vi.mock("~/lib/neolixHostApi", () => ({
  getHostFeatures: async () => ({
    serverVersion: "0.15.0",
    features: hostFeatures.values,
  }),
}));

import { DockSetupPane } from "./DockSetupPane";

let restoreNativeApi: (() => void) | undefined;

beforeEach(() => {
  hostFeatures.values = { workspaceSetupObservation: true };
});

afterEach(() => {
  restoreNativeApi?.();
  restoreNativeApi = undefined;
  document.body.innerHTML = "";
});

function snapshot(
  status: WorkspaceSetupSnapshot["status"],
  commands: WorkspaceSetupSnapshot["detail"]["commands"] = [],
  error: string | null = null,
): WorkspaceSetupSnapshot {
  return {
    status,
    error,
    detail: {
      type: "worktree_setup",
      worktreePath: "/repo/wt",
      branchName: "feature",
      log: "",
      commands,
    },
  };
}

async function mountPane(workspaceId: string | null, initial?: WorkspaceSetupSnapshot) {
  let listener: ((event: WorkspaceSetupEvent) => void) | undefined;
  const subscribe = vi.fn((_input: { workspaceId: string }, next: typeof listener) => {
    listener = next;
    if (initial) {
      queueMicrotask(() => next?.({ workspaceId: "ws_1", snapshot: initial }));
    }
    return () => undefined;
  });
  const run = vi.fn(async (input: { workspaceId: string }) => ({
    workspaceId: input.workspaceId,
    started: true,
    error: null,
  }));

  const previous = Object.getOwnPropertyDescriptor(window, "nativeApi");
  Object.defineProperty(window, "nativeApi", {
    configurable: true,
    value: {
      neolix: { workspaceSetup: { subscribe, run } },
    } as unknown as NativeApi,
  });
  restoreNativeApi = () => {
    if (previous) Object.defineProperty(window, "nativeApi", previous);
    else Reflect.deleteProperty(window, "nativeApi");
  };

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const screen = await render(
    <QueryClientProvider client={queryClient}>
      <DockSetupPane workspaceId={workspaceId} />
    </QueryClientProvider>,
  );

  return {
    screen,
    subscribe,
    run,
    push: (next: WorkspaceSetupSnapshot) => listener?.({ workspaceId: "ws_1", snapshot: next }),
  };
}

describe("DockSetupPane", () => {
  it("renders a running setup with its expanded log", async () => {
    const pane = await mountPane(
      "ws_1",
      snapshot("running", [
        {
          index: 1,
          command: "bun install",
          status: "running",
          log: "installing packages\rinstalling packages 42%",
        },
      ]),
    );
    try {
      await expect.element(page.getByText("Running setup")).toBeVisible();
      await expect.element(page.getByText("bun install")).toBeVisible();
      await expect.element(page.getByText("installing packages 42%")).toBeVisible();
    } finally {
      await pane.screen.unmount();
    }
  });

  it("runs setup again from the toolbar", async () => {
    const pane = await mountPane("ws_1", snapshot("failed", [], "bun install failed"));
    try {
      await expect.element(page.getByText("bun install failed")).toBeVisible();
      await page.getByRole("button", { name: "Run setup again" }).click();
      expect(pane.run).toHaveBeenCalledWith({ workspaceId: "ws_1" });
    } finally {
      await pane.screen.unmount();
    }
  });

  it("shows the empty state for a completed workspace with no setup commands", async () => {
    const pane = await mountPane("ws_1", snapshot("completed"));
    try {
      await expect.element(page.getByText("This workspace has no setup commands.")).toBeVisible();
    } finally {
      await pane.screen.unmount();
    }
  });

  it("explains that a chat without a workspace has nothing to observe", async () => {
    const pane = await mountPane(null);
    try {
      expect(pane.subscribe).not.toHaveBeenCalled();
      await expect
        .element(page.getByText("This chat has no workspace yet. Send a message to create one."))
        .toBeVisible();
    } finally {
      await pane.screen.unmount();
    }
  });

  it("asks for a host update instead of subscribing on an older host", async () => {
    hostFeatures.values = {};
    const pane = await mountPane("ws_1");
    try {
      await expect.element(page.getByText("Update the host", { exact: true })).toBeVisible();
      expect(pane.subscribe).not.toHaveBeenCalled();
    } finally {
      await pane.screen.unmount();
    }
  });
});
