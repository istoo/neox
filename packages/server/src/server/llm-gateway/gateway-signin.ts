import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import {
  beginCodexLogin,
  cancelCodexLogin,
  pollCodexLogin,
  saveCodexSignInTokens,
  type CodexLoginPoll,
} from "./codex-login.js";
import {
  completeCodexBrowserSignIn,
  startCodexBrowserSignIn,
  type CodexBrowserFlow,
} from "./codex-browser-signin.js";
import {
  createSubscriptionSignInManager,
  type SubscriptionSignInManager,
} from "./subscription-signin.js";
import {
  addSubscriptionAccount,
  isSubscriptionAgent,
  loadAnySubscriptionAccounts,
  saveSubscriptionAccounts,
  subscriptionAccountsFile,
  type SubscriptionAccount,
} from "./subscription-store.js";

/**
 * The gateway's sign-in flow, shaped as myna's (`internal/provider/signin.go`):
 * start, ask its state, cancel, or hand back a pasted callback URL. Codex's
 * ChatGPT sign-in is the device-code flow; other agents can plug their own
 * flows into the same states without another RPC family.
 */
export interface GatewaySignInState {
  id: string;
  agent: string;
  state: "installing" | "waiting" | "done" | "failed" | "canceled";
  url?: string;
  code?: string;
  pasteCallback?: boolean;
  instructions?: string;
  user?: string;
  plan?: string;
  error?: string;
  /** Where the account signs in, for Copilot's enterprise host. */
  site?: string;
  /** Why the callback port couldn't be opened: "reserved" or "busy". */
  callbackBlocked?: "reserved" | "busy";
  callbackPort?: number;
  /** The account was listed already: its sign-in was renewed. */
  again?: boolean;
}

export interface SignInContext {
  accountsFile: string;
  fetchImpl?: typeof fetch;
  /** False in tests: no loopback callback server, so the address is pasted. */
  listen?: boolean;
  /** The least a device sign-in waits between polls; 0 in tests. */
  devicePollFloorMs?: number;
}

const states = new Map<string, GatewaySignInState>();

/** Browser sign-ins under way: the flow, and what the callback made of it. */
interface BrowserLogin {
  flow: CodexBrowserFlow;
  result: CodexLoginPoll | null;
  /** What the page was told when the sign-in started. */
  state: GatewaySignInState;
}

const browserLogins = new Map<string, BrowserLogin>();

/** Which gateway directory a subscription sign-in belongs to, by id. */
const subscriptionIds = new Map<string, string>();
const managers = new Map<string, SubscriptionSignInManager>();

function subscriptionManagerFor(context: SignInContext): SubscriptionSignInManager {
  const gatewayDir = dirname(context.accountsFile);
  let manager = managers.get(gatewayDir);
  if (manager === undefined) {
    manager = createSubscriptionSignInManager({
      gatewayDir,
      saveAccount: (account) => saveSignedInSubscription(gatewayDir, account),
      ...(context.fetchImpl === undefined ? {} : { fetchImpl: context.fetchImpl }),
      ...(context.listen === undefined ? {} : { listen: context.listen }),
      ...(context.devicePollFloorMs === undefined
        ? {}
        : { devicePollFloorMs: context.devicePollFloorMs }),
    });
    managers.set(gatewayDir, manager);
  }
  return manager;
}

/** Keeps the account under its agent's store; `again` says it was listed. */
async function saveSignedInSubscription(
  gatewayDir: string,
  account: SubscriptionAccount,
): Promise<{ again: boolean }> {
  const file = subscriptionAccountsFile(gatewayDir, account.agent);
  const existing = await loadAnySubscriptionAccounts(file);
  const again = existing.some((entry) => entry.id === account.id);
  const kept = existing.filter((entry) => entry.agent !== account.agent);
  await saveSubscriptionAccounts(file, addSubscriptionAccount(kept, account));
  return { again };
}

