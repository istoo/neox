import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createExternalProcessEnv } from "../../neolix-env.js";
import { installFakeClaude } from "./testing/fake-claude.js";
import { TuiSession, TUI_TRUST_ENV } from "./tui.js";

const cleanup: string[] = [];
const sessions: TuiSession[] = [];

afterEach(async () => {
  const stopped = sessions.splice(0);
  for (const session of stopped) {
    session.kill();
  }
  // Windows holds a directory while a process's cwd is in it: wait for the
  // session's whole process tree to be gone before the temp dirs are removed.
  await Promise.all(stopped.map((session) => session.waitForExit()));
  for (const dir of cleanup.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

const SCRIPT = `
out("READY trust=" + process.env[${JSON.stringify(TUI_TRUST_ENV)}]);
onLines((line) => out("BOT:" + line));
`;

async function start(
  script = SCRIPT,
  options: {
    env?: Record<string, string>;
    listedFile?: string;
    readyTimeoutMs?: number;
    tap?: { env: Record<string, string> };
    trust?: boolean;
  } = {},
): Promise<{ session: TuiSession; dir: string }> {
  const fake = await installFakeClaude(script);
  cleanup.push(fake.dir);
  const dir = await mkdtemp(path.join(os.tmpdir(), "neolix-claude-tui-"));
  cleanup.push(dir);
  const session = new TuiSession({
    binary: fake.binary,
    args: [],
    cwd: dir,
    // The pty gets exactly the env it is given, and Node on Windows needs the
    // host's own variables (SystemRoot among them) to start at all; a real
    // run's env comes from process.env, so the fixture starts from there too.
    env: createExternalProcessEnv(process.env, {
      PATH: "/usr/bin:/bin",
      TERM: "xterm-256color",
      ...options.env,
    }),
    listedFile: options.listedFile,
    readyTimeoutMs: options.readyTimeoutMs,
    tap: options.tap,
    trust: options.trust,
  });
  sessions.push(session);
  await session.start();
  return { session, dir };
}

const PROMPT_SCRIPT = `
outRaw("\\u276f ");
onLines((line) => out("BOT:" + line));
`;

const TRUST_SCRIPT = `
let input = "";
let phase = 0;
function note(text) {
  fs.appendFileSync(process.env.MARKERS, text + "\\n");
}
function pump(chunk) {
  input += chunk;
  if (phase === 2) {
    let at;
    while ((at = input.indexOf("\\n")) !== -1) {
      const line = input.slice(0, at).replace(/\\r$/, "");
      input = input.slice(at + 1);
      out("BOT:" + line);
    }
    return;
  }
  if (phase === 0) {
    const at = input.indexOf("\\u001b[B");
    if (at === -1) {
      return;
    }
    input = input.slice(at + 3);
    note("ARROW_OK");
    note("MOVE_OK");
    phase = 1;
    out("  No, exit");
    out("\\u276f Yes, I trust this folder");
    return;
  }
  const enter = input.indexOf("\\r");
  if (enter !== -1) {
    input = input.slice(enter + 1);
    note("ENTER_OK");
    phase = 2;
    outRaw("\\u276f ");
  }
}
out("Do you trust the files in this folder?");
out("\\u276f No, exit");
out("  Yes, I trust this folder");
onKeys(pump);
`;

const ONBOARD_SCRIPT = `
outRaw("Security notes: two things\\nPress Enter to continue\\n");
let input = "";
let phase = 0;
onKeys((chunk) => {
  input += chunk;
  if (phase === 0 && input.length > 0) {
    input = "";
    phase = 1;
    out("Choose the text style");
    return;
  }
  if (phase === 1 && input.length > 0) {
    input = "";
    phase = 2;
    outRaw("\\u276f ");
    return;
  }
  let at;
  while ((at = input.search(/[\\r\\n]/)) !== -1) {
    const line = input.slice(0, at);
    input = input.slice(at + 1);
    out("BOT:" + line);
  }
});
`;

const LISTED_SCRIPT = `
setTimeout(() => {
  fs.writeFileSync(process.env.LISTED_FILE, "");
  outRaw("\\u276f ");
  onLines((line) => out("BOT:" + line));
}, 300);
`;

describe("TuiSession", { timeout: 20_000 }, () => {
  it("starts Claude Code as trusted and reads its screen", async () => {
    const { session } = await start();
    const screen = await session.waitFor(/READY/);
    expect(screen).toContain(`trust=1`);
  });

  it("types a turn and reads its answer", async () => {
    const { session } = await start();
    await session.waitFor(/READY/);
    session.ask("hello");
    expect(await session.waitFor(/BOT:hello/)).toContain("BOT:hello");
  });

  it("rejects when the screen never says what was asked", async () => {
    const { session } = await start();
    await expect(session.waitFor(/NEVER/, 100)).rejects.toThrow("did not say");
  });

  it("answers trust with the environment its caller set", async () => {
    const { session } = await start();
    expect(await session.waitFor(/READY/)).toContain("trust=1");
    session.kill();
    expect(session.pid).toBe(0);
  });

  it("waits for the prompt before it says it is ready", async () => {
    const { session } = await start(PROMPT_SCRIPT);
    await session.ready();
    expect(session.screen()).toContain("❯");
  });

  it("waits for the tools to be listed before it says it is ready", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "neolix-claude-tui-listed-"));
    cleanup.push(dir);
    const listedFile = path.join(dir, "listed");
    const { session } = await start(LISTED_SCRIPT, {
      env: { LISTED_FILE: listedFile },
      listedFile,
      readyTimeoutMs: 5_000,
    });
    await session.ready();
    await expect(access(listedFile)).resolves.toBeUndefined();
  });

  it("gives Claude Code the tap to load before itself", async () => {
    const { session } = await start(
      `out("BUN:" + (process.env.BUN_OPTIONS ?? "") + " TAP:" + (process.env.NEOLIX_CLAUDE_TAP ?? "")); keepAlive();`,
      {
        tap: {
          env: {
            BUN_OPTIONS: "--preload /tmp/neolix-claude-tap-x/tap.cjs",
            NEOLIX_CLAUDE_TAP: "/tmp/neolix-claude-tap-x/tap.jsonl",
          },
        },
      },
    );
    const screen = await session.waitFor(/BUN:/);
    expect(screen).toContain("BUN:--preload /tmp/neolix-claude-tap-x/tap.cjs");
    expect(screen).toContain("TAP:/tmp/neolix-claude-tap-x/tap.jsonl");
  });

  it("trusts the folder as a person does: down to Yes, then Enter", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "neolix-claude-tui-markers-"));
    cleanup.push(dir);
    const markers = path.join(dir, "markers");
    const { session } = await start(TRUST_SCRIPT, { env: { MARKERS: markers } });
    await session.ready();
    expect(await readFile(markers, "utf8")).toBe("ARROW_OK\nMOVE_OK\nENTER_OK\n");
  });

  it("refuses to answer the trust question for its user", async () => {
    const { session } = await start(TRUST_SCRIPT, { trust: false });
    await expect(session.ready()).rejects.toThrow("which only its user answers");
  });

  it("refuses to answer a sign-in", async () => {
    const { session } = await start(`out("Select login method"); keepAlive();`);
    await expect(session.ready()).rejects.toThrow("asks to sign in");
  });

  it("goes past the first-run screens as Enter does", async () => {
    const { session } = await start(ONBOARD_SCRIPT);
    await session.ready();
    expect(session.screen()).toContain("❯");
    session.ask("hello");
    expect(await session.waitFor(/BOT:hello/)).toContain("BOT:hello");
  });

  it("fails when the prompt shows but the tools are never listed", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "neolix-claude-tui-listed-"));
    cleanup.push(dir);
    const { session } = await start(PROMPT_SCRIPT, {
      listedFile: path.join(dir, "never"),
      // The prompt has to be drawn first; this is startup time, not the
      // behavior under test, and cmd.exe on Windows starts slower than the
      // half second this used to allow.
      readyTimeoutMs: 5_000,
    });
    await expect(session.ready()).rejects.toThrow("had not listed its MCP tools");
  });

  it("fails when it ends without showing a prompt", async () => {
    const { session } = await start("process.exit(3);", { readyTimeoutMs: 5_000 });
    await expect(session.ready()).rejects.toThrow("ended before it showed its prompt");
  });
});
