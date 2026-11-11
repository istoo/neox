// FILE: workspaceFocusModeStore.ts
// Purpose: App-level focus mode: hide both sidebars and show only the focused split pane.
// Layer: UI state store
// Exports: useWorkspaceFocusModeStore
//
// Focus mode is intentionally not persisted: it is a transient viewing state, and
// restoring it on launch would strand a new session without its sidebars.

import { create } from "zustand";

interface WorkspaceFocusModeStore {
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
  toggle: () => void;
}

export const useWorkspaceFocusModeStore = create<WorkspaceFocusModeStore>()((set, get) => ({
  enabled: false,
  setEnabled: (enabled) => {
    if (get().enabled !== enabled) set({ enabled });
  },
  toggle: () => set((state) => ({ enabled: !state.enabled })),
}));
