// Neox Library → Synara settings RPCs.
//
// Two surfaces live here:
// - `neolix.library.*`: a thin pass-through to the daemon's `library.*` requests for the
//   Instructions / Hooks / Subagents / RTK panels the Synara UI has no equivalent for.
// - Existing Synara RPCs used by the Connectors panel (`server.listMcpConnectors`, connect,
//   disconnect, setup) and the built-in-tools panel, mapped onto the same library MCP entries.
//
// Library MCP servers are stored per agent; Synara connectors are host-wide, so a connector
// created here is written into every library agent.
import {
  type LibraryHook as ContractHook,
  type LibraryMcpServer as ContractMcpServer,
  type LibrarySubagent as ContractSubagent,
  NEOLIX_LIBRARY_WS_METHODS,
  type McpConnector,
  type McpConnectorConnectInput,
  WS_METHODS,
} from "@synara/contracts";
import {
  defaultMcpConnectorName,
  findMcpConnectorPreset,
  mcpConnectorServerName,
  mcpConnectorSlug,
  normalizeMcpConnectorUrl,
} from "@synara/shared/mcpConnectors";
import { Effect } from "effect";

import type { BridgeModel } from "./model.ts";
import { bridgeError, codedError, fromPromise } from "./rpcErrors.ts";
import type { AnyHandler } from "./stubs.ts";

/** Library agent ids the daemon knows about, read from the snapshot the caller already has. */
function agentIds(library: { agents: ReadonlyArray<{ id: string }> }): string[] {
  return library.agents.map((agent) => agent.id);
}

function listenOrigin(
  listen: string | null | undefined,
  publicUrl: string | undefined,
): string | null {
  const publicBase = publicUrl?.trim();
  if (publicBase) return publicBase.replace(/\/+$/u, "");
  const value = listen?.trim();
  if (!value) return null;
  // Unix sockets and Windows named pipes have no HTTP address.
  if (value.startsWith("/") || value.startsWith("\\") || value.includes("\\\\.\\pipe")) {
    return null;
  }
  return /^\[?[0-9a-fA-F:.]+\]?:\d+$/u.test(value) ? `http://${value}` : null;
}

/** The daemon's built-in agent MCP endpoint and the "give agents Neox tools" switch. */
async function readNeolixTools(model: BridgeModel) {
  const [{ config }, status] = await Promise.all([
    model.client.getDaemonConfig(),
    model.client.getDaemonStatus(),
  ]);
  const origin = listenOrigin(status.listen, status.publicUrl);
  return {
    address: origin ? `${origin}/mcp/agents` : null,
    injectIntoAgents: config.mcp?.injectIntoAgents !== false,
    enabled: config.mcp?.enabled !== false,
  };
}

async function writeNeolixTools(
  model: BridgeModel,
  input: { injectIntoAgents?: boolean; enabled?: boolean },
) {
  const patch: Record<string, unknown> = {};
  if (input.injectIntoAgents !== undefined) patch.injectIntoAgents = input.injectIntoAgents;
  if (input.enabled !== undefined) patch.enabled = input.enabled;
  if (Object.keys(patch).length > 0) {
    await model.client.patchDaemonConfig({ mcp: patch } as never);
  }
  return readNeolixTools(model);
}

function mcpValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function connectorFromServer(server: ContractMcpServer): McpConnector {
  const now = new Date().toISOString();
  const signedIn = server.signIn?.signedIn === true;
  const status: McpConnector["status"] = server.signIn
    ? server.signIn.dead
      ? "needs-auth"
      : signedIn
        ? "connected"
        : "needs-auth"
    : "connected";
  const base = {
    connectorId: server.name,
    presetId: null,
    name: server.name,
    serverName: mcpConnectorServerName(mcpConnectorSlug(server.name)),
    authKind: (server.oauth || server.signIn ? "oauth" : "none") as "oauth" | "none",
    status,
    createdAt: now,
    updatedAt: now,
  };
  if (server.transport === "stdio") {
    return {
      ...base,
      transport: "stdio",
      command: mcpValue(server.command),
      args: [...(server.args ?? [])],
      envKeys: server.env ? Object.keys(server.env) : [],
    };
  }
  return {
    ...base,
    transport: server.local ? "local-http" : "remote-http",
    url: mcpValue(server.url),
  };
}

interface ConnectPayload {
  readonly presetId?: string;
  readonly url?: string;
  readonly name?: string;
  readonly command?: string;
  readonly args?: ReadonlyArray<string>;
  readonly env?: Readonly<Record<string, string>>;
  readonly clientId?: string;
  readonly clientSecret?: string;
}

