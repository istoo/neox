// FILE: viewStore.ts
// Purpose: Opens plugin web views from any surface (sidebar, command palette, composer pill,
//          iframe navigation) without adding a route for each declaration.
// Layer: Web plugin host
// Exports: openPluginView, closePluginView, usePluginViewTarget

import { create } from "zustand";

export interface PluginViewTarget {
  readonly pluginId: string;
  readonly viewId: string;
  readonly params?: Readonly<Record<string, string>> | undefined;
}

interface PluginViewStore {
  readonly target: PluginViewTarget | null;
  open(target: PluginViewTarget): void;
  close(): void;
}

const usePluginViewStore = create<PluginViewStore>((set) => ({
  target: null,
  open: (target) => set({ target }),
  close: () => set({ target: null }),
}));

export function openPluginView(target: PluginViewTarget): void {
  usePluginViewStore.getState().open(target);
}

export function closePluginView(): void {
  usePluginViewStore.getState().close();
}

export function usePluginViewTarget(): PluginViewTarget | null {
  return usePluginViewStore((state) => state.target);
}
