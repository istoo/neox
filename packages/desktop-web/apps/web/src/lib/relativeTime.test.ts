import { afterEach, describe, expect, it } from "vitest";
import { setLanguagePreference } from "~/i18n";

import {
  formatRelativeTime,
  formatRelativeTimeAgo,
  formatSnoozeRemainingTime,
} from "./relativeTime";

afterEach(() => setLanguagePreference("system"));

it("formats complete time-ago phrases once in both languages", () => {
  const now = Date.parse("2026-10-02T12:00:00Z");
  setLanguagePreference("en");
  expect(formatRelativeTimeAgo("2026-10-02T11:55:00Z", now)).toBe("5m ago");
  expect(formatRelativeTimeAgo("2026-10-02T11:59:30Z", now)).toBe("just now");
  setLanguagePreference("zh-CN");
  expect(formatRelativeTimeAgo("2026-10-02T11:55:00Z", now)).toBe("5分钟前");
  expect(formatRelativeTimeAgo("2026-10-02T11:59:30Z", now)).toBe("刚刚");
});

it("localizes relative time and snooze countdowns without changing deadline values", () => {
  setLanguagePreference("zh-CN");
  const now = Date.parse("2026-10-02T12:00:00Z");
  expect(formatRelativeTime("2026-10-02T11:55:00Z", now)).toBe(
    new Intl.RelativeTimeFormat("zh-CN", { style: "short", numeric: "auto" }).format(-5, "minute"),
  );
  expect(formatSnoozeRemainingTime("2026-10-02T13:28:00Z", now)).toBe("剩余 1 小时 28 分钟");
});

describe("formatRelativeTime", () => {
  it('returns "now" for timestamps less than 1 minute ago', () => {
    const iso = new Date(Date.now() - 30_000).toISOString();
    expect(formatRelativeTime(iso)).toBe("now");
  });

  it("returns minutes for timestamps under an hour", () => {
    const iso = new Date(Date.now() - 5 * 60_000).toISOString();
    expect(formatRelativeTime(iso)).toBe("5m");
  });

  it("returns days for timestamps over a day", () => {
    const iso = new Date(Date.now() - 2 * 24 * 60 * 60_000).toISOString();
    expect(formatRelativeTime(iso)).toBe("2d");
  });

  it('returns "now" for future timestamps caused by clock skew', () => {
    const iso = new Date(Date.now() + 60_000).toISOString();
    expect(formatRelativeTime(iso)).toBe("now");
  });
});
