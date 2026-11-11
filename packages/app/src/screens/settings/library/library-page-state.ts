import type { DaemonClient } from "@neolix/client/internal/daemon-client";
import type { LibraryProblem, LibrarySnapshot, LibrarySyncResult } from "@neolix/protocol/library";

export type LibraryPageState = "unsupported" | "disconnected" | "error" | "loading" | "ready";

/**
 * The library query is disabled while its host is offline, so the page must
 * render the disconnected notice instead of an unbounded spinner.
 */
export function resolveLibraryPageState(input: {
  supported: boolean;
  isConnected: boolean;
  error: Error | null;
  isLoading: boolean;
  library: LibrarySnapshot | null;
  client: DaemonClient | null;
}): LibraryPageState {
  if (!input.supported) {
    return "unsupported";
  }
  if (!input.isConnected) {
    return "disconnected";
  }
  if (input.error) {
    return "error";
  }
  if (input.isLoading || !input.library || !input.client) {
    return "loading";
  }
  return "ready";
}

/**
 * `own` problems mean the agent already has a skill by that name and the
 * library intentionally leaves it alone, so they are not save failures.
 */
export function firstReportableLibraryProblem(result: LibrarySyncResult): LibraryProblem | null {
  return result.problems.find((problem) => problem.own !== true) ?? null;
}
