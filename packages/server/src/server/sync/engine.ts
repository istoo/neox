import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  buildPacks,
  openPack,
  packFileName,
  sealPack,
  unpackPacks,
  type PartFileInput,
  type SyncPack,
} from "./archive.js";
import {
  enabledParts,
  isPartEnabled,
  loadSyncConfig,
  syncConfigPath,
  type SyncConfig,
  type SyncNotice,
} from "./config.js";
import {
  applyPart,
  collectPart,
  partHash,
  readAppSettingsCopy,
  SYNC_PARTS,
  type SyncPart,
} from "./parts.js";
import {
  noteBrought,
  noticeOwn,
  ownList,
  readAgentFields,
  restoreOwnFields,
  stripOwnFields,
  type OwnField,
  type OwnState,
} from "./own.js";
import { mergeSignInsOnPull, signInBundleOf, signInHashes, type SignInHashes } from "./signins.js";
import {
  dropOtherUsage,
  shareUsage,
  USAGE_DIR,
  USAGE_EVERY_MS,
  usageDevice,
  type UsageRemoteFiles,
  type UsageSyncState,
} from "./usage.js";
import { createRemote, RemoteConflictError, type RemoteEntry, type SyncRemote } from "./remote.js";

/** A pack on the server that is a file no sync can read. */
export class DamagedRemoteError extends Error {
  constructor(readonly file: string) {
    super(
      `The file ${file} on the server can't be read as a Neox sync file. ` +
        "Sync on the computer that wrote it last, or upload this computer's setup over it.",
    );
    this.name = "DamagedRemoteError";
  }
}

export interface SyncState extends OwnState {
  /** The address, account and passphrase the state is for. */
  key: string;
  last?: string;
  error?: string;
  notice?: SyncNotice;
  /** Each part's hash here and on the server, as the last sync left them. */
  local: Partial<Record<SyncPart, string>>;
  remote: Partial<Record<SyncPart, string>>;
  /** The server's pack names and versions, so an unchanged part costs a listing. */
  remoteList: Partial<Record<SyncPart, string>>;
  /** The last snapshot `undo` brings back. */
  undo?: string;
  /** Gateway key values this computer has seen in the folder's store. */
  gatewayKeysSeen?: string[];
  /** Each sign-in's hash as the last sync left it, to tell a removal from a join. */
  signIns?: SignInHashes;
  /** What usage was shared and brought in (myna `usageState`). */
  usage?: UsageSyncState;
  /** Why sharing usage failed, kept apart from the setup's own error. */
  usageError?: string;
  /** The server holds a file no sync can read; this computer's can go over it. */
  serverFile?: { replace: boolean };
}

export interface SyncStatus {
  enabled: boolean;
  last?: string;
  error?: string;
  notice?: SyncNotice;
  undo: boolean;
  running: boolean;
  /** Agent fields kept on this computer after a sync wrote over them. */
  own?: OwnField[];
  /** Why sharing usage failed; the setup synced all the same. */
  usageError?: string;
  serverFile?: { replace: boolean };
}

export interface RemoteVersion {
  part: SyncPart;
  takenAt: string;
  device: string;
  files: number;
}

const STATE_FILENAME = "sync-state.json";
const SNAPSHOT_DIR = "sync-undo";
const CONFLICT_DIR = "sync";
const CACHE_DIR = "sync-cache";
// myna keeps one undo: the setup from just before the last restore
// (`internal/backup/auto.go:492` AutoRestore). Older snapshots go.
const KEEP_SNAPSHOTS = 1;
const KEEP_DAMAGED = 3;

interface ParsedRemotePart {
  files: PartFileInput[];
  takenAt: string;
  device: string;
  names: string[];
  hash: string;
  signature: string;
}

interface PullTarget {
  part: SyncPart;
  parsed: ParsedRemotePart;
}

function statePath(neolixHome: string): string {
  return path.join(neolixHome, STATE_FILENAME);
}

function nowStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function stateKey(config: SyncConfig): string {
  return hash(
    [
      config.url,
      config.user ?? "",
      config.endpoint ?? "",
      config.branch ?? "",
      config.passphrase,
    ].join("\0"),
  );
}

function emptyState(key: string): SyncState {
  return { key, local: {}, remote: {}, remoteList: {} };
}

