// FILE: expensiveReadRetry.ts
// Purpose: Web re-export of the React- and DOM-free implementation in @synara/client-runtime.
// Layer: Web data-fetching helpers

export {
  DEFAULT_RPC_CAPACITY_RETRY_MS,
  EXPENSIVE_READ_RETRY_OPTIONS,
  MAX_EXPENSIVE_READ_ERROR_REFETCH_INTERVAL_MS,
  MAX_UNARY_RPC_CAPACITY_RETRY_ATTEMPTS,
  RPC_CAPACITY_RETRY_LIMIT,
  UNARY_RPC_CAPACITY_QUEUE_WAIT_MS,
  expensiveReadErrorRefetchInterval,
  expensiveReadRetryDelay,
  getRpcCapacityRetryAfterMs,
  getUnaryRpcCapacityRetryDelayMs,
  isRpcCapacityExceededError,
  shouldRetryExpensiveRead,
} from "@synara/client-runtime/expensiveReadRetry";
