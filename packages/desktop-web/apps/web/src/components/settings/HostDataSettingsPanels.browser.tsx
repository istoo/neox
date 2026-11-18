// FILE: HostDataSettingsPanels.browser.tsx
// Purpose: Browser characterization for external-session searching and its empty state.
// Layer: Browser UI test

import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const harness = vi.hoisted(() => ({
  sessionsQueryOptions: null as null | Record<string, unknown>,
  data: {
    partial: undefined as boolean | undefined,
    agents: [{ agent: "pi", name: "Pi", count: 2, deletable: true }],
    agent: "pi",
    sessions: [
      {
        id: "session-1",
        agent: "pi",
        cwd: "/tmp/qa-settings",
        title: "First session",
        start: "2026-01-01T00:00:00.000Z",
        last: "2026-01-02T00:00:00.000Z",
        messages: 3,
        size: 1024,
        cost: 0,
        priced: false,
        resume: "",
        path: "/tmp/session-1.json",
        deletable: true,
      },
      {
        id: "session-2",
        agent: "pi",
        cwd: "/tmp/qa-settings",
        title: "Second session",
        start: "2026-01-01T00:00:00.000Z",
        last: "2026-01-03T00:00:00.000Z",
        messages: 1,
        size: 512,
        cost: 0,
        priced: false,
        resume: "",
        path: "/tmp/session-2.json",
        deletable: true,
      },
    ],
    trash: [],
    trashDir: "",
    home: "/tmp/qa-settings-home",
    recording: false,
    recorded: false,
    error: null,
  },
  search: vi.fn(async () => ({
    hits: [],
    searched: 2,
    total: 2,
    cut: false,
    error: null,
  })),
  invalidateQueries: vi.fn(async () => {}),
  transcript: {
    source: "provider",
    total: 2,
    error: null,
    parts: [
      { role: "assistant", kind: "reviewer_transcript", text: "same text" },
      { role: "assistant", kind: "reviewer_transcript", text: "same text" },
    ],
  },
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey: readonly string[] }) => {
    if (options.queryKey[0] === "neolix-external-sessions") {
      harness.sessionsQueryOptions = options as unknown as Record<string, unknown>;
      return { data: harness.data, isLoading: false, isFetching: false, refetch: vi.fn() };
    }
    if (options.queryKey[0] === "neolix-external-transcript") {
      return { data: harness.transcript, isLoading: false, isFetching: false };
    }
    return { data: undefined, isLoading: false };
  },
  useQueryClient: () => ({ invalidateQueries: harness.invalidateQueries }),
  useMutation: () => ({ isPending: false, mutateAsync: vi.fn() }),
  useQueries: () => [],
}));

vi.mock("~/lib/neolixHostApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/neolixHostApi")>();
  return {
    ...actual,
    listExternalSessions: vi.fn(async () => harness.data),
    searchExternalSessions: harness.search,
  };
});

vi.mock("~/nativeApi", () => ({
  readNativeApi: () => null,
  ensureNativeApi: () => ({ dialogs: { confirm: vi.fn(async () => true) } }),
}));

import { HostSessionsSettingsPanel } from "./HostDataSettingsPanels";

describe("HostSessionsSettingsPanel", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    harness.data.partial = undefined;
    harness.sessionsQueryOptions = null;
    harness.search.mockClear();
    harness.invalidateQueries.mockClear();
  });

  it("shows an empty result and keeps the list filtered when a search has no hits", async () => {
    await render(<HostSessionsSettingsPanel active />);

    await vi.waitFor(() => expect(document.body.textContent).toContain("First session"));
    expect(document.body.textContent).toContain("Second session");

    await page.getByPlaceholder("Search text").fill("zzzzqqqq");
    await page.getByRole("button", { name: "Search", exact: true }).click();

    await vi.waitFor(() => expect(harness.search).toHaveBeenCalledWith("pi", "zzzzqqqq"));
    await vi.waitFor(() => expect(document.body.textContent).toContain("No sessions matched"));
    expect(document.body.textContent).not.toContain("First session");
    expect(document.body.textContent).not.toContain("Second session");

    await page.getByRole("button", { name: "Clear", exact: true }).click();
    await vi.waitFor(() => expect(document.body.textContent).toContain("First session"));
  });

  it("keys provider session rows and repeated transcript parts without collisions", async () => {
    // Provider session ids are file names and repeat across directories; the
    // transcript has no ids at all, so two identical turns are legitimate.
    harness.data.sessions = [
      { ...harness.data.sessions[0]!, id: "session", path: "/tmp/one/session.json" },
      { ...harness.data.sessions[1]!, id: "session", path: "/tmp/two/session.json" },
    ];
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await render(<HostSessionsSettingsPanel active />);
    await vi.waitFor(() => expect(document.body.textContent).toContain("First session"));

    await page.getByRole("button", { name: "Read", exact: true }).first().click();
    await vi.waitFor(() => expect(document.querySelectorAll("p").length).toBeGreaterThanOrEqual(2));

    expect(errorSpy.mock.calls.some((call) => String(call[0]).includes("same key"))).toBe(false);
    errorSpy.mockRestore();
  });

  it("says it is still counting and shows no final message counts while partial", async () => {
    harness.data.partial = true;

    await render(<HostSessionsSettingsPanel active />);

    await vi.waitFor(() => expect(document.body.textContent).toContain("First session"));
    expect(document.body.textContent).toContain("Counting messages and usage…");
    expect(document.body.textContent).toContain("Counting messages…");
    expect(document.body.textContent).not.toContain("3 messages");
  });

  it("shows the final counts and drops the counting state once the list is complete", async () => {
    harness.data.partial = true;
    const screen = await render(<HostSessionsSettingsPanel active />);
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain("Counting messages and usage…"),
    );

    harness.data.partial = false;
    await screen.rerender(<HostSessionsSettingsPanel active />);

    await vi.waitFor(() =>
      expect(document.body.textContent).not.toContain("Counting messages and usage…"),
    );
    expect(document.body.textContent).not.toContain("Counting messages…");
    expect(document.body.textContent).toContain("3 messages");
  });

  it("backs off to a 15 second poll and keeps asking while the list is partial", async () => {
    harness.data.partial = true;
    await render(<HostSessionsSettingsPanel active />);
    await vi.waitFor(() => expect(harness.sessionsQueryOptions).not.toBeNull());

    const options = harness.sessionsQueryOptions as {
      refetchInterval: (query: {
        state: { data: { partial?: boolean }; dataUpdateCount: number };
      }) => number | false;
      refetchIntervalInBackground: boolean;
    };
    const delay = (dataUpdateCount: number, partial = true): number | false =>
      options.refetchInterval({
        state: { data: { ...harness.data, partial }, dataUpdateCount },
      });

    expect(options.refetchIntervalInBackground).toBe(false);
    expect(delay(1)).toBe(1_500);
    expect(delay(2)).toBe(3_000);
    expect(delay(3)).toBe(6_000);
    expect(delay(4)).toBe(12_000);
    expect(delay(5)).toBe(15_000);
    // Past the last step it keeps the slow poll, never settles on partial data.
    expect(delay(30)).toBe(15_000);
    expect(delay(30, false)).toBe(false);
  });
});
