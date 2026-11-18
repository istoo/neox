// Neox worktree setup observation, republished to the web renderer.
//
// The daemon's `workspace.setup.subscribe` is an owned subscription: the first
// response carries the cached snapshot (or the persisted blocked state) and every
// later `workspace_setup_progress` message carries a new one. The bridge turns
// that into one Effect RPC stream per workspace so the dock can render setup
// output live without polling.
import { WS_METHODS, type WorkspaceSetupEvent } from "@synara/contracts";
import { Effect, Queue, Stream } from "effect";

import type { BridgeModel } from "./model.ts";
import { fromPromise, rpcError } from "./rpcErrors.ts";
import type { AnyHandler } from "./stubs.ts";

/** The setup snapshot, structurally identical to the daemon's wire payload. */
export type WorkspaceSetupSnapshotWire = WorkspaceSetupEvent["snapshot"];

export interface WorkspaceSetupObservation {
  subscribe(observer: {
    snapshot: (response: { workspaceId: string; snapshot: unknown }) => void;
    update: (message: { type: string; payload?: unknown }) => void;
    error?: (error: unknown) => void;
  }): () => void;
  release(): Promise<void>;
}

/** The slice of DaemonClient this module needs; tests supply a fake. */
export interface WorkspaceSetupDaemonClient {
  observeWorkspaceSetup(workspaceId: string): WorkspaceSetupObservation;
  runWorkspaceSetup(workspaceId: string): Promise<{ started: boolean; error: string | null }>;
}

function progressSnapshot(message: {
  type: string;
  payload?: unknown;
}): WorkspaceSetupSnapshotWire | null {
  if (message.type !== "workspace_setup_progress") return null;
  const payload = message.payload;
  if (payload === null || typeof payload !== "object") return null;
  return payload as WorkspaceSetupSnapshotWire;
}

/**
 * Takes an emit callback instead of the queue: the queue's error parameter also carries the
 * stream's done sentinel, which a plain `Queue<Event>` parameter cannot express.
 */
function emitSnapshot(
  emit: (event: WorkspaceSetupEvent) => void,
  workspaceId: string,
  snapshot: WorkspaceSetupSnapshotWire | null,
): void {
  if (!snapshot) return;
  emit({ workspaceId, snapshot });
}

/**
 * One subscription per stream lifetime. `acquire` may refuse (an old host without
 * owned subscriptions), which fails the stream with the client's own message.
 */
export function workspaceSetupEvents(
  client: WorkspaceSetupDaemonClient,
  workspaceId: string,
): Stream.Stream<WorkspaceSetupEvent, ReturnType<typeof rpcError>> {
  return Stream.suspend(() => {
    let observation: WorkspaceSetupObservation;
    try {
      observation = client.observeWorkspaceSetup(workspaceId);
    } catch (cause) {
      // A host without owned subscriptions refuses here. Report it as one event and then
      // stay open: failing would make the web transport retry forever, and completing
      // normally makes it treat the stream as a dropped connection and restart it.
      const message = rpcError(cause).message;
      return Stream.concat(
        Stream.make({ workspaceId, snapshot: null, error: message }),
        Stream.never,
      );
    }
    return Stream.callback<WorkspaceSetupEvent, ReturnType<typeof rpcError>>((queue) => {
      const emit = (event: WorkspaceSetupEvent) => Queue.offerUnsafe(queue, event);
      return Effect.acquireRelease(
        Effect.try({
          try: () =>
            observation.subscribe({
              snapshot: (response) => {
                if (response.workspaceId !== workspaceId) return;
                emitSnapshot(emit, workspaceId, response.snapshot as WorkspaceSetupSnapshotWire);
              },
              update: (message) => {
                const snapshot = progressSnapshot(message);
                if (!snapshot) return;
                emitSnapshot(emit, workspaceId, snapshot);
              },
            }),
          catch: (cause) => rpcError(cause),
        }),
        (detach) =>
          Effect.sync(() => {
            detach();
            void observation.release().catch(() => undefined);
          }),
      );
    });
  });
}

export function makeWorkspaceSetupHandlers(model: BridgeModel): Record<string, AnyHandler> {
  const client = model.client as unknown as WorkspaceSetupDaemonClient;
  return {
    [WS_METHODS.neolixWorkspaceSetupSubscribe]: (payload) => {
      const { workspaceId } = payload as { workspaceId: string };
      return workspaceSetupEvents(client, workspaceId);
    },
    [WS_METHODS.neolixWorkspaceSetupRun]: (payload) =>
      fromPromise("neolix.workspaceSetup.run", async () => {
        const { workspaceId } = payload as { workspaceId: string };
        const result = await client.runWorkspaceSetup(workspaceId);
        return { workspaceId, started: result.started, error: result.error ?? null };
      }),
  };
}
