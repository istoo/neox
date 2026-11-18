// FILE: transportPlatform.ts
// Purpose: The host-specific edges of WsTransport, injected so the transport
//   itself stays React- and DOM-free. The default implementation reads browser
//   globals structurally, which also lets node tests drive the real transport
//   against a global WebSocket shim.
// Layer: Client runtime platform binding

import { trackWsTurnSettlement } from "./wsTransportEvents";
import {
  ORCHESTRATION_WS_METHODS,
  WS_METHODS,
  type DesktopDiagnosticActivity,
  type DesktopDiagnosticBreadcrumb,
  type OrchestrationEvent,
  type ProductAnalyticsInput,
  type ProductAnalyticsMode,
  type ThreadId,
} from "@synara/contracts";

export interface TransportTimers {
  setTimeout(handler: () => void, ms: number): number;
  clearTimeout(handle: number): void;
}

export interface TurnObserver {
  observe(event: OrchestrationEvent, mode: ProductAnalyticsMode): void;
}

export interface TransportAnalytics {
  /** Fixed diagnostic category for an RPC, or undefined when diagnostics are off. */
  rendererRpcActivity(method: string, params: unknown): DesktopDiagnosticActivity | undefined;
  recordRendererActivity(
    activity: DesktopDiagnosticActivity,
    phase: DesktopDiagnosticBreadcrumb["phase"],
  ): void;
  /** Analytics event classified from an RPC, independent of its outcome. */
  productRpcActivity(
    method: string,
    params: unknown,
  ): Pick<ProductAnalyticsInput, "event" | "feature"> | undefined;
  track(input: ProductAnalyticsInput): void;
  createTurnObserver(): TurnObserver;
}

export interface TransportPlatform {
  readonly timers: TransportTimers;
  /** Raw WebSocket origin for this host: bridge URL, env override, or page origin. */
  resolveSocketBase(explicitUrl: string | null): string;
  readonly appVersion: string;
  localizeRpcError<T>(error: T): T;
  /**
   * One RPC observation for diagnostics and analytics. `started` is emitted
   * before the request; `succeeded`/`failed` after it settles.
   */
  onRpcActivity(event: RpcActivityEvent): void;
  readonly analytics: TransportAnalytics;
  /** Retains pending UI state for an uncertain turn until its verdict arrives. */
  trackTurnSettlement(threadId: ThreadId): () => void;
}

export interface RpcActivityEvent {
  readonly method: string;
  readonly params: unknown;
  readonly phase: "started" | "succeeded" | "failed";
  readonly mode: ProductAnalyticsMode;
  readonly startedAt: number;
  readonly cancelled?: boolean;
  /** The RPC failure, when the outcome is `failed`. */
  readonly error?: unknown;
  /** Analytics reason for a failed request, matching the renderer's vocabulary. */
  readonly failureReason?: "timeout" | "unreachable" | "other";
}

interface BridgeLike {
  betaDiagnostics?: {
    recordActivity?: (input: {
      activity: DesktopDiagnosticActivity;
      phase: DesktopDiagnosticBreadcrumb["phase"];
    }) => void;
    recordActivityInput?: (input: {
      activity: DesktopDiagnosticActivity;
      phase: DesktopDiagnosticBreadcrumb["phase"];
    }) => void;
  };
  productAnalytics?: {
    track?: (input: ProductAnalyticsInput) => void;
  };
  getWsUrl?: () => string | undefined;
}

interface WindowLike {
  location?: { protocol?: string; hostname?: string; port?: string };
  desktopBridge?: BridgeLike;
  setTimeout?: (handler: () => void, ms: number) => number;
  clearTimeout?: (handle: number) => void;
}

function windowLike(): WindowLike | undefined {
  return (globalThis as { window?: WindowLike }).window;
}

function bridge(): BridgeLike | undefined {
  return windowLike()?.desktopBridge;
}

function envValue(name: string): string | undefined {
  const env = (import.meta as unknown as { env?: Record<string, unknown> }).env;
  const value = env?.[name];
  return typeof value === "string" ? value : undefined;
}

/** The same fixed categories the renderer diagnostics bridge accepts. */
export function browserRendererRpcActivity(
  method: string,
  params: unknown,
): DesktopDiagnosticActivity | undefined {
  try {
    const diagnostics = bridge()?.betaDiagnostics;
    if (!diagnostics?.recordActivity && !diagnostics?.recordActivityInput) return;
    switch (method) {
      case ORCHESTRATION_WS_METHODS.getThreadDetailSnapshot:
        return "chat.open";
      case ORCHESTRATION_WS_METHODS.importThread:
      case ORCHESTRATION_WS_METHODS.importProject:
        return "project.import";
      case ORCHESTRATION_WS_METHODS.listProjectImports:
        return "project.import.catalog";
      case ORCHESTRATION_WS_METHODS.loadProjectImportHistory:
        return "project.import.preview";
      case ORCHESTRATION_WS_METHODS.reconcileProviderDelivery:
        return "chat.unblock";
      case WS_METHODS.projectsSearchEntries:
      case WS_METHODS.projectsSearchLocalEntries:
      case WS_METHODS.projectsSearchContent:
        return "workspace.search";
      case WS_METHODS.projectsReadFile:
        return "workspace.read";
      case ORCHESTRATION_WS_METHODS.dispatchCommand: {
        const command = (params as { command?: { type?: unknown } } | undefined)?.command;
        switch (command?.type) {
          case "thread.turn.start":
            return "chat.send";
          case "thread.turn.interrupt":
            return "chat.stop";
          case "thread.meta.update":
            return "workspace.change";
          case "project.create":
            return "project.create";
        }
      }
    }
  } catch {
    // Malformed input and unavailable bridges must not affect RPC behavior.
  }
}

