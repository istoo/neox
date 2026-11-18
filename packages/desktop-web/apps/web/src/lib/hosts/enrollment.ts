// FILE: enrollment.ts
// Purpose: Web re-export of the React- and DOM-free implementation in @synara/client-runtime.
// Layer: Web remote-access feature logic

export {
  DEVICE_USER_CODE_GROUP_SIZE,
  DEVICE_USER_CODE_LENGTH,
  formatDeviceUserCode,
  formatUnambiguousCode,
  isCompleteDeviceUserCode,
  normalizeDeviceUserCode,
  normalizeUnambiguousCode,
  shouldPromptForDiscoverability,
  type DiscoverabilityPromptDecision,
  type HostEnrollment,
} from "@synara/client-runtime/enrollment";
