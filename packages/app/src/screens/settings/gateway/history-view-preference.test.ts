import { describe, expect, test } from "vitest";
import {
  loadHistoryBodyTab,
  parseHistoryBodyTab,
  saveHistoryBodyTab,
  type HistoryViewStorage,
} from "./history-view-preference";

function memoryStorage(initial: Record<string, string> = {}): HistoryViewStorage & {
  items: Map<string, string>;
} {
  const items = new Map(Object.entries(initial));
  return {
    items,
    getItem: async (key) => items.get(key) ?? null,
    setItem: async (key, value) => {
      items.set(key, value);
    },
  };
}

describe("history view preference", () => {
  test("an unknown or missing value opens the request body", () => {
    expect(parseHistoryBodyTab(null)).toBe("request");
    expect(parseHistoryBodyTab("")).toBe("request");
    expect(parseHistoryBodyTab("events")).toBe("request");
  });

  test("a kept tab is read back", async () => {
    const storage = memoryStorage({ "@neolix:gateway-history-view": "reply" });
    await expect(loadHistoryBodyTab(storage)).resolves.toBe("reply");
  });

  test("saving keeps the tab under the app's storage key", async () => {
    const storage = memoryStorage();
    await saveHistoryBodyTab("upstream", storage);
    expect(storage.items.get("@neolix:gateway-history-view")).toBe("upstream");
  });

  test("unreadable storage falls back to the request body", async () => {
    const storage: HistoryViewStorage = {
      getItem: async () => {
        throw new Error("storage unavailable");
      },
      setItem: async () => {
        throw new Error("storage unavailable");
      },
    };
    await expect(loadHistoryBodyTab(storage)).resolves.toBe("request");
    await expect(saveHistoryBodyTab("reply", storage)).resolves.toBeUndefined();
  });
});
