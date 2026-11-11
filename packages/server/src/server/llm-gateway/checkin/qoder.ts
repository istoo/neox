import { execFile } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { authNumber, authString, providerOfKey, readPluginAuth } from "./store.js";
import { renewOnce, writeAuthFields } from "./oauth.js";
import { failedResult, type CheckinResult } from "./state.js";

/**
 * Qoder's daily credits, ported from the plugin
 * @magpie-community/opencode-qoder-auth 0.2.61 (`campaignRuntime`,
 * `campaignMachine`, `campaignCall`, `checkin`) and myna's
 * `internal/provider/qoder_checkin.go`.
 *
 * Qoder lists an account's campaigns on its openapi host; the day's
 * credits are the `CLAIM_BENEFIT` one. A claimable campaign is claimed, a
 * claimed one is the day's check-in, and campaigns are rechecked through
 * the day (they need not open at midnight). Both sites ask for the device
 * identity their own app's `runtime-info` helper gives; without it Qoder
 * offers no daily credits. Qoder CN may go on without it.
 *
 * The sign-in is myna's. A device token Qoder refuses is rotated once
 * through the plugin's own `/api/v1/deviceToken/refresh` and the request
 * asked again, as the plugin's campaigns calls do; the rotated pair is
 * written back where myna's file still holds the token it spent. A PAT
 * account has no device token to rotate, and its refusal is the answer.
 */

export const QODER_VENDOR = "qoder";
export const QODER_ID = "qoder";
export const QODER_CN_ID = "qoder-cn";

const CAMPAIGNS = "/sash/api/v1/me/campaigns";
const CAMPAIGN_MACHINE_TIMEOUT_MS = 20_000;
/** A minute's room for a computer clock that runs ahead of Qoder's. */
const OPEN_ROOM_MS = 60_000;
const DAY_MS = 86_400_000;
const BEIJING_OFFSET_MS = 8 * 60 * 60_000;

export type QoderSite = "qoder" | "qoder-cn";

const OPENAPI: Record<QoderSite, string> = {
  qoder: "https://openapi.qoder.sh",
  "qoder-cn": "https://openapi.qoder.com.cn",
};

interface RuntimeConfig {
  name: string;
  environment: string;
  override: string;
  app: string;
  linux: string;
  cli: string;
  dir: string;
  /** Qoder offers the daily credits only to a request carrying the identity. */
  required: boolean;
}

const RUNTIMES: Record<QoderSite, RuntimeConfig> = {
  qoder: {
    name: "Qoder",
    environment: "3",
    override: "QODER_RUNTIME_INFO",
    app: "Qoder",
    linux: "Qoder",
    cli: "QODER_",
    dir: ".qoder",
    required: true,
  },
  "qoder-cn": {
    name: "Qoder CN",
    environment: "0",
    override: "QODERCN_RUNTIME_INFO",
    app: "Qoder CN",
    linux: "Qoder-CN",
    cli: "QODERCN_",
    dir: ".qoder-cn",
    required: false,
  },
};

export interface QoderAccount {
  /** Its entry in the check-in file: `<site>|<uid>`. */
  key: string;
  user: string;
  uid: string;
  deviceToken: string;
  access: string;
  lingma: boolean;
  site: QoderSite;
  /** Its key in myna's plugin-auth.json, for writing a rotation back. */
  authKey: string;
  deviceRefresh?: string;
  /** The device token is this account's chat token too (Qoder CN's CLI). */
  deviceChat?: boolean;
  /** The chat pair's end; a device-chat account's device token instead. */
  expires?: number;
}

/** How the device identity is read; injected whole in tests, never run there. */
export interface QoderIdentityOptions {
  home?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  env?: NodeJS.ProcessEnv;
  opt?: string;
  runRuntime?: (input: {
    file: string;
    args: string[];
    stdin?: string;
    timeoutMs: number;
  }) => Promise<string>;
}

export interface QoderRequestOptions {
  account: QoderAccount;
  /** myna's plugin-auth.json, where a rotation is written back. */
  authPath?: string;
  /** The campaigns page, for tests; the site's otherwise. */
  baseUrl?: string;
  fetch?: typeof fetch;
  now?: () => Date;
  signal?: AbortSignal;
  identity?: QoderIdentityOptions;
}

