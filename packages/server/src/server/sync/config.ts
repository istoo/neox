import { chmod, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { writePrivateFileAtomic } from "../private-files.js";
import { SYNC_PARTS, type SyncPart } from "./parts.js";

/**
 * The sync's setup, kept in `$NEOLIX_HOME/sync.json` readable by the user
 * alone, as myna keeps `sync.json` (`internal/davsync/davsync.go:64`). The
 * passphrase and the remote's password are here rather than in
 * `secrets.json`, as myna keeps them beside the rest of the sync's setup.
 */
export const SYNC_CONFIG_FILENAME = "sync.json";
export const DEFAULT_INTERVAL_MINUTES = 3;
/** myna's `Manual` (`internal/davsync/davsync.go:104`): only when asked. */
export const MANUAL_INTERVAL = -1;
export const INTERVAL_CHOICES = [MANUAL_INTERVAL, 3, 15, 30, 60] as const;

export type SyncBackend = "webdav" | "s3" | "github";

export interface SyncParts {
  sources: boolean;
  settings: boolean;
  profiles: boolean;
  models: boolean;
  library: boolean;
  /** Calls and quota readings, by day, shared best-effort (myna's usage). */
  usage: boolean;
}

/** What a sync replaced when a part changed on both sides, or on a join. */
export interface SyncNotice {
  at: string;
  /** This computer's parts the server's replaced. */
  here: string[];
  /** The server's parts this computer's replaced. */
  there: string[];
  /** Where the replaced copies are kept. */
  saved?: string;
  /** A restore's notice: `here` are the parts it brought in. */
  restored?: boolean;
}

export interface SyncConfig {
  enabled: boolean;
  /** WebDAV's folder address, `s3://bucket/prefix`, or `github://owner/repo/prefix`. */
  url: string;
  user?: string;
  /** WebDAV password, S3 secret key, or the GitHub Contents token. */
  password?: string;
  passphrase: string;
  endpoint?: string;
  region?: string;
  pathStyle?: boolean;
  branch?: string;
  /** Providers and the library carry their credentials. */
  keys: boolean;
  parts: SyncParts;
  intervalMinutes: number;
  /** This computer's name, written into each pack. */
  device?: string;
}

export interface SyncConfigView {
  enabled: boolean;
  backend: SyncBackend | null;
  url: string;
  user: string;
  passwordSet: boolean;
  passphraseSet: boolean;
  endpoint: string;
  region: string;
  pathStyle: boolean;
  branch: string;
  keys: boolean;
  parts: SyncParts;
  intervalMinutes: number;
  device: string;
}

export const ALL_PARTS: SyncParts = {
  sources: true,
  settings: true,
  profiles: true,
  models: true,
  library: true,
  usage: true,
};

export function defaultSyncConfig(): SyncConfig {
  return {
    enabled: false,
    url: "",
    passphrase: "",
    keys: false,
    parts: { ...ALL_PARTS },
    intervalMinutes: DEFAULT_INTERVAL_MINUTES,
  };
}

export function syncConfigPath(neolixHome: string): string {
  return path.join(neolixHome, SYNC_CONFIG_FILENAME);
}

export function backendOf(url: string): SyncBackend {
  const lower = url.trim().toLowerCase();
  if (lower.startsWith("github://")) {
    return "github";
  }
  if (lower.startsWith("s3://")) {
    return "s3";
  }
  return "webdav";
}

export function isPartEnabled(config: SyncConfig, part: SyncPart): boolean {
  return config.parts[part] !== false;
}

export function enabledParts(config: SyncConfig): SyncPart[] {
  return SYNC_PARTS.filter((part) => isPartEnabled(config, part));
}

export function autoIntervalMs(config: SyncConfig): number {
  if (!config.enabled || config.intervalMinutes === MANUAL_INTERVAL) {
    return 0;
  }
  const minutes = config.intervalMinutes > 0 ? config.intervalMinutes : DEFAULT_INTERVAL_MINUTES;
  return minutes * 60_000;
}

/** Reads the setup; null when sync was never turned on. */
export async function loadSyncConfig(neolixHome: string): Promise<SyncConfig | null> {
  let raw: string;
  try {
    raw = await readFile(syncConfigPath(neolixHome), "utf8");
  } catch {
    return null;
  }
  try {
    return normalizeSyncConfig(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function normalizeSyncConfig(value: unknown): SyncConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("The sync setup is not an object");
  }
  const input = value as Record<string, unknown>;
  const url = typeof input.url === "string" ? input.url.trim() : "";
  if (url.length === 0) {
    throw new Error("Sync needs an address");
  }
  const partsInput =
    typeof input.parts === "object" && input.parts !== null
      ? (input.parts as Record<string, unknown>)
      : {};
  const parts = { ...ALL_PARTS };
  for (const part of SYNC_PARTS) {
    if (typeof partsInput[part] === "boolean") {
      parts[part] = partsInput[part];
    }
  }
  const interval = Number(input.intervalMinutes);
  return {
    enabled: input.enabled !== false,
    url,
    user: optionalString(input.user),
    password: optionalString(input.password),
    passphrase: typeof input.passphrase === "string" ? input.passphrase : "",
    endpoint: optionalString(input.endpoint),
    region: optionalString(input.region),
    pathStyle: input.pathStyle === true,
    branch: optionalString(input.branch),
    keys: input.keys === true,
    parts,
    intervalMinutes:
      interval === MANUAL_INTERVAL || interval > 0 ? interval : DEFAULT_INTERVAL_MINUTES,
    device: optionalString(input.device),
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export async function saveSyncConfig(neolixHome: string, config: SyncConfig): Promise<void> {
  await mkdir(neolixHome, { recursive: true, mode: 0o700 });
  const serialized = `${JSON.stringify(serializeSyncConfig(config), null, 2)}\n`;
  await writePrivateFileAtomic(syncConfigPath(neolixHome), serialized);
  await chmod(syncConfigPath(neolixHome), 0o600).catch(() => {});
}

/** The file's shape, with the fields an old reader must not see left as absent. */
function serializeSyncConfig(config: SyncConfig): Record<string, unknown> {
  return {
    enabled: config.enabled,
    url: config.url,
    ...(config.user ? { user: config.user } : {}),
    ...(config.password ? { password: config.password } : {}),
    passphrase: config.passphrase,
    ...(config.endpoint ? { endpoint: config.endpoint } : {}),
    ...(config.region ? { region: config.region } : {}),
    ...(config.pathStyle ? { pathStyle: true } : {}),
    ...(config.branch ? { branch: config.branch } : {}),
    keys: config.keys,
    parts: config.parts,
    intervalMinutes: config.intervalMinutes,
    ...(config.device ? { device: config.device } : {}),
  };
}

/** What Settings › Sync is shown: never the secret fields themselves. */
export function syncConfigView(config: SyncConfig | null): SyncConfigView {
  const current = config ?? defaultSyncConfig();
  return {
    enabled: config?.enabled ?? false,
    backend: config ? backendOf(config.url) : null,
    url: current.url,
    user: current.user ?? "",
    passwordSet: (current.password ?? "").length > 0,
    passphraseSet: current.passphrase.length > 0,
    endpoint: current.endpoint ?? "",
    region: current.region ?? "",
    pathStyle: current.pathStyle === true,
    branch: current.branch ?? "",
    keys: current.keys,
    parts: current.parts,
    intervalMinutes: current.intervalMinutes,
    device: current.device ?? "",
  };
}
