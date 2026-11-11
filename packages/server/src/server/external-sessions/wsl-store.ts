import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExternalSession } from "./types.js";

// debt: every listed session of a running distro is kept, up to a cap; trim
// by age if a distro ever holds more sessions than this.
const SAVED_MAX = 2_000;

export interface WslSavedDistro {
  home: string;
  sessions: ExternalSession[];
}

export interface WslSaved {
  version: 1;
  distros: Record<string, WslSavedDistro>;
}

/**
 * The sessions a distro's files held when they were last listed. A stopped
 * distro can't be read without starting it, so its sessions stay listed
 * from here, as myna keeps its listing.
 */
export function wslStorePath(neolixHome: string): string {
  return path.join(neolixHome, "sessions-wsl.json");
}

export async function readWslSaved(neolixHome: string): Promise<WslSaved> {
  try {
    const text = await readFile(wslStorePath(neolixHome), "utf8");
    const parsed: unknown = JSON.parse(text);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      (parsed as { version?: unknown }).version !== 1
    ) {
      return { version: 1, distros: {} };
    }
    const distros = (parsed as { distros?: unknown }).distros;
    if (typeof distros !== "object" || distros === null || Array.isArray(distros)) {
      return { version: 1, distros: {} };
    }
    return sanitize(parsed as WslSaved);
  } catch {
    return { version: 1, distros: {} };
  }
}

export async function writeWslSaved(neolixHome: string, saved: WslSaved): Promise<void> {
  const target = wslStorePath(neolixHome);
  const temp = `${target}.tmp`;
  await writeFile(temp, `${JSON.stringify(saved)}\n`, "utf8");
  await rename(temp, target);
}

function sanitize(saved: WslSaved): WslSaved {
  const distros: Record<string, WslSavedDistro> = {};
  for (const [name, entry] of Object.entries(saved.distros)) {
    if (typeof entry !== "object" || entry === null || !Array.isArray(entry.sessions)) {
      continue;
    }
    distros[name] = {
      home: typeof entry.home === "string" ? entry.home : "",
      sessions: entry.sessions.filter(isSession).slice(0, SAVED_MAX),
    };
  }
  return { version: 1, distros };
}

function isSession(value: unknown): value is ExternalSession {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as ExternalSession).id === "string" &&
    typeof (value as ExternalSession).agent === "string"
  );
}
