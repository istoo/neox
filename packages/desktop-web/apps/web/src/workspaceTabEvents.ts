// FILE: workspaceTabEvents.ts
// Purpose: Window events the command palette uses to reach the focused chat surface for
//          thread-tab actions that own their dialogs/navigation there.
// Layer: UI events
// Exports: tab event names

export const WORKSPACE_RENAME_ACTIVE_TAB_EVENT = "neolix:rename-active-tab";
export const WORKSPACE_CLOSE_ACTIVE_TAB_EVENT = "neolix:close-active-tab";
/** The palette toggles a project pin; the sidebar owns the ref-backed optimistic state. */
export const WORKSPACE_TOGGLE_PIN_PROJECT_EVENT = "neolix:toggle-pin-project";
