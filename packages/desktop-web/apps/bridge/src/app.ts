import * as os from "node:os";
import * as path from "node:path";

import { makeHandlers } from "./handlers.ts";
import { connectNeolix } from "./neolix.ts";
import { BridgeModel } from "./model.ts";
import { DraftThreads } from "./draftThreads.ts";
import { ProjectPins } from "./projectPins.ts";
import { HostRegistry, httpBaseForConnection, makeHostRegistryHandlers } from "./multihost.ts";
import { bridgeError } from "./rpcErrors.ts";
import type { DaemonTransportFactory } from "../../../../client/dist/daemon-client-transport-types.js";
import type { BridgeRouteOptions } from "./server.ts";
import {
  environmentIdFor,
  legacyEnvironmentId,
  worktreesDirFor,
  type HostPaths,
} from "./serverInfo.ts";
import { bridgeServerCapabilities } from "./compatibility.ts";

export interface BridgeAppConfig {
  /** `host:port` (or socket target) of the daemon this app serves. */
  readonly daemonHost: string;
  /** The daemon's home: its local credential and the app's own state live here. */
  readonly neolixHome: string;
  /** Built `apps/web/dist`, served from the same origin as the RPC socket. */
  readonly webDistDir?: string;
  /** Extra origins allowed to frame plugin web views (dev serves the web app elsewhere). */
  readonly frameAncestorOrigins?: readonly string[];
  /**
   * The daemon's in-process transport when the daemon hosts this app (`embed.ts`); absent
   * in the standalone bridge, which dials the daemon's loopback socket instead.
   */
  readonly daemonTransport?: DaemonTransportFactory;
  readonly log: (line: string) => void;
}

export interface BridgeApp {
  /** Everything the routes need; the caller decides how they are served. */
  readonly routes: BridgeRouteOptions;
  readonly dispose: () => Promise<void>;
}

/**
 * Connects to the daemon and assembles the web app's RPC handlers. Shared by the
 * standalone bridge (`main.ts`) and the daemon, which mounts the same routes on its
 * own HTTP server (`embed.ts`).
 */
export async function createBridgeApp(config: BridgeAppConfig): Promise<BridgeApp> {
  const { daemonHost, neolixHome, log } = config;
  const neolix = await connectNeolix({
    host: daemonHost,
    home: neolixHome,
    // COMPAT(webAppInProcess): added in v0.16.5, remove after 2027-05-14; the standalone
    // bridge (`bun src/main.ts`) has no daemon to attach a socket from and dials loopback TCP.
    ...(config.daemonTransport ? { daemonTransport: config.daemonTransport } : {}),
    log,
  });
  // The daemon's serverId is stable across port changes; the address is only an endpoint.
  // COMPAT(environment-id): added in 0.16.5, remove the legacy scope after 2027-05-14.
  const legacyId = legacyEnvironmentId(daemonHost);
  const environmentId = environmentIdFor(neolix, legacyId);
  const legacyScopes = legacyId === environmentId ? [] : [legacyId];
  // Pins are keyed by environment so each host this bridge serves keeps its own set.
  const projectPins = new ProjectPins({
    file: path.join(neolixHome, "desktop-web", "project-pins.json"),
    scope: environmentId,
    legacyScopes,
    log,
  });
  await projectPins.load();
  const draftThreads = new DraftThreads({
    file: path.join(neolixHome, "desktop-web", "draft-threads.json"),
    scope: environmentId,
    legacyScopes,
    log,
  });
  // The controller daemon runs on this machine, so its home folder is this process's.
  const model = new BridgeModel(neolix, log, os.homedir(), projectPins, draftThreads);
  await model.load();
  const label = os.hostname() || "Neox";
  // Paths belong to the daemon's home, not to the bridge process. The daemon resolves a
  // custom `worktrees.root`; older daemons only ever had the documented default.
  const hostPaths: HostPaths = {
    cwd: os.homedir(),
    homeDir: os.homedir(),
    worktreesDir: await worktreesDirFor(neolix, path.join(neolixHome, "worktrees")),
  };
  // Backups download through the daemon's token route, which is plain HTTP. A socket or
  // SSH target has no reachable origin, and the handler reports that instead of guessing.
  const daemonHttpBase = httpBaseForConnection(daemonHost);
  const registry = new HostRegistry(neolix, {
    home: neolixHome,
    environmentId,
    label,
    log,
    buildHandlers: makeHandlers,
  });
  const routes: BridgeRouteOptions = {
    handlers: {
      ...makeHandlers(model, {
        environmentId,
        home: neolixHome,
        paths: hostPaths,
        log,
        label,
        projectPins,
        ...(daemonHttpBase ? { daemonHttpBase } : {}),
      }),
      ...makeHostRegistryHandlers(registry),
    },
    resolveHostHandlers: (hostId) => registry.handlersFor(hostId),
    resolveHostNegotiation: (hostId) => registry.negotiationFor(hostId),
    negotiation: {
      serverBuild: neolix.getLastServerInfoMessage()?.version ?? undefined,
      capabilities: bridgeServerCapabilities({
        daemonRuntimeStatus:
          neolix.getLastServerInfoMessage()?.features?.daemonRuntimeStatus === true,
      }),
    },
    ...(config.webDistDir ? { webDistDir: config.webDistDir } : {}),
    uploadTerminalFile: async (input) => {
      const result = await neolix.uploadFile(input);
      if (result.error || !result.file) {
        throw bridgeError(
          "file.terminal-upload-failed",
          result.error ?? `Uploading "${input.fileName}" failed.`,
          { name: input.fileName, ...(result.error ? { detail: result.error } : {}) },
        );
      }
      return result.file.path;
    },
    threadExport: {
      loadThread: async (threadId) => {
        const snapshot = await model.threadDetail(threadId);
        return snapshot ? snapshot.thread : null;
      },
    },
    pluginWeb: {
      readAsset: (pluginId, assetPath) => neolix.getPluginWebAsset(pluginId, assetPath),
      frameAncestorOrigins: config.frameAncestorOrigins ?? [],
    },
    log,
  };
  return {
    routes,
    dispose: async () => {
      await registry.dispose();
      model.dispose();
      await neolix.close().catch(() => undefined);
    },
  };
}
