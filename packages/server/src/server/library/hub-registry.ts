import type { LibraryHub } from "./hub.js";

/**
 * The gateway serves the MCP hub and the library runs its servers; both
 * live in the daemon, so the gateway asks this registry rather than going
 * over HTTP.
 */
let provider: LibraryHub | null = null;

export function setLibraryHub(next: LibraryHub | null): void {
  provider = next;
}

export function getLibraryHub(): LibraryHub | null {
  return provider;
}
