import {
  WS_CLIENT_REQUIRED_CAPABILITIES,
  WS_PROTOCOL_EPOCH,
  WS_PROTOCOL_MAX_REVISION,
  WS_SERVER_RUNTIME_STATUS_CAPABILITY,
  type WsBootstrapNegotiateInput,
} from "@synara/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  BRIDGE_SERVER_CAPABILITIES,
  bridgeServerCapabilities,
  negotiateWsCompatibility,
} from "./compatibility.ts";

function input(overrides: Partial<WsBootstrapNegotiateInput> = {}): WsBootstrapNegotiateInput {
  return {
    protocolEpoch: WS_PROTOCOL_EPOCH,
    minRevision: WS_PROTOCOL_MAX_REVISION,
    maxRevision: WS_PROTOCOL_MAX_REVISION,
    clientBuild: "test-client",
    requiredCapabilities: [...WS_CLIENT_REQUIRED_CAPABILITIES],
    ...overrides,
  };
}

describe("negotiateWsCompatibility", () => {
  it("advertises only capabilities the bridge implements", async () => {
    const result = await Effect.runPromise(negotiateWsCompatibility(input()));
    expect(result.capabilities).toEqual([...BRIDGE_SERVER_CAPABILITIES]);
    // A daemon that predates the metrics RPC makes the bridge omit the capability.
    expect(result.capabilities).not.toContain(WS_SERVER_RUNTIME_STATUS_CAPABILITY);
    for (const capability of WS_CLIENT_REQUIRED_CAPABILITIES) {
      expect(result.capabilities).toContain(capability);
    }
  });

  it("advertises runtime status only when the daemon serves the metrics RPC", async () => {
    expect(bridgeServerCapabilities({ daemonRuntimeStatus: false })).not.toContain(
      WS_SERVER_RUNTIME_STATUS_CAPABILITY,
    );

    const capabilities = bridgeServerCapabilities({ daemonRuntimeStatus: true });
    expect(capabilities).toContain(WS_SERVER_RUNTIME_STATUS_CAPABILITY);

    const result = await Effect.runPromise(negotiateWsCompatibility(input(), { capabilities }));
    expect(result.capabilities).toContain(WS_SERVER_RUNTIME_STATUS_CAPABILITY);
  });

  it("reports the host daemon's version as the server build", async () => {
    const result = await Effect.runPromise(
      negotiateWsCompatibility(input(), { serverBuild: "0.16.5" }),
    );
    expect(result.serverBuild).toBe("0.16.5");
  });

  it("refuses a capability it does not implement", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        negotiateWsCompatibility(
          input({ requiredCapabilities: [WS_SERVER_RUNTIME_STATUS_CAPABILITY] }),
        ),
      ),
    );
    expect(error).toMatchObject({ code: "WS_CAPABILITIES_INCOMPATIBLE", action: "update-server" });
  });
});
