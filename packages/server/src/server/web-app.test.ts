import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  daemonAddressForWebApp,
  isLocalWebAppRequest,
  isWebAppPage,
  isWebAppRoute,
  isWebAppUpgrade,
  resolveWebAppPaths,
  webAppCandidates,
} from "./web-app.js";

function request(input: {
  remoteAddress?: string;
  host?: string;
  origin?: string;
  unixSocket?: boolean;
}): IncomingMessage {
  const socket = input.unixSocket
    ? { remoteAddress: undefined, remoteFamily: undefined }
    : { remoteAddress: input.remoteAddress ?? "127.0.0.1", remoteFamily: "IPv4" };
  const headers: Record<string, string> = {};
  if (input.host !== undefined) headers.host = input.host;
  if (input.origin !== undefined) headers.origin = input.origin;
  return { socket, headers } as unknown as IncomingMessage;
}

describe("web app routing", () => {
  it("claims its RPC, upload and view routes and nothing of the daemon's", () => {
    for (const owned of [
      "/rpc",
      "/rpc/negotiate",
      "/rpc/remote/host-1/rpc",
      "/api/attachments/upload",
      "/attachments/abc",
      "/api/thread-export",
      "/plugin-web/p/view",
    ]) {
      expect(isWebAppRoute(owned), owned).toBe(true);
    }
    for (const daemon of ["/ws", "/api/health", "/api/files/download", "/mcp", "/public/x"]) {
      expect(isWebAppRoute(daemon), daemon).toBe(false);
    }
  });

  it("serves page loads for app paths but leaves daemon paths to the daemon", () => {
    expect(isWebAppPage("GET", "/")).toBe(true);
    expect(isWebAppPage("GET", "/settings/general")).toBe(true);
    expect(isWebAppPage("HEAD", "/assets/index.js")).toBe(true);
    expect(isWebAppPage("POST", "/")).toBe(false);
    for (const daemon of [
      "/api",
      "/api/health",
      "/mcp/sse",
      "/public/a.png",
      "/ws",
      "/.well-known/x",
    ]) {
      expect(isWebAppPage("GET", daemon), daemon).toBe(false);
    }
  });

  it("upgrades only its own sockets", () => {
    expect(isWebAppUpgrade("/rpc")).toBe(true);
    expect(isWebAppUpgrade("/rpc/remote/h/rpc")).toBe(true);
    expect(isWebAppUpgrade("/ws")).toBe(false);
    expect(isWebAppUpgrade("/rpcx")).toBe(false);
  });
});

describe("isLocalWebAppRequest", () => {
  it("admits this computer by address, Host and Origin", () => {
    expect(isLocalWebAppRequest(request({ host: "127.0.0.1:6767" }))).toBe(true);
    expect(isLocalWebAppRequest(request({ host: "localhost:6767" }))).toBe(true);
    expect(
      isLocalWebAppRequest(
        request({ remoteAddress: "::1", host: "[::1]:6767", origin: "http://[::1]:6767" }),
      ),
    ).toBe(true);
    expect(
      isLocalWebAppRequest(
        request({
          remoteAddress: "::ffff:127.0.0.1",
          host: "localhost:1",
          origin: "http://localhost:1",
        }),
      ),
    ).toBe(true);
    expect(isLocalWebAppRequest(request({ unixSocket: true }))).toBe(true);
  });

  it("refuses another machine, a public Host and a foreign Origin", () => {
    expect(
      isLocalWebAppRequest(request({ remoteAddress: "192.168.1.5", host: "127.0.0.1:1" })),
    ).toBe(false);
    // DNS rebinding: a public name resolved to loopback.
    expect(isLocalWebAppRequest(request({ host: "evil.example:6767" }))).toBe(false);
    expect(isLocalWebAppRequest(request({}))).toBe(false);
    expect(
      isLocalWebAppRequest(request({ host: "127.0.0.1:1", origin: "https://evil.example" })),
    ).toBe(false);
    expect(isLocalWebAppRequest(request({ host: "127.0.0.1:1", origin: "not a url" }))).toBe(false);
  });
});

