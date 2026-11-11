import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Logger } from "pino";
import { resolveNeolixHome } from "@neolix/server/daemon-control";
import {
  accountDiscoveryOn,
  GatewayConfigStore,
  type GatewayConfig,
} from "@neolix/server/gateway-config";
import {
  addFactoryKey,
  addSubscriptionAccount,
  claudeAccountsFile,
  clearSignInReturn,
  importGoogleAccounts,
  isSubscriptionAgent,
  loadAnySubscriptionAccounts,
  loadClaudeAccounts,
  loadSubscriptionAccounts,
  nextInOrder,
  parseClaudeImport,
  readClaudeSignIn,
  readCodexPool,
  refreshChatGptApiAccount,
  spentShareOf,
  refreshGoogleAccount,
  saveClaudeAccounts,
  saveSubscriptionAccounts,
  subscriptionAccountsFile,
  updateSubscriptionAccount,
  upsertClaudeAccounts,
  writeClaudeSignIn,
  writeCodexSignIn,
  type ClaudeAccount,
  type ClaudeOptions,
  type CodexOwnedAccount,
  type SignInCaps,
  type SignInWindow,
  type ImportedSubscriptionAccount,
  type SubscriptionAccount,
  type SubscriptionAgent,
} from "@neolix/server/gateway-accounts";

/**
 * `neolix accounts`: the subscriptions Neolix signed in to itself
 * (`internal/cli/accounts_cli.go`). The stores are the ones the daemon
 * reads, under `$NEOLIX_HOME/gateway/`, so a change here is taken by the
 * gateway without a daemon restart.
 */

/** The order myna lists agents in. */
export const SUBSCRIPTION_AGENTS: readonly SubscriptionAgent[] = [
  "chatgpt-api",
  "copilot",
  "gemini",
  "antigravity",
  "factory",
];

export interface AccountsOptions {
  home?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  proxy?: string;
  /** Overridable so a test never reaches the vendors. */
  issuer?: string;
  googleTokenUrl?: string;
  /** Codex's own sign-in: the home it is read from and written to, and the keychain, injected by tests. */
  homeDir?: string;
  codexHome?: string;
  env?: NodeJS.ProcessEnv;
  writeKeychain?: (storeKey: string, secret: string) => Promise<void>;
  /** Claude Code's own files and keychain, injected by tests. */
  credentialsPath?: string;
  profilePath?: string;
  readClaudeKeychain?: (service: string) => Promise<string | null>;
  writeClaudeKeychain?: (service: string, secret: string) => Promise<void>;
  /**
   * An account's windows, as the daemon's usage sources read them; used by
   * `accounts switch <agent> next` to pick the one with room.
   */
  usageWindows?: (
    agent: "codex" | "claude",
    account: { id: string; user: string },
  ) => Promise<readonly SignInWindow[] | undefined> | readonly SignInWindow[] | undefined;
}

export interface AccountRow {
  agent: SubscriptionAgent | "claude";
  user: string;
  alias?: string;
  plan?: string;
  host?: string;
  project?: string;
  lapsed?: string;
  addedAt: number;
}

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child: () => silentLogger,
} as unknown as Logger;

function neolixHome(options: AccountsOptions): string {
  return resolveNeolixHome({
    NEOLIX_HOME: options.home ?? process.env.NEOLIX_HOME,
  } as NodeJS.ProcessEnv);
}

export function gatewayDirOf(options: AccountsOptions): string {
  return join(neolixHome(options), "gateway");
}

/** The agent a name on the command line means, as myna's `agentID`. */
export function parseAccountAgent(name: string): SubscriptionAgent {
  switch (name.trim().toLowerCase()) {
    case "chatgpt":
    case "bbinbtl":
    case "chatgpt-api":
      return "chatgpt-api";
    case "copilot":
      return "copilot";
    case "gemini":
    case "gemini-cli":
      return "gemini";
    case "antigravity":
    case "ag":
      return "antigravity";
    case "factory":
    case "droid":
      return "factory";
  }
  throw new Error(
    `"${name}": only ChatGPT API, Copilot, Gemini CLI, Antigravity and Factory accounts are Neox's own — neox accounts lists them`,
  );
}

