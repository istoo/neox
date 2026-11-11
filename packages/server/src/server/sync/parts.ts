import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { chmod, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { GatewayConfigSchema } from "../llm-gateway/config.js";
import { PersistedConfigSchema, type PersistedConfig } from "../persisted-config.js";
import { writePrivateFileAtomic } from "../private-files.js";
import { keepLastGood } from "../last-good.js";
import { resolveLibraryPaths, writeLibrary, type StoredLibrary } from "../library/store.js";
import { applySignIns, collectSignIns, SIGNIN_FILES, type SignInBundle } from "./signins.js";
import type { PartFileInput } from "./archive.js";

/**
 * The five parts myna syncs (`internal/davsync/davsync.go:59`), mapped onto
 * Neolix's files. Each part is a set of files so `archive.ts` can pack and
 * seal it the way myna seals its bundle.
 */
export const SYNC_PARTS = [
  "sources",
  "settings",
  "profiles",
  "models",
  "library",
  "usage",
] as const;
export type SyncPart = (typeof SYNC_PARTS)[number];

/** `gateway.json` keys that belong to the sources part (myna's providers). */
export const GATEWAY_SOURCE_KEYS = [
  "providers",
  "groups",
  "groupOrder",
  "hiddenGroups",
  "autoGroups",
  "autoGroupSkip",
] as const;

/**
 * The rest of `gateway.json` that is a setting, not this computer's own.
 * `version` is the file's shape; `keys` is a secret handled by `keys`.
 */
export const GATEWAY_SETTING_KEYS = [
  "enabled",
  "allowIPs",
  "corsOrigins",
  "pricing",
  "modelSameAs",
  "budget",
  "recording",
  "masking",
  "oidc",
  "search",
  "mcp",
  "codexBackend",
  "accountDiscovery",
  // COMPAT(codexAccountDiscovery): kept for clients older than v0.16.0; remove after 2027-11-06.
  "codexAccountDiscovery",
  "codexSignInWriteBack",
  "codexAutoSwitchSignIn",
  "claudeAutoSwitchSignIn",
  "claudeSignInWriteBack",
  "codexSessionReads",
  "codexSignInLinkOnly",
  "modelNames",
  "codexWarmup",
  "claudeWarmup",
  "codexWarmAts",
  "claudeWarmAts",
  "codexResetLead",
  "claudeLeanPrompt",
  "claudePrintMode",
  "claudeRunsMost",
  "fetchPrivate",
  "codexTitles",
  "codexDescriptions",
  "codexPredictions",
  "replyModel",
  "memberModel",
  "turnDoneSeconds",
  "noLoopGuard",
  "refusalRetries",
  "classifyTimeout",
  "proxy",
  "otel",
  "middleware",
  "vision",
  "archive",
] as const;

/**
 * `config.json`'s daemon keys that travel. Left out, as myna's KeepOwn leaves
 * them out (`internal/settings/settings.go:1351`): `listen`, `port`, `lan`,
 * `lanKey`, `hostnames`, `allowedHosts`, `trustedProxies`, `noWslAgents`,
 * `git`, `terminalProfiles`, `auth`.
 */
export const DAEMON_SETTING_KEYS = [
  "autoArchiveAfterMerge",
  "enableTerminalAgentHooks",
  "appendSystemPrompt",
  "relay",
  "usage",
  "browserTools",
  "mcp",
  "serviceProxy",
  "cors",
] as const;

/** `config.json` top-level keys that travel; the rest is this computer's. */
export const CONFIG_SETTING_KEYS = [
  "pluginsEnabled",
  "plugins",
  "pluginRegistries",
  "builtinFeatures",
  "builtinFeatureConfig",
  "app",
] as const;

/** The library subdirectories that are the user's setup. */
const LIBRARY_DIRS = ["instructions", "instruction-sets", "skills"] as const;
/** Skill checkouts carry git internals that are not the setup. */
const LIBRARY_SKIP_DIRS = new Set([".git", "node_modules"]);
const LIBRARY_MAX_FILE = 8 * 1024 * 1024;

export const APP_SETTINGS_FILENAME = "sync-app-settings.json";

export interface CollectOptions {
  neolixHome: string;
  /** Provider and library credentials go in the bundle. */
  keys: boolean;
  /**
   * Subscription sign-ins go in the settings part. Absent follows `keys`,
   * which is how sync carries them; a backup has its own switch.
   */
  signIns?: boolean;
  /** Which parts are on; absent is on. */
  enabledParts?: Partial<Record<SyncPart, boolean>>;
  /** This computer's id in the usage part; absent is "neox". */
  device?: string;
}

export interface PartSnapshot {
  part: SyncPart;
  files: PartFileInput[];
  /** Latest change on this computer, as the files' mtimes say. */
  changedAt: Date;
}

/** A part's packs as one hash: what a sync compares to tell a change. */
export function partHash(files: readonly PartFileInput[]): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(file.path);
    hash.update("\0");
    hash.update(createHash("sha256").update(toBuffer(file.content)).digest("hex"));
    hash.update("\n");
  }
  return hash.digest("hex");
}

