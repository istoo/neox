// FILE: wsTransport.ts
// Purpose: Bind the DOM-free transport in @synara/client-runtime to this browser frame.
// Layer: Web transport
// Exports: every transport symbol, re-exported unchanged for existing import paths.

import { browserProductRpcActivity } from "@synara/client-runtime/transportPlatform";
import {
  setTransportPlatform,
  type RpcActivityEvent,
  type TransportPlatform,
} from "@synara/client-runtime/transportPlatform";
import { trackWsTurnSettlement } from "@synara/client-runtime/wsTransportEvents";

import { APP_VERSION } from "./branding";
import { localizeRpcError } from "./i18n/errors";
import { readWorkspaceFrame } from "./lib/hosts/workspaceFrame";
import { ProductTurnObserver, trackProductAnalytics } from "./lib/productAnalytics";
import { recordRendererActivity, rendererRpcActivity } from "./lib/rendererErrorDiagnostics";

const webPlatform: TransportPlatform = {
  timers: {
    setTimeout: (handler, ms) => window.setTimeout(handler, ms),
    clearTimeout: (handle) => window.clearTimeout(handle),
  },
  resolveSocketBase: (explicitUrl) => {
    if (explicitUrl) return explicitUrl;
    const bridgeUrl = readWorkspaceFrame()?.controllerWsUrl ?? window.desktopBridge?.getWsUrl();
    const envUrl = import.meta.env.VITE_WS_URL as string | undefined;
    return bridgeUrl && bridgeUrl.length > 0
      ? bridgeUrl
      : envUrl && envUrl.length > 0
        ? envUrl
        : `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.hostname}:${window.location.port}`;
  },
  appVersion: APP_VERSION,
  localizeRpcError,
  onRpcActivity: (event: RpcActivityEvent) => {
    const activity = rendererRpcActivity(event.method, event.params);
    if (activity)
      recordRendererActivity(activity, event.phase === "started" ? "started" : event.phase);
    const productActivity = browserProductRpcActivity(event.method, event.params);
    if (!productActivity || event.phase === "started") return;
    const durationMs = Math.round(performance.now() - event.startedAt);
    if (event.phase === "succeeded") {
      trackProductAnalytics({
        ...productActivity,
        outcome: "succeeded",
        mode: event.mode,
        ...(productActivity.event === "feature.used" ? {} : { durationMs }),
      });
      return;
    }
    const cancelled = event.cancelled === true;
    trackProductAnalytics({
      ...productActivity,
      outcome: cancelled ? "cancelled" : "failed",
      mode: event.mode,
      ...(productActivity.event === "feature.used" ? {} : { durationMs }),
      ...(cancelled || productActivity.event === "feature.used"
        ? {}
        : { reason: event.failureReason ?? "other" }),
    });
  },
  analytics: {
    rendererRpcActivity,
    recordRendererActivity,
    productRpcActivity: browserProductRpcActivity,
    track: trackProductAnalytics,
    createTurnObserver: () => new ProductTurnObserver(),
  },
  trackTurnSettlement: trackWsTurnSettlement,
};

setTransportPlatform(webPlatform);

export {
  MAX_PROJECT_FILE_WATCH_RETRY_ATTEMPTS,
  MAX_RESNAPSHOT_RETRY_ATTEMPTS,
  MAX_STREAM_DUPLICATE_RETRY_ATTEMPTS,
  MAX_THREAD_SNAPSHOT_BOOTSTRAP_RETRY_ATTEMPTS,
  MAX_UNARY_RPC_CAPACITY_RETRY_ATTEMPTS,
  RemoteConnectionUnavailableError,
  SNAPSHOT_FAULT_RETRY_MS,
  WsTransport,
  WsTransportRequestInterruptedError,
  getProjectFileWatchRetryDelayMs,
  getReconnectRetryDelayMs,
  getResnapshotRetryDelayMs,
  getSnapshotFaultRetryDelayMs,
  getStreamCapacityRetryDelayMs,
  getStreamDuplicateRetryDelayMs,
  getTerminalCompatibilityError,
  getThreadSnapshotBootstrapRetryDelayMs,
  getUnexpectedStreamCompletionRetryDelayMs,
  getUnaryRpcCapacityRetryDelayMs,
  isRuntimeInterruptFailure,
  isServerLifecyclePushChannel,
  isTerminalCompatibilityFailure,
  makeFeatureSocketUrl,
  makeNegotiateHttpUrl,
  makeRequestAbortScope,
  makeSocketUrl,
  projectFileChangeStreamKey,
  rawSocketUrl,
  resolveStreamAdmissionRetry,
  serverIdentityChanged,
  shouldKeepServerLifecycleStream,
  shouldReconnectAfterStreamFailure,
  threadStreamInputsEqual,
  workspaceSetupStreamKey,
  type StreamAdmissionRetry,
  type WsRequestOptions,
  type WsShellStreamFailure,
  type WsThreadStreamFailure,
} from "@synara/client-runtime/wsTransport";
