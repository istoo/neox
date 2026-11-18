import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeRun } from "./run.js";
import type { ClaudeStreamEvent } from "./stream.js";

const dirs: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

interface StartedRun {
  run: ClaudeRun;
  child(): ChildProcess;
}

async function startRun(script: string): Promise<StartedRun> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "neolix-claude-run-"));
  dirs.push(dir);
  let child: ChildProcess | null = null;
  const spawnImpl = ((binary: string, args: readonly string[], options: SpawnOptions) => {
    const spawned = spawn(binary, [...args], options);
    child = spawned;
    children.push(spawned);
    return spawned;
  }) as unknown as typeof spawn;
  const run = new ClaudeRun({
    binary: process.execPath,
    args: ["-e", script],
    cwd: dir,
    env: {},
    spawnImpl,
  });
  return {
    run,
    child: () => {
      if (child === null) {
        throw new Error("the run didn't spawn its process");
      }
      return child;
    },
  };
}

function whenReady(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    let seen = "";
    const onData = (chunk: Buffer | string): void => {
      seen += chunk.toString();
      if (seen.includes("ready\n")) {
        child.stdout?.off("data", onData);
        resolve();
      }
    };
    child.stdout?.on("data", onData);
    child.once("error", reject);
  });
}

describe("a message's write into Claude Code's stdin", () => {
  // Closing fd 0 does not sever the inherited pipe on Windows, so this fixture cannot produce EPIPE.
  it.skipIf(process.platform === "win32")(
    "fails the run when the pipe is broken, without an unhandled stream error",
    async () => {
      const { run, child } = await startRun(
        "require('node:fs').closeSync(0); process.stdout.write('ready\\n'); setInterval(() => {}, 1000);",
      );
      run.start();
      const events = run.events();
      await whenReady(child());

      const uncaught: unknown[] = [];
      let sawUncaught!: (error: unknown) => void;
      const uncaughtSeen = new Promise<unknown>((resolve) => {
        sawUncaught = resolve;
      });
      const capture = (error: unknown): void => {
        uncaught.push(error);
        sawUncaught(error);
      };
      process.on("uncaughtException", capture);
      try {
        run.sendUserMessage([{ type: "text", text: "hi" }]);
        const failed = await Promise.race([run.waitForExit().then(() => null), uncaughtSeen]);
        expect(failed).toBeNull();

        const drained: ClaudeStreamEvent[] = [];
        for await (const event of events) {
          drained.push(event);
        }
        expect(drained).toContainEqual(
          expect.objectContaining({
            kind: "error",
            message: expect.stringMatching(/stdin|EPIPE/i),
          }),
        );
        expect(uncaught).toEqual([]);
        expect(run.running).toBe(false);
      } finally {
        process.off("uncaughtException", capture);
      }
    },
  );

  it("fails a message sent after the process exited, with the reason", async () => {
    const { run } = await startRun("process.exit(0);");
    const seen: ClaudeStreamEvent[] = [];
    run.setEventListener((event) => seen.push(event));
    run.start();
    await run.waitForExit();

    run.sendUserMessage([{ type: "text", text: "hi" }]);

    expect(seen).toContainEqual(
      expect.objectContaining({
        kind: "error",
        message: expect.stringMatching(/exited|stdin/i),
      }),
    );
    expect(run.running).toBe(false);
  });
});
