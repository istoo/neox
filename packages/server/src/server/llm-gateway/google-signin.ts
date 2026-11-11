import { antigravityModelsOf, type AntigravityModel } from "./codeassist.js";
import { errorMessage, isRecord, readJson } from "./oauth.js";
import { fetchThroughProxy } from "./proxy-fetch.js";
import type { GoogleSubscriptionAccount } from "./subscription-store.js";
import { subscriptionAccountId } from "./subscription-store.js";

/**
 * Google's sign-ins: Gemini CLI's and Antigravity's (`provider/google.go`).
 * Each app borrows its own OAuth client; Neolix keeps the tokens and finds
 * the Google Cloud project Code Assist bills. Nothing of Gemini CLI's own
 * `~/.gemini` is written.
 */

export type GoogleAgent = "gemini" | "antigravity";

export interface GoogleApp {
  agent: GoogleAgent;
  name: string;
  clientId: string;
  clientSecret: string;
  scopes: string[];
  /** The path the browser comes back to. */
  callbackPath: string;
  /** The host it comes back to. */
  loopback: string;
  /** Where Code Assist requests go. */
  base: string;
  /** Where the account's project is found. */
  loadBase: string;
}

const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo?alt=json";
const CLOUDCODE = "https://cloudcode-pa.googleapis.com";
const DAILY_CLOUDCODE = "https://daily-cloudcode-pa.googleapis.com";

/** The Antigravity build Neolix says it is; myna's fallback (`google.go:485`). */
const ANTIGRAVITY_VERSION = "2.9.1";
/** Where Antigravity's updater says its newest build is (`google.go:68`). */
const ANTIGRAVITY_VERSION_URL =
  "https://antigravity-hub-auto-updater-974169037036.us-central1.run.app/manifest/latest-arm64-mac.yml";
/** How long a version the updater gave is kept (`google.go:471`). */
const ANTIGRAVITY_VERSION_TTL_MS = 6 * 60 * 60_000;

let antigravityVersion = ANTIGRAVITY_VERSION;
let antigravityVersionAt = 0;
let antigravityPending: Promise<void> | null = null;
/** The Gemini CLI version myna says it is (`google.go:108`). */
const GEMINI_CLI_VERSION = "0.61.0";
/** How long one onboardUser poll waits (`google.go:777`: 2s). */
const ONBOARD_POLL_MS = 2000;

export function googleAppOf(agent: GoogleAgent): GoogleApp {
  if (agent === "antigravity") {
    return {
      agent,
      name: "Antigravity",
      // Antigravity's own OAuth client (`google.go:87-97`).
      clientId: "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com",
      clientSecret: "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",
      scopes: [
        "https://www.googleapis.com/auth/cloud-platform",
        "https://www.googleapis.com/auth/userinfo.email",
        "https://www.googleapis.com/auth/userinfo.profile",
        "https://www.googleapis.com/auth/cclog",
        "https://www.googleapis.com/auth/experimentsandconfigs",
      ],
      callbackPath: "/oauth-callback",
      loopback: "localhost",
      base: DAILY_CLOUDCODE,
      loadBase: CLOUDCODE,
    };
  }
  return {
    agent: "gemini",
    name: "Gemini CLI",
    // Gemini CLI's own OAuth client, an installed app's (`google.go:74-84`);
    // its "secret" ships in the CLI and is no secret.
    clientId: "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com",
    clientSecret: "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",
    scopes: [
      "https://www.googleapis.com/auth/cloud-platform",
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/userinfo.profile",
    ],
    callbackPath: "/oauth2callback",
    loopback: "127.0.0.1",
    base: CLOUDCODE,
    loadBase: CLOUDCODE,
  };
}

/** What the sign-in says before a Google account is added (`google.go:104-105`). */
export const ANTIGRAVITY_RISK =
  "Google may suspend an Antigravity account it sees used outside Antigravity. Use one you can afford to lose.";

export interface GoogleSignInStart {
  url: string;
  state: string;
  verifier: string;
  redirectUri: string;
}

