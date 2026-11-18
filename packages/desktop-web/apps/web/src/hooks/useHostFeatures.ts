// FILE: useHostFeatures.ts
// Purpose: Read the connected host's `server_info.features` once and refetch it whenever the
//          execution transport opens again, so a host restart or reconnect is picked up.
// Layer: Web hook

import { useQuery } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";

import { getHostFeatures } from "~/lib/neolixHostApi";
import {
  hostFeatureStatus,
  type HostFeature,
  type HostFeatureMap,
  type HostFeatureStatus,
} from "~/lib/hostFeatures.logic";
import { addWsTransportStateListener } from "~/wsTransportEvents";
import { onNeolixHostFeaturesUpdated } from "~/wsNativeApi";

export const HOST_FEATURES_QUERY_KEY = ["neolix-host", "features"] as const;

/**
 * One listener per module, not per component: reconnect bumps a counter every consumer reads,
 * so N mounted gates still issue one refetch rather than one each.
 */
let connectionEpoch = 0;
const epochListeners = new Set<() => void>();
let stopListening: (() => void) | undefined;
let stopFeatureListening: (() => void) | undefined;

function advanceConnectionEpoch(): void {
  connectionEpoch += 1;
  for (const notify of epochListeners) notify();
}

function subscribeToReconnect(listener: () => void): () => void {
  epochListeners.add(listener);
  stopListening ??= addWsTransportStateListener((state) => {
    if (state !== "open") return;
    advanceConnectionEpoch();
  });
  // A host daemon can restart under a bridge session that never closes, so its socket
  // staying open is not evidence the flags are current. The bridge re-announces them.
  stopFeatureListening ??= onNeolixHostFeaturesUpdated(advanceConnectionEpoch);
  return () => {
    epochListeners.delete(listener);
    if (epochListeners.size === 0) {
      stopListening?.();
      stopListening = undefined;
      stopFeatureListening?.();
      stopFeatureListening = undefined;
    }
  };
}

function readConnectionEpoch(): number {
  return connectionEpoch;
}

export interface HostFeaturesController {
  /** Null until the host answers; an error reads as an empty map so its gates show the prompt. */
  readonly features: HostFeatureMap;
  readonly isLoading: boolean;
  readonly error: Error | null;
  readonly featureStatus: (feature: HostFeature) => HostFeatureStatus;
  readonly isAvailable: (feature: HostFeature) => boolean;
}

export function useHostFeatures(): HostFeaturesController {
  const epoch = useSyncExternalStore(
    subscribeToReconnect,
    readConnectionEpoch,
    readConnectionEpoch,
  );
  const query = useQuery({
    queryKey: [...HOST_FEATURES_QUERY_KEY, epoch],
    queryFn: getHostFeatures,
    // The flags only change with the connection or a daemon restart; a focus refetch also
    // catches one that reconnected behind a surviving bridge session.
    staleTime: 0,
    retry: false,
  });
  // No answer yet (loading or a failed read) stays unknown: a prompt needs a host that
  // actually answered without the flag.
  const features: HostFeatureMap = query.data?.features ?? null;
  const error = query.error instanceof Error ? query.error : null;

  return {
    features,
    isLoading: query.isPending,
    error,
    featureStatus: (feature) => hostFeatureStatus(features, feature),
    isAvailable: (feature) => hostFeatureStatus(features, feature) === "available",
  };
}
