import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

/**
 * myna's Session terminal (gui/sessions.go:1043 openTerminal,
 * gui/terminal_apps*.go, gui/terminal_rex.go): a resumed session opens in the
 * Mac terminal the reader picked, through a .command file so no Automation
 * consent is asked. Ported from the desktop's system/terminals.ts; the daemon
 * builds the resume line from its own session list and opens it here, never a
 * shell string from the page.
 */

export interface SessionTerminalApp {
  id: string;
  name: string;
}

export interface SessionTerminalList {
  supported: boolean;
  apps: SessionTerminalApp[];
  /** The system's handler for `.command` files, when it can be read. */
  defaultId: string | null;
}

interface TerminalCandidate extends SessionTerminalApp {
  paths: string[];
}

const REX_ID = "com.superlogical.rex";
/** What Rex's own `rex new` names the session Neolix opens its tabs in. */
const REX_SESSION_LABEL = "Neox";

/**
 * The Mac terminals myna's Launch Services lookup returns in practice, by
 * bundle id, with the paths they usually sit at.
 */
const TERMINAL_CANDIDATES: readonly TerminalCandidate[] = [
  {
    id: "com.apple.Terminal",
    name: "Terminal",
    paths: ["/System/Applications/Utilities/Terminal.app", "/Applications/Utilities/Terminal.app"],
  },
  {
    id: "com.googlecode.iterm2",
    name: "iTerm",
    paths: ["/Applications/iTerm.app", "/Applications/iTerm2.app"],
  },
  { id: "dev.warp.Warp-Stable", name: "Warp", paths: ["/Applications/Warp.app"] },
  { id: "com.mitchellh.ghostty", name: "Ghostty", paths: ["/Applications/Ghostty.app"] },
  { id: "org.alacritty", name: "Alacritty", paths: ["/Applications/Alacritty.app"] },
  { id: "net.kovidgoyal.kitty", name: "kitty", paths: ["/Applications/kitty.app"] },
  { id: "com.github.wez.wezterm", name: "WezTerm", paths: ["/Applications/WezTerm.app"] },
  { id: "co.zeit.hyper", name: "Hyper", paths: ["/Applications/Hyper.app"] },
  { id: "org.tabby", name: "Tabby", paths: ["/Applications/Tabby.app"] },
];

/** The terminals installed here, in myna's order, from the standard paths. */
export async function installedTerminals(
  exists: (candidatePath: string) => boolean | Promise<boolean> = defaultExists,
  home: string = os.homedir(),
): Promise<SessionTerminalApp[]> {
  const found: SessionTerminalApp[] = [];
  for (const candidate of TERMINAL_CANDIDATES) {
    let installed = false;
    for (const candidatePath of candidate.paths) {
      if (await exists(candidatePath)) {
        installed = true;
        break;
      }
    }
    if (
      !installed &&
      (await exists(path.join(home, "Applications", path.basename(candidate.paths[0] ?? ""))))
    ) {
      installed = true;
    }
    if (installed) {
      found.push({ id: candidate.id, name: candidate.name });
    }
  }
  return found;
}

async function defaultExists(candidatePath: string): Promise<boolean> {
  try {
    await fs.access(candidatePath);
    return true;
  } catch {
    return false;
  }
}

/** The argument `open` needs for a chosen terminal; none opens the system's. */
export function terminalOpenArgs(app: string, installed: readonly SessionTerminalApp[]): string[] {
  if (app === "" || app === "system") {
    return [];
  }
  if (!installed.some((candidate) => candidate.id === app)) {
    throw new Error(`the selected terminal app "${app}" is no longer available`);
  }
  // Terminal is found by name, as myna opens it, so a moved install still works.
  return app === "com.apple.Terminal" ? ["-a", "Terminal"] : ["-b", app];
}

const BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;
/** Tokens a resume command may hold: no shell metacharacters, quotes or spaces inside. */
const SAFE_COMMAND_TOKEN = /^[A-Za-z0-9._:@/+=,-]+$/;
/** The binaries Neolix starts agents with; the command must open one of them. */
const AGENT_BINARIES = new Set([
  "claude",
  "codex",
  "opencode",
  "pi",
  "copilot",
  "gemini",
  "cursor-agent",
  "muse",
  "antigravity",
  "agy",
  "dsh",
  "crush",
]);

function controlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

/**
 * A resume command is the agent's binary and plain tokens (myna's sessions
 * compose it); punctuation that could start another command is refused.
 */