/** Google's page, as myna opens it (`google.go:690-...`). */
export function startGoogleSignIn(input: {
  agent: GoogleAgent;
  redirectUri: string;
  state: string;
  verifier: string;
  challenge: string;
}): GoogleSignInStart {
  const app = googleAppOf(input.agent);
  const query = new URLSearchParams({
    client_id: app.clientId,
    redirect_uri: input.redirectUri,
    response_type: "code",
    scope: app.scopes.join(" "),
    access_type: "offline",
    prompt: "consent",
    state: input.state,
    code_challenge: input.challenge,
    code_challenge_method: "S256",
  });
  return {
    url: `${AUTHORIZE_URL}?${query.toString()}`,
    state: input.state,
    verifier: input.verifier,
    redirectUri: input.redirectUri,
  };
}

export interface GoogleOptions {
  fetchImpl?: typeof fetch;
  /** The proxy the sign-in, its refreshes and Code Assist calls go through. */
  proxy?: string;
  now?: () => number;
  /** Overridable so a test never reaches Google. */
  tokenUrl?: string;
  userInfoUrl?: string;
  cloudCodeUrl?: string;
  cloudCodeDailyUrl?: string;
  /** The wait between onboardUser polls; 0 in tests. */
  onboardPollMs?: number;
  /** Where Antigravity's newest build is asked for. */
  antigravityVersionUrl?: string;
}

export interface GoogleCompleteInput extends GoogleOptions {
  agent: GoogleAgent;
  code: string;
  verifier: string;
  redirectUri: string;
  addedAt?: number;
}

/** Trades a sign-in's code for the account (`google.go:1630-1657`). */
export async function completeGoogleSignIn(
  input: GoogleCompleteInput,
): Promise<{ account: GoogleSubscriptionAccount } | { error: string }> {
  const app = googleAppOf(input.agent);
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: app.clientId,
    client_secret: app.clientSecret,
    code_verifier: input.verifier,
  });
  let response: Response;
  try {
    response = await fetchThroughProxy(input.proxy, input.fetchImpl)(input.tokenUrl ?? TOKEN_URL, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: form.toString(),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    return { error: `${app.name} sign-in: couldn't reach Google: ${errorMessage(error)}` };
  }
  const body = await readJson(response);
  if (!response.ok) {
    return { error: `${app.name} sign-in: Google refused the code (${response.status})` };
  }
  if (!isRecord(body)) {
    return { error: `${app.name} sign-in: Google's token answer didn't read` };
  }
  const accessToken = typeof body.access_token === "string" ? body.access_token : "";
  const refreshToken = typeof body.refresh_token === "string" ? body.refresh_token : "";
  const expiresIn = typeof body.expires_in === "number" ? body.expires_in : 0;
  if (accessToken === "" || refreshToken === "") {
    return { error: `${app.name} sign-in: Google sent back no token` };
  }
  const now = input.now?.() ?? Date.now();
  let account: GoogleSubscriptionAccount = {
    agent: input.agent,
    id: "",
    user: "",
    plan: null,
    addedAt: input.addedAt ?? now,
    lapsed: null,
    accessToken,
    refreshToken,
    expiresAt: expiresIn > 0 ? now + expiresIn * 1000 : 0,
    project: null,
  };
  if (input.agent === "antigravity") {
    await refreshAntigravityVersion(input);
  }
  const who = await googleWho(account, input);
  if ("error" in who) {
    return { error: who.error };
  }
  account = { ...account, user: who.email, id: subscriptionAccountId(input.agent, who.email) };
  // Kept even when Code Assist has no project for it yet: a Standard or
  // Enterprise account gets one named afterwards.
  const project = await discoverGoogleProject(account, input);
  if ("project" in project) {
    account = { ...account, project: project.project, plan: project.plan };
  }
  return { account };
}

