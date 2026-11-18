// Adapted from Synara apps/server/src/wsCompatibility.ts (MIT, Copyright (c) 2026 T3 Tools Inc.).
// The bridge negotiates exactly like the Synara server so the unmodified front end connects.
import { randomUUID } from "node:crypto";

import {
  WS_COMPATIBILITY_QUERY,
  WS_NEGOTIATE_QUERY,
  WS_PROTOCOL_EPOCH,
  WS_CLIENT_REQUIRED_CAPABILITIES,
  WS_GITHUB_PROJECT_PROVISIONING_CAPABILITY,
  WS_PROJECT_FILE_WATCH_CAPABILITY,
  WS_PROTOCOL_MAX_REVISION,
  WS_PROTOCOL_MIN_REVISION,
  WS_SERVER_RUNTIME_STATUS_CAPABILITY,
  WS_TURN_DISPATCH_SETTLEMENT_CAPABILITY,
  WsCompatibilityError,
  type WsBootstrapNegotiateInput,
  type WsBootstrapNegotiateResult,
  type WsCompatibilityAction,
} from "@synara/contracts";
import { Effect } from "effect";

// The bridge's own build identity, used only when the daemon version is unknown. It is a
// real build, not a claim about the daemon.
const bridgeBuild = "neolix-bridge-0.0.0";

/**
 * What this bridge serves on every daemon. `WS_SERVER_CAPABILITIES` is Synara's full surface;
 * methods this bridge does not implement (usage-limit recovery, goal visibility, the remote
 * agent gateway) stay out. A capability appears here only when its RPC has a handler in
 * `handlers.ts`/`hostRpc.ts`; capabilities that also need a daemon RPC are added per
 * connection by {@link bridgeServerCapabilities}.
 */
export const BRIDGE_SERVER_CAPABILITIES = [
  ...WS_CLIENT_REQUIRED_CAPABILITIES,
  WS_GITHUB_PROJECT_PROVISIONING_CAPABILITY,
  WS_PROJECT_FILE_WATCH_CAPABILITY,
  WS_TURN_DISPATCH_SETTLEMENT_CAPABILITY,
  // The bridge serves `/rpc/negotiate` over plain HTTP, so a connect is one upgrade.
  "transport.http-negotiate",
] as const;

/**
 * The capabilities this bridge can serve for one daemon. Runtime status is only advertised
 * when the daemon has the metrics RPC, so a client on an older host gets its update-server
 * path instead of a call that cannot answer.
 */
export function bridgeServerCapabilities(
  options: {
    readonly daemonRuntimeStatus?: boolean;
  } = {},
): readonly string[] {
  return options.daemonRuntimeStatus === true
    ? [...BRIDGE_SERVER_CAPABILITIES, WS_SERVER_RUNTIME_STATUS_CAPABILITY]
    : BRIDGE_SERVER_CAPABILITIES;
}

/** Identifies this bridge process; a restart changes it and the client reloads. */
const serverInstanceId = randomUUID();

function incompatibility(
  action: WsCompatibilityAction,
  message: string,
  code: WsCompatibilityError["code"] = "WS_PROTOCOL_INCOMPATIBLE",
  build: string = bridgeBuild,
): WsCompatibilityError {
  return new WsCompatibilityError({
    message,
    code,
    retryable: false,
    action,
    serverBuild: build,
    protocolEpoch: WS_PROTOCOL_EPOCH,
    minRevision: WS_PROTOCOL_MIN_REVISION,
    maxRevision: WS_PROTOCOL_MAX_REVISION,
  });
}

export interface WsNegotiationOptions {
  /** The daemon's version when known; the bridge build otherwise. */
  readonly serverBuild?: string | undefined;
  readonly capabilities?: readonly string[] | undefined;
}

export function negotiateWsCompatibility(
  input: WsBootstrapNegotiateInput,
  options: WsNegotiationOptions = {},
): Effect.Effect<WsBootstrapNegotiateResult, WsCompatibilityError> {
  const serverBuild = options.serverBuild?.trim() || bridgeBuild;
  const capabilities = options.capabilities ?? BRIDGE_SERVER_CAPABILITIES;
  if (input.minRevision > input.maxRevision) {
    return Effect.fail(
      incompatibility("reload", "The client sent an invalid WebSocket protocol range."),
    );
  }
  if (input.protocolEpoch !== WS_PROTOCOL_EPOCH) {
    return Effect.fail(
      incompatibility(
        input.protocolEpoch < WS_PROTOCOL_EPOCH ? "update-client" : "update-server",
        `WebSocket protocol epoch ${input.protocolEpoch} is incompatible with server epoch ${WS_PROTOCOL_EPOCH}.`,
      ),
    );
  }

  const lowestCompatibleRevision = Math.max(input.minRevision, WS_PROTOCOL_MIN_REVISION);
  const negotiatedRevision = Math.min(input.maxRevision, WS_PROTOCOL_MAX_REVISION);
  if (negotiatedRevision < lowestCompatibleRevision) {
    return Effect.fail(
      incompatibility(
        input.maxRevision < WS_PROTOCOL_MIN_REVISION ? "update-client" : "update-server",
        `WebSocket protocol revisions ${input.minRevision}-${input.maxRevision} do not overlap server revisions ${WS_PROTOCOL_MIN_REVISION}-${WS_PROTOCOL_MAX_REVISION}.`,
      ),
    );
  }

  const missingCapabilities = input.requiredCapabilities.filter(
    (capability) => !capabilities.some((supported) => supported === capability),
  );
  if (missingCapabilities.length > 0) {
    return Effect.fail(
      incompatibility(
        "update-server",
        `The server is missing required WebSocket capabilities: ${missingCapabilities.join(", ")}.`,
        "WS_CAPABILITIES_INCOMPATIBLE",
      ),
    );
  }

  return Effect.succeed({
    protocolEpoch: WS_PROTOCOL_EPOCH,
    negotiatedRevision,
    serverBuild,
    serverInstanceId,
    capabilities: [...capabilities],
  });
}

