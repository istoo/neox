// FILE: historyActions.ts
// Purpose: Cross-surface actions the History page asks the sidebar to run. The
//   import sheet and its target project already live in the sidebar, so the
//   history entry opens that surface instead of duplicating the flow.
// Layer: Web shell events

export const OPEN_IMPORT_THREAD_EVENT = "synara:open-import-thread";

/** The mounted sidebar opens its existing import sheet. */
export function requestImportThreadDialog(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(OPEN_IMPORT_THREAD_EVENT));
}
