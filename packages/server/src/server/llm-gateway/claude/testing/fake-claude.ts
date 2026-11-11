import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface FakeClaude {
  dir: string;
  binary: string;
}

/**
 * Writes an executable shell script named `claude`, as myna's tests stand one
 * in for the real binary. `body` runs after the shebang; tests give it the
 * stream-json lines and the stdin loop they need.
 */
export async function installFakeClaude(body: string): Promise<FakeClaude> {
  if (process.platform === "win32") {
    throw new Error("a shell script stands in for Claude Code");
  }
  const dir = await mkdtemp(path.join(os.tmpdir(), "neolix-fake-claude-"));
  const binary = path.join(dir, "claude");
  await writeFile(binary, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  await chmod(binary, 0o755);
  return { dir, binary };
}

/** Quotes one word for a POSIX shell. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** A script body that prints each line, one per line. */
export function printLines(lines: readonly string[]): string {
  return `printf '%s\\n' ${lines.map(shellQuote).join(" ")}`;
}