/** Whose Google account a token is (`google.go:1662-1684`). */
async function googleWho(
  account: GoogleSubscriptionAccount,
  options: GoogleOptions,
): Promise<{ email: string } | { error: string }> {
  let response: Response;
  try {
    response = await fetchThroughProxy(options.proxy, options.fetchImpl)(
      options.userInfoUrl ?? USERINFO_URL,
      {
        method: "GET",
        headers: { authorization: `Bearer ${account.accessToken}` },
        signal: AbortSignal.timeout(30_000),
      },
    );
  } catch (error) {
    return {
      error: `${appName(account.agent)} sign-in: couldn't ask Google whose account it is: ${errorMessage(error)}`,
    };
  }
  const body = await readJson(response);
  if (!response.ok || !isRecord(body) || typeof body.email !== "string" || body.email === "") {
    return { error: `${appName(account.agent)} sign-in: Google didn't say whose account this is` };
  }
  return { email: body.email };
}

export interface GoogleProject {
  project: string;
  plan: string | null;
}

/**
 * The Google Cloud project Code Assist bills, found the way the app does
 * it (`google.go:565-720`, `google.go:736-...`). A Standard or Enterprise
 * account without one is reported, so the page can ask for it.
 */
export async function discoverGoogleProject(
  account: GoogleSubscriptionAccount,
  options: GoogleOptions = {},
): Promise<GoogleProject | { error: string }> {
  const app = googleAppOf(account.agent);
  if (account.agent === "antigravity") {
    await refreshAntigravityVersion(options);
  }
  const cloudCode = options.cloudCodeUrl ?? app.loadBase;
  const load = await codeAssistCall(account, options, cloudCode, "loadCodeAssist", {
    metadata: projectMetadata(account.agent),
  });
  if ("error" in load) {
    return { error: load.error };
  }
  const plan = planOf(load.body);
  const found = companionProjectOf(load.body.cloudaicompanionProject);
  if (found !== "") {
    return { project: found, plan };
  }
  // Gemini CLI's path stops here for an account on a tier that bills its
  // own project; Antigravity onboards the account instead.
  if (isRecord(load.body.currentTier) && account.agent !== "antigravity") {
    return { error: needsProject(account.agent) };
  }
  return onboardGoogleProject(account, options, load.body, plan, cloudCode);
}

/** Sets the account up for Code Assist, as its app does on first run. */
async function onboardGoogleProject(
  account: GoogleSubscriptionAccount,
  options: GoogleOptions,
  load: Record<string, unknown>,
  plan: string | null,
  cloudCode: string,
): Promise<GoogleProject | { error: string }> {
  const app = googleAppOf(account.agent);
  const tier = defaultTier(load.allowedTiers);
  if (tier === null) {
    return { error: needsProject(account.agent) };
  }
  let base = cloudCode;
  let request: Record<string, unknown>;
  let headers: Record<string, string> | undefined;
  if (account.agent === "antigravity") {
    base = options.cloudCodeDailyUrl ?? app.base;
    request = {
      tier_id: tier.id === "legacy-tier" ? "free-tier" : tier.id,
      metadata: {
        ide_type: "ANTIGRAVITY",
        ide_version: ANTIGRAVITY_VERSION,
        ide_name: "antigravity",
      },
    };
    headers = {
      "User-Agent": `${googleUserAgent(account.agent)} google-api-nodejs-client/10.3.0`,
      "X-Goog-Api-Client": "gl-node/22.21.1",
    };
  } else {
    request = { tierId: tier.id, metadata: projectMetadata(account.agent) };
  }
  const onboard = await codeAssistCall(
    account,
    options,
    base,
    "onboardUser",
    request,
    headers,
    options.onboardPollMs ?? ONBOARD_POLL_MS,
  );
  if ("error" in onboard) {
    return { error: onboard.error };
  }
  const response = isRecord(onboard.body.response) ? onboard.body.response : {};
  const id = companionProjectOf(response.cloudaicompanionProject);
  if (id === "") {
    return { error: noProjectAfterOnboard(account.agent) };
  }
  return { project: id, plan: tier.name ?? plan };
}

