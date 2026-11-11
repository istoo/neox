import AsyncStorage from "@react-native-async-storage/async-storage";

/** The body tabs a request's detail can show, in myna's order. */
export type HistoryBodyTab = "request" | "response" | "upstream" | "prompt" | "reply";

const STORAGE_KEY = "@neolix:gateway-history-view";
const TABS: readonly HistoryBodyTab[] = ["request", "response", "upstream", "prompt", "reply"];

export interface HistoryViewStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

/**
 * myna keeps the last view picked in the request detail in localStorage
 * (`myna.sseView`, gateway/client.js:860,1120-1122); on this app the
 * equivalent is the device's own storage, so the pick survives restarts.
 */
export function parseHistoryBodyTab(value: string | null | undefined): HistoryBodyTab {
  return TABS.find((tab) => tab === value) ?? "request";
}

export async function loadHistoryBodyTab(
  storage: HistoryViewStorage = AsyncStorage,
): Promise<HistoryBodyTab> {
  try {
    return parseHistoryBodyTab(await storage.getItem(STORAGE_KEY));
  } catch {
    return "request";
  }
}

export async function saveHistoryBodyTab(
  tab: HistoryBodyTab,
  storage: HistoryViewStorage = AsyncStorage,
): Promise<void> {
  try {
    await storage.setItem(STORAGE_KEY, tab);
  } catch {
    // Storage can be unavailable (private windows, cleared data); the tab still works.
  }
}
