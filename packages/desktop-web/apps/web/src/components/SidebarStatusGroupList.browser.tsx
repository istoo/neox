// FILE: SidebarStatusGroupList.browser.tsx
// Purpose: Feeds five thread states through the status grouping and asserts the section
//          titles and their order in the rendered sidebar surface.
// Layer: Browser UI test

import "../index.css";

import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { t } from "~/i18n";
import {
  groupSidebarThreadsByStatus,
  resolveSidebarStatusBucket,
  SIDEBAR_STATUS_BUCKET_LABEL_KEYS,
  type ThreadStatusPill,
} from "./Sidebar.logic";
import { SidebarStatusGroupList } from "./SidebarStatusGroupList";
import { SidebarProvider } from "./ui/sidebar";

type FixtureThread = {
  readonly id: string;
  readonly status: ThreadStatusPill | null;
  readonly sessionStatus?: string | null;
};

function pill(label: string): ThreadStatusPill {
  return {
    label,
    colorClass: "text-muted-foreground",
    dotClass: "bg-muted-foreground",
    pulse: false,
  } as ThreadStatusPill;
}

describe("sidebar status grouping surface", () => {
  it("renders the five status buckets in actionable-first order", async () => {
    const threads: FixtureThread[] = [
      { id: "done-thread", status: null },
      { id: "working-thread", status: pill("Working") },
      { id: "needs-input-thread", status: pill("Pending Approval") },
      { id: "failed-thread", status: null, sessionStatus: "error" },
      { id: "review-thread", status: pill("Completed") },
    ];

    const groups = groupSidebarThreadsByStatus({
      threads,
      bucketFor: (thread) =>
        resolveSidebarStatusBucket({
          status: thread.status,
          sessionStatus: thread.sessionStatus ?? null,
        }),
      labels: {
        needs_input: t(SIDEBAR_STATUS_BUCKET_LABEL_KEYS.needs_input),
        failed: t(SIDEBAR_STATUS_BUCKET_LABEL_KEYS.failed),
        attention: t(SIDEBAR_STATUS_BUCKET_LABEL_KEYS.attention),
        running: t(SIDEBAR_STATUS_BUCKET_LABEL_KEYS.running),
        done: t(SIDEBAR_STATUS_BUCKET_LABEL_KEYS.done),
      },
    });

    const mounted = await render(
      <SidebarProvider>
        <div className="w-80">
          <SidebarStatusGroupList
            groups={groups}
            emptyLabel="No threads"
            renderThreadRow={(thread) => (
              <div key={thread.id} data-testid={`row-${thread.id}`}>
                {thread.id}
              </div>
            )}
          />
        </div>
      </SidebarProvider>,
    );

    const labels = [...document.querySelectorAll("[data-testid^='status-group-label-']")].map(
      (element) => element.textContent,
    );
    expect(labels).toEqual([
      t("workspace:statusBucket_needsInput"),
      t("workspace:statusBucket_failed"),
      t("workspace:statusBucket_readyToReview"),
      t("workspace:statusBucket_working"),
      t("workspace:statusBucket_done"),
    ]);
    expect(labels).toHaveLength(5);

    const rows = [...document.querySelectorAll("[data-testid^='row-']")].map((element) =>
      element.getAttribute("data-testid"),
    );
    expect(rows).toEqual([
      "row-needs-input-thread",
      "row-failed-thread",
      "row-review-thread",
      "row-working-thread",
      "row-done-thread",
    ]);
    await expect.element(mounted.getByTestId("workspace-status-group-list")).toBeVisible();
  });
});
