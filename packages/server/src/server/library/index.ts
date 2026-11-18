import { lstat, mkdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import { resolveLibraryAgentTargets, type LibraryAgentTarget } from "./paths.js";
import {
  resolveLibraryPaths,
  createBackupSession,
  createEmptyLibrary,
  pruneBackups,
  readLibrary,
  writeLibrary,
  type StoredHook,
  type StoredLibrary,
  type StoredMcpServer,
  type StoredSubagent,
} from "./store.js";
import {
  applyInstructionsChange,
  readInstructionsView,
  syncInstructions,
  type InstructionsChange,
  type InstructionsView,
} from "./instructions.js";
import { checkMcpServer, removeAgentMcpServer, syncMcp } from "./mcp.js";
import { checkMcpServerHealth, type McpHealth } from "./health.js";
import { parseWslProvider } from "../agent-connect/external/wsl.js";
import { searchSkillMarket, type SkillMarketHit } from "./market.js";
import { createLibraryHub, type LibraryHub } from "./hub.js";
import { setLibraryHub } from "./hub-registry.js";
import type { McpauthService, McpauthState, McpauthStatus } from "../mcpauth/mcpauth.js";
import {
  availableServerName,
  marketServerById,
  NEOLIX_SELF_PATHS,
  NEOLIX_WEB_SEARCH_ID,
  searchMarketServers,
  serverFromMarket,
  type MarketSearchOutcome,
} from "./market-servers.js";
import {
  handBackSkill,
  handOverSkills,
  importSkill,
  listLibrarySkills,
  removeSkill,
  setSkillHere,
  settleAgentSkill,
  syncSharedSkills,
  syncSkills,
  type SkillView,
} from "./skills.js";
import { checkHook, hooksView, syncHooks } from "./hooks.js";
import { checkSubagent, subagentsView, syncSubagents } from "./subagents.js";
import { fail, type LibrarySyncResult } from "./result.js";
import {
  readRtkGain,
  readRtkStatus,
  runRtkInstall,
  setRtkForAgent,
  type RtkGain,
  type RtkRunResult,
  type RtkStatus,
} from "./rtk.js";
import {
  discoverFromAgents,
  importDiscovered as importDiscoveredEntries,
  type DiscoverView,
  type ImportSelection,
} from "./discover.js";
import { importFromMynaLibrary, readMynaLibrary, type MynaLibraryView } from "./myna.js";
import {
  checkSkillSources,
  installSkillCandidates,
  resolveSkillSource,
  sourceForCandidate,
  updateSkillsFromSources,
  type SkillCandidate,
  type SkillCheckView,
  type SkillSourceInput,
} from "./skills-source.js";
import {
  listBackups as listBackupSessions,
  restoreBackup as restoreBackupFile,
  restoreTargetFor,
  type BackupSessionView,
} from "./backups.js";

export interface LibraryAgentView {
  id: string;
  name: string;
  icon: string;
  instructionsPath: string;
  mcpPath: string | null;
  skillsDir: string | null;
  hooksPath: string | null;
  subagentsDir: string | null;
  /** The WSL distro it lives in, when it is one of a distro's agents. */
  distro?: string;
}

const NEOLIX_SELF_NOTES: Record<string, string> = {
  "neox-vision": "Neox's image recognition, through the gateway",
  "neox-image": "Neox's image generation, through the gateway",
  [NEOLIX_WEB_SEARCH_ID]: "Neox's web search, through the gateway",
};

export interface LibrarySnapshot {
  dir: string;
  backupsDir: string;
  homeDir: string;
  agents: LibraryAgentView[];
  instructions: InstructionsView;
  mcp: LibraryMcpView[];
  skills: SkillView[];
  hooks: StoredHook[];
  subagents: StoredSubagent[];
  skillOptions: {
    copySkills: boolean;
    skillHow: Record<string, "link" | "copy">;
    sharedSkills: boolean;
  };
  /** Whether agents get Neolix's hub instead of their own server entries. */
  mcpHub: boolean;
  counts: { mcp: number; skills: number; hooks: number; subagents: number; rtk: number };
}

export interface LibraryMutation {
  library: LibrarySnapshot;
  result: LibrarySyncResult;
}

/** One library server as Neolix's agent launch config takes it. */
export type LibraryMcpLaunchServer =
  | { type: "stdio"; command: string; args: string[]; env?: Record<string, string> }
  | { type: "http" | "sse"; url: string; headers?: Record<string, string> };

/** A server plus what its sign-in says; only the sign-in is not persisted. */
export interface LibraryMcpView extends StoredMcpServer {
  signIn?: McpauthStatus;
}

export interface LibraryService {
  /** Reads the library once, so launch-time MCP injection has it. */
  warm(): Promise<void>;
  /** Looks for the agents again, after noWslAgents changed. */
  refreshTargets(): Promise<void>;
  /**
   * Waits for the library work already queued, then refuses new work. A stopped
   * daemon must not keep creating `$NEOLIX_HOME/library` after `stop()` returns.
   */
  dispose(): Promise<void>;
  /** The daemon's cached CLI versions, for the agents that read as of one. */
  setAgentVersionSource(source: ((agent: string) => Promise<string | null>) | null): void;
  /** The MCP servers ticked for an agent, merged into its launch config. */
  mcpServersForAgent(agentId: string): Record<string, LibraryMcpLaunchServer>;
  getSnapshot(): Promise<LibrarySnapshot>;
  /** Writes the library into every agent again, as a change does. */
  syncNow(): Promise<LibraryMutation>;
  saveInstructions(change: InstructionsChange): Promise<LibraryMutation>;
  saveMcpServer(oldName: string | null, server: StoredMcpServer): Promise<LibraryMutation>;
  removeMcpServer(name: string): Promise<LibraryMutation>;
  setMcpAgents(name: string, agents: string[]): Promise<LibraryMutation>;
  checkMcp(name: string): Promise<McpHealth>;
  setMcpHub(on: boolean): Promise<LibraryMutation>;
  /** Keeps a server to this computer, out of any sync or backup. */
  setMcpLocal(name: string, local: boolean): Promise<LibraryMutation>;
  /** With the hub on, shares a server through it or keeps it each agent's own. */
  setMcpRouter(name: string, direct: boolean): Promise<LibraryMutation>;
  /** Where the hub is and the key an agent reaches it with; wired by the daemon. */
  setHub(provider: LibraryHubProvider | null): void;
  /** Neolix's OAuth sign-ins to remote MCP servers; wired by the daemon. */
  setMcpauth(service: McpauthService | null): void;
  /** Begins signing Neolix in to the server called name. */
  signInMcp(name: string): Promise<McpauthState>;
  signInProgress(id: string): McpauthState | undefined;
  cancelSignIn(id: string): void;
  /** Forgets a sign-in and gives the agents the server's own address again. */
  signOutMcp(name: string): Promise<LibraryMutation>;
  /** Re-reads the library and gives every agent the current addresses,
   * after a sign-in or sign-out changed which servers are relayed. */
  resync(): Promise<void>;
  importSkill(source: string): Promise<LibraryMutation>;
  removeSkill(name: string): Promise<LibraryMutation>;
  setSkillAgents(name: string, agents: string[]): Promise<LibraryMutation>;
  findSkills(source: SkillSourceInput): Promise<SkillCandidate[]>;
  installSkills(source: SkillSourceInput, names: string[]): Promise<LibraryMutation>;
  setSkillOptions(options: {
    copySkills?: boolean;
    skillHow?: Record<string, "link" | "copy">;
    sharedSkills?: boolean;
  }): Promise<LibraryMutation>;
  setSkillNote(name: string, note: string): Promise<LibraryMutation>;
  /** Turns a skill off or on here alone. */
  setSkillHere(name: string, on: boolean): Promise<LibraryMutation>;
  /** Moves skills kept in ~/.agents/skills into the library; null means all. */
  handOverSkills(names: string[] | null): Promise<LibraryMutation>;
  /** Puts a skill back into ~/.agents/skills, the library linking to it. */
  handBackSkill(name: string): Promise<LibraryMutation>;
  /** Settles an agent's own skill against the library's by that name. */
  settleSkill(name: string, agent: string, keepOwn: boolean): Promise<LibraryMutation>;
  checkSkillUpdates(): Promise<SkillCheckView[]>;
  searchSkillMarket(query: string): Promise<SkillMarketHit[]>;
  searchMarketServers(query: string): Promise<MarketSearchOutcome>;
  installMarketServer(
    id: string,
    values: Record<string, string>,
    agents: string[],
  ): Promise<LibraryMutation>;
  updateSkills(names: string[] | null): Promise<LibraryMutation>;
  saveHook(oldName: string | null, hook: StoredHook): Promise<LibraryMutation>;
  removeHook(name: string): Promise<LibraryMutation>;
  setHookAgents(name: string, agents: string[]): Promise<LibraryMutation>;
  saveSubagent(oldName: string | null, subagent: StoredSubagent): Promise<LibraryMutation>;
  removeSubagent(name: string): Promise<LibraryMutation>;
  setSubagentAgents(name: string, agents: string[]): Promise<LibraryMutation>;
  getRtk(refresh?: boolean): Promise<RtkStatus>;
  setRtk(agent: string, on: boolean): Promise<RtkStatus>;
  runRtk(
    action: "install" | "upgrade",
    confirm: boolean,
    distro?: string,
  ): Promise<{ rtk: RtkStatus; run: RtkRunResult }>;
  getRtkGain(): Promise<RtkGain>;
  discover(): Promise<DiscoverView>;
  importDiscovered(selection: ImportSelection): Promise<LibraryMutation>;
  /** Takes found servers and skills out of every agent that has them, backing them up. */
  removeDiscovered(selection: ImportSelection): Promise<LibraryMutation>;
  getMynaLibrary(): Promise<MynaLibraryView>;
  importMynaLibrary(selection: ImportSelection): Promise<LibraryMutation>;
  listBackups(): Promise<BackupSessionView[]>;
  restoreBackup(agent: string, stamp: string, file: string): Promise<LibrarySnapshot>;
}

export interface LibraryHubProvider {
  baseUrl: () => string | null;
  /** Null when this computer needs no key (the gateway has none). */
  keyForAgent: (agent: string) => Promise<string | null>;
  env?: NodeJS.ProcessEnv;
}

export interface LibraryServiceOptions {
  neolixHome: string;
  /** Overridable for tests: the user's home whose agent files are written. */
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  /** Overridable for tests: the shipped market snapshot and its registry. */
  marketSnapshot?: string;
  marketFetch?: typeof fetch;
  /** Settings' Detect agents in WSL, inverse: false keeps the library on this machine. */
  wslEnabled?: () => boolean;
  /** Tests: an agent CLI's version, cached by the caller (myna's SharedToo). */
  agentVersion?: (agent: string) => Promise<string | null>;
}

/** The version from which an agent reads ~/.agents/skills besides its own
 * (myna targets.go: piSharedSince, ompSharedSince). */
const SHARED_SINCE: Record<string, readonly [number, number, number]> = {
  pi: [0, 54, 0],
  omp: [11, 0, 0],
};

function versionAtLeast(version: string, since: readonly [number, number, number]): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(version.trim());
  if (!match) {
    return false;
  }
  const parts = [Number(match[1]), Number(match[2]), Number(match[3])];
  for (let index = 0; index < 3; index += 1) {
    if (parts[index] !== since[index]) {
      return (parts[index] ?? 0) > (since[index] ?? 0);
    }
  }
  return true;
}

