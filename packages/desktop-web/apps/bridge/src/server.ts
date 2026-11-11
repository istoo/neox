import * as http from "node:http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import {
  WS_BOOTSTRAP_METHOD,
  WS_BOOTSTRAP_PATH,
  WS_FEATURE_PATH,
  WS_NEGOTIATE_HTTP_PATH,
  WsBootstrapRpcGroup,
  WsComputerRpcGroup,
  WsDeviceRpcGroup,
  NeolixLibraryRpcGroup,
  NeolixGatewayRpcGroup,
  WsFeatureRpcGroup,
  WsNeolixHostRpcGroup,
  WsProjectAgentRpcGroup,
  WsProjectFileRpcGroup,
  WsRealtimeVoiceRpcGroup,
  NeolixManagementRpcGroup,
} from "@synara/contracts";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";

import {
  ATTACHMENT_CANCEL_PATH,
  ATTACHMENT_DOWNLOAD_PREFIX,
  ATTACHMENT_UPLOAD_PATH,
  makeAttachmentCancelHandler,
  makeAttachmentDownloadHandler,
  makeAttachmentPreflightHandler,
  makeAttachmentUploadHandler,
  sharedAttachmentStore,
} from "./attachments.ts";
import {
  negotiateWsCompatibility,
  parseWsNegotiateSearchParams,
  validateWsFeatureCompatibility,
} from "./compatibility.ts";
import { makeProjectFaviconHandler, PROJECT_FAVICON_PATH } from "./favicon.ts";
import { makeSiteFaviconHandler, SITE_FAVICON_PATH } from "./siteFavicon.ts";
import {
  makeThreadExportHandler,
  THREAD_EXPORT_PATH,
  type ThreadExportThread,
} from "./threadExport.ts";
import { createPluginWebHandler } from "./pluginWeb.ts";
import { resolveStaticAsset, staticResponseHeaders } from "./staticFiles.ts";
import { type AnyHandler, withStubs } from "./stubs.ts";
import {
  makeTerminalUploadHandler,
  makeTerminalUploadPreflightHandler,
  TERMINAL_UPLOAD_PATH,
  type TerminalUpload,
} from "./terminalUpload.ts";

// The same four groups the front end's RpcClient merges (apps/web/src/wsTransport.ts).
export const BridgeRpcGroup = WsFeatureRpcGroup.merge(WsDeviceRpcGroup)
  .merge(WsComputerRpcGroup)
  .merge(WsProjectAgentRpcGroup)
  .merge(WsProjectFileRpcGroup)
  .merge(WsNeolixHostRpcGroup)
  .merge(NeolixLibraryRpcGroup)
  .merge(NeolixGatewayRpcGroup)
  .merge(WsRealtimeVoiceRpcGroup)
  .merge(NeolixManagementRpcGroup);

export interface BridgeServerOptions {
  readonly host: string;
  readonly port: number;
  readonly handlers: Record<string, AnyHandler>;
  readonly log: (line: string) => void;
  /**
   * Built `apps/web/dist` served from the same origin as the RPC socket. The
   * Electron shell sets this so the renderer can derive its WebSocket URL from
   * `window.location`; plain `bun src/main.ts` runs leave it unset.
   */
  readonly webDistDir?: string;
  /** Stores terminal drop/paste bytes on the host; the route is absent when unset. */
  readonly uploadTerminalFile?: TerminalUpload;
  /** Loads a thread for the composer's Markdown `/export` download. */
  readonly threadExport?: {
    readonly loadThread: (threadId: string) => Promise<ThreadExportThread | null>;
  };
  /** Reads declared plugin web assets for the sandboxed view route. */
  readonly pluginWeb?: {
    readonly readAsset: (
      pluginId: string,
      assetPath: string,
    ) => Promise<{ contentType: string; encoding: "utf8" | "base64"; content: string }>;
    readonly frameAncestorOrigins?: readonly string[];
  };
  /**
   * Handler maps for connected hosts. `key` identifies one live session: when a host
   * reconnects, its handlers are rebuilt and the cached socket is replaced.
   */
  readonly resolveHostHandlers?: (
    hostId: string,
  ) => { readonly key: string; readonly handlers: Record<string, AnyHandler> } | null;
}

