import type { DaemonClient } from "@neolix/client/internal/daemon-client";
import type { LibrarySnapshot } from "@neolix/protocol/library";
import { describe, expect, it } from "vitest";
import {
  firstReportableLibraryProblem,
  resolveLibraryPageState,
  type LibraryPageState,
} from "./library-page-state";

const LIBRARY = {} as LibrarySnapshot;
const CLIENT = {} as DaemonClient;

function resolve(overrides: Partial<Parameters<typeof resolveLibraryPageState>[0]> = {}) {
  return resolveLibraryPageState({
    supported: true,
    isConnected: true,
    error: null,
    isLoading: false,
    library: LIBRARY,
    client: CLIENT,
    ...overrides,
  });
}

describe("resolveLibraryPageState", () => {
  it("reports disconnected when the host is offline instead of spinning forever", () => {
    const state: LibraryPageState = resolve({
      isConnected: false,
      isLoading: true,
      library: null,
    });
    expect(state).toBe("disconnected");
  });

  it("keeps unsupported and load errors ahead of the connection state", () => {
    expect(resolve({ supported: false, isConnected: false })).toBe("unsupported");
    expect(resolve({ error: new Error("boom") })).toBe("error");
  });

  it("loads until the snapshot and client are both available", () => {
    expect(resolve({ isLoading: true })).toBe("loading");
    expect(resolve({ library: null })).toBe("loading");
    expect(resolve({ client: null })).toBe("loading");
    expect(resolve()).toBe("ready");
  });
});

describe("firstReportableLibraryProblem", () => {
  it("ignores own-skill notices so they do not toast as save failures", () => {
    expect(
      firstReportableLibraryProblem({
        changed: [],
        problems: [{ agent: "claude", what: "skill:review", error: "kept its own", own: true }],
      }),
    ).toBeNull();
  });

  it("returns the first real problem after skipping own-skill notices", () => {
    const failure = { agent: "codex", what: "skill:review", error: "permission denied" };
    expect(
      firstReportableLibraryProblem({
        changed: [],
        problems: [
          { agent: "claude", what: "skill:review", error: "kept its own", own: true },
          failure,
        ],
      }),
    ).toEqual(failure);
  });
});