/** No runtime-info helper on this machine. */
export class QoderRuntimeMissingError extends Error {
  constructor(runtime: RuntimeConfig) {
    super(
      `${runtime.name} check-in: device identity runtime not found. ${runtime.name} gives the daily credits only to a device its own app identifies, and this machine has neither ${runtime.name} desktop nor ${runtime.name} CLI to read that identity from. Install ${runtime.name} desktop (or install ${runtime.name} CLI and sign in to it once), or set ${runtime.override} to its runtime-info executable; Neox checks in again the next day`,
    );
    this.name = "QoderRuntimeMissingError";
  }
}

/** The helper was found but couldn't be read. */
export class QoderRuntimeError extends Error {
  constructor(runtime: RuntimeConfig, reason: "read" | "invalid") {
    const detail =
      reason === "read"
        ? `could not read device identity; restart or update ${runtime.name}, or check ${runtime.override}`
        : `invalid device identity from ${runtime.name}; restart or update ${runtime.name}`;
    super(`${runtime.name} check-in: ${detail}`);
    this.name = "QoderRuntimeError";
  }
}

/** Reads the Qoder plugin's sign-ins on both sites from myna's plugin-auth.json. */
export async function loadQoderAccounts(input: { authPath: string }): Promise<QoderAccount[]> {
  const auths = await readPluginAuth(input.authPath);
  const out: QoderAccount[] = [];
  const seen = new Set<string>();
  for (const [authKey, auth] of Object.entries(auths)) {
    const provider = providerOfKey(authKey);
    if (provider !== QODER_ID && provider !== QODER_CN_ID) continue;
    const uid = authString(auth, "uid");
    if (uid === "") continue;
    const site = provider;
    const key = `${site}|${uid}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const name = authString(auth, "accountId");
    const deviceRefresh = authString(auth, "deviceRefresh");
    const expires = authNumber(auth, "expires");
    out.push({
      key,
      user: name !== "" ? name : uid,
      uid,
      deviceToken: authString(auth, "deviceToken"),
      access: authString(auth, "access"),
      lingma: Boolean(auth.lingma),
      site,
      authKey,
      ...(deviceRefresh === "" ? {} : { deviceRefresh }),
      ...(auth.deviceChat === true ? { deviceChat: true } : {}),
      ...(expires === undefined ? {} : { expires }),
    });
  }
  return out;
}

/**
 * Claims one account's claimable daily credits. None claimable: one claimed
 * for the day now is done, no daily campaign at all is inactive, and one
 * neither is a failure, tried again later (the plugin's `checkin`).
 */
export async function checkQoder(options: QoderRequestOptions): Promise<CheckinResult> {
  const { account } = options;
  if (account.lingma) {
    return { outcome: "inactive", msg: "a Lingma 1.0 dedicated domain has no daily credits" };
  }
  const now = options.now ?? (() => new Date());
  const nowDate = now();
  const nowMs = nowDate.getTime();

  let identity: { headers: Record<string, string>; unread?: Error };
  try {
    identity = await campaignIdentity(account, options.identity);
  } catch (error) {
    // Asking again won't find a runtime or fix a broken one; the next
    // Beijing day is when it is looked at again.
    if (error instanceof QoderRuntimeMissingError || error instanceof QoderRuntimeError) {
      return {
        outcome: "ineligible",
        msg: error.message,
        until: nextBeijingMidnight(nowDate),
      };
    }
    return failedResult(error);
  }

  const context: QoderCallContext = {
    baseUrl: options.baseUrl ?? `${OPENAPI[account.site]}${CAMPAIGNS}`,
    account,
    machine: identity.headers,
    fetch: options.fetch ?? globalThis.fetch,
    signal: options.signal,
  };

  const listed = await campaignCallRotating(context, "GET", context.baseUrl, options);
  if (listed.failure !== undefined) return listed.failure;
  if (listed.httpStatus !== 200) {
    return { outcome: "failed", msg: `campaigns: HTTP ${listed.httpStatus}` };
  }
  if (listed.body === null) {
    return unreadable("campaigns", listed.text);
  }
  const campaigns = campaignList(listed.body);
  const claimable = campaigns.find(
    (campaign) => campaign.claimStatus === "CLAIMABLE" && campaign.id !== "",
  );

  if (claimable === undefined) {
    const done = campaigns.find(
      (campaign) => campaign.claimStatus === "CLAIMED" && active(campaign, nowMs),
    );
    if (done !== undefined) {
      return withUntil(result("done", done.amount), nextOpens(done));
    }
    if (campaigns.length > 0) {
      return withUntil(
        { outcome: "failed", msg: "campaigns: today's credits aren't offered yet" },
        nextOpening(campaigns, nowMs),
      );
    }
    if (identity.unread !== undefined) {
      return {
        outcome: "ineligible",
        msg: identity.unread.message,
        until: nextBeijingMidnight(nowDate),
      };
    }
    return { outcome: "inactive", msg: noCampaign(account.site) };
  }

  const claimed = await campaignCallRotating(
    context,
    "POST",
    `${context.baseUrl}/${encodeURIComponent(claimable.id)}/claim`,
    options,
  );
  if (claimed.failure !== undefined) return claimed.failure;
  if (claimed.httpStatus !== 200) {
    return { outcome: "failed", msg: `claim: HTTP ${claimed.httpStatus}` };
  }
  if (claimed.body === null) {
    return unreadable("claim", claimed.text);
  }
  const status = claimStatus(claimed.body);
  if (status !== "CLAIMED") {
    return { outcome: "failed", msg: `claim: ${status !== "" ? status : "unknown answer"}` };
  }
  const amount = claimAmount(claimed.body, claimable);
  return withUntil(result("claimed", amount), nextOpens(claimable));
}

interface QoderCallContext {
  baseUrl: string;
  account: QoderAccount;
  machine: Record<string, string>;
  fetch: typeof fetch;
  signal?: AbortSignal;
}

type QoderCall =
  | { httpStatus: number; text: string; body: Record<string, unknown> | null; failure?: never }
  | { httpStatus: number; text: string; body: null; failure: CheckinResult };

/**
 * Asks a campaigns page with the account's device token and this machine's
 * identity, as the plugin's `campaignCall`. A 401/403 is passed back so the
 * caller can rotate the device token once, as the plugin does.
 */
async function campaignCall(
  context: QoderCallContext,
  method: "GET" | "POST",
  url: string,
): Promise<QoderCall> {
  let response: Response;
  try {
    response = await context.fetch(url, {
      method,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${context.account.deviceToken || context.account.access}`,
        "Cosy-ClientType": "10",
        "User-Agent": "Qoder",
        ...context.machine,
      },
      ...(method === "POST" ? { body: "{}" } : {}),
      signal: context.signal,
    });
  } catch (error) {
    return { httpStatus: 0, text: "", body: null, failure: failedResult(error) };
  }
  const text = await response.text();
  if (response.status === 401 || response.status === 403) {
    return {
      httpStatus: response.status,
      text,
      body: null,
      failure: { outcome: "failed", msg: "Qoder's sign-in has expired — sign in again" },
    };
  }
  let body: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      body = parsed as Record<string, unknown>;
    }
  } catch {
    body = null;
  }
  return { httpStatus: response.status, text, body };
}