/** Loopback-only bridge: any localhost origin may negotiate, nothing else. */
function isLoopbackOrigin(origin: string | undefined): origin is string {
  if (!origin) return false;
  try {
    const { hostname } = new URL(origin);
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

function requestUrl(request: HttpServerRequest.HttpServerRequest): URL | null {
  return HttpServerRequest.toURL(request) ?? null;
}

export function makeBridgeServerLayer(options: BridgeServerOptions) {
  const makeFeatureSocket = (handlers: Record<string, AnyHandler>) => {
    const resolved = withStubs(BridgeRpcGroup, handlers, options.log);
    return RpcServer.toHttpEffectWebsocket(BridgeRpcGroup, {
      spanPrefix: "bridge.rpc",
    }).pipe(
      Effect.provide(
        // oxlint-disable-next-line typescript/no-explicit-any -- the handler map is built per tag at runtime
        BridgeRpcGroup.toLayer(Effect.succeed(resolved as any)).pipe(
          Layer.provideMerge(RpcSerialization.layerJson),
        ),
      ),
    );
  };

  const featureSocket = makeFeatureSocket(options.handlers);

  // One feature socket per connected host. Bumped `key` means the host reconnected and
  // its handlers were rebuilt; the stale socket must not serve the new session.
  const hostSockets = new Map<
    string,
    { readonly key: string; readonly socket: ReturnType<typeof makeFeatureSocket> }
  >();
  const hasHost = (hostId: string): boolean => options.resolveHostHandlers?.(hostId) != null;
  const hostFeatureSocket = (hostId: string): ReturnType<typeof makeFeatureSocket> | null => {
    const resolved = options.resolveHostHandlers?.(hostId);
    if (!resolved) {
      // A removed host must not keep its feature socket cached.
      hostSockets.delete(hostId);
      return null;
    }
    const cached = hostSockets.get(hostId);
    if (cached?.key === resolved.key) return cached.socket;
    const socket = makeFeatureSocket(resolved.handlers);
    hostSockets.set(hostId, { key: resolved.key, socket });
    return socket;
  };

  const bootstrapSocket = RpcServer.toHttpEffectWebsocket(WsBootstrapRpcGroup, {
    spanPrefix: "bridge.bootstrap",
  }).pipe(
    Effect.provide(
      WsBootstrapRpcGroup.toLayer(
        Effect.succeed(WsBootstrapRpcGroup.of({ [WS_BOOTSTRAP_METHOD]: negotiateWsCompatibility })),
      ).pipe(Layer.provideMerge(RpcSerialization.layerJson)),
    ),
  );

  const routes = HttpRouter.use((router) =>
    Effect.gen(function* () {
      const feature = yield* featureSocket;
      const bootstrap = yield* bootstrapSocket;

      yield* router.add(
        "GET",
        WS_NEGOTIATE_HTTP_PATH,
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const origin = request.headers.origin;
          const headers: Record<string, string> = { "Cache-Control": "no-store" };
          if (isLoopbackOrigin(origin)) {
            headers["Access-Control-Allow-Origin"] = origin;
            headers.Vary = "Origin";
          }
          const url = requestUrl(request);
          if (!url) return HttpServerResponse.text("Bad request", { status: 400, headers });
          const input = parseWsNegotiateSearchParams(url.searchParams);
          if (!("protocolEpoch" in input) || "_tag" in input) {
            return HttpServerResponse.jsonUnsafe(input, { status: 426, headers });
          }
          return yield* negotiateWsCompatibility(input).pipe(
            Effect.map((result) => HttpServerResponse.jsonUnsafe(result, { status: 200, headers })),
            Effect.catch((error) =>
              Effect.succeed(HttpServerResponse.jsonUnsafe(error, { status: 426, headers })),
            ),
          );
        }),
      );

      yield* router.add("GET", WS_BOOTSTRAP_PATH, bootstrap);

      yield* router.add("GET", PROJECT_FAVICON_PATH, makeProjectFaviconHandler());
      yield* router.add("GET", SITE_FAVICON_PATH, makeSiteFaviconHandler());

      if (options.threadExport) {
        yield* router.add(
          "GET",
          THREAD_EXPORT_PATH,
          makeThreadExportHandler({ loadThread: options.threadExport.loadThread }),
        );
      }

      // Composer attachments arrive over HTTP before the turn that carries their ids.
      const attachmentPreflight = makeAttachmentPreflightHandler();
      yield* router.add("OPTIONS", ATTACHMENT_UPLOAD_PATH, attachmentPreflight);
      yield* router.add("OPTIONS", ATTACHMENT_CANCEL_PATH, attachmentPreflight);
      yield* router.add(
        "POST",
        ATTACHMENT_UPLOAD_PATH,
        makeAttachmentUploadHandler(sharedAttachmentStore),
      );
      yield* router.add(
        "POST",
        ATTACHMENT_CANCEL_PATH,
        makeAttachmentCancelHandler(sharedAttachmentStore),
      );
      yield* router.add(
        "GET",
        `${ATTACHMENT_DOWNLOAD_PREFIX}:attachmentId`,
        makeAttachmentDownloadHandler(sharedAttachmentStore),
      );

      // Terminal drops and clipboard images become host files, then paste their path.
      const uploadTerminalFile = options.uploadTerminalFile;
      if (uploadTerminalFile) {
        yield* router.add("OPTIONS", TERMINAL_UPLOAD_PATH, makeTerminalUploadPreflightHandler());
        yield* router.add(
          "POST",
          TERMINAL_UPLOAD_PATH,
          makeTerminalUploadHandler(uploadTerminalFile),
        );
      }

      yield* router.add(
        "GET",
        WS_FEATURE_PATH,
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const url = requestUrl(request);
          if (!url) return HttpServerResponse.text("Bad request", { status: 400 });
          const origin = request.headers.origin;
          if (origin !== undefined && !isLoopbackOrigin(origin)) {
            return HttpServerResponse.text("Forbidden", { status: 403 });
          }
          const compatibilityError = validateWsFeatureCompatibility(url.searchParams);
          if (compatibilityError) {
            return HttpServerResponse.jsonUnsafe(compatibilityError, {
              status: 426,
              headers: { "Cache-Control": "no-store" },
            });
          }
          return yield* feature;
        }),
      );

      // A connected host's execution environment. The renderer resolved these paths
      // against the controller URL, so each path mirrors `/ws` under `/ws/remote/<hostId>`.
      yield* router.add(
        "GET",
        "/ws/remote/:hostId/ws/negotiate",
        Effect.gen(function* () {
          const params = yield* HttpRouter.params;
          if (!params.hostId || !hasHost(params.hostId)) {
            return HttpServerResponse.text("Not found", { status: 404 });
          }
          const request = yield* HttpServerRequest.HttpServerRequest;
          const origin = request.headers.origin;
          const headers: Record<string, string> = { "Cache-Control": "no-store" };
          if (isLoopbackOrigin(origin)) {
            headers["Access-Control-Allow-Origin"] = origin;
            headers.Vary = "Origin";
          }
          const url = requestUrl(request);
          if (!url) return HttpServerResponse.text("Bad request", { status: 400, headers });
          const input = parseWsNegotiateSearchParams(url.searchParams);
          if (!("protocolEpoch" in input) || "_tag" in input) {
            return HttpServerResponse.jsonUnsafe(input, { status: 426, headers });
          }
          return yield* negotiateWsCompatibility(input).pipe(
            Effect.map((result) => HttpServerResponse.jsonUnsafe(result, { status: 200, headers })),
            Effect.catch((error) =>
              Effect.succeed(HttpServerResponse.jsonUnsafe(error, { status: 426, headers })),
            ),
          );
        }),
      );

      yield* router.add(
        "GET",
        "/ws/remote/:hostId/ws/bootstrap",
        Effect.gen(function* () {
          const params = yield* HttpRouter.params;
          if (!params.hostId || !hasHost(params.hostId)) {
            return HttpServerResponse.text("Not found", { status: 404 });
          }
          return yield* bootstrap;
        }),
      );

      yield* router.add(
        "GET",
        "/ws/remote/:hostId/ws",
        Effect.gen(function* () {
          const params = yield* HttpRouter.params;
          const request = yield* HttpServerRequest.HttpServerRequest;
          const url = requestUrl(request);
          if (!url) return HttpServerResponse.text("Bad request", { status: 400 });
          const origin = request.headers.origin;
          if (origin !== undefined && !isLoopbackOrigin(origin)) {
            return HttpServerResponse.text("Forbidden", { status: 403 });
          }
          if (!params.hostId) return HttpServerResponse.text("Not found", { status: 404 });
          const socket = hostFeatureSocket(params.hostId);
          if (!socket) return HttpServerResponse.text("Not found", { status: 404 });
          const compatibilityError = validateWsFeatureCompatibility(url.searchParams);
          if (compatibilityError) {
            return HttpServerResponse.jsonUnsafe(compatibilityError, {
              status: 426,
              headers: { "Cache-Control": "no-store" },
            });
          }
          // `socket` builds the per-host RPC server; the inner effect performs the
          // upgrade with this request in context.
          const handler = yield* socket;
          return yield* handler;
        }),
      );

      if (options.pluginWeb) {
        const pluginWeb = createPluginWebHandler(options.pluginWeb);
        yield* router.add(
          "GET",
          "/plugin-web/*",
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest;
            const url = requestUrl(request);
            if (!url) return HttpServerResponse.text("Bad request", { status: 400 });
            const response = yield* Effect.promise(() =>
              pluginWeb({ method: "GET", pathname: url.pathname, searchParams: url.searchParams }),
            );
            const body =
              typeof response.body === "string"
                ? new TextEncoder().encode(response.body)
                : response.body;
            return HttpServerResponse.uint8Array(body, {
              status: response.status,
              headers: response.headers,
            });
          }),
        );
      }

      if (options.webDistDir) {
        const webDistDir = options.webDistDir;
        const reservedPrefixes = ["/api/", "/mcp/", "/ws/", "/attachments/", "/remote-resources/"];
        // Catch-all after every API/WebSocket route: exact routes win in the
        // router, and only GET falls back here for the SPA's static files.
        yield* router.add(
          "GET",
          "*",
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest;
            const url = requestUrl(request);
            if (url && reservedPrefixes.some((prefix) => url.pathname.startsWith(prefix))) {
              return HttpServerResponse.text("Not found", { status: 404 });
            }
            const asset = url
              ? yield* Effect.promise(() =>
                  resolveStaticAsset({ webDistDir, pathname: url.pathname }),
                )
              : null;
            if (!asset) {
              return HttpServerResponse.text("Not found", { status: 404 });
            }
            return yield* HttpServerResponse.file(asset.filePath, {
              headers: staticResponseHeaders(asset, url?.pathname ?? "/"),
            }).pipe(
              Effect.catch(() =>
                Effect.succeed(HttpServerResponse.text("Not found", { status: 404 })),
              ),
            );
          }),
        );
      }
    }),
  );

  return HttpRouter.serve(routes).pipe(
    Layer.provide(
      NodeHttpServer.layer(() => http.createServer(), { host: options.host, port: options.port }),
    ),
  );
}
