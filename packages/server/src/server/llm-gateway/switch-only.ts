import type { GatewayAccount, GatewayProvider } from "./config.js";

/**
 * myna's SwitchOnly (`internal/provider/provider.go:161-168`,
 * `provider/routing.go:149`): the gateway only moves an agent's own sign-in
 * between its accounts.
 *
 * Claude's subscription is myna's KeptToAgent (`provider.go:2248-2258`):
 * with SwitchOnly on, the gateway takes no request on its accounts at all.
 * Codex's subscription keeps the gateway's failover out of the accounts that
 * are Codex's own sign-ins; its requests go straight to OpenAI.
 */

/** Whether an account is one of the agent's own sign-ins. */
export function signedInAccount(account: GatewayAccount): boolean {
  return account.agent === "claude-code" || account.codexAccountId !== undefined;
}

/** myna's KeptToAgent: Claude's own sign-ins, served nothing by the gateway. */
export function providerKeptToAgent(provider: GatewayProvider): boolean {
  return (
    provider.switchOnly === true &&
    provider.id === "claude" &&
    provider.accounts.some((account) => account.agent === "claude-code")
  );
}

/**
 * Whether a Codex sign-in is spent: a window at or past `spentShare` that has
 * not reset, as myna's usedPast counts SpentShare (`codex_switch.go:96`).
 */
export function signInSpent(
  limits: readonly { usedPercent: number; resetAt: number | null }[],
  now: number,
  spentShare = 98,
): boolean {
  return limits.some(
    (limit) => limit.usedPercent >= spentShare && (limit.resetAt === null || limit.resetAt > now),
  );
}

export interface SignInSwitchInput {
  /** The account Codex is signed in to, as its store id; null when unknown. */
  activeId: string | null;
  /** The accounts, in the order the agent moves through them. */
  accounts: readonly { id: string; disabled?: boolean }[];
  limitsOf: (id: string) => readonly { usedPercent: number; resetAt: number | null }[];
  now: number;
  spentShare?: number;
}

/**
 * The account myna would sign Codex in to: the first after the one it is on
 * that has room, as `NextLogin`/`SwitchWhenSpent` move forward
 * (`codex_switch.go:270-310`). Under SwitchOnly the sign-in does not go back
 * to an account that has room again: `returnsToFirst` is false for Codex
 * (`codex_switch.go:153-160`). Null when the account it is on still has room
 * or no later account does.
 */
/** myna's SpentShare: the share of an allowance past which an account is spent. */
export const SPENT_SHARE = 98;
/** myna's backShare: below it the account a switch moved off is low no more. */
export const BACK_SHARE = 90;
/** myna's codexNearShare: past it the Codex sign-in is looked at every minute. */
export const NEAR_SHARE = 90;
/** myna's roomMargin: how much more room a spare needs than a spent active one. */
export const ROOM_MARGIN = 1;

/**
 * The share an account is moved off at, myna's SpentShareOf: an account at
 * 98% is still tried in its turn under `order`, and drained under `drain`.
 */
export function spentShareOf(routing: GatewayProvider["routing"]): number {
  return routing === "order" || routing === "drain" ? 100 : SPENT_SHARE;
}

/**
 * Whether myna signs the agent back in to the account it moved it off once
 * that has room (`codex_switch.go:153-162`). Under SwitchOnly that only
 * happens where the user said the first comes first (`order`); a Codex
 * subscription that is not switch-only follows the gateway, too.
 */
export function returnsToFirst(
  agent: "codex" | "claude",
  routing: GatewayProvider["routing"],
  switchOnly: boolean,
): boolean {
  return routing === "order" || (agent === "codex" && !switchOnly);
}

/** One window of an account's allowance, as myna's QuotaWindow is read. */
export interface SignInWindow {
  usedPercent: number;
  /** Epoch ms; null when the vendor said nothing of it. */
  resetAt: number | null;
  /** The window's name, for a cap of its own. */
  name?: string;
}

/** The shares an account is held at (myna's WindowCaps, `account_caps.go`). */
export interface SignInCaps {
  /** A cap on every window, percent. */
  all?: number;
  /** A cap of one window, by its name. */
  windows?: Record<string, number>;
}

/** One of the agent's accounts, as the switch sees it. */
export interface SignInAccountState {
  id: string;
  /** myna's `Login.On`: the account is in use, not switched off. */
  enabled: boolean;
  /** Why the vendor refused its sign-in; a lapsed account is never moved to. */
  lapsed?: string | null;
  /** Codex: the other CODEX_HOME holding this sign-in, which is not to be switched to. */
  home?: string | null;
}