export async function loadState(neolixHome: string): Promise<SyncState | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(statePath(neolixHome), "utf8"));
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    const state = parsed as Partial<SyncState>;
    return {
      key: typeof state.key === "string" ? state.key : "",
      last: state.last,
      error: state.error,
      notice: state.notice,
      local: state.local ?? {},
      remote: state.remote ?? {},
      remoteList: state.remoteList ?? {},
      undo: state.undo,
      gatewayKeysSeen: state.gatewayKeysSeen,
      brought: state.brought,
      replaced: state.replaced,
      own: state.own,
      follow: state.follow,
      signIns: state.signIns,
      usage: state.usage,
      usageError: state.usageError,
      serverFile: state.serverFile,
    };
  } catch {
    return null;
  }
}

async function saveState(neolixHome: string, state: SyncState): Promise<void> {
  await mkdir(neolixHome, { recursive: true, mode: 0o700 });
  const target = statePath(neolixHome);
  await writeFile(target, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await chmod(target, 0o600).catch(() => {});
}

function listSignature(entries: readonly RemoteEntry[]): string {
  return entries
    .map((entry) => `${entry.name}=${entry.etag ?? ""}`)
    .sort()
    .join("\n");
}

function partEntries(entries: readonly RemoteEntry[], part: SyncPart): RemoteEntry[] {
  const prefix = `${part}.`;
  return entries.filter(
    (entry) => entry.name.startsWith(prefix) && entry.name.endsWith(".neolixsync"),
  );
}

async function readCache(neolixHome: string, name: string): Promise<SyncPack | null> {
  try {
    return JSON.parse(
      await readFile(path.join(neolixHome, CACHE_DIR, `${name}.json`), "utf8"),
    ) as SyncPack;
  } catch {
    return null;
  }
}

async function writeCache(neolixHome: string, name: string, pack: SyncPack): Promise<void> {
  const dir = path.join(neolixHome, CACHE_DIR);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const target = path.join(dir, `${name}.json`);
  await writeFile(target, JSON.stringify(pack), { mode: 0o600 });
  await chmod(target, 0o600).catch(() => {});
}

async function trimCache(neolixHome: string, part: SyncPart, keep: Set<string>): Promise<void> {
  const dir = path.join(neolixHome, CACHE_DIR);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name.startsWith(`${part}.`) && !keep.has(name.replace(/\.json$/, ""))) {
      await rm(path.join(dir, name), { force: true });
    }
  }
}

/**
 * The sync engine: myna's three-way merge over `lastSyncedHash`
 * (`internal/davsync/davsync.go:1105`). One part changed only here is
 * pushed, one changed only on the server is brought in, one changed on both
 * keeps the newer and saves the replaced copy under `$NEOLIX_HOME/sync/`.
 * What the server holds is mirrored: a pack it no longer has is deleted.
 */
export interface SyncEngineOptions {
  /** Told when a brought-in settings part carries app settings to apply. */
  onAppSettings?: (value: unknown) => void;
}

export class SyncEngine {
  private running = false;
  private readonly neolixHome: string;
  private readonly options: SyncEngineOptions;

  constructor(neolixHome: string, options: SyncEngineOptions = {}) {
    this.neolixHome = neolixHome;
    this.options = options;
  }

  async status(): Promise<SyncStatus> {
    const config = await loadSyncConfig(this.neolixHome);
    const state = await loadState(this.neolixHome);
    const own = ownList(state?.own);
    return {
      enabled: config?.enabled === true,
      ...(state?.last ? { last: state.last } : {}),
      ...(state?.error ? { error: state.error } : {}),
      ...(state?.notice ? { notice: state.notice } : {}),
      undo: Boolean(state?.undo && (await this.hasUndo(state.undo))),
      running: this.running,
      ...(own.length > 0 ? { own } : {}),
      ...(state?.usageError ? { usageError: state.usageError } : {}),
      ...(state?.serverFile ? { serverFile: state.serverFile } : {}),
    };
  }

  /** One sync. A conflict from another computer is retried once over its version. */
  async run(options: { force?: boolean } = {}): Promise<SyncStatus> {
    const config = await loadSyncConfig(this.neolixHome);
    if (!config?.enabled) {
      return this.status();
    }
    this.running = true;
    try {
      let state = (await loadState(this.neolixHome)) ?? emptyState(stateKey(config));
      if (state.key !== stateKey(config)) {
        state = emptyState(stateKey(config));
      }
      // A field put back here since a sync wrote over it is this computer's
      // own from now on (myna `noticeOwn`).
      if (isPartEnabled(config, "models")) {
        noticeOwn(state, await readAgentFields(this.neolixHome));
      }
      const remote = createRemote(config);
      let error: unknown;
      try {
        await this.syncOnce(config, remote, state, options.force === true);
      } catch (caught) {
        if (caught instanceof RemoteConflictError) {
          try {
            await this.syncOnce(config, remote, state, options.force === true);
          } catch (retry) {
            error = retry;
          }
        } else {
          error = caught;
        }
      }
      if (error) {
        state.error = messageOf(error);
        state.serverFile = error instanceof DamagedRemoteError ? { replace: true } : undefined;
      } else {
        state.error = undefined;
        state.serverFile = undefined;
        state.last = new Date().toISOString();
      }
      await saveState(this.neolixHome, state);
      return this.status();
    } finally {
      this.running = false;
    }
  }

