import { describe, expect, it } from "vitest";

import {
  buildThreadMarkdown,
  isValidThreadExportId,
  threadExportFilename,
  type ThreadExportThread,
} from "./threadExport.ts";

const THREAD_ID = "8a1f0e6c-0d0e-4c64-9d61-1d2f6f9b7c11";

describe("thread export", () => {
  it("rejects ids that could name a path or an arbitrary lookup", () => {
    expect(isValidThreadExportId(THREAD_ID)).toBe(true);
    expect(isValidThreadExportId("mission_01-abc")).toBe(true);
    expect(isValidThreadExportId("../secret")).toBe(false);
    expect(isValidThreadExportId("/etc/passwd")).toBe(false);
    expect(isValidThreadExportId("a/b")).toBe(false);
    expect(isValidThreadExportId("")).toBe(false);
    expect(isValidThreadExportId("x".repeat(129))).toBe(false);
  });

  it("builds a filename from the title and strips path and header characters", () => {
    expect(threadExportFilename("排查 / 登录: 问题?", THREAD_ID)).toBe("排查 登录 问题.md");
    expect(threadExportFilename("  ", THREAD_ID)).toBe(`thread-${THREAD_ID}.md`);
    expect(threadExportFilename("a".repeat(200), THREAD_ID).length).toBe(83);
  });

  it("writes user, assistant and tool rows in time order", () => {
    const thread: ThreadExportThread = {
      title: "排查 登录",
      latestTurn: { state: "completed" },
      messages: [
        { role: "user", text: "Why does login fail?", createdAt: "2026-01-01T00:00:00.000Z" },
        { role: "assistant", text: "Checking.", createdAt: "2026-01-01T00:00:02.000Z" },
      ],
      activities: [
        {
          kind: "tool.completed",
          summary: "Bash",
          createdAt: "2026-01-01T00:00:01.000Z",
          payload: { title: "grep login", status: "completed", data: { toolCallId: "call-1" } },
        },
        {
          kind: "tool.started",
          summary: "Bash",
          createdAt: "2026-01-01T00:00:01.000Z",
          payload: { title: "grep login", status: "inProgress", data: { toolCallId: "call-1" } },
        },
      ],
    };

    const markdown = buildThreadMarkdown(thread, {
      threadId: THREAD_ID,
      exportedAt: new Date("2026-01-02T00:00:00.000Z"),
    });

    expect(markdown).toContain("# 排查 登录");
    expect(markdown).toContain("_Exported 2026-01-02T00:00:00.000Z_");
    expect(markdown.indexOf("## User")).toBeLessThan(markdown.indexOf("## Tool call"));
    expect(markdown.indexOf("## Tool call")).toBeLessThan(markdown.indexOf("## Assistant"));
    expect(markdown).toContain("grep login (completed)");
    // The running snapshot of the same call is deduplicated.
    expect(markdown.match(/## Tool call/gu)).toHaveLength(1);
  });
});