/**
 * A campaigns call, with the device token rotated once and the call asked
 * again where Qoder refuses it (401/403), as the plugin's `campaign` does.
 * A PAT account has no device token: its refusal is the answer.
 */
async function campaignCallRotating(
  context: QoderCallContext,
  method: "GET" | "POST",
  url: string,
  options: QoderRequestOptions,
): Promise<QoderCall> {
  const first = await campaignCall(context, method, url);
  if (first.httpStatus !== 401 && first.httpStatus !== 403) return first;
  if (context.account.deviceToken === "" || context.account.deviceRefresh === undefined) {
    return first;
  }
  const rotated = await rotateDeviceToken(context.account, options);
  if (rotated === null) return first;
  context.account = { ...context.account, deviceToken: rotated.deviceToken };
  return campaignCall(context, method, url);
}

interface RotatedDevice {
  deviceToken: string;
  deviceRefresh: string;
  expires: number;
}

/**
 * The device pair Qoder gave for the one it refused, written back where
 * myna's file still holds the spent device token. One rotation in flight per
 * entry: a refresh token is spent once.
 */
async function rotateDeviceToken(
  account: QoderAccount,
  options: QoderRequestOptions,
): Promise<RotatedDevice | null> {
  const rotated = await renewOnce(`qoder-device:${account.authKey}`, () =>
    refreshQoderDevice(account, options),
  );
  if (rotated === null) return null;
  if (options.authPath !== undefined) {
    await writeAuthFields({
      authPath: options.authPath,
      authKey: account.authKey,
      field: "deviceToken",
      expected: account.deviceToken,
      values: {
        deviceToken: rotated.deviceToken,
        deviceRefresh: rotated.deviceRefresh,
        // Qoder CN's device token is its chat token too, so the chat pair
        // is the rotated pair.
        ...(account.deviceChat === true
          ? {
              access: rotated.deviceToken,
              refresh: rotated.deviceRefresh,
              expires: rotated.expires,
            }
          : {}),
      },
    });
  }
  return rotated;
}

