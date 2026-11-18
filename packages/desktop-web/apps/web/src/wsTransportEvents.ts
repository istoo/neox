// FILE: wsTransportEvents.ts
// Purpose: Web re-export of the DOM-free transport event hub in @synara/client-runtime.
// Layer: Web transport utility

export {
  SYNARA_WS_COMPATIBILITY_ISSUE_EVENT,
  SYNARA_WS_TRANSPORT_STATE_EVENT,
  addWsCompatibilityIssueListener,
  addWsTransportStateListener,
  emitWsCompatibilityIssue,
  emitWsTransportState,
  getWsSettlingThreadIds,
  readLatestWsCompatibilityIssue,
  readLatestWsTransportState,
  subscribeWsTurnSettlements,
  trackWsTurnSettlement,
  type WsCompatibilityIssueEventDetail,
  type WsTransportState,
  type WsTransportStateEventDetail,
} from "@synara/client-runtime/wsTransportEvents";
