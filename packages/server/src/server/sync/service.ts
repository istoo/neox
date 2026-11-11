import { spawn } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  open,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { revealCommand } from "../llm-gateway/held-report.js";
import {
  BACKUP_EXT,
  deleteBackup,
  exportBackup,
  listBackups,
  loadAutoConfig,
  resolveBackupDir,
  restoreBackup,
  runAutoBackup,
  saveAutoConfig,
  type BackupAutoConfig,
  type BackupAutoConfigInput,
  type BackupEntry,
  type RestoreResult,
} from "./backup.js";
import {
  autoIntervalMs,
  backendOf,
  defaultSyncConfig,
  enabledParts,
  loadSyncConfig,
  normalizeSyncConfig,
  saveSyncConfig,
  syncConfigView,
  type SyncConfig,
  type SyncConfigView,
} from "./config.js";
import { SyncEngine, type RemoteVersion, type SyncStatus } from "./engine.js";
import { dropOtherUsage, usageDevice, usageReport } from "./usage.js";
import { APP_SETTINGS_FILENAME } from "./parts.js";
import { RemoteRateLimitedError } from "./remote.js";

/**
 * Keeps sync's files to one writer across processes, as myna's `lock`
 * (`internal/davsync/lock.go`). Node has no `flock`, so the lock is a file
 * created with `wx`: a stale one (a process that ended without unlocking) is
 * taken after ten minutes.
 */
const LOCK_FILENAME = "sync.lock";
const STALE_LOCK_MS = 10 * 60_000;
const LOCK_POLL_MS = 200;
/** When each app setting was last written from outside the app, by key. */
const APP_SETTINGS_PATCHES_FILENAME = "sync-app-settings-patches.json";
/** The keys the last known app settings copy had, so a sync's removals show. */
const APP_SETTINGS_KEYS_FILENAME = "sync-app-settings-keys.json";
export const LOCK_WAIT_MS = 30_000;

function lockPath(neolixHome: string): string {
  return path.join(neolixHome, LOCK_FILENAME);
}

