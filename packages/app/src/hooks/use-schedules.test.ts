// @vitest-environment jsdom
import React from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  hosts: [{ serverId: "host-a", label: "主机 A" }],
  schedule: {
    id: "task-a",
    name: "验收任务",
    prompt: "验收",
    target: { type: "new-agent" as const, config: { provider: "claude" as const, cwd: "/repo" } },
    cadence: { type: "cron" as const, expression: "0 * * * *" },
    status: "active" as "active" | "paused" | "completed",
    createdAt: "2026-11-07T00:00:00Z",
    updatedAt: "2026-11-07T00:00:00Z",
    nextRunAt: "2026-11-07T01:00:00Z",
    lastRunAt: null,
    pausedAt: null,
    expiresAt: null,
    maxRuns: 1,
  },
}));
vi.mock("@/runtime/host-runtime", () => ({
  useHosts: () => state.hosts,
  useHostRuntimeConnectionStatuses: () => new Map([["host-a", "online"]]),
  getHostRuntimeStore: () => ({
    getSnapshot: () => ({ connectionStatus: "online" }),
    getClient: () => ({ scheduleList: async () => ({ schedules: [state.schedule], error: null }) }),
  }),
}));

import { schedulesQueryKey, useSchedules } from "@/hooks/use-schedules";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("schedulesQueryKey", () => {
  it("uses only the sorted host identity", () => {
    expect(schedulesQueryKey(["laptop", "local"])).toEqual(["schedules", "laptop|local"]);
    expect(schedulesQueryKey(["local", "laptop"])).toEqual(["schedules", "laptop|local"]);
  });

  it("后台完成任务后自动刷新状态，不依赖用户重新进入页面", async () => {
    vi.useFakeTimers();
    state.schedule.status = "active";
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(QueryClientProvider, { client: queryClient }, children);
    const { result, unmount } = renderHook(useSchedules, { wrapper });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(result.current.loadState).toMatchObject({
      status: "loaded",
      data: [{ status: "active" }],
    });

    state.schedule.status = "completed";
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_050);
    });
    expect(result.current.loadState).toMatchObject({
      status: "loaded",
      data: [{ status: "completed" }],
    });
    unmount();
    queryClient.clear();
  });
});
