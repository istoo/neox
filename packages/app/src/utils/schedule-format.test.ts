import type { ScheduleSummary } from "@neolix/protocol/schedule/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canRunScheduleNow,
  canToggleSchedulePause,
  describeCron,
  everyMsToParts,
  filterSchedulesForSidebar,
  formatCadence,
  formatNextRun,
  isNewAgentSchedule,
  matchesScheduleSearch,
  matchesScheduleStatusFilter,
  scheduleProductName,
  partsToEveryMs,
  resolveScheduleMenuActions,
  resolveScheduleTitle,
  validateCron,
} from "./schedule-format";

function createSchedule(input: {
  id?: string;
  name?: string | null;
  prompt?: string;
  title?: string | null;
  targetType?: "agent" | "new-agent";
  status?: "active" | "paused" | "completed";
  expiresAt?: string | null;
  createdAt?: string;
  serverName?: string;
}): ScheduleSummary & { serverName?: string } {
  return {
    id: input.id ?? "schedule-1",
    name: input.name ?? null,
    prompt: input.prompt ?? "Run the task",
    cadence: { type: "every", everyMs: 60_000 },
    target:
      input.targetType === "agent"
        ? { type: "agent", agentId: "00000000-0000-4000-8000-000000000000" }
        : {
            type: "new-agent",
            config: {
              provider: "codex",
              cwd: "/tmp/project",
              title: input.title,
            },
          },
    status: input.status ?? "active",
    createdAt: input.createdAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    nextRunAt: null,
    lastRunAt: null,
    pausedAt: null,
    expiresAt: input.expiresAt ?? null,
    maxRuns: null,
    ...(input.serverName ? { serverName: input.serverName } : {}),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("schedule title helpers", () => {
  it("identifies new-agent schedules", () => {
    expect(isNewAgentSchedule(createSchedule({ targetType: "new-agent" }))).toBe(true);
    expect(isNewAgentSchedule(createSchedule({ targetType: "agent" }))).toBe(false);
  });

  it("labels engine records by product meaning", () => {
    expect(scheduleProductName(createSchedule({ targetType: "new-agent" }))).toBe("Schedule");
    expect(scheduleProductName(createSchedule({ targetType: "agent" }))).toBe("Heartbeat");
  });

  it("resolves display titles by name, config title, prompt, then fallback", () => {
    expect(
      resolveScheduleTitle(createSchedule({ name: "Morning run", title: "Config title" })),
    ).toBe("Morning run");
    expect(resolveScheduleTitle(createSchedule({ name: " ", title: "Config title" }))).toBe(
      "Config title",
    );
    expect(
      resolveScheduleTitle(createSchedule({ name: " ", title: " ", prompt: "\nPrompt line" })),
    ).toBe("Prompt line");
    expect(resolveScheduleTitle(createSchedule({ name: " ", title: " ", prompt: "\n  " }))).toBe(
      "Untitled schedule",
    );
  });
});

describe("interval formatting", () => {
  it("round-trips interval parts and formats cadence labels", () => {
    expect(everyMsToParts(2 * 24 * 60 * 60_000)).toEqual({ value: 2, unit: "days" });
    expect(everyMsToParts(3 * 60 * 60_000)).toEqual({ value: 3, unit: "hours" });
    expect(everyMsToParts(90_000)).toEqual({ value: 2, unit: "minutes" });
    expect(everyMsToParts(0)).toEqual({ value: 1, unit: "hours" });

    expect(partsToEveryMs(2, "hours")).toBe(2 * 60 * 60_000);
    expect(partsToEveryMs(0, "minutes")).toBe(60_000);
    expect(formatCadence({ type: "every", everyMs: 2 * 60 * 60_000 })).toBe("Every 2 hours");
  });
});

describe("describeCron", () => {
  it("humanizes common fixed-time cron shapes", () => {
    expect(describeCron({ type: "cron", expression: "* * * * *" })).toBe("Every minute");
    expect(describeCron({ type: "cron", expression: "0 * * * *" })).toBe("Every hour");
    expect(describeCron({ type: "cron", expression: "15 * * * *" })).toBe("Every hour at :15");
    expect(describeCron({ type: "cron", expression: "0 9 * * *" })).toBe("Daily at 09:00 UTC");
    expect(describeCron({ type: "cron", expression: "0 9 * * 1-5" })).toBe("Weekdays at 09:00 UTC");
    expect(describeCron({ type: "cron", expression: "0 9 * * 0,6" })).toBe("Weekends at 09:00 UTC");
    expect(describeCron({ type: "cron", expression: "0 9 * * 1" })).toBe("Mondays at 09:00 UTC");
  });

  it("labels fixed-time cron cadences with their stored timezone", () => {
    expect(
      describeCron({
        type: "cron",
        expression: "0 9 * * *",
        timezone: "America/New_York",
      }),
    ).toBe("Daily at 09:00 America/New_York");
    expect(
      formatCadence({
        type: "cron",
        expression: "0 9 * * 1-5",
        timezone: "Europe/Madrid",
      }),
    ).toBe("Weekdays at 09:00 Europe/Madrid");
  });

  it("keeps timezone-less fixed-time cron cadences labeled as UTC", () => {
    expect(formatCadence({ type: "cron", expression: "0 9 * * *" })).toBe("Daily at 09:00 UTC");
  });

  it("returns null for invalid or unrecognized valid cron expressions", () => {
    expect(describeCron({ type: "cron", expression: "not a cron" })).toBeNull();
    expect(describeCron({ type: "cron", expression: "*/5 * * * *" })).toBeNull();
    expect(formatCadence({ type: "cron", expression: "0 9 * * *" })).toBe("Daily at 09:00 UTC");
  });
});

describe("validateCron", () => {
  it("accepts structurally valid cron expressions", () => {
    expect(validateCron("*/5 9-17 * 1,6 1-5")).toBeNull();
  });

  it("rejects step fields with extra slash tokens", () => {
    expect(validateCron("*/5/2 * * * *")).toBe("Invalid minute step");
  });

  it("rejects malformed fields with targeted messages", () => {
    expect(validateCron("")).toBe("Enter a cron expression");
    expect(validateCron("* * *")).toBe("Cron expressions must have 5 fields");
    expect(validateCron("60 * * * *")).toBe("Invalid minute value");
    expect(validateCron("* 24 * * *")).toBe("Invalid hour value");
    expect(validateCron("* * 31-1 * *")).toBe("Invalid day-of-month range");
    expect(validateCron("* * * */0 *")).toBe("Invalid month step");
    expect(validateCron("* * * * mon")).toBe("Invalid day-of-week value");
    expect(validateCron("5/2 * * * *")).toBe("Invalid minute step: use * or a range before /");
  });
});

describe("formatNextRun", () => {
  it("formats next-run distance from the current clock", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    expect(formatNextRun(null)).toBe("");
    expect(formatNextRun("not-a-date")).toBe("");
    expect(formatNextRun("2026-01-01T00:00:15.000Z")).toBe("soon");
    expect(formatNextRun("2026-01-01T00:30:00.000Z")).toBe("in 30m");
    expect(formatNextRun("2026-01-01T03:00:00.000Z")).toBe("in 3h");
    expect(formatNextRun("2026-01-03T00:00:00.000Z")).toBe("in 2d");
  });

  it("carries a rounded value across the unit boundary", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    expect(formatNextRun("2026-01-01T00:59:36.000Z")).toBe("in 1h");
    expect(formatNextRun("2026-01-01T23:36:00.000Z")).toBe("in 1d");
  });
});

