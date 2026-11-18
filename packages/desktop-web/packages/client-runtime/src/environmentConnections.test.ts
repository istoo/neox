import { describe, expect, it, vi } from "vitest";

import {
  EnvironmentConnections,
  EnvironmentMismatchError,
  type EnvironmentConnectionTarget,
} from "./environmentConnections";
import type { WsTransport } from "./wsTransport";

function fakeTransport(): WsTransport & { dispose: ReturnType<typeof vi.fn> } {
  return { dispose: vi.fn(async () => undefined) } as unknown as WsTransport & {
    dispose: ReturnType<typeof vi.fn>;
  };
}

function target(
  environmentId: string,
  hostId = `host-${environmentId}`,
): EnvironmentConnectionTarget {
  return {
    hostId,
    executionScope: {
      environmentId,
      userId: "user-1",
      organizationId: "org-1",
      accountAuthority: "authority-1",
      channel: "stable",
    },
  };
}

describe("EnvironmentConnections", () => {
  it("shares one controller and defaults execution to it", () => {
    const controller = fakeTransport();
    const createController = vi.fn(() => controller);
    const connections = new EnvironmentConnections({
      createController,
      connectEnvironment: async () => fakeTransport(),
    });

    expect(connections.controller()).toBe(controller);
    expect(connections.execution()).toBe(controller);
    expect(createController).toHaveBeenCalledOnce();
  });

  it("refcounts an environment and connects concurrently only once", async () => {
    const controller = fakeTransport();
    const remote = fakeTransport();
    const connectEnvironment = vi.fn(async () => remote);
    const connections = new EnvironmentConnections({
      createController: () => controller,
      connectEnvironment,
    });

    const [first, second] = await Promise.all([
      connections.acquire(target("env-a")),
      connections.acquire(target("env-a")),
    ]);
    expect(connectEnvironment).toHaveBeenCalledOnce();
    expect(first.transport).toBe(remote);
    expect(second.transport).toBe(remote);
    expect(connections.forEnvironment("env-a")).toBe(remote);

    await first.release();
    expect(remote.dispose).not.toHaveBeenCalled();
    await second.release();
    expect(remote.dispose).toHaveBeenCalledOnce();
    expect(connections.forEnvironment("env-a")).toBeUndefined();
    // Releasing never disconnects the host or the controller.
    expect(controller.dispose).not.toHaveBeenCalled();
  });

  it("rejects a second host claiming the same environment", async () => {
    const connections = new EnvironmentConnections({
      createController: () => fakeTransport(),
      connectEnvironment: async () => fakeTransport(),
    });
    await connections.acquire(target("env-a", "host-1"));

    await expect(connections.acquire(target("env-a", "host-2"))).rejects.toBeInstanceOf(
      EnvironmentMismatchError,
    );
  });

  it("closes transports it opened when the owner disposes", async () => {
    const controller = fakeTransport();
    const remote = fakeTransport();
    const connections = new EnvironmentConnections({
      createController: () => controller,
      connectEnvironment: async () => remote,
    });
    expect(connections.controller()).toBe(controller);
    await connections.acquire(target("env-a"));

    await connections.dispose();
    expect(remote.dispose).toHaveBeenCalledOnce();
    expect(controller.dispose).toHaveBeenCalledOnce();
  });

  it("ignores repeated releases", async () => {
    const remote = fakeTransport();
    const connections = new EnvironmentConnections({
      createController: () => fakeTransport(),
      connectEnvironment: async () => remote,
    });
    const lease = await connections.acquire(target("env-a"));
    await lease.release();
    await lease.release();
    expect(remote.dispose).toHaveBeenCalledOnce();
  });
});
