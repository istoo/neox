import type { LibraryBackup, StoredMcpServer } from "./store.js";
import type { LibraryAgentTarget } from "./paths.js";

/** One thing the library could not write into an agent, and why. */
export interface LibraryProblem {
  agent: string;
  /** `instructions`, `mcp:<name>`, `skill:<name>`, `hook:<name>`, `subagent:<name>`. */
  what: string;
  error: string;
}

export interface LibrarySyncResult {
  changed: string[];
  problems: LibraryProblem[];
  backup?: string;
}

export interface AgentSyncContext {
  target: LibraryAgentTarget;
  backup: LibraryBackup;
  result: LibrarySyncResult;
  /** The one entry the hub replaces this agent's servers with, when it is on. */
  hubServer?: StoredMcpServer;
}

export function markChanged(result: LibrarySyncResult, agent: string): void {
  if (!result.changed.includes(agent)) {
    result.changed.push(agent);
  }
}

export function fail(
  result: LibrarySyncResult,
  agent: string,
  what: string,
  error: unknown,
  own = false,
): void {
  result.problems.push({
    agent,
    what,
    error: error instanceof Error ? error.message : String(error),
    ...(own ? { own: true } : {}),
  });
}