export function validateResumeCommand(command: string): string | null {
  const trimmed = command.trim();
  if (trimmed === "" || trimmed.length > 500) {
    return "the resume command is empty";
  }
  if (controlCharacters(trimmed)) {
    return "the resume command holds a control character";
  }
  const tokens = trimmed.split(/\s+/);
  for (const token of tokens) {
    if (!SAFE_COMMAND_TOKEN.test(token)) {
      return `the resume command holds an unsafe token: "${token}"`;
    }
  }
  if (!AGENT_BINARIES.has(tokens[0] ?? "")) {
    return `the resume command does not start an agent: "${tokens[0] ?? ""}"`;
  }
  return null;
}

export function validateTerminalRequest(
  input: { app?: unknown; command?: unknown; cwd?: unknown },
  installed: readonly SessionTerminalApp[],
): string | null {
  if (typeof input.app !== "string") {
    return "a terminal app is required";
  }
  if (input.app !== "" && input.app !== "system") {
    if (!BUNDLE_ID.test(input.app) || !installed.some((app) => app.id === input.app)) {
      return `the selected terminal app "${input.app}" is not available`;
    }
  }
  if (typeof input.command !== "string") {
    return "a resume command is required";
  }
  const commandError = validateResumeCommand(input.command);
  if (commandError !== null) {
    return commandError;
  }
  if (typeof input.cwd !== "string" || !path.isAbsolute(input.cwd)) {
    return "the working folder must be an absolute path";
  }
  if (input.cwd.includes("\0") || controlCharacters(input.cwd)) {
    return "the working folder holds a control character";
  }
  return null;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The .command file, as myna writes it: the resume, then the reader's shell. */
export function resumeScript(command: string, cwd: string): string {
  return `#!/bin/sh\ncd ${shellQuote(cwd)} && ${command.trim()}\nexec "\${SHELL:-/bin/zsh}" -l\n`;
}

const run = promisify(execFile);

async function exec(command: string, args: readonly string[], timeout = 0): Promise<string> {
  const { stdout } = await run(command, [...args], {
    encoding: "utf8",
    ...(timeout > 0 ? { timeout } : {}),
  });
  return stdout;
}

/** The system's handler for `.command` files, when Launch Services says. */
export async function readDefaultTerminalId(): Promise<string | null> {
  try {
    const preferences = path.join(
      os.homedir(),
      "Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist",
    );
    const json = await exec("plutil", ["-convert", "json", "-o", "-", preferences]);
    const parsed = JSON.parse(json) as { LSHandlers?: unknown };
    if (!Array.isArray(parsed.LSHandlers)) {
      return null;
    }
    for (const entry of parsed.LSHandlers) {
      if (typeof entry !== "object" || entry === null) continue;
      const handler = entry as Record<string, unknown>;
      const type = handler.LSHandlerContentType;
      const tag = handler.LSHandlerContentTag;
      if (
        type === "public.shell-script" ||
        type === "com.apple.terminal.shell-script" ||
        tag === "command"
      ) {
        const id = handler.LSHandlerRoleAll ?? handler.LSHandlerRoleViewer;
        return typeof id === "string" && BUNDLE_ID.test(id) ? id : null;
      }
    }
    return null;
  } catch {
    return null;
  }
}

export async function listTerminals(): Promise<SessionTerminalList> {
  if (process.platform !== "darwin") {
    return { supported: false, apps: [], defaultId: null };
  }
  const apps = await installedTerminals();
  const rex = await findRex();
  if (rex !== null) {
    apps.push({ id: REX_ID, name: "Rex" });
  }
  return {
    supported: true,
    apps,
    defaultId: await readDefaultTerminalId(),
  };
}

/**
 * Opens a validated resume in the chosen terminal. Never a page-supplied
 * shell string: the command is checked token by token and the cwd quoted.
 */
export async function openInTerminal(input: {
  app?: unknown;
  command?: unknown;
  cwd?: unknown;
  label?: unknown;
}): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error("Session terminals are only available in the Mac app");
  }
  const installed = await installedTerminals();
  const rex = await findRex();
  if (rex !== null) {
    installed.push({ id: REX_ID, name: "Rex" });
  }
  const error = validateTerminalRequest(input, installed);
  if (error !== null) {
    throw new Error(error);
  }
  const app = input.app as string;
  const command = (input.command as string).trim();
  const cwd = input.cwd as string;
  const stats = await fs.stat(cwd).catch(() => null);
  if (stats === null || !stats.isDirectory()) {
    throw new Error(`the working folder "${cwd}" is not available`);
  }

  if (app === REX_ID) {
    if (rex === null) {
      throw new Error(`the selected terminal app "${REX_ID}" is no longer available`);
    }
    await openInRex(rex, command, cwd, typeof input.label === "string" ? input.label : "");
    return;
  }

  const openArgs = terminalOpenArgs(app, installed);
  const file = path.join(
    await fs.mkdtemp(path.join(os.tmpdir(), "neolix-resume-")),
    "resume.command",
  );
  await fs.writeFile(file, resumeScript(command, cwd), { encoding: "utf8", mode: 0o700 });
  try {
    await exec("open", [...openArgs, file]);
  } catch (cause) {
    await fs.rm(path.dirname(file), { recursive: true, force: true }).catch(() => undefined);
    throw cause;
  }
  // Terminal has read it long before this; a minute is myna's own delay.
  setTimeout(() => {
    void fs.rm(path.dirname(file), { recursive: true, force: true }).catch(() => undefined);
  }, 60_000);
}