/** An account by its user, the id it was stored under, or the name the user gave it. */
function accountNamed<A extends SubscriptionAccount>(accounts: readonly A[], ref: string): A {
  const wanted = ref.trim().toLowerCase();
  const found = accounts.find(
    (account) =>
      account.id.toLowerCase() === wanted ||
      account.user.trim().toLowerCase() === wanted ||
      (account.alias ?? "").trim().toLowerCase() === wanted,
  );
  if (found === undefined) {
    throw new Error(`no account "${ref}" — neox accounts lists them`);
  }
  return found;
}

/** Every account Neolix keeps, one agent's or all of them. */
export async function listAccounts(
  options: AccountsOptions,
  agent?: SubscriptionAgent | "claude",
): Promise<AccountRow[]> {
  const dir = gatewayDirOf(options);
  const rows: AccountRow[] = [];
  if (agent === undefined || agent === "claude") {
    for (const account of await loadClaudeAccounts(claudeAccountsFile(dir))) {
      rows.push({
        agent: "claude",
        user: account.user,
        addedAt: account.addedAt,
        ...(account.alias === undefined ? {} : { alias: account.alias }),
        ...(account.plan === null ? {} : { plan: account.plan }),
        ...(account.lapsed === null ? {} : { lapsed: account.lapsed }),
      });
    }
  }
  if (agent === "claude") {
    return rows;
  }
  for (const current of agent === undefined ? SUBSCRIPTION_AGENTS : [agent]) {
    const accounts = await loadSubscriptionAccounts(
      subscriptionAccountsFile(dir, current),
      current,
    );
    for (const account of accounts) {
      rows.push(accountRowOf(account));
    }
  }
  return rows;
}

/** One account as the page shows it: its name, plan and what it bills. */
export interface AccountRowFields {
  agent: SubscriptionAgent | "claude";
  user: string;
  alias?: string;
  plan: string | null;
  addedAt: number;
  host?: string;
  project?: string | null;
  lapsed: string | null;
}

export function accountRowOf(account: AccountRowFields): AccountRow {
  const row: AccountRow = {
    agent: account.agent,
    user: account.user,
    addedAt: account.addedAt,
  };
  if (account.alias !== undefined && account.alias !== "") {
    row.alias = account.alias;
  }
  if (account.plan !== null) {
    row.plan = account.plan;
  }
  if (account.agent === "copilot" && account.host !== undefined && account.host !== "") {
    row.host = account.host;
  }
  if (
    (account.agent === "gemini" || account.agent === "antigravity") &&
    account.project !== undefined &&
    account.project !== null
  ) {
    row.project = account.project;
  }
  if (account.lapsed !== null) {
    row.lapsed = account.lapsed;
  }
  return row;
}

/** `neolix accounts alias <agent> <email|alias> [name|--clear]`. */
export async function aliasAccount(
  options: AccountsOptions,
  agent: SubscriptionAgent,
  ref: string,
  name: string | undefined,
): Promise<{ user: string; alias: string }> {
  const dir = gatewayDirOf(options);
  const file = subscriptionAccountsFile(dir, agent);
  const all = await loadAnySubscriptionAccounts(file);
  const account = accountNamed(
    all.filter(
      (entry): entry is Extract<SubscriptionAccount, { agent: typeof agent }> =>
        entry.agent === agent,
    ),
    ref,
  );
  const alias = (name ?? "").trim() === "--clear" ? "" : (name ?? "").trim();
  const next = updateSubscriptionAccount(all, account.id, (current) => {
    const changed = { ...current } as typeof current;
    if (alias === "") {
      delete changed.alias;
    } else {
      changed.alias = alias;
    }
    return changed;
  });
  await saveSubscriptionAccounts(file, next);
  return { user: account.user, alias };
}

