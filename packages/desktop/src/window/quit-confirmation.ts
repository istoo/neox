import { randomUUID } from "node:crypto";

export interface QuitConfirmationRequest {
  requestId: string;
  presentation: "native" | "in-app";
}

export interface QuitConfirmationChat {
  id: string;
  title: string;
}

export type QuitConfirmationResponse =
  | {
      requestId: string;
      phase: "ready";
      runningCount: number;
      chats: readonly QuitConfirmationChat[];
    }
  | { requestId: string; phase: "decision"; allow: boolean };

export interface QuitConfirmationRenderer {
  /** Posts the request to the renderer that owns the quit prompt. */
  send(request: QuitConfirmationRequest): void;
  /** False once that renderer is gone; waiting on it would stall the quit. */
  isAlive(): boolean;
}

/**
 * Asks the renderer whether quitting may proceed while chats are running.
 *
 * `ask()` resolves `true` (quit), `false` (stay) or `null` (the renderer never
 * answered, so the caller shows its native dialog instead). A renderer that
 * answers `ready` with no running chats allows the quit without a dialog; one
 * that lists chats keeps the quit waiting for the user's decision.
 */
export function createQuitConfirmationBroker({
  renderer,
  readyTimeoutMs = 1_500,
}: {
  renderer: QuitConfirmationRenderer;
  readyTimeoutMs?: number;
}) {
  let active: {
    requestId: string;
    resolve: (allowed: boolean | null) => void;
    timer: NodeJS.Timeout | null;
  } | null = null;

  function finish(requestId: string, allowed: boolean | null): void {
    if (!active || active.requestId !== requestId) return;
    const { resolve, timer } = active;
    active = null;
    if (timer !== null) clearTimeout(timer);
    resolve(allowed);
  }

  function handleResponse(response: unknown): void {
    if (!active || typeof response !== "object" || response === null) return;
    const requestId = (response as { requestId?: unknown }).requestId;
    if (typeof requestId !== "string" || requestId !== active.requestId) return;
    const phase = (response as { phase?: unknown }).phase;
    if (phase === "ready") {
      const runningCount = (response as { runningCount?: unknown }).runningCount;
      if (typeof runningCount !== "number" || !Number.isFinite(runningCount)) return;
      if (active.timer !== null) {
        clearTimeout(active.timer);
        active.timer = null;
      }
      if (runningCount <= 0) {
        finish(requestId, true);
      }
      return;
    }
    if (phase === "decision") {
      const allow = (response as { allow?: unknown }).allow;
      if (typeof allow !== "boolean") return;
      finish(requestId, allow);
    }
  }

  function cancel(): void {
    if (active) finish(active.requestId, false);
  }

  function ask(): Promise<boolean | null> {
    if (active) return Promise.resolve(false);
    return new Promise((resolve) => {
      const requestId = randomUUID();
      active = {
        requestId,
        resolve,
        timer: setTimeout(() => finish(requestId, null), readyTimeoutMs),
      };
      try {
        renderer.send({ requestId, presentation: "in-app" });
      } catch {
        finish(requestId, null);
      }
    });
  }

  /** A renderer going away while its prompt is open must not strand the quit. */
  function handleRendererGone(): void {
    if (active && !renderer.isAlive()) cancel();
  }

  return { ask, handleResponse, cancel, handleRendererGone };
}