function projectMetadata(agent: GoogleAgent): Record<string, string> {
  if (agent === "antigravity") {
    return { ideType: "ANTIGRAVITY" };
  }
  return { ideType: "IDE_UNSPECIFIED", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" };
}

function planOf(load: Record<string, unknown>): string | null {
  const paid = isRecord(load.paidTier) ? load.paidTier : null;
  const current = isRecord(load.currentTier) ? load.currentTier : null;
  return tierName(paid) ?? tierName(current);
}

function noProjectAfterOnboard(agent: GoogleAgent): string {
  if (agent === "antigravity") {
    return "Antigravity hasn't set this Google account up (it gave no project); sign in to the Antigravity app with it once, then try again";
  }
  return needsProject(agent);
}

/** A live access token, refreshed in memory when it is near expiring (`google.go:406-438`). */
export async function refreshGoogleAccount(
  account: GoogleSubscriptionAccount,
  options: GoogleOptions = {},
): Promise<
  { account: GoogleSubscriptionAccount; refreshed: boolean } | { error: string; lapsed?: string }
> {
  const now = options.now?.() ?? Date.now();
  if (account.lapsed !== null) {
    return { error: account.lapsed, lapsed: account.lapsed };
  }
  if (account.accessToken !== "" && account.expiresAt - now > 2 * 60_000) {
    return { account, refreshed: false };
  }
  const app = googleAppOf(account.agent);
  const form = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: account.refreshToken,
    client_id: app.clientId,
    client_secret: app.clientSecret,
  });
  let response: Response;
  try {
    response = await fetchThroughProxy(options.proxy, options.fetchImpl)(
      options.tokenUrl ?? TOKEN_URL,
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body: form.toString(),
        signal: AbortSignal.timeout(30_000),
      },
    );
  } catch (error) {
    if (account.accessToken !== "" && account.expiresAt > now) {
      return { account, refreshed: false };
    }
    return { error: `${app.name} token refresh: ${errorMessage(error)}` };
  }
  const body = await readJson(response);
  if (!response.ok || !isRecord(body) || typeof body.access_token !== "string") {
    const lapsed = `${account.user} is signed out of ${app.name}; sign in again`;
    return { error: lapsed, lapsed };
  }
  const expiresIn = typeof body.expires_in === "number" ? body.expires_in : 0;
  return {
    account: {
      ...account,
      accessToken: body.access_token,
      expiresAt: expiresIn > 0 ? now + expiresIn * 1000 : 0,
      lapsed: null,
    },
    refreshed: true,
  };
}

async function codeAssistCall(
  account: GoogleSubscriptionAccount,
  options: GoogleOptions,
  base: string,
  method: string,
  body: Record<string, unknown>,
  headers?: Record<string, string>,
  pollMs = 0,
): Promise<{ body: Record<string, unknown> } | { error: string }> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    let response: Response;
    try {
      response = await fetchThroughProxy(options.proxy, options.fetchImpl)(
        `${base}/v1internal:${method}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${account.accessToken}`,
            "user-agent": googleUserAgent(account.agent),
            ...headers,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(60_000),
        },
      );
    } catch (error) {
      return { error: `${appName(account.agent)}: ${errorMessage(error)}` };
    }
    const answer = await readJson(response);
    if (!response.ok) {
      return { error: `${appName(account.agent)}: Code Assist refused (${response.status})` };
    }
    if (!isRecord(answer)) {
      return { error: `${appName(account.agent)}: Code Assist's answer didn't read` };
    }
    if (method !== "onboardUser" || answer.done !== false) {
      return { body: answer };
    }
    if (pollMs <= 0) {
      return { body: answer };
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return {
    error: `${appName(account.agent)}: setting the account up for Code Assist is taking long; try again in a minute`,
  };
}

function companionProjectOf(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (isRecord(value) && typeof value.id === "string") {
    return value.id;
  }
  return "";
}

function tierName(tier: Record<string, unknown> | null): string | null {
  if (tier === null) {
    return null;
  }
  if (typeof tier.name === "string" && tier.name !== "") {
    return tier.name;
  }
  return typeof tier.id === "string" && tier.id !== "" ? tier.id : null;
}