/** `neolix accounts project <gemini|antigravity> <email> <project>`; "" clears it. */
export async function setAccountProject(
  options: AccountsOptions,
  agent: SubscriptionAgent,
  ref: string,
  project: string,
): Promise<{ user: string; project: string }> {
  if (agent !== "gemini" && agent !== "antigravity") {
    throw new Error(`only Gemini CLI and Antigravity accounts name a Google Cloud project`);
  }
  const dir = gatewayDirOf(options);
  const file = subscriptionAccountsFile(dir, agent);
  const all = await loadAnySubscriptionAccounts(file);
  const account = accountNamed(
    all.filter(
      (entry): entry is Extract<SubscriptionAccount, { agent: "gemini" | "antigravity" }> =>
        entry.agent === agent,
    ),
    ref,
  );
  const value = project.trim();
  const next = updateSubscriptionAccount(all, account.id, (current) =>
    current.agent === "gemini" || current.agent === "antigravity"
      ? { ...current, project: value === "" ? null : value }
      : current,
  );
  await saveSubscriptionAccounts(file, next);
  return { user: account.user, project: value };
}

export interface RefreshedAccount {
  agent: SubscriptionAgent;
  user: string;
  /** True when a token was traded for a new one. */
  refreshed: boolean;
  error?: string;
}

/**
 * Renews every account whose access token is near expiring, as myna's
 * `accounts refresh` does. A Copilot account keeps its GitHub sign-in, which
 * has nothing to renew.
 */
export async function refreshAccounts(options: AccountsOptions): Promise<RefreshedAccount[]> {
  const dir = gatewayDirOf(options);
  const out: RefreshedAccount[] = [];
  // Gemini CLI's and Antigravity's accounts share one file: it is read and
  // written whole, so one agent's refresh never drops the other's.
  const stores: { file: string; agents: readonly SubscriptionAgent[] }[] = [
    { file: subscriptionAccountsFile(dir, "chatgpt-api"), agents: ["chatgpt-api"] },
    { file: subscriptionAccountsFile(dir, "copilot"), agents: ["copilot"] },
    { file: subscriptionAccountsFile(dir, "gemini"), agents: ["gemini", "antigravity"] },
  ];
  for (const { file, agents } of stores) {
    const all = await loadAnySubscriptionAccounts(file);
    const accounts = all.filter((account) => agents.includes(account.agent));
    if (accounts.length === 0) {
      continue;
    }
    let next: SubscriptionAccount[] = [...all];
    for (const account of accounts) {
      const agent = account.agent;
      if (agent === "copilot") {
        out.push({ agent, user: account.user, refreshed: false });
        continue;
      }
      // Factory's key is never renewed.
      if (agent === "factory") {
        out.push({ agent, user: account.user, refreshed: false });
        continue;
      }
      const refreshed =
        account.agent === "chatgpt-api"
          ? await refreshChatGptApiAccount(account, {
              ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
              ...(options.now === undefined ? {} : { now: options.now }),
              ...(options.proxy === undefined ? {} : { proxy: options.proxy }),
              ...(options.issuer === undefined ? {} : { issuer: options.issuer }),
            })
          : await refreshGoogleAccount(account, {
              ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
              ...(options.now === undefined ? {} : { now: options.now }),
              ...(options.proxy === undefined ? {} : { proxy: options.proxy }),
              ...(options.googleTokenUrl === undefined ? {} : { tokenUrl: options.googleTokenUrl }),
            });
      if ("error" in refreshed) {
        out.push({
          agent,
          user: account.user,
          refreshed: false,
          error: refreshed.error,
        });
        if (refreshed.lapsed !== undefined) {
          next = updateSubscriptionAccount(next, account.id, (current) => ({
            ...current,
            lapsed: refreshed.lapsed ?? current.lapsed,
          }));
        }
        continue;
      }
      out.push({
        agent,
        user: account.user,
        refreshed: refreshed.refreshed,
      });
      if (refreshed.refreshed) {
        next = updateSubscriptionAccount(
          next,
          account.id,
          () => refreshed.account as SubscriptionAccount,
        );
      }
    }
    if (next.some((account, index) => account !== all[index])) {
      await saveSubscriptionAccounts(file, next);
    }
  }
  return out.sort(
    (a, b) => SUBSCRIPTION_AGENTS.indexOf(a.agent) - SUBSCRIPTION_AGENTS.indexOf(b.agent),
  );
}

