// FILE: HostDaemonUpdate.browser.tsx
// Purpose: The daemon update button names the phase the host reports, then returns
//          to its idle label when the update finishes.
// Layer: Browser UI test

import "../../index.css";

import type { NeolixHostUpdateProgress } from "@synara/contracts";
import { beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";

const harness = vi.hoisted(() => {
  let finishUpdate:
    | ((result: { success: boolean; error: string | null; newVersion: string | null }) => void)
    | null = null;
  let progressListener: ((progress: { phase: NeolixHostUpdateProgress["phase"] }) => void) | null =
    null;
  return {
    updateCalls: 0,
    toast: vi.fn(),
    get updateListener() {
      return progressListener;
    },
    setUpdateListener(listener: (progress: { phase: NeolixHostUpdateProgress["phase"] }) => void) {
      progressListener = listener;
    },
    emit(phase: NeolixHostUpdateProgress["phase"]) {
      progressListener?.({ phase });
    },
    update() {
      harness.updateCalls += 1;
      return new Promise<{ success: boolean; error: string | null; newVersion: string | null }>(
        (resolve) => {
          finishUpdate = resolve;
        },
      );
    },
    finish(result: { success: boolean; error: string | null; newVersion: string | null }) {
      finishUpdate?.(result);
      finishUpdate = null;
    },
  };
});

vi.mock("~/lib/neolixHostApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/neolixHostApi")>()),
  updateHost: () => harness.update(),
  getHostStatus: async () => ({
    serverId: "srv-1",
    version: "0.17.0",
    pid: 42,
    startedAt: null,
    listen: "127.0.0.1:6768",
  }),
  restartHost: async () => ({ requestId: "restart-1" }),
  getLibraryGithubToken: async () => ({ configured: false }),
  setLibraryGithubToken: async () => ({ configured: false }),
}));

vi.mock("~/wsNativeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/wsNativeApi")>()),
  onNeolixHostUpdateProgress: (listener: (progress: NeolixHostUpdateProgress) => void) => {
    harness.setUpdateListener(listener);
    return () => harness.setUpdateListener(() => {});
  },
}));

vi.mock("~/components/ui/toast", () => ({ toastManager: { add: harness.toast } }));

vi.mock("~/nativeApi", () => ({
  ensureNativeApi: () => ({
    dialogs: { confirm: async () => true },
  }),
}));

vi.mock("~/hooks/useBuiltinFeatures", () => ({
  useBuiltinFeatures: () => ({ isEnabled: () => false }),
}));

vi.mock("./hostSettingsModel", () => ({
  hostConfigQueryKey: ["neolix-host-config"],
  hostStatusQueryKey: ["neolix-host-status"],
  useHostConfig: () => ({
    config: {},
    isLoading: false,
    error: null,
    saving: false,
    patch: vi.fn(async () => true),
  }),
  useHostStatus: () => ({
    data: { serverId: "srv-1", version: "0.16.5", pid: 42, startedAt: null, listen: null },
    isLoading: false,
    isFetching: false,
    refetch: vi.fn(),
  }),
  useGatewayConfig: () => ({
    config: {},
    isLoading: false,
    error: null,
    save: vi.fn(async () => null),
  }),
  formatBytes: (bytes: number) => `${bytes} B`,
}));

vi.mock("./AgentSkillsSettingsPanel", () => ({
  AgentSkillsSettingsPanel: () => null,
}));

vi.mock("./DesktopDaemonSection", () => ({
  DesktopDaemonLifecycleSection: () => null,
}));

import { HostDaemonSettingsPanel } from "./HostSettingsPanels";

beforeEach(() => {
  harness.toast.mockClear();
  harness.updateCalls = 0;
});

it("shows the daemon's update phase until the update finishes", async () => {
  render(<HostDaemonSettingsPanel active />);

  const updateButton = page.getByRole("button", { name: "Update", exact: true });
  await expect.element(updateButton).toBeVisible();
  await updateButton.click();

  await expect.element(page.getByRole("button", { name: "Updating…", exact: true })).toBeVisible();
  harness.emit("downloading");
  await expect
    .element(page.getByRole("button", { name: "Downloading…", exact: true }))
    .toBeVisible();
  harness.emit("installing");
  await expect
    .element(page.getByRole("button", { name: "Installing…", exact: true }))
    .toBeVisible();

  harness.finish({ success: true, error: null, newVersion: "0.17.0" });
  await expect.element(page.getByRole("button", { name: "Update", exact: true })).toBeVisible();
  expect(harness.updateCalls).toBe(1);
});

it("shows why the daemon could not install the update", async () => {
  render(<HostDaemonSettingsPanel active />);
  await page.getByRole("button", { name: "Update", exact: true }).click();
  harness.finish({ success: false, error: "npm ERR! network timeout", newVersion: null });

  await expect.element(page.getByRole("button", { name: "Update", exact: true })).toBeVisible();
  expect(harness.toast).toHaveBeenCalledWith({
    type: "error",
    title: "Daemon update failed",
    description: "npm ERR! network timeout",
  });
});
