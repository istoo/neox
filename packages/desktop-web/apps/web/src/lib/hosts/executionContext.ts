// FILE: executionContext.ts
// Purpose: Web re-export of the React- and DOM-free implementation in @synara/client-runtime.
// Layer: Web environment context

export {
  executionKey,
  executionNamespace,
  initializeExecutionContext,
  readExecutionContext,
  type WindowExecutionContext,
} from "@synara/client-runtime/executionContext";
