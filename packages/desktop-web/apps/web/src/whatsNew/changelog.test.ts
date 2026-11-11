import { describe, expect, it } from "vitest";

import { parseChangelog, toWhatsNewEntries } from "./changelog";

const SAMPLE = `# Changelog

## 0.15.0 - 2026-11-03

Terminal programs keep running.

Second summary paragraph.

### Added

- Added [draggable handles](https://example.com/pr/1)
- Added a second thing

### Fixed

- Fixed \`foo\` ([#2](https://example.com/pr/2))

## 0.14.0 - 2026-10-29

### Improved

- Improved startup

### Notes

No bullets here.
`;

describe("parseChangelog", () => {
  it("parses releases newest-first with summary and sections", () => {
    const releases = parseChangelog(SAMPLE);

    expect(releases.map((release) => release.version)).toEqual(["0.15.0", "0.14.0"]);
    expect(releases[0]).toEqual({
      version: "0.15.0",
      date: "2026-11-03",
      summary: "Terminal programs keep running.\n\nSecond summary paragraph.",
      sections: [
        {
          title: "Added",
          items: ["Added draggable handles", "Added a second thing"],
        },
        {
          title: "Fixed",
          items: ["Fixed `foo` (#2)"],
        },
      ],
    });
  });

  it("drops sections with no bullets", () => {
    const releases = parseChangelog(SAMPLE);
    expect(releases[1]?.sections).toEqual([{ title: "Improved", items: ["Improved startup"] }]);
  });

  it("respects the release limit", () => {
    expect(parseChangelog(SAMPLE, { limit: 1 }).map((release) => release.version)).toEqual([
      "0.15.0",
    ]);
    expect(parseChangelog(SAMPLE, { limit: 0 })).toEqual([]);
  });

  it("handles CRLF headings and ignores headings inside code fences", () => {
    const markdown = [
      "# Changelog",
      "",
      "## 1.0.0 - 2026-01-01",
      "",
      "### Added",
      "",
      "- Thing",
      "",
      "```md",
      "## not-a-release",
      "```",
    ].join("\r\n");

    const releases = parseChangelog(markdown);
    expect(releases).toHaveLength(1);
    expect(releases[0]?.version).toBe("1.0.0");
    // Fenced lines are not bullets, so they stay out of the section.
    expect(releases[0]?.sections[0]?.items).toEqual(["Thing"]);
  });
});

describe("toWhatsNewEntries", () => {
  it("maps each section to a feature card and keeps the summary on the entry", () => {
    const entries = toWhatsNewEntries(parseChangelog(SAMPLE));

    expect(entries[0]?.version).toBe("0.15.0");
    expect(entries[0]?.date).toBe("2026-11-03");
    expect(entries[0]?.summary).toBe(
      "Terminal programs keep running.\n\nSecond summary paragraph.",
    );
    expect(entries[0]?.features.map((feature) => feature.title)).toEqual(["Added", "Fixed"]);
    expect(entries[0]?.features[0]?.items).toEqual([
      "Added draggable handles",
      "Added a second thing",
    ]);
    expect(entries[0]?.features[0]?.description).toBe("");
  });
});