/**
 * The resume for the terminal: Neolix's own `cd '<cwd>' && ` prefix (an
 * Antigravity resume carries it) becomes the script's own cd.
 */
export function terminalCommandOf(resume: string, cwd: string): string {
  const prefix = `cd ${shellQuote(cwd)} && `;
  return resume.startsWith(prefix) ? resume.slice(prefix.length) : resume;
}

/* Rex: it claims no .command file, so Launch Services never lists it; its
 * own CLI opens a tab in a session of Neolix's (myna's terminal_rex.go). */

let rexMemo: { at: number; path: string | null } | null = null;

/** The native rex CLI, on PATH or in a Rex app; null when there is none. */
export async function findRex(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
  applicationDirs: readonly string[] = ["/Applications", path.join(home, "Applications")],
): Promise<string | null> {
  const now = Date.now();
  if (rexMemo !== null && now - rexMemo.at < 60_000) {
    return rexMemo.path;
  }
  const found = await lookRex(env, applicationDirs);
  rexMemo = { at: now, path: found };
  return found;
}

export function resetRexForTests(): void {
  rexMemo = null;
}

async function lookRex(
  env: NodeJS.ProcessEnv,
  applicationDirs: readonly string[],
): Promise<string | null> {
  for (const directory of (env.PATH ?? "").split(path.delimiter)) {
    if (directory.length === 0) continue;
    const candidate = path.join(directory, "rex");
    if (await nativeProgram(candidate)) {
      return candidate;
    }
  }
  for (const app of await rexApps(applicationDirs)) {
    const candidate = await rexInApp(path.join(app, "Contents"), 0);
    if (candidate !== null) {
      return candidate;
    }
  }
  return null;
}

async function rexApps(applicationDirs: readonly string[]): Promise<string[]> {
  const found: string[] = [];
  for (const directory of applicationDirs) {
    let entries: string[];
    try {
      entries = await fs.readdir(directory);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.startsWith("Rex") && entry.endsWith(".app")) {
        found.push(path.join(directory, entry));
      }
    }
  }
  return found;
}

async function rexInApp(root: string, depth: number): Promise<string | null> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (depth < 4 && !entry.name.endsWith(".framework") && entry.name !== "Frameworks") {
        const found = await rexInApp(full, depth + 1);
        if (found !== null) {
          return found;
        }
      }
      continue;
    }
    if (entry.name === "rex" && (await nativeProgram(full))) {
      return full;
    }
  }
  return null;
}

const NATIVE_MAGIC: readonly number[][] = [
  [0xcf, 0xfa, 0xed, 0xfe],
  [0xce, 0xfa, 0xed, 0xfe],
  [0xca, 0xfe, 0xba, 0xbe],
  [0x7f, 0x45, 0x4c, 0x46],
];

/** An executable Mach-O or ELF file, not a script named rex. */
async function nativeProgram(candidate: string): Promise<boolean> {
  try {
    const info = await fs.stat(candidate);
    if (!info.isFile() || (info.mode & 0o111) === 0) {
      return false;
    }
    const handle = await fs.open(candidate, "r");
    try {
      const head = Buffer.alloc(4);
      await handle.read(head, 0, 4, 0);
      return NATIVE_MAGIC.some((magic) => magic.every((byte, index) => head[index] === byte));
    } finally {
      await handle.close();
    }
  } catch {
    return false;
  }
}