async function acquireLock(
  neolixHome: string,
  waitMs = LOCK_WAIT_MS,
): Promise<() => Promise<void>> {
  await mkdir(neolixHome, { recursive: true, mode: 0o700 });
  const target = lockPath(neolixHome);
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const handle = await open(target, "wx", 0o600);
      await handle.writeFile(`${process.pid} ${new Date().toISOString()}\n`);
      await handle.close();
      return async () => {
        await rm(target, { force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        // A file system without lock-like semantics: sync without one.
        return async () => {};
      }
      try {
        const info = await stat(target);
        if (Date.now() - info.mtimeMs > STALE_LOCK_MS) {
          await rm(target, { force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error("another Neox is syncing: try again in a moment", { cause: error });
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
    }
  }
}

export type SyncEvent =
  | { type: "sync.status.changed"; status: SyncStatus }
  | { type: "sync.notice"; notice: NonNullable<SyncStatus["notice"]> }
  | { type: "sync.app_settings.apply"; value: unknown };

export interface SyncServiceOptions {
  neolixHome: string;
  hostname?: string;
  onEvent?: (event: SyncEvent) => void;
  logger?: { warn(message: string): void };
}

/** Schedules the sync and is the one entry point RPCs use, as myna's `Run`. */
export class SyncService {
  private readonly neolixHome: string;
  private readonly options: SyncServiceOptions;
  private readonly engine: SyncEngine;
  private timer: NodeJS.Timeout | null = null;
  private firstTimer: NodeJS.Timeout | null = null;
  private autoTimer: NodeJS.Timeout | null = null;
  private lastAttempt = 0;
  private backoffMs = 0;
  private lastError: string | undefined;

  constructor(options: SyncServiceOptions) {
    this.neolixHome = options.neolixHome;
    this.options = options;
    this.engine = new SyncEngine(options.neolixHome, {
      onAppSettings: (value) => {
        // A settings part pulled in or restored is a write the app hasn't
        // seen; mark it so the app adopts it at its next start.
        void this.recordAppSettingsApplied(value).catch(() => undefined);
        this.emit({ type: "sync.app_settings.apply", value });
      },
    });
  }

  start(): void {
    if (this.timer) {
      return;
    }
    // The keys this computer had before the first sync: a key the first
    // pull removes is told apart from one that was never here.
    void this.initializeAppSettingsKeys().catch(() => undefined);
    // myna's Run waits a little after start (`davsync.go:766`).
    this.firstTimer = setTimeout(() => void this.tick(), 20_000);
    this.firstTimer.unref?.();
    this.timer = setInterval(() => void this.tick(), 60_000);
    this.timer.unref?.();
    // An automatic backup is checked hourly; `runAutoBackup` decides whether
    // the configured interval has passed (myna `backup/auto.go` AutoTick).
    this.autoTimer = setInterval(() => void this.autoTick(), 3_600_000);
    this.autoTimer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.firstTimer) {
      clearTimeout(this.firstTimer);
      this.firstTimer = null;
    }
    if (this.autoTimer) {
      clearInterval(this.autoTimer);
      this.autoTimer = null;
    }
  }

  async config(): Promise<SyncConfigView> {
    return syncConfigView(await loadSyncConfig(this.neolixHome));
  }

  /**
   * Turns sync on or changes it. An empty password keeps the saved one for
   * the same account, as myna's `Configure` does (`davsync.go:284`); it is
   * never sent to another server.
   */
  async configure(input: unknown): Promise<SyncConfigView> {
    const old = await loadSyncConfig(this.neolixHome);
    const config = normalizeSyncConfig(input);
    const previous = old ?? defaultSyncConfig();
    if (!config.password && previous.password && sameAccount(previous, config)) {
      config.password = previous.password;
    }
    if (!config.passphrase && previous.passphrase) {
      config.passphrase = previous.passphrase;
    }
    config.device = config.device || previous.device || this.options.hostname || os.hostname();
    validateConfig(config, previous);
    const unlock = await acquireLock(this.neolixHome);
    try {
      await saveSyncConfig(this.neolixHome, config);
    } finally {
      await unlock();
    }
    this.emitStatus(await this.status());
    if (!config.enabled || config.parts.usage === false) {
      await dropOtherUsage(this.neolixHome).catch(() => undefined);
    }
    if (config.enabled) {
      void this.run();
    }
    return this.config();
  }

  async disable(): Promise<void> {
    const old = await loadSyncConfig(this.neolixHome);
    if (!old) {
      return;
    }
    old.enabled = false;
    await saveSyncConfig(this.neolixHome, old);
    await dropOtherUsage(this.neolixHome).catch(() => undefined);
    this.emitStatus(await this.status());
  }

  async status(): Promise<SyncStatus> {
    return this.engine.status();
  }

  async listRemote(): Promise<RemoteVersion[]> {
    return this.engine.listRemote();
  }

  /** Every computer's shared usage, for the Usage page (myna's shared days). */
  async usage(): Promise<Awaited<ReturnType<typeof usageReport>>> {
    const config = await loadSyncConfig(this.neolixHome);
    const device = await usageDevice(this.neolixHome, config?.device ?? "neox");
    return usageReport(this.neolixHome, device);
  }

  async run(options: { force?: boolean } = {}): Promise<SyncStatus> {
    const unlock = await acquireLock(this.neolixHome);
    try {
      const status = await this.engine.run(options);
      this.lastAttempt = Date.now();
      this.report(status);
      if (status.notice) {
        this.emit({ type: "sync.notice", notice: status.notice });
      }
      return status;
    } finally {
      await unlock();
    }
  }

  async restoreRemote(): Promise<SyncStatus> {
    const unlock = await acquireLock(this.neolixHome);
    try {
      const status = await this.engine.restoreRemote();
      this.report(status);
      return status;
    } finally {
      await unlock();
    }
  }

  async upload(): Promise<SyncStatus> {
    const unlock = await acquireLock(this.neolixHome);
    try {
      const status = await this.engine.upload();
      this.report(status);
      return status;
    } finally {
      await unlock();
    }
  }

  async undo(): Promise<SyncStatus> {
    const unlock = await acquireLock(this.neolixHome);
    try {
      const status = await this.engine.undo();
      this.report(status);
      return status;
    } finally {
      await unlock();
    }
  }

  async follow(): Promise<SyncStatus> {
    const unlock = await acquireLock(this.neolixHome);
    try {
      const status = await this.engine.follow();
      this.report(status);
      return status;
    } finally {
      await unlock();
    }
  }

  async dismissNotice(): Promise<void> {
    await this.engine.dismissNotice();
  }

  /**
   * The app's settings, pushed here when they change. The daemon keeps a
   * copy so the settings part can carry them (`sync-app-settings.json`).
   */
  async saveAppSettings(value: unknown): Promise<void> {
    if (typeof value !== "object" || value === null) {
      throw new Error("App settings must be a JSON object");
    }
    const target = path.join(this.neolixHome, APP_SETTINGS_FILENAME);
    await mkdir(this.neolixHome, { recursive: true, mode: 0o700 });
    await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await chmod(target, 0o600).catch(() => {});
    await this.saveKnownAppSettingsKeys(Object.keys(value));
  }

  async appSettings(): Promise<unknown | null> {
    try {
      return JSON.parse(await readFile(path.join(this.neolixHome, APP_SETTINGS_FILENAME), "utf8"));
    } catch {
      return null;
    }
  }

  /**
   * Writes one key from outside the app, as `neolix settings set` does; null
   * unsets it, so the app falls back to its own default. The time is kept
   * apart from the copy so the app can tell, at start, which keys the CLI
   * changed while it was closed.
   */
  async patchAppSettings(key: string, value: unknown): Promise<void> {
    // debt: read-modify-write; two patches landing at once can drop one.
    const stored = await this.appSettings();
    const current =
      typeof stored === "object" && stored !== null && !Array.isArray(stored)
        ? (stored as Record<string, unknown>)
        : {};
    const next = { ...current };
    if (value === null) {
      delete next[key];
    } else {
      next[key] = value;
    }
    await this.saveAppSettings(next);
    const patched = await this.appSettingsPatchedAt();
    patched[key] = new Date().toISOString();
    await this.saveAppSettingsPatchedAt(patched);
  }

  /**
   * Marks every key a sync pull, restore or undo just wrote on this computer,
   * so an app that was closed adopts them at its next start instead of
   * pushing its own copy back over them.
   */
  async recordAppSettingsApplied(value: unknown): Promise<void> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return;
    }
    // The engine has already written the new copy, so the keys the old copy
    // had come from the last set this service wrote or recorded (the startup
    // snapshot, an app export, or a patch).
    const previous = await this.knownAppSettingsKeys();
    const keys = Object.keys(value);
    const patched = await this.appSettingsPatchedAt();
    const now = new Date().toISOString();
    for (const key of keys) {
      patched[key] = now;
    }
    for (const key of previous) {
      // A key the new copy doesn't have was removed by the sync: mark it so
      // the app adopts the removal as an unset instead of restoring its own.
      if (!keys.includes(key)) {
        patched[key] = now;
      }
    }
    await this.saveAppSettingsPatchedAt(patched);
    await this.saveKnownAppSettingsKeys(keys);
  }

  /**
   * Remembers the copy's keys at daemon start, before any sync writes it, so
   * a key the first sync removes is still seen as an unset.
   */
  async initializeAppSettingsKeys(): Promise<void> {
    if ((await this.knownAppSettingsKeys()).length > 0) {
      return;
    }
    const stored = await this.appSettings();
    if (typeof stored !== "object" || stored === null || Array.isArray(stored)) {
      return;
    }
    await this.saveKnownAppSettingsKeys(Object.keys(stored));
  }

  /** The app setting keys of the last copy this service wrote or recorded. */
  private async knownAppSettingsKeys(): Promise<string[]> {
    try {
      const raw: unknown = JSON.parse(
        await readFile(path.join(this.neolixHome, APP_SETTINGS_KEYS_FILENAME), "utf8"),
      );
      return Array.isArray(raw) ? raw.filter((key): key is string => typeof key === "string") : [];
    } catch {
      return [];
    }
  }

  private async saveKnownAppSettingsKeys(keys: string[]): Promise<void> {
    const target = path.join(this.neolixHome, APP_SETTINGS_KEYS_FILENAME);
    await mkdir(this.neolixHome, { recursive: true, mode: 0o700 });
    await writeFile(target, `${JSON.stringify(keys, null, 2)}\n`, { mode: 0o600 });
    await chmod(target, 0o600).catch(() => {});
  }

  /** ISO time each key was last patched from outside the app. */
  async appSettingsPatchedAt(): Promise<Record<string, string>> {
    try {
      const raw: unknown = JSON.parse(
        await readFile(path.join(this.neolixHome, APP_SETTINGS_PATCHES_FILENAME), "utf8"),
      );
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        return {};
      }
      const times: Record<string, string> = {};
      for (const [key, at] of Object.entries(raw)) {
        if (typeof at === "string") {
          times[key] = at;
        }
      }
      return times;
    } catch {
      return {};
    }
  }

  private async saveAppSettingsPatchedAt(times: Record<string, string>): Promise<void> {
    const target = path.join(this.neolixHome, APP_SETTINGS_PATCHES_FILENAME);
    await mkdir(this.neolixHome, { recursive: true, mode: 0o700 });
    await writeFile(target, `${JSON.stringify(times, null, 2)}\n`, { mode: 0o600 });
    await chmod(target, 0o600).catch(() => {});
  }

  async exportBackup(input: {
    passphrase?: string;
    keys?: boolean;
    signIns?: boolean;
  }): Promise<BackupEntry> {
    const config = await loadSyncConfig(this.neolixHome);
    const auto = await loadAutoConfig(this.neolixHome);
    const passphrase = input.passphrase?.trim() || config?.passphrase || "";
    const written = await exportBackup({
      neolixHome: this.neolixHome,
      passphrase,
      keys: input.keys ?? config?.keys ?? false,
      signIns: input.signIns,
      dir: auto.dir,
      device: config?.device ?? this.options.hostname ?? os.hostname(),
    });
    return {
      file: written.file,
      name: written.name,
      size: written.size,
      at: written.at,
      auto: false,
    };
  }

  async backups(): Promise<BackupEntry[]> {
    const auto = await loadAutoConfig(this.neolixHome);
    return listBackups(this.neolixHome, auto.dir);
  }

  async restore(input: {
    name: string;
    passphrase?: string;
    keys?: boolean;
    signIns?: boolean;
  }): Promise<RestoreResult> {
    const config = await loadSyncConfig(this.neolixHome);
    const auto = await loadAutoConfig(this.neolixHome);
    const file = await this.backupFile(input.name);
    const result = await restoreBackup({
      neolixHome: this.neolixHome,
      file,
      passphrase: input.passphrase?.trim() || config?.passphrase || "",
      keys: input.keys ?? config?.keys ?? false,
      signIns: input.signIns,
      dir: auto.dir,
    });
    if (result.parts.includes("settings")) {
      const value = await this.appSettings();
      if (value !== null) {
        await this.recordAppSettingsApplied(value);
        this.emit({ type: "sync.app_settings.apply", value });
      }
    }
    return result;
  }

  async removeBackup(name: string): Promise<void> {
    await deleteBackup(await this.backupFile(name));
  }

  /**
   * Brings in a backup the app uploaded and put in this host's uploads
   * folder (myna's Import, `syncfiles.js`): the file is copied into the
   * backups folder, so it can be restored again, and then applied.
   */
  async importBackup(input: {
    id: string;
    passphrase?: string;
    keys?: boolean;
    signIns?: boolean;
  }): Promise<RestoreResult> {
    if (!/^upload_[0-9a-f-]{36}$/i.test(input.id)) {
      throw new Error("That is not a file this host received");
    }
    const uploadDir = path.join(this.neolixHome, "uploads", input.id);
    const names = await readdir(uploadDir).catch(() => [] as string[]);
    const name = names.find((entry) => entry.endsWith(BACKUP_EXT));
    if (!name) {
      throw new Error("That upload is not a Neox backup");
    }
    const auto = await loadAutoConfig(this.neolixHome);
    const dir = resolveBackupDir(this.neolixHome, auto.dir);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const target = path.join(dir, `neolix-${stamp}-imported${BACKUP_EXT}`);
    await copyFile(path.join(uploadDir, name), target);
    await chmod(target, 0o600).catch(() => {});
    // The upload's copy is not kept: the backup folder has it now.
    await rm(uploadDir, { recursive: true, force: true }).catch(() => {});
    return this.restore({
      name: path.basename(target),
      passphrase: input.passphrase,
      keys: input.keys,
      signIns: input.signIns,
    });
  }

  /** Opens the backups folder on the computer the daemon runs on. */
  async revealBackups(): Promise<{ ok: boolean; error?: string }> {
    const auto = await loadAutoConfig(this.neolixHome);
    const dir = resolveBackupDir(this.neolixHome, auto.dir);
    await mkdir(dir, { recursive: true, mode: 0o700 }).catch(() => {});
    const { command, args } = revealCommand(process.platform, dir);
    return new Promise((resolve) => {
      const child = spawn(command, args, { stdio: "ignore", detached: true });
      child.once("error", (error) => resolve({ ok: false, error: error.message }));
      child.once("spawn", () => {
        child.unref();
        resolve({ ok: true });
      });
    });
  }

  async autoConfig(): Promise<BackupAutoConfig & { folder: string }> {
    const config = await loadAutoConfig(this.neolixHome);
    return { ...config, folder: resolveBackupDir(this.neolixHome, config.dir) };
  }

  async setAutoConfig(
    config: BackupAutoConfigInput,
  ): Promise<BackupAutoConfig & { folder: string }> {
    const saved = await saveAutoConfig(this.neolixHome, config);
    return { ...saved, folder: resolveBackupDir(this.neolixHome, saved.dir) };
  }

  async runAuto(passphraseInput?: string): Promise<BackupEntry | null> {
    const config = await loadSyncConfig(this.neolixHome);
    const passphrase = passphraseInput?.trim() || config?.passphrase;
    return runAutoBackup(this.neolixHome, passphrase);
  }

  /** A backup name as a file inside the backups folder; no other path. */
  private async backupFile(name: string): Promise<string> {
    const base = path.basename(name);
    if (base !== name || !name.endsWith(BACKUP_EXT)) {
      throw new Error("That is not a backup in this computer's backups folder");
    }
    const auto = await loadAutoConfig(this.neolixHome);
    return path.join(resolveBackupDir(this.neolixHome, auto.dir), base);
  }

  private async autoTick(): Promise<void> {
    try {
      await this.runAuto();
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      if (text !== this.lastError) {
        this.options.logger?.warn(`automatic backup: ${text}`);
      }
      this.lastError = text;
    }
  }

  private report(status: SyncStatus): void {
    this.lastError = status.error;
    this.emitStatus(status);
  }

  private emitStatus(status: SyncStatus): void {
    this.emit({ type: "sync.status.changed", status });
  }

  private emit(event: SyncEvent): void {
    this.options.onEvent?.(event);
  }

  private async tick(): Promise<void> {
    const config = await loadSyncConfig(this.neolixHome);
    if (!config?.enabled) {
      return;
    }
    const interval = autoIntervalMs(config);
    if (interval === 0) {
      return;
    }
    const wait = this.backoffMs > 0 ? Math.max(this.backoffMs, interval) : interval;
    if (this.lastAttempt > 0 && Date.now() - this.lastAttempt < wait) {
      return;
    }
    try {
      await this.run();
      this.backoffMs = 0;
    } catch (error) {
      if (error instanceof RemoteRateLimitedError) {
        // myna waits as long as Retry-After says, else twice the last wait
        // (`davsync.go:744`), up to six hours for a stated wait.
        this.backoffMs =
          error.retryAfterMs > 0
            ? Math.min(error.retryAfterMs, 6 * 60 * 60_000)
            : Math.min(Math.max(this.backoffMs * 2, interval * 2), 30 * 60_000);
      }
      const text = error instanceof Error ? error.message : String(error);
      if (text !== this.lastError) {
        this.options.logger?.warn(`syncing: ${text}`);
      }
      this.lastError = text;
    }
  }
}

