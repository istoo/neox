import "../../../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import type { GatewayConfig, GatewayRouteHistoryRow } from "~/lib/gatewayTypes";

const harness = vi.hoisted(() => ({
  routes: [] as GatewayRouteHistoryRow[],
  getRoutingHistory: vi.fn(),
  heldList: vi.fn(),
  getTrace: vi.fn(),
}));

vi.mock("~/hooks/useHostFeatures", () => ({
  useHostFeatures: () => ({
    features: {},
    isLoading: false,
    error: null,
    featureStatus: () => "available",
    isAvailable: () => true,
  }),
}));

vi.mock("~/hooks/useBuiltinFeatures", () => ({
  useBuiltinFeatures: () => ({
    isEnabled: () => true,
    isLoading: false,
    setEnabled: vi.fn(),
  }),
}));

vi.mock("~/lib/neolixGatewayApi", () => ({
  neolixGatewayApi: {
    getRoutingHistory: harness.getRoutingHistory,
    getTrace: harness.getTrace,
    heldList: harness.heldList,
  },
}));

import { GatewayRoutingPane } from "./GatewayRoutingPane";

const config: GatewayConfig = { version: 1, enabled: true, providers: [], groups: [] };

function pane() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return (
    <QueryClientProvider client={client}>
      <GatewayRoutingPane config={config} edit={() => undefined} apply={async () => undefined} />
    </QueryClientProvider>
  );
}

function row(overrides: Partial<GatewayRouteHistoryRow> = {}): GatewayRouteHistoryRow {
  return {
    id: "call-1",
    time: "2026-11-18T10:00:00.000Z",
    asked: "sweep-model",
    served: "fake/sweep-model",
    model: "fake/sweep-model",
    status: 200,
    millis: 12,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  harness.routes = [];
  harness.getRoutingHistory.mockImplementation(async () => ({
    days: ["2026-11-18"],
    day: "2026-11-18",
    routes: harness.routes,
  }));
  harness.heldList.mockResolvedValue({ names: [] });
  harness.getTrace.mockResolvedValue({
    routes: [],
    stats: { requests: 0, active: 0, rerouted: 0, errors: 0 },
  });
});

describe("gateway routing history rows", () => {
  it("badges a try with its provider and status", async () => {
    harness.routes = [
      row({ tries: [{ provider: "fake", model: "sweep-model", status: 200, millis: 12 }] }),
    ];
    await render(pane());

    await expect.element(page.getByText("fake 200", { exact: true })).toBeVisible();
  });

  it("badges a failed try in the error tone", async () => {
    harness.routes = [
      row({
        status: 500,
        tries: [
          { provider: "fake", model: "sweep-model", status: 500, millis: 8, error: "HTTP 500" },
        ],
      }),
    ];
    await render(pane());

    const badge = page.getByText("fake 500", { exact: true });
    await expect.element(badge).toBeVisible();
    expect(badge.element().className).toContain("text-destructive");
  });

  it("leaves the provider out of a try that has none instead of drawing a question mark", async () => {
    // Records written before tries named their provider have only the seat's
    // `provider/model` in `model`.
    harness.routes = [row({ tries: [{ model: "fake/sweep-model", status: 200, millis: 12 }] })];
    await render(pane());

    await expect.element(page.getByText("200", { exact: true })).toBeVisible();
    await expect.element(page.getByText("? 200", { exact: true })).not.toBeInTheDocument();
  });
});
