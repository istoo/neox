import { WS_METHODS, type WorkspaceSetupEvent } from "@synara/contracts";
import { Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";

import type { BridgeModel } from "./model.ts";
import {
  makeWorkspaceSetupHandlers,
  type WorkspaceSetupDaemonClient,
  type WorkspaceSetupObservation,
} from "./workspaceSetupRpc.ts";

const WORKSPACE_ID = "ws_1";

function snapshot(status: "running" | "completed" | "failed", commandStatus: string, log: string) {
  return {
    status,
    error: status === "failed" ? "command failed" : null,
    detail: {
      type: "worktree_setup" as const,
      worktreePath: "/repo/wt",
      branchName: "feature",
      log: "",
      commands: [
        {
          index: 1,
          command: "bun install",
          cwd: "/repo/wt",
          log,
          status: commandStatus,
          exitCode: status === "failed" ? 1 : null,
        },
      ],
    },
  };
}

function makeClient(options: {
  readonly failObservation?: string;
  readonly runResult?: { started: boolean; error: string | null };
}) {
  const calls: string[] = [];
  let observer: Parameters<WorkspaceSetupObservation["subscribe"]>[0] | undefined;
  let released = false;
  const client: WorkspaceSetupDaemonClient = {
    observeWorkspaceSetup: (workspaceId) => {
      calls.push(`observe:${workspaceId}`);
      if (options.failObservation) throw new Error(options.failObservation);
      return {
        subscribe: (next) => {
          observer = next;
          next.snapshot({ workspaceId, snapshot: snapshot("running", "running", "installing") });
          queueMicrotask(() => {
            next.update({
              type: "workspace_setup_progress",
              payload: { workspaceId, ...snapshot("completed", "completed", "installed") },
            });
          });
          return () => {
            calls.push("detach");
          };
        },
        release: async () => {
          released = true;
          calls.push("release");
        },
      };
    },
    runWorkspaceSetup: async (workspaceId) => {
      calls.push(`run:${workspaceId}`);
      return options.runResult ?? { started: true, error: null };
    },
  };
  return {
    client,
    calls,
    getObserver: () => observer,
    wasReleased: () => released,
  };
}

async function collect(
  handlers: Record<string, unknown>,
  workspaceId = WORKSPACE_ID,
): Promise<ReadonlyArray<WorkspaceSetupEvent>> {
  const stream = (
    handlers[WS_METHODS.neolixWorkspaceSetupSubscribe] as (
      payload: unknown,
    ) => Stream.Stream<WorkspaceSetupEvent, unknown>
  )({ workspaceId });
  const events = await Effect.runPromise(Stream.runCollect(stream.pipe(Stream.take(2))));
  return [...events];
}

describe("workspaceSetupRpc", () => {
  it("replays the initial snapshot and each progress update, then releases", async () => {
    const fake = makeClient({});
    const handlers = makeWorkspaceSetupHandlers({
      client: fake.client,
    } as unknown as BridgeModel);

    const events = await collect(handlers);
    expect(fake.calls).toContain(`observe:${WORKSPACE_ID}`);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      workspaceId: WORKSPACE_ID,
      snapshot: { status: "running" },
    });
    expect(events[1]).toMatchObject({
      workspaceId: WORKSPACE_ID,
      snapshot: { status: "completed" },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fake.wasReleased()).toBe(true);
    expect(fake.calls).toContain("detach");
  });

  it("reports a host without setup observation as one event and stays open", async () => {
    const fake = makeClient({ failObservation: "Update the host to view workspace setup details" });
    const handlers = makeWorkspaceSetupHandlers({
      client: fake.client,
    } as unknown as BridgeModel);
    const stream = (
      handlers[WS_METHODS.neolixWorkspaceSetupSubscribe] as (
        payload: unknown,
      ) => Stream.Stream<WorkspaceSetupEvent, unknown>
    )({
      workspaceId: WORKSPACE_ID,
    });

    const events = await Effect.runPromise(Stream.runCollect(Stream.take(stream, 1)));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      workspaceId: WORKSPACE_ID,
      snapshot: null,
      error: "Update the host to view workspace setup details",
    });
  });

  it("re-runs setup and reports the daemon's started/error result", async () => {
    const fake = makeClient({ runResult: { started: false, error: "workspace not found" } });
    const handlers = makeWorkspaceSetupHandlers({
      client: fake.client,
    } as unknown as BridgeModel);

    const result = await Effect.runPromise(
      (
        handlers[WS_METHODS.neolixWorkspaceSetupRun] as (
          payload: unknown,
        ) => Effect.Effect<unknown, never>
      )({ workspaceId: WORKSPACE_ID }),
    );
    expect(result).toEqual({
      workspaceId: WORKSPACE_ID,
      started: false,
      error: "workspace not found",
    });
    expect(fake.calls).toContain(`run:${WORKSPACE_ID}`);
  });
});
