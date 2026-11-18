// FILE: rpcTransportFailure.ts
// Purpose: Web re-export of the React- and DOM-free implementation in @synara/client-runtime.
// Layer: Web transport helpers

export {
  classifyRpcTransportFailure,
  describeTransportFailureForDiagnostics,
  formatTransportFailureMessage,
  isRequestNotSent,
  markRequestNotSent,
  nextTransportFailureRef,
  type RpcTransportFailure,
  type RpcTransportFailureDelivery,
  type RpcTransportFailureReason,
} from "@synara/client-runtime/rpcTransportFailure";
