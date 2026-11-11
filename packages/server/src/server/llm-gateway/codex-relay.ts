import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { readCodexSignIn, type CodexDiscoveryOptions } from "./codex-user-data.js";

/**
 * Keeps Codex threads open once Neolix stops serving (myna's `codexrelay`,
 * `internal/codexrelay/relay.go:76-196`). A thread started while Neolix was
 * Codex's provider keeps the base URL it was started with; while Neolix is
 * gone a small relay holds that port and sends those turns on to the
 * ChatGPT backend with Codex's own sign-in. The next Neolix asks it to let
 * go (`/.neolix-codex-relay/leave`), and it leaves once the Codex processes
 * it was started for have ended and its streams have finished.
 */
export const RELAY_LEAVE_PATH = "/.neolix-codex-relay/leave";
export const RELAY_TOKEN_HEADER = "X-Neolix-Relay-Token";
const CODEX_PATH = "/backend-api/codex";
const CHATGPT_BASE = "https://chatgpt.com/backend-api/codex";

/**
 * Whether a request is Codex's own backend protocol, the address a Codex
 * thread keeps after it is started. A daemon that never answered one has no
 * thread to serve after it quits, so it leaves no relay (myna only leaves
 * one when Codex's config still points at its gateway,
 * `agent/codex.go:2428-2462`).
 */
export function isCodexGatewayRequest(url: string | undefined): boolean {
  if (url === undefined) {
    return false;
  }
  const path = url.split(/[?#]/u, 1)[0] ?? "";
  return path === CODEX_PATH || path.startsWith(`${CODEX_PATH}/`);
}

export interface CodexRelayState {
  pid: number;
  addr: string;
  token: string;
}

export interface CodexRelayOptions {
  /** `host:port` the gateway let go of. */
  addr: string;
  /** The Codex processes the relay is for; it ends with the last. */
  pids: readonly number[];
  statePath: string;
  /** Reads Codex's own sign-in; injected in tests. */
  signIn?: CodexDiscoveryOptions;
  readSignIn?: () => Promise<{ accessToken: string; accountId: string | null } | null>;
  fetchImpl?: typeof fetch;
  /** Whether a pid is running; injected in tests. */
  alive?: (pid: number) => boolean;
  /** How long to wait for the port; myna waits 60 s. */
  bindForMs?: number;
  watchEveryMs?: number;
  drainForMs?: number;
  /** The ChatGPT backend's base. */
  backendBase?: string;
}

export interface CodexRelayHandle {
  state: CodexRelayState;
  /** Resolves once the relay let go and its streams finished. */
  done: Promise<void>;
  /** The same as POSTing to the leave address with the token. */
  leave(): void;
}

export async function runCodexRelay(options: CodexRelayOptions): Promise<CodexRelayHandle> {
  const server = createServer();
  const listener = await bindFor(server, options.addr, options.bindForMs ?? 60_000);
  const bound = listener.address() as AddressInfo;
  const state: CodexRelayState = {
    pid: process.pid,
    addr: `${bound.address}:${bound.port}`,
    token: randomBytes(16).toString("hex"),
  };
  await writeState(options.statePath, state);
  const leave = makeLeave();
  server.on("request", (request, response) => {
    if (request.url === RELAY_LEAVE_PATH) {
      handleLeave(request, response, state.token, leave);
      return;
    }
    void forward(request, response, options).catch(() => {
      if (!response.headersSent) {
        response.writeHead(502, { "content-type": "application/json" });
      }
      response.end(JSON.stringify({ error: { message: "Neox's Codex relay could not forward" } }));
    });
  });
  const done = watch(options, leave.promise).then(async () => {
    server.close();
    await dropState(options.statePath, state.token);
    return undefined;
  });
  return { state, done, leave: leave.leave };
}

interface LeaveControl {
  promise: Promise<void>;
  leave(): void;
}

function makeLeave(): LeaveControl {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, leave: release };
}

function handleLeave(
  request: { method?: string; headers: Record<string, string | string[] | undefined> },
  response: { writeHead(code: number): void; end(): void },
  token: string,
  leave: LeaveControl,
): void {
  const given = request.headers[RELAY_TOKEN_HEADER.toLowerCase()];
  const authorized =
    request.method === "POST" &&
    request.headers.origin === undefined &&
    typeof given === "string" &&
    sameToken(given, token);
  if (!authorized) {
    response.writeHead(403);
    response.end();
    return;
  }
  response.writeHead(204);
  response.end();
  leave.leave();
}

function sameToken(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function watch(options: CodexRelayOptions, left: Promise<void>): Promise<void> {
  const alive = options.alive ?? defaultAlive;
  const every = options.watchEveryMs ?? 15_000;
  let leaving = false;
  const leavingDone = left.then(() => {
    leaving = true;
    return undefined;
  });
  for (;;) {
    await Promise.race([leavingDone, sleep(every)]);
    if (leaving || !options.pids.some((pid) => alive(pid))) {
      return;
    }
  }
}

function defaultAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function forward(
  request: import("node:http").IncomingMessage,
  response: import("node:http").ServerResponse,
  options: CodexRelayOptions,
): Promise<void> {
  if (!isLoopback(request.headers.host ?? "") || request.headers.origin !== undefined) {
    reply(response, 403, "Neox's Codex relay serves Codex on this computer only");
    return;
  }
  const path = request.url ?? "";
  if (!path.startsWith(`${CODEX_PATH}/`)) {
    reply(response, 503, "Neox isn't running; this thread's gateway is gone");
    return;
  }
  if (String(request.headers.upgrade ?? "").toLowerCase() === "websocket") {
    reply(response, 426, "Neox's Codex relay speaks HTTP");
    return;
  }
  const signIn = await readSignIn(options);
  if (signIn === null) {
    reply(response, 503, "Neox isn't running and Codex's own sign-in could not be read");
    return;
  }
  const body = await readBody(request);
  const headers: Record<string, string> = {
    authorization: `Bearer ${signIn.accessToken}`,
    ...(signIn.accountId === null ? {} : { "chatgpt-account-id": signIn.accountId }),
    "content-type": request.headers["content-type"] ?? "application/json",
  };
  const answer = await (options.fetchImpl ?? fetch)(
    `${options.backendBase ?? CHATGPT_BASE}${path.slice(CODEX_PATH.length)}`,
    {
      method: request.method ?? "POST",
      headers,
      ...(body === null ? {} : { body: new Uint8Array(body) }),
      signal: AbortSignal.timeout(30 * 60_000),
    },
  );
  response.writeHead(answer.status, {
    "content-type": answer.headers.get("content-type") ?? "application/json",
  });
  if (answer.body === null) {
    response.end();
    return;
  }
  const reader = answer.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    response.write(Buffer.from(value));
  }
  response.end();
}

async function readSignIn(
  options: CodexRelayOptions,
): Promise<{ accessToken: string; accountId: string | null } | null> {
  if (options.readSignIn !== undefined) {
    return options.readSignIn();
  }
  const signIn = await readCodexSignIn(options.signIn ?? {});
  return signIn.ok ? { accessToken: signIn.accessToken, accountId: signIn.accountId } : null;
}

function isLoopback(host: string): boolean {
  const name = host.replace(/:\d+$/, "").toLowerCase();
  return name === "127.0.0.1" || name === "localhost" || name === "[::1]";
}

function reply(
  response: import("node:http").ServerResponse,
  status: number,
  message: string,
): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: { message } }));
}

