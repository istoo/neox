import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  completeChatGptApiSignIn,
  loadOrCreateChatGptHostId,
  startChatGptApiSignIn,
  type ChatGptApiOptions,
} from "./chatgpt-api-signin.js";
import {
  completeCopilotSignIn,
  pollCopilotDeviceSignIn,
  startCopilotDeviceSignIn,
  type CopilotOptions,
} from "./copilot-signin.js";
import {
  completeGoogleSignIn,
  googleAppOf,
  startGoogleSignIn,
  type GoogleAgent,
  type GoogleOptions,
} from "./google-signin.js";
import { errorMessage, pkcePair, randomToken } from "./oauth.js";
import {
  isSubscriptionAgent,
  type SubscriptionAccount,
  type SubscriptionAgent,
} from "./subscription-store.js";

/**
 * A subscription sign-in under way, as myna's `SignInState`
 * (`provider/signin.go:57-94`). It never carries a token.
 *
 * One sign-in per agent at a time: starting another ends the older one
 * (`signin.go:295-304`). The account is written before the state reads
 * `done`, so the page that sees `done` finds the account listed.
 */
export interface SubscriptionSignInState {
  id: string;
  agent: SubscriptionAgent;
  /** The vendor's page to open, or the device page. */
  url: string;
  /** The code to type on a device page. */
  code?: string;
  state: "waiting" | "done" | "failed" | "canceled";
  /** The browser's callback can also be pasted here (a server, Docker). */
  pasteCallback?: boolean;
  /** Why the callback port couldn't be opened. */
  callbackBlocked?: "reserved" | "busy";
  callbackPort?: number;
  /** Where the account signs in, for Copilot's enterprise host. */
  site?: string;
  user?: string;
  plan?: string;
  /** The account was listed already: its sign-in was renewed. */
  again?: boolean;
  /** The proxy the sign-in, and then the account's requests, go through. */
  proxy?: string;
  error?: string;
}

export interface SubscriptionSignInDeps {
  gatewayDir: string;
  /** Stores the account; says whether one of that id was listed already. */
  saveAccount: (account: SubscriptionAccount) => Promise<{ again: boolean }>;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** How long a sign-in waits for the browser; myna's ten minutes. */
  timeoutMs?: number;
  /** False in tests: no loopback server, and the callback is pasted. */
  listen?: boolean;
  /** The least a device sign-in waits between polls; myna's one second. */
  devicePollFloorMs?: number;
}

export interface SubscriptionSignInStartInput {
  agent: SubscriptionAgent;
  /** Copilot's host: "" github.com, "<name>.ghe.com". */
  site?: string;
  /** The proxy to sign in through, kept as the account's; "" the daemon's. */
  proxy?: string;
  addedAt?: number;
}

export interface SubscriptionSignIn {
  state: SubscriptionSignInState;
  /** Resolves once the sign-in is over, done or not. */
  done: Promise<SubscriptionSignInState>;
  /** Finishes with the whole address the browser ended on. */
  callback(raw: string): Promise<void>;
  cancel(): void;
}

export interface SubscriptionSignInManager {
  start(input: SubscriptionSignInStartInput): Promise<SubscriptionSignIn>;
  status(id: string): SubscriptionSignInState | null;
  cancel(id: string): void;
  callback(id: string, raw: string): Promise<void>;
}

interface Flow {
  state: SubscriptionSignInState;
  done: Promise<SubscriptionSignInState>;
  finish(output: FinishOutput): void;
  onClose(close: () => void): void;
  /** Resolves a pasted callback's query, checked to be this sign-in's. */
  pasted(raw: string): Promise<void>;
}

type FinishOutput = Partial<SubscriptionSignInState> & Pick<SubscriptionSignInState, "state">;

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
/** OpenAI sends the browser back only to this port (myna's `signin.go:34-36`). */
const CHATGPT_CALLBACK_PORT = 1455;
/** Where a test's Google sign-in says its browser comes back to. */
const TEST_CALLBACK_PORT = 45454;