/** `neolix accounts import antigravity <file>…`: only Antigravity exports are read today. */
export async function importAccounts(
  options: AccountsOptions,
  agent: SubscriptionAgent,
  texts: readonly string[],
): Promise<ImportedSubscriptionAccount[]> {
  if (agent !== "antigravity") {
    throw new Error(
      `importing ${agent} accounts isn't in Neox's CLI yet; only Antigravity's export is read (neox accounts import antigravity <file>…)`,
    );
  }
  return importGoogleAccounts({
    gatewayDir: gatewayDirOf(options),
    texts,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.proxy === undefined ? {} : { proxy: options.proxy }),
  });
}

/**
 * `neolix accounts add factory --key fk-…` (myna's `accounts add factory`
 * kept the key as an account of Factory's plugin). `whoami` checks the key
 * and names whose it is before anything is stored.
 */
export async function addFactoryAccount(
  options: AccountsOptions,
  key: string,
): Promise<{ user: string }> {
  const added = await addFactoryKey(key, {
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  if ("error" in added) {
    throw new Error(added.error);
  }
  const file = subscriptionAccountsFile(gatewayDirOf(options), "factory");
  const all = await loadAnySubscriptionAccounts(file);
  await saveSubscriptionAccounts(file, addSubscriptionAccount(all, added.account));
  return { user: added.account.user };
}

async function withConfig<T>(
  options: AccountsOptions,
  work: (store: GatewayConfigStore) => Promise<T>,
): Promise<T> {
  const store = new GatewayConfigStore({ neolixHome: neolixHome(options), logger: silentLogger });
  await store.start();
  try {
    return await work(store);
  } finally {
    store.dispose();
  }
}

/** Whether Neolix reads the agents' own sign-ins (`settings.Discovery`). */
export async function getDiscovery(options: AccountsOptions): Promise<boolean> {
  return withConfig(options, async (store) => accountDiscoveryOn(store.get()));
}

/** `neolix accounts discovery [on|off]`; writes the general key codexAccountDiscovery was replaced by. */
export async function setDiscovery(options: AccountsOptions, on: boolean): Promise<boolean> {
  return withConfig(options, async (store) => {
    const config = store.get();
    const saved = await store.write({ ...config, accountDiscovery: on });
    return accountDiscoveryOn(saved);
  });
}

/**
 * `neolix accounts switch <agent> <email|alias|next>`: the gateway accounts
 * that spend this agent's sign-ins point at the chosen one. The sign-in the
 * agent itself keeps is Neolix's gateway's to pick, not a vendor file's.
 */
export interface SwitchedAccount {
  agent: SubscriptionAgent | "codex" | "claude";
  user: string;
  /** Where a Codex switch was written: Codex's own auth.json or keychain. */
  store?: "file" | "keychain";
  /** True when every other account is past its line and this one has the most room. */
  over?: boolean;
}

/**
 * `neolix accounts switch <agent> <email|alias|next>`, as myna's
 * `SwitchLogin` (`provider/logins.go:1211-1257`). A subscription Neolix
 * signed in itself moves to the front of its store, the account its
 * providers serve first. Codex's own sign-in is written into Codex's store
 * (`~/.codex/auth.json` or its keychain item), when write-back is on. A
 * saved Claude sign-in is written into Claude Code's store only when
 * `claudeSignInWriteBack` is on; until then the switch is refused and
 * nothing of Claude Code's is touched.
 */
export async function switchAccount(
  options: AccountsOptions,
  agent: SubscriptionAgent | "codex" | "claude",
  ref: string,
): Promise<SwitchedAccount> {
  const discovery = await getDiscovery(options);
  if (!discovery) {
    throw new Error(
      "reading the agents' own sign-ins is off — turn Subscription accounts back on under Settings › Privacy",
    );
  }
  if (agent === "codex") {
    return switchCodexAccount(options, ref);
  }
  if (agent === "claude") {
    return switchClaudeAccount(options, ref);
  }
  const dir = gatewayDirOf(options);
  const file = subscriptionAccountsFile(dir, agent);
  const accounts = await loadSubscriptionAccounts(file, agent);
  if (accounts.length === 0) {
    throw new Error(`no ${agent} accounts yet — neox accounts add ${agent}`);
  }
  const target =
    ref.trim().toLowerCase() === "next"
      ? accounts[1 % accounts.length]
      : accountNamed(accounts, ref);
  if (target === undefined) {
    throw new Error(`no ${agent} accounts to switch to`);
  }
  // myna's `First`: the account the providers serve first. The store's
  // order is that order, so the chosen one moves to the front.
  const rest = accounts.filter((account) => account.id !== target.id);
  await saveSubscriptionAccounts(file, [target, ...rest]);
  return { agent, user: target.user };
}

/** One account as `nextInOrder` reads it, with the name its usage is matched by. */
interface NextSignInAccount {
  id: string;
  user: string;
  enabled: boolean;
  lapsed: string | null;
  home: string;
}

/** The caps of the gateway account that spends a saved sign-in. */
function capsOfFrom(config: GatewayConfig, id: string, user: string): SignInCaps | undefined {
  for (const provider of config.providers) {
    const account =
      provider.accounts.find((entry) => entry.codexAccountId === id) ??
      provider.accounts.find(
        (entry) =>
          entry.agent === "claude-code" &&
          (entry.subscriptionUser ?? "").toLowerCase() === user.toLowerCase(),
      );
    if (account !== undefined) {
      return { all: account.capPercent, windows: account.capWindows };
    }
  }
  return undefined;
}

/**
 * myna's NextInOrder for `accounts switch <agent> next`: the first
 * switchable account after the one signed in to, with room, or the one
 * with the most room left when every one is past its line. The usage
 * sources are the daemon's; without a daemon no allowance is known, and
 * myna asks for the account by name.
 */
async function nextSignInAccount(input: {
  agent: "codex" | "claude";
  accounts: readonly NextSignInAccount[];
  activeId: string | null;
  config: GatewayConfig;
  options: AccountsOptions;
}): Promise<{ to: string; over: boolean }> {
  const windows = new Map<string, readonly SignInWindow[] | undefined>();
  for (const account of input.accounts) {
    try {
      windows.set(
        account.id,
        await input.options.usageWindows?.(input.agent, { id: account.id, user: account.user }),
      );
    } catch {
      windows.set(account.id, undefined);
    }
  }
  const provider = input.config.providers.find((entry) => entry.id === input.agent);
  const result = nextInOrder({
    accounts: input.accounts,
    activeId: input.activeId,
    share: spentShareOf(provider?.routing),
    windowsOf: (id) => windows.get(id),
    capsOf: (id) =>
      capsOfFrom(input.config, id, input.accounts.find((account) => account.id === id)?.user ?? ""),
    now: Date.now(),
  });
  if (result.status === "none") {
    throw new Error(`${input.agent} has no other account in Neox to switch to`);
  }
  if (result.status === "unread") {
    throw new Error(
      `Neox has no reading of ${input.agent}'s other accounts' usage: name the one to switch to (neox accounts switch ${input.agent} <email>)`,
    );
  }
  return { to: result.to, over: result.over };
}

/** Codex's own sign-in, written where Codex keeps it (myna's `saveCodexLogin`). */
async function switchCodexAccount(options: AccountsOptions, ref: string): Promise<SwitchedAccount> {
  const config = await withConfig(options, async (store) => store.get());
  if (config.codexSignInWriteBack === false) {
    throw new Error(
      "writing Codex's own sign-in back is off — turn it on under Providers › Codex, or use neox provider",
    );
  }
  const dir = gatewayDirOf(options);
  const snapshot = await readCodexPool({
    config,
    gatewayDir: dir,
    now: Date.now(),
    ...(options.homeDir === undefined ? {} : { homeDir: options.homeDir }),
    ...(options.codexHome === undefined ? {} : { codexHome: options.codexHome }),
    ...(options.env === undefined ? {} : { env: options.env }),
  });
  const accounts = snapshot.pool;
  if (accounts.length === 0) {
    throw new Error("no ChatGPT accounts Neox signed in — neox accounts add chatgpt");
  }
  const next = ref.trim().toLowerCase() === "next";
  const picked = next
    ? await nextSignInAccount({
        agent: "codex",
        accounts: accounts.map((account) => ({
          id: account.id,
          user: account.label,
          enabled: account.disabled !== true,
          lapsed: null,
          home: account.home ?? "",
        })),
        activeId: snapshot.activeId,
        config,
        options,
      })
    : undefined;
  const target = next
    ? accounts.find((account) => account.id === picked?.to)
    : codexAccountNamed(accounts, ref);
  if (target === undefined) {
    throw new Error("no ChatGPT account to switch to");
  }
  // myna's `codexHeldIn` (`provider/logins.go:812-824`): a sign-in imported
  // from one of the user's other Codex folders is that Codex's while it is
  // still there, and two holders of one refresh token sign each other out.
  const heldIn = target.home;
  if (
    heldIn !== undefined &&
    heldIn !== "" &&
    heldIn !== codexHomeOf(options) &&
    codexHomeHolds(target, heldIn)
  ) {
    throw new Error(
      `${target.label} is signed in to Codex in ${heldIn}: run Codex there (CODEX_HOME=${heldIn} codex) to use it, or turn it on for Neox's requests`,
    );
  }
  const written = await writeCodexSignIn({
    accessToken: target.accessToken,
    refreshToken: target.refreshToken,
    idToken: target.idToken,
    accountId: target.accountId,
    discovery: true,
    ...(options.homeDir === undefined ? {} : { homeDir: options.homeDir }),
    ...(options.codexHome === undefined ? {} : { codexHome: options.codexHome }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.writeKeychain === undefined ? {} : { writeKeychain: options.writeKeychain }),
  });
  if ("error" in written) {
    throw new Error(written.error);
  }
  // The user's own choice: myna doesn't sign Codex back to the account it
  // moved it off (`SwitchLogin`).
  await clearSignInReturn(dir, "codex");
  return {
    agent: "codex",
    user: target.label,
    store: written.store,
    ...(picked === undefined ? {} : { over: picked.over }),
  };
}

/** The CODEX_HOME this command writes a sign-in into. */
function codexHomeOf(options: AccountsOptions): string {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? env.HOME ?? homedir();
  return options.codexHome ?? (env.CODEX_HOME?.trim() || join(homeDir, ".codex"));
}

/** Whether that Codex folder still holds the same sign-in. */
function codexHomeHolds(account: CodexOwnedAccount, home: string): boolean {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(join(home, "auth.json"), "utf8"));
  } catch {
    return false;
  }
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const tokens = (value as { tokens?: unknown }).tokens;
  if (typeof tokens !== "object" || tokens === null) {
    return false;
  }
  const entry = tokens as { refresh_token?: unknown; account_id?: unknown };
  if (typeof entry.refresh_token === "string" && account.refreshToken !== null) {
    return entry.refresh_token === account.refreshToken;
  }
  return (
    typeof entry.account_id === "string" &&
    account.accountId !== null &&
    entry.account_id === account.accountId
  );
}

