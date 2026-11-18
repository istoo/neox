import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface FakeClaude {
  dir: string;
  binary: string;
}

/**
 * What every fake Claude Code body runs with: line readers for `-p`'s
 * stream-json stdin, raw readers for the interactive mode's keys, and writers
 * that flush each message as its own line.
 */
const RUNTIME = `const fs = require("node:fs");
const path = require("node:path");
// The pid the bridge sees: a .cmd shim runs under cmd.exe on Windows, so the
// process it spawned is this script's parent.
const runPid = process.platform === "win32" ? process.ppid : process.pid;
function out(text) {
  process.stdout.write(text + "\\n");
}
function outRaw(text) {
  process.stdout.write(text);
}
function onLines(handler) {
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf("\\n")) !== -1) {
      const line = buffer.slice(0, at).replace(/\\r$/, "");
      buffer = buffer.slice(at + 1);
      handler(line);
    }
  });
}
function onKeys(handler) {
  if (typeof process.stdin.setRawMode === "function") process.stdin.setRawMode(true);
  process.stdin.setEncoding("utf8");
  process.stdin.resume();
  process.stdin.on("data", handler);
}
function keepAlive() {
  setInterval(() => {}, 1000);
}
async function waitForFile(file) {
  while (!fs.existsSync(file)) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}`;

/**
 * Writes a fake named `claude`, as myna's tests stand one in for the real
 * binary. The body is JavaScript run by this process's Node: a shell wrapper
 * off Windows carries the arguments through unchanged, and a `.cmd` shim on
 * Windows does the same, the shape an npm-installed Claude Code has there.
 */
export async function installFakeClaude(body: string): Promise<FakeClaude> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "neolix-fake-claude-"));
  const script = path.join(dir, "claude.js");
  await writeFile(script, `${RUNTIME}\n${body}\n`);
  if (process.platform === "win32") {
    const binary = path.join(dir, "claude.cmd");
    await writeFile(binary, `@echo off\r\n"${process.execPath}" "%~dp0claude.js" %*\r\n`);
    return { dir, binary };
  }
  const binary = path.join(dir, "claude");
  await writeFile(
    binary,
    `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(script)} "$@"\n`,
    { mode: 0o755 },
  );
  await chmod(binary, 0o755);
  return { dir, binary };
}

/** Quotes one word for a POSIX shell. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** A script body that prints each line, one per line. */
export function printLines(lines: readonly string[]): string {
  return lines.map((line) => `out(${JSON.stringify(line)});`).join("\n");
}
