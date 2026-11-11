// FILE: whatsNew/changelog.ts
// Purpose: Pure parser for the repository-root CHANGELOG.md / CHANGELOG.zh-CN.md
//          files. The release-history surfaces read these instead of the curated
//          upstream entries so the dialog always describes this product.
// Layer: pure functions (no React, storage, or Vite imports) shared by the
//        build-time data module and the unit tests.
//
// Format (Keep a Changelog): a `## <version> - <date>` heading per release,
// optional summary paragraphs before the first `### <section>` heading, then
// bullet lists under each section.

import type { WhatsNewEntry, WhatsNewFeature } from "./logic";

export interface ChangelogSection {
  readonly title: string;
  readonly items: readonly string[];
}

export interface ChangelogRelease {
  readonly version: string;
  readonly date: string;
  readonly summary: string;
  readonly sections: readonly ChangelogSection[];
}

const RELEASE_HEADING = /^##\s+(\S+)\s+-\s+(.+?)\s*$/;
const SECTION_HEADING = /^###\s+(.+?)\s*$/;
const BULLET = /^[-*]\s+(.*)$/;

/** Keep only the link label so release notes render as prose, not raw Markdown. */
function stripMarkdownLinks(line: string): string {
  return line.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").trim();
}

function parseSection(block: readonly string[]): ChangelogSection | null {
  const headingIndex = block.findIndex((line) => SECTION_HEADING.test(line));
  if (headingIndex === -1) return null;
  const title = stripMarkdownLinks(SECTION_HEADING.exec(block[headingIndex]!)?.[1] ?? "");
  if (!title) return null;
  const items = block.slice(headingIndex + 1).flatMap((line) => {
    const match = BULLET.exec(line);
    if (!match) return [];
    const item = stripMarkdownLinks(match[1] ?? "");
    return item ? [item] : [];
  });
  return items.length > 0 ? { title, items } : null;
}

function splitSections(lines: readonly string[]): ChangelogSection[] {
  const sections: ChangelogSection[] = [];
  let block: string[] = [];
  let inSection = false;
  const flush = () => {
    if (!inSection) return;
    const section = parseSection(block);
    if (section) sections.push(section);
    block = [];
  };
  for (const line of lines) {
    if (SECTION_HEADING.test(line)) {
      flush();
      inSection = true;
      block = [line];
      continue;
    }
    if (inSection) block.push(line);
  }
  flush();
  return sections;
}

function splitSummary(lines: readonly string[]): string {
  const firstSection = lines.findIndex((line) => SECTION_HEADING.test(line));
  const summaryLines = firstSection === -1 ? lines : lines.slice(0, firstSection);
  return summaryLines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Parse a Keep a Changelog Markdown document. Releases keep their file order
 * (newest first) and are capped by `limit` so a public changelog with years of
 * history does not ship into the app bundle whole.
 */
export function parseChangelog(
  markdown: string,
  options?: { readonly limit?: number },
): readonly ChangelogRelease[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const releases: ChangelogRelease[] = [];
  let current: { version: string; date: string; body: string[] } | null = null;

  const finish = () => {
    if (!current) return;
    const sections = splitSections(current.body);
    const summary = splitSummary(current.body);
    if (summary.length > 0 || sections.length > 0) {
      releases.push({
        version: current.version,
        date: current.date,
        summary,
        sections,
      });
    }
    current = null;
  };

  let inFence = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      if (current) current.body.push(line);
      continue;
    }
    const heading = inFence ? null : RELEASE_HEADING.exec(line);
    if (heading) {
      finish();
      current = { version: heading[1]!, date: heading[2]!, body: [] };
      continue;
    }
    if (current) current.body.push(line);
  }
  finish();

  const limit = options?.limit;
  return limit === undefined ? releases : releases.slice(0, Math.max(0, limit));
}

function sectionFeatureId(version: string, title: string, index: number): string {
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "section";
  return `${version}:${slug}:${index}`;
}

/**
 * Convert parsed releases into the shape the existing "What's new" components
 * consume. Each release section becomes one feature card whose `items` render
 * as a bullet list; the release summary sits on the entry, not the card.
 */
export function toWhatsNewEntries(releases: readonly ChangelogRelease[]): readonly WhatsNewEntry[] {
  return releases.map((release) => {
    const features: WhatsNewFeature[] = release.sections.map((section, index) => ({
      id: sectionFeatureId(release.version, section.title, index),
      title: section.title,
      description: "",
      items: section.items,
    }));
    return {
      version: release.version,
      date: release.date,
      ...(release.summary.length > 0 ? { summary: release.summary } : {}),
      features,
    };
  });
}