function countRtkAgents(status: RtkStatus | null): number {
  return status ? status.agents.filter((agent) => agent.on).length : 0;
}

/** Which servers are relayed through the gateway and how an agent reaches
 * it (myna internal/library/mcp_signin.go:38). */
interface McpRelayContext {
  base: string;
  key: string | null;
  signins: Map<string, { url: string }>;
}

/** Only a streamable HTTP server is relayed: an SSE one's stream names the
 * address to post to, which would have to be rewritten. */
function isRelayed(server: StoredMcpServer, relay: McpRelayContext): boolean {
  if (server.transport !== "http" || !server.url) {
    return false;
  }
  const record = relay.signins.get(server.name);
  return record !== undefined && record.url === server.url;
}

/**
 * The server as an agent that reaches the gateway at base is given it: the
 * gateway's `/mcp/<name>` in place of the server's own address, and the
 * agent's gateway key where the server's Authorization header was (Neolix's
 * token goes in its place at the relay).
 */
function relayedServer(server: StoredMcpServer, relay: McpRelayContext): StoredMcpServer {
  if (!isRelayed(server, relay)) {
    return server;
  }
  const rest: StoredMcpServer = { ...server };
  delete rest.headers;
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(server.headers ?? {})) {
    if (key.toLowerCase() !== "authorization") {
      headers[key] = value;
    }
  }
  if (relay.key) {
    headers.authorization = `Bearer ${relay.key}`;
  }
  return {
    ...rest,
    url: `${relay.base.replace(/\/+$/, "")}/mcp/${encodeURIComponent(server.name)}`,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  };
}

