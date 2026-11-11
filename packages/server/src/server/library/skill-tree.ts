import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

/** Marks a copied skill folder as the library's, not the user's own. */
export const SKILL_MARKER = ".neolix-library.json";

export function markerFor(name: string): string {
  return `${JSON.stringify({ version: 1, name })}\n`;
}

/** A digest of a skill folder's paths and bytes, for update checks. */
export async function hashSkillTree(dir: string): Promise<string> {
  const hash = createHash("sha256");
  const walk = async (current: string, prefix: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name === ".git" || entry.name === "node_modules" || entry.name === SKILL_MARKER) {
        continue;
      }
      const full = path.join(current, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(full, relative);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const info = await stat(full);
      hash.update(`${relative}\0${info.size}\0`);
      hash.update(await readFile(full));
      hash.update("\0");
    }
  };
  await walk(dir, "");
  return hash.digest("hex");
}

/** Whether a folder is a copy this library made, under this skill's name. */
export async function isOwnedCopy(dir: string, name: string): Promise<boolean> {
  try {
    const parsed = JSON.parse(await readFile(path.join(dir, SKILL_MARKER), "utf8")) as unknown;
    return (
      typeof parsed === "object" && parsed !== null && (parsed as { name?: unknown }).name === name
    );
  } catch {
    return false;
  }
}