// The HTTP negotiate endpoint carries the same input as bootstrap.negotiate,
// flattened into query params so the request stays a cacheable-free plain GET
// with no body to decode before the compatibility gate runs.
// Decimal digits only. `Number()` would accept "0x1" and "1e0", which the RPC
// path's Schema.Int rejects — the two transports must decode identically or
// "one negotiation, two transports" is only true for well-formed clients.
function parseDecimalInteger(raw: string | null): number | null {
  // No trimming: surrounding whitespace (including a `+` that decodes to a
  // space) is not a well-formed integer on either transport.
  if (raw === null || !/^\d+$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function parseWsNegotiateSearchParams(
  searchParams: URLSearchParams,
): WsBootstrapNegotiateInput | WsCompatibilityError {
  const protocolEpoch = parseDecimalInteger(searchParams.get(WS_NEGOTIATE_QUERY.protocolEpoch));
  const minRevision = parseDecimalInteger(searchParams.get(WS_NEGOTIATE_QUERY.minRevision));
  const maxRevision = parseDecimalInteger(searchParams.get(WS_NEGOTIATE_QUERY.maxRevision));
  const clientBuild = searchParams.get(WS_NEGOTIATE_QUERY.clientBuild)?.trim() ?? "";
  if (
    protocolEpoch === null ||
    minRevision === null ||
    maxRevision === null ||
    clientBuild.length === 0
  ) {
    return incompatibility(
      "reload",
      "WebSocket negotiation request is missing required parameters.",
      "WS_NEGOTIATION_REQUIRED",
    );
  }
  return {
    protocolEpoch,
    minRevision,
    maxRevision,
    clientBuild,
    requiredCapabilities: searchParams.getAll(WS_NEGOTIATE_QUERY.requiredCapability),
  };
}

export function validateWsFeatureCompatibility(
  searchParams: URLSearchParams,
): WsCompatibilityError | null {
  const epoch = Number(searchParams.get(WS_COMPATIBILITY_QUERY.protocolEpoch));
  const revision = Number(searchParams.get(WS_COMPATIBILITY_QUERY.protocolRevision));
  const clientBuild = searchParams.get(WS_COMPATIBILITY_QUERY.clientBuild)?.trim() ?? "";
  const expectedServerInstanceId =
    searchParams.get(WS_COMPATIBILITY_QUERY.serverInstanceId)?.trim() ?? "";
  if (!Number.isSafeInteger(epoch) || epoch !== WS_PROTOCOL_EPOCH) {
    return incompatibility(
      "reload",
      "Feature RPC rejected before compatible WebSocket protocol negotiation.",
      "WS_NEGOTIATION_REQUIRED",
    );
  }
  if (
    !Number.isSafeInteger(revision) ||
    revision < WS_PROTOCOL_MIN_REVISION ||
    revision > WS_PROTOCOL_MAX_REVISION
  ) {
    return incompatibility(
      revision < WS_PROTOCOL_MIN_REVISION ? "update-client" : "update-server",
      "Feature RPC rejected because its negotiated protocol revision is unsupported.",
    );
  }
  if (clientBuild.length === 0) {
    return incompatibility(
      "reload",
      "Feature RPC rejected because the client build identity is missing.",
      "WS_NEGOTIATION_REQUIRED",
    );
  }
  if (expectedServerInstanceId !== serverInstanceId) {
    return incompatibility(
      "reload",
      "The Neox bridge restarted during WebSocket negotiation. Reload to reconnect to the new server generation.",
      "WS_SERVER_GENERATION_CHANGED",
    );
  }
  return null;
}

export function makeCurrentWsFeatureCompatibilitySearchParams(
  clientBuild: string,
): URLSearchParams {
  return new URLSearchParams({
    [WS_COMPATIBILITY_QUERY.clientBuild]: clientBuild,
    [WS_COMPATIBILITY_QUERY.protocolEpoch]: String(WS_PROTOCOL_EPOCH),
    [WS_COMPATIBILITY_QUERY.protocolRevision]: String(WS_PROTOCOL_MAX_REVISION),
    [WS_COMPATIBILITY_QUERY.serverInstanceId]: serverInstanceId,
  });
}
