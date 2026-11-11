import { describe, expect, test } from "vitest";
import {
  loadSseView,
  resolveSseView,
  saveSseView,
  type SseViewStorage,
} from "./sse-view-preference";

function memoryStorage(initial: string | null = null): SseViewStorage & { value: string | null } {
  const box = {
    value: initial,
    getItem: async () => box.value,
    setItem: async (value: string) => {
      box.value = value;
    },
  };
  return box;
}

describe("SSE view preference", () => {
  test("defaults to events, as myna does", () => {
    expect(resolveSseView(null, true)).toBe("events");
    expect(resolveSseView("", true)).toBe("events");
    expect(resolveSseView("compact", true)).toBe("events");
  });

  test("keeps raw and reply when they are offered", () => {
    expect(resolveSseView("raw", true)).toBe("raw");
    expect(resolveSseView("reply", true)).toBe("reply");
    expect(resolveSseView("reply", false)).toBe("events");
  });

  test("a kept view is read back and a pick is saved", async () => {
    const storage = memoryStorage("raw");
    await expect(loadSseView(true, storage)).resolves.toBe("raw");
    await saveSseView("reply", storage);
    expect(storage.value).toBe("reply");
  });

  test("unreadable storage opens events", async () => {
    const storage: SseViewStorage = {
      getItem: async () => {
        throw new Error("storage unavailable");
      },
      setItem: async () => {
        throw new Error("storage unavailable");
      },
    };
    await expect(loadSseView(true, storage)).resolves.toBe("events");
    await expect(saveSseView("raw", storage)).resolves.toBeUndefined();
  });
});