  /** Force the server's version over this computer's, keeping an undo snapshot. */
  async restoreRemote(): Promise<SyncStatus> {
    const config = await loadSyncConfig(this.neolixHome);
    if (!config?.enabled) {
      throw new Error("Sync is off");
    }
    const remote = createRemote(config);
    const entries = await remote.list();
    const state = (await loadState(this.neolixHome)) ?? emptyState(stateKey(config));
    state.key = stateKey(config);
    const pulls: PullTarget[] = [];
    for (const part of enabledParts(config)) {
      if (part === "usage") {
        continue; // shared usage is nobody's setup to restore
      }
      const parsed = await this.readRemotePart(config, remote, part, partEntries(entries, part));
      if (parsed.files.length > 0) {
        pulls.push({ part, parsed });
      }
    }
    if (pulls.length === 0) {
      throw new Error("The server holds no setup to restore");
    }
    const snapshot = await this.snapshot(pulls.map((pull) => pull.part));
    for (const pull of pulls) {
      await this.applyPulled(pull.part, pull.parsed, config);
    }
    state.undo = snapshot;
    // A restore is the server's setup wholesale: nothing here stays own
    // (myna `restore.go:103`).
    state.own = undefined;
    state.follow = false;
    state.notice = {
      at: new Date().toISOString(),
      here: pulls.map((pull) => pull.part),
      there: [],
      saved: snapshot ? path.join(this.neolixHome, SNAPSHOT_DIR) : undefined,
      restored: true,
    };
    // The restored setup is this computer's now; the next sync pushes it if
    // the server moved on meanwhile.
    for (const pull of pulls) {
      state.local[pull.part] = pull.parsed.hash;
      state.remote[pull.part] = pull.parsed.hash;
    }
    await saveState(this.neolixHome, state);
    return this.status();
  }

  /**
   * Puts this computer's setup over whatever the server holds, even a file
   * that isn't a Neolix sync file (myna `davsync.Upload`): every pack of the
   * enabled parts goes, and the sync starts over as a first one. The
   * server's files are deleted, not kept; myna keeps them in the sync folder.
   */
  async upload(): Promise<SyncStatus> {
    const config = await loadSyncConfig(this.neolixHome);
    if (!config?.enabled) {
      throw new Error("Sync is off");
    }
    const remote = createRemote(config);
    const entries = await remote.list();
    for (const part of enabledParts(config)) {
      for (const entry of partEntries(entries, part)) {
        // The server's file is kept in the sync folder first, as myna's
        // Upload keeps it (`davsync.Upload`).
        await this.keepServerFile(remote, entry.name);
        await remote.delete(entry.name);
      }
    }
    await saveState(this.neolixHome, emptyState(stateKey(config)));
    return this.run({ force: true });
  }

  /**
   * Gives this computer's own agent fields back to sync: the next sync
   * brings the server's values of them in (myna `Follow`, `own.go:238`).
   */
  async follow(): Promise<SyncStatus> {
    const config = await loadSyncConfig(this.neolixHome);
    if (!config?.enabled) {
      throw new Error("Sync is off");
    }
    const state = (await loadState(this.neolixHome)) ?? emptyState(stateKey(config));
    if (state.own && Object.keys(state.own).length > 0) {
      state.own = undefined;
      state.follow = true;
      await saveState(this.neolixHome, state);
    }
    return this.run();
  }

