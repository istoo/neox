import { access } from "node:fs/promises";
import * as pty from "node-pty";
import { resolveTerminalSpawnCommand } from "../../../terminal/terminal.js";
import { signalProcessTree } from "../../../utils/tree-kill.js";
import { ScreenGrid } from "./screen.js";
import type { ClaudeTap } from "./tap.js";

/** The prompt Claude Code draws when it takes input. */
const TUI_PROMPT = /❯/;

/** Tells Claude Code yes when it asks whether to trust the folder it runs in. */
export const TUI_TRUST_ENV = "NEOLIX_CLAUDE_TUI_TRUST";

/** Why a run ends where the folder it runs in is not trusted. */
export const TUI_UNTRUSTED =
  "Claude Code asks whether to trust the folder, which only its user answers";

const TRUST_NO = /❯\s*No,\s*exit/g;
const TRUST_YES = /❯\s*Yes,\s*I trust/g;

/** How long a choice stays drawn before Enter is pressed on it. */
const TRUST_SETTLE_MS = 300;

/** How often one onboarding screen is answered before the run ends. */
const ONBOARD_TRIES = 3;

/** Where Claude Code is not signed in: nothing the bridge may answer. */
const SIGN_IN = /Select login method|Log in with your Claude account|claude\.ai\/oauth\/authorize/;

const FIRST_RUN = /Security notes:.*Press Enter to continue/;
const TERMINAL_SETUP = /terminal setup\?.*Esc to skip/;
const TEXT_STYLE = "Choose the text style";

export interface TuiSessionOptions {
  binary: string;
  args: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  cols?: number;
  rows?: number;
  /** The pty spawner, for a test's stand-in. */
  spawn?: typeof pty.spawn;
  /** The file the MCP helper writes once Claude Code has listed its tools. */
  listedFile?: string;
  /** How long Claude Code may take to show its prompt; myna waits 45s. */
  readyTimeoutMs?: number;
  /** Whether the bridge answers yes when asked to trust the folder; on by default. */
  trust?: boolean;
  /** The tap Claude Code loads before itself, so its replies stream to the bridge. */
  tap?: Pick<ClaudeTap, "env">;
}

/**
 * Claude Code's interactive mode, driven through a pseudo terminal: its
 * screen is read as a grid, not as a stream of escapes, and the caller's
 * words are typed into it. This is the process the subscription bridge keeps
 * for a conversation when `claudePrintMode` is off, as myna does by default.
 */
export class TuiSession {
  private readonly options: TuiSessionOptions;
  private readonly grid: ScreenGrid;
  private terminal: pty.IPty | null = null;
  private listeners: Array<(screen: string) => void> = [];
  private exited = false;
  private exitCode: number | null = null;
  private readonly exitWaiters: Array<() => void> = [];

  public constructor(options: TuiSessionOptions) {
    this.options = options;
    this.grid = new ScreenGrid(options.cols ?? 120, options.rows ?? 40);
  }

  public async start(): Promise<void> {
    const spawn = this.options.spawn ?? pty.spawn;
    // An npm-installed Claude Code is a `.cmd` on Windows, which ConPTY cannot
    // launch by itself; the binary's path is already resolved, so it is passed
    // through the terminal launcher unchanged and routed through cmd.exe there.
    const launch = await resolveTerminalSpawnCommand(this.options.binary, [...this.options.args], {
      resolveExecutable: async (name) => name,
      env: { ...process.env, ...this.options.env },
    });
    this.terminal = spawn(launch.command, launch.args, {
      name: "xterm-256color",
      cols: this.options.cols ?? 120,
      rows: this.options.rows ?? 40,
      cwd: this.options.cwd,
      env: {
        ...this.options.env,
        ...this.options.tap?.env,
        [TUI_TRUST_ENV]: this.options.trust === false ? "0" : "1",
      },
    });
    this.terminal.onExit(({ exitCode }) => {
      this.exited = true;
      this.exitCode = exitCode;
      for (const resolve of this.exitWaiters.splice(0)) {
        resolve();
      }
    });
    this.terminal.onData((data) => {
      this.grid.write(data);
      const screen = this.screen();
      for (const listener of this.listeners) {
        listener(screen);
      }
    });
  }