export async function startGatewaySignIn(
  request: { agent: string; site?: string; proxy?: string; user?: string },
  context: SignInContext,
): Promise<GatewaySignInState> {
  if (isSubscriptionAgent(request.agent)) {
    const manager = subscriptionManagerFor(context);
    const flow = await manager.start({
      agent: request.agent,
      ...(request.site === undefined ? {} : { site: request.site }),
      ...(request.proxy === undefined || request.proxy === "" ? {} : { proxy: request.proxy }),
      addedAt: Date.now(),
    });
    subscriptionIds.set(flow.state.id, dirname(context.accountsFile));
    return flow.state;
  }
  if (request.agent !== "codex") {
    return {
      id: "",
      agent: request.agent,
      state: "failed",
      error: `Signing in ${request.agent} is not supported here yet`,
    };
  }
  if (request.site !== "device") {
    return startCodexBrowser(context);
  }
  const started = await beginCodexLogin({ fetchImpl: context.fetchImpl });
  if ("error" in started) {
    return { id: "", agent: request.agent, state: "failed", error: started.error };
  }
  const state: GatewaySignInState = {
    id: started.start.loginId,
    agent: "codex",
    state: "waiting",
    url: started.start.url,
    code: started.start.userCode,
    pasteCallback: false,
    instructions: "Enter the code on the page, then ask again",
  };
  states.set(state.id, state);
  return state;
}

/** Codex's browser sign-in (myna's default); "device" is the other way in. */
async function startCodexBrowser(context: SignInContext): Promise<GatewaySignInState> {
  const opened = await startCodexBrowserSignIn({
    ...(context.fetchImpl === undefined ? {} : { fetchImpl: context.fetchImpl }),
    ...(context.listen === undefined ? {} : { listen: context.listen }),
  });
  if ("error" in opened) {
    return { id: "", agent: "codex", state: "failed", error: opened.error };
  }
  const { flow } = opened;
  const loginId = randomUUID();
  const state: GatewaySignInState = {
    id: loginId,
    agent: "codex",
    state: "waiting",
    url: flow.url,
    pasteCallback: true,
    callbackPort: Number(new URL(flow.redirectUri).port),
    ...(flow.blocked === undefined ? {} : { callbackBlocked: flow.blocked }),
    instructions:
      flow.blocked === undefined
        ? "Finish in the browser; the account shows up here as soon as you're done"
        : "Paste the address the browser ends on; this computer can't take the callback",
  };
  const login: BrowserLogin = { flow, result: null, state };
  browserLogins.set(loginId, login);
  void settleBrowserCallback(loginId, context, flow.callback);
  return state;
}

/**
 * Waits for the browser's callback and finishes the sign-in. A failure is
 * shown on the login state instead of escaping as an unhandled rejection:
 * saving the account can fail, and that must not take the daemon down.
 */
