import { describe, expect, it } from "vitest";
import {
  resolveSchedulesScreenBodyState,
  shouldRenderScheduleHostErrors,
} from "./schedules-screen-state";

describe("resolveSchedulesScreenBodyState", () => {
  it("routes failed loading state to the retry UI instead of the spinner", () => {
    expect(
      resolveSchedulesScreenBodyState({
        loadState: { status: "loading" },
        showLoadError: true,
      }),
    ).toEqual({ kind: "load-error" });
  });

  it("renders the offline retry UI instead of the empty state", () => {
    expect(
      resolveSchedulesScreenBodyState({
        loadState: { status: "offline" },
        showLoadError: false,
      }),
    ).toEqual({ kind: "offline" });
  });
});

describe("shouldRenderScheduleHostErrors", () => {
  const error = { serverId: "host-a", serverName: "Host A", message: "boom" };

  it("shows the banner once the aggregate answered, even without any schedule", () => {
    expect(
      shouldRenderScheduleHostErrors({ bodyState: { kind: "empty" }, hostErrors: [error] }),
    ).toBe(true);
    expect(
      shouldRenderScheduleHostErrors({ bodyState: { kind: "content" }, hostErrors: [error] }),
    ).toBe(true);
  });

  it("never shows the banner while loading, offline, or with no failures", () => {
    expect(
      shouldRenderScheduleHostErrors({ bodyState: { kind: "loading" }, hostErrors: [error] }),
    ).toBe(false);
    expect(
      shouldRenderScheduleHostErrors({ bodyState: { kind: "offline" }, hostErrors: [error] }),
    ).toBe(false);
    expect(shouldRenderScheduleHostErrors({ bodyState: { kind: "content" }, hostErrors: [] })).toBe(
      false,
    );
  });
});