  public get pid(): number {
    return this.terminal?.pid ?? 0;
  }

  public get running(): boolean {
    return this.terminal !== null && !this.exited;
  }

  /**
   * Waits for Claude Code's prompt, and for its MCP servers' tools to have
   * been listed: a message sent before then is answered without the caller's
   * tools, which the bridge's helper carries.
   */
  public async ready(): Promise<void> {
    const timeout = this.options.readyTimeoutMs ?? 45_000;
    const deadline = Date.now() + timeout;
    const state: ReadyState = {
      answered: 0,
      yesAt: 0,
      downAt: 0,
      shownAt: new Map(),
      pressed: new Map(),
    };
    let prompted = false;
    let asking = "";
    for (;;) {
      const screen = this.screen();
      const words = screen.split(/\s+/).filter(Boolean).join(" ");
      asking = screen.includes("trust this folder")
        ? `asked whether to trust ${this.options.cwd}, not answered`
        : "showed no prompt";
      if (screen.includes("trust this folder")) {
        if (this.options.trust === false) {
          throw new Error(TUI_UNTRUSTED);
        }
        this.answerTrust(screen, state);
      } else if (SIGN_IN.test(screen)) {
        throw new Error(`Claude Code's interactive mode asks to sign in: ${this.lastScreen()}`);
      } else if (FIRST_RUN.test(words)) {
        this.onboard(state, "notes", "\r");
      } else if (TERMINAL_SETUP.test(words)) {
        this.onboard(state, "terminal", "\u001b");
      } else if (screen.includes("keep browser tools off")) {
        // Claude in Chrome found: kept off, as the bridge runs without it
        this.clearScreen();
        this.type("\u001b");
      } else if (words.includes(TEXT_STYLE)) {
        this.onboard(state, "theme", "\r");
      } else if (TUI_PROMPT.test(screen)) {
        if (await this.toolsListed()) {
          // a moment for its input to be listened to, and for the tools just
          // listed to be taken up
          await sleep(300);
          return;
        }
        // drawn before Claude Code has its MCP servers' tools: a message
        // sent now is answered without the caller's tools
        prompted = true;
      }
      if (this.exited) {
        throw new Error(
          `Claude Code ended before it showed its prompt (${this.exitCode ?? "signal"}): ${this.lastScreen()}`,
        );
      }
      if (Date.now() >= deadline) {
        throw new Error(
          prompted
            ? `Claude Code showed its prompt, but had not listed its MCP tools in ${timeout / 1000}s`
            : `Claude Code ${asking} in ${timeout / 1000}s: ${this.lastScreen()}`,
        );
      }
      await sleep(100);
    }
  }

  /** Answers the trust question as a person does: down to Yes, then Enter. */
  private answerTrust(screen: string, state: ReadyState): void {
    const no = lastMatch(TRUST_NO, screen);
    const yes = lastMatch(TRUST_YES, screen);
    if (yes > no) {
      if (state.yesAt === 0) {
        state.yesAt = Date.now();
      }
      if (Date.now() - state.yesAt < TRUST_SETTLE_MS) {
        return;
      }
      state.answered += 1;
      state.yesAt = 0;
      this.clearScreen();
      this.type("\r");
      return;
    }
    if (no >= 0) {
      state.yesAt = 0;
      // a key sent as the question is first drawn can be lost to its being
      // drawn again on No
      if (Date.now() - state.downAt >= 1_000) {
        state.downAt = Date.now();
        this.type("\u001b[B");
      }
    }
  }

