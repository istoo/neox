import "../../index.css";

import type { AgentSkillsSaveResult, AgentSkillsStatus } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

function makeStatus(): AgentSkillsStatus {
  return {
    state: "not-installed",
    ops: [{ kind: "add", name: "orchestration" }],
    available: ["orchestration", "review"],
    installed: [],
    selection: { mode: "all" },
  };
}

const harness = vi.hoisted(() => {
  const state = {
    status: makeStatus(),
    confirm: true,
    features: { skillManagement: true } as Record<string, boolean>,
    getCalls: 0,
  };
  const calls: Array<[string, unknown]> = [];
  return {
    state,
    calls,
    reset() {
      state.status = makeStatus();
      state.confirm = true;
      state.features = { skillManagement: true };
      state.getCalls = 0;
      calls.length = 0;
    },
  };
});

vi.mock("~/lib/neolixHostApi", () => ({
  getHostFeatures: async () => ({
    serverVersion: "0.15.0",
    features: harness.state.features,
  }),
}));

vi.mock("~/lib/neolixAgentSkillsApi", () => {
  const save = (
    selection: AgentSkillsStatus["selection"],
    confirmedRemovals?: readonly string[],
  ): AgentSkillsSaveResult => {
    harness.calls.push(["saveSelection", { selection, confirmedRemovals }]);
    if (confirmedRemovals === undefined && selection.mode === "custom") {
      const removable = harness.state.status.installed.filter(
        (name) => !selection.skills.includes(name),
      );
      if (removable.length > 0) {
        // The daemon reports the unchanged status while it waits for approval.
        return {
          ...harness.state.status,
          confirmationRequired: { removals: removable },
        };
      }
    }
    harness.state.status = {
      ...harness.state.status,
      state: "up-to-date",
      ops: [],
      selection,
      installed:
        selection.mode === "all" ? [...harness.state.status.available] : [...selection.skills],
    };
    return { ...harness.state.status, confirmationRequired: null };
  };
  return {
    neolixAgentSkillsApi: {
      get: async () => {
        harness.state.getCalls += 1;
        return harness.state.status;
      },
      reconcile: async () => {
        harness.calls.push(["reconcile", undefined]);
        harness.state.status = {
          ...harness.state.status,
          state: "up-to-date",
          ops: [],
          installed: [...harness.state.status.available],
        };
        return harness.state.status;
      },
      uninstall: async () => {
        harness.calls.push(["uninstall", undefined]);
        harness.state.status = {
          ...harness.state.status,
          state: "not-installed",
          ops: harness.state.status.available.map((name) => ({ kind: "add" as const, name })),
          installed: [],
        };
        return harness.state.status;
      },
      saveSelection: async (
        selection: AgentSkillsStatus["selection"],
        confirmedRemovals?: readonly string[],
      ) => save(selection, confirmedRemovals),
    },
  };
});

vi.mock("~/nativeApi", () => ({
  readNativeApi: () => ({
    dialogs: { confirm: async () => harness.state.confirm },
  }),
}));

import { AgentSkillsSettingsPanel } from "./AgentSkillsSettingsPanel";

function renderPanel() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <AgentSkillsSettingsPanel active />
    </QueryClientProvider>,
  );
}

beforeEach(() => harness.reset());

it("asks for a host update and sends no request on an older host", async () => {
  harness.state.features = {};
  const screen = await renderPanel();
  await expect.element(screen.getByText("Update the host", { exact: true })).toBeVisible();
  expect(harness.state.getCalls).toBe(0);
  await screen.unmount();
});

it("installs the bundled skills from the row switch", async () => {
  const screen = await renderPanel();
  await expect
    .element(screen.getByRole("switch", { name: "Orchestration skills" }))
    .not.toBeChecked();

  await screen.getByRole("switch", { name: "Orchestration skills" }).click();
  await expect.poll(() => harness.calls).toContainEqual(["reconcile", undefined]);
  await expect.element(screen.getByRole("switch", { name: "Orchestration skills" })).toBeChecked();
  await screen.unmount();
});

it("offers Update when drift only adds or refreshes skills", async () => {
  harness.state.status = {
    state: "drift",
    ops: [
      { kind: "delete", name: "old-skill" },
      { kind: "update", name: "review" },
    ],
    available: ["review"],
    installed: ["review", "old-skill"],
    selection: { mode: "all" },
  };
  const screen = await renderPanel();
  await expect.element(screen.getByText("Update available")).toBeVisible();

  await screen.getByRole("button", { name: "Update" }).click();
  await expect.poll(() => harness.calls).toContainEqual(["reconcile", undefined]);
  await screen.unmount();
});

it("saves a custom selection and retries with confirmed removals", async () => {
  harness.state.status = {
    state: "up-to-date",
    ops: [],
    available: ["orchestration", "review"],
    installed: ["orchestration", "review"],
    selection: { mode: "all" },
  };
  const screen = await renderPanel();
  await screen.getByRole("button", { name: "Choose skills" }).click();
  await expect.element(screen.getByText("Bundled skills")).toBeVisible();

  await screen.getByRole("switch", { name: "All skills" }).click();
  await screen.getByRole("switch", { name: "review" }).click();
  await screen.getByRole("button", { name: "Save", exact: true }).click();

  await expect
    .poll(() => harness.calls)
    .toContainEqual([
      "saveSelection",
      {
        selection: { mode: "custom", skills: ["orchestration"] },
        confirmedRemovals: undefined,
      },
    ]);
  await expect
    .poll(() => harness.calls)
    .toContainEqual([
      "saveSelection",
      {
        selection: { mode: "custom", skills: ["orchestration"] },
        confirmedRemovals: ["review"],
      },
    ]);
  await expect.element(screen.getByText("Bundled skills")).not.toBeInTheDocument();
  await screen.unmount();
});

it("asks before uninstalling every bundled skill", async () => {
  harness.state.status = {
    state: "up-to-date",
    ops: [],
    available: ["orchestration"],
    installed: ["orchestration"],
    selection: { mode: "all" },
  };
  const screen = await renderPanel();
  await expect.element(screen.getByRole("switch", { name: "Orchestration skills" })).toBeChecked();

  await screen.getByRole("switch", { name: "Orchestration skills" }).click();
  await expect.poll(() => harness.calls).toContainEqual(["uninstall", undefined]);
  await expect
    .element(screen.getByRole("switch", { name: "Orchestration skills" }))
    .not.toBeChecked();
  await screen.unmount();
});

it("declining the uninstall confirmation leaves the skills installed", async () => {
  harness.state.status = {
    state: "up-to-date",
    ops: [],
    available: ["orchestration"],
    installed: ["orchestration"],
    selection: { mode: "all" },
  };
  harness.state.confirm = false;
  const screen = await renderPanel();
  await screen.getByRole("switch", { name: "Orchestration skills" }).click();
  expect(harness.calls).toEqual([]);
  await expect.element(screen.getByRole("switch", { name: "Orchestration skills" })).toBeChecked();
  await screen.unmount();
});
