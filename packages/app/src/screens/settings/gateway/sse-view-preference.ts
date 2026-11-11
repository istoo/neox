import AsyncStorage from "@react-native-async-storage/async-storage";
import { isWeb } from "@/constants/platform";

/** The three readings of a streamed response, as myna names them. */
export type SseView = "reply" | "events" | "raw";

/**
 * myna keeps the pick in localStorage under `myna.sseView`
 * (gateway/client.js:860,1120-1122). Here the browser page uses localStorage
 * directly; a native window uses AsyncStorage, which is this app's store.
 */
const WEB_KEY = "neolix.sseView";
const NATIVE_KEY = "@neolix:sse-view";

export interface SseViewStorage {
  getItem(): Promise<string | null>;
  setItem(value: string): Promise<void>;
}

function webStorage(): Storage | null {
  if (!isWeb) {
    return null;
  }
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

const defaultStorage: SseViewStorage = {
  getItem: async () => {
    const web = webStorage();
    if (web !== null) {
      return web.getItem(WEB_KEY);
    }
    return AsyncStorage.getItem(NATIVE_KEY);
  },
  setItem: async (value) => {
    const web = webStorage();
    if (web !== null) {
      web.setItem(WEB_KEY, value);
      return;
    }
    await AsyncStorage.setItem(NATIVE_KEY, value);
  },
};

/**
 * The view to open: the kept one when it is still offered, else Events. myna
 * drops Reply for a stream that spells no reply.
 */
export function resolveSseView(saved: string | null | undefined, hasReply: boolean): SseView {
  if (saved === "reply" && hasReply) {
    return "reply";
  }
  if (saved === "events" || saved === "raw") {
    return saved;
  }
  return "events";
}

/**
 * The kept view when it can be read without waiting: myna's localStorage read
 * is synchronous, so the first draw already shows the last pick. A native
 * window has no synchronous store and starts on Events until loadSseView.
 */
export function initialSseView(hasReply: boolean): SseView {
  const web = webStorage();
  if (web === null) {
    return "events";
  }
  try {
    return resolveSseView(web.getItem(WEB_KEY), hasReply);
  } catch {
    return "events";
  }
}

export async function loadSseView(
  hasReply: boolean,
  storage: SseViewStorage = defaultStorage,
): Promise<SseView> {
  try {
    return resolveSseView(await storage.getItem(), hasReply);
  } catch {
    return "events";
  }
}

export async function saveSseView(
  view: SseView,
  storage: SseViewStorage = defaultStorage,
): Promise<void> {
  try {
    await storage.setItem(view);
  } catch {
    // Storage can be unavailable (private windows, cleared data); the view still works.
  }
}