describe("schedule action availability", () => {
  it("offers run-now only for runnable new-agent schedules", () => {
    const newAgent = createSchedule({ targetType: "new-agent" });
    expect(canRunScheduleNow(newAgent, "active")).toBe(true);
    expect(canRunScheduleNow(newAgent, "paused")).toBe(true);
    expect(canRunScheduleNow(newAgent, "expired")).toBe(false);
    expect(canRunScheduleNow(newAgent, "finished")).toBe(false);
    expect(canRunScheduleNow(newAgent, "targetGone")).toBe(false);
    expect(canRunScheduleNow(createSchedule({ targetType: "agent" }), "active")).toBe(false);
  });

  it("hides pause/resume once a schedule has ended", () => {
    expect(canToggleSchedulePause("active")).toBe(true);
    expect(canToggleSchedulePause("paused")).toBe(true);
    expect(canToggleSchedulePause("expired")).toBe(false);
    expect(canToggleSchedulePause("finished")).toBe(false);
    expect(canToggleSchedulePause("targetGone")).toBe(false);
  });

  it("keeps pause/resume for heartbeats while hiding run-now", () => {
    const heartbeat = createSchedule({ targetType: "agent" });
    expect(resolveScheduleMenuActions(heartbeat, "active")).toEqual({
      runNow: false,
      togglePause: true,
    });
    expect(resolveScheduleMenuActions(heartbeat, "paused")).toEqual({
      runNow: false,
      togglePause: true,
    });
    expect(resolveScheduleMenuActions(heartbeat, "finished")).toEqual({
      runNow: false,
      togglePause: false,
    });
  });
});

describe("sidebar schedule filters", () => {
  const now = Date.parse("2026-01-01T00:00:00.000Z");

  it("keeps paused schedules in the active view", () => {
    expect(matchesScheduleStatusFilter(createSchedule({ status: "paused" }), "active", now)).toBe(
      true,
    );
    expect(matchesScheduleStatusFilter(createSchedule({ status: "paused" }), "ended", now)).toBe(
      false,
    );
  });

  it("counts completed and expired schedules as ended", () => {
    expect(matchesScheduleStatusFilter(createSchedule({ status: "completed" }), "ended", now)).toBe(
      true,
    );
    expect(
      matchesScheduleStatusFilter(
        createSchedule({ status: "active", expiresAt: "2025-12-31T00:00:00.000Z" }),
        "ended",
        now,
      ),
    ).toBe(true);
    expect(
      matchesScheduleStatusFilter(
        createSchedule({ status: "active", expiresAt: "2026-01-02T00:00:00.000Z" }),
        "active",
        now,
      ),
    ).toBe(true);
  });

  it("matches titles, prompts, hosts and target paths, then sorts newest first", () => {
    const older = createSchedule({
      id: "older",
      name: "Nightly audit",
      createdAt: "2026-01-01T00:00:00.000Z",
      serverName: "Build host",
    });
    const newer = createSchedule({
      id: "newer",
      name: "Morning sync",
      prompt: "Publish the daily report",
      createdAt: "2026-01-02T00:00:00.000Z",
      serverName: "Laptop",
    });
    const schedules = [older, newer];

    expect(matchesScheduleSearch(older, "nightly")).toBe(true);
    expect(matchesScheduleSearch(newer, "daily report")).toBe(true);
    expect(matchesScheduleSearch(newer, "laptop")).toBe(true);
    expect(matchesScheduleSearch(newer, "missing")).toBe(false);
    expect(filterSchedulesForSidebar(schedules, "active", "").map((s) => s.id)).toEqual([
      newer.id,
      older.id,
    ]);
  });
});