function connectServerFromInput(
  input: McpConnectorConnectInput,
  agents: ReadonlyArray<string>,
): ContractMcpServer {
  const payload = input as ConnectPayload;
  if (typeof payload.command === "string" && payload.command.trim()) {
    // LibraryMcpServerSchema has no working directory, and the daemon's sync
    // drops unknown keys, so a connect input's `cwd` cannot be persisted. The
    // local-connector dialog no longer offers one.
    const name = payload.name?.trim() || payload.command.trim().slice(0, 60);
    return {
      name,
      transport: "stdio",
      command: payload.command.trim(),
      args: [...(payload.args ?? [])],
      ...(payload.env && Object.keys(payload.env).length > 0 ? { env: { ...payload.env } } : {}),
      agents: [...agents],
    };
  }

  const preset = payload.presetId ? findMcpConnectorPreset(payload.presetId) : undefined;
  const rawUrl = payload.url ?? preset?.url;
  if (!rawUrl) {
    throw bridgeError("library.connector-url-required", "A connector needs a URL or a preset id.");
  }
  const normalized = normalizeMcpConnectorUrl(rawUrl);
  if (!normalized.ok) {
    throw bridgeError("library.connector-url-invalid", normalized.reason, {
      detail: normalized.reason,
    });
  }
  const name = (
    payload.name?.trim() ||
    preset?.name ||
    defaultMcpConnectorName(normalized.url)
  ).slice(0, 60);
  return {
    name,
    transport: "http",
    url: normalized.url,
    ...(payload.clientId
      ? {
          oauth: {
            clientId: payload.clientId,
            ...(payload.clientSecret ? { clientSecret: payload.clientSecret } : {}),
          },
        }
      : {}),
    agents: [...agents],
  };
}

async function connectMcpServer(model: BridgeModel, input: McpConnectorConnectInput) {
  const { library } = await model.client.getLibrary();
  const agents = agentIds(library);
  const server = connectServerFromInput(input, agents);
  const existing = library.mcp.find((entry) => entry.name === server.name);
  const next = {
    ...server,
    ...(existing
      ? {
          agents: existing.agents.length > 0 ? [...existing.agents] : [...server.agents],
          // Editing a connector must not silently drop secrets or policy the UI never
          // receives. The dialog leaves env blank when the user did not touch it.
          ...(server.env === undefined && existing.env ? { env: { ...existing.env } } : {}),
          ...(existing.disabledTools ? { disabledTools: [...existing.disabledTools] } : {}),
          ...(existing.oauth ? { oauth: { ...existing.oauth } } : {}),
          ...(existing.startupTimeout !== undefined
            ? { startupTimeout: existing.startupTimeout }
            : {}),
          ...(existing.note ? { note: existing.note } : {}),
          ...(existing.icon ? { icon: existing.icon } : {}),
          ...(existing.local !== undefined ? { local: existing.local } : {}),
          ...(existing.router ? { router: existing.router } : {}),
        }
      : {}),
  } as unknown as Parameters<typeof model.client.saveLibraryMcpServer>[0];
  const saved = await model.client.saveLibraryMcpServer(next);
  const stored = (saved.library.mcp.find((entry) => entry.name === next.name) ??
    next) as unknown as ContractMcpServer;

  // Remote servers may answer OAuth; the daemon owns the callback. No URL means no sign-in.
  if (stored.transport !== "stdio") {
    try {
      const { state } = await model.client.signInLibraryMcpServer(stored.name);
      if (state.state === "waiting" && state.url) {
        return { authorizationUrl: state.url, connector: null };
      }
    } catch {
      // A server that needs no sign-in is already connected.
    }
  }

  return {
    authorizationUrl: null,
    connector: connectorFromServer(stored as unknown as ContractMcpServer),
  };
}