/** Claude Code's own files and keychain, from this command's options. */
function claudeOptions(options: AccountsOptions): ClaudeOptions {
  return {
    ...(options.homeDir === undefined ? {} : { homeDir: options.homeDir }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.credentialsPath === undefined ? {} : { credentialsPath: options.credentialsPath }),
    ...(options.profilePath === undefined ? {} : { profilePath: options.profilePath }),
    ...(options.readClaudeKeychain === undefined
      ? {}
      : { readKeychain: options.readClaudeKeychain }),
    ...(options.writeClaudeKeychain === undefined
      ? {}
      : { writeKeychain: options.writeClaudeKeychain }),
  };
}

/** A saved Claude sign-in, written into Claude Code's store when the bridge is on. */
async function switchClaudeAccount(
  options: AccountsOptions,
  ref: string,
): Promise<SwitchedAccount> {
  const config = await withConfig(options, async (store) => store.get());
  if (config.claudeSignInWriteBack !== true) {
    throw new Error(
      "writing Claude Code's own sign-in back is off — the Claude subscription bridge is off by default; turn it on under Providers › Claude",
    );
  }
  const dir = gatewayDirOf(options);
  const accounts = await loadClaudeAccounts(claudeAccountsFile(dir));
  if (accounts.length === 0) {
    throw new Error("no Claude accounts saved — neox accounts import claude <file>");
  }
  const current = await readClaudeSignIn(claudeOptions(options));
  const next = ref.trim().toLowerCase() === "next";
  const picked = next
    ? await nextSignInAccount({
        agent: "claude",
        accounts: accounts.map((account) => ({
          id: account.id,
          user: account.user,
          enabled: true,
          lapsed: account.lapsed,
          home: "",
        })),
        activeId: claudeActiveId(accounts, current),
        config,
        options,
      })
    : undefined;
  const target = next
    ? accounts.find((account) => account.id === picked?.to)
    : claudeAccountNamed(accounts, ref);
  if (target === undefined) {
    throw new Error("no Claude account to switch to");
  }
  const store = "error" in current ? "file" : current.store;
  const written = await writeClaudeSignIn(target.credentials, store, claudeOptions(options));
  if ("error" in written) {
    throw new Error(written.error);
  }
  await clearSignInReturn(dir, "claude");
  return {
    agent: "claude",
    user: target.user,
    store: written.store,
    ...(picked === undefined ? {} : { over: picked.over }),
  };
}