/** Whether a folder is the library's own copy (or a link to it), not an agent's. */
async function pointsIntoLibrary(librarySkillsDir: string, folder: string): Promise<boolean> {
  try {
    const resolved = await realpath(folder);
    const base = await realpath(librarySkillsDir);
    const relative = path.relative(base, resolved);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  } catch {
    return false;
  }
}

export function createLibraryService(options: LibraryServiceOptions): LibraryService {
  const homeDir = options.homeDir ?? homedir();
  const env = options.env ?? process.env;
  const paths = resolveLibraryPaths(options.neolixHome);
  let targets: LibraryAgentTarget[] | null = null;
  let agentVersion = options.agentVersion ?? null;
  const getTargets = async (): Promise<LibraryAgentTarget[]> => {
    if (targets !== null) {
      return targets;
    }
    const rows = await resolveLibraryAgentTargets({
      homeDir,
      env,
      ...(options.wslEnabled?.() === false ? { wslRows: [] } : {}),
    });
    // A Pi or omp new enough reads ~/.agents/skills besides its own folder.
    // The version comes from the daemon's cache, read here once with the
    // targets (myna targets.go:217, 235).
    if (agentVersion !== null) {
      const readVersion = agentVersion;
      await Promise.all(
        rows.map(async (target) => {
          const since = SHARED_SINCE[target.id];
          if (since === undefined) {
            return;
          }
          const version = await readVersion(target.id).catch(() => null);
          if (version !== null && versionAtLeast(version, since)) {
            target.sharedToo = true;
          }
        }),
      );
    }
    targets = rows;
    return rows;
  };
  let queue: Promise<unknown> = Promise.resolve();
  let disposed = false;
  let rtk: RtkStatus | null = null;
  let current: StoredLibrary | null = null;
  let hubProvider: LibraryHubProvider | null = null;
  let mcpauthService: McpauthService | null = null;
  const hub: LibraryHub = createLibraryHub({
    serversForAgent: (agent) =>
      current?.mcp.filter(
        (server) =>
          server.agents.includes(agent) && server.name !== "neox" && server.router !== "direct",
      ) ?? [],
    ...(options.env ? { env: options.env } : {}),
    // The hub connects to a signed-in server itself, with Neolix's token
    // (myna internal/gateway/mcp_check.go:745, mcp_hub.go:368). A sign-in
    // change resets the hub, so a new token and a new address are used.
    credentials: {
      token: async (server) => {
        const service = mcpauthService;
        if (service === null || server.transport !== "http" || !server.url) {
          return null;
        }
        if (!(await service.signedIn(server.name, server.url))) {
          return null;
        }
        return service.token(server.name);
      },
      rejected: async (server, token) => {
        await mcpauthService?.rejected(server.name, token);
      },
      renew: async (server, stale) => {
        if (mcpauthService === null) {
          throw new Error("Neox's MCP sign-in is not running");
        }
        return mcpauthService.renewIfStale(server.name, stale);
      },
    },
  });
  setLibraryHub(hub);

  const withLock = <T>(work: () => Promise<T>): Promise<T> => {
    if (disposed) {
      return Promise.reject(new Error("The library service is disposed"));
    }
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
  };

  /** The relay an agent's signed-in servers take, asking for its key only
   * when it has one. */
  const relayForTarget = async (
    library: StoredLibrary,
    target: LibraryAgentTarget,
    signins: Map<string, { url: string }> | null,
    base: string | null,
  ): Promise<McpRelayContext | null> => {
    if (base === null || signins === null || hubProvider === null) {
      return null;
    }
    const relay: McpRelayContext = { base, key: null, signins };
    const needed = library.mcp.some(
      (server) => server.agents.includes(target.id) && isRelayed(server, relay),
    );
    if (!needed) {
      return null;
    }
    relay.key = await hubProvider.keyForAgent(target.id).catch(() => null);
    return relay;
  };

  // The MCP servers last read, per agent, for the daemon to give a new agent
  // without a disk read on its launch path.
  let mcpCache: Record<string, Record<string, LibraryMcpLaunchServer>> = {};
  const refreshCache = async (
    library: StoredLibrary,
    agentTargets: LibraryAgentTarget[],
  ): Promise<void> => {
    const base = hubProvider?.baseUrl() ?? null;
    const signins = base !== null && mcpauthService !== null ? await mcpauthService.all() : null;
    const next: Record<string, Record<string, LibraryMcpLaunchServer>> = {};
    for (const target of agentTargets) {
      const relay = await relayForTarget(library, target, signins, base);
      // With the hub on, only the servers kept direct are given as entries;
      // the rest reach the agent through the hub.
      const given = library.mcp
        .filter(
          (server) =>
            server.agents.includes(target.id) &&
            server.name !== "neox" &&
            (!library.mcpHub || server.router === "direct"),
        )
        .map((server) => (relay !== null ? relayedServer(server, relay) : server));
      const servers: Record<string, LibraryMcpLaunchServer> = {};
      for (const server of given) {
        servers[server.name] =
          server.transport === "stdio"
            ? {
                type: "stdio",
                command: server.command ?? "",
                args: server.args ?? [],
                ...(server.env ? { env: server.env } : {}),
              }
            : {
                type: server.transport,
                url: server.url ?? "",
                ...(server.headers ? { headers: server.headers } : {}),
              };
      }
      next[target.id] = servers;
    }
    mcpCache = next;
  };

  const load = async (): Promise<StoredLibrary> => {
    await mkdir(paths.dir, { recursive: true, mode: 0o700 }).catch(() => undefined);
    const library = (await readLibrary(paths.dataFile)) ?? createEmptyLibrary();
    current = library;
    await refreshCache(library, await getTargets());
    return library;
  };

  const save = async (library: StoredLibrary): Promise<void> => {
    library.mcp.sort((left, right) => left.name.localeCompare(right.name));
    library.skills.sort((left, right) => left.name.localeCompare(right.name));
    library.hooks.sort((left, right) => left.name.localeCompare(right.name));
    library.subagents.sort((left, right) => left.name.localeCompare(right.name));
    await writeLibrary(paths.dataFile, library);
  };

  /** The library with the signed-in servers this target has given the
   * gateway's address; only asking for the key when one is relayed. */
  const relayedLibraryFor = async (
    library: StoredLibrary,
    target: LibraryAgentTarget,
    signins: Map<string, { url: string }> | null,
    relayBase: string | null,
    hubServer: StoredMcpServer | undefined,
  ): Promise<StoredLibrary> => {
    if (hubServer !== undefined) {
      return library;
    }
    const relay = await relayForTarget(library, target, signins, relayBase);
    return relay === null
      ? library
      : { ...library, mcp: library.mcp.map((server) => relayedServer(server, relay)) };
  };

  const sync = async (library: StoredLibrary): Promise<LibrarySyncResult> => {
    const result: LibrarySyncResult = { changed: [], problems: [] };
    const backup = createBackupSession(paths.backupsDir, options.now?.() ?? new Date());
    const signins = mcpauthService !== null ? await mcpauthService.all() : null;
    const relayBase = hubProvider?.baseUrl() ?? null;
    for (const target of await getTargets()) {
      let hubServer: StoredMcpServer | undefined;
      if (
        library.mcpHub &&
        hubProvider &&
        library.mcp.some((server) => server.agents.includes(target.id))
      ) {
        const base = hubProvider.baseUrl();
        if (base === null) {
          fail(
            result,
            target.id,
            "mcp:hub",
            new Error("The daemon is not listening on a TCP port"),
          );
        } else {
          const key = await hubProvider.keyForAgent(target.id).catch(() => null);
          hubServer = {
            name: "neox-hub",
            transport: "http",
            url: `${base.replace(/\/+$/, "")}/mcp/neox/hub/${encodeURIComponent(target.id)}`,
            ...(key ? { headers: { Authorization: `Bearer ${key}` } } : {}),
            agents: [target.id],
          };
        }
      }
      const context = {
        target,
        backup,
        result,
        ...(hubServer ? { hubServer } : {}),
      };
      // A signed-in server is given the gateway's address; only the entries
      // this agent has make asking for its key worthwhile.
      const relayed = await relayedLibraryFor(library, target, signins, relayBase, hubServer);
      const steps: [string, (value: typeof context) => Promise<void>][] = [
        ["instructions", (value) => syncInstructions(library, paths, value)],
        ["mcp", (value) => syncMcp(relayed, value)],
        ["skills", (value) => syncSkills(library, paths, value)],
        ["hooks", (value) => syncHooks(library, value)],
        ["subagents", (value) => syncSubagents(library, value)],
      ];
      for (const [what, step] of steps) {
        try {
          await step(context);
        } catch (error) {
          fail(result, target.id, what, error);
        }
      }
    }
    try {
      await syncSharedSkills(library, paths, homeDir, result);
    } catch (error) {
      fail(result, "shared", "skill", error);
    }
    const dir = backup.done();
    if (dir) {
      result.backup = dir;
      await pruneBackups(paths.backupsDir);
    }
    return result;
  };

  /** The library's servers with each one's sign-in state (myna
   * internal/library/mcp_signin.go; the page's "Signed in" tag). */
  const mcpViews = async (library: StoredLibrary): Promise<LibraryMcpView[]> => {
    const signins = mcpauthService !== null ? await mcpauthService.all() : null;
    return library.mcp.map((server) => {
      const record = signins?.get(server.name);
      const status: McpauthStatus | undefined =
        record !== undefined && record.url === server.url
          ? {
              signedIn: true,
              ...(record.dead ? { dead: true } : {}),
              ...(record.at ? { at: record.at } : {}),
            }
          : undefined;
      return {
        ...server,
        agents: [...server.agents],
        ...(status ? { signIn: status } : {}),
      };
    });
  };

  const buildSnapshot = async (
    library: StoredLibrary,
    rtkStatus: RtkStatus | null,
  ): Promise<LibrarySnapshot> => {
    const agentTargets = await getTargets();
    return {
      dir: paths.dir,
      backupsDir: paths.backupsDir,
      homeDir,
      agents: agentTargets.map((target) => {
        const view: LibraryAgentView = {
          id: target.id,
          name: target.name,
          icon: target.icon,
          instructionsPath: target.instructionsPath,
          mcpPath: target.mcpPath ?? null,
          skillsDir: target.skillsDir ?? null,
          hooksPath: target.hooksPath ?? null,
          subagentsDir: target.subagentsDir ?? null,
        };
        if (target.distro !== undefined) {
          view.distro = target.distro;
        }
        return view;
      }),
      mcpHub: library.mcpHub === true,
      skillOptions: {
        copySkills: library.copySkills === true,
        skillHow: { ...library.skillHow },
        sharedSkills: library.sharedSkills === true,
      },
      instructions: await readInstructionsView(library, paths, agentTargets),
      mcp: await mcpViews(library),
      skills: await listLibrarySkills(library, paths, {
        targets: agentTargets,
        homeDir,
        sharedSkills: library.sharedSkills === true,
      }),
      hooks: hooksView(library),
      subagents: subagentsView(library),
      counts: {
        mcp: library.mcp.length,
        skills: library.skills.length,
        hooks: library.hooks.length,
        subagents: library.subagents.length,
        rtk: countRtkAgents(rtkStatus),
      },
    };
  };

  const changed = async (library: StoredLibrary): Promise<LibraryMutation> => {
    settleAway(library);
    await refreshCache(library, await getTargets());
    await save(library);
    const result = await sync(library);
    await save(library);
    rtk = null;
    await hub.reset();
    current = library;
    return { library: await buildSnapshot(library, rtk), result };
  };

  const mutate = (work: (library: StoredLibrary) => Promise<void>): Promise<LibraryMutation> =>
    withLock(async () => {
      const library = await load();
      await work(library);
      return changed(library);
    });

  /**
   * Lets go of each kept-aside server whose name no local server has any more
   * (myna's settleAway): a server shared here again takes its place, and with
   * none here the other computers' comes in.
   */
  const settleAway = (library: StoredLibrary): void => {
    const away = library.away ?? [];
    if (away.length === 0) {
      return;
    }
    const left: StoredMcpServer[] = [];
    for (const remote of away) {
      const here = library.mcp.find((server) => server.name === remote.name);
      if (here?.local === true) {
        left.push(remote);
      } else if (here === undefined) {
        library.mcp.push({ ...remote, local: undefined });
      }
    }
    if (left.length > 0) {
      library.away = left;
    } else {
      delete library.away;
    }
  };

  const requireServer = (library: StoredLibrary, name: string): StoredMcpServer => {
    const server = library.mcp.find((entry) => entry.name === name);
    if (!server) {
      throw new Error(`There is no MCP server called ${name}`);
    }
    return server;
  };

  const replaceNamed = <T extends { name: string }>(
    items: T[],
    oldName: string | null,
    value: T,
  ): void => {
    if (oldName !== null && oldName !== value.name) {
      const index = items.findIndex((entry) => entry.name === oldName);
      if (index < 0) {
        throw new Error(`There is nothing called ${oldName}`);
      }
      if (items.some((entry) => entry.name === value.name)) {
        throw new Error(`There is one called ${value.name} already`);
      }
      items.splice(index, 1, value);
      return;
    }
    const index = items.findIndex((entry) => entry.name === value.name);
    if (index >= 0) {
      items[index] = value;
    } else {
      items.push(value);
    }
  };

  return {
    warm: () =>
      withLock(async () => {
        await load();
      }),

    refreshTargets: () =>
      withLock(async () => {
        targets = null;
        await load();
      }),

    dispose: () => {
      disposed = true;
      // Queued work may already be writing; let it finish so `stop()` returns
      // with no library write left behind.
      return queue.then(
        () => undefined,
        () => undefined,
      );
    },

    setAgentVersionSource: (source) => {
      agentVersion = source;
      targets = null;
    },

    mcpServersForAgent: (agentId) => mcpCache[agentId] ?? {},

    setMcpauth: (service) => {
      mcpauthService = service;
    },

    signInMcp: (name) =>
      withLock(async () => {
        if (mcpauthService === null) {
          throw new Error("Neox's MCP sign-in is not running");
        }
        const library = await load();
        const server = requireServer(library, name);
        if (server.transport !== "http" || !server.url) {
          throw new Error("Neox signs in only to a server reached over streamable HTTP");
        }
        const app = server.oauth
          ? {
              clientID: server.oauth.clientId,
              ...(server.oauth.clientSecret ? { clientSecret: server.oauth.clientSecret } : {}),
              ...(server.oauth.callbackPort ? { callbackPort: server.oauth.callbackPort } : {}),
            }
          : undefined;
        return mcpauthService.start(server.name, server.url, app);
      }),

    signInProgress: (id) => mcpauthService?.progress(id),

    cancelSignIn: (id) => {
      mcpauthService?.cancel(id);
    },

    signOutMcp: (name) =>
      withLock(async () => {
        if (mcpauthService === null) {
          throw new Error("Neox's MCP sign-in is not running");
        }
        await mcpauthService.signOut(name);
        const library = await load();
        return changed(library);
      }),

    resync: () =>
      withLock(async () => {
        const library = await load();
        await sync(library);
        // A sign-in changed the address the hub connects to: its old
        // connection still points at the server without Neolix's token.
        await hub.reset();
        current = library;
      }),

    getSnapshot: () =>
      withLock(async () => {
        const library = await load();
        return buildSnapshot(library, rtk);
      }),

    syncNow: () =>
      withLock(async () => {
        const library = await load();
        return changed(library);
      }),

    saveInstructions: (change) =>
      mutate(async (library) => {
        const backup = createBackupSession(paths.backupsDir, options.now?.() ?? new Date());
        await applyInstructionsChange(library, paths, change, {
          targets: await getTargets(),
          backup,
        });
        if (backup.done()) {
          await pruneBackups(paths.backupsDir);
        }
      }),

    saveMcpServer: (oldName, server) =>
      mutate(async (library) => {
        const checked = checkMcpServer(server);
        replaceNamed(library.mcp, oldName, checked);
        // The sign-in moves with the server, as myna's does (Rename).
        if (oldName !== null && oldName !== checked.name) {
          await mcpauthService?.rename(oldName, checked.name);
        }
      }),

    removeMcpServer: (name) =>
      mutate(async (library) => {
        requireServer(library, name);
        library.mcp = library.mcp.filter((server) => server.name !== name);
        // A server the library no longer has gives its sign-in to no agent.
        await mcpauthService?.forget(name);
      }),

    checkMcp: (name) =>
      withLock(async () => {
        const library = await load();
        const server = requireServer(library, name);
        // a server an agent in WSL runs is checked in its distro, where
        // its own command lives (myna's mcp_check.go)
        const distro = server.agents
          .map((agent) => parseWslProvider(agent)?.distro)
          .find((one) => one !== undefined);
        return checkMcpServerHealth(server, {
          env,
          timeoutMs: 15_000,
          ...(distro === undefined ? {} : { distro }),
        });
      }),

    setMcpHub: (on) =>
      mutate(async (library) => {
        library.mcpHub = on;
        if (!on) {
          await hub.reset();
        }
      }),

    setMcpLocal: (name, local) =>
      mutate(async (library) => {
        const server = requireServer(library, name);
        if (local) {
          server.local = true;
        } else {
          delete server.local;
        }
      }),

    setMcpRouter: (name, direct) =>
      mutate(async (library) => {
        const server = requireServer(library, name);
        if (direct) {
          server.router = "direct";
        } else {
          delete server.router;
        }
      }),

    setHub: (provider) => {
      hubProvider = provider;
    },

    setMcpAgents: (name, agents) =>
      mutate(async (library) => {
        requireServer(library, name).agents = [...new Set(agents)].sort();
      }),

    importSkill: (source) =>
      mutate(async (library) => {
        await importSkill(library, paths, source);
      }),

    removeSkill: (name) =>
      mutate(async (library) => {
        const backup = createBackupSession(paths.backupsDir, options.now?.() ?? new Date());
        await removeSkill(library, paths, name, backup);
        if (backup.done()) {
          await pruneBackups(paths.backupsDir);
        }
      }),

    setSkillAgents: (name, agents) =>
      mutate(async (library) => {
        const skill = library.skills.find((entry) => entry.name === name);
        if (!skill) {
          throw new Error(`There is no skill called ${name}`);
        }
        skill.agents = [...new Set(agents)].sort();
      }),

    findSkills: (source) =>
      withLock(async () => {
        const resolved = await resolveSkillSource(source, { paths, env });
        try {
          return resolved.candidates;
        } finally {
          await resolved.cleanup();
        }
      }),

    installSkills: (source, names) =>
      mutate(async (library) => {
        const resolved = await resolveSkillSource(source, { paths, env });
        try {
          const picked = resolved.candidates.filter((candidate) => names.includes(candidate.name));
          if (picked.length === 0) {
            throw new Error("No skill was picked");
          }
          for (const candidate of picked) {
            if (library.skills.some((skill) => skill.name === candidate.name)) {
              throw new Error(`The library already has a skill called ${candidate.name}`);
            }
            const storedSource = sourceForCandidate(source, candidate);
            await installSkillCandidates(library, paths, storedSource, resolved.commit, [
              candidate,
            ]);
          }
        } finally {
          await resolved.cleanup();
        }
      }),

    setSkillOptions: (next) =>
      mutate(async (library) => {
        if (next.copySkills !== undefined) {
          library.copySkills = next.copySkills;
        }
        if (next.skillHow !== undefined) {
          library.skillHow = { ...library.skillHow, ...next.skillHow };
        }
        if (next.sharedSkills !== undefined) {
          library.sharedSkills = next.sharedSkills;
        }
      }),

    setSkillNote: (name, note) =>
      mutate(async (library) => {
        const skill = library.skills.find((entry) => entry.name === name);
        if (!skill) {
          throw new Error(`There is no skill called ${name}`);
        }
        if (note.trim().length > 0) {
          skill.note = note.trim();
        } else {
          delete skill.note;
        }
      }),

    setSkillHere: (name, on) =>
      mutate(async (library) => {
        setSkillHere(library, name, on);
      }),

    handOverSkills: (names) =>
      mutate(async (library) => {
        await handOverSkills(library, paths, homeDir, names, await getTargets());
      }),

    handBackSkill: (name) =>
      mutate(async (library) => {
        await handBackSkill(library, paths, homeDir, name);
      }),

    settleSkill: (name, agent, keepOwn) =>
      mutate(async (library) => {
        const target = (await getTargets()).find((entry) => entry.id === agent);
        if (!target) {
          throw new Error(`There is no agent called ${agent}`);
        }
        await settleAgentSkill(library, paths, target, name, keepOwn);
      }),

    searchSkillMarket: (query) => withLock(async () => searchSkillMarket(query)),

    searchMarketServers: (query) =>
      withLock(async () =>
        searchMarketServers(query, await load(), {
          ...(options.marketSnapshot ? { snapshot: options.marketSnapshot } : {}),
          ...(options.marketFetch ? { fetchImpl: options.marketFetch } : {}),
        }),
      ),

    installMarketServer: (id, values, agents) =>
      mutate(async (library) => {
        const selfPath = NEOLIX_SELF_PATHS[id];
        if (selfPath !== undefined) {
          if (!hubProvider) {
            throw new Error("Neox's gateway is not running, so its own servers have no address");
          }
          const base = hubProvider.baseUrl();
          if (base === null) {
            throw new Error("The daemon is not listening on a TCP port");
          }
          const key = await hubProvider.keyForAgent(id).catch(() => null);
          const server: StoredMcpServer = {
            name: availableServerName(id, library),
            transport: "http",
            url: `${base.replace(/\/+$/, "")}${selfPath}`,
            ...(key ? { headers: { Authorization: `Bearer ${key}` } } : {}),
            agents: [...new Set(agents)].sort(),
            note: NEOLIX_SELF_NOTES[id] ?? "Neox's own server, through the gateway",
          };
          library.mcp.push(checkMcpServer(server));
          return;
        }
        const entry = await marketServerById(
          id,
          options.marketSnapshot ? { snapshot: options.marketSnapshot } : {},
        );
        if (!entry) {
          throw new Error(`The market has no server ${id}; search for it again`);
        }
        const server = serverFromMarket(entry, values, agents);
        server.name = availableServerName(server.name, library);
        library.mcp.push(checkMcpServer(server));
      }),

    checkSkillUpdates: () => withLock(async () => checkSkillSources(await load(), { paths, env })),

    updateSkills: (names) =>
      mutate(async (library) => {
        const all = names ?? library.skills.filter((skill) => skill.source).map((s) => s.name);
        await updateSkillsFromSources(library, paths, all, { paths, env });
      }),

    saveHook: (oldName, hook) =>
      mutate(async (library) => {
        replaceNamed(library.hooks, oldName, checkHook(hook));
      }),

    removeHook: (name) =>
      mutate(async (library) => {
        if (!library.hooks.some((hook) => hook.name === name)) {
          throw new Error(`There is no hook called ${name}`);
        }
        library.hooks = library.hooks.filter((hook) => hook.name !== name);
      }),

    setHookAgents: (name, agents) =>
      mutate(async (library) => {
        const hook = library.hooks.find((entry) => entry.name === name);
        if (!hook) {
          throw new Error(`There is no hook called ${name}`);
        }
        hook.agents = [...new Set(agents)].sort();
      }),

    saveSubagent: (oldName, subagent) =>
      mutate(async (library) => {
        replaceNamed(library.subagents, oldName, checkSubagent(subagent));
      }),

    removeSubagent: (name) =>
      mutate(async (library) => {
        if (!library.subagents.some((subagent) => subagent.name === name)) {
          throw new Error(`There is no subagent called ${name}`);
        }
        library.subagents = library.subagents.filter((subagent) => subagent.name !== name);
      }),

    setSubagentAgents: (name, agents) =>
      mutate(async (library) => {
        const subagent = library.subagents.find((entry) => entry.name === name);
        if (!subagent) {
          throw new Error(`There is no subagent called ${name}`);
        }
        subagent.agents = [...new Set(agents)].sort();
      }),

    getRtk: (refresh = false) =>
      withLock(async () => {
        if (refresh || rtk === null) {
          rtk = await readRtkStatus(await getTargets(), { homeDir, env, refresh });
        }
        return rtk;
      }),

    discover: () =>
      withLock(async () => {
        const library = await load();
        return discoverFromAgents(library, paths, await getTargets());
      }),

    importDiscovered: (selection) =>
      mutate(async (library) => {
        const view = await discoverFromAgents(library, paths, await getTargets());
        await importDiscoveredEntries(library, paths, await getTargets(), view, selection);
      }),

    removeDiscovered: (selection) =>
      mutate(async (library) => {
        const agentTargets = await getTargets();
        const view = await discoverFromAgents(library, paths, agentTargets);
        const backup = createBackupSession(paths.backupsDir, options.now?.() ?? new Date());
        for (const name of selection.servers) {
          const found = view.servers.find((entry) => entry.name === name);
          if (found === undefined) {
            throw new Error(`There is no server called ${name} in any agent`);
          }
          if (found.own === true) {
            throw new Error(
              `${name} is put there by the agent's app itself, each time it starts: it stays as it is`,
            );
          }
          for (const target of agentTargets) {
            const has = found.agents.includes(target.id) || found.otherAgents.includes(target.id);
            if (!has || !target.mcpPath) {
              continue;
            }
            await backup.keep(target.id, target.mcpPath);
            await removeAgentMcpServer(target, name);
          }
        }
        for (const name of selection.skills) {
          const found = view.skills.find((entry) => entry.name === name);
          if (found === undefined) {
            throw new Error(`There is no skill called ${name} in any agent`);
          }
          for (const target of agentTargets) {
            const has = found.agents.includes(target.id) || found.otherAgents.includes(target.id);
            if (!has || !target.skillsDir) {
              continue;
            }
            const folder = path.join(target.skillsDir, name);
            if (
              !(await lstat(folder)
                .then(() => true)
                .catch(() => false))
            ) {
              continue;
            }
            if (await pointsIntoLibrary(paths.skillsDir, folder)) {
              continue;
            }
            await backup.keepTree(target.id, folder, name);
            await rm(folder, { recursive: true, force: true });
          }
        }
        if (backup.done()) {
          await pruneBackups(paths.backupsDir);
        }
      }),

    getMynaLibrary: () =>
      withLock(async () => {
        const agentTargets = await getTargets();
        return readMynaLibrary({
          homeDir,
          env,
          agents: agentTargets.map((target) => target.id),
        });
      }),

    importMynaLibrary: (selection) =>
      mutate(async (library) => {
        const view = await readMynaLibrary({
          homeDir,
          env,
          agents: (await getTargets()).map((target) => target.id),
        });
        await importFromMynaLibrary(library, paths, view, selection);
      }),

    listBackups: () =>
      withLock(async () => {
        const sessions = await listBackupSessions(paths.backupsDir);
        const agentTargets = await getTargets();
        for (const session of sessions) {
          for (const [agent, files] of Object.entries(session.files)) {
            const target = agentTargets.find((entry) => entry.id === agent);
            for (const file of files) {
              file.target = restoreTargetFor(target, file.file);
            }
          }
        }
        return sessions;
      }),

    restoreBackup: (agent, stamp, file) =>
      withLock(async () => {
        const target = (await getTargets()).find((entry) => entry.id === agent);
        if (!target) {
          throw new Error(`Unknown agent ${agent}`);
        }
        await restoreBackupFile({
          backupsDir: paths.backupsDir,
          target,
          stamp,
          agent,
          file,
          now: options.now?.() ?? new Date(),
        });
        return buildSnapshot(await load(), rtk);
      }),

    runRtk: (action, confirm, distro) =>
      withLock(async () => {
        if (!confirm) {
          throw new Error("Installing RTK has to be confirmed in the page");
        }
        if (distro !== undefined) {
          const known = (await getTargets()).some((target) => target.distro === distro);
          if (!known) {
            throw new Error(`No agent RTK has a hook for is in a WSL distro named ${distro}`);
          }
        }
        const result = await runRtkInstall(action, {
          env,
          ...(distro === undefined ? {} : { distro }),
        });
        const agentTargets = await getTargets();
        rtk = await readRtkStatus(agentTargets, { homeDir, env, refresh: true });
        return { rtk, run: result };
      }),

    getRtkGain: () => withLock(async () => readRtkGain(env)),

    setRtk: (agent, on) =>
      withLock(async () => {
        const agentTargets = await getTargets();
        const target = agentTargets.find((entry) => entry.id === agent);
        if (!target) {
          throw new Error(`Unknown agent ${agent}`);
        }
        const backup = createBackupSession(paths.backupsDir, options.now?.() ?? new Date());
        await setRtkForAgent({ target, on, homeDir, env, backup });
        await pruneBackups(paths.backupsDir);
        rtk = await readRtkStatus(agentTargets, { homeDir, env, refresh: true });
        return rtk;
      }),
  };
}
