// FILE: whatsNew/entries.ts
// Purpose: Build the "What's new" / Release history entries from the product's
// own changelog instead of a curated upstream list.
// Layer: static data consumed by `useWhatsNew`, `ReleaseHistoryDialog`, and the
// sidebar help menu.
//
// Both languages are embedded with Vite's `?raw` import. Parsing is lazy (and
// cached) so switching languages only parses the selected file once, and the
// repository changelog stays the single source of truth.
//
// `version` matches the repository's package version, not the web package's
// own version, so the post-update popout anchors on the newest product release.

import changelogEn from "../../../../../../CHANGELOG.md?raw";
import changelogZhCn from "../../../../../../CHANGELOG.zh-CN.md?raw";

import { parseChangelog, toWhatsNewEntries } from "./changelog";
import type { WhatsNewEntry } from "./logic";

/** Recent releases are enough for the in-app history; the website owns the full log. */
export const WHATS_NEW_RECENT_RELEASE_LIMIT = 20;

type ChangelogLanguage = "en" | "zh-CN";

const RAW_CHANGELOGS: Record<ChangelogLanguage, string> = {
  en: changelogEn,
  "zh-CN": changelogZhCn,
};

const parsedByLanguage = new Map<ChangelogLanguage, readonly WhatsNewEntry[]>();

function changelogLanguage(locale: string | undefined): ChangelogLanguage {
  return locale?.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

/** Release history for the current interface language, newest first. */
export function getWhatsNewEntries(locale: string | undefined): readonly WhatsNewEntry[] {
  const language = changelogLanguage(locale);
  const cached = parsedByLanguage.get(language);
  if (cached) return cached;
  const entries = toWhatsNewEntries(
    parseChangelog(RAW_CHANGELOGS[language], { limit: WHATS_NEW_RECENT_RELEASE_LIMIT }),
  );
  parsedByLanguage.set(language, entries);
  return entries;
}