function toBuffer(content: Buffer | string): Buffer {
  return Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
}

async function readJson(file: string): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** JSON with object keys sorted, so equal values hash equal. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (isRecord(value)) {
    const entries = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function pick(source: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (source[key] !== undefined) {
      out[key] = source[key];
    }
  }
  return out;
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const SECRET_ENV = /(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i;

function stripEnvSecrets(env: unknown): unknown {
  if (!isRecord(env)) {
    return env;
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!SECRET_ENV.test(key)) {
      out[key] = value;
    }
  }
  return out;
}

/** Gateway providers with their credentials taken out when `keys` is off. */
function redactSources(sources: Record<string, unknown>, keys: boolean): Record<string, unknown> {
  if (keys) {
    return sources;
  }
  const out = deepClone(sources);
  const providers = Array.isArray(out.providers) ? out.providers : [];
  for (const provider of providers) {
    if (!isRecord(provider)) {
      continue;
    }
    delete provider.apiKey;
    if (Array.isArray(provider.accounts)) {
      for (const account of provider.accounts) {
        if (isRecord(account)) {
          delete account.apiKey;
          delete account.headers;
        }
      }
    }
    delete provider.headers;
  }
  return out;
}

function redactGatewaySettings(
  settings: Record<string, unknown>,
  keys: boolean,
): Record<string, unknown> {
  const out = deepClone(settings);
  if (!keys) {
    delete out.keys;
    if (isRecord(out.otel)) {
      delete out.otel.headers;
    }
  }
  return out;
}

function redactConfigParts(
  config: Record<string, unknown>,
  keys: boolean,
): Record<string, unknown> {
  const out = deepClone(config);
  if (!keys) {
    const daemon = isRecord(out.daemon) ? out.daemon : undefined;
    if (daemon) {
      delete daemon.lanKey;
    }
    const agents = isRecord(out.agents) ? out.agents : undefined;
    if (agents && isRecord(agents.providers)) {
      for (const provider of Object.values(agents.providers)) {
        if (isRecord(provider) && provider.env !== undefined) {
          provider.env = stripEnvSecrets(provider.env);
        }
      }
    }
  }
  return out;
}

/** The library object without the fields this computer alone owns. */
export function sanitizeLibrary(library: StoredLibrary, keys: boolean): StoredLibrary {
  const out = deepClone(library) as unknown as Record<string, unknown>;
  delete out.applied;
  delete out.seenSkills;
  // A server kept to this computer is carried to no other computer; the other
  // computers' by its name (Away) are carried on as they came.
  out.mcp = [
    ...((out.mcp as StoredLibrary["mcp"] | undefined) ?? []).filter(
      (server) => server.local !== true,
    ),
    ...((out.away as StoredLibrary["away"] | undefined) ?? []),
  ];
  delete out.away;
  for (const skill of (out.skills as StoredLibrary["skills"] | undefined) ?? []) {
    delete (skill as { offHere?: boolean }).offHere;
  }
  if (!keys) {
    for (const server of (out.mcp as StoredLibrary["mcp"] | undefined) ?? []) {
      delete server.env;
      delete server.headers;
      if (server.oauth) {
        delete server.oauth.clientSecret;
      }
    }
  }
  return out as unknown as StoredLibrary;
}

async function listLibraryFiles(
  neolixHome: string,
): Promise<{ files: PartFileInput[]; changedAt: Date }> {
  const paths = resolveLibraryPaths(neolixHome);
  const files: PartFileInput[] = [];
  let changedAt = new Date(0);

  const note = async (file: string) => {
    try {
      const info = await stat(file);
      if (info.mtime > changedAt) {
        changedAt = info.mtime;
      }
      return info;
    } catch {
      return null;
    }
  };

  const walk = async (dir: string, prefix: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (LIBRARY_SKIP_DIRS.has(entry.name)) {
          continue;
        }
        await walk(path.join(dir, entry.name), `${prefix}${entry.name}/`);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const absolute = path.join(dir, entry.name);
      const info = await note(absolute);
      if (!info || info.size > LIBRARY_MAX_FILE) {
        continue;
      }
      files.push({
        path: `${prefix}${entry.name}`,
        content: await readFile(absolute),
        mode: info.mode & 0o777,
      });
    }
  };

  for (const dir of LIBRARY_DIRS) {
    await walk(path.join(paths.dir, dir), `${dir}/`);
  }
  const dataFile = paths.dataFile;
  const info = await note(dataFile);
  if (info) {
    const raw = await readJson(dataFile);
    const library = sanitizeLibrary(raw as unknown as StoredLibrary, true);
    files.push({
      path: "library.json",
      content: `${JSON.stringify(library, null, 2)}\n`,
      mode: 0o600,
    });
  }
  return { files, changedAt };
}

