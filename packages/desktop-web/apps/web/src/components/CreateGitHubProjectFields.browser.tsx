import "../index.css";
import type { GitHubRepositorySummary } from "@synara/contracts";
import { page } from "vitest/browser";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { CreateGitHubProjectFields } from "./CreateGitHubProjectFields";

const repository: GitHubRepositorySummary = {
  id: "r1",
  name: "neolix",
  nameWithOwner: "neolix/neolix",
  description: "The Neolix monorepo",
  visibility: "private",
  updatedAt: "2026-01-01T00:00:00.000Z",
  cloneUrl: "https://github.com/neolix/neolix.git",
};

function renderFields(onSelect: (value: GitHubRepositorySummary) => void) {
  return render(
    <CreateGitHubProjectFields
      repositoryInputId="repo"
      destinationParentInputId="parent"
      directoryNameInputId="name"
      errorId="error"
      repositoryInput="neo"
      destinationParent="/tmp"
      directoryName=""
      finalClonePath="/tmp/neolix"
      formError={null}
      provisionProgress={null}
      isElectron={false}
      isPickingFolder={false}
      submitting={false}
      repositorySuggestions={[repository]}
      repositorySearchStatus="idle"
      repositorySearchError={null}
      onRepositoryChange={() => {}}
      onSelectRepositorySuggestion={onSelect}
      onDestinationParentChange={() => {}}
      onDirectoryNameChange={() => {}}
      onBrowse={() => {}}
      onSubmitKeyDown={() => {}}
    />,
  );
}

it("lists GitHub repository suggestions and picks one", async () => {
  const onSelect = vi.fn();
  const screen = await renderFields(onSelect);
  try {
    await expect.element(page.getByText("neolix/neolix")).toBeVisible();
    await expect.element(page.getByText("The Neolix monorepo")).toBeVisible();
    await page.getByRole("button", { name: /neolix\/neolix/ }).click();
    expect(onSelect).toHaveBeenCalledWith(repository);
  } finally {
    await screen.unmount();
  }
});

it("shows the search error instead of an empty list", async () => {
  const screen = await render(
    <CreateGitHubProjectFields
      repositoryInputId="repo"
      destinationParentInputId="parent"
      directoryNameInputId="name"
      errorId="error"
      repositoryInput="neo"
      destinationParent="/tmp"
      directoryName=""
      finalClonePath="/tmp/neolix"
      formError={null}
      provisionProgress={null}
      isElectron={false}
      isPickingFolder={false}
      submitting={false}
      repositorySuggestions={[]}
      repositorySearchStatus="error"
      repositorySearchError="gh is not installed"
      onRepositoryChange={() => {}}
      onSelectRepositorySuggestion={() => {}}
      onDestinationParentChange={() => {}}
      onDirectoryNameChange={() => {}}
      onBrowse={() => {}}
      onSubmitKeyDown={() => {}}
    />,
  );
  try {
    await expect.element(page.getByText("gh is not installed")).toBeVisible();
  } finally {
    await screen.unmount();
  }
});
