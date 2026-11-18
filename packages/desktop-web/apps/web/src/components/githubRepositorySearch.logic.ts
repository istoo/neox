// FILE: githubRepositorySearch.logic.ts
// Purpose: Decide when the add-project dialog should ask the host for GitHub repository
//          suggestions, and what picking one fills in. Complete remotes and complete
//          `owner/repo` values already say what to clone, so they do not search.
// Layer: Web UI dialog logic

import type { GitHubRepositorySummary } from "@synara/contracts";

const COMPLETE_REMOTE = /^(?:[a-z][a-z0-9+.-]*:\/\/|git@)/i;
const COMPLETE_REPOSITORY = /^[^\s/]+\/[^\s/]+$/;

/** The query to send to the host, or null when the input is already a complete target. */
export function githubRepositorySearchQuery(input: string): string | null {
  const query = input.trim();
  if (query === "") return null;
  if (COMPLETE_REMOTE.test(query)) return null;
  if (COMPLETE_REPOSITORY.test(query)) return null;
  return query;
}

export interface GitHubRepositorySuggestionPick {
  readonly repository: string;
  readonly directoryName: string;
}

/** What the form fields become when a suggestion is chosen. */
export function applyGitHubRepositorySuggestion(
  repository: Pick<GitHubRepositorySummary, "nameWithOwner" | "name">,
): GitHubRepositorySuggestionPick {
  return {
    repository: repository.nameWithOwner,
    directoryName: repository.nameWithOwner.split("/").findLast(Boolean) ?? repository.name,
  };
}