async function readBody(request: import("node:http").IncomingMessage): Promise<Buffer | null> {
  if (request.method === "GET" || request.method === "HEAD") {
    return null;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks);
}

function bindFor(server: Server, addr: string, waitMs: number): Promise<Server> {
  const host = addr.replace(/:\d+$/, "");
  const port = Number(addr.slice(addr.lastIndexOf(":") + 1));
  const end = Date.now() + waitMs;
  return new Promise<Server>((resolve, reject) => {
    const attempt = (): void => {
      server.once("error", (error: NodeJS.ErrnoException) => {
        if (Date.now() > end) {
          reject(error);
          return;
        }
        setTimeout(attempt, 200);
      });
      server.listen(port, host, () => resolve(server));
    };
    attempt();
  });
}

async function writeState(file: string, state: CodexRelayState): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(state), { mode: 0o600 });
  await rename(temp, file);
}

async function dropState(file: string, token: string): Promise<void> {
  const kept = await readState(file);
  if (kept?.token === token) {
    await unlink(file).catch(() => undefined);
  }
}

export async function readState(file: string): Promise<CodexRelayState | null> {
  try {
    const value: unknown = JSON.parse(await readFile(file, "utf8"));
    if (typeof value !== "object" || value === null) {
      return null;
    }
    const entry = value as Record<string, unknown>;
    if (
      typeof entry.pid !== "number" ||
      typeof entry.addr !== "string" ||
      typeof entry.token !== "string"
    ) {
      return null;
    }
    return { pid: entry.pid, addr: entry.addr, token: entry.token };
  } catch {
    return null;
  }
}

