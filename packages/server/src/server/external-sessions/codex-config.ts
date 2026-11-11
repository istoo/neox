import { readFile } from "node:fs/promises";
import path from "node:path";

// debt: only the keys the Sessions page reads are parsed from config.toml, by
// hand. Replace with a TOML parser if Neolix ever needs more of it.
const KEY_RE = /^\s*([A-Za-z0-9_.-]+)\s*=\s*"([^"]*)"/u;
const SECTION_RE = /^\s*\[([^\]]+)\]\s*$/u;

export interface CodexConfig {
  /** The provider Codex uses now: what its history lists. */
  provider: string;
  /** Where its state databases are, when config.toml moves them. */
  sqliteHome: string;
}

/**
 * What a Codex folder's config.toml says of the provider it uses now and
 * where its databases are. A profile's provider wins over the top-level
 * one, and "openai" is Codex's own default.
 */
export async function readCodexConfig(home: string): Promise<CodexConfig> {
  const text = await readFile(path.join(home, "config.toml"), "utf8").catch(() => "");
  if (text.length === 0) {
    return { provider: "openai", sqliteHome: "" };
  }
  let provider = "";
  let profile = "";
  let sqliteHome = "";
  const profiles = new Map<string, string>();
  let section = "";
  for (const line of text.split(/\r?\n/u)) {
    const sectionMatch = SECTION_RE.exec(line);
    if (sectionMatch !== null) {
      section = (sectionMatch[1] ?? "").trim();
      continue;
    }
    const keyMatch = KEY_RE.exec(line);
    if (keyMatch === null) {
      continue;
    }
    const key = keyMatch[1] ?? "";
    const value = keyMatch[2] ?? "";
    if (section.startsWith("profiles.") && key === "model_provider") {
      profiles.set(profileNameOf(section), value);
      continue;
    }
    if (section.length > 0) {
      continue;
    }
    if (key === "model_provider") {
      provider = value;
    } else if (key === "sqlite_home") {
      sqliteHome = value;
    } else if (key === "profile") {
      profile = value;
    }
  }
  const chosen = profile.length > 0 ? profiles.get(profile) : undefined;
  return { provider: currentProviderOf(chosen, provider), sqliteHome };
}

function currentProviderOf(chosen: string | undefined, provider: string): string {
  if (chosen !== undefined && chosen.length > 0) {
    return chosen;
  }
  return provider.length > 0 ? provider : "openai";
}

function profileNameOf(section: string): string {
  const name = section.slice("profiles.".length).trim();
  return name.replace(/^"(.*)"$/u, "$1").replace(/^'(.*)'$/u, "$1");
}