function latest(...dates: Date[]): Date {
  return dates.reduce((a, b) => (b > a ? b : a), new Date(0));
}

async function mtime(file: string): Promise<Date> {
  try {
    return (await stat(file)).mtime;
  } catch {
    return new Date(0);
  }
}

/** One part as this computer has it, with credentials kept out when asked. */
export async function collectPart(part: SyncPart, options: CollectOptions): Promise<PartSnapshot> {
  const home = options.neolixHome;
  const gatewayPath = path.join(home, "gateway.json");
  const configPath = path.join(home, "config.json");
  const appSettingsPath = path.join(home, APP_SETTINGS_FILENAME);

  switch (part) {
    case "sources": {
      const gateway = await readJson(gatewayPath);
      const sources = redactSources(pick(gateway, GATEWAY_SOURCE_KEYS), options.keys);
      return {
        part,
        files: [{ path: "sources.json", content: `${JSON.stringify(sources, null, 2)}\n` }],
        changedAt: await mtime(gatewayPath),
      };
    }
    case "settings": {
      const gateway = await readJson(gatewayPath);
      const config = await readJson(configPath);
      const gatewaySettings = redactGatewaySettings(
        pick(gateway, GATEWAY_SETTING_KEYS),
        options.keys,
      );
      if (gateway.keys !== undefined && options.keys) {
        gatewaySettings.keys = gateway.keys;
      }
      const daemon = isRecord(config.daemon) ? config.daemon : {};
      const settings: Record<string, unknown> = {
        gateway: gatewaySettings,
        config: {
          ...pick(config, CONFIG_SETTING_KEYS),
          daemon: pick(daemon, DAEMON_SETTING_KEYS),
        },
      };
      if (options.keys && isRecord(daemon) && daemon.lanKey !== undefined) {
        (settings.config as Record<string, unknown>).daemon = {
          ...(settings.config as { daemon: Record<string, unknown> }).daemon,
          lanKey: daemon.lanKey,
        };
      }
      const files: PartFileInput[] = [
        { path: "settings.json", content: `${JSON.stringify(settings, null, 2)}\n` },
      ];
      let appMtime = new Date(0);
      try {
        const appSettings = await readFile(appSettingsPath);
        JSON.parse(appSettings.toString("utf8"));
        files.push({ path: "app-settings.json", content: appSettings, mode: 0o600 });
        appMtime = await mtime(appSettingsPath);
      } catch {
        // no app settings exported yet: the daemon's copy is the only one
      }
      let signInMtime = new Date(0);
      if (options.signIns ?? options.keys) {
        const signIns = await collectSignIns(home);
        // An empty set is carried too: that is how a computer that removed
        // its last sign-in tells the others (myna's non-nil SignIns).
        files.push({
          path: "signins.json",
          content: `${JSON.stringify(signIns, null, 2)}\n`,
          mode: 0o600,
        });
        signInMtime = latest(
          ...(await Promise.all(SIGNIN_FILES.map((relPath) => mtime(path.join(home, relPath))))),
        );
      }
      return {
        part,
        files,
        changedAt: latest(await mtime(gatewayPath), await mtime(configPath), appMtime, signInMtime),
      };
    }
    case "profiles": {
      const config = await readJson(configPath);
      const daemon = isRecord(config.daemon) ? config.daemon : {};
      const profiles = { agentProfiles: daemon.agentProfiles ?? [] };
      return {
        part,
        files: [{ path: "profiles.json", content: `${JSON.stringify(profiles, null, 2)}\n` }],
        changedAt: await mtime(configPath),
      };
    }
    case "models": {
      const config = await readJson(configPath);
      const agents = redactConfigParts({ agents: config.agents ?? {} }, options.keys);
      return {
        part,
        files: [{ path: "models.json", content: `${JSON.stringify(agents, null, 2)}\n` }],
        changedAt: await mtime(configPath),
      };
    }
    case "library": {
      const { files, changedAt } = await listLibraryFiles(home);
      return { part, files, changedAt };
    }
    case "usage": {
      // Usage is shared as one file a day under `usage/`, not as a part
      // (`engine.ts` `syncUsage`); a backup never carries it.
      return { part, files: [], changedAt: new Date(0) };
    }
  }
}