  /** Bring back the setup from just before the last restore. */
  async undo(): Promise<SyncStatus> {
    const config = await loadSyncConfig(this.neolixHome);
    if (!config?.enabled) {
      throw new Error("Sync is off");
    }
    const state = (await loadState(this.neolixHome)) ?? emptyState(stateKey(config));
    if (!state.undo) {
      throw new Error("There is no restore to undo");
    }
    const manifest = await this.readSnapshot(state.undo);
    if (!manifest) {
      throw new Error("The snapshot to undo is gone");
    }
    for (const [part, packs] of Object.entries(manifest.parts) as [SyncPart, SyncPack[]][]) {
      const files = unpackPacks(packs);
      await applyPart(part, files, { neolixHome: this.neolixHome, keys: config.keys });
      if (part === "settings" && files.some((file) => file.path === "app-settings.json")) {
        const value = await readAppSettingsCopy(this.neolixHome);
        if (value !== null) {
          this.options.onAppSettings?.(value);
        }
      }
    }
    state.notice = undefined;
    state.undo = undefined;
    await saveState(this.neolixHome, state);
    return this.run({ force: true });
  }

  async dismissNotice(): Promise<void> {
    const state = await loadState(this.neolixHome);
    if (!state) {
      return;
    }
    state.notice = undefined;
    state.undo = undefined;
    await saveState(this.neolixHome, state);
  }

  /** The versions the server holds, one per part. */
  async listRemote(): Promise<RemoteVersion[]> {
    const config = await loadSyncConfig(this.neolixHome);
    if (!config?.enabled) {
      return [];
    }
    const remote = createRemote(config);
    const entries = await remote.list();
    const out: RemoteVersion[] = [];
    for (const part of enabledParts(config)) {
      if (part === "usage") {
        continue; // not a version of the setup
      }
      const parsed = await this.readRemotePart(config, remote, part, partEntries(entries, part));
      if (parsed.files.length > 0) {
        out.push({
          part,
          takenAt: parsed.takenAt,
          device: parsed.device,
          files: parsed.files.length,
        });
      }
    }
    return out;
  }

  /** Config file paths, for the settings page's "stored here" line. */
  configPath(): string {
    return syncConfigPath(this.neolixHome);
  }

