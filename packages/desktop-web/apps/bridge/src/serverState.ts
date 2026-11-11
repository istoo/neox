// Server-level state the front end subscribes to: settings (kept by the bridge, since Neox has
// no store for this front end's preferences), config and provider statuses (read from the
// daemon), keep-awake and lifecycle. Every stream opens with the current value, then follows
// changes made through this bridge.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
  ServerConfig,
  ServerConfigStreamEvent,
  ServerKeepAwakeUpdatedPayload,
  ServerLifecycleStreamEvent,
  ServerProviderStatus,
  ServerSettingsView,
} from "@synara/contracts";

import { daemonProviderIdForInstanceId } from "./providerConfig.ts";

type Listener<A> = (item: A) => void;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A settings patch names whole top-level keys; nested objects merge, arrays and scalars replace. */
export function mergeSettings<T>(base: T, patch: Record<string, unknown>): T {
  const merged: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const current = merged[key];
    merged[key] =
      isPlainObject(current) && isPlainObject(value) ? mergeSettings(current, value) : value;
  }
  return merged as T;
}

export interface ServerStateSources {
  /** Daemon-derived config: providers, paths, keybindings. */
  readonly config: () => Promise<ServerConfig>;
  /** Settings built from the daemon's providers, before any saved preferences are applied. */
  readonly baseSettings: () => Promise<ServerSettingsView>;
  /** File the user's preference patches are kept in across bridge restarts. */
  readonly settingsFile: string;
  /**
   * Writes provider launch config to the daemon before the local settings patch is saved.
   * The daemon is the source of truth for binary, environment and home-directory fields.
   */
  readonly applyProviderSettings?: (patch: Record<string, unknown>) => Promise<void>;
  /** What stays in the bridge-local file: presentation fields the daemon does not store. */
  readonly localSettingsPatch?: (patch: Record<string, unknown>) => Record<string, unknown>;
  readonly cwd: string;
  /** The host's home folder; the client builds its Home chat container from it. */
  readonly homeDir?: string;
  readonly log: (line: string) => void;
}

/**
 * The web names accounts with `_` (for example `codex_work`); the daemon's provider ids only
 * allow `-`, so the same account comes back derived as `codex-work`. Re-key the derived entry
 * onto the id the user saved and merge it underneath, or the account list shows it twice.
 * Presentation fields win because they only exist locally; launch fields survive from the
 * daemon entry.
 */
function mergeProviderInstanceAliases(
  settings: ServerSettingsView,
  savedPatch: Record<string, unknown>,
): ServerSettingsView {
  const instances = settings.providerInstances as Record<string, unknown> | undefined;
  const saved = savedPatch.providerInstances;
  if (!isPlainObject(instances) || !isPlainObject(saved)) return settings;
  const next: Record<string, unknown> = { ...instances };
  for (const localId of Object.keys(saved)) {
    const daemonId = daemonProviderIdForInstanceId(localId);
    if (daemonId === localId) continue;
    const derived = next[daemonId];
    if (!isPlainObject(derived)) continue;
    const local = isPlainObject(next[localId]) ? next[localId] : {};
    next[localId] = mergeSettings(derived, local);
    delete next[daemonId];
  }
  return { ...settings, providerInstances: next } as ServerSettingsView;
}

export class ServerState {
  private savedPatch: Record<string, unknown> = {};
  private loaded = false;
  private readonly settingsListeners = new Set<Listener<ServerSettingsView>>();
  private readonly configListeners = new Set<Listener<ServerConfigStreamEvent>>();
  private readonly providerListeners = new Set<
    Listener<{ providers: readonly ServerProviderStatus[] }>
  >();

  constructor(private readonly sources: ServerStateSources) {}

