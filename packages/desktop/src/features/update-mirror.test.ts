import { describe, expect, it } from "vitest";
import { isGithubReleaseDownload, mirroredDownloadUrl } from "./update-mirror.js";

const RELEASE = "https://github.com/istoo/neox/releases/download/v0.15.0/Neox-0.15.0-arm64.dmg";

describe("update mirror", () => {
  it("puts the mirror's prefix before a release download", () => {
    expect(mirroredDownloadUrl("https://mirror.example/", RELEASE)).toBe(
      `https://mirror.example/${RELEASE}`,
    );
    expect(mirroredDownloadUrl("https://mirror.example", RELEASE)).toBe(
      `https://mirror.example/${RELEASE}`,
    );
  });

  it("leaves everything alone without a mirror", () => {
    expect(mirroredDownloadUrl("", RELEASE)).toBe(RELEASE);
    expect(mirroredDownloadUrl("   ", RELEASE)).toBe(RELEASE);
  });

  it("only mirrors release downloads, never the feed or other GitHub pages", () => {
    expect(isGithubReleaseDownload(RELEASE)).toBe(true);
    expect(mirroredDownloadUrl("https://m.example", "https://github.com/istoo/neox")).toBe(
      "https://github.com/istoo/neox",
    );
    expect(
      mirroredDownloadUrl("https://m.example", "https://api.github.com/repos/istoo/neox"),
    ).toBe("https://api.github.com/repos/istoo/neox");
    expect(mirroredDownloadUrl("https://m.example", "https://example.com/file.zip")).toBe(
      "https://example.com/file.zip",
    );
  });
});
