import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";
import {
  claudeAccountsFile,
  loadClaudeAccounts,
  parseClaudeImport,
  readClaudeSignIn,
  writeClaudeSignIn,
  type ClaudeAccount,
  type ClaudeOptions,
} from "./claude-accounts.js";
import {
  addCodexAccount,
  loadCodexAccounts,
  saveCodexAccounts,
  type CodexOwnedAccount,
} from "./codex-accounts.js";
import {
  codexHomePath,
  readCodexSignIn,
  writeCodexSignIn,
  type CodexSignIn,
} from "./codex-user-data.js";
import { accountDiscoveryOn, type GatewayConfig, type GatewayProvider } from "./config.js";
import { writePrivateFileAtomic } from "../private-files.js";
import {
  NEAR_SHARE,
  nextLogin,
  usedPast,
  type NextLogin,
  type SignInAccountState,
  type SignInCaps,
  type SignInWindow,
} from "./switch-only.js";

/**
 * Signing Codex and Claude Code in to the next of their accounts when the
 * one they are on is spent (`provider/codex_switch.go`), for a provider
 * whose SwitchOnly is on and whose automatic switch the user turned on.
 *
 * Codex's account pool is `codex-accounts.json`, the accounts Neolix signed
 * in itself; the one Codex is on is read from its own store and matched by
 * ChatGPT account id. Claude's pool is `claude-accounts.json`, matched by
 * refresh token. Nothing here writes unless both `switchOnly` and the
 * agent's `*AutoSwitchSignIn` are on.
 */

/** The account a switch moved the agent off, and the one it moved it to. */
export interface SignInReturn {
  back: string;
  to: string;
}

export const SIGN_IN_RETURNS_FILENAME = "sign-in-returns.json";

export function signInReturnsPath(gatewayDir: string): string {
  return join(gatewayDir, SIGN_IN_RETURNS_FILENAME);
}

type SignInReturns = Record<string, SignInReturn>;

/** The switch's record for an agent; a missing or unreadable file is none. */
export async function readSignInReturn(
  gatewayDir: string,
  agent: "codex" | "claude",
): Promise<SignInReturn | null> {
  const all = await readSignInReturns(gatewayDir);
  return all[agent] ?? null;
}