  // eslint-disable-next-line complexity -- the three-way merge is one decision table.
  private async syncOnce(
    config: SyncConfig,
    remote: SyncRemote,
    state: SyncState,
    force: boolean,
  ): Promise<void> {
    await remote.ensure();
    if (!isPartEnabled(config, "usage")) {
      // Sharing is off: the others' usage goes (myna `DropAllShared`).
      state.usage = undefined;
      state.usageError = undefined;
      await dropOtherUsage(this.neolixHome).catch(() => undefined);
    }
    const entries = await remote.list();
    // "Follow the others": this sync brings the server's values of this
    // computer's own agent fields in (myna `st.Follow`).
    const following = state.follow === true && isPartEnabled(config, "models");
    state.follow = false;
    const pulls: PullTarget[] = [];
    const pushes: SyncPart[] = [];
    let signInsMerged = false;
    const here: SyncPart[] = [];
    const there: SyncPart[] = [];
    const localFiles = new Map<SyncPart, PartFileInput[]>();
    const remoteFiles = new Map<SyncPart, PartFileInput[]>();
    let conflicts = 0;

    for (const part of SYNC_PARTS) {
      if (!isPartEnabled(config, part)) {
        continue;
      }
      const entriesForPart = partEntries(entries, part);
      if (part === "usage") {
        // Usage is one file a computer's day, not a three-way merge; a
        // failure here never fails the setup's sync.
        await this.syncUsage(config, remote, state, force);
        continue;
      }
      const snapshot = await collectPart(part, {
        neolixHome: this.neolixHome,
        keys: config.keys,
      });
      localFiles.set(part, snapshot.files);
      // This computer's own agent fields never go up, and the server's
      // values of them are no change here (myna `hashesOwn`).
      const hashFiles =
        part === "models" ? stripOwnFields(snapshot.files, state.own) : snapshot.files;
      const localHash = partHash(hashFiles);
      const local = state.local[part];
      const knownRemote = state.remote[part];
      const signature = listSignature(entriesForPart);

      let parsed: ParsedRemotePart | null = null;
      const remoteUnchanged =
        entriesForPart.length > 0 &&
        state.remoteList[part] === signature &&
        knownRemote !== undefined;
      if (remoteUnchanged) {
        parsed = await this.readRemotePart(config, remote, part, entriesForPart, true);
      } else if (entriesForPart.length > 0) {
        parsed = await this.readRemotePart(config, remote, part, entriesForPart);
      }
      // The server's hash as this computer compares it: its own fields are
      // left out of both sides (myna `Rafter`).
      const compared =
        parsed === null || part !== "models"
          ? parsed?.files
          : stripOwnFields(parsed.files, state.own);
      const remoteHash = compared ? partHash(compared) : "";
      // A hash kept from before a field became own is the raw one; it still
      // says what this computer last saw (myna `hashesOwn` on both sides).
      const rawLocalHash = partHash(snapshot.files);
      const rawRemoteHash = parsed?.hash ?? "";
      const first = local === undefined && knownRemote === undefined;

      if (remoteHash === "") {
        // Nothing of this part on the server yet: this computer's goes up.
        pushes.push(part);
        state.remoteList[part] = "";
        continue;
      }
      if (part === "models" && following && parsed) {
        pulls.push({ part, parsed });
        here.push(part);
        continue;
      }
      if (localHash === remoteHash) {
        state.local[part] = localHash;
        state.remote[part] = remoteHash;
        state.remoteList[part] = signature;
        continue;
      }

      const localChanged = local !== undefined && localHash !== local && rawLocalHash !== local;
      const remoteChanged =
        knownRemote === undefined || (remoteHash !== knownRemote && rawRemoteHash !== knownRemote);
      if (localChanged && !remoteChanged) {
        pushes.push(part);
        continue;
      }
      if (remoteChanged && !localChanged) {
        let merged = false;
        if (first && part === "settings" && config.keys) {
          merged = await this.keepUnseenGatewayKeys(config, parsed!);
        }
        pulls.push({ part, parsed: parsed! });
        here.push(part);
        if (merged) {
          // The folder's store gains this computer's unseen keys: the merged
          // one goes up, as myna pushes the merged bundle (`davsync.go:1389`).
          pushes.push(part);
        }
        continue;
      }
      // Both sides changed (or the state was lost): the newer wins.
      const localAt = snapshot.changedAt.getTime();
      const remoteAt = Date.parse(parsed?.takenAt ?? "") || 0;
      remoteFiles.set(part, parsed?.files ?? []);
      if (localAt > remoteAt) {
        pushes.push(part);
        there.push(part);
      } else {
        pulls.push({ part, parsed: parsed! });
        here.push(part);
      }
      conflicts += 1;
    }

    // A replaced copy is kept beside the setup, as myna keeps it (`davsync.go:1304`).
    let saved: string | undefined;
    if (conflicts > 0) {
      const stamp = nowStamp();
      for (const part of there) {
        await this.saveConflict(stamp, "server", part, remoteFiles.get(part) ?? [], config);
      }
      for (const part of here) {
        await this.saveConflict(stamp, "this-computer", part, localFiles.get(part) ?? [], config);
      }
      saved = path.join(this.neolixHome, CONFLICT_DIR);
    }
    if (pulls.length > 0) {
      await this.snapshot(pulls.map((pull) => pull.part));
    }

    for (const pull of pulls) {
      if (pull.part === "settings" && config.keys) {
        // Sign-ins merge per account, and a removal on either computer is
        // mirrored (myna `MergeSignIns`); the part is applied without its
        // signins file, which the merge has already written.
        const file = pull.parsed.files.find((entry) => entry.path === "signins.json");
        const merged = await mergeSignInsOnPull(
          this.neolixHome,
          file ? signInBundleOf(file.content) : null,
          state.signIns,
        );
        signInsMerged ||= merged.changed;
        const files = pull.parsed.files.filter((entry) => entry.path !== "signins.json");
        await this.applyPulled(pull.part, { ...pull.parsed, files }, config);
      } else if (pull.part === "models") {
        // The pull writes the server's agent fields here; the fields this
        // computer keeps go back after it (myna `keepServersOwn`).
        const before = await readAgentFields(this.neolixHome);
        await this.applyPulled(pull.part, pull.parsed, config);
        await restoreOwnFields(this.neolixHome, state.own, before);
        noteBrought(state, before, await readAgentFields(this.neolixHome));
      } else {
        await this.applyPulled(pull.part, pull.parsed, config);
      }
      const pulled =
        pull.part === "models"
          ? partHash(stripOwnFields(pull.parsed.files, state.own))
          : pull.parsed.hash;
      state.local[pull.part] = pulled;
      state.remote[pull.part] = pulled;
      state.remoteList[pull.part] = pull.parsed.signature;
    }
    // A sign-in kept here or renewed here goes up with the merged settings.
    if (signInsMerged) {
      pushes.push("settings");
    }

    for (const part of pushes) {
      const snapshot = await collectPart(part, {
        neolixHome: this.neolixHome,
        keys: config.keys,
      });
      const files = part === "models" ? stripOwnFields(snapshot.files, state.own) : snapshot.files;
      const localHash = partHash(files);
      const signature = await this.pushPart(config, remote, part, files, entries);
      state.local[part] = localHash;
      state.remote[part] = localHash;
      state.remoteList[part] = signature;
    }

    // What each sign-in looks like after this sync, for the next one to
    // tell a removal from a join (myna's `st.SignIns`).
    if (config.keys && isPartEnabled(config, "settings")) {
      state.signIns = await signInHashes(this.neolixHome);
    }

    if (here.length > 0 || there.length > 0) {
      state.notice = {
        at: new Date().toISOString(),
        here,
        there,
        ...(saved ? { saved } : {}),
      };
      state.undo = undefined;
    }
  }