export function browserRecordRendererActivity(
  activity: DesktopDiagnosticActivity,
  phase: DesktopDiagnosticBreadcrumb["phase"],
): void {
  try {
    const diagnostics = bridge()?.betaDiagnostics;
    diagnostics?.recordActivity?.({ activity, phase });
    diagnostics?.recordActivityInput?.({ activity, phase });
  } catch {
    // Diagnostics must never affect the action being observed.
  }
}

/** Mirrors the web's product-intent classifier without touching page state. */
export function browserProductRpcActivity(
  method: string,
  params: unknown,
): Pick<ProductAnalyticsInput, "event" | "feature"> | undefined {
  try {
    if (!bridge()?.productAnalytics?.track) return;
    if (method === WS_METHODS.hostsRemoteAccess) {
      if (
        (params as { request?: { operation?: unknown } } | undefined)?.request?.operation === "pair"
      )
        return { event: "connection.pair" };
      return;
    }
    if (method === WS_METHODS.hostsConfirmSyncKey) return { event: "connection.pair" };
    if (method !== ORCHESTRATION_WS_METHODS.dispatchCommand) return;
    const type = (params as { command?: { type?: unknown } } | undefined)?.command?.type;
    if (type === "thread.turn.start") return { event: "chat.request" };
    if (type === "project.create") return { event: "feature.used", feature: "project" };
  } catch {
    // Malformed inputs are still handled by the normal RPC boundary.
  }
}

function browserTrackAnalytics(input: ProductAnalyticsInput): void {
  try {
    bridge()?.productAnalytics?.track?.(input);
  } catch {
    // Analytics never changes the operation it observes.
  }
}

const NOOP_TURN_OBSERVER: TurnObserver = { observe: () => undefined };

export const browserTransportAnalytics: TransportAnalytics = {
  rendererRpcActivity: browserRendererRpcActivity,
  recordRendererActivity: browserRecordRendererActivity,
  productRpcActivity: browserProductRpcActivity,
  track: browserTrackAnalytics,
  createTurnObserver: () => NOOP_TURN_OBSERVER,
};

/**
 * Default platform for node tests and browser frames that inject nothing: the
 * same structural globals the renderer exposes, with no UI imports.
 */
export const browserTransportPlatform: TransportPlatform = {
  timers: {
    setTimeout: (handler, ms) => globalThis.setTimeout(handler, ms) as unknown as number,
    clearTimeout: (handle) =>
      globalThis.clearTimeout(handle as unknown as Parameters<typeof globalThis.clearTimeout>[0]),
  },
  resolveSocketBase: (explicitUrl) => {
    if (explicitUrl) return explicitUrl;
    const win = windowLike();
    const bridgeUrl = win?.desktopBridge?.getWsUrl?.();
    const envUrl = envValue("VITE_WS_URL");
    return bridgeUrl && bridgeUrl.length > 0
      ? bridgeUrl
      : envUrl && envUrl.length > 0
        ? envUrl
        : `${win?.location?.protocol === "https:" ? "wss" : "ws"}://${win?.location?.hostname ?? "localhost"}:${win?.location?.port ?? ""}`;
  },
  appVersion: envValue("APP_VERSION") ?? "0.0.0",
  localizeRpcError: (error) => error,
  onRpcActivity: (event) => {
    const activity = browserRendererRpcActivity(event.method, event.params);
    if (activity && event.phase !== "started") {
      browserRecordRendererActivity(activity, event.phase);
    } else if (activity) {
      browserRecordRendererActivity(activity, "started");
    }
    const productActivity = browserProductRpcActivity(event.method, event.params);
    if (!productActivity) return;
    if (event.phase === "started") return;
    const durationMs = Math.round(performance.now() - event.startedAt);
    if (event.phase === "succeeded") {
      browserTrackAnalytics({
        ...productActivity,
        outcome: "succeeded",
        mode: event.mode,
        ...(productActivity.event === "feature.used" ? {} : { durationMs }),
      });
      return;
    }
    const cancelled = event.cancelled === true;
    browserTrackAnalytics({
      ...productActivity,
      outcome: cancelled ? "cancelled" : "failed",
      mode: event.mode,
      ...(productActivity.event === "feature.used" ? {} : { durationMs }),
      ...(cancelled || productActivity.event === "feature.used"
        ? {}
        : { reason: event.failureReason ?? "unreachable" }),
    });
  },
  analytics: browserTransportAnalytics,
  trackTurnSettlement: trackWsTurnSettlement,
};

let configuredPlatform: TransportPlatform = browserTransportPlatform;

export function setTransportPlatform(platform: TransportPlatform): void {
  configuredPlatform = platform;
}

export function getTransportPlatform(): TransportPlatform {
  return configuredPlatform;
}

/** Restores the default platform, for tests that install a host binding. */
export function resetTransportPlatform(): void {
  configuredPlatform = browserTransportPlatform;
}