  private async loadPatch(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(await fs.readFile(this.sources.settingsFile, "utf8")) as unknown;
      if (isPlainObject(raw)) {
        // Older files may still hold provider launch fields; the daemon owns those now, so
        // strip them on read instead of letting a stale local copy shadow the daemon.
        this.savedPatch = this.sources.localSettingsPatch?.(raw) ?? raw;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.sources.log(`settings file unreadable, starting from defaults: ${String(error)}`);
      }
    }
  }

  async settings(): Promise<ServerSettingsView> {
    await this.loadPatch();
    const merged = mergeSettings(await this.sources.baseSettings(), this.savedPatch);
    return mergeProviderInstanceAliases(merged, this.savedPatch);
  }

  /** Applies a patch, saves it (write to a temp file, then rename), and tells subscribers. */
  async updateSettings(patch: Record<string, unknown>): Promise<ServerSettingsView> {
    await this.loadPatch();
    // Provider launch fields go to the daemon first; if that write fails the patch fails as a
    // whole, so the front end's optimistic state can be rolled back.
    if (patch.providers !== undefined || patch.providerInstances !== undefined) {
      await this.sources.applyProviderSettings?.(patch);
    }
    const localPatch = this.sources.localSettingsPatch?.(patch) ?? patch;
    const nextPatch = mergeSettings(this.savedPatch, localPatch);
    // The front end sends `providerInstances` as a complete map, so an id missing from the
    // patch was deleted. Deep-merging would keep the old entry and the account would return.
    if (isPlainObject(localPatch.providerInstances)) {
      nextPatch.providerInstances = localPatch.providerInstances;
    }
    const file = this.sources.settingsFile;
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(temp, `${JSON.stringify(nextPatch, null, 2)}\n`, "utf8");
    await fs.rename(temp, file);
    this.savedPatch = nextPatch;
    const settings = await this.settings();
    for (const listener of this.settingsListeners) listener(settings);
    for (const listener of this.configListeners)
      listener({ type: "settingsUpdated", payload: { settings } });
    return settings;
  }

  /** Re-reads the config after a change the bridge itself made (e.g. keybindings). */
  async refreshConfig(): Promise<ServerConfig> {
    const config = await this.sources.config();
    for (const listener of this.configListeners) listener({ type: "snapshot", config });
    return config;
  }

  async refreshProviders(): Promise<{ providers: readonly ServerProviderStatus[] }> {
    const config = await this.sources.config();
    const update = { providers: config.providers };
    for (const listener of this.providerListeners) listener(update);
    for (const listener of this.configListeners) {
      listener({ type: "providerStatuses", payload: update } as ServerConfigStreamEvent);
    }
    return update;
  }

  subscribeSettings(listener: Listener<{ settings: ServerSettingsView }>): () => void {
    const forward = (settings: ServerSettingsView) => listener({ settings });
    this.settingsListeners.add(forward);
    void this.settings().then(forward, (error) =>
      this.sources.log(`settings snapshot failed: ${String(error)}`),
    );
    return () => this.settingsListeners.delete(forward);
  }

  subscribeConfig(listener: Listener<ServerConfigStreamEvent>): () => void {
    this.configListeners.add(listener);
    void this.sources.config().then(
      (config) => listener({ type: "snapshot", config }),
      (error) => this.sources.log(`config snapshot failed: ${String(error)}`),
    );
    return () => this.configListeners.delete(listener);
  }

  subscribeProviderStatuses(
    listener: Listener<{ providers: readonly ServerProviderStatus[] }>,
  ): () => void {
    this.providerListeners.add(listener);
    void this.sources.config().then(
      (config) => listener({ providers: config.providers }),
      (error) => this.sources.log(`provider snapshot failed: ${String(error)}`),
    );
    return () => this.providerListeners.delete(listener);
  }

  /** Neox does not hold the machine awake for this front end; the switch reads as unavailable. */
  async keepAwake(): Promise<ServerKeepAwakeUpdatedPayload> {
    const settings = await this.settings();
    return {
      keepAwake: { available: false, mode: settings.keepAwakeMode, active: false, error: null },
    };
  }

  lifecycle(): ServerLifecycleStreamEvent[] {
    return [
      {
        type: "welcome",
        payload: {
          cwd: this.sources.cwd,
          ...(this.sources.homeDir ? { homeDir: this.sources.homeDir } : {}),
          projectName: path.basename(this.sources.cwd) || "Neox",
        },
      } as ServerLifecycleStreamEvent,
      { type: "ready", payload: { at: new Date().toISOString() } } as ServerLifecycleStreamEvent,
    ];
  }
}