export function createSubscriptionSignInManager(
  deps: SubscriptionSignInDeps,
): SubscriptionSignInManager {
  const flows = new Map<string, Flow>();
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function start(input: SubscriptionSignInStartInput): Promise<SubscriptionSignIn> {
    if (!isSubscriptionAgent(input.agent)) {
      throw new Error(`Neox can't sign in to ${input.agent} accounts`);
    }
    // A newer sign-in replaces the older one for the same agent.
    for (const [id, flow] of flows) {
      if (flow.state.agent === input.agent) {
        flow.finish({ state: "canceled" });
        flows.delete(id);
      }
    }
    let flow: Flow;
    switch (input.agent) {
      case "chatgpt-api":
        flow = await startChatGptApiFlow(deps, input);
        break;
      case "copilot":
        flow = await startCopilotFlow(deps, input);
        break;
      case "gemini":
      case "antigravity":
        flow = await startGoogleFlow(deps, input, input.agent);
        break;
      case "factory":
        throw new Error(
          "Factory accounts are added by their API key: neox accounts add factory --key fk-…",
        );
    }
    flows.set(flow.state.id, flow);
    const timer = setTimeout(() => {
      flow.finish({ state: "failed", error: "the sign-in timed out; start it again" });
    }, timeoutMs);
    timer.unref?.();
    const current = flow;
    current.onClose(() => clearTimeout(timer));
    const done = current.done.finally(() => {
      // kept a while, so a page that polls after `done` still reads it
      const kept = setTimeout(() => flows.delete(current.state.id), 5 * 60_000);
      kept.unref?.();
    });
    return {
      state: current.state,
      done,
      callback: (raw) => submitCallback(current, raw),
      cancel: () => current.finish({ state: "canceled" }),
    };
  }

  async function submitCallback(flow: Flow, raw: string): Promise<void> {
    if (flow.state.pasteCallback !== true) {
      throw new Error("this sign-in can't be finished from a pasted address");
    }
    if (flow.state.state !== "waiting") {
      throw new Error("this sign-in is over; start it again");
    }
    await flow.pasted(raw);
  }

  return {
    start,
    status(id) {
      return flows.get(id)?.state ?? null;
    },
    cancel(id) {
      flows.get(id)?.finish({ state: "canceled" });
    },
    async callback(id, raw) {
      const flow = flows.get(id);
      if (flow === undefined) {
        throw new Error("no such sign-in");
      }
      await submitCallback(flow, raw);
    },
  };

  // ---- ChatGPT API -------------------------------------------------------

  async function startChatGptApiFlow(
    managerDeps: SubscriptionSignInDeps,
    input: SubscriptionSignInStartInput,
  ): Promise<Flow> {
    const hostId = await loadOrCreateChatGptHostId(managerDeps.gatewayDir);
    const pair = pkcePair();
    const state = randomToken(24);
    const nonce = randomToken(24);
    const listener = await openLoopback({
      port: CHATGPT_CALLBACK_PORT,
      path: "/auth/callback",
      enabled: managerDeps.listen !== false,
      testPort: CHATGPT_CALLBACK_PORT,
    });
    const redirectUri = listener.redirectUri;
    const authorize = startChatGptApiSignIn({
      redirectUri,
      hostId,
      state,
      verifier: pair.verifier,
      challenge: pair.challenge,
      nonce,
    });
    const flow = makeFlow({
      agent: "chatgpt-api",
      ...(input.proxy === undefined ? {} : { proxy: input.proxy }),
      url: authorize.url,
      pasteCallback: true,
      ...(listener.blocked === undefined ? {} : { callbackBlocked: listener.blocked }),
      callbackPort: portOf(redirectUri),
    });
    listener.closeOn(flow);
    const options: ChatGptApiOptions = {
      ...(managerDeps.fetchImpl === undefined ? {} : { fetchImpl: managerDeps.fetchImpl }),
      ...(input.proxy === undefined ? {} : { proxy: input.proxy }),
      ...(managerDeps.now === undefined ? {} : { now: managerDeps.now }),
    };
    const complete = async (code: string, clientId: string): Promise<void> => {
      const result = await completeChatGptApiSignIn({
        ...options,
        code,
        clientId,
        verifier: pair.verifier,
        redirectUri,
        nonce,
        hostId,
        ...(input.addedAt === undefined ? {} : { addedAt: input.addedAt }),
      });
      if ("error" in result) {
        flow.finish({ state: "failed", error: result.error });
        return;
      }
      await keep(flow, managerDeps, result.account);
    };
    flow.pasted = async (raw) => {
      const params = pastedParams(raw, redirectUri, state);
      const refusal = refusalOf(params);
      if (refusal !== null) {
        flow.finish({ state: "failed", error: refusal });
        return;
      }
      await complete(params.get("code") ?? "", params.get("client_id") ?? "");
    };
    listener.onCallback((params) => {
      const refusal = refusalOf(params);
      if (refusal !== null) {
        flow.finish({ state: "failed", error: refusal });
        return;
      }
      if (params.get("state") !== state || (params.get("code") ?? "") === "") {
        return;
      }
      void complete(params.get("code") ?? "", params.get("client_id") ?? "");
    });
    return flow;
  }

  // ---- Copilot -----------------------------------------------------------

  async function startCopilotFlow(
    managerDeps: SubscriptionSignInDeps,
    input: SubscriptionSignInStartInput,
  ): Promise<Flow> {
    const options: CopilotOptions = {
      ...(managerDeps.fetchImpl === undefined ? {} : { fetchImpl: managerDeps.fetchImpl }),
      ...(input.proxy === undefined ? {} : { proxy: input.proxy }),
      ...(managerDeps.now === undefined ? {} : { now: managerDeps.now }),
    };
    const host = input.site ?? "";
    const started = await startCopilotDeviceSignIn({ host, ...options });
    if ("error" in started) {
      const failed = makeFlow({
        agent: "copilot",
        url: "",
        site: host,
        ...(input.proxy === undefined ? {} : { proxy: input.proxy }),
      });
      failed.finish({ state: "failed", error: started.error });
      return failed;
    }
    const flow = makeFlow({
      agent: "copilot",
      ...(input.proxy === undefined ? {} : { proxy: input.proxy }),
      url: started.start.url,
      code: started.start.code,
      site: host,
    });
    flow.pasted = () =>
      Promise.reject(new Error("this sign-in can't be finished from a pasted address"));
    let intervalMs = Math.max(started.start.intervalMs, managerDeps.devicePollFloorMs ?? 1000);
    const deadline = Date.now() + Math.min(timeoutMs, started.start.expiresInMs);
    void (async () => {
      while (flow.state.state === "waiting" && Date.now() < deadline) {
        await sleep(intervalMs);
        if (flow.state.state !== "waiting") {
          return;
        }
        const poll = await pollCopilotDeviceSignIn({
          host,
          deviceCode: started.start.deviceCode,
          ...options,
        });
        if (poll.state === "waiting") {
          if (poll.intervalMs !== undefined) {
            intervalMs = poll.intervalMs;
          }
          continue;
        }
        if (poll.state === "error") {
          flow.finish({ state: "failed", error: poll.error });
          return;
        }
        const result = await completeCopilotSignIn({
          githubToken: poll.githubToken,
          host,
          ...options,
          ...(input.addedAt === undefined ? {} : { addedAt: input.addedAt }),
        });
        if ("error" in result) {
          flow.finish({ state: "failed", error: result.error });
          return;
        }
        await keep(flow, managerDeps, result.account);
        return;
      }
      if (flow.state.state === "waiting") {
        flow.finish({ state: "failed", error: "the code expired; start again" });
      }
    })();
    return flow;
  }

  // ---- Gemini CLI and Antigravity ---------------------------------------

  async function startGoogleFlow(
    managerDeps: SubscriptionSignInDeps,
    input: SubscriptionSignInStartInput,
    agent: GoogleAgent,
  ): Promise<Flow> {
    const app = googleAppOf(agent);
    const listener = await openLoopback({
      host: app.loopback,
      port: 0,
      path: app.callbackPath,
      enabled: managerDeps.listen !== false,
      testPort: TEST_CALLBACK_PORT,
    });
    const redirectUri = listener.redirectUri;
    const pair = pkcePair();
    const state = randomToken(24);
    const authorize = startGoogleSignIn({
      agent,
      redirectUri,
      state,
      verifier: pair.verifier,
      challenge: pair.challenge,
    });
    const flow = makeFlow({
      agent,
      ...(input.proxy === undefined ? {} : { proxy: input.proxy }),
      url: authorize.url,
      pasteCallback: true,
      callbackPort: portOf(redirectUri),
    });
    listener.closeOn(flow);
    const options: GoogleOptions = {
      ...(managerDeps.fetchImpl === undefined ? {} : { fetchImpl: managerDeps.fetchImpl }),
      ...(input.proxy === undefined ? {} : { proxy: input.proxy }),
      ...(managerDeps.now === undefined ? {} : { now: managerDeps.now }),
      onboardPollMs: 2000,
    };
    const complete = async (code: string): Promise<void> => {
      const result = await completeGoogleSignIn({
        ...options,
        agent,
        code,
        verifier: pair.verifier,
        redirectUri,
        ...(input.addedAt === undefined ? {} : { addedAt: input.addedAt }),
      });
      if ("error" in result) {
        flow.finish({ state: "failed", error: result.error });
        return;
      }
      await keep(flow, managerDeps, result.account);
    };
    flow.pasted = async (raw) => {
      const params = pastedParams(raw, redirectUri, state);
      const refusal = refusalOf(params);
      if (refusal !== null) {
        flow.finish({ state: "failed", error: refusal });
        return;
      }
      await complete(params.get("code") ?? "");
    };
    listener.onCallback((params) => {
      const refusal = refusalOf(params);
      if (refusal !== null) {
        flow.finish({ state: "failed", error: refusal });
        return;
      }
      if (params.get("state") !== state || (params.get("code") ?? "") === "") {
        return;
      }
      void complete(params.get("code") ?? "");
    });
    return flow;
  }

  async function keep(
    flow: Flow,
    managerDeps: SubscriptionSignInDeps,
    account: SubscriptionAccount,
  ): Promise<void> {
    try {
      const stored: SubscriptionAccount = {
        ...account,
        proxy: flow.state.proxy ?? account.proxy ?? null,
      };
      const saved = await managerDeps.saveAccount(stored);
      flow.finish({
        state: "done",
        user: stored.user,
        ...(stored.plan === null ? {} : { plan: stored.plan }),
        ...(saved.again ? { again: true } : {}),
      });
    } catch (error) {
      flow.finish({ state: "failed", error: errorMessage(error) });
    }
  }
}

