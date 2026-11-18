// Synara host enrollment backed by the Neox daemon pairing offer.
//
// `hosts.enrollment` is the only host-identity read the Synara UI needs for its "this computer"
// row and the org-discoverability prompt. Neox has no account/org directory; what it does have
// is a pairing offer (URL + QR) that identifies this daemon. The bridge exposes that daemon as a
// local, already-linked host so the settings surface can name the machine. Account-backed
// operations (device approval, org membership, sync keys) have no Neox equivalent and stay
// stubs.
import { type AccountHost, type HostsEnrollmentResult, WS_METHODS } from "@synara/contracts";

import type { BridgeModel } from "./model.ts";
import { fromPromise } from "./rpcErrors.ts";
import type { AnyHandler } from "./stubs.ts";

function platformForHost(): AccountHost["platform"] {
  switch (process.platform) {
    case "darwin":
      return "darwin";
    case "win32":
      return "windows";
    default:
      return "linux";
  }
}

/** The local daemon's row id, shared with the host directory so both name one identity. */
export const LOCAL_HOST_ID = "neolix-local-daemon";

/**
 * The daemon has no account row, so this host is synthesized from its pairing offer. The offer's
 * URL is the address another device reaches this machine on, which is exactly what the host
 * endpoint list means. Membership and discoverability are not account concepts here.
 *
 * `environmentId` must be the controller's descriptor id: a row whose environment differs from
 * the runtime would look like a second computer to the connections list.
 */
export function localHostFromPairingOffer(
  offer: { readonly url: string },
  options: {
    /** The controller descriptor's environment id (its daemon's serverId). */
    readonly environmentId: string;
    readonly label?: string | undefined;
  },
): AccountHost {
  const now = new Date().toISOString();
  const url = offer.url.trim();
  return {
    id: LOCAL_HOST_ID,
    environmentId: options.environmentId as AccountHost["environmentId"],
    name: options.label?.trim() || "This computer",
    platform: platformForHost(),
    kind: "local",
    endpoints: url ? [{ url, transport: "lan" }] : [],
    ownerUserId: "local",
    discoverable: true,
    linked: true,
    keyGeneration: 0,
    createdAt: now,
    lastSeenAt: now,
  };
}

export function makePairingHandlers(
  model: BridgeModel,
  options: {
    readonly environmentId: string;
    readonly label?: string | undefined;
  },
): Record<string, AnyHandler> {
  return {
    [WS_METHODS.hostsEnrollment]: () =>
      fromPromise("hosts.enrollment", async () => {
        const offer = await model.client.getDaemonPairingOffer();
        return {
          host: localHostFromPairingOffer(offer, options),
          organizationMemberCount: null,
          discoverabilityAcknowledged: true,
        } satisfies HostsEnrollmentResult;
      }),
  };
}