describe("daemonAddressForWebApp", () => {
  it("dials loopback for a wildcard bind and keeps sockets as paths", () => {
    expect(daemonAddressForWebApp({ type: "tcp", host: "0.0.0.0", port: 6767 })).toBe(
      "127.0.0.1:6767",
    );
    expect(daemonAddressForWebApp({ type: "tcp", host: "::1", port: 1 })).toBe("[::1]:1");
    expect(daemonAddressForWebApp({ type: "socket", path: "/tmp/d.sock" })).toBe("/tmp/d.sock");
  });
});

describe("resolveWebAppPaths", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function webApp(root: string, bundle: string, dist: string): void {
    mkdirSync(path.dirname(path.join(root, bundle)), { recursive: true });
    writeFileSync(path.join(root, bundle), "");
    mkdirSync(path.join(root, dist), { recursive: true });
    writeFileSync(path.join(root, dist, "index.html"), "");
  }

  function resolve(input: Parameters<typeof webAppCandidates>[0]) {
    return resolveWebAppPaths(webAppCandidates(input));
  }

  it("prefers an explicit override, then the packaged desktop's resources", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "neolix-web-app-"));
    roots.push(root);
    webApp(root, "override/embed.js", "override/web");
    webApp(root, "resources/desktop-web/bridge/embed.js", "resources/desktop-web/web");
    const moduleUrl = new URL(`file://${path.join(root, "nowhere", "src", "server", "web-app.ts")}`)
      .href;

    expect(
      await resolve({
        env: {
          NEOLIX_WEB_APP_BUNDLE: path.join(root, "override/embed.js"),
          NEOLIX_WEB_APP_DIST: path.join(root, "override/web"),
        },
        resourcesPath: path.join(root, "resources"),
        moduleUrl,
      }),
    ).toEqual({
      bundlePath: path.join(root, "override/embed.js"),
      distDir: path.join(root, "override/web"),
    });
    expect(
      await resolve({ env: {}, resourcesPath: path.join(root, "resources"), moduleUrl }),
    ).toEqual({
      bundlePath: path.join(root, "resources/desktop-web/bridge/embed.js"),
      distDir: path.join(root, "resources/desktop-web/web"),
    });
  });

  it("finds the server's build, then the checkout's desktop-web builds, else nothing", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "neolix-web-app-"));
    roots.push(root);
    const moduleUrl = new URL(
      `file://${path.join(root, "packages", "server", "src", "server", "web-app.ts")}`,
    ).href;
    expect(await resolve({ env: {}, moduleUrl })).toBeNull();

    webApp(
      root,
      "packages/desktop-web/apps/bridge/dist/embed.js",
      "packages/desktop-web/apps/web/dist",
    );
    expect(await resolve({ env: {}, moduleUrl })).toEqual({
      bundlePath: path.join(root, "packages/desktop-web/apps/bridge/dist/embed.js"),
      distDir: path.join(root, "packages/desktop-web/apps/web/dist"),
    });

    webApp(
      root,
      "packages/server/dist/server/web-app/embed.js",
      "packages/server/dist/server/web-app/web",
    );
    expect(await resolve({ env: {}, moduleUrl })).toEqual({
      bundlePath: path.join(root, "packages/server/dist/server/web-app/embed.js"),
      distDir: path.join(root, "packages/server/dist/server/web-app/web"),
    });
  });

  it("skips a bundle whose page was never built", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "neolix-web-app-"));
    roots.push(root);
    mkdirSync(path.join(root, "only"), { recursive: true });
    writeFileSync(path.join(root, "only", "embed.js"), "");
    expect(
      await resolveWebAppPaths([
        { bundlePath: path.join(root, "only", "embed.js"), distDir: path.join(root, "missing") },
      ]),
    ).toBeNull();
  });
});