async function openInRex(bin: string, command: string, cwd: string, title: string): Promise<void> {
  const label = rexLabel(title);
  const session = await rexOwnSession(bin);
  if (session !== null) {
    const result = await rexRunAllowFailure(bin, [
      "run",
      "-s",
      session,
      `--label=${label}`,
      "--json",
      "--",
      "/bin/sh",
      "-c",
      rexTabScript(command, cwd),
    ]);
    if (result.code === 0) {
      const window = windowIdOf(result.stdout);
      if (window.length > 0) {
        await rexRunAllowFailure(bin, ["window", "rename", "-s", session, "--", window, label]);
      }
      await rexShow();
      await rexSelect(bin, session, window);
      return;
    }
    if (result.code !== 3) {
      throw new Error(result.stderr.trim() || `rex exited with ${result.code ?? "no code"}`);
    }
  }
  const created = await rexRunAllowFailure(bin, [
    "new",
    REX_SESSION_LABEL,
    `--window=${label}`,
    "--json",
    "--",
    "/bin/sh",
    "-c",
    rexTabScript(command, cwd),
  ]);
  if (created.code !== 0) {
    throw new Error(created.stderr.trim() || `rex exited with ${created.code ?? "no code"}`);
  }
  await rexShow();
  const made = parseRexNew(created.stdout);
  if (made !== null) {
    await rexSelect(bin, made.session, made.window);
  }
}

/** The command in sh, then the login shell, so the tab stays when the agent quits. */
function rexTabScript(command: string, cwd: string): string {
  return `cd ${shellQuote(cwd)} && ${command}\nexec "\${SHELL:-/bin/zsh}" -l`;
}

function rexLabel(title: string): string {
  const text = title.split(/\s+/u).filter(Boolean).join(" ");
  if (text.length === 0) {
    return REX_SESSION_LABEL;
  }
  const characters = [...text];
  return characters.length > 60 ? `${characters.slice(0, 59).join("")}…` : text;
}

interface RexResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function rexRunAllowFailure(
  bin: string,
  args: readonly string[],
  timeout = 20_000,
): Promise<RexResult> {
  return new Promise((resolve) => {
    execFile(bin, [...args], { encoding: "utf8", timeout }, (error, stdout, stderr) => {
      let code: number | null = null;
      if (error === null) {
        code = 0;
      } else if (typeof (error as { code?: unknown }).code === "number") {
        code = (error as { code: number }).code;
      }
      resolve({ code, stdout, stderr });
    });
  });
}

function windowIdOf(stdout: string): string {
  try {
    const parsed = JSON.parse(stdout) as { window_id?: unknown };
    return typeof parsed.window_id === "string" ? parsed.window_id : "";
  } catch {
    return "";
  }
}

function parseRexNew(stdout: string): { session: string; window: string } | null {
  try {
    const parsed = JSON.parse(stdout) as {
      session_id?: unknown;
      initial_windows?: { window_id?: unknown }[];
    };
    if (typeof parsed.session_id !== "string") {
      return null;
    }
    const window = parsed.initial_windows?.[0]?.window_id;
    return {
      session: parsed.session_id,
      window: typeof window === "string" ? window : "",
    };
  } catch {
    return null;
  }
}

async function rexOwnSession(bin: string): Promise<string | null> {
  const result = await rexRunAllowFailure(bin, ["ls", "--json"]);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || "rex ls failed");
  }
  try {
    const parsed = JSON.parse(result.stdout) as {
      sessions?: { session_id?: unknown; label?: unknown }[];
    };
    const sessions = parsed.sessions ?? [];
    const exact = sessions.find((entry) => entry.label === REX_SESSION_LABEL);
    if (typeof exact?.session_id === "string") {
      return exact.session_id;
    }
    const loose = sessions.find(
      (entry) =>
        typeof entry.label === "string" &&
        entry.label.toLowerCase() === REX_SESSION_LABEL.toLowerCase(),
    );
    return typeof loose?.session_id === "string" ? loose.session_id : null;
  } catch {
    return null;
  }
}

async function rexShow(): Promise<void> {
  await rexRunAllowFailure("open", ["-b", REX_ID], 5_000);
}

/** Asks the Rex app to show the tab; the tab is open either way. */
async function rexSelect(bin: string, session: string, window: string): Promise<void> {
  const list = await rexRunAllowFailure(bin, ["client", "list", "--json"], 3_000);
  if (list.code !== 0) {
    return;
  }
  let client = "";
  try {
    const parsed = JSON.parse(list.stdout) as {
      clients?: {
        client_id?: unknown;
        connection_state?: unknown;
        info?: { kind?: unknown };
        session_ids?: unknown;
      }[];
    };
    for (const entry of parsed.clients ?? []) {
      if (
        typeof entry.client_id !== "string" ||
        entry.info?.kind !== "app" ||
        entry.connection_state === "lost"
      ) {
        continue;
      }
      if (Array.isArray(entry.session_ids) && entry.session_ids.includes(session)) {
        client = entry.client_id;
        break;
      }
      client = entry.client_id;
    }
  } catch {
    return;
  }
  if (client.length === 0) {
    return;
  }
  const args = ["-C", client, "do", "session.select", `session_id=${session}`];
  if (window.length > 0) {
    args.push(`window_id=${window}`);
  }
  await rexRunAllowFailure(bin, args, 3_000);
}
