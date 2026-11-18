import type { AccountHost } from "@synara/contracts";
import { describe, expect, it } from "vitest";

// The standalone entry installs this at startup; tests import the modules directly.
import "./clientRuntime.node.ts";

import {
  HostRegistry,
  LOCAL_HOST_ID,
  httpBaseForConnection,
  httpBaseForTarget,
  registrationIdFromHostId,
  remoteHostId,
  wsPathForHost,
} from "./multihost.ts";
import type { DaemonClient } from "./neolix.ts";

const row = {
  registrationId: "reg-1",
  serverId: "srv-remote",
  label: "Studio mini",
  source: { id: "producer", key: "key" },
  metadata: {},
  enabled: true,
  status: "online" as const,
  targetDescription: "tcp://192.168.1.20:6768",
  lastOnlineAt: "2026-11-08T10:00:00.000Z",
  nextRetryAt: null,
  error: null,
};

function registryWith(overrides: Record<string, unknown> = {}) {
  const calls: Array<[string, unknown]> = [];
  const primary = {
    listHosts: async () => ({
      self: { serverId: "srv-local", label: "This computer" },
      hosts: [row],
    }),
    addHost: async (input: unknown) => {
      calls.push(["add", input]);
      return { ...row, registrationId: "reg-new", label: null, metadata: {} };
    },
    updateHost: async (registrationId: string, patch: unknown) => {
      calls.push(["update", { registrationId, patch }]);
      return { ...row, label: (patch as { label?: string }).label ?? row.label };
    },
    removeHost: async (registrationId: string) => {
      calls.push(["remove", registrationId]);
    },
    getDaemonPairingOffer: async () => ({
      requestId: "r",
      url: "neolix://pair#offer",
      qr: null,
      relayEnabled: true,
    }),
    ...overrides,
  };
  const registry = new HostRegistry(primary as unknown as DaemonClient, {
    home: "/tmp/home",
    environmentId: "neolix-local-env",
    label: "This computer",
    log: () => {},
    buildHandlers: () => ({}),
  });
  return { registry, calls };
}

describe("multihost identity", () => {
  it("derives a path-safe host id and reads it back", () => {
    const hostId = remoteHostId("reg/with spaces");
    expect(hostId).toBe("neolix-host-reg_with_spaces");
    expect(registrationIdFromHostId(hostId)).toBe("reg_with_spaces");
  });

  it("keeps the ws path inside the prefix the renderer accepts", () => {
    expect(wsPathForHost(remoteHostId("reg-1"))).toBe("/rpc/remote/neolix-host-reg-1");
  });

  it("builds an HTTP base only for directly reachable targets", () => {
    expect(httpBaseForTarget("tcp://192.168.1.20:6768")).toBe("http://192.168.1.20:6768");
    expect(httpBaseForTarget("ws://host.lan:6768/ws")).toBe("http://host.lan:6768");
    expect(httpBaseForTarget("wss://host.example/ws")).toBe("https://host.example");
    expect(httpBaseForTarget("relay://relay.example:443/srv")).toBeNull();
    expect(httpBaseForTarget("ssh://mini.local:6768 (daemon port 6768)")).toBeNull();
  });

  it("derives the primary daemon's HTTP origin from its configured target", () => {
    expect(httpBaseForConnection("localhost:6768")).toBe("http://localhost:6768");
    expect(httpBaseForConnection("ssh://mini.local:2222")).toBeNull();
  });
});

describe("HostRegistry directory", () => {
  it("lists the controller and every registration as one host each", async () => {
    const { registry } = registryWith();
    const hosts = await registry.hosts();
    expect(hosts.map((host: AccountHost) => host.id)).toEqual([LOCAL_HOST_ID, "neolix-host-reg-1"]);
    const [self, remote] = hosts;
    expect(self).toMatchObject({
      name: "This computer",
      environmentId: "neolix-local-env",
      kind: "local",
      mine: true,
    });
    expect(remote).toMatchObject({
      name: "Studio mini",
      // The daemon's stable serverId, not the registration id or its address.
      environmentId: "srv-remote",
      kind: "ssh-managed",
      endpoints: [{ url: "tcp://192.168.1.20:6768", transport: "lan" }],
    });
  });

  it("keeps the same environment id when the host's address changes", async () => {
    const first = registryWith();
    const second = registryWith({
      listHosts: async () => ({
        self: { serverId: "srv-local", label: "This computer" },
        hosts: [{ ...row, targetDescription: "tcp://192.168.1.99:6800" }],
      }),
    });
    const [firstHosts, secondHosts] = await Promise.all([
      first.registry.hosts(),
      second.registry.hosts(),
    ]);
    expect(firstHosts[1]?.environmentId).toBe("srv-remote");
    expect(secondHosts[1]?.environmentId).toBe("srv-remote");
  });

  it("falls back to the registration id until the daemon reports a server id", async () => {
    const { registry } = registryWith({
      listHosts: async () => ({
        self: { serverId: "srv-local", label: "This computer" },
        hosts: [{ ...row, serverId: null }],
      }),
    });
    const hosts = await registry.hosts();
    expect(hosts[1]?.environmentId).toBe("neolix-host-reg-1");
  });

  it("falls back to the target description when a registration has no label", async () => {
    const { registry } = registryWith({
      listHosts: async () => ({
        self: { serverId: "srv-local", label: "This computer" },
        hosts: [{ ...row, label: null }],
      }),
    });
    const hosts = await registry.hosts();
    expect(hosts[1]?.name).toBe("tcp://192.168.1.20:6768");
  });

  it("renames through the daemon label, not metadata", async () => {
    const { registry, calls } = registryWith();
    await registry.update("neolix-host-reg-1", { label: "Renamed" });
    expect(calls).toEqual([["update", { registrationId: "reg-1", patch: { label: "Renamed" } }]]);
  });

  it("keeps the row when only discoverability was sent", async () => {
    const { registry, calls } = registryWith();
    const host = await registry.update("neolix-host-reg-1", {});
    expect(calls).toEqual([]);
    expect(host.name).toBe("Studio mini");
  });

  it("returns the saved entry instead of registering the same target twice", async () => {
    const { registry, calls } = registryWith();
    const host = await registry.add({ connection: "tcp://192.168.1.20:6768" });
    expect(calls).toEqual([]);
    expect(host.id).toBe("neolix-host-reg-1");
  });

  it("updates the label when an existing target is re-added with a name", async () => {
    const { registry, calls } = registryWith();
    await registry.add({ connection: "tcp://192.168.1.20:6768", label: "Renamed" });
    expect(calls).toEqual([["update", { registrationId: "reg-1", patch: { label: "Renamed" } }]]);
  });

  it("pairs every registration so the connections pane can list it", async () => {
    const { registry } = registryWith();
    const connections = await registry.connections();
    expect(connections.pairedHosts).toEqual([
      { hostId: "neolix-host-reg-1", environmentId: "srv-remote" },
    ]);
    expect(connections.connections).toEqual([]);
  });

  it("returns the daemon offer as the pairing link", async () => {
    const { registry } = registryWith();
    const result = await registry.remoteAccess({ operation: "create-code" });
    expect(result).toMatchObject({
      kind: "pairing-code",
      link: "neolix://pair#offer",
      code: "neolix://pair#offer",
    });
  });
});
