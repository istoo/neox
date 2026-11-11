import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installFakeClaude } from "./testing/fake-claude.js";
import { TuiSession, TUI_TRUST_ENV } from "./tui.js";

const cleanup: string[] = [];
const sessions: TuiSession[] = [];

afterEach(async () => {
  for (const session of sessions.splice(0)) {
    session.kill();
  }
  for (const dir of cleanup.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

const SCRIPT = `
printf 'READY trust=%s\\n' "$${TUI_TRUST_ENV}"
while IFS= read -r line; do
  printf 'BOT:%s\\n' "$line"
done
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
    env: { PATH: "/usr/bin:/bin", TERM: "xterm-256color", ...options.env },
    listedFile: options.listedFile,
    readyTimeoutMs: options.readyTimeoutMs,
    tap: options.tap,
    trust: options.trust,
  });
  sessions.push(session);
  session.start();
  return { session, dir };
}

const PROMPT_SCRIPT = `
printf '❯ '
while IFS= read -r line; do
  printf 'BOT:%s\n' "$line"
done
`;

const TRUST_SCRIPT = `
stty raw -echo
printf 'Do you trust the files in this folder?\n'
printf '❯ No, exit\n  Yes, I trust this folder\n'
a=$(dd bs=1 count=1 2>/dev/null)
[ "$a" = "$(printf '\\033')" ] && printf 'ARROW_OK\n' >> "$MARKERS"
b=$(dd bs=1 count=2 2>/dev/null)
[ "$b" = '[B' ] && printf 'MOVE_OK\n' >> "$MARKERS"
printf '  No, exit\n❯ Yes, I trust this folder\n'
c=$(dd bs=1 count=1 2>/dev/null)
[ "$c" = "$(printf '\\r')" ] && printf 'ENTER_OK\n' >> "$MARKERS"
stty sane
printf '❯ '
while IFS= read -r line; do
  printf 'BOT:%s\n' "$line"
done
`;

const ONBOARD_SCRIPT = `
stty raw -echo
printf 'Security notes: two things\nPress Enter to continue\n'
dd bs=1 count=1 >/dev/null 2>&1
printf 'Choose the text style\n'
dd bs=1 count=1 >/dev/null 2>&1
stty sane
printf '❯ '
while IFS= read -r line; do
  printf 'BOT:%s\n' "$line"
done
`;

const LISTED_SCRIPT = `
sleep 0.3
touch "$LISTED_FILE"
printf '❯ '
while IFS= read -r line; do
  printf 'BOT:%s\n' "$line"
done
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
      `printf 'BUN:%s TAP:%s\\n' "$BUN_OPTIONS" "$NEOLIX_CLAUDE_TAP"\n`,
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
    const { session } = await start(`printf 'Select login method\n'\n`);
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
      readyTimeoutMs: 500,
    });
    await expect(session.ready()).rejects.toThrow("had not listed its MCP tools");
  });

  it("fails when it ends without showing a prompt", async () => {
    const { session } = await start("exit 3\n", { readyTimeoutMs: 5_000 });
    await expect(session.ready()).rejects.toThrow("ended before it showed its prompt");
  });
});
