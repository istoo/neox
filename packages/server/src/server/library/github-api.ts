import type { SecretsStore } from "./github-token.js";

/**
 * myna's `internal/ghtoken`: the token Neolix's GitHub API requests carry,
 * where it comes from, and what to do when GitHub turns it away.
 *
 * Sources, in order: the token set in Settings (secrets.json here), then
 * `GITHUB_TOKEN`, then `GH_TOKEN`. It goes to GitHub's API host alone —
 * never to codeload, raw files or a mirror — and never into a log or an
 * error. A 401 drops that token for the rest of the run and the request is
 * asked again without it; a refused Settings token is remembered so the
 * page can say it needs replacing, and the environment's token is not used
 * in its place.
 */

/** The hosts a token may go to. */
const API_HOST = "api.github.com";
export const GITHUB_TOKEN_ENV = ["GITHUB_TOKEN", "GH_TOKEN"] as const;

export type GithubTokenOrigin = "settings" | "GITHUB_TOKEN" | "GH_TOKEN";

export interface GithubTokenChoice {
  token: string;
  from: GithubTokenOrigin | "";
}

const refused = new Set<string>();
let settingsRefused: { token: string; at: number } | null = null;

/** Forgets refusals; tests use it between cases. */
export function resetGithubTokenStateForTests(): void {
  refused.clear();
  settingsRefused = null;
}

/** The token to use and where it came from; refused ones are not tokens. */
export async function resolveGithubToken(
  store: SecretsStore,
  env: NodeJS.ProcessEnv = process.env,
): Promise<GithubTokenChoice> {
  const settingsToken = (await store.githubToken())?.trim() ?? "";
  if (settingsToken !== "") {
    return refused.has(settingsToken)
      ? { token: "", from: "" }
      : { token: settingsToken, from: "settings" };
  }
  for (const name of GITHUB_TOKEN_ENV) {
    const token = (env[name] ?? "").trim();
    if (token !== "" && !refused.has(token)) {
      return { token, from: name };
    }
  }
  return { token: "", from: "" };
}

/** When GitHub refused the token currently in Settings, if it did. */
export function githubSettingsRefused(currentToken: string | null): { at: number } | null {
  const token = currentToken?.trim() ?? "";
  if (token === "" || settingsRefused === null || settingsRefused.token !== token) {
    return null;
  }
  return { at: settingsRefused.at };
}

export interface GithubRequestOptions {
  store: SecretsStore;
  /** The API base, moved in tests. */
  apiBase?: string;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

export interface GithubResponse {
  response: Response;
  /** Whether the answer came from a request that carried the token. */
  usedToken: boolean;
}

function apiHost(apiBase: string): string | null {
  try {
    return new URL(apiBase).host;
  } catch {
    return null;
  }
}

/**
 * fetch for GitHub's API: carries the token to that host only, and asks
 * again without it when GitHub refuses it (401), so a stale token costs the
 * rate limit, not the whole check.
 */
export async function githubFetch(
  url: string | URL,
  init: RequestInit,
  options: GithubRequestOptions,
): Promise<GithubResponse> {
  const target = new URL(String(url));
  const host = apiHost(options.apiBase ?? `https://${API_HOST}`);
  const fetchImpl = options.fetchImpl ?? fetch;
  const choice = await resolveGithubToken(options.store, options.env ?? process.env);
  const carries = choice.token !== "" && host !== null && target.host === host;
  const first = await fetchImpl(target, carries ? withToken(init, choice.token) : init);
  if (!carries || first.status !== 401) {
    return { response: first, usedToken: carries };
  }

  refused.add(choice.token);
  if (choice.from === "settings") {
    settingsRefused = { token: choice.token, at: Date.now() };
  }
  await first.body?.cancel().catch(() => undefined);
  const again = await fetchImpl(target, withoutToken(init));
  return { response: again, usedToken: false };
}

/** The headers a request carrying the token has. */
export function withToken(init: RequestInit, token: string): RequestInit {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  return { ...init, headers };
}

function withoutToken(init: RequestInit): RequestInit {
  const headers = new Headers(init.headers);
  headers.delete("authorization");
  return { ...init, headers };
}

/** GitHub turning requests away for a while: until when, and with a token or not. */
export class GithubRateLimited extends Error {
  constructor(
    public readonly until: Date | null,
    public readonly token: boolean,
  ) {
    super(
      token
        ? `GitHub's rate limit for your GitHub token is used up${until === null ? " for a while" : ` until ${until.toLocaleTimeString()}`}; try again then`
        : `GitHub's rate limit for requests without a token (60 an hour) is used up${until === null ? " for a while" : ` until ${until.toLocaleTimeString()}`}. Add a GitHub token in Settings → Network and sharing to raise it to 5,000 an hour`,
    );
    this.name = "GithubRateLimited";
  }
}

/** The rate limit a refusal says, or null when it is not one (429, or a 403 that names one). */
export function githubLimitedBy(
  response: Response,
  body: string,
  token: boolean,
): GithubRateLimited | null {
  const message = body.toLowerCase();
  const limited =
    response.status === 429 ||
    (response.status === 403 &&
      (response.headers.get("x-ratelimit-remaining") === "0" ||
        response.headers.get("retry-after") !== null ||
        message.includes("rate limit")));
  if (!limited) {
    return null;
  }
  return new GithubRateLimited(limitUntil(response), token);
}

/** When GitHub's limit ends, from its reset header or a secondary limit's Retry-After. */
function limitUntil(response: Response): Date | null {
  const reset = Number.parseInt(response.headers.get("x-ratelimit-reset") ?? "", 10);
  if (Number.isFinite(reset) && reset > 0) {
    return new Date(reset * 1_000);
  }
  const retry = Number.parseInt(response.headers.get("retry-after") ?? "", 10);
  return Number.isFinite(retry) && retry > 0 ? new Date(Date.now() + retry * 1_000) : null;
}

/** The 401 message for a request that carried the token; never the token itself. */
export function githubRefused(origin: GithubTokenOrigin | "", settingsRejected: boolean): Error {
  const where =
    origin === "settings" || settingsRejected
      ? "the GitHub token in Settings → Network and sharing"
      : `${origin || "no token"} (no GitHub token is set in Settings → Network and sharing)`;
  return new Error(`GitHub refused ${where}: it may have expired or been revoked`);
}