/** A flow whose finish records the outcome once and lets its listener go. */
function makeFlow(
  seed: Pick<SubscriptionSignInState, "agent" | "url"> &
    Partial<
      Pick<
        SubscriptionSignInState,
        "code" | "pasteCallback" | "callbackBlocked" | "callbackPort" | "site" | "proxy"
      >
    >,
): Flow {
  let resolveDone: (state: SubscriptionSignInState) => void = () => undefined;
  const done = new Promise<SubscriptionSignInState>((resolve) => {
    resolveDone = resolve;
  });
  let closed = false;
  const closers: (() => void)[] = [];
  const state: SubscriptionSignInState = {
    id: randomToken(9),
    agent: seed.agent,
    url: seed.url,
    state: "waiting",
    ...(seed.code === undefined ? {} : { code: seed.code }),
    ...(seed.pasteCallback === undefined ? {} : { pasteCallback: seed.pasteCallback }),
    ...(seed.callbackBlocked === undefined ? {} : { callbackBlocked: seed.callbackBlocked }),
    ...(seed.callbackPort === undefined ? {} : { callbackPort: seed.callbackPort }),
    ...(seed.site === undefined || seed.site === "" ? {} : { site: seed.site }),
    ...(seed.proxy === undefined || seed.proxy === "" ? {} : { proxy: seed.proxy }),
  };
  const flow: Flow = {
    state,
    done,
    onClose(close) {
      closers.push(close);
    },
    finish(output) {
      if (state.state !== "waiting") {
        return;
      }
      Object.assign(state, output);
      if (!closed) {
        closed = true;
        for (const close of closers) {
          close();
        }
      }
      resolveDone(state);
    },
    pasted() {
      return Promise.reject(new Error("this sign-in can't be finished from a pasted address"));
    },
  };
  return flow;
}

