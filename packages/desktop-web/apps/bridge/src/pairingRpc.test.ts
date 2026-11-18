import { HostsEnrollmentResult, WS_METHODS } from "@synara/contracts";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";

import type { BridgeModel } from "./model.ts";
import { localHostFromPairingOffer, makePairingHandlers } from "./pairingRpc.ts";
import type { AnyHandler } from "./stubs.ts";

const encode = <S extends Schema.Top>(schema: S, value: unknown) =>
  Schema.encodeUnknownSync(schema as never)(value);

function run<A>(handler: AnyHandler | undefined, payload: unknown): Promise<A> {
  if (handler === undefined) throw new Error("handler is missing");
  return Effect.runPromise(handler(payload, {}) as Effect.Effect<A, never>);
}

describe("pairingRpc", () => {
  it("projects the daemon pairing offer into a local host", async () => {
    const client = {
      getDaemonPairingOffer: async () => ({
        requestId: "r",
        url: "neolix://pair?host=abc",
        qr: null,
        relayEnabled: true,
      }),
    };
    const model = { client } as unknown as BridgeModel;
    const handlers = makePairingHandlers(model, { environmentId: "srv-local" });
    const result = await run<HostsEnrollmentResult>(handlers[WS_METHODS.hostsEnrollment], {});
    const encoded = encode(HostsEnrollmentResult, result) as HostsEnrollmentResult;
    expect(encoded).toMatchObject({
      organizationMemberCount: null,
      discoverabilityAcknowledged: true,
      host: {
        id: "neolix-local-daemon",
        environmentId: "srv-local",
        name: "This computer",
        kind: "local",
        linked: true,
        endpoints: [{ url: "neolix://pair?host=abc", transport: "lan" }],
      },
    });
  });

  it("omits the endpoint when the daemon has no offer URL", () => {
    const host = localHostFromPairingOffer({ url: "   " }, { environmentId: "srv-local" });
    const encoded = encode(HostsEnrollmentResult, {
      host,
      organizationMemberCount: null,
      discoverabilityAcknowledged: true,
    }) as HostsEnrollmentResult;
    expect(encoded.host?.endpoints).toEqual([]);
  });
});