function sameAccount(old: SyncConfig, next: SyncConfig): boolean {
  const oldBackend = backendOf(old.url);
  if (oldBackend !== backendOf(next.url)) {
    return false;
  }
  if (oldBackend === "github") {
    return old.url.trim().toLowerCase() === next.url.trim().toLowerCase();
  }
  try {
    const a = new URL(old.url);
    const b = new URL(next.url);
    return a.protocol === b.protocol && a.host.toLowerCase() === b.host.toLowerCase();
  } catch {
    return old.url === next.url;
  }
}

/** myna's `Configure` refusals (`internal/davsync/davsync.go:347`). */
function validateConfig(config: SyncConfig, old: SyncConfig): void {
  const backend = backendOf(config.url);
  if (backend === "github") {
    if (!config.password) {
      throw new Error(
        "GitHub sync needs a token with Contents read and write permission for the repository",
      );
    }
    if (config.password === config.passphrase) {
      throw new Error(
        "the passphrase is the GitHub token: GitHub receives it, and could open the file with it. Pick a passphrase of its own",
      );
    }
  }
  if (backend === "s3") {
    if (!config.user) {
      throw new Error("S3 sync needs an access key ID, and its secret");
    }
    if (!config.password) {
      throw new Error(`type the secret for the access key ${config.user}`);
    }
    if (config.password === config.passphrase) {
      throw new Error(
        "the passphrase is the access key's secret: the S3 server holds it, and could open the file with it. Pick a passphrase of its own",
      );
    }
  }
  if (backend === "webdav" && config.password && config.password === config.passphrase) {
    throw new Error(
      "the passphrase is the server's password: the server is sent the password, and could open the file with it. Pick a passphrase of its own",
    );
  }
  if (!config.passphrase) {
    throw new Error(
      "sync needs a passphrase: the file is sealed with it before it leaves this computer",
    );
  }
  // An address change without a password typed asks for one, as myna does:
  // a saved password is only sent to the server and user it was given for.
  if (!config.password && old.password && !sameAccount(old, config) && backend !== "webdav") {
    throw new Error(
      "type the password for this server: the saved one is only sent to the server and user it was given for",
    );
  }
}

/** For the RPC layer: the parts a caller may ask for. */
export function selectedParts(config: SyncConfig): string[] {
  return enabledParts(config);
}