  /**
   * Shares this computer's usage and brings the others' days in (myna
   * `shareUsage`, `internal/davsync/usage.go`). Each computer writes one
   * sealed file a day and one quota file under `usage/`, so nothing is
   * three-way merged and none is ever in a backup or a restore. Sharing runs
   * every `USAGE_EVERY_MS` on its own clock; a sync asked for shares it at
   * once.
   */
  private async syncUsage(
    config: SyncConfig,
    remote: SyncRemote,
    state: SyncState,
    force: boolean,
  ): Promise<void> {
    try {
      const now = Date.now();
      const at = state.usage?.at ? Date.parse(state.usage.at) : Number.NaN;
      if (!force && Number.isFinite(at) && now - at < USAGE_EVERY_MS) {
        return;
      }
      await remote.ensure(USAGE_DIR);
      const device = await usageDevice(this.neolixHome, config.device ?? "neox");
      const usage: UsageSyncState = state.usage ?? {};
      state.usage = usage;
      const files: UsageRemoteFiles = {
        list: async () => {
          const wanted = `${USAGE_DIR}/`;
          const out = new Map<string, string>();
          for (const entry of await remote.list(USAGE_DIR)) {
            const name = entry.name.startsWith(wanted)
              ? entry.name.slice(wanted.length)
              : entry.name;
            out.set(name, entry.etag ?? "");
          }
          return out;
        },
        read: async (name) => {
          const file = await remote.get(`${USAGE_DIR}/${name}`);
          if (!file) {
            throw new Error(`the server has no usage file ${name}`);
          }
          return file.data;
        },
        write: async (name, data) => {
          // A computer writes only its own files, so no version is compared.
          await remote.put(`${USAGE_DIR}/${name}`, data, undefined);
        },
        remove: async (name) => remote.delete(`${USAGE_DIR}/${name}`),
      };
      await shareUsage({
        neolixHome: this.neolixHome,
        passphrase: config.passphrase,
        device,
        state: usage,
        files,
        now,
      });
      state.usageError = undefined;
    } catch (error) {
      state.usageError = messageOf(error);
    }
  }

  /**
   * The first sync into a folder keeps the gateway keys the folder has never
   * seen (myna `keepUnseenGatewayKeys`, `davsync.go:1088`): a key the folder
   * holds by value is the folder's and its copy wins; afterwards absence
   * from a store this computer has seen is a removal, which goes everywhere.
   */
  private async keepUnseenGatewayKeys(
    config: SyncConfig,
    remote: ParsedRemotePart,
  ): Promise<boolean> {
    const settingsFile = remote.files.find((file) => file.path === "settings.json");
    if (!settingsFile) {
      return false;
    }
    let incoming: Record<string, unknown>;
    try {
      incoming = JSON.parse(Buffer.from(settingsFile.content).toString("utf8")) as Record<
        string,
        unknown
      >;
    } catch {
      return false;
    }
    const gateway = isRecord(incoming.gateway) ? incoming.gateway : undefined;
    if (!gateway || !Array.isArray(gateway.keys)) {
      return false;
    }
    const local = await collectPart("settings", { neolixHome: this.neolixHome, keys: config.keys });
    const localFile = local.files.find((file) => file.path === "settings.json");
    if (!localFile) {
      return false;
    }
    const localSettings = JSON.parse(Buffer.from(localFile.content).toString("utf8")) as Record<
      string,
      unknown
    >;
    const localGateway = isRecord(localSettings.gateway) ? localSettings.gateway : undefined;
    const localKeys = Array.isArray(localGateway?.keys) ? localGateway.keys : [];
    const known = new Set(gateway.keys.map((entry) => keyValue(entry)));
    const gatewayBefore = gateway.keys.length;
    const merged = [...gateway.keys];
    for (const entry of localKeys) {
      const value = keyValue(entry);
      if (value.length === 0 || known.has(value)) {
        continue;
      }
      merged.push(entry);
      known.add(value);
    }
    gateway.keys = merged;
    // Apply only the merged store over this computer's, as a normal pull would.
    settingsFile.content = Buffer.from(`${JSON.stringify(incoming, null, 2)}\n`, "utf8");
    // The pull's hash must be what this computer ends up with, or the next
    // sync would take its own keys for a change and push them again.
    remote.hash = partHash(remote.files);
    return merged.length > gatewayBefore;
  }

