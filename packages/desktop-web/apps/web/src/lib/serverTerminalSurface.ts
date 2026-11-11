// FILE: serverTerminalSurface.ts
// Purpose: Opens terminal-first threads as terminal pages on clients that did not create them.
// Layer: Web terminal state glue
// Exports: adoptServerTerminalSurfaces
// Why: The terminal/chat surface lives in this client's terminal store. A thread created from
//      "New terminal" on another device (or before this browser's storage was cleared) would
//      otherwise open as an empty chat. The server's mark is adopted once per thread, so a user
//      who later turns the thread back into a chat keeps that choice.

import type { ThreadId } from "@synara/contracts";
import * as Schema from "effect/Schema";

import { getLocalStorageItem, setLocalStorageItem } from "../hooks/useLocalStorage";
import { useTerminalStateStore } from "../terminalStateStore";

const ADOPTED_KEY = "neolix:adopted-terminal-surfaces";
const AdoptedThreadIds = Schema.Array(Schema.String);

interface ServerThreadSurface {
  readonly id: ThreadId;
  readonly primarySurface?: "chat" | "terminal" | undefined;
}

function readAdopted(): Set<string> {
  try {
    return new Set(getLocalStorageItem(ADOPTED_KEY, AdoptedThreadIds) ?? []);
  } catch {
    // A corrupt entry only means a terminal thread may be adopted again.
    return new Set();
  }
}

/**
 * `complete` is true for a full shell snapshot: adopted ids of threads it no longer lists are
 * dropped so the stored set stays bounded by the live thread list.
 */
export function adoptServerTerminalSurfaces(
  threads: readonly ServerThreadSurface[],
  options: { readonly complete: boolean },
): void {
  const adopted = readAdopted();
  const listed = options.complete ? new Set<string>(threads.map((thread) => thread.id)) : null;
  const next = listed ? new Set([...adopted].filter((id) => listed.has(id))) : new Set(adopted);
  const terminalStore = useTerminalStateStore.getState();
  for (const thread of threads) {
    if (thread.primarySurface !== "terminal" || next.has(thread.id)) continue;
    next.add(thread.id);
    if (terminalStore.terminalStateByThreadId[thread.id] === undefined) {
      terminalStore.openTerminalThreadPage(thread.id, { terminalOnly: true });
    }
  }
  if (next.size !== adopted.size || [...next].some((id) => !adopted.has(id))) {
    setLocalStorageItem(ADOPTED_KEY, [...next], AdoptedThreadIds);
  }
}