  /**
   * Goes past one of Claude Code's first-run screens once it has stayed
   * drawn, as Enter or Esc would for a person.
   */
  private onboard(state: ReadyState, key: string, press: string): void {
    const shown = state.shownAt.get(key);
    if (shown === undefined) {
      state.shownAt.set(key, Date.now());
      return;
    }
    if (Date.now() - shown < TRUST_SETTLE_MS) {
      return;
    }
    const pressed = state.pressed.get(key) ?? 0;
    if (pressed >= ONBOARD_TRIES) {
      throw new Error(
        `Claude Code's interactive mode stays on its first-run screens, its onboarding not done; run Claude Code once in a terminal and go through them: ${this.lastScreen()}`,
      );
    }
    state.pressed.set(key, pressed + 1);
    state.shownAt.delete(key);
    this.clearScreen();
    this.type(press);
  }

  /** Draws a blank screen, so an answered question is not answered again. */
  public clearScreen(): void {
    this.grid.reset();
  }

  /** The end of what Claude Code drew, for an error to say. */
  private lastScreen(): string {
    const screen = this.screen().split(/\s+/).filter(Boolean).join(" ");
    return screen.length > 600 ? screen.slice(-600) : screen;
  }

  /** Whether the MCP helper has written the file Claude Code's tools are listed by. */
  public async toolsListed(): Promise<boolean> {
    if (this.options.listedFile === undefined) {
      return true;
    }
    try {
      await access(this.options.listedFile);
      return true;
    } catch {
      return false;
    }
  }

  /** Waits until Claude Code ends; its exit code, or null for a signal. */
  public waitForExit(): Promise<number | null> {
    if (this.exited) {
      return Promise.resolve(this.exitCode);
    }
    return new Promise((resolve) => {
      this.exitWaiters.push(() => resolve(this.exitCode));
    });
  }

  /** What the screen holds now, escapes taken out. */
  public screen(): string {
    return this.grid.text();
  }

  /** Types text into Claude Code's input, as a paste, without sending it. */
  public type(text: string): void {
    this.terminal?.write(text);
  }

  /** Sends the input Claude Code holds, as Enter does. */
  public enter(): void {
    this.terminal?.write("\r");
  }

  /** Types a turn and sends it. */
  public ask(text: string): void {
    this.type(text);
    this.enter();
  }

  /** Answers what Claude Code waits on, as the screen says. */
  public waitFor(pattern: RegExp, timeoutMs = 30_000): Promise<string> {
    const current = this.screen();
    if (pattern.test(current)) {
      return Promise.resolve(current);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners = this.listeners.filter((listener) => listener !== check);
        reject(new Error(`Claude Code's screen did not say ${String(pattern)}`));
      }, timeoutMs);
      const check = (screen: string): void => {
        if (!pattern.test(screen)) {
          return;
        }
        clearTimeout(timer);
        this.listeners = this.listeners.filter((listener) => listener !== check);
        resolve(screen);
      };
      this.listeners.push(check);
    });
  }

  public kill(): void {
    const terminal = this.terminal;
    if (terminal === null) {
      return;
    }
    this.terminal = null;
    this.listeners = [];
    if (process.platform !== "win32") {
      terminal.kill();
      return;
    }
    // ConPTY launched this run through cmd.exe: node-pty's own kill only
    // reaches the console's processes asynchronously (and is deferred until
    // the pty is ready), so a `claude.cmd` script's node child can outlive
    // the session. End the tree first; waitForExit then reports its exit.
    void (async () => {
      await signalProcessTree(
        {
          pid: terminal.pid,
          kill: (): boolean => {
            try {
              terminal.kill();
            } catch {
              // the process is already gone
            }
            return true;
          },
        },
        "SIGKILL",
      );
      try {
        terminal.kill();
      } catch {
        // the tree has already ended
      }
    })();
  }
}

interface ReadyState {
  answered: number;
  yesAt: number;
  downAt: number;
  shownAt: Map<string, number>;
  pressed: Map<string, number>;
}

/** Where re's last match in text starts, -1 with none. */
function lastMatch(re: RegExp, text: string): number {
  re.lastIndex = 0;
  let at = -1;
  for (let match = re.exec(text); match !== null; match = re.exec(text)) {
    at = match.index;
    if (match[0] === "") {
      re.lastIndex += 1;
    }
  }
  return at;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
