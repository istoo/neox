import type * as Http from "node:http";
import type { Duplex } from "node:stream";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { NodeWS } from "@effect/platform-node/NodeSocket";
import { Effect, Exit, Layer, Scope } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";

import { createBridgeApp, type BridgeAppConfig } from "./app.ts";
import { installBridgeClientRuntime, type BridgeClientRuntime } from "./clientRuntime.ts";
import { makeBridgeRoutes } from "./server.ts";

// The daemon's entry into the web app: the same routes the standalone bridge serves,
// handed to the daemon's own HTTP server instead of a port of their own. Built as a
// bundle (`dist/embed.js`) that carries Effect and the bridge's own code but not the
// Neox client: the daemon injects the client and protocol modules it already has.

type RequestHandler = (request: Http.IncomingMessage, response: Http.ServerResponse) => void;
type UpgradeHandler = (request: Http.IncomingMessage, socket: Duplex, head: Buffer) => void;

export interface EmbeddedWebAppOptions extends BridgeAppConfig {
  /**
   * The daemon's copies of @neolix/client, its protocol constants and the credential
   * reader. Required: without them the bundle would have to ship a second copy.
   */
  readonly clientRuntime: BridgeClientRuntime;
}

export interface EmbeddedWebApp {
  /** Serves an HTTP request the daemon routed to the web app. */
  readonly handleRequest: RequestHandler;
  /** Takes over a WebSocket upgrade the daemon routed to the web app. */
  readonly handleUpgrade: UpgradeHandler;
  /** Closes the RPC sockets and the app's connection to the daemon. */
  readonly dispose: () => Promise<void>;
}

export async function startEmbeddedWebApp(options: EmbeddedWebAppOptions): Promise<EmbeddedWebApp> {
  const { clientRuntime, ...config } = options;
  installBridgeClientRuntime(clientRuntime);
  const app = await createBridgeApp(config);
  const handlers: { request: RequestHandler | null; upgrade: UpgradeHandler | null } = {
    request: null,
    upgrade: null,
  };

  // An HttpServer that never listens: `serve` only builds the request and upgrade
  // handlers, the same ones NodeHttpServer attaches to a server it owns.
  const embeddedServer = Layer.effect(
    HttpServer.HttpServer,
    Effect.gen(function* () {
      const scope = yield* Effect.scope;
      const wss = yield* Effect.acquireRelease(
        Effect.sync(() => new NodeWS.WebSocketServer({ noServer: true })),
        (server) =>
          Effect.callback<void>((resume) => {
            server.close(() => resume(Effect.void));
          }),
      ).pipe(Scope.provide(scope), Effect.cached);
      return HttpServer.make({
        address: { _tag: "TcpAddress", hostname: "127.0.0.1", port: 0 },
        serve: (httpApp, middleware) =>
          Effect.gen(function* () {
            const serveScope = yield* Effect.scope;
            // oxlint-disable-next-line typescript/no-explicit-any -- the untyped middleware NodeHttpServer passes along too
            const handlerOptions = { middleware: middleware as any, scope: serveScope };
            handlers.request = yield* NodeHttpServer.makeHandler(httpApp, handlerOptions);
            handlers.upgrade = yield* NodeHttpServer.makeUpgradeHandler(
              wss,
              httpApp,
              handlerOptions,
            );
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                handlers.request = null;
                handlers.upgrade = null;
              }),
            );
          }),
      });
    }),
  );

  // The handler map is assembled per tag at runtime, so its requirements are not tracked
  // statically; every handler closes over the app's model and needs no services.
  // The daemon filters Host before these routes (loopback on its port, key + Host on
  // Browser access), so the sockets may accept their own page's origin.
  const routes = makeBridgeRoutes({ ...app.routes, hostFilteredUpstream: true });
  const layer = HttpRouter.serve(routes, { disableListenLog: true }).pipe(
    Layer.provide(embeddedServer),
    Layer.provide(NodeHttpServer.layerHttpServices),
  ) as unknown as Layer.Layer<never, unknown, never>;

  const scope = Effect.runSync(Scope.make());
  try {
    await Effect.runPromise(Layer.buildWithScope(scope)(layer));
  } catch (error) {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    await app.dispose();
    throw error;
  }
  if (!handlers.request || !handlers.upgrade) {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    await app.dispose();
    throw new Error("The web app's HTTP handlers were not built.");
  }

  let disposed: Promise<void> | null = null;
  return {
    handleRequest: (request, response) => {
      const handler = handlers.request;
      if (!handler) {
        response.statusCode = 503;
        response.end("The web app is shutting down.");
        return;
      }
      handler(request, response);
    },
    handleUpgrade: (request, socket, head) => {
      const handler = handlers.upgrade;
      if (!handler) {
        socket.destroy();
        return;
      }
      handler(request, socket, head);
    },
    dispose: () => {
      disposed ??= (async () => {
        await Effect.runPromise(Scope.close(scope, Exit.void));
        await app.dispose();
      })();
      return disposed;
    },
  };
}