/** The saved account Claude Code is signed in to now, matched by refresh token. */
function claudeActiveId(
  accounts: readonly ClaudeAccount[],
  current: Awaited<ReturnType<typeof readClaudeSignIn>>,
): string | null {
  if ("error" in current) {
    return null;
  }
  const live = parseClaudeImport(current.credentials)[0];
  if (live === undefined) {
    return null;
  }
  return (
    accounts.find(
      (account) => live.refreshToken !== "" && account.refreshToken === live.refreshToken,
    )?.id ??
    accounts.find((account) => account.user.toLowerCase() === live.user.toLowerCase())?.id ??
    null
  );
}

function claudeAccountNamed(accounts: readonly ClaudeAccount[], ref: string): ClaudeAccount {
  const wanted = ref.trim().toLowerCase();
  const found = accounts.find(
    (account) =>
      account.id.toLowerCase() === wanted ||
      account.user.trim().toLowerCase() === wanted ||
      (account.alias ?? "").trim().toLowerCase() === wanted,
  );
  if (found === undefined) {
    throw new Error(`no Claude account "${ref}" — neox accounts lists them`);
  }
  return found;
}

/** One sign-in `accounts import claude` took from a file. */
export interface ImportedClaude {
  file: number;
  user: string;
  status: "added" | "updated" | "failed";
  error?: string;
}

