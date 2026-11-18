import type { GatewayQuotaAccountWire, GatewayUsageReportWire } from "@neolix/protocol/gateway";
import {
  trayUsageData,
  trayUsageLabel,
  trayUsageTooltip,
  type TrayUsageFormat,
  type TrayUsagePresentationSettings,
} from "@neolix/protocol/tray-usage-model";
import { currentTrayLanguage, type TrayLanguage, type TrayUsageState } from "./tray-manager.js";
import { hasProviderMark, providerMarkDataUrl } from "./provider-marks.js";
import { trayUsageWords } from "./tray-usage-words.js";

/**
 * The menu bar's readings without a renderer (myna's watchTrayUsage, which
 * lives in the app process). A login launch opens no window, so the Electron
 * main process reads gateway.quota.get and the two usage reports itself; the
 * renderer keeps pushing its richer reading while it is up, and tray-manager
 * lets that win (tray-usage.tsx).
 */

export interface TrayUsagePollerSettings extends TrayUsagePresentationSettings {
  trayUsageEvery: number;
  trayWindows: Record<string, string[]>;
  trayNoBird: boolean;
  trayDisplayAs: "used" | "remaining";
  trayCurrency: "usd" | "cny";
  trayNumberUnits: "compact" | "wan";
  trayCnyPerUsd: number;
}

export interface TrayUsageDaemonTarget {
  url: string;
  /** Windows named pipes cannot ride in a WebSocket URL; `ws` takes the path instead. */
  socketPath?: string;
  credential: string | null;
}

/** The slice of DaemonClient the poller uses; tests pass a fake. */
export interface TrayUsageClient {
  getGatewayQuota(): Promise<{ quota: { accounts: GatewayQuotaAccountWire[] } }>;
  getGatewayUsage(query: {
    period: "today" | "7d";
    timezoneOffsetMinutes: number;
  }): Promise<{ report: GatewayUsageReportWire | null }>;
  close(): void | Promise<void>;
}

export interface TrayUsagePollerDeps {
  readSettings(): Promise<TrayUsagePollerSettings>;
  resolveTarget(): Promise<TrayUsageDaemonTarget | null>;
  createClient(target: TrayUsageDaemonTarget): TrayUsageClient;
  publish(state: TrayUsageState): void;
  getLanguage?(): TrayLanguage;
  now?(): number;
  setTimeout?(callback: () => void, delayMs: number): unknown;
  clearTimeout?(handle: unknown): void;
}

export interface TrayUsagePoller {
  /** Reads now instead of waiting for the next tick (settings just changed). */
  refresh(): void;
  stop(): void;
}

const MIN_POLL_MS = 20_000;
const FIRST_READ_RETRY_MS = 20_000;

export interface DaemonWebSocketTarget {
  url: string;
  /** Set for Windows named pipes; `ws` connects with it as a socket path. */
  socketPath?: string;
}

/**
 * The local daemon's WebSocket, from the listen address the CLI reports.
 * Mirrors protocol/host-target: `ws+unix:` carries POSIX sockets in the URL,
 * while a named pipe needs the path outside it — backslashes are not a valid
 * URL path.
 */
export function daemonWebSocketTarget(listen: string): DaemonWebSocketTarget | null {
  const trimmed = listen.trim();
  if (trimmed === "") {
    return null;
  }
  if (trimmed.startsWith("unix://")) {
    return { url: `ws+unix://${trimmed.slice("unix://".length)}:/ws` };
  }
  if (trimmed.startsWith("pipe://")) {
    return { url: "ws://localhost/ws", socketPath: trimmed.slice("pipe://".length) };
  }
  if (trimmed.startsWith("\\\\.\\pipe\\")) {
    return { url: "ws://localhost/ws", socketPath: trimmed };
  }
  if (trimmed.startsWith("/")) {
    return { url: `ws+unix://${trimmed}:/ws` };
  }
  try {
    const url = new URL(`ws://${trimmed}`);
    if (url.port === "" || (url.pathname !== "/" && url.pathname !== "")) {
      return null;
    }
    return { url: `ws://${url.hostname}:${url.port}/ws` };
  } catch {
    return null;
  }
}

function trayFormat(
  settings: TrayUsagePollerSettings,
  language: TrayLanguage,
  platform: NodeJS.Platform,
): TrayUsageFormat {
  return {
    locale: language,
    displayAs: settings.trayDisplayAs,
    currency: settings.trayCurrency,
    numberUnits: settings.trayNumberUnits,
    cnyPerUsd: settings.trayCnyPerUsd,
    // The Mac draws the mark only for the first segment, and only when Neolix's
    // own icon is off; every other card keeps its provider's name.
    showProviderName: (card) =>
      !(
        platform === "darwin" &&
        settings.trayNoBird &&
        !settings.trayNoLogos &&
        settings.trayUsages[0] === card.id &&
        hasProviderMark(card.provider)
      ),
  };
}