export interface ApplyOptions {
  neolixHome: string;
  keys: boolean;
  /** Sign-ins are brought in; absent follows `keys`, as sync does. */
  signIns?: boolean;
}

/**
 * Writes a part over this computer's. Structured parts own their keys: a key
 * the part no longer has is removed, which is myna's mirror
 * (`internal/davsync/davsync.go:1017`). Device-local keys are never touched.
 */
// eslint-disable-next-line complexity -- one case per part, each a short mirror.
export async function applyPart(
  part: SyncPart,
  files: readonly PartFileInput[],
  options: ApplyOptions,
): Promise<void> {
  const home = options.neolixHome;
  const byPath = new Map(files.map((file) => [file.path, file]));

  switch (part) {
    case "sources": {
      const incoming = parseJsonFile(byPath.get("sources.json"));
      const gatewayPath = path.join(home, "gateway.json");
      const current = await readJson(gatewayPath);
      for (const key of GATEWAY_SOURCE_KEYS) {
        delete current[key];
      }
      Object.assign(current, incoming);
      await writeGateway(gatewayPath, current);
      return;
    }
    case "settings": {
      const incoming = parseJsonFile(byPath.get("settings.json"));
      const gatewayIn = isRecord(incoming.gateway) ? incoming.gateway : {};
      const configIn = isRecord(incoming.config) ? incoming.config : {};
      const daemonIn = isRecord(configIn.daemon) ? configIn.daemon : {};

      const gatewayPath = path.join(home, "gateway.json");
      const gateway = await readJson(gatewayPath);
      for (const key of GATEWAY_SETTING_KEYS) {
        delete gateway[key];
      }
      if (options.keys) {
        delete gateway.keys;
      }
      Object.assign(gateway, gatewayIn);
      await writeGateway(gatewayPath, gateway);

      const configPath = path.join(home, "config.json");
      const config = await readJson(configPath);
      const currentDaemon = isRecord(config.daemon) ? config.daemon : {};
      for (const key of CONFIG_SETTING_KEYS) {
        delete config[key];
      }
      Object.assign(config, pick(configIn, CONFIG_SETTING_KEYS));
      for (const key of DAEMON_SETTING_KEYS) {
        delete currentDaemon[key];
      }
      if (options.keys) {
        delete currentDaemon.lanKey;
      }
      Object.assign(currentDaemon, daemonIn);
      config.daemon = currentDaemon;
      await writeConfig(configPath, config);

      const appFile = byPath.get("app-settings.json");
      if (appFile) {
        const target = path.join(home, APP_SETTINGS_FILENAME);
        await writePrivateFileAtomic(target, toBuffer(appFile.content).toString("utf8"));
        await chmod(target, 0o600);
      }
      const signInFile = byPath.get("signins.json");
      if (signInFile && (options.signIns ?? options.keys)) {
        await applySignIns(
          home,
          JSON.parse(toBuffer(signInFile.content).toString("utf8")) as SignInBundle,
        );
      }
      return;
    }
    case "profiles": {
      const incoming = parseJsonFile(byPath.get("profiles.json"));
      const configPath = path.join(home, "config.json");
      const config = await readJson(configPath);
      const daemon = isRecord(config.daemon) ? config.daemon : {};
      delete daemon.agentProfiles;
      if (incoming.agentProfiles !== undefined) {
        daemon.agentProfiles = incoming.agentProfiles;
      }
      config.daemon = daemon;
      await writeConfig(configPath, config);
      return;
    }
    case "models": {
      const incoming = parseJsonFile(byPath.get("models.json"));
      const configPath = path.join(home, "config.json");
      const config = await readJson(configPath);
      if (options.keys || !isRecord(incoming.agents)) {
        config.agents = incoming.agents;
      } else {
        // Keep this computer's env values the keyless part left out.
        const current = isRecord(config.agents) ? config.agents : {};
        const next = deepClone(incoming.agents) as Record<string, unknown>;
        keepProviderEnv(current.providers, next.providers);
        config.agents = next;
      }
      await writeConfig(configPath, config);
      return;
    }
    case "library": {
      const paths = resolveLibraryPaths(home);
      const libraryFile = byPath.get("library.json");
      if (libraryFile) {
        const incoming = parseJsonFile(libraryFile);
        const here = await readJson(paths.dataFile);
        const merged = mergeLibrary(incoming as unknown as StoredLibrary, here, options.keys);
        await writeLibrary(paths.dataFile, merged);
      }
      for (const [relPath, file] of byPath) {
        if (relPath === "library.json") {
          continue;
        }
        const target = resolveLibraryTarget(paths.dir, relPath);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, toBuffer(file.content));
        await chmod(target, file.mode ?? 0o644);
      }
      // Mirror: a library file the part doesn't have goes from here too.
      const keep = new Set(byPath.keys());
      for (const dir of LIBRARY_DIRS) {
        await removeUnlisted(path.join(paths.dir, dir), `${dir}/`, keep);
      }
      return;
    }
    case "usage":
      // Shared usage is not setup: sync brings it in file by file, and a
      // restore never writes it.
      return;
  }
}