/** Tells a running relay to let go of the port; the next Neolix serves there. */
export async function leaveCodexRelay(
  file: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const state = await readState(file);
  if (state === null) {
    return false;
  }
  try {
    const answer = await fetchImpl(`http://${state.addr}${RELAY_LEAVE_PATH}`, {
      method: "POST",
      headers: { [RELAY_TOKEN_HEADER]: state.token },
      signal: AbortSignal.timeout(2_000),
    });
    return answer.status === 204;
  } catch {
    return false;
  }
}

/**
 * Starts the relay apart from this process, so it outlives it (myna's
 * `Start`, `relay.go:81-96`). The command line is the caller's, since only
 * the daemon knows how its own program is started.
 */
export interface CodexRelaySpawn {
  (
    program: string,
    args: readonly string[],
    options: { detached: true; stdio: "ignore" },
  ): {
    pid?: number;
    unref?: () => void;
    on?: (event: "error", listener: () => void) => void;
  };
}

export interface StartCodexRelayInput {
  addr: string;
  pids: readonly number[];
  statePath: string;
  /** The packaged CLI, `neolix`; null when this host has none. */
  program: string | null;
  spawn: CodexRelaySpawn;
}

/** Starts the `neolix codex-relay` process; its pid, or null when it could not start. */
export function startCodexRelay(input: StartCodexRelayInput): number | null {
  if (input.program === null || input.pids.length === 0) {
    return null;
  }
  try {
    const child = input.spawn(
      input.program,
      [
        "codex-relay",
        "--addr",
        input.addr,
        "--pids",
        input.pids.join(","),
        "--state",
        input.statePath,
      ],
      { detached: true, stdio: "ignore" },
    );
    child.unref?.();
    // A program not installed on this host fails asynchronously; the
    // daemon's exit must not turn that into a crash.
    child.on?.("error", () => undefined);
    return child.pid ?? null;
  } catch {
    // A host without the CLI keeps working; the threads it cannot serve
    // end with the daemon as they did before.
    return null;
  }
}

/**
 * The Codex processes a relay is for: `ps` rows whose command is Codex's
 * (`codex`, `codex exec`, the Codex app's helpers), never this one.
 */
export function codexProcessIds(rows: string): number[] {
  const ids: number[] = [];
  for (const row of rows.split("\n")) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(row);
    if (match === null) {
      continue;
    }
    const pid = Number(match[1]);
    const command = match[2] ?? "";
    if (!Number.isFinite(pid)) {
      continue;
    }
    if (command.includes("codex-relay")) {
      continue;
    }
    // A test runner's command line names the file it runs; that is not a
    // Codex process a relay is for.
    if (/\.(test|spec)\.[cm]?[jt]sx?/.test(command)) {
      continue;
    }
    if (/(^|\/| )codex( |$|-)/.test(command)) {
      ids.push(pid);
    }
  }
  return [...new Set(ids)];
}

export interface ShutdownRelayInput {
  addr: string;
  statePath: string;
  program: string | null;
  spawn: CodexRelaySpawn;
  /** Whether this daemon answered Codex's own backend; without it no relay. */
  servedCodex: boolean;
  /** Lists this host's processes, `ps -A -o pid=,command=`; injected in tests. */
  run: (program: string, args: readonly string[]) => Promise<string>;
}

/**
 * What the daemon does as it quits (myna's `agent/codex.go:2445-2467`):
 * with Codex still running, leave a relay on the port it is giving up so
 * those threads' turns reach ChatGPT instead of a closed port. myna leaves
 * one only after it took Codex's failover out of Codex's config
 * (`gui/app.go:435-448`); here the same fact is that a Codex thread asked
 * this daemon's gateway for its protocol. A daemon that never did (a test
 * daemon, or one only serving other agents) leaves no process behind.
 */
export async function startCodexRelayOnShutdown(input: ShutdownRelayInput): Promise<number | null> {
  if (!input.servedCodex) {
    return null;
  }
  let rows: string;
  try {
    rows = await input.run("ps", ["-A", "-o", "pid=,command="]);
  } catch {
    // A host without ps (Windows) keeps the daemon's old behaviour.
    return null;
  }
  return startCodexRelay({
    addr: input.addr,
    pids: codexProcessIds(rows),
    statePath: input.statePath,
    program: input.program,
    spawn: input.spawn,
  });
}