/** The first card's mark, when the menu bar's image slot is free for it. */
function trayLogo(
  cards: { id: string; provider: string }[],
  settings: TrayUsagePollerSettings,
  platform: NodeJS.Platform,
): string | null {
  if (platform !== "darwin" || !settings.trayNoBird || settings.trayNoLogos) {
    return null;
  }
  // Only when the menu bar's first segment is a card; a total has no mark.
  const firstId = settings.trayUsages[0];
  const card = cards.find((candidate) => candidate.id === firstId);
  return card === undefined ? null : providerMarkDataUrl(card.provider);
}

export async function readTrayUsageState(
  client: TrayUsageClient,
  settings: TrayUsagePollerSettings,
  language: TrayLanguage,
  now: number,
  platform: NodeJS.Platform = process.platform,
): Promise<TrayUsageState> {
  if (settings.trayUsages.length === 0) {
    return { label: "", tooltip: "Neox", logoDataUrl: null };
  }
  const timezoneOffsetMinutes = -new Date(now).getTimezoneOffset();
  const [quota, today, week] = await Promise.all([
    client.getGatewayQuota(),
    client.getGatewayUsage({ period: "today", timezoneOffsetMinutes }),
    client.getGatewayUsage({ period: "7d", timezoneOffsetMinutes }),
  ]);
  const data = trayUsageData(settings, quota.quota.accounts, {
    today: today.report,
    week: week.report,
  });
  const format = trayFormat(settings, language, platform);
  const label = trayUsageLabel(data, settings, format);
  const tooltip = trayUsageTooltip(data, settings, format, trayUsageWords(language), now);
  return { label, tooltip, logoDataUrl: trayLogo(data.cards, settings, platform) };
}

/**
 * Polls every `trayUsageEvery` minutes, starting at once. A failed read
 * leaves the last reading up and tries again on the next tick, sooner while
 * there has never been a reading (myna's 20s first-answer retry).
 */
export function startTrayUsagePolling(deps: TrayUsagePollerDeps): TrayUsagePoller {
  const schedule = deps.setTimeout ?? ((callback, ms) => setTimeout(callback, ms));
  const cancel = deps.clearTimeout ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
  const now = deps.now ?? Date.now;
  const getLanguage = deps.getLanguage ?? currentTrayLanguage;

  let stopped = false;
  let running = false;
  let rerun = false;
  let timer: unknown = null;
  let published = false;
  let client: TrayUsageClient | null = null;
  let clientKey = "";

  function disposeClient(): void {
    const current = client;
    client = null;
    clientKey = "";
    void Promise.resolve(current?.close()).catch(() => undefined);
  }

  function scheduleNext(delayMs: number): void {
    if (stopped) {
      return;
    }
    if (timer !== null) {
      cancel(timer);
    }
    timer = schedule(() => {
      timer = null;
      void tick();
    }, delayMs);
  }

  async function tick(): Promise<void> {
    if (stopped) {
      return;
    }
    if (running) {
      rerun = true;
      return;
    }
    running = true;
    let intervalMs = MIN_POLL_MS;
    try {
      const settings = await deps.readSettings();
      intervalMs = Math.max(MIN_POLL_MS, settings.trayUsageEvery * 60_000);
      const target = await deps.resolveTarget();
      if (target !== null && settings.trayUsages.length > 0) {
        const key = `${target.url}\n${target.socketPath ?? ""}\n${target.credential ?? ""}`;
        if (client === null || clientKey !== key) {
          disposeClient();
          client = deps.createClient(target);
          clientKey = key;
        }
        const state = await readTrayUsageState(client, settings, getLanguage(), now());
        if (!stopped) {
          deps.publish(state);
          published = true;
        }
      } else if (settings.trayUsages.length === 0) {
        if (!stopped) {
          deps.publish({ label: "", tooltip: "Neox", logoDataUrl: null });
        }
      }
    } catch {
      // The daemon may be starting, restarting, or gone; the last reading
      // stays and the next tick tries again.
      disposeClient();
    } finally {
      running = false;
      const delay =
        !published && intervalMs > FIRST_READ_RETRY_MS ? FIRST_READ_RETRY_MS : intervalMs;
      if (rerun) {
        rerun = false;
        scheduleNext(0);
      } else {
        scheduleNext(delay);
      }
    }
  }

  void tick();

  return {
    refresh: () => {
      if (stopped) {
        return;
      }
      if (running) {
        rerun = true;
        return;
      }
      scheduleNext(0);
    },
    stop: () => {
      stopped = true;
      if (timer !== null) {
        cancel(timer);
        timer = null;
      }
      disposeClient();
    },
  };
}