/**
 * `accounts import claude <files...>`: myna's Claude import keeps each
 * account exactly as its file has it and never refreshes it
 * (`login_import.go`), so the files are only read here too.
 */
export async function importClaudeAccounts(
  options: AccountsOptions,
  texts: readonly string[],
): Promise<ImportedClaude[]> {
  const file = claudeAccountsFile(gatewayDirOf(options));
  let kept = await loadClaudeAccounts(file);
  const out: ImportedClaude[] = [];
  for (const [index, text] of texts.entries()) {
    const parsed = parseClaudeImport(text);
    if (parsed.length === 0) {
      out.push({ file: index + 1, user: "", status: "failed", error: "no Claude sign-in in it" });
      continue;
    }
    for (const account of parsed) {
      const merged = upsertClaudeAccounts(kept, [account]);
      kept = merged.accounts;
      out.push({
        file: index + 1,
        user: account.user,
        status: merged.added > 0 ? "added" : "updated",
      });
    }
  }
  if (out.some((entry) => entry.status !== "failed")) {
    await saveClaudeAccounts(file, kept);
  }
  return out;
}

/**
 * `accounts import claude --from-claude`: the sign-in Claude Code keeps on
 * this computer, read and never changed (`readClaudeSignIn`): its
 * `.credentials.json`, else the macOS keychain item. No token is written
 * back; only the store under `$NEOLIX_HOME/gateway/` gains the account.
 */