/** The plugin's `/api/v1/deviceToken/refresh`: the rotated pair, or null. */
async function refreshQoderDevice(
  account: QoderAccount,
  options: QoderRequestOptions,
): Promise<RotatedDevice | null> {
  // qoder and qoder-cn set no refresh target, so the body carries the
  // refresh token alone, as the plugin's `deviceRefreshBody` has it.
  const base = options.baseUrl ?? `${OPENAPI[account.site]}${CAMPAIGNS}`;
  try {
    const response = await (options.fetch ?? globalThis.fetch)(
      `${new URL(base).origin}/api/v1/deviceToken/refresh`,
      {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: account.deviceRefresh ?? "" }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
    );
    if (!response.ok) return null;
    const parsed = (await response.json()) as Record<string, unknown>;
    let token = "";
    if (typeof parsed.token === "string") token = parsed.token;
    if (token === "" && typeof parsed.device_token === "string") token = parsed.device_token;
    const refresh = typeof parsed.refresh_token === "string" ? parsed.refresh_token : "";
    if (token === "" || refresh === "") return null;
    return {
      deviceToken: token,
      deviceRefresh: refresh,
      expires: deviceExpiry(parsed),
    };
  } catch {
    return null;
  }
}

/** When a device token ends, as the plugin's `deviceExpiry` reads it. */
function deviceExpiry(value: Record<string, unknown>): number {
  const at = Date.parse(String(value.expires_at ?? "").trim());
  if (!Number.isNaN(at)) return at;
  const seconds = typeof value.expires_in === "number" ? value.expires_in : 0;
  if (seconds > 0) return Date.now() + seconds * 1000;
  return Date.now() + DAY_MS;
}

interface QoderCampaign {
  id: string;
  claimStatus: string;
  startAt?: number;
  endAt?: number;
  amount: number;
}

function campaignList(body: Record<string, unknown>): QoderCampaign[] {
  const raw = Array.isArray(body.campaigns) ? body.campaigns : [];
  return raw
    .map(asCampaign)
    .filter((campaign) => campaign.actionType === "CLAIM_BENEFIT")
    .map((campaign) => ({
      id: campaign.id,
      claimStatus: campaign.claimStatus,
      startAt: campaign.startAt,
      endAt: campaign.endAt,
      amount: campaign.amount,
    }));
}

function asCampaign(value: unknown): QoderCampaign & { actionType: string } {
  const entry = asObject(value);
  const benefit = asObject(entry.benefit);
  return {
    id: typeof entry.campaignId === "string" ? entry.campaignId : "",
    actionType: typeof entry.actionType === "string" ? entry.actionType : "",
    claimStatus: typeof entry.claimStatus === "string" ? entry.claimStatus : "",
    startAt: when(entry.startAt),
    endAt: when(entry.endAt),
    amount: amountOf(benefit.amount),
  };
}

function claimStatus(body: Record<string, unknown>): string {
  const direct = body.status;
  if (typeof direct === "string") return direct;
  const nested = asObject(body.data).status;
  return typeof nested === "string" ? nested : "";
}

function claimAmount(body: Record<string, unknown>, campaign: QoderCampaign): number {
  const direct = amountOf(asObject(body.benefit).amount);
  if (direct > 0) return direct;
  const nested = amountOf(asObject(asObject(body.data).benefit).amount);
  if (nested > 0) return nested;
  return campaign.amount;
}

function result(outcome: "done" | "claimed", credit: number): CheckinResult {
  return credit > 0 ? { outcome, credit } : { outcome };
}

function withUntil(entry: CheckinResult, until: number | undefined): CheckinResult {
  return until === undefined
    ? entry
    : { ...entry, until: new Date(until + OPEN_ROOM_MS).toISOString() };
}