interface LoopbackListener {
  redirectUri: string;
  blocked?: "reserved" | "busy";
  onCallback(next: (params: URLSearchParams) => void): void;
  closeOn(flow: Flow): void;
}

async function openLoopback(input: {
  port: number;
  path: string;
  host?: string;
  enabled: boolean;
  /** The port a test's address names when no server is opened. */
  testPort: number;
}): Promise<LoopbackListener> {
  const host = input.host ?? "127.0.0.1";
  let callback: (params: URLSearchParams) => void = () => undefined;
  let server: Server | null = null;
  let redirectUri: string;
  let blocked: "reserved" | "busy" | undefined;
  if (!input.enabled) {
    redirectUri = `http://${host}:${input.testPort}${input.path}`;
  } else {
    server = createServer((request, response) => {
      handleRequest(input.path, request, response, callback);
    });
    try {
      await listen(server, input.port, host);
      const address = server.address() as AddressInfo;
      redirectUri = `http://${host}:${address.port}${input.path}`;
    } catch (error) {
      server = null;
      const code = (error as NodeJS.ErrnoException).code;
      blocked = process.platform === "win32" && code === "EACCES" ? "reserved" : "busy";
      if (input.port === 0) {
        // A random port that can't be had is a real failure; only a fixed
        // one falls back to the pasted address.
        throw error;
      }
      redirectUri = `http://${host}:${input.port}${input.path}`;
    }
  }
  return {
    redirectUri,
    ...(blocked === undefined ? {} : { blocked }),
    onCallback(next) {
      callback = next;
    },
    closeOn(flow) {
      flow.onClose(() => {
        server?.close();
        server = null;
      });
    },
  };
}