export async function importClaudeSignIn(options: AccountsOptions): Promise<ImportedClaude> {
  const read = await readClaudeSignIn(claudeOptions(options));
  if ("error" in read) {
    return { file: 0, user: "", status: "failed", error: read.error };
  }
  const parsed = parseClaudeImport(read.credentials);
  const account = parsed[0];
  if (account === undefined) {
    return { file: 0, user: "", status: "failed", error: "no Claude sign-in in it" };
  }
  const file = claudeAccountsFile(gatewayDirOf(options));
  const merged = upsertClaudeAccounts(await loadClaudeAccounts(file), [account]);
  await saveClaudeAccounts(file, merged.accounts);
  return {
    file: 0,
    user: account.user,
    status: merged.added > 0 ? "added" : "updated",
  };
}

function codexAccountNamed(accounts: readonly CodexOwnedAccount[], ref: string): CodexOwnedAccount {
  const wanted = ref.trim().toLowerCase();
  const found = accounts.find(
    (account) =>
      account.id.toLowerCase() === wanted || account.label.trim().toLowerCase() === wanted,
  );
  if (found === undefined) {
    throw new Error(`no ChatGPT account "${ref}" — neox accounts chatgpt lists them`);
  }
  return found;
}

/** Drops a subscription account from its store; the gateway stops serving it. */
export async function removeAccount(
  options: AccountsOptions,
  agent: SubscriptionAgent,
  ref: string,
): Promise<{ user: string }> {
  const dir = gatewayDirOf(options);
  const file = subscriptionAccountsFile(dir, agent);
  const all = await loadAnySubscriptionAccounts(file);
  const account = accountNamed(
    all.filter(
      (entry): entry is Extract<SubscriptionAccount, { agent: typeof agent }> =>
        entry.agent === agent,
    ),
    ref,
  );
  await saveSubscriptionAccounts(
    file,
    all.filter((entry) => entry.id !== account.id),
  );
  return { user: account.user };
}

/** The name a row is shown by: its alias, then the vendor's name (`accounts_cli.go:273`). */
export function accountDisplayName(row: AccountRow): string {
  return row.alias === undefined || row.alias === "" ? row.user : `${row.alias} · ${row.user}`;
}

/** One account as `neolix accounts` prints it. */
export function formatAccountRow(row: AccountRow): string {
  const parts = [accountDisplayName(row)];
  if (row.plan !== undefined) {
    parts.push(row.plan);
  }
  if (row.host !== undefined) {
    parts.push(row.host);
  }
  if (row.project !== undefined) {
    parts.push(`project ${row.project}`);
  }
  if (row.lapsed !== undefined) {
    parts.push(row.lapsed);
  }
  return `${row.agent.padEnd(12)} ${parts.join(" · ")}`;
}

export { isSubscriptionAgent };
