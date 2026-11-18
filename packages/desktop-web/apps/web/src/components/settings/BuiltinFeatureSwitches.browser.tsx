import "../../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const harness = vi.hoisted(() => {
  const state: {
    config: Record<string, unknown>;
    gateway: Record<string, unknown>;
    patches: Array<Record<string, unknown>>;
  } = { config: {}, gateway: {}, patches: [] };
  return {
    state,
    reset() {
      state.config = {};
      state.gateway = {};
      state.patches = [];
    },
  };
});

vi.mock("~/lib/neolixHostApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/neolixHostApi")>()),
  getHostConfig: async () => ({ config: harness.state.config }),
  patchHostConfig: async (patch: Record<string, unknown>) => {
    harness.state.patches.push(patch);
    harness.state.config = { ...harness.state.config, ...patch };
    return { config: harness.state.config };
  },
}));

vi.mock("~/lib/neolixGatewayApi", async (importOriginal) => {
  const original = await importOriginal<typeof import("~/lib/neolixGatewayApi")>();
  return {
    ...original,
    neolixGatewayApi: {
      ...original.neolixGatewayApi,
      getConfig: async () => ({ config: harness.state.gateway }),
    },
  };
});

import { BuiltinFeatureSwitches } from "./BuiltinFeatureSwitches";

function renderSwitches() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <BuiltinFeatureSwitches />
    </QueryClientProvider>,
  );
}

beforeEach(() => harness.reset());

it("turns a feature off through the daemon config", async () => {
  const screen = await renderSwitches();
  const sessions = screen.getByRole("switch", { name: "Sessions" });
  await expect.element(sessions).toBeChecked();

  await sessions.click();

  await expect
    .poll(() => harness.state.patches)
    .toEqual([{ builtinFeatures: { sessions: false } }]);
  await expect.element(sessions).not.toBeChecked();
  await screen.unmount();
});

it("keeps an in-use feature on and says how much is in use", async () => {
  harness.state.gateway = { recording: { enabled: true } };
  const screen = await renderSwitches();
  const sessions = screen.getByRole("switch", { name: "Sessions" });

  await expect.element(screen.getByText("1 in use")).toBeVisible();
  await expect.element(sessions).toBeChecked();
  await expect.element(sessions).toBeDisabled();

  await sessions.click({ force: true });
  await expect.poll(() => harness.state.patches).toEqual([]);
  await screen.unmount();
});

it("changes how many recent gateway calls the page shows", async () => {
  harness.state.config = { builtinFeatureConfig: { gateway: { callsPage: 20 } } };
  const screen = await renderSwitches();

  await screen.getByRole("button", { name: "50" }).click();

  await expect
    .poll(() => harness.state.patches)
    .toEqual([{ builtinFeatureConfig: { gateway: { callsPage: 50 } } }]);
  await screen.unmount();
});