function handleRequest(
  path: string,
  request: IncomingMessage,
  response: ServerResponse,
  callback: (params: URLSearchParams) => void,
): void {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (url.pathname !== path) {
    response.writeHead(404).end("Not found");
    return;
  }
  response
    .writeHead(200, { "content-type": "text/html; charset=utf-8" })
    .end(
      "<!doctype html><meta charset=utf-8><title>Neox</title><p>You can close this tab and return to Neox.",
    );
  callback(url.searchParams);
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

/** The query of the whole address the browser ended on, checked to be this sign-in's. */
function pastedParams(raw: string, redirectUri: string, state: string): URLSearchParams {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("paste the whole address the browser ended on, starting with http://");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("paste the whole address the browser ended on, starting with http://");
  }
  const want = new URL(redirectUri);
  const loopback = ["localhost", "127.0.0.1", "::1"];
  if (!loopback.includes(url.hostname.toLowerCase())) {
    throw new Error("that address isn't from this sign-in: paste the one its browser tab ended on");
  }
  // A browser writes the default port out or leaves it; both are the same URL.
  const samePort =
    url.port === want.port ||
    (url.port === "" && want.port === "") ||
    (url.port === "80" && want.port === "") ||
    (url.port === "" && want.port === "80");
  if (!samePort || url.pathname !== want.pathname) {
    throw new Error("that address isn't from this sign-in: paste the one its browser tab ended on");
  }
  if (url.searchParams.get("state") !== state) {
    throw new Error("that address isn't from this sign-in: paste the one its browser tab ended on");
  }
  return url.searchParams;
}

function refusalOf(params: URLSearchParams): string | null {
  const error = params.get("error");
  if (error === null) {
    return null;
  }
  return params.get("error_description") ?? error;
}

function portOf(redirectUri: string): number {
  try {
    return Number(new URL(redirectUri).port);
  } catch {
    return 0;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
