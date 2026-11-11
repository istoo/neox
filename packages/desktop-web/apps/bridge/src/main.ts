import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { Effect, Layer } from "effect";
import * as os from "node:os";
import * as path from "node:path";

import { makeBridgeServerLayer } from "./server.ts";
import { makeHandlers } from "./handlers.ts";
import { connectNeolix } from "./neolix.ts";
import { BridgeModel } from "./model.ts";
import { DraftThreads } from "./draftThreads.ts";
import { ProjectPins } from "./projectPins.ts";
import { HostRegistry, httpBaseForConnection, makeHostRegistryHandlers } from "./multihost.ts";
import { patchBunWebSocketCloseEventCompatibility } from "./bunWebSocketCompatibility.ts";
import { bridgeError } from "./rpcErrors.ts";

// Bun's ws shim emits close events without a code, which the RPC socket rejects and crashes on.
patchBunWebSocketCloseEventCompatibility();

const host = process.env.BRIDGE_HOST ?? "127.0.0.1";
const port = Number(process.env.BRIDGE_PORT ?? 7731);
const daemonHost = process.env.NEOLIX_DAEMON ?? "localhost:6768";
const neolixHome = process.env.NEOLIX_HOME;
const webDistDir = process.env.BRIDGE_WEB_DIST?.trim() || undefined;
// Dev serves the web app from another port, so the sandboxed frame needs that origin in
// `frame-ancestors`. Packaged Electron loads the web build from this bridge and needs only 'self'.
const frameAncestorOrigins = (process.env.BRIDGE_FRAME_ANCESTOR_ORIGINS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter((value) => value.length > 0);

function log(line: string): void {
  process.stderr.write(`[bridge] ${new Date().toISOString()} ${line}\n`);
}

if (!neolixHome) {
  log("NEOLIX_HOME is required so the bridge can read the daemon's local credential.");
  process.exit(2);
}

const program = Effect.gen(function* () {
  const neolix = yield* Effect.promise(() =>
    connectNeolix({ host: daemonHost, home: neolixHome, log }),
  );
  const environmentId = `neolix-${daemonHost.replace(/[^A-Za-z0-9]/g, "-")}`;
  // Pins are keyed by environment so each host this bridge serves keeps its own set.
  const projectPins = new ProjectPins({
    file: path.join(neolixHome, "desktop-web", "project-pins.json"),
    scope: environmentId,
    log,
  });
  yield* Effect.promise(() => projectPins.load());
  const draftThreads = new DraftThreads({
    file: path.join(neolixHome, "desktop-web", "draft-threads.json"),
    scope: environmentId,
    log,
  });
  // The controller daemon runs on this machine, so its home folder is this process's.
  const model = new BridgeModel(neolix, log, os.homedir(), projectPins, draftThreads);
  yield* Effect.promise(() => model.load());
  const label = os.hostname() || "Neox";
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
  log(`connected to ${daemonHost}; serving ws://${host}:${port}/ws`);
  const server = makeBridgeServerLayer({
    host,
    port,
    handlers: {
      ...makeHandlers(model, {
        environmentId,
        home: neolixHome,
        log,
        label,
        projectPins,
        ...(daemonHttpBase ? { daemonHttpBase } : {}),
      }),
      ...makeHostRegistryHandlers(registry),
    },
    resolveHostHandlers: (hostId) => registry.handlersFor(hostId),
    ...(webDistDir ? { webDistDir } : {}),
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
      frameAncestorOrigins,
    },
    log,
  });
  // The handler map is assembled per tag at runtime, so its requirements are not tracked
  // statically; every handler closes over `model` and needs no services.
  return yield* Layer.launch(server as Layer.Layer<never, unknown, never>);
});

NodeRuntime.runMain(program);
