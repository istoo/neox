import { describe, expect, it } from "vitest";

import {
  applyGitHubRepositorySuggestion,
  githubRepositorySearchQuery,
} from "./githubRepositorySearch.logic";

describe("githubRepositorySearchQuery", () => {
  it("searches partial names", () => {
    expect(githubRepositorySearchQuery("neo")).toBe("neo");
    expect(githubRepositorySearchQuery("  neo  ")).toBe("neo");
  });

  it("does not search a complete clone target", () => {
    expect(githubRepositorySearchQuery("neolix/neolix")).toBeNull();
    expect(githubRepositorySearchQuery("neolix/ne")).toBeNull();
    expect(githubRepositorySearchQuery("https://github.com/neolix/neolix")).toBeNull();
    expect(githubRepositorySearchQuery("git@github.com:neolix/neolix.git")).toBeNull();
    expect(githubRepositorySearchQuery("   ")).toBeNull();
  });
});

describe("applyGitHubRepositorySuggestion", () => {
  it("fills the repository and the daemon-derived folder name", () => {
    expect(
      applyGitHubRepositorySuggestion({
        nameWithOwner: "neolix/neolix",
        name: "neolix",
      }),
    ).toEqual({ repository: "neolix/neolix", directoryName: "neolix" });
  });
});