export function makeLibraryHandlers(model: BridgeModel): Record<string, AnyHandler> {
  const client = model.client;
  return {
    [NEOLIX_LIBRARY_WS_METHODS.get]: () => fromPromise("library.get", () => client.getLibrary()),
    [NEOLIX_LIBRARY_WS_METHODS.sync]: () => fromPromise("library.sync", () => client.syncLibrary()),
    [NEOLIX_LIBRARY_WS_METHODS.saveInstructions]: (payload) =>
      fromPromise("library.instructions.save", () =>
        client.saveLibraryInstructions(
          payload as Parameters<typeof client.saveLibraryInstructions>[0],
        ),
      ),
    [NEOLIX_LIBRARY_WS_METHODS.saveMcpServer]: (payload) => {
      const input = payload as { server: ContractMcpServer; oldName?: string };
      return fromPromise("library.mcp.save", () =>
        client.saveLibraryMcpServer(
          input.server as unknown as Parameters<typeof client.saveLibraryMcpServer>[0],
          input.oldName ? { oldName: input.oldName } : {},
        ),
      );
    },
    [NEOLIX_LIBRARY_WS_METHODS.removeMcpServer]: (payload) =>
      fromPromise("library.mcp.remove", () =>
        client.removeLibraryMcpServer((payload as { name: string }).name),
      ),
    [NEOLIX_LIBRARY_WS_METHODS.setMcpAgents]: (payload) => {
      const input = payload as { name: string; agents: string[] };
      return fromPromise("library.mcp.set_agents", () =>
        client.setLibraryMcpAgents(input.name, input.agents),
      );
    },
    [NEOLIX_LIBRARY_WS_METHODS.checkMcpServer]: (payload) =>
      fromPromise("library.mcp.health", () =>
        client.checkLibraryMcpServer((payload as { name: string }).name),
      ),
    [NEOLIX_LIBRARY_WS_METHODS.setMcpHub]: (payload) =>
      fromPromise("library.mcp.hub", () =>
        client.setLibraryMcpHub((payload as { on: boolean }).on),
      ),
    [NEOLIX_LIBRARY_WS_METHODS.setMcpLocal]: (payload) => {
      const input = payload as { name: string; local: boolean };
      return fromPromise("library.mcp.local", () =>
        client.setLibraryMcpLocal(input.name, input.local),
      );
    },
    [NEOLIX_LIBRARY_WS_METHODS.setMcpRouter]: (payload) => {
      const input = payload as { name: string; direct: boolean };
      return fromPromise("library.mcp.router", () =>
        client.setLibraryMcpRouter(input.name, input.direct),
      );
    },
    [NEOLIX_LIBRARY_WS_METHODS.signInMcpServer]: (payload) =>
      fromPromise("library.mcp.signin", () =>
        client.signInLibraryMcpServer((payload as { name: string }).name),
      ),
    [NEOLIX_LIBRARY_WS_METHODS.mcpSignInStatus]: (payload) =>
      fromPromise("library.mcp.signin_status", () =>
        client.libraryMcpSignInStatus((payload as { id: string }).id),
      ),
    [NEOLIX_LIBRARY_WS_METHODS.cancelMcpSignIn]: (payload) =>
      fromPromise("library.mcp.signin_cancel", () =>
        client.cancelLibraryMcpSignIn((payload as { id: string }).id),
      ),
    [NEOLIX_LIBRARY_WS_METHODS.signOutMcpServer]: (payload) =>
      fromPromise("library.mcp.signout", () =>
        client.signOutLibraryMcpServer((payload as { name: string }).name),
      ),
    [NEOLIX_LIBRARY_WS_METHODS.importSkill]: (payload) =>
      fromPromise("library.skill.import", () =>
        client.importLibrarySkill((payload as { path: string }).path),
      ),
    [NEOLIX_LIBRARY_WS_METHODS.findSkills]: (payload) =>
      fromPromise("library.skill.find", () =>
        client.findLibrarySkills((payload as { source: never }).source),
      ),
    [NEOLIX_LIBRARY_WS_METHODS.installSkills]: (payload) => {
      const input = payload as { source: never; names: string[] };
      return fromPromise("library.skill.install", () =>
        client.installLibrarySkills(input.source, input.names),
      );
    },
    [NEOLIX_LIBRARY_WS_METHODS.setSkillOptions]: (payload) =>
      fromPromise("library.skill.options", () =>
        client.setLibrarySkillOptions(
          payload as Parameters<typeof client.setLibrarySkillOptions>[0],
        ),
      ),
    [NEOLIX_LIBRARY_WS_METHODS.setSkillNote]: (payload) => {
      const input = payload as { name: string; note: string };
      return fromPromise("library.skill.note", () =>
        client.setLibrarySkillNote(input.name, input.note),
      );
    },
    [NEOLIX_LIBRARY_WS_METHODS.checkSkillUpdates]: () =>
      fromPromise("library.skill.check", () => client.checkLibrarySkillUpdates()),
    [NEOLIX_LIBRARY_WS_METHODS.updateSkills]: (payload) =>
      fromPromise("library.skill.update", () =>
        client.updateLibrarySkills((payload as { names: string[] | null }).names),
      ),
    [NEOLIX_LIBRARY_WS_METHODS.removeSkill]: (payload) =>
      fromPromise("library.skill.remove", () =>
        client.removeLibrarySkill((payload as { name: string }).name),
      ),
    [NEOLIX_LIBRARY_WS_METHODS.setSkillAgents]: (payload) => {
      const input = payload as { name: string; agents: string[] };
      return fromPromise("library.skill.set_agents", () =>
        client.setLibrarySkillAgents(input.name, input.agents),
      );
    },
    [NEOLIX_LIBRARY_WS_METHODS.setSkillHere]: (payload) => {
      const input = payload as { name: string; on: boolean };
      return fromPromise("library.skill.here", () =>
        client.setLibrarySkillHere(input.name, input.on),
      );
    },
    [NEOLIX_LIBRARY_WS_METHODS.handOverSkills]: (payload) =>
      fromPromise("library.skill.handover", () =>
        client.handOverLibrarySkills((payload as { names: string[] | null }).names),
      ),
    [NEOLIX_LIBRARY_WS_METHODS.handBackSkill]: (payload) =>
      fromPromise("library.skill.handback", () =>
        client.handBackLibrarySkill((payload as { name: string }).name),
      ),
    [NEOLIX_LIBRARY_WS_METHODS.settleSkill]: (payload) => {
      const input = payload as { name: string; agent: string; keepOwn: boolean };
      return fromPromise("library.skill.settle", () =>
        client.settleLibrarySkill(input.name, input.agent, input.keepOwn),
      );
    },
    [NEOLIX_LIBRARY_WS_METHODS.searchMarket]: (payload) =>
      fromPromise("library.market.servers", () =>
        client.searchLibraryMarket((payload as { query: string }).query),
      ),
    [NEOLIX_LIBRARY_WS_METHODS.installMarketServer]: (payload) => {
      const input = payload as { id: string; values: Record<string, string>; agents: string[] };
      return fromPromise("library.market.install", () =>
        client.installLibraryMarketServer(input.id, input.values, input.agents),
      );
    },
    [NEOLIX_LIBRARY_WS_METHODS.searchSkillMarket]: (payload) =>
      fromPromise("library.market.skills", () =>
        client.searchLibrarySkillMarket((payload as { query: string }).query),
      ),
    [NEOLIX_LIBRARY_WS_METHODS.saveHook]: (payload) => {
      const input = payload as { hook: ContractHook; oldName?: string };
      return fromPromise("library.hook.save", () =>
        client.saveLibraryHook(
          input.hook as Parameters<typeof client.saveLibraryHook>[0],
          input.oldName ? { oldName: input.oldName } : {},
        ),
      );
    },
    [NEOLIX_LIBRARY_WS_METHODS.removeHook]: (payload) =>
      fromPromise("library.hook.remove", () =>
        client.removeLibraryHook((payload as { name: string }).name),
      ),
    [NEOLIX_LIBRARY_WS_METHODS.setHookAgents]: (payload) => {
      const input = payload as { name: string; agents: string[] };
      return fromPromise("library.hook.set_agents", () =>
        client.setLibraryHookAgents(input.name, input.agents),
      );
    },
    [NEOLIX_LIBRARY_WS_METHODS.saveSubagent]: (payload) => {
      const input = payload as { subagent: ContractSubagent; oldName?: string };
      return fromPromise("library.subagent.save", () =>
        client.saveLibrarySubagent(
          input.subagent as Parameters<typeof client.saveLibrarySubagent>[0],
          input.oldName ? { oldName: input.oldName } : {},
        ),
      );
    },
    [NEOLIX_LIBRARY_WS_METHODS.removeSubagent]: (payload) =>
      fromPromise("library.subagent.remove", () =>
        client.removeLibrarySubagent((payload as { name: string }).name),
      ),
    [NEOLIX_LIBRARY_WS_METHODS.setSubagentAgents]: (payload) => {
      const input = payload as { name: string; agents: string[] };
      return fromPromise("library.subagent.set_agents", () =>
        client.setLibrarySubagentAgents(input.name, input.agents),
      );
    },
    [NEOLIX_LIBRARY_WS_METHODS.getRtk]: () =>
      fromPromise("library.rtk.get", () => client.getLibraryRtk()),
    [NEOLIX_LIBRARY_WS_METHODS.setRtk]: (payload) => {
      const input = payload as { agent: string; on: boolean };
      return fromPromise("library.rtk.set", () => client.setLibraryRtk(input.agent, input.on));
    },
    [NEOLIX_LIBRARY_WS_METHODS.runRtk]: (payload) => {
      const input = payload as { action: "install" | "upgrade"; distro?: string };
      return fromPromise("library.rtk.run", () =>
        client.runLibraryRtk(
          input.action,
          input.distro === undefined ? {} : { distro: input.distro },
        ),
      );
    },
    [NEOLIX_LIBRARY_WS_METHODS.getRtkGain]: () =>
      fromPromise("library.rtk.gain", () => client.getLibraryRtkGain()),
    [NEOLIX_LIBRARY_WS_METHODS.getDiscover]: () =>
      fromPromise("library.discover.get", () => client.discoverLibrary()),
    [NEOLIX_LIBRARY_WS_METHODS.importDiscovered]: (payload) =>
      fromPromise("library.discover.import", () =>
        client.importLibraryDiscovered(
          payload as Parameters<typeof client.importLibraryDiscovered>[0],
        ),
      ),
    [NEOLIX_LIBRARY_WS_METHODS.removeDiscovered]: (payload) =>
      fromPromise("library.discover.remove", () =>
        client.removeLibraryDiscovered(
          payload as Parameters<typeof client.removeLibraryDiscovered>[0],
        ),
      ),
    [NEOLIX_LIBRARY_WS_METHODS.getMynaLibrary]: () =>
      fromPromise("library.myna.get", () => client.getMynaLibrary()),
    [NEOLIX_LIBRARY_WS_METHODS.importMynaLibrary]: (payload) =>
      fromPromise("library.myna.import", () =>
        client.importMynaLibrary(payload as Parameters<typeof client.importMynaLibrary>[0]),
      ),
    [NEOLIX_LIBRARY_WS_METHODS.listBackups]: () =>
      fromPromise("library.backup.list", () => client.getLibraryBackups()),
    [NEOLIX_LIBRARY_WS_METHODS.restoreBackup]: (payload) =>
      fromPromise("library.backup.restore", () =>
        client.restoreLibraryBackup(payload as Parameters<typeof client.restoreLibraryBackup>[0]),
      ),
    [NEOLIX_LIBRARY_WS_METHODS.getNeolixTools]: () =>
      fromPromise("library.neolixTools.get", () => readNeolixTools(model)),
    [NEOLIX_LIBRARY_WS_METHODS.setNeolixTools]: (payload) =>
      fromPromise("library.neolixTools.set", () =>
        writeNeolixTools(model, payload as { injectIntoAgents?: boolean; enabled?: boolean }),
      ),

    // ── Synara Connectors panel ──────────────────────────────────────────────
    [WS_METHODS.serverListMcpConnectors]: () =>
      fromPromise("server.listMcpConnectors", async () => {
        const { library } = await client.getLibrary();
        return library.mcp.map((server) =>
          connectorFromServer(server as unknown as ContractMcpServer),
        );
      }),
    [WS_METHODS.serverListMcpConnectorProposals]: () => Effect.succeed([]),
    [WS_METHODS.serverResolveMcpConnectorProposal]: () =>
      Effect.fail(
        codedError(
          "library.connector-proposals-unsupported",
          "Neox does not take MCP connector proposals from agents.",
          undefined,
          { retryable: false },
        ),
      ),
    [WS_METHODS.serverConnectMcpConnector]: (payload) =>
      fromPromise("server.connectMcpConnector", () =>
        connectMcpServer(model, payload as McpConnectorConnectInput),
      ),
    [WS_METHODS.serverDisconnectMcpConnector]: (payload) =>
      fromPromise("server.disconnectMcpConnector", async () => {
        await client.removeLibraryMcpServer((payload as { connectorId: string }).connectorId);
        return { disconnected: true };
      }),
    // The daemon's own OAuth app path listens on http://localhost:<dynamic port>/callback and
    // tells the user to register http://localhost/callback with the vendor (mcpauth.ts
    // NO_REGISTRATION_MESSAGE). Loopback redirects match with any port, so that literal URL is
    // the one to show here; the actual port is only known once sign-in starts.
    [WS_METHODS.serverGetMcpConnectorSetup]: () =>
      Effect.succeed({ redirectUrl: "http://localhost/callback" }),
  };
}
