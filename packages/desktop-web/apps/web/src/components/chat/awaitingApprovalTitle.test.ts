import { beforeEach, describe, expect, it } from "vitest";

import { APP_DISPLAY_NAME } from "~/branding";

import {
  resetAwaitingApprovalTitleForTests,
  setThreadAwaitingApproval,
  syncAwaitingApprovalTitle,
} from "./awaitingApprovalTitle";

const translate = (key: string) => (key === "chat:timeline_awaitingApproval" ? "等待批准" : key);

describe("awaiting approval document title", () => {
  beforeEach(() => {
    resetAwaitingApprovalTitleForTests();
  });

  it("shows the approval title while a thread is blocked and restores the app name after", () => {
    const doc = { title: APP_DISPLAY_NAME };
    setThreadAwaitingApproval("thread-a", true, doc, translate);
    expect(doc.title).toBe("等待批准");
    setThreadAwaitingApproval("thread-a", false, doc, translate);
    expect(doc.title).toBe(APP_DISPLAY_NAME);
  });

  it("keeps the approval title while any other pane still waits", () => {
    const doc = { title: APP_DISPLAY_NAME };
    setThreadAwaitingApproval("thread-a", true, doc, translate);
    setThreadAwaitingApproval("thread-b", true, doc, translate);
    setThreadAwaitingApproval("thread-a", false, doc, translate);
    expect(doc.title).toBe("等待批准");
    setThreadAwaitingApproval("thread-b", false, doc, translate);
    expect(doc.title).toBe(APP_DISPLAY_NAME);
  });

  it("ignores clearing a thread that was never waiting", () => {
    const doc = { title: APP_DISPLAY_NAME };
    setThreadAwaitingApproval("thread-a", false, doc, translate);
    expect(doc.title).toBe(APP_DISPLAY_NAME);
    syncAwaitingApprovalTitle(doc, translate);
    expect(doc.title).toBe(APP_DISPLAY_NAME);
  });
});