/**
 * A library part key is untrusted (it arrives in a sync or backup pack). Keep
 * every write inside the library directory: absolute paths and `..` escape
 * would otherwise land outside `$NEOLIX_HOME`.
 */
function resolveLibraryTarget(base: string, relPath: string): string {
  if (path.isAbsolute(relPath) || path.win32.isAbsolute(relPath)) {
    throw new Error(`The synced library file path must be relative: ${relPath}`);
  }
  const target = path.resolve(base, relPath);
  const relative = path.relative(base, target);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    throw new Error(`The synced library file path escapes the library directory: ${relPath}`);
  }
  return target;
}

async function removeUnlisted(dir: string, prefix: string, keep: Set<string>): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (LIBRARY_SKIP_DIRS.has(entry.name)) {
        continue;
      }
      const rel = `${prefix}${entry.name}/`;
      await removeUnlisted(path.join(dir, entry.name), rel, keep);
      if ((await readdir(path.join(dir, entry.name)).catch(() => [])).length === 0) {
        await rm(path.join(dir, entry.name), { recursive: true, force: true });
      }
      continue;
    }
    if (!keep.has(`${prefix}${entry.name}`)) {
      await rm(path.join(dir, entry.name), { force: true });
    }
  }
}

/** Keeps this computer's env values in providers a keyless part strips. */
function keepProviderEnv(current: unknown, next: unknown): void {
  if (!isRecord(current) || !isRecord(next)) {
    return;
  }
  for (const [id, provider] of Object.entries(next)) {
    const here = current[id];
    if (isRecord(provider) && isRecord(here) && isRecord(here.env)) {
      provider.env = here.env;
    }
  }
}