export interface NextLoginInput {
  agent: "codex" | "claude";
  /** The provider's routing; `order` moves the sign-in at 100% instead of 98%. */
  routing?: GatewayProvider["routing"];
  switchOnly: boolean;
  /** The account the agent is signed in to, or null when it can't be told. */
  activeId: string | null;
  /** Every account, in the order myna moves through them. */
  accounts: readonly SignInAccountState[];
  /** The account a switch moved the agent off (`sign-in-returns.json`). */
  returnTo: string | null;
  /** An account's windows; undefined when its allowance is not known. */
  windowsOf: (id: string) => readonly SignInWindow[] | undefined;
  /** The vendor holds the account whatever its windows read (myna's `q.Held`). */
  heldOf?: (id: string) => boolean;
  /** The account rests after a refusal (myna's rest tables). */
  restingOf?: (id: string) => boolean;
  capsOf?: (id: string) => SignInCaps | undefined;
  /** True when the account spends its credits before moving on (myna's spendsFirst). */
  creditsFirstOf?: (id: string) => boolean;
  /** True when the account holds credits to go on with. */
  creditsOf?: (id: string) => boolean;
  now: number;
}

/** What a switch does: the account it moves off, to, and whether it goes back. */
export interface NextLogin {
  from: string;
  to: string;
  /** True when the account it moves to is the one it was moved off. */
  back: boolean;
}

function resetPassed(window: SignInWindow, now: number): boolean {
  return window.resetAt !== null && now >= window.resetAt;
}

/**
 * Whether one of the account's windows is at `share` or past at `now`;
 * a window whose reset has passed has started again.
 */
export function usedPast(windows: readonly SignInWindow[], share: number, now: number): boolean {
  return windows.some((window) => window.usedPercent >= share && !resetPassed(window, now));
}

function windowNames(name: string): string[] {
  const lower = name.trim().toLowerCase();
  if (lower === "5h") {
    return [lower, "5 hour", "5 hours", "5-hour", "5-hours"];
  }
  if (lower === "7d") {
    return [lower, "7 day", "7 days", "7-day", "7-days", "week", "weekly"];
  }
  return [lower];
}

function capOf(caps: SignInCaps | undefined, window: SignInWindow): number {
  if (caps === undefined) {
    return 0;
  }
  // myna's WindowCapID: the window's name trimmed and lower-cased. The
  // usage sources call the windows "5h" and "7d"; gateway.json's capWindows
  // carries the names the app shows, so both forms find the same cap.
  const names = windowNames(window.name ?? "");
  const own = Object.entries(caps.windows ?? {}).find(([key]) =>
    names.includes(key.trim().toLowerCase()),
  )?.[1];
  const share = own !== undefined && own > 0 ? own : (caps.all ?? 0);
  return share >= 100 ? 0 : share;
}

/** myna's capReached: a window at or past its own cap, not renewed since. */
export function capReached(
  windows: readonly SignInWindow[],
  caps: SignInCaps | undefined,
  now: number,
): boolean {
  return windows.some((window) => {
    const share = capOf(caps, window);
    return share > 0 && window.usedPercent >= share && !resetPassed(window, now);
  });
}

/**
 * myna's roomLeft: how far the fullest window is below the line it is moved
 * off at (its own cap when lower), below zero when past it.
 */
export function roomLeft(
  windows: readonly SignInWindow[],
  share: number,
  caps: SignInCaps | undefined,
  now: number,
): number {
  let room = share;
  for (const window of windows) {
    if (resetPassed(window, now)) {
      continue;
    }
    const own = capOf(caps, window);
    const line = own > 0 && own < share ? own : share;
    room = Math.min(room, line - window.usedPercent);
  }
  return room;
}

/**
 * myna's NextLogin (`codex_switch.go:236-348`): the account the agent
 * should be signed in to instead of the one it is on, or null to stay.
 *
 * The account it was moved off is signed back in to once it is no longer
 * low (backShare) where myna returns to the first; else, when the one it
 * is on is spent (SpentShare, or 100% under `order`) or at its cap, the
 * first other account in use, in the saved order, whose allowance is known
 * and not spent — or, when every one is past its line too, the one with
 * the most room left, by `roomMargin` more than the one it is on.
 */
export function nextLogin(input: NextLoginInput): NextLogin | null {
  const index = input.accounts.findIndex((account) => account.id === input.activeId);
  if (index < 0) {
    return null;
  }
  const active = input.accounts[index] as SignInAccountState;
  const share = spentShareOf(input.routing);
  const spares = input.accounts.filter(
    (account) =>
      account.id !== active.id &&
      account.enabled &&
      (account.lapsed ?? "") === "" &&
      (account.home ?? "") === "",
  );
  if (spares.length === 0) {
    return null;
  }
  const held = (id: string): boolean =>
    input.heldOf?.(id) === true || input.restingOf?.(id) === true;
  const capsOf = (id: string): SignInCaps | undefined => input.capsOf?.(id);
  // Kept on the first, the agent goes back to it at once; but of the myna
  // settings only `order` says the first comes first under SwitchOnly.
  const backId = backAccount(input, held, capsOf);
  if (backId !== null) {
    return { from: active.id, to: backId, back: true };
  }
  const activeWindows = input.windowsOf(active.id);
  if (
    activeWindows === undefined ||
    (!held(active.id) &&
      !usedPast(activeWindows, share, input.now) &&
      !capReached(activeWindows, capsOf(active.id), input.now))
  ) {
    return null;
  }
  // myna's spendsFirst: set to spend its credits before another account,
  // and holding some, Codex stays on it even though its window is spent.
  if (
    input.agent === "codex" &&
    !held(active.id) &&
    !capReached(activeWindows, capsOf(active.id), input.now) &&
    input.creditsFirstOf?.(active.id) === true &&
    input.creditsOf?.(active.id) === true
  ) {
    return null;
  }
  const most = held(active.id)
    ? Number.NEGATIVE_INFINITY
    : roomLeft(activeWindows, share, capsOf(active.id), input.now) + ROOM_MARGIN;
  const to = chooseSpare(input, spares, share, held, capsOf, most);
  return to === null ? null : { from: active.id, to, back: false };
}