async function readSignInReturns(gatewayDir: string): Promise<SignInReturns> {
  let text: string;
  try {
    text = await readFile(signInReturnsPath(gatewayDir), "utf8");
  } catch {
    return {};
  }
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return {};
    }
    const out: SignInReturns = {};
    for (const [agent, entry] of Object.entries(value)) {
      if (typeof entry !== "object" || entry === null) {
        continue;
      }
      const record = entry as Record<string, unknown>;
      if (typeof record.back === "string" && typeof record.to === "string") {
        out[agent] = { back: record.back, to: record.to };
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** Keeps the record for an agent; null forgets it (myna's setLoginReturn). */
export async function setSignInReturn(
  gatewayDir: string,
  agent: "codex" | "claude",
  record: SignInReturn | null,
): Promise<void> {
  const all = await readSignInReturns(gatewayDir);
  if (record === null) {
    if (!(agent in all)) {
      return;
    }
    delete all[agent];
  } else {
    all[agent] = record;
  }
  await writePrivateFileAtomic(signInReturnsPath(gatewayDir), `${JSON.stringify(all, null, 2)}\n`);
}

/** Forgets the record, as a switch the user made does (`SwitchLogin`). */
export async function clearSignInReturn(
  gatewayDir: string,
  agent: "codex" | "claude",
): Promise<void> {
  await setSignInReturn(gatewayDir, agent, null);
}

/** Whether an account holds credits to go on with, as its vendor reads them. */
export type SignInCreditsOf = (
  agent: "codex" | "claude",
  account: { id: string; user: string },
) => boolean | undefined | Promise<boolean | undefined>;

/** An account's windows, as the usage sources read them (`warm-windows`). */
export type SignInWindowsOf = (
  agent: "codex" | "claude",
  account: { id: string; user: string },
) => readonly SignInWindow[] | undefined | Promise<readonly SignInWindow[] | undefined>;

export interface SwitchSignInOptions {
  agent: "codex" | "claude";
  provider: GatewayProvider;
  config: GatewayConfig;
  /** `$NEOLIX_HOME/gateway`. */
  gatewayDir: string;
  windowsOf: SignInWindowsOf;
  /** The account's credits reading; absent leaves credits-first off. */
  creditsOf?: SignInCreditsOf;
  /** True when the gateway account spends its credits before moving on. */
  creditsFirstOf?: (id: string, user: string) => boolean;
  now: number;
  homeDir?: string;
  codexHome?: string;
  env?: NodeJS.ProcessEnv;
  /** Reads Codex's keychain item; tests inject it. */
  keychain?: (storeKey: string) => string | null | Promise<string | null>;
  /** Writes Codex's keychain item; tests inject it. */
  writeKeychain?: (storeKey: string, secret: string) => Promise<void>;
  readClaudeKeychain?: (service: string) => Promise<string | null>;
  writeClaudeKeychain?: (service: string, secret: string) => Promise<void>;
  claudeCredentialsPath?: string;
  claudeProfilePath?: string;
  /** True when the vendor holds the account whatever its windows read. */
  heldOf?: (id: string, user: string) => boolean;
  /** True when the account rests after a refusal. */
  restingOf?: (id: string, user: string) => boolean;
  /** The caps of the gateway account that spends this sign-in. */
  capsOf?: (id: string, user: string) => SignInCaps | undefined;
  /**
   * myna's RestartApp: the Codex app's app-server is restarted for a switch
   * back only when the user asked for that, and for a switch off a spent
   * account either way.
   */
  restartCodexApp?: (input: { from: string; to: string; back: boolean; spent: boolean }) => void;
}

export type SwitchSignInResult =
  | {
      status: "switched";
      from: string;
      to: string;
      back: boolean;
      /** The windows show the account it moved off near out. */
      near: boolean;
      store?: "file" | "keychain";
    }
  | { status: "stayed"; near: boolean }
  | { status: "error"; error: string };

interface SwitchAccount extends SignInAccountState {
  /** The name the usage sources know it by. */
  user: string;
  /** Claude: what tells the live sign-in apart, as myna matches an account. */
  refreshToken?: string;
}

function codexAccountsOf(accounts: readonly CodexOwnedAccount[]): SwitchAccount[] {
  return accounts.map((account) => ({
    id: account.id,
    user: account.label,
    // myna's Logins: an account switched off in myna is not moved to.
    enabled: account.disabled !== true,
    lapsed: null,
    home: account.home ?? "",
  }));
}

function claudeAccountsOf(accounts: readonly ClaudeAccount[]): SwitchAccount[] {
  return accounts.map((account) => ({
    id: account.id,
    user: account.user,
    enabled: true,
    lapsed: account.lapsed,
    home: "",
    refreshToken: account.refreshToken,
  }));
}

/** The windows lookup with every promise resolved, so `nextLogin` stays pure. */
async function readWindows(
  agent: "codex" | "claude",
  accounts: readonly SwitchAccount[],
  windowsOf: SignInWindowsOf,
): Promise<Map<string, readonly SignInWindow[] | undefined>> {
  const out = new Map<string, readonly SignInWindow[] | undefined>();
  for (const account of accounts) {
    try {
      out.set(account.id, await windowsOf(agent, { id: account.id, user: account.user }));
    } catch {
      out.set(account.id, undefined);
    }
  }
  return out;
}

/** Each account's credits reading, with the promises resolved. */
async function readCredits(
  agent: "codex" | "claude",
  accounts: readonly SwitchAccount[],
  creditsOf: SignInCreditsOf | undefined,
): Promise<Map<string, boolean | undefined>> {
  const out = new Map<string, boolean | undefined>();
  for (const account of accounts) {
    if (creditsOf === undefined) {
      out.set(account.id, undefined);
      continue;
    }
    try {
      out.set(account.id, await creditsOf(agent, { id: account.id, user: account.user }));
    } catch {
      out.set(account.id, undefined);
    }
  }
  return out;
}

function claudeOptions(options: SwitchSignInOptions): ClaudeOptions {
  return {
    ...(options.homeDir === undefined ? {} : { homeDir: options.homeDir }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.claudeCredentialsPath === undefined
      ? {}
      : { credentialsPath: options.claudeCredentialsPath }),
    ...(options.claudeProfilePath === undefined ? {} : { profilePath: options.claudeProfilePath }),
    ...(options.readClaudeKeychain === undefined
      ? {}
      : { readKeychain: options.readClaudeKeychain }),
    ...(options.writeClaudeKeychain === undefined
      ? {}
      : { writeKeychain: options.writeClaudeKeychain }),
  };
}

function codexHomeOf(options: SwitchSignInOptions): string {
  return codexHomePath({
    ...(options.homeDir === undefined ? {} : { homeDir: options.homeDir }),
    ...(options.codexHome === undefined ? {} : { codexHome: options.codexHome }),
    ...(options.env === undefined ? {} : { env: options.env }),
  });
}

/**
 * The other CODEX_HOME this saved sign-in is held in still, as myna's
 * `codexHeldIn`: two holders of one refresh token sign each other out.
 */
async function codexHeldIn(account: CodexOwnedAccount, codexHome: string): Promise<boolean> {
  const home = account.home ?? "";
  if (home === "" || home === codexHome) {
    return false;
  }
  let value: unknown;
  try {
    value = JSON.parse(await readFile(join(home, "auth.json"), "utf8"));
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
  const held = tokens as { refresh_token?: unknown; account_id?: unknown };
  if (account.refreshToken !== null && typeof held.refresh_token === "string") {
    return held.refresh_token === account.refreshToken;
  }
  return account.accountId !== null && held.account_id === account.accountId;
}

/**
 * Signs the agent in to the next account with room, as myna's
 * SwitchWhenSpent: writes the account's tokens into Codex's own store or
 * Claude Code's, keeping the record of the account to go back to.
 */
export async function switchSignInWhenSpent(
  options: SwitchSignInOptions,
): Promise<SwitchSignInResult> {
  // Both switches, checked here too: no caller can write a sign-in with
  // one of them off.
  if (options.provider.switchOnly !== true) {
    return { status: "error", error: "switch-only is off" };
  }
  if (!accountDiscoveryOn(options.config)) {
    return { status: "error", error: "reading the agents' sign-ins is off" };
  }
  const auto =
    options.agent === "codex"
      ? options.config.codexAutoSwitchSignIn
      : options.config.claudeAutoSwitchSignIn;
  if (auto !== true) {
    return { status: "error", error: "automatic sign-in switching is off" };
  }
  if (options.agent === "codex") {
    return switchCodex(options);
  }
  return switchClaude(options);
}

/** Whether the signed-in account's windows put it near out (myna's codexNearShare). */
function nearOut(
  account: { id: string; user: string } | undefined,
  windows: readonly SignInWindow[] | undefined,
  options: SwitchSignInOptions,
  now: number,
): boolean {
  if (account === undefined || windows === undefined) {
    return false;
  }
  return usedPast(windows, NEAR_SHARE, now) || options.heldOf?.(account.id, account.user) === true;
}

/** An id-and-user lookup as the id-only one `nextLogin` takes. */
function byUser<T>(
  accounts: readonly SwitchAccount[],
  found: (id: string, user: string) => T,
): (id: string) => T {
  return (id) => found(id, accounts.find((account) => account.id === id)?.user ?? "");
}

export interface CodexPoolOptions {
  config: GatewayConfig;
  /** `$NEOLIX_HOME/gateway`. */
  gatewayDir: string;
  now: number;
  homeDir?: string;
  codexHome?: string;
  env?: NodeJS.ProcessEnv;
  keychain?: (storeKey: string) => string | null | Promise<string | null>;
}

export interface CodexPoolSnapshot {
  pool: CodexOwnedAccount[];
  /** The saved account Codex is signed in to, when it is in the pool. */
  activeId: string | null;
  live: CodexSignIn;
}

/**
 * Codex's saved accounts with the one it is signed in to, first put into
 * the pool as myna's `rememberLogins` does: a sign-in made with
 * `codex login` outside Neolix is an account the switch can move off and
 * back to, not a stranger it leaves alone.
 */
export async function readCodexPool(options: CodexPoolOptions): Promise<CodexPoolSnapshot> {
  let pool = await loadCodexAccounts(join(options.gatewayDir, "codex-accounts.json"));
  const live = await readCodexSignIn({
    ...(options.homeDir === undefined ? {} : { homeDir: options.homeDir }),
    ...(options.codexHome === undefined ? {} : { codexHome: options.codexHome }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.keychain === undefined ? {} : { keychain: options.keychain }),
    discovery: accountDiscoveryOn(options.config),
    now: options.now,
  });
  if (!live.ok) {
    return { pool, activeId: null, live };
  }
  const owner = pool.find(
    (account) =>
      (live.accountId !== null && account.accountId === live.accountId) ||
      (live.refreshToken !== null &&
        live.refreshToken !== "" &&
        account.refreshToken === live.refreshToken),
  );
  if (owner !== undefined) {
    return { pool, activeId: owner.id, live };
  }
  // A sign-in with no refresh token can't be signed back in to, and one
  // with neither an account id nor a token has no stable identity.
  if (live.refreshToken === null || live.refreshToken === "") {
    return { pool, activeId: null, live };
  }
  const id =
    live.accountId !== null
      ? `neolix:${live.accountId}`
      : `neolix:${createHash("sha256").update(live.refreshToken).digest("hex").slice(0, 16)}`;
  const owned: CodexOwnedAccount = {
    id,
    label: live.label,
    plan: live.plan,
    accountId: live.accountId,
    accessToken: live.accessToken,
    refreshToken: live.refreshToken,
    idToken: live.idToken,
    expiresAt: live.expiresAt,
    addedAt: options.now,
  };
  pool = addCodexAccount(pool, owned);
  await saveCodexAccounts(join(options.gatewayDir, "codex-accounts.json"), pool);
  return { pool, activeId: id, live };
}

interface CodexState {
  pool: readonly CodexOwnedAccount[];
  accounts: SwitchAccount[];
  active: SwitchAccount | undefined;
  windows: Map<string, readonly SignInWindow[] | undefined>;
  credits: Map<string, boolean | undefined>;
  near: boolean;
}

/** Codex's own sign-in and its saved accounts, matched by ChatGPT account id. */
async function codexState(options: SwitchSignInOptions): Promise<CodexState | null> {
  const snapshot = await readCodexPool(options);
  if (!snapshot.live.ok) {
    return null;
  }
  const accounts = codexAccountsOf(snapshot.pool);
  const active = accounts.find((account) => account.id === snapshot.activeId);
  const windows = await readWindows("codex", accounts, options.windowsOf);
  const activeWindows = active === undefined ? undefined : windows.get(active.id);
  return {
    pool: snapshot.pool,
    accounts,
    active,
    windows,
    credits: await readCredits("codex", accounts, options.creditsOf),
    near: nearOut(active, activeWindows, options, options.now),
  };
}

/** Writes a saved Codex account where Codex keeps its sign-in. */
async function writeCodexTarget(
  options: SwitchSignInOptions,
  target: CodexOwnedAccount,
): Promise<{ store: "file" | "keychain" } | { error: string }> {
  if (await codexHeldIn(target, codexHomeOf(options))) {
    return {
      error: `${target.label} is signed in to Codex in ${target.home ?? ""}`,
    };
  }
  return writeCodexSignIn({
    accessToken: target.accessToken,
    refreshToken: target.refreshToken,
    idToken: target.idToken,
    accountId: target.accountId,
    discovery: accountDiscoveryOn(options.config),
    ...(options.homeDir === undefined ? {} : { homeDir: options.homeDir }),
    ...(options.codexHome === undefined ? {} : { codexHome: options.codexHome }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.writeKeychain === undefined ? {} : { writeKeychain: options.writeKeychain }),
  });
}

async function switchCodex(options: SwitchSignInOptions): Promise<SwitchSignInResult> {
  if (options.config.codexSignInWriteBack === false) {
    return { status: "error", error: "writing Codex's own sign-in back is off" };
  }
  const state = await codexState(options);
  if (state === null) {
    return { status: "stayed", near: false };
  }
  const { pool, accounts, active, windows, credits, near } = state;
  const record = await readSignInReturn(options.gatewayDir, "codex");
  const move = nextLogin({
    agent: "codex",
    ...(options.provider.routing === undefined ? {} : { routing: options.provider.routing }),
    switchOnly: options.provider.switchOnly === true,
    activeId: active?.id ?? null,
    accounts,
    returnTo: record !== null && record.to === active?.id ? record.back : null,
    windowsOf: (id) => windows.get(id),
    ...(options.heldOf === undefined ? {} : { heldOf: byUser(accounts, options.heldOf) }),
    ...(options.restingOf === undefined ? {} : { restingOf: byUser(accounts, options.restingOf) }),
    ...(options.capsOf === undefined ? {} : { capsOf: byUser(accounts, options.capsOf) }),
    ...(options.creditsFirstOf === undefined
      ? {}
      : { creditsFirstOf: byUser(accounts, options.creditsFirstOf) }),
    // myna's spendsFirst reads the vendor's windows' Credits; the usage
    // sources report it as the account's credits balance.
    creditsOf: (id) => credits.get(id) === true,
    now: options.now,
  });
  const target = move === null ? undefined : pool.find((account) => account.id === move.to);
  if (move === null || target === undefined) {
    return { status: "stayed", near };
  }
  const written = await writeCodexTarget(options, target);
  if ("error" in written) {
    return { status: "error", error: written.error };
  }
  await keepReturn(options.gatewayDir, "codex", move);
  // myna's RestartApp: a switch off a spent account restarts the app
  // either way, because it greys Send there; a switch back only when the
  // user asked myna to restart it.
  if (!move.back || options.provider.restartApp === true) {
    options.restartCodexApp?.({
      from: move.from,
      to: move.to,
      back: move.back,
      spent: !move.back,
    });
  }
  return {
    status: "switched",
    from: move.from,
    to: move.to,
    back: move.back,
    near,
    store: written.store,
  };
}

async function switchClaude(options: SwitchSignInOptions): Promise<SwitchSignInResult> {
  const saved = await loadClaudeAccounts(claudeAccountsFile(options.gatewayDir));
  const accounts = claudeAccountsOf(saved);
  const current = await readClaudeSignIn(claudeOptions(options));
  let active: SwitchAccount | undefined;
  if (!("error" in current)) {
    const live = parseClaudeImport(current.credentials)[0];
    if (live !== undefined) {
      active =
        (live.refreshToken === ""
          ? undefined
          : accounts.find((account) => account.refreshToken === live.refreshToken)) ??
        accounts.find((account) => account.user.toLowerCase() === live.user.toLowerCase());
    }
  }
  const windows = await readWindows("claude", accounts, options.windowsOf);
  const activeWindows = active === undefined ? undefined : windows.get(active.id);
  const near = nearOut(active, activeWindows, options, options.now);
  const credits = await readCredits("claude", accounts, options.creditsOf);
  const record = await readSignInReturn(options.gatewayDir, "claude");
  const move = nextLogin({
    agent: "claude",
    ...(options.provider.routing === undefined ? {} : { routing: options.provider.routing }),
    switchOnly: options.provider.switchOnly === true,
    activeId: active?.id ?? null,
    accounts,
    returnTo: record !== null && record.to === active?.id ? record.back : null,
    windowsOf: (id) => windows.get(id),
    ...(options.heldOf === undefined ? {} : { heldOf: byUser(accounts, options.heldOf) }),
    ...(options.restingOf === undefined ? {} : { restingOf: byUser(accounts, options.restingOf) }),
    ...(options.capsOf === undefined ? {} : { capsOf: byUser(accounts, options.capsOf) }),
    ...(options.creditsFirstOf === undefined
      ? {}
      : { creditsFirstOf: byUser(accounts, options.creditsFirstOf) }),
    creditsOf: (id) => credits.get(id) === true,
    now: options.now,
  });
  if (move === null) {
    return { status: "stayed", near };
  }
  const target = saved.find((account) => account.id === move.to);
  if (target === undefined) {
    return { status: "stayed", near };
  }
  const store = "error" in current ? "file" : current.store;
  const written = await writeClaudeSignIn(target.credentials, store, claudeOptions(options));
  if ("error" in written) {
    return { status: "error", error: written.error };
  }
  await keepReturn(options.gatewayDir, "claude", move);
  return {
    status: "switched",
    from: move.from,
    to: move.to,
    back: move.back,
    near,
    store: written.store,
  };
}

async function keepReturn(
  gatewayDir: string,
  agent: "codex" | "claude",
  move: NextLogin,
): Promise<void> {
  if (move.back) {
    await setSignInReturn(gatewayDir, agent, null);
    return;
  }
  const record = await readSignInReturn(gatewayDir, agent);
  await setSignInReturn(gatewayDir, agent, {
    back: record !== null && record.back !== "" ? record.back : move.from,
    to: move.to,
  });
}

export interface SignInSwitchSchedulerOptions extends Omit<
  SwitchSignInOptions,
  "agent" | "provider" | "now" | "config"
> {
  config: () => GatewayConfig;
  logger: Pick<Logger, "info" | "warn" | "debug">;
  now?: () => number;
  /** myna's firstSignInLook: when the first look is made. */
  firstLookMs?: number;
  /** myna's loginSwitchEvery. */
  everyMs?: number;
  /** myna's codexNearOutEvery, while the signed-in account is near out. */
  nearEveryMs?: number;
}

/** myna's loginSwitchEvery. */
const LOGIN_SWITCH_EVERY = 5 * 60_000;
/** myna's codexNearOutEvery. */
const NEAR_OUT_EVERY = 60_000;
/** myna's firstSignInLook. */
const FIRST_SIGN_IN_LOOK = 60_000;

export type LookResult = SwitchSignInResult | { status: "skipped"; reason: string };

/**
 * myna's KeepOnAnAccountWithRoom: looks at Codex's and Claude Code's
 * sign-ins every five minutes, and every minute while the account one is
 * on is near out, moving them on when it is spent.
 */
export class SignInSwitchScheduler {
  private timer: NodeJS.Timeout | null = null;
  private disposed = false;
  /** True while the last look saw the signed-in account near out. */
  private near = false;
  private readonly logger: Pick<Logger, "info" | "warn" | "debug">;

  constructor(private readonly options: SignInSwitchSchedulerOptions) {
    this.logger = options.logger;
  }

  public start(): void {
    this.schedule(this.options.firstLookMs ?? FIRST_SIGN_IN_LOOK);
  }

  public dispose(): void {
    this.disposed = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private schedule(ms: number): void {
    if (this.disposed) {
      return;
    }
    this.timer = setTimeout(() => {
      void this.tick();
    }, ms);
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.near = false;
    for (const agent of ["codex", "claude"] as const) {
      let result: LookResult;
      try {
        result = await this.lookNow(agent);
      } catch (error) {
        this.logger.warn({ err: error, agent }, "Cannot switch the agent's sign-in");
        continue;
      }
      if (result.status === "switched") {
        this.near = this.near || result.near;
        this.logger.info(
          {
            agent,
            from: result.from,
            to: result.to,
            back: result.back,
          },
          "Switched the agent's sign-in to an account with room",
        );
      } else if (result.status === "stayed") {
        this.near = this.near || result.near;
      } else if (result.status === "error") {
        this.logger.warn({ agent, err: result.error }, "Cannot switch the agent's sign-in");
      }
    }
    const every = this.near
      ? (this.options.nearEveryMs ?? NEAR_OUT_EVERY)
      : (this.options.everyMs ?? LOGIN_SWITCH_EVERY);
    this.schedule(every);
  }

  /**
   * One look at one agent's sign-in, as myna's lookAtSignIn: nothing is
   * read or written unless SwitchOnly and the agent's automatic switch are
   * both on.
   */
  public async lookNow(agent: "codex" | "claude"): Promise<LookResult> {
    const config = this.options.config();
    const provider = config.providers.find((entry) => entry.id === agent);
    if (provider === undefined || provider.switchOnly !== true) {
      return { status: "skipped", reason: "switch-only is off" };
    }
    if (!accountDiscoveryOn(config)) {
      return { status: "skipped", reason: "reading the agents' sign-ins is off" };
    }
    const auto = agent === "codex" ? config.codexAutoSwitchSignIn : config.claudeAutoSwitchSignIn;
    if (auto !== true) {
      return { status: "skipped", reason: "automatic sign-in switching is off" };
    }
    try {
      return await switchSignInWhenSpent({
        ...this.options,
        config,
        agent,
        provider,
        now: (this.options.now ?? Date.now)(),
      });
    } catch (error) {
      return {
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
