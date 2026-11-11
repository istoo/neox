import { describe, expect, it } from "vitest";

import {
  canDeleteSessions,
  groupTitleOf,
  isCollectorEndpoint,
  parseDaemonPort,
} from "./hostSettingsValidation";

describe("hostSettingsValidation", () => {
  it("accepts only the daemon port range the dialog offers", () => {
    expect(parseDaemonPort(" 6768 ")).toBe(6768);
    expect(parseDaemonPort("1024")).toBe(1024);
    expect(parseDaemonPort("65535")).toBe(65535);
    expect(parseDaemonPort("0")).toBeNull();
    expect(parseDaemonPort("1023")).toBeNull();
    expect(parseDaemonPort("65536")).toBeNull();
    expect(parseDaemonPort("12x")).toBeNull();
  });

  it("accepts an http(s) collector endpoint with a host", () => {
    expect(isCollectorEndpoint("http://127.0.0.1:4318/v1/traces")).toBe(true);
    expect(isCollectorEndpoint("https://collector.example.com")).toBe(true);
    expect(isCollectorEndpoint("ftp://collector.example.com")).toBe(false);
    expect(isCollectorEndpoint("not a url")).toBe(false);
    expect(isCollectorEndpoint("")).toBe(false);
  });

  it("falls back to a localized title for an unrecorded cwd", () => {
    expect(groupTitleOf("/work/project", "Unknown folder")).toBe("/work/project");
    expect(groupTitleOf("   ", "Unknown folder")).toBe("Unknown folder");
  });

  it("allows a selection to be deleted only when every session is deletable", () => {
    expect(canDeleteSessions([])).toBe(false);
    expect(canDeleteSessions([{ deletable: true }])).toBe(true);
    expect(canDeleteSessions([{ deletable: true }, { deletable: false }])).toBe(false);
  });
});
