import "../../../index.css";

import type { NeolixSyncUsage } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import type { ReactNode } from "react";

const harness = vi.hoisted(() => ({
  feature: "available" as "available" | "unavailable" | "unknown",
  getSyncUsage: vi.fn(),
}));

vi.mock("~/hooks/useHostFeatures", () => ({
  useHostFeatures: () => ({
    features: { sync: harness.feature === "available" },
    isLoading: false,
    error: null,
    featureStatus: () => harness.feature,
    isAvailable: () => harness.feature === "available",
  }),
}));

vi.mock("~/lib/neolixHostApi", () => ({ getSyncUsage: harness.getSyncUsage }));

import { GatewaySyncUsageSection } from "./GatewaySyncUsageSection";

function wrap(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return <QueryClientProvider client={client}>{node}</QueryClientProvider>;
}

function sharedUsage(overrides: Partial<NeolixSyncUsage> = {}): NeolixSyncUsage {
  const totals = {
    errors: 0,
    cache_read: 0,
    cache_write: 0,
    reasoning: 0,
    unpriced: 0,
  };
  return {
    devices: [],
    quotas: [],
    calls: 3,
    input: 150,
    output: 75,
    cost: 0.2,
    series: [
      {
        label: "8/17",
        time: "2026-08-17",
        ...totals,
        calls: 3,
        input: 150,
        output: 75,
        cost: 0.2,
      },
    ],
    computers: [
      { ...totals, id: "this", name: "", calls: 1, input: 50, output: 25, cost: 0.05 },
      { ...totals, id: "studio", name: "Studio", calls: 2, input: 100, output: 50, cost: 0.15 },
    ],
    quotaHistory: [
      {
        provider: "claude",
        user: "work@example.com",
        lines: [
          {
            name: "allowance",
            points: [
              { at: "2026-08-17T08:00:00.000Z", left: 80 },
              { at: "2026-08-17T12:00:00.000Z", left: 64 },
            ],
          },
        ],
      },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  harness.feature = "available";
  harness.getSyncUsage.mockReset();
});

describe("gateway sync usage", () => {
  it("lists devices, recent calls and merged quota history", async () => {
    harness.getSyncUsage.mockResolvedValue(sharedUsage());
    await render(wrap(<GatewaySyncUsageSection refreshMs={0} />));

    await expect.element(page.getByText("Studio")).toBeVisible();
    await expect.element(page.getByText("This computer")).toBeVisible();
    await expect.element(page.getByText("Quota history")).toBeVisible();
    await expect.element(page.getByText("64% left")).toBeVisible();
  });

  it("explains when no computer has shared usage yet", async () => {
    harness.getSyncUsage.mockResolvedValue(sharedUsage({ computers: undefined, quotaHistory: [] }));
    await render(wrap(<GatewaySyncUsageSection refreshMs={0} />));

    await expect.element(page.getByText(/No other computer has shared usage yet/)).toBeVisible();
  });

  it("shows the host update notice instead of the data on an older host", async () => {
    harness.feature = "unavailable";
    await render(wrap(<GatewaySyncUsageSection refreshMs={0} />));

    await expect.element(page.getByTestId("host-update-notice")).toBeVisible();
    expect(harness.getSyncUsage).not.toHaveBeenCalled();
  });

  it("shows the daemon's error with a retry action", async () => {
    harness.getSyncUsage.mockRejectedValue(new Error("sync password is not set"));
    await render(wrap(<GatewaySyncUsageSection refreshMs={0} />));

    await expect.element(page.getByText("sync password is not set")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Try again" })).toBeEnabled();
  });
});