function defaultTier(value: unknown): { id: string; name: string | null } | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const tiers = value.filter(isRecord);
  const chosen = tiers.find((tier) => tier.isDefault === true) ?? tiers[0];
  if (chosen === undefined || typeof chosen.id !== "string" || chosen.id === "") {
    return null;
  }
  return { id: chosen.id, name: tierName(chosen) };
}

function needsProject(agent: GoogleAgent): string {
  return agent === "antigravity"
    ? "Antigravity hasn't set this Google account up (it gave no project); sign in to the Antigravity app with it once, then try again"
    : "Google serves Gemini CLI's sign-in only to Gemini Code Assist Standard and Enterprise accounts, which bill a Google Cloud project: name that project for this account. A personal Google account is served to Antigravity instead.";
}

/**
 * Asks Antigravity's updater for its newest build, at most every six hours
 * (`google.go:466-500`); an answer that doesn't come leaves the last one.
 */
export async function refreshAntigravityVersion(options: GoogleOptions = {}): Promise<void> {
  if (Date.now() - antigravityVersionAt < ANTIGRAVITY_VERSION_TTL_MS) {
    return;
  }
  antigravityPending ??= (async () => {
    try {
      const response = await fetchThroughProxy(options.proxy, options.fetchImpl)(
        options.antigravityVersionUrl ?? ANTIGRAVITY_VERSION_URL,
        {
          method: "GET",
          headers: { "user-agent": "electron-builder" },
          signal: AbortSignal.timeout(5_000),
        },
      );
      if (response.ok) {
        const text = await response.text();
        for (const line of text.split("\n")) {
          if (!line.startsWith("version:")) {
            continue;
          }
          const value = line
            .slice("version:".length)
            .trim()
            .replace(/^["']|["']$/g, "");
          if (value !== "" && /^[0-9.]+$/.test(value)) {
            antigravityVersion = value;
          }
          break;
        }
      }
    } catch {
      // the updater didn't answer: the last version stands
    } finally {
      antigravityVersionAt = Date.now();
      antigravityPending = null;
    }
  })();
  await antigravityPending;
}

/** What the app says it is to Code Assist (`google.go:441-457`). */
export function googleUserAgent(agent: GoogleAgent): string {
  if (agent === "antigravity") {
    return `antigravity/hub/${antigravityVersion} ${process.platform}/${process.arch}`;
  }
  const platform = process.platform === "win32" ? "win32" : process.platform;
  const arch = process.arch === "x64" ? "x64" : process.arch;
  return `GeminiCLI/${GEMINI_CLI_VERSION}/gemini-2.5-pro (${platform}; ${arch}; terminal)`;
}

function appName(agent: GoogleAgent): string {
  return agent === "antigravity" ? "Antigravity" : "Gemini CLI";
}

/**
 * The models an Antigravity account is offered, as its own picker lists
 * them (`fetchAvailableModels`, `google.go:985-1125`). A near-expiring
 * access token is renewed first, and handed back so its store can keep it.
 */
export async function fetchAntigravityModels(
  account: GoogleSubscriptionAccount,
  options: GoogleOptions = {},
): Promise<
  | { models: AntigravityModel[]; account: GoogleSubscriptionAccount; refreshed: boolean }
  | { error: string }
> {
  const live = await refreshGoogleAccount(account, options);
  if ("error" in live) {
    return { error: live.error };
  }
  const app = googleAppOf("antigravity");
  const body: Record<string, unknown> = {};
  if (account.project !== null && account.project !== "") {
    body.project = account.project;
  }
  const answer = await codeAssistCall(
    live.account,
    options,
    app.base,
    "fetchAvailableModels",
    body,
  );
  if ("error" in answer) {
    return { error: answer.error };
  }
  return {
    models: antigravityModelsOf(answer.body),
    account: live.account,
    refreshed: live.refreshed,
  };
}