/**
 * A server kept to this computer stays; another computer's by its name is
 * kept aside (myna's Away) and carried on, given to no agent here.
 */
function mergeLocalServers(merged: StoredLibrary, here: Record<string, unknown>): void {
  const localHere = ((here.mcp as StoredLibrary["mcp"] | undefined) ?? []).filter(
    (server) => server.local === true,
  );
  const localNames = new Set(localHere.map((server) => server.name));
  const away: StoredLibrary["mcp"] = [];
  const shared: StoredLibrary["mcp"] = [];
  for (const server of merged.mcp ?? []) {
    if (localNames.has(server.name)) {
      away.push({ ...server, local: undefined });
    } else {
      shared.push(server);
    }
  }
  merged.mcp = [...localHere, ...shared];
  if (away.length > 0) {
    merged.away = away;
  } else {
    delete merged.away;
  }
}

/** The local half a library object keeps when a sync brings one in. */
function mergeLibrary(
  incoming: StoredLibrary,
  here: Record<string, unknown>,
  keys: boolean,
): StoredLibrary {
  const merged = deepClone(incoming) as StoredLibrary & Record<string, unknown>;
  merged.applied = here.applied as StoredLibrary["applied"];
  merged.seenSkills = here.seenSkills as StoredLibrary["seenSkills"];
  mergeLocalServers(merged, here);
  const offHere = new Map(
    (here.skills as StoredLibrary["skills"] | undefined)?.map((skill) => [
      skill.name,
      skill.offHere,
    ]) ?? [],
  );
  for (const skill of merged.skills ?? []) {
    if (offHere.get(skill.name)) {
      skill.offHere = true;
    }
  }
  if (!keys) {
    // A keyless part carries no credentials: the ones here stay, as myna's
    // `take` keeps the server's secrets on a keyless upload (`davsync.go:894`).
    const hereServers = new Map(
      ((here.mcp as StoredLibrary["mcp"] | undefined) ?? []).map((server) => [server.name, server]),
    );
    for (const server of merged.mcp ?? []) {
      const local = hereServers.get(server.name);
      if (!local) {
        continue;
      }
      if (server.env === undefined) {
        server.env = local.env;
      }
      if (server.headers === undefined) {
        server.headers = local.headers;
      }
      if (server.oauth && local.oauth && server.oauth.clientSecret === undefined) {
        server.oauth.clientSecret = local.oauth.clientSecret;
      }
    }
  }
  return merged;
}

function parseJsonFile(file: PartFileInput | undefined): Record<string, unknown> {
  if (!file) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(toBuffer(file.content).toString("utf8"));
    return isRecord(parsed) ? parsed : {};
  } catch {
    throw new Error(`${file.path} in the sync file is not valid JSON`);
  }
}

async function writeGateway(file: string, value: Record<string, unknown>): Promise<void> {
  const parsed = GatewayConfigSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`The synced gateway settings are invalid: ${parsed.error.message}`);
  }
  // Write what was merged, not the parsed copy: defaults added here would
  // make every absorb of a sparse file look like a change on this computer.
  await writeJsonPrivate(file, JSON.stringify(value, null, 2));
}

/** Writes `config.json` validated, as the parts' own writer does. */
export async function writeConfig(file: string, value: Record<string, unknown>): Promise<void> {
  const parsed = PersistedConfigSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`The synced config is invalid: ${parsed.error.message}`);
  }
  await writeJsonPrivate(file, JSON.stringify(value as PersistedConfig, null, 2));
}

async function writeJsonPrivate(file: string, data: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await keepLastGood(file, (contents) => {
    try {
      JSON.parse(contents.toString("utf8"));
      return true;
    } catch {
      return false;
    }
  });
  await writePrivateFileAtomic(file, `${data}\n`);
  await chmod(file, 0o600);
}

export async function readAppSettingsCopy(neolixHome: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path.join(neolixHome, APP_SETTINGS_FILENAME), "utf8"));
  } catch {
    return null;
  }
}
