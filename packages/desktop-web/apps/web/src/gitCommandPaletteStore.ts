// FILE: gitCommandPaletteStore.ts
// Purpose: Lets the mounted GitActionsControl publish its current menu (commit, push,
//          commit & push, PR) to the command palette, so the palette reuses the control's
//          git state and dialog flows instead of re-implementing them.
// Layer: UI state store
// Exports: useGitCommandPaletteStore

import type { ThreadId } from "@synara/contracts";
import { create } from "zustand";

export interface GitPaletteCommand {
  id: string;
  label: string;
  disabled: boolean;
  run: () => void;
}

interface GitCommandPaletteStore {
  commandsByThreadId: Record<string, readonly GitPaletteCommand[] | undefined>;
  setCommands: (threadId: ThreadId, commands: readonly GitPaletteCommand[]) => void;
  clearCommands: (threadId: ThreadId) => void;
}

export const useGitCommandPaletteStore = create<GitCommandPaletteStore>()((set) => ({
  commandsByThreadId: {},
  setCommands: (threadId, commands) =>
    set((state) => ({
      commandsByThreadId: { ...state.commandsByThreadId, [threadId]: commands },
    })),
  clearCommands: (threadId) =>
    set((state) => {
      if (!Object.hasOwn(state.commandsByThreadId, threadId)) return state;
      const next = { ...state.commandsByThreadId };
      delete next[threadId];
      return { commandsByThreadId: next };
    }),
}));
