import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import path from "node:path";

export interface BridgeLaunchPaths {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly webDistDir: string;
  /** Packaged builds run the bundled Node entry through Electron itself. */
  readonly electronRunAsNode?: boolean;
}

export interface ResolveBridgeLaunchPathsInput {
  readonly isPackaged: boolean;
  /** `process.resourcesPath`; only used in packaged builds. */
  readonly resourcesPath: string;
  /** Directory holding this desktop build's compiled main process (`dist`). */
  readonly desktopDistDir: string;
  readonly env: NodeJS.ProcessEnv;
}

function resolveDevPaths(input: ResolveBridgeLaunchPathsInput): BridgeLaunchPaths {
  // dist -> desktop -> packages -> repo root.
  const repoRoot = path.resolve(input.desktopDistDir, "../../..");
  const cwd = path.join(repoRoot, "packages", "desktop-web", "apps", "bridge");
  const entry = path.join(cwd, "src", "main.ts");
  return {
    command: input.env.NEOLIX_BUN_BINARY?.trim() || "bun",
    args: [entry],
    cwd,
    webDistDir: path.join(repoRoot, "packages", "desktop-web", "apps", "web", "dist"),
  };
}

/**
 * Packaged layout, produced by `npm run build:desktop-web` and copied by
 * electron-builder under `resources/desktop-web`:
 *
 *   bridge/main.js — single-file Node ESM bundle (`bun build --target=node`)
 *   web/           — a copy of `apps/web/dist`
 *
 * The bundle runs on Electron's own binary with `ELECTRON_RUN_AS_NODE=1`, the
 * same extension-host approach VS Code uses, so no Bun runtime ships.
 */
function resolvePackagedPaths(input: ResolveBridgeLaunchPathsInput): BridgeLaunchPaths {
  const root = path.join(input.resourcesPath, "desktop-web");
  return {
    command: process.execPath,
    args: [path.join(root, "bridge", "main.js")],
    cwd: path.join(root, "bridge"),
    webDistDir: path.join(root, "web"),
    electronRunAsNode: true,
  };
}

export function resolveBridgeLaunchPaths(
  input: ResolveBridgeLaunchPathsInput,
): BridgeLaunchPaths | null {
  const paths = input.isPackaged ? resolvePackagedPaths(input) : resolveDevPaths(input);
  const hasWebEntry = existsSync(path.join(paths.webDistDir, "index.html"));
  const entry = paths.args[0];
  if (!entry || !existsSync(entry) || !hasWebEntry) {
    return null;
  }
  return paths;
}

/** Ask the OS for a free loopback port, then close the probe socket. */
export function findAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate a loopback port"));
        return;
      }
      const { port } = address;
      // The probe socket is only used to let the OS pick a free port; a close
      // failure does not make that port unusable, so resolving is enough.
      server.close(() => resolve(port));
    });
  });
}

export interface StartBridgeSidecarInput {
  readonly paths: BridgeLaunchPaths;
  readonly daemonAddress: string;
  readonly neolixHome: string;
  readonly log: (line: string) => void;
  readonly env?: NodeJS.ProcessEnv;
  readonly healthTimeoutMs?: number;
  /** Test seam. */
  readonly spawnProcess?: typeof spawn;
}

export interface BridgeSidecar {
  readonly baseUrl: string;
  readonly port: number;
  stop(): Promise<void>;
}

function waitForBridge(input: {
  url: string;
  child: ChildProcess;
  timeoutMs: number;
  log: (line: string) => void;
}): Promise<void> {
  const deadline = Date.now() + input.timeoutMs;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve();
    };

    input.child.once("exit", (code, signal) => {
      finish(
        new Error(
          `Bridge exited before it was ready (code=${String(code)}, signal=${String(signal)})`,
        ),
      );
    });
    input.child.once("error", (error) => {
      finish(error instanceof Error ? error : new Error(String(error)));
    });

    const attempt = (): void => {
      if (settled) return;
      if (Date.now() > deadline) {
        finish(new Error("Timed out waiting for the desktop web bridge"));
        return;
      }
      const request = http.get(input.url, { timeout: 1_000 }, (response) => {
        response.resume();
        if (response.statusCode !== undefined) {
          finish();
          return;
        }
        response.once("end", attempt);
      });
      request.once("timeout", () => {
        request.destroy();
        setTimeout(attempt, 250);
      });
      request.once("error", () => {
        request.destroy();
        setTimeout(attempt, 250);
      });
    };

    input.log(`waiting for the bridge at ${input.url}`);
    attempt();
  });
}

function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let settled = false;
    const killTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }, 3_000);
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      // oxlint-disable-next-line promise/no-multiple-resolved -- guarded by `settled`
      resolve();
    };
    child.once("exit", finish);
    child.kill("SIGTERM");
  });
}

/**
 * Start `apps/bridge/src/main.ts` as a child process. The bridge owns no
 * daemon; it is a client like any other and exits with this process.
 */
export async function startBridgeSidecar(input: StartBridgeSidecarInput): Promise<BridgeSidecar> {
  const port = await findAvailablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const spawnProcess = input.spawnProcess ?? spawn;
  const child = spawnProcess(input.paths.command, [...input.paths.args], {
    cwd: input.paths.cwd,
    env: {
      ...process.env,
      ...input.env,
      ...(input.paths.electronRunAsNode ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
      BRIDGE_HOST: "127.0.0.1",
      BRIDGE_PORT: String(port),
      NEOLIX_DAEMON: input.daemonAddress,
      NEOLIX_HOME: input.neolixHome,
      BRIDGE_WEB_DIST: input.paths.webDistDir,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    input.log(chunk.toString("utf8").trimEnd());
  });

  // Never leave the sidecar behind if Electron dies without running will-quit.
  process.once("exit", () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  });

  try {
    await waitForBridge({
      url: `${baseUrl}/`,
      child,
      timeoutMs: input.healthTimeoutMs ?? 30_000,
      log: input.log,
    });
  } catch (error) {
    await stopChild(child);
    throw error;
  }

  input.log(`desktop web bridge ready at ${baseUrl} (pid ${String(child.pid)})`);
  return {
    baseUrl,
    port,
    stop: () => stopChild(child),
  };
}