  private async applyPulled(
    part: SyncPart,
    parsed: ParsedRemotePart,
    config: SyncConfig,
  ): Promise<void> {
    await applyPart(part, parsed.files, { neolixHome: this.neolixHome, keys: config.keys });
    if (part === "settings" && parsed.files.some((file) => file.path === "app-settings.json")) {
      const value = await readAppSettingsCopy(this.neolixHome);
      if (value !== null) {
        this.options.onAppSettings?.(value);
      }
    }
  }

  private async pushPart(
    config: SyncConfig,
    remote: SyncRemote,
    part: SyncPart,
    files: readonly PartFileInput[],
    entries: readonly RemoteEntry[],
  ): Promise<string> {
    const packs = buildPacks({
      part,
      device: config.device ?? "neox",
      files,
    });
    const wanted = new Set(packs.map(packFileName));
    const existing = new Map(
      partEntries(entries, part).map((entry) => [entry.name, entry.etag] as const),
    );
    const written: RemoteEntry[] = [];
    for (const pack of packs) {
      const name = packFileName(pack);
      const sealed = sealPack(pack, config.passphrase);
      const expected = existing.has(name) ? (existing.get(name) ?? undefined) : null;
      const result = await remote.put(name, sealed, expected);
      written.push({ name, etag: result.etag });
      await writeCache(this.neolixHome, name, pack);
    }
    for (const [name] of existing) {
      if (!wanted.has(name)) {
        await remote.delete(name);
      }
    }
    await trimCache(this.neolixHome, part, wanted);
    return listSignature(written);
  }

  /** The losing side of a conflict, sealed, under `$NEOLIX_HOME/sync/`. */
  private async saveConflict(
    stamp: string,
    side: "server" | "this-computer",
    part: SyncPart,
    files: readonly PartFileInput[],
    config: SyncConfig,
  ): Promise<void> {
    const dir = path.join(this.neolixHome, CONFLICT_DIR);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const packs = buildPacks({ part, device: config.device ?? "neox", files });
    for (const pack of packs) {
      const name = `${stamp}-${side}-${pack.part}-${String(pack.index).padStart(3, "0")}.neolixsync`;
      await writeFile(path.join(dir, name), sealPack(pack, config.passphrase), { mode: 0o600 });
    }
  }

  private async readRemotePart(
    config: SyncConfig,
    remote: SyncRemote,
    _part: SyncPart,
    entries: readonly RemoteEntry[],
    useCache = false,
  ): Promise<ParsedRemotePart> {
    const signature = listSignature(entries);
    const packs: SyncPack[] = [];
    const damaged: RemoteEntry[] = [];
    for (const entry of entries) {
      try {
        const cached = useCache ? await readCache(this.neolixHome, entry.name) : null;
        if (cached) {
          packs.push(cached);
          continue;
        }
        const file = await remote.get(entry.name);
        if (!file) {
          continue;
        }
        const pack = openPack(file.data, config.passphrase);
        packs.push(pack);
        await writeCache(this.neolixHome, entry.name, pack);
      } catch {
        damaged.push(entry);
      }
    }
    if (damaged.length > 0) {
      // A damaged pack is rebuilt from the cached copy this computer read
      // whole before it broke (myna `corrupt_remote_test`). With no such
      // copy the error stands rather than losing another computer's setup.
      for (const entry of damaged) {
        const cached = await readCache(this.neolixHome, entry.name);
        if (cached) {
          packs.push(cached);
          await this.keepDamaged(entry.name);
        } else {
          throw new DamagedRemoteError(entry.name);
        }
      }
    }
    packs.sort((a, b) => a.index - b.index);
    const files = unpackPacks(packs);
    const takenAt =
      packs
        .map((pack) => pack.takenAt)
        .sort()
        .at(-1) ?? new Date(0).toISOString();
    return {
      files,
      takenAt,
      device: packs[0]?.device ?? "",
      names: entries.map((entry) => entry.name),
      hash: partHash(files),
      signature,
    };
  }

