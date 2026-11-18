// FILE: SidebarHostFilter.browser.tsx
// Purpose: Verifies the display-options host filter narrows connected-host rows to the
//          selected host and restores them when cleared.
// Layer: Browser UI test

import "../index.css";

import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";

import { DEFAULT_SIDEBAR_ROW_ITEMS } from "../appSettings";
import { filterWorkspaceSessionsByHostFilters } from "../lib/hosts/workspaceSidebar";
import type { WorkspaceSession } from "../lib/hosts/workspaceSessions";
import { SidebarDisplayOptionsMenu } from "./SidebarDisplayOptionsMenu";

function session(environmentId: string, hostName: string): WorkspaceSession {
  return {
    host: {
      hostId: environmentId,
      hostName,
      wsPath: `/rpc/remote/${environmentId}`,
      executionScope: {
        environmentId,
        accountAuthority: "https://account.example.test",
        userId: "fixture-owner",
        organizationId: "fixture-org",
        channel: "beta",
      },
    },
  };
}

const SESSIONS = [session("env-a", "Computer A"), session("env-b", "Computer B")];

function HostFilterHarness() {
  const [hostFilters, setHostFilters] = useState<readonly string[]>([]);
  const visible = filterWorkspaceSessionsByHostFilters(SESSIONS, hostFilters);
  return (
    <div>
      <SidebarDisplayOptionsMenu
        groupBy="project"
        onGroupByChange={() => {}}
        threadSortOrder="updated_at"
        onThreadSortOrderChange={() => {}}
        threadAttentionFirst
        onThreadAttentionFirstChange={() => {}}
        projectSortOrder="manual"
        onProjectSortOrderChange={() => {}}
        titleSource="title"
        onTitleSourceChange={() => {}}
        rowItems={DEFAULT_SIDEBAR_ROW_ITEMS}
        onToggleRowItem={() => {}}
        trailing="none"
        onTrailingChange={() => {}}
        labels={[]}
        selectedLabels={[]}
        onToggleLabel={() => {}}
        onClearLabelFilter={() => {}}
        onManageLabels={() => {}}
        hosts={SESSIONS.map((entry) => ({
          id: entry.host.executionScope.environmentId,
          label: entry.host.hostName,
        }))}
        hostFilters={[...hostFilters]}
        onToggleHost={(id) => {
          setHostFilters((current) =>
            current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id],
          );
        }}
        onClearHostFilters={() => setHostFilters([])}
        projects={[]}
        projectFilters={[]}
        onToggleProject={() => {}}
        onClearProjectFilters={() => {}}
      />
      <ul data-testid="host-filtered-rows">
        {visible.map((entry) => (
          <li key={entry.host.hostId}>{entry.host.hostName}</li>
        ))}
      </ul>
    </div>
  );
}

describe("sidebar host filter", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("keeps only the selected host's rows and restores all hosts when cleared", async () => {
    const screen = await render(<HostFilterHarness />);
    const rows = screen.getByTestId("host-filtered-rows");

    await expect.element(rows).toHaveTextContent("Computer A");
    await expect.element(rows).toHaveTextContent("Computer B");

    await page.getByRole("button", { name: "Display options" }).click();
    await page.getByRole("menuitemcheckbox", { name: "Computer A" }).click();

    await expect.element(rows).toHaveTextContent("Computer A");
    expect(rows.element().textContent).not.toContain("Computer B");

    await page.getByRole("menuitemcheckbox", { name: "Computer A" }).click();
    await expect.element(rows).toHaveTextContent("Computer B");
  });
});
