import { closeSync, openSync, readSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { Command, Option } from "commander";
import { resolveNeolixHome } from "@neolix/server/daemon-control";
import { connectToDaemon } from "../../utils/client.js";
import type { CommandOptions } from "../../output/index.js";
import {
  addDaemonHostOption,
  localDaemonHome,
  withGlobalOptions,
} from "../../utils/command-options.js";

/**
 * The Node counterparts of myna's pprof commands, plus `log` and
 * `healthcheck`. The daemon does the work (`daemon.diagnostics.*`); `log`
 * reads this computer's daemon.log, as myna's log reads the app's own.
 */

const heapUsage = `usage: neox heap [<file>]
  a V8 heap snapshot of the Neox daemon on this computer, for a report of Neox using
  too much memory. It is written to <file>, else to neolix-heap-<date>-<time>.heapsnapshot
  in this folder, and never over a file that is there. Chrome DevTools reads it
  (Memory › Load).`;

const cpuUsage = `usage: neox cpu [<file>] [--seconds N]
  a V8 CPU profile of the Neox daemon (myna's cpu profile). It samples for N seconds
  (10 unless given) and writes the profile to <file>, else to
  neolix-cpu-<date>-<time>.cpuprofile in this folder. Chrome DevTools reads it.`;

const goroutinesUsage = `usage: neox goroutines [<file>]
  the Neox daemon's active handles and requests, myna's goroutine dump: what keeps its
  event loop alive and what it is waiting on. Written to <file>, else to
  neolix-goroutines-<date>-<time>.json in this folder.`;

function stamp(): string {
  const now = new Date();
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function targetPath(args: string[], suffix: string): string {
  const given = args.find((value) => !value.startsWith("-"));
  if (given !== undefined && given.trim() !== "") {
    return path.resolve(given);
  }
  return path.resolve(`neolix-${suffix}-${stamp()}`);
}

interface DiagnosticsOptions extends CommandOptions {
  /** --seconds, for cpu. */
  seconds?: string;
}

async function withDaemon(
  options: DiagnosticsOptions,
): Promise<Awaited<ReturnType<typeof connectToDaemon>>> {
  const client = await connectToDaemon({ target: options.daemonTarget });
  if (client.getLastServerInfoMessage()?.features?.daemonDiagnostics !== true) {
    client.close();
    throw new Error("Update the host to write Neox diagnostics.");
  }
  return client;
}

async function heapCommand(args: string[], options: DiagnosticsOptions): Promise<void> {
  const file = targetPath(args, "heap");
  const client = await withDaemon(options);
  try {
    await client.writeDaemonHeapSnapshot(file);
  } finally {
    client.close();
  }
  console.log(`heap snapshot written to ${file}`);
}

async function cpuCommand(args: string[], options: DiagnosticsOptions): Promise<void> {
  const file = targetPath(args, "cpu");
  const seconds = options.seconds === undefined ? undefined : Number(options.seconds);
  if (seconds !== undefined && (!Number.isFinite(seconds) || seconds <= 0)) {
    throw new Error(`--seconds takes a number of seconds, not ${JSON.stringify(options.seconds)}`);
  }
  const client = await withDaemon(options);
  try {
    await client.writeDaemonCpuProfile(file, seconds);
  } finally {
    client.close();
  }
  console.log(`cpu profile written to ${file}`);
}

async function goroutinesCommand(args: string[], options: DiagnosticsOptions): Promise<void> {
  const file = targetPath(args, "goroutines");
  const client = await withDaemon(options);
  try {
    await client.writeDaemonHandlesDump(file);
  } finally {
    client.close();
  }
  console.log(`handles and requests written to ${file}`);
}

/** Exits 0 when the daemon answers, for a container's HEALTHCHECK (myna's healthcheck). */
async function healthcheckCommand(options: DiagnosticsOptions): Promise<void> {
  let client: Awaited<ReturnType<typeof connectToDaemon>>;
  try {
    client = await connectToDaemon({ target: options.daemonTarget });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`no Neox daemon answers: ${message}`, { cause: error });
  }
  try {
    await client.getDaemonStatus();
  } finally {
    client.close();
  }
}

function logFile(home: string | undefined): string {
  const neolixHome = resolveNeolixHome({ NEOLIX_HOME: home ?? process.env.NEOLIX_HOME });
  return path.join(neolixHome, "daemon.log");
}

/** The last n lines of a file, myna's tail: the whole file when it is short. */
function lastLines(file: string, n: number): string[] {
  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    return [];
  }
  // Read back in growing chunks until the tail holds n newlines or the file start is reached.
  let take = Math.min(size, 64 * 1024);
  for (;;) {
    const buffer = Buffer.alloc(take);
    const fd = openSync(file, "r");
    try {
      readSync(fd, buffer, 0, take, size - take);
    } finally {
      closeSync(fd);
    }
    const lines = buffer.toString("utf8").split("\n");
    if (lines.at(-1) === "") {
      lines.pop();
    }
    if (lines.length >= n || take === size) {
      return lines.slice(-n);
    }
    take = Math.min(size, take * 4);
  }
}

