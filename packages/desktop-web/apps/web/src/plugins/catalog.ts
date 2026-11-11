// FILE: catalog.ts
// Purpose: One shared read of the daemon's installed plugin catalog for every declarative
//          contribution surface (command palette, sidebar, composer, themes, timeline).
// Layer: Web plugin host
// Exports: catalog store, hooks, and the flattened contribution index.

import type { NeolixPlugin } from "@synara/contracts";
import { useEffect, useSyncExternalStore } from "react";

import { readNativeApi } from "~/nativeApi";

export interface PluginCatalogState {
  readonly status: "idle" | "loading" | "ready" | "error";
  readonly plugins: readonly NeolixPlugin[];
  readonly error: string | null;
}

const IDLE: PluginCatalogState = { status: "idle", plugins: [], error: null };

let state: PluginCatalogState = IDLE;
let inFlight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function publish(next: PluginCatalogState) {
  state = next;
  for (const listener of listeners) listener();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Loads the catalog once per connection. Safe to call from every consumer. */
export function ensurePluginCatalogLoaded(): void {
  if (state.status === "loading" || state.status === "ready") return;
  if (inFlight) return;
  const api = readNativeApi();
  if (!api?.neolix?.plugins) {
    publish({ status: "error", plugins: [], error: "Plugin catalog is unavailable." });
    return;
  }
  publish({ ...state, status: "loading", error: null });
  inFlight = api.neolix.plugins
    .list()
    .then((result) => {
      publish({ status: "ready", plugins: result.plugins, error: null });
    })
    .catch((error: unknown) => {
      publish({ status: "error", plugins: [], error: errorMessage(error) });
    })
    .finally(() => {
      inFlight = null;
    });
}

/** Drops the cached catalog so the next consumer reloads it after a lifecycle change. */
export function invalidatePluginCatalog(): void {
  inFlight = null;
  publish(IDLE);
}

export function readPluginCatalog(): PluginCatalogState {
  return state;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePluginCatalog(): PluginCatalogState {
  useEffect(() => {
    ensurePluginCatalogLoaded();
  }, []);
  return useSyncExternalStore(subscribe, readPluginCatalog, readPluginCatalog);
}

/** Plugins whose contributions are safe to execute: enabled and currently running. */
export function useRunningPlugins(): readonly NeolixPlugin[] {
  const catalog = usePluginCatalog();
  return catalog.plugins.filter((plugin) => plugin.enabled && plugin.status === "running");
}
