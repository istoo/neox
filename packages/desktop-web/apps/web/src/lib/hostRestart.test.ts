import { describe, expect, it, vi } from "vitest";

import { isDaemonReconnectFailure, restartHostAndAwaitReplacement } from "./hostRestart";

describe("restartHostAndAwaitReplacement", () => {
  it("waits for a different pid of the same daemon", async () => {
    const statuses = [
      { serverId: "srv", pid: 1, version: "1.0.0" },
      { serverId: "srv", pid: 1, version: "1.0.0" },
      { serverId: "srv", pid: 2, version: "1.1.0" },
    ];
    let index = 0;
    const result = await restartHostAndAwaitReplacement({
      getStatus: async () => statuses[Math.min(index++, statuses.length - 1)]!,
      restart: async () => undefined,
      sleep: async () => undefined,
      now: (() => {
        let time = 0;
        return () => (time += 10);
      })(),
    });
    expect(result.pid).toBe(2);
    expect(result.version).toBe("1.1.0");
  });

  it("survives the connection dropping while the daemon restarts", async () => {
    let pid = 4;
    const getStatus = vi
      .fn()
      .mockResolvedValueOnce({ serverId: "srv", pid, version: "1.0.0" })
      .mockRejectedValueOnce(
        Object.assign(new Error("WebSocket transport reconnect"), {
          code: "DAEMON_CONNECTION_LOST",
        }),
      )
      .mockImplementation(async () => ({ serverId: "srv", pid: (pid += 1), version: "1.1.0" }));
    const result = await restartHostAndAwaitReplacement({
      getStatus,
      restart: async () => undefined,
      sleep: async () => undefined,
      now: (() => {
        let time = 0;
        return () => (time += 10);
      })(),
    });
    expect(result.pid).toBe(5);
  });

  it("rejects a daemon whose identity changed", async () => {
    const getStatus = vi
      .fn()
      .mockResolvedValueOnce({ serverId: "srv-a", pid: 1, version: "1.0.0" })
      .mockResolvedValue({ serverId: "srv-b", pid: 2, version: "1.1.0" });
    await expect(
      restartHostAndAwaitReplacement({
        getStatus,
        restart: async () => undefined,
        sleep: async () => undefined,
        now: (() => {
          let time = 0;
          return () => (time += 10);
        })(),
        deadlineMs: 100,
      }),
    ).rejects.toThrow("identity changed");
  });

  it("reports a timeout when no replacement appears", async () => {
    await expect(
      restartHostAndAwaitReplacement({
        getStatus: async () => ({ serverId: "srv", pid: 1, version: "1.0.0" }),
        restart: async () => undefined,
        sleep: async () => undefined,
        now: (() => {
          let time = 0;
          return () => (time += 100);
        })(),
        deadlineMs: 250,
      }),
    ).rejects.toThrow("did not appear");
  });
});

describe("isDaemonReconnectFailure", () => {
  it("recognizes the bridge's error code and wording", () => {
    expect(isDaemonReconnectFailure({ code: "DAEMON_REQUEST_TIMEOUT" })).toBe(true);
    expect(isDaemonReconnectFailure(new Error("WebSocket closed during restart"))).toBe(true);
    expect(isDaemonReconnectFailure(new Error("Permission denied"))).toBe(false);
  });
});