  /** The server's file as it is, into `$NEOLIX_HOME/sync/`, before it is replaced. */
  private async keepServerFile(remote: SyncRemote, name: string): Promise<void> {
    let data: Buffer | null = null;
    try {
      data = (await remote.get(name))?.data ?? null;
    } catch {
      return;
    }
    if (!data) {
      return;
    }
    const dir = path.join(this.neolixHome, CONFLICT_DIR);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(path.join(dir, `${nowStamp()}-server-${name}`), data, { mode: 0o600 });
  }

  private async keepDamaged(name: string): Promise<void> {
    const dir = path.join(this.neolixHome, CONFLICT_DIR);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const cached = path.join(this.neolixHome, CACHE_DIR, `${name}.json`);
    try {
      const data = await readFile(cached);
      await writeFile(path.join(dir, `${nowStamp()}-server-damaged-${name}.json`), data, {
        mode: 0o600,
      });
    } catch {
      return;
    }
    const damaged = (await readdir(dir))
      .filter((entry) => entry.includes("-server-damaged-"))
      .sort();
    for (const old of damaged.slice(0, Math.max(damaged.length - KEEP_DAMAGED, 0))) {
      await rm(path.join(dir, old), { force: true });
    }
  }

  /** Saves the parts here now, sealed, for `undo`. Returns the folder. */
  private async snapshot(parts: readonly SyncPart[]): Promise<string | undefined> {
    if (parts.length === 0) {
      return undefined;
    }
    const config = await loadSyncConfig(this.neolixHome);
    if (!config) {
      return undefined;
    }
    const stamp = nowStamp();
    const dir = path.join(this.neolixHome, SNAPSHOT_DIR, stamp);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const manifest: { version: 1; at: string; parts: Partial<Record<SyncPart, string[]>> } = {
      version: 1,
      at: new Date().toISOString(),
      parts: {},
    };
    for (const part of parts) {
      if (!isPartEnabled(config, part)) {
        continue;
      }
      const snapshot = await collectPart(part, {
        neolixHome: this.neolixHome,
        keys: config.keys,
      });
      const packs = buildPacks({
        part,
        device: config.device ?? "neox",
        files: snapshot.files,
      });
      const names: string[] = [];
      for (const pack of packs) {
        const name = `${pack.part}.${String(pack.index).padStart(3, "0")}.snapshot`;
        await writeFile(path.join(dir, name), sealPack(pack, config.passphrase), { mode: 0o600 });
        names.push(name);
      }
      manifest.parts[part] = names;
    }
    await writeFile(path.join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600,
    });
    await this.trimSnapshots();
    return stamp;
  }

  private async readSnapshot(
    stamp: string,
  ): Promise<{ parts: Partial<Record<SyncPart, SyncPack[]>> } | null> {
    const dir = path.join(this.neolixHome, SNAPSHOT_DIR, stamp);
    const config = await loadSyncConfig(this.neolixHome);
    if (!config) {
      return null;
    }
    let manifest: { parts?: Partial<Record<SyncPart, string[]>> };
    try {
      manifest = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8")) as {
        parts?: Partial<Record<SyncPart, string[]>>;
      };
    } catch {
      return null;
    }
    const parts: Partial<Record<SyncPart, SyncPack[]>> = {};
    for (const [part, names] of Object.entries(manifest.parts ?? {}) as [SyncPart, string[]][]) {
      const packs: SyncPack[] = [];
      for (const name of names) {
        const sealed = await readFile(path.join(dir, name)).catch(() => null);
        if (sealed) {
          packs.push(openPack(sealed, config.passphrase));
        }
      }
      parts[part] = packs;
    }
    return { parts };
  }

  private async hasUndo(stamp: string): Promise<boolean> {
    try {
      await stat(path.join(this.neolixHome, SNAPSHOT_DIR, stamp, "manifest.json"));
      return true;
    } catch {
      return false;
    }
  }

  private async trimSnapshots(): Promise<void> {
    const dir = path.join(this.neolixHome, SNAPSHOT_DIR);
    let entries: string[];
    try {
      entries = (await readdir(dir)).sort();
    } catch {
      return;
    }
    for (const old of entries.slice(0, Math.max(entries.length - KEEP_SNAPSHOTS, 0))) {
      await rm(path.join(dir, old), { recursive: true, force: true });
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function keyValue(entry: unknown): string {
  if (typeof entry === "string") {
    return entry;
  }
  if (isRecord(entry) && typeof entry.key === "string") {
    return entry.key;
  }
  return "";
}
