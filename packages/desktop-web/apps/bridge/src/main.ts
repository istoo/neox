import "./clientRuntime.node.ts";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { Effect, Layer } from "effect";

import { createBridgeApp } from "./app.ts";
import { makeBridgeServerLayer } from "./server.ts";
import { patchBunWebSocketCloseEventCompatibility } from "./bunWebSocketCompatibility.ts";

// Standalone bridge for `bun src/main.ts` development. The daemon mounts the same routes
// on its own HTTP server instead (see embed.ts).

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
  const app = yield* Effect.promise(() =>
    createBridgeApp({
      daemonHost,
      neolixHome,
      ...(webDistDir ? { webDistDir } : {}),
      frameAncestorOrigins,
      log,
    }),
  );
  log(`connected to ${daemonHost}; serving ws://${host}:${port}/rpc`);
  const server = makeBridgeServerLayer({ ...app.routes, host, port });
  // The handler map is assembled per tag at runtime, so its requirements are not tracked
  // statically; every handler closes over `model` and needs no services.
  return yield* Layer.launch(server as Layer.Layer<never, unknown, never>);
});

NodeRuntime.runMain(program);
