import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * myna's update/blocked.go: a version this computer refused to run, and why.
 * Windows' code integrity (Smart App Control, AppLocker, software
 * restriction policies) refuses a newly installed build, so the app puts
 * the note here and the automatic checks stop offering that version.
 */
export interface BlockedUpdate {
  version: string;
  error: string;
  /** Windows application control refused it, rather than a download or signature error. */
  policy?: boolean;
  at: string;
}

export const BLOCKED_UPDATE_FILENAME = "update-blocked.json";

/** Windows error numbers application control returns. */
const POLICY_ERRNOS = new Set([1260, 4551]);

export function isPolicyRefusal(error: unknown): boolean {
  const record =
    typeof error === "object" && error !== null ? (error as Record<string, unknown>) : {};
  for (const key of ["errno", "code", "errorCode"]) {
    const value = record[key];
    if (typeof value === "number" && POLICY_ERRNOS.has(value)) {
      return true;
    }
    if (typeof value === "string" && /^(0x)?[0-9a-f]+$/i.test(value)) {
      const parsed = Number.parseInt(value.replace(/^0x/i, ""), 16);
      // HRESULTs carry the Win32 number in their low word (0x800711C7 → 4551).
      const errno = parsed > 0xffff ? parsed & 0xffff : parsed;
      if (Number.isFinite(errno) && (POLICY_ERRNOS.has(errno) || (errno >= 4550 && errno < 4600))) {
        return true;
      }
    }
  }
  let message = "";
  if (error instanceof Error) {
    message = error.message;
  } else if (typeof error === "string") {
    message = error;
  }
  return /smart app control|applocker|blocked by (a )?policy|software restriction|access is denied|0x800704ec|0x800711c7/i.test(
    message,
  );
}

function parseVersion(version: string): { parts: number[]; pre: string } | null {
  const cleaned = version.trim().replace(/^v/i, "").split("+")[0] ?? "";
  const [core, pre = ""] = cleaned.split("-", 2);
  const pieces = (core ?? "").split(".");
  if (pieces.length !== 3) {
    return null;
  }
  const parts = pieces.map((piece) => Number.parseInt(piece, 10));
  if (parts.some((part) => !Number.isFinite(part) || part < 0)) {
    return null;
  }
  return { parts, pre };
}

/** Whether a comes after b; a pre-release comes before the release it leads to. */
export function isNewerVersion(a: string, b: string): boolean {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) {
    return false;
  }
  for (let index = 0; index < 3; index += 1) {
    const x = left.parts[index] ?? 0;
    const y = right.parts[index] ?? 0;
    if (x !== y) {
      return x > y;
    }
  }
  if (left.pre === right.pre) {
    return false;
  }
  if (left.pre === "") {
    return true;
  }
  if (right.pre === "") {
    return false;
  }
  return left.pre.localeCompare(right.pre, undefined, { numeric: true }) > 0;
}

export function blockedUpdatePath(userDataPath: string): string {
  return path.join(userDataPath, BLOCKED_UPDATE_FILENAME);
}

/** Notes a version this computer refused; returns the note it wrote. */
export function noteBlockedUpdate(
  userDataPath: string,
  version: string,
  error: unknown,
): BlockedUpdate {
  const message = error instanceof Error ? error.message : String(error);
  const blocked: BlockedUpdate = {
    version,
    error: message,
    ...(isPolicyRefusal(error) ? { policy: true } : {}),
    at: new Date().toISOString(),
  };
  try {
    mkdirSync(userDataPath, { recursive: true });
    writeFileSync(blockedUpdatePath(userDataPath), JSON.stringify(blocked), "utf8");
  } catch {
    // A note that can't be written changes nothing about the version itself.
  }
  return blocked;
}

/** The note while it names a version newer than the one running; else it is dropped. */
export function readBlockedUpdate(
  userDataPath: string,
  currentVersion: string,
): BlockedUpdate | null {
  let raw: string;
  try {
    raw = readFileSync(blockedUpdatePath(userDataPath), "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    clearBlockedUpdate(userDataPath);
    return null;
  }
  const record =
    typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  const version = typeof record.version === "string" ? record.version : "";
  if (!version || !isNewerVersion(version, currentVersion)) {
    clearBlockedUpdate(userDataPath);
    return null;
  }
  return {
    version,
    error: typeof record.error === "string" ? record.error : "",
    ...(record.policy === true ? { policy: true } : {}),
    at: typeof record.at === "string" ? record.at : "",
  };
}

export function clearBlockedUpdate(userDataPath: string): void {
  try {
    rmSync(blockedUpdatePath(userDataPath), { force: true });
  } catch {
    // Already gone.
  }
}