/** A campaign runs from its start (inclusive) to its end (exclusive). */
function active(campaign: QoderCampaign, nowMs: number): boolean {
  return (
    (campaign.startAt ?? Number.NEGATIVE_INFINITY) <= nowMs &&
    nowMs < (campaign.endAt ?? Number.POSITIVE_INFINITY)
  );
}

/** When the campaign after c is expected to open. */
function nextOpens(campaign: QoderCampaign): number | undefined {
  if (campaign.endAt === undefined) return undefined;
  if (campaign.startAt === undefined) return campaign.endAt;
  return Math.max(campaign.endAt, campaign.startAt + DAY_MS);
}

function nextOpening(campaigns: readonly QoderCampaign[], nowMs: number): number | undefined {
  const times = campaigns.flatMap((campaign) => [campaign.startAt, nextOpens(campaign)]);
  const future = times.filter((time): time is number => time !== undefined && time > nowMs);
  return future.length > 0 ? Math.min(...future) : undefined;
}

/** Qoder's times are seconds or milliseconds, as numbers or text. */
function when(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n > 1e12 ? n : n * 1000;
}

function amountOf(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** The next Beijing midnight, so a missing identity isn't asked again today. */
function nextBeijingMidnight(now: Date): string {
  const shifted = now.getTime() + BEIJING_OFFSET_MS;
  const dayStart = Math.floor(shifted / DAY_MS) * DAY_MS;
  return new Date(dayStart + DAY_MS - BEIJING_OFFSET_MS).toISOString();
}

function noCampaign(site: QoderSite): string {
  const name = RUNTIMES[site].name;
  return `${name} check-in: ${name} offered this device's identity, read from this machine's own ${name} runtime-info, no daily credits campaign right now. ${name} decides per device whether to offer it; if ${name} desktop shows today's credits, claim them there`;
}

function unreadable(what: string, text: string): CheckinResult {
  const said = text.trim().slice(0, 120);
  return {
    outcome: "failed",
    msg: `${what}: unreadable reply ${said !== "" ? said : "(empty)"}`,
  };
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * The machine headers Qoder asks its own helper for. Qoder CN goes on
 * without them when the helper is missing; Qoder refuses the daily credits
 * without them, so there a missing helper is the day's answer.
 */
async function campaignIdentity(
  account: QoderAccount,
  options: QoderIdentityOptions = {},
): Promise<{ headers: Record<string, string>; unread?: Error }> {
  const runtime = RUNTIMES[account.site];
  try {
    return { headers: await campaignMachine(account.uid, runtime, options) };
  } catch (error) {
    if (runtime.required) throw error;
    return { headers: {}, unread: toError(error) };
  }
}

async function campaignMachine(
  uid: string,
  runtime: RuntimeConfig,
  options: QoderIdentityOptions,
): Promise<Record<string, string>> {
  if (uid === "") {
    throw new Error(
      `${runtime.name} check-in: device identity needs the account uid; sign in again`,
    );
  }
  const platform = options.platform ?? process.platform;
  const file = await campaignRuntime(runtime, options);
  const args =
    platform === "linux" ? [runtime.environment] : [runtime.environment, "--account-stdin"];
  const stdin = platform === "linux" ? undefined : `${JSON.stringify({ account: uid })}\n`;
  let text: string;
  try {
    text = await (options.runRuntime ?? runRuntime)({
      file,
      args,
      stdin,
      timeoutMs: CAMPAIGN_MACHINE_TIMEOUT_MS,
    });
  } catch {
    throw new QoderRuntimeError(runtime, "read");
  }
  const first = text.trim().split(/\r?\n/, 1)[0] ?? "";
  try {
    const identity = JSON.parse(first) as unknown;
    const headers: Record<string, string> = {};
    for (const [header, field] of [
      ["Cosy-MachineToken", "machineToken"],
      ["Cosy-MachineType", "machineType"],
    ] as const) {
      const value = asObject(identity)[field];
      if (
        typeof value !== "string" ||
        value.trim() === "" ||
        value.trim().length > 4096 ||
        !/^[\x20-\x7e]+$/.test(value.trim())
      ) {
        throw new Error("invalid identity");
      }
      headers[header] = value.trim();
    }
    return headers;
  } catch {
    throw new QoderRuntimeError(runtime, "invalid");
  }
}

/** The helper Qoder's desktop or CLI keeps, as the plugin's `campaignRuntime`. */
async function campaignRuntime(
  runtime: RuntimeConfig,
  options: QoderIdentityOptions = {},
): Promise<string> {
  const home = options.home ?? homedir();
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const env = options.env ?? process.env;
  const opt = options.opt ?? "/opt";
  const override = env[runtime.override];
  if (override !== undefined && override !== "") return resolve(override);

  const name = platform === "win32" ? "runtime-info.exe" : "runtime-info";
  for (const path of runtimePaths(runtime, { home, platform, env, opt, name })) {
    if (await isFile(path)) return path;
  }
  const cached = await cachedRuntime(runtime, { home, platform, arch, env });
  if (cached !== undefined) return cached;
  throw new QoderRuntimeMissingError(runtime);
}

/** The desktop's own runtime-info, in the order the plugin looks. */
function runtimePaths(
  runtime: RuntimeConfig,
  input: {
    home: string;
    platform: NodeJS.Platform;
    env: NodeJS.ProcessEnv;
    opt: string;
    name: string;
  },
): string[] {
  const { home, platform, env, opt, name } = input;
  if (platform === "win32") {
    const local = env.LOCALAPPDATA || join(home, "AppData", "Local");
    const paths = [join(local, "Programs", runtime.app, "resources", "umid", name)];
    for (const dir of [env.ProgramFiles || env.PROGRAMFILES, env.ProgramW6432]) {
      if (dir !== undefined && dir !== "") {
        paths.push(join(dir, runtime.app, "resources", "umid", name));
      }
    }
    return paths;
  }
  if (platform === "darwin") {
    return ["/Applications", join(home, "Applications")].map((dir) =>
      join(dir, `${runtime.app}.app`, "Contents", "Resources", "umid", name),
    );
  }
  if (platform === "linux") {
    return [join(opt, runtime.linux, "resources", "umid", name)];
  }
  return [];
}

/** The CLI's cached runtime-info, newest first, if any. */
async function cachedRuntime(
  runtime: RuntimeConfig,
  input: {
    home: string;
    platform: NodeJS.Platform;
    arch: string;
    env: NodeJS.ProcessEnv;
  },
): Promise<string | undefined> {
  const { home, platform, arch, env } = input;
  const name = platform === "win32" ? "runtime-info.exe" : "runtime-info";
  const cli = (key: string) => env[`${runtime.cli}${key}`];
  const config =
    cli("CONFIG_DIR") ||
    join(cli("CLI_HOME") || env.GEMINI_CLI_HOME || home, cli("CONFIG_DIR_NAME") || runtime.dir);
  const cache = join(config, ".bin");
  const entries = await readdir(cache, { withFileTypes: true }).catch(() => []);
  const found: Array<{ path: string; time: number }> = [];
  for (const entry of entries) {
    const path = cachedCandidate(entry, platform, arch, cache, name);
    if (path !== undefined && (await isFile(path))) {
      const info = await stat(path).catch(() => null);
      found.push({ path, time: info?.mtimeMs ?? 0 });
    }
  }
  found.sort((a, b) => b.time - a.time);
  return found[0]?.path;
}

function cachedCandidate(
  entry: { name: string; isFile: () => boolean; isDirectory: () => boolean },
  platform: NodeJS.Platform,
  arch: string,
  cache: string,
  name: string,
): string | undefined {
  if (platform === "win32") {
    return entry.isDirectory() && entry.name.startsWith(`umid-win32-${arch}-`)
      ? join(cache, entry.name, name)
      : undefined;
  }
  if (
    entry.isFile() &&
    entry.name.startsWith(`runtime-info-${platform}-${arch}-`) &&
    !entry.name.endsWith(".tmp")
  ) {
    return join(cache, entry.name);
  }
  return undefined;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** The helper's output, through the real child process. */
function runRuntime(input: {
  file: string;
  args: string[];
  stdin?: string;
  timeoutMs: number;
}): Promise<string> {
  return new Promise((resolveText, reject) => {
    const child = execFile(
      input.file,
      input.args,
      { timeout: input.timeoutMs, windowsHide: true, maxBuffer: 1 << 20, encoding: "utf8" },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolveText(String(stdout));
      },
    );
    child.stdin?.on("error", () => {});
    if (input.stdin !== undefined) child.stdin?.end(input.stdin);
  });
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