export async function settleBrowserCallback(
  loginId: string,
  context: SignInContext,
  callback: Promise<URLSearchParams>,
): Promise<void> {
  try {
    const params = await callback;
    await finishCodexBrowser(loginId, context, `?${params.toString()}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const login = browserLogins.get(loginId);
    if (login !== undefined) {
      login.result = { state: "error", error: message };
      login.flow.close();
    }
    console.error(`Gateway sign-in ${loginId} failed: ${message}`);
  }
}

/** Exchanges the callback once; the account is saved before the state says done. */
async function finishCodexBrowser(
  loginId: string,
  context: SignInContext,
  raw: string,
): Promise<void> {
  const login = browserLogins.get(loginId);
  if (login === undefined || login.result !== null) {
    return;
  }
  const options = context.fetchImpl === undefined ? {} : { fetchImpl: context.fetchImpl };
  const poll = await completeCodexBrowserSignIn(login.flow, raw, options);
  if (poll.state === "done") {
    login.result = await saveCodexSignInTokens(poll.tokens, context.accountsFile);
  } else if (poll.state === "error") {
    login.result = { state: "error", error: poll.error };
  } else {
    login.result = { state: "waiting" };
  }
  login.flow.close();
}

function stateOfBrowserLogin(id: string, login: BrowserLogin): GatewaySignInState {
  const result = login.result;
  if (result === null || result.state === "waiting") {
    return login.state;
  }
  if (result.state === "error") {
    return { ...login.state, id, state: "failed", error: result.error };
  }
  return {
    ...login.state,
    id,
    state: "done",
    user: result.account?.label,
    plan: result.account?.plan ?? undefined,
  };
}

/** Asks once whether the sign-in is done; a done one is saved and forgotten. */
export async function statusGatewaySignIn(
  id: string,
  context: SignInContext,
): Promise<GatewaySignInState> {
  const subscriptionDir = subscriptionIds.get(id);
  if (subscriptionDir !== undefined) {
    const state = managers.get(subscriptionDir)?.status(id);
    if (state === null || state === undefined) {
      subscriptionIds.delete(id);
      return { id, agent: "", state: "failed", error: "This sign-in is no longer waiting" };
    }
    return state;
  }
  const browserLogin = browserLogins.get(id);
  if (browserLogin !== undefined) {
    const browserState = stateOfBrowserLogin(id, browserLogin);
    if (browserState.state !== "waiting") {
      browserLogins.delete(id);
    }
    return browserState;
  }
  const kept = states.get(id);
  if (kept === undefined) {
    return { id, agent: "", state: "failed", error: "This sign-in is no longer waiting" };
  }
  if (kept.agent !== "codex") {
    return kept;
  }
  const poll = await pollCodexLogin(id, context.accountsFile, {
    fetchImpl: context.fetchImpl,
  });
  if (poll.state === "waiting") {
    return kept;
  }
  states.delete(id);
  if (poll.state === "error") {
    return { ...kept, state: "failed", error: poll.error };
  }
  return {
    ...kept,
    state: "done",
    user: poll.account?.label,
    plan: poll.account?.plan ?? undefined,
  };
}

/** Stops a waiting sign-in. */
export function cancelGatewaySignIn(id: string): boolean {
  const subscriptionDir = subscriptionIds.get(id);
  if (subscriptionDir !== undefined) {
    const manager = managers.get(subscriptionDir);
    const state = manager?.status(id);
    if (state === undefined || state === null) {
      subscriptionIds.delete(id);
      return false;
    }
    if (state.state !== "waiting") {
      return false;
    }
    manager?.cancel(id);
    return true;
  }
  const browserLogin = browserLogins.get(id);
  if (browserLogin !== undefined) {
    browserLogins.delete(id);
    browserLogin.flow.close();
    return true;
  }
  const kept = states.get(id);
  states.delete(id);
  if (kept?.agent === "codex") {
    cancelCodexLogin(id);
  }
  return kept !== undefined;
}

/**
 * A pasted browser callback (myna's `signin.go:673`: the address the
 * browser ended on finishes the sign-in). Codex's device-code sign-in has
 * none, so it says why rather than pretending it worked.
 */
export async function callbackGatewaySignIn(
  id: string,
  url: string,
  context: SignInContext,
): Promise<{ ok: boolean; error?: string }> {
  const subscriptionDir = subscriptionIds.get(id);
  if (subscriptionDir !== undefined) {
    const manager = managers.get(subscriptionDir);
    if (manager === undefined) {
      return { ok: false, error: "This sign-in is no longer waiting" };
    }
    try {
      await manager.callback(id, url);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
  const browserLogin = browserLogins.get(id);
  if (browserLogin !== undefined) {
    if (url.trim().length === 0) {
      return { ok: false, error: "Paste the address the browser ended on" };
    }
    await finishCodexBrowser(id, context, url);
    const state = stateOfBrowserLogin(id, browserLogin);
    // The state stays until the page reads it, as the device flow's does.
    return state.state === "done" ? { ok: true } : { ok: false, error: state.error };
  }
  const kept = states.get(id);
  if (kept === undefined) {
    return { ok: false, error: "This sign-in is no longer waiting" };
  }
  if (url.trim().length === 0) {
    return { ok: false, error: "Paste the address the browser ended on" };
  }
  return { ok: false, error: "This sign-in asks for a code on the page, not a callback address" };
}

/** Forgets every sign-in; tests use it between cases. */
export function clearGatewaySignIns(): void {
  for (const [id, gatewayDir] of subscriptionIds) {
    managers.get(gatewayDir)?.cancel(id);
  }
  subscriptionIds.clear();
  managers.clear();
  states.clear();
  for (const login of browserLogins.values()) {
    login.flow.close();
  }
  browserLogins.clear();
}
