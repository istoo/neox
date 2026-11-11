import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { copilotHostOf } from "./copilot-signin.js";
import type { CopilotAccount } from "./subscription-store.js";
import { subscriptionAccountId } from "./subscription-store.js";

/**
 * The Copilot sign-ins the user's own tools keep
 * (`provider/account.go:1361-1389`, `provider/copilot_cli.go:106-150`):
 * Copilot's editors in `~/.config/github-copilot/{apps,hosts}.json`, and
 * the standalone Copilot CLI in `~/.copilot/config.json`. Neolix reads
 * them and never writes them, as myna does; they are listed as the user's
 * own accounts (`own: true` in myna) and can serve requests.
 *
 * The CLI keeps its token in the system keychain unless the user chose
 * plaintext. Neolix does not read the keychain; a token in the file is
 * taken, and a keychain-only sign-in is left out rather than guessed at.
 */

export interface CopilotOwnLogin {
  /** The GitHub login, on github.com or an enterprise's host. */
  login: string;
  /** The account as the list names it: `login` or `login@host`. */
  user: string;
  token: string;
  /** "" for github.com, "<name>.ghe.com" for an enterprise. */
  host: string;
  /** True for the standalone Copilot CLI's sign-in. */
  cli: boolean;
  /** The file it was read from. */
  source: string;
}

export interface CopilotOwnOptions {
  home?: string;
  /** The XDG config directory holding `github-copilot/`; `~/.config` by default. */
  configDir?: string;
  readFileImpl?: (path: string) => Promise<string>;
  /** The user's "read no sign-in" switch; off, none of the files is read. */
  discovery?: boolean;
}

export async function readCopilotOwnLogins(
  options: CopilotOwnOptions = {},
): Promise<CopilotOwnLogin[]> {
  // myna's AccountDiscoveryOff: the editors' files and the CLI's are left
  // unread, like every other agent's own sign-in.
  if (options.discovery === false) {
    return [];
  }
  const home = options.home ?? homedir();
  const configDir = options.configDir ?? join(home, ".config");
  const read = options.readFileImpl ?? ((path: string) => readFile(path, "utf8"));
  const out = await editorLogins(configDir, read);
  const cliSource = join(home, ".copilot", "config.json");
  try {
    const text = stripJsonc(await read(cliSource));
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed)) {
      out.push(...cliLogins(parsed, cliSource));
    }
  } catch {
    // no CLI sign-in, or one this build can't read
  }
  return out;
}

/** Copilot's editors' sign-ins: one per host, github.com first. */
async function editorLogins(
  configDir: string,
  read: (path: string) => Promise<string>,
): Promise<CopilotOwnLogin[]> {
  const out: CopilotOwnLogin[] = [];
  for (const name of ["apps.json", "hosts.json"]) {
    const source = join(configDir, "github-copilot", name);
    const parsed = await readJsonFile(read, source);
    if (parsed === null) {
      continue;
    }
    for (const [key, value] of Object.entries(parsed)) {
      if (!isRecord(value)) {
        continue;
      }
      const token = typeof value.oauth_token === "string" ? value.oauth_token : "";
      if (token === "") {
        continue;
      }
      const hostPart = key.includes(":") ? (key.split(":")[0] ?? "") : key;
      const host = copilotHostOf(hostPart);
      if ("error" in host) {
        continue;
      }
      if (out.some((login) => login.host === host.host)) {
        continue;
      }
      const user = typeof value.user === "string" ? value.user : "";
      out.push({
        login: user,
        user: host.host === "" || user === "" ? user : `${user}@${host.host}`,
        token,
        host: host.host,
        cli: false,
        source,
      });
    }
  }
  return out;
}

async function readJsonFile(
  read: (path: string) => Promise<string>,
  source: string,
): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await read(source));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function cliLogins(config: Record<string, unknown>, source: string): CopilotOwnLogin[] {
  const users: Record<string, unknown>[] = [];
  if (isRecord(config.lastLoggedInUser)) {
    users.push(config.lastLoggedInUser);
  }
  if (Array.isArray(config.loggedInUsers)) {
    for (const user of config.loggedInUsers) {
      if (isRecord(user)) {
        users.push(user);
      }
    }
  }
  const tokens = isRecord(config.copilotTokens) ? config.copilotTokens : {};
  const out: CopilotOwnLogin[] = [];
  for (const user of users) {
    const login = typeof user.login === "string" ? user.login : "";
    const rawHost = typeof user.host === "string" ? user.host : "";
    const host = copilotHostOf(rawHost);
    if (login === "" || "error" in host) {
      continue;
    }
    const key =
      host.host === "" ? `https://github.com:${login}` : `${rawHost.replace(/\/+$/, "")}:${login}`;
    const token = typeof tokens[key] === "string" ? (tokens[key] as string) : "";
    if (token === "") {
      // Keychain-only sign-ins are not read: see the module comment.
      continue;
    }
    out.push({
      login,
      user: host.host === "" ? login : `${login}@${host.host}`,
      token,
      host: host.host,
      cli: true,
      source,
    });
  }
  return out;
}

/** The own logins as accounts the gateway can serve with. */
export function ownLoginAccount(login: CopilotOwnLogin): CopilotAccount {
  return {
    agent: "copilot",
    id: subscriptionAccountId("copilot", login.login, login.host),
    user: login.user,
    plan: null,
    addedAt: 0,
    lapsed: null,
    githubToken: login.token,
    host: login.host,
    own: true,
    proxy: null,
  };
}

/** JSONC's comments, without touching a string that holds `//`. */
function stripJsonc(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] ?? "";
    if (inString) {
      out += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") {
        i += 1;
      }
      out += "\n";
      continue;
    }
    if (char === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) {
        i += 1;
      }
      i += 1;
      continue;
    }
    out += char;
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
