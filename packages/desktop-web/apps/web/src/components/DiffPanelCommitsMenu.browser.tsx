import "../index.css";

import type { GitListCommitsResult, NativeApi } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { ComposerPickerMenuPopup } from "./chat/ComposerPickerMenuPopup";
import { DiffPanelCommitsMenuSection } from "./DiffPanelCommitsMenu";
import { Menu, MenuTrigger } from "./ui/menu";

const { listCommits } = vi.hoisted(() => ({
  listCommits: vi.fn<NativeApi["git"]["listCommits"]>(),
}));

vi.mock("~/nativeApi", () => ({
  ensureNativeApi: () => ({ git: { listCommits } }),
}));

const COMMITS: GitListCommitsResult = {
  baseRef: "main",
  commits: [
    {
      sha: "abc1234567",
      shortSha: "abc1234",
      subject: "Add commit browser",
      authorName: "Dev",
      authorDate: "2026-11-01T00:00:00.000Z",
      isOnRemote: true,
      isOnBase: false,
      files: [{ path: "src/a.ts", additions: 3, deletions: 1, status: "modified" }],
    },
    {
      sha: "def4567890",
      shortSha: "def4567",
      subject: "Base history entry",
      authorName: "Dev",
      authorDate: "2026-10-01T00:00:00.000Z",
      isOnRemote: true,
      isOnBase: true,
      files: [],
    },
  ],
};

function renderMenu(props: {
  activeCommitSha?: string | null;
  onSelectCommit?: (sha: string) => void;
  onClearCommit?: () => void;
}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <Menu>
        <MenuTrigger
          render={
            <button type="button" aria-label="Diff options">
              Diff options
            </button>
          }
        />
        <ComposerPickerMenuPopup align="end" side="bottom" sideOffset={6} className="w-64 min-w-64">
          <DiffPanelCommitsMenuSection
            cwd="/repo"
            open
            activeCommitSha={props.activeCommitSha ?? null}
            onSelectCommit={props.onSelectCommit ?? (() => {})}
            onClearCommit={props.onClearCommit ?? (() => {})}
          />
        </ComposerPickerMenuPopup>
      </Menu>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  listCommits.mockReset();
  listCommits.mockResolvedValue(COMMITS);
});

describe("DiffPanelCommitsMenuSection", () => {
  it("lists checkout commits without base history and selects one", async () => {
    const onSelectCommit = vi.fn();
    await renderMenu({ onSelectCommit });

    await page.getByRole("button", { name: "Diff options" }).click();

    await expect.element(page.getByText("Add commit browser")).toBeVisible();
    await expect.element(page.getByText("Base history entry")).not.toBeInTheDocument();
    await page.getByText("Add commit browser").click();

    expect(onSelectCommit).toHaveBeenCalledWith("abc1234567");
  });

  it("offers a way back to the working-tree diff while a commit is selected", async () => {
    const onClearCommit = vi.fn();
    await renderMenu({ activeCommitSha: "abc1234567", onClearCommit });

    await page.getByRole("button", { name: "Diff options" }).click();
    await page.getByText("Back to changes").click();

    expect(onClearCommit).toHaveBeenCalledTimes(1);
  });
});
