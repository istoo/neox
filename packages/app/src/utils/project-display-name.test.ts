import { describe, expect, it } from "vitest";
import {
  projectDisplayNameFromProjectId,
  projectIconPlaceholderLabelFromDisplayName,
} from "./project-display-name";

describe("projectDisplayNameFromProjectId", () => {
  it("shows owner and repo for GitHub remote ids", () => {
    expect(projectDisplayNameFromProjectId("remote:github.com/istoo/neox")).toBe("istoo/neox");
  });

  it("shows the trailing directory name for local projects", () => {
    expect(projectDisplayNameFromProjectId("/Users/me/dev/neolix")).toBe("neolix");
  });
});

describe("projectIconPlaceholderLabelFromDisplayName", () => {
  it("uses repo name instead of owner for GitHub-style display names", () => {
    expect(projectIconPlaceholderLabelFromDisplayName("istoo/neox")).toBe("neox");
  });

  it("returns the original display name when it has no path separator", () => {
    expect(projectIconPlaceholderLabelFromDisplayName("neolix")).toBe("neolix");
  });
});