async function followLog(file: string, from: number): Promise<void> {
  let offset = from;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    let size: number;
    try {
      size = statSync(file).size;
    } catch {
      continue;
    }
    if (size < offset) {
      offset = 0; // rotated
    }
    if (size === offset) {
      continue;
    }
    const handle = await open(file, "r");
    try {
      const length = size - offset;
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, offset);
      process.stdout.write(buffer.toString("utf8"));
      offset = size;
    } finally {
      await handle.close();
    }
  }
}

async function logCommand(options: {
  path?: boolean;
  lines?: string;
  follow?: boolean;
  home?: string;
}): Promise<void> {
  const file = logFile(options.home);
  let lines = 20;
  if (options.follow === true) {
    lines = 100;
  }
  if (options.lines !== undefined) {
    lines = Number(options.lines);
  }
  if (options.lines !== undefined && (!Number.isInteger(lines) || lines < 0)) {
    throw new Error(
      `-n takes a number of lines, not ${JSON.stringify(options.lines)} (neox log -n 200)`,
    );
  }
  if (options.path === true) {
    if (options.follow === true || options.lines !== undefined) {
      throw new Error("--path prints the path alone: use it without -n or -f");
    }
    console.log(file);
    return;
  }
  if (options.follow !== true && options.lines === undefined) {
    try {
      statSync(file);
    } catch {
      console.log(`${file}\n  the daemon's log: nothing yet; it writes one once it runs`);
      return;
    }
    console.log(`${file}\n  the daemon's log; neox log -f follows it`);
    return;
  }
  try {
    statSync(file);
  } catch {
    throw new Error(`${file} isn't there yet: the daemon writes it once it runs`);
  }
  for (const line of lastLines(file, lines)) {
    console.log(line);
  }
  if (options.follow === true) {
    await followLog(file, statSync(file).size);
  }
}

export function createHeapCommand(): Command {
  const command = new Command("heap").description(heapUsage).argument("[args...]");
  addDaemonHostOption(command);
  command.action(
    withGlobalOptions(async (args: string[], options: DiagnosticsOptions) => {
      await heapCommand(args, options);
    }),
  );
  return command;
}

export function createCpuCommand(): Command {
  const command = new Command("cpu")
    .description(cpuUsage)
    .argument("[args...]")
    .addOption(new Option("--seconds <n>", "how long to sample"));
  addDaemonHostOption(command);
  command.action(
    withGlobalOptions(async (args: string[], options: DiagnosticsOptions) => {
      await cpuCommand(args, options);
    }),
  );
  return command;
}

export function createGoroutinesCommand(): Command {
  const command = new Command("goroutines").description(goroutinesUsage).argument("[args...]");
  addDaemonHostOption(command);
  command.action(
    withGlobalOptions(async (args: string[], options: DiagnosticsOptions) => {
      await goroutinesCommand(args, options);
    }),
  );
  return command;
}

export function createHealthcheckCommand(): Command {
  const command = new Command("healthcheck").description(
    "exit 0 when a Neox daemon answers, for a container's HEALTHCHECK",
  );
  addDaemonHostOption(command);
  command.action(
    withGlobalOptions(async (options: DiagnosticsOptions) => {
      await healthcheckCommand(options);
    }),
  );
  return command;
}

export function createLogCommand(): Command {
  const command = new Command("log")
    .description("where the daemon's log is, and its last lines")
    .option("--path", "print the log's path alone")
    .option("-n, --lines <n>", "the last n lines (100 with -f)")
    .option("-f, --follow", "the last lines, then each line as it is written");
  addDaemonHostOption(command);
  command.action(async () => {
    await logCommand({ ...command.opts(), home: localDaemonHome(command) });
  });
  return command;
}
