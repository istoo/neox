import { NEOLIX_PROJECT_ICON_WS_METHODS } from "@synara/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { makeProjectIconHandlers } from "./projectIconsRpc.ts";
import type { BridgeModel } from "./model.ts";
import type { AnyHandler } from "./stubs.ts";

const ICON = { data: "AAAA", mimeType: "image/png" };

function run<A>(handler: AnyHandler | undefined, payload: unknown = {}): Promise<A> {
  if (!handler) throw new Error("handler is missing");
  return Effect.runPromise(handler(payload, {}) as Effect.Effect<A, never>);
}

function harness(options: { supportsCustomIcons?: boolean; iconError?: string | null } = {}) {
  const calls: Array<[string, unknown]> = [];
  const client = {
    getLastServerInfoMessage: () => ({
      features: { projectCustomIcon: options.supportsCustomIcons ?? true },
    }),
    getProjectIcon: async (projectId: string) => {
      calls.push(["getProjectIcon", projectId]);
      return { projectId, icon: ICON, error: options.iconError ?? null, requestId: "r" };
    },
    requestProjectIcon: async (cwd: string) => {
      calls.push(["requestProjectIcon", cwd]);
      return { cwd, icon: ICON, error: null, requestId: "r" };
    },
    setProjectIcon: async (projectId: string, source: unknown) => {
      calls.push(["setProjectIcon", { projectId, source }]);
    },
  };
  return {
    calls,
    handlers: makeProjectIconHandlers({ client } as unknown as BridgeModel),
  };
}

describe("makeProjectIconHandlers", () => {
  it("reads the project icon and reports custom-icon support", async () => {
    const { handlers, calls } = harness();
    const result = await run(handlers[NEOLIX_PROJECT_ICON_WS_METHODS.get], {
      projectId: "project-1",
    });
    expect(calls).toEqual([["getProjectIcon", "project-1"]]);
    expect(result).toEqual({ icon: ICON, supportsCustomIcons: true });
  });

  it("skips a custom-icon read on a host that predates it", async () => {
    const { handlers, calls } = harness({ supportsCustomIcons: false });
    const result = await run(handlers[NEOLIX_PROJECT_ICON_WS_METHODS.get], {
      projectId: "project-1",
    });
    expect(calls).toEqual([]);
    expect(result).toEqual({ icon: null, supportsCustomIcons: false });
  });

  it("answers the legacy cwd lookup", async () => {
    const { handlers, calls } = harness();
    const result = await run(handlers[NEOLIX_PROJECT_ICON_WS_METHODS.request], { cwd: "/repo" });
    expect(calls).toEqual([["requestProjectIcon", "/repo"]]);
    expect(result).toEqual({ icon: ICON });
  });

  it("forwards an upload", async () => {
    const { handlers, calls } = harness();
    await run(handlers[NEOLIX_PROJECT_ICON_WS_METHODS.set], {
      projectId: "project-1",
      source: { type: "upload", data: "AAAA" },
    });
    expect(calls).toEqual([
      ["setProjectIcon", { projectId: "project-1", source: { type: "upload", data: "AAAA" } }],
    ]);
  });

  it("refuses a write the host does not support", async () => {
    const { handlers } = harness({ supportsCustomIcons: false });
    await expect(
      run(handlers[NEOLIX_PROJECT_ICON_WS_METHODS.set], {
        projectId: "project-1",
        source: { type: "automatic" },
      }),
    ).rejects.toMatchObject({ code: "neolix.error.project.icon-unsupported" });
  });

  it("passes a daemon read failure through", async () => {
    const { handlers } = harness({ iconError: "Project not found" });
    await expect(
      run(handlers[NEOLIX_PROJECT_ICON_WS_METHODS.get], { projectId: "project-1" }),
    ).rejects.toMatchObject({ message: "Project not found" });
  });
});
