import "../../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const harness = vi.hoisted(() => {
  const initialOrder = ["codex", "claude"];
  function makeSnapshot() {
    return {
      gatewayBaseUrl: "http://127.0.0.1:6868/v1",
      models: [
        { id: "gpt-5", label: "GPT-5" },
        { id: "claude-sonnet", label: "Claude Sonnet" },
      ],
      entries: [
        {
          provider: "codex",
          configPath: null,
          connected: false,
          model: null,
          modelCount: 0,
          reason: null,
          models: { listed: 2, shown: 2, hidden: [] as string[] },
          shellInstalled: false,
          cliVersion: "0.50.0",
        },
        {
          provider: "claude",
          configPath: "/home/me/.claude/settings.json",
          connected: true,
          model: "gpt-5",
          modelCount: 2,
          reason: null,
          models: { listed: 2, shown: 2, hidden: [] as string[] },
          shellInstalled: true,
        },
      ],
      profiles: [] as Array<{ name: string; savedAt: number; agents: object }>,
      order: [...initialOrder],
      hidden: [] as string[],
      error: null as string | null,
    };
  }

  const state = { snapshot: makeSnapshot() };
  const calls: Array<[string, unknown]> = [];
  return {
    state,
    calls,
    reset() {
      state.snapshot = makeSnapshot();
      calls.length = 0;
    },
  };
});

vi.mock("~/lib/neolixAgentConnectApi", () => {
  const respond = () => ({ snapshot: harness.state.snapshot });
  const entryOf = (provider: string) =>
    harness.state.snapshot.entries.find((entry) => entry.provider === provider)!;
  return {
    neolixAgentConnectApi: {
      get: async () => respond(),
      set: async (input: { provider: string; connected: boolean; model?: string }) => {
        harness.calls.push(["set", input]);
        const entry = entryOf(input.provider);
        entry.connected = input.connected;
        if (input.model !== undefined) entry.model = input.model;
        return respond();
      },
      setModels: async (input: { provider: string; hidden: string[] }) => {
        harness.calls.push(["setModels", input]);
        const entry = entryOf(input.provider);
        entry.models = {
          listed: entry.models.listed,
          shown: entry.models.listed - input.hidden.length,
          hidden: input.hidden,
        };
        return respond();
      },
      setShell: async (input: { provider: string; enabled: boolean }) => {
        harness.calls.push(["setShell", input]);
        entryOf(input.provider).shellInstalled = input.enabled;
        return respond();
      },
      setLayout: async (input: { order: string[]; hidden: string[] }) => {
        harness.calls.push(["setLayout", input]);
        harness.state.snapshot.order = input.order;
        harness.state.snapshot.hidden = input.hidden;
        return respond();
      },
      saveProfile: async (name: string) => {
        harness.calls.push(["saveProfile", name]);
        harness.state.snapshot.profiles = [
          ...harness.state.snapshot.profiles,
          { name, savedAt: 1, agents: {} },
        ];
        return respond();
      },
      applyProfile: async (name: string) => {
        harness.calls.push(["applyProfile", name]);
        return respond();
      },
      deleteProfile: async (name: string) => {
        harness.calls.push(["deleteProfile", name]);
        return respond();
      },
      renameProfile: async (input: { name: string; to: string }) => {
        harness.calls.push(["renameProfile", input]);
        return respond();
      },
      restartStale: async (input: { provider: string; kind: string }) => {
        harness.calls.push(["restartStale", input]);
        return respond();
      },
    },
  };
});

import { AgentConnectSettingsPanel } from "./AgentConnectSettingsPanel";

function renderPanel() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <AgentConnectSettingsPanel />
    </QueryClientProvider>,
  );
}

beforeEach(() => harness.reset());

it("shows connected agents and folds the rest until asked", async () => {
  const screen = await renderPanel();
  await expect.element(screen.getByText("Claude Code", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Codex", { exact: true })).not.toBeInTheDocument();

  await screen.getByRole("button", { name: "Show 1 more" }).click();
  await expect.element(screen.getByText("Codex", { exact: true })).toBeVisible();
  await screen.unmount();
});

it("connects an agent from its row switch", async () => {
  const screen = await renderPanel();
  await screen.getByRole("button", { name: "Show 1 more" }).click();
  await screen.getByRole("switch", { name: "Connect Codex to the gateway" }).click();
  await expect
    .poll(() => harness.calls)
    .toContainEqual(["set", { provider: "codex", connected: true }]);
  await screen.unmount();
});

it("keeps the current model when disconnecting", async () => {
  const screen = await renderPanel();
  await screen.getByRole("switch", { name: "Connect Claude Code to the gateway" }).click();
  await expect
    .poll(() => harness.calls)
    .toContainEqual(["set", { provider: "claude", connected: false, model: "gpt-5" }]);
  await screen.unmount();
});

it("hides one of the agent's gateway models", async () => {
  const screen = await renderPanel();
  await screen.getByRole("button", { name: "All 2 models in its list" }).click();
  await expect.element(screen.getByText("Models Claude Code keeps")).toBeVisible();
  await screen.getByRole("switch", { name: "GPT-5" }).click();
  await screen.getByRole("button", { name: "Save", exact: true }).click();
  await expect
    .poll(() => harness.calls)
    .toContainEqual(["setModels", { provider: "claude", hidden: ["gpt-5"] }]);
  await screen.unmount();
});

it("moves an agent while arranging", async () => {
  const screen = await renderPanel();
  await screen.getByRole("button", { name: "Arrange" }).click();
  await screen.getByRole("button", { name: "Move Claude Code up" }).click();
  await expect
    .poll(() => harness.calls)
    .toContainEqual(["setLayout", { order: ["claude", "codex"], hidden: [] }]);
  await screen.unmount();
});

it("saves the current switches as a setup", async () => {
  const screen = await renderPanel();
  await screen.getByRole("button", { name: "Save current" }).click();
  await screen.getByPlaceholder("Setup name").fill("Work");
  await screen.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => harness.calls).toContainEqual(["saveProfile", "Work"]);
  await screen.unmount();
});
