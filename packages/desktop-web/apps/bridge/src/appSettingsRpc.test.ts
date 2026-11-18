import { NEOLIX_APP_SETTINGS_WS_METHODS } from "@synara/contracts";
import { Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { makeAppSettingsHandlers } from "./appSettingsRpc.ts";
import type { BridgeModel } from "./model.ts";
import type { AnyHandler } from "./stubs.ts";

function run<A>(handler: AnyHandler | undefined, payload: unknown = {}): Promise<A> {
  if (!handler) throw new Error("handler is missing");
  return Effect.runPromise(handler(payload, {}) as Effect.Effect<A, never>);
}

function harness(options: { sync?: boolean; copy?: unknown } = {}) {
  const calls: Array<[string, unknown]> = [];
  const rawListeners = new Set<(message: unknown) => void>();
  const client = {
    getLastServerInfoMessage: () => ({ features: { sync: options.sync ?? true } }),
    getSyncAppSettings: async () => {
      calls.push(["getSyncAppSettings", undefined]);
      return (
        options.copy ?? {
          settings: { language: "zh-CN", chatFontSizePx: 15 },
          patchedAt: { language: "2026-11-01T00:00:00.000Z" },
        }
      );
    },
    exportSyncAppSettings: async (settings: unknown) => {
      calls.push(["exportSyncAppSettings", settings]);
      return { requestId: "r", error: undefined };
    },
    subscribeRawMessages: (listener: (message: unknown) => void) => {
      rawListeners.add(listener);
      return () => rawListeners.delete(listener);
    },
  };
  return {
    calls,
    rawListeners,
    handlers: makeAppSettingsHandlers({ client } as unknown as BridgeModel),
  };
}

describe("makeAppSettingsHandlers", () => {
  it("reads the daemon's copy and per-key patch times", async () => {
    const { handlers, calls } = harness();
    const result = await run(handlers[NEOLIX_APP_SETTINGS_WS_METHODS.get]);
    expect(calls).toEqual([["getSyncAppSettings", undefined]]);
    expect(result).toEqual({
      settings: { language: "zh-CN", chatFontSizePx: 15 },
      patchedAt: { language: "2026-11-01T00:00:00.000Z" },
      supportsSync: true,
    });
  });

  it("reports an unsupported host without asking the daemon", async () => {
    const { handlers, calls } = harness({ sync: false });
    const result = await run(handlers[NEOLIX_APP_SETTINGS_WS_METHODS.get]);
    expect(calls).toEqual([]);
    expect(result).toEqual({ settings: null, supportsSync: false });
  });

  it("exports the merged settings", async () => {
    const { handlers, calls } = harness();
    const result = await run(handlers[NEOLIX_APP_SETTINGS_WS_METHODS.export], {
      settings: { language: "en" },
    });
    expect(calls).toEqual([["exportSyncAppSettings", { language: "en" }]]);
    expect(result).toEqual({ saved: true });
  });

  it("does not export to a host without the sync surface", async () => {
    const { handlers, calls } = harness({ sync: false });
    const result = await run(handlers[NEOLIX_APP_SETTINGS_WS_METHODS.export], {
      settings: { language: "en" },
    });
    expect(calls).toEqual([]);
    expect(result).toEqual({ saved: false });
  });

  it("relays only sync apply messages", async () => {
    const { handlers, rawListeners } = harness();
    const handler = handlers[NEOLIX_APP_SETTINGS_WS_METHODS.subscribe];
    if (!handler) throw new Error("handler is missing");
    const stream = (handler as () => Stream.Stream<unknown>)().pipe(Stream.take(1));
    const collected = Effect.runPromise(Stream.runCollect(stream));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(rawListeners.size).toBe(1);
    for (const listener of rawListeners) {
      listener({ type: "agent_update", payload: {} });
      listener({
        type: "sync.app_settings.apply",
        payload: { settings: { language: "zh-CN" } },
      });
    }
    expect(Array.from(await collected)).toEqual([{ settings: { language: "zh-CN" } }]);
  });
});
