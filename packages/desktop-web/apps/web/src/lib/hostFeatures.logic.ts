// FILE: hostFeatures.logic.ts
// Purpose: The one place a host capability flag is named and read. A feature runs when its
//          `server_info.features.*` flag is true, and otherwise the UI shows the update-host
//          notice; there is no fallback path. Field names mirror packages/protocol.
// Layer: Web logic

/** Capability flags this front end gates. Names match `server_info.features` in the protocol. */
export const HOST_FEATURES = {
  skillManagement: "skillManagement",
  agentDetach: "agentDetach",
  checkoutForgeSetAutoMerge: "checkoutForgeSetAutoMerge",
  gatewayDiagnostics: "gatewayDiagnostics",
  workspaceSetupObservation: "workspaceSetupObservation",
  sync: "sync",
  projectCustomIcon: "projectCustomIcon",
} as const;

export type HostFeature = (typeof HOST_FEATURES)[keyof typeof HOST_FEATURES];

export type HostFeatureStatus = "available" | "unavailable" | "unknown";

/** A host's feature map, or null while the answer is still on its way. */
export type HostFeatureMap = Readonly<Record<string, boolean>> | null | undefined;

/**
 * `unknown` means the flags have not been read yet; the caller renders nothing rather than
 * flashing an update prompt at a host that may be current.
 */
export function hostFeatureStatus(
  features: HostFeatureMap,
  feature: HostFeature,
): HostFeatureStatus {
  if (features == null) return "unknown";
  return features[feature] === true ? "available" : "unavailable";
}

/** True only once a feature is known to be missing, so a prompt cannot precede the answer. */
export function hostFeatureUnavailable(features: HostFeatureMap, feature: HostFeature): boolean {
  return hostFeatureStatus(features, feature) === "unavailable";
}