/** The account to go back to, when it is no longer low, or null. */
function backAccount(
  input: NextLoginInput,
  held: (id: string) => boolean,
  capsOf: (id: string) => SignInCaps | undefined,
): string | null {
  if (input.returnTo === null || !returnsToFirst(input.agent, input.routing, input.switchOnly)) {
    return null;
  }
  const first = input.accounts.find(
    (account) => account.id === input.returnTo && account.enabled && (account.lapsed ?? "") === "",
  );
  if (first === undefined) {
    return null;
  }
  const windows = input.windowsOf(first.id);
  if (
    windows === undefined ||
    held(first.id) ||
    usedPast(windows, BACK_SHARE, input.now) ||
    capReached(windows, capsOf(first.id), input.now)
  ) {
    return null;
  }
  return first.id;
}

/** The spare with room, else the one with the most room left (`roomMargin`). */
function chooseSpare(
  input: NextLoginInput,
  spares: readonly SignInAccountState[],
  share: number,
  held: (id: string) => boolean,
  capsOf: (id: string) => SignInCaps | undefined,
  most: number,
): string | null {
  let best = "";
  for (const spare of spares) {
    const windows = input.windowsOf(spare.id);
    if (windows === undefined || held(spare.id)) {
      continue;
    }
    if (!usedPast(windows, share, input.now) && !capReached(windows, capsOf(spare.id), input.now)) {
      return spare.id;
    }
    const room = roomLeft(windows, share, capsOf(spare.id), input.now);
    if (room > most) {
      best = spare.id;
      most = room;
    }
  }
  return best === "" ? null : best;
}

export interface NextInOrderInput {
  /** Every account, in the order the agent moves through them. */
  accounts: readonly SignInAccountState[];
  activeId: string | null;
  /** The share an account is moved at, `spentShareOf(routing)`. */
  share: number;
  windowsOf: (id: string) => readonly SignInWindow[] | undefined;
  capsOf?: (id: string) => SignInCaps | undefined;
  now: number;
}

export type NextInOrderResult =
  | { status: "chosen"; to: string; over: boolean }
  | { status: "none" }
  | { status: "unread" };

/**
 * myna's NextInOrder (`codex_switch.go:394-438`): the account `accounts
 * switch <agent> next` signs it in to — of its other switchable accounts,
 * taken from the one after the account it is on, the first whose allowance
 * is known and has room; when none has, the one with the most room left
 * and `over` saying so. Unlike the automatic switch, an account switched
 * off in Neolix is still taken (on/off is the gateway's, not the sign-in's),
 * and a lapsed one or one held in another Codex folder is not.
 */
export function nextInOrder(input: NextInOrderInput): NextInOrderResult {
  const at = input.accounts.findIndex((account) => account.id === input.activeId);
  if (at < 0) {
    return { status: "none" };
  }
  const order: SignInAccountState[] = [];
  for (let step = 1; step < input.accounts.length; step += 1) {
    const account = input.accounts[(at + step) % input.accounts.length] as SignInAccountState;
    if (account.id === input.activeId) {
      continue;
    }
    // myna's switchable: a lapsed account and one Codex keeps signed in in
    // another folder are left out (a setup-token has no Neolix counterpart).
    if ((account.lapsed ?? "") !== "" || (account.home ?? "") !== "") {
      continue;
    }
    order.push(account);
  }
  if (order.length === 0) {
    return { status: "none" };
  }
  let best = "";
  let most = Number.NEGATIVE_INFINITY;
  for (const account of order) {
    const windows = input.windowsOf(account.id);
    if (windows === undefined) {
      continue;
    }
    if (
      !usedPast(windows, input.share, input.now) &&
      !capReached(windows, input.capsOf?.(account.id), input.now)
    ) {
      return { status: "chosen", to: account.id, over: false };
    }
    const room = roomLeft(windows, input.share, input.capsOf?.(account.id), input.now);
    if (room > most) {
      best = account.id;
      most = room;
    }
  }
  return best === "" ? { status: "unread" } : { status: "chosen", to: best, over: true };
}

export function nextSignIn(input: SignInSwitchInput): string | null {
  const index = input.accounts.findIndex((account) => account.id === input.activeId);
  if (index < 0) {
    return null;
  }
  if (!signInSpent(input.limitsOf(input.accounts[index]!.id), input.now, input.spentShare)) {
    return null;
  }
  for (const account of input.accounts.slice(index + 1)) {
    if (account.disabled === true) {
      continue;
    }
    if (!signInSpent(input.limitsOf(account.id), input.now, input.spentShare)) {
      return account.id;
    }
  }
  return null;
}
