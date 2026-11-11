import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { readFileSteady, type SteadyRuntime } from "./steady.js";

let directory: string;
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "neolix-steady-"));
});
afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});

function counting(): { runtime: SteadyRuntime; waits: number[] } {
  const waits: number[] = [];
  return {
    waits,
    runtime: {
      pause: 10,
      tries: 50,
      gonePause: 1,
      goneTries: 15,
      sleep: async (milliseconds) => {
        waits.push(milliseconds);
      },
    },
  };
}

it("reads a file that is there", async () => {
  const file = path.join(directory, "state.json");
  await fs.writeFile(file, "{}");
  const { runtime, waits } = counting();
  expect((await readFileSteady(file, runtime)).toString()).toBe("{}");
  expect(waits).toEqual([]);
});

it("waits out a file that is briefly not there, then reads it", async () => {
  const file = path.join(directory, "state.json");
  const waits: number[] = [];
  let wrote = false;
  const runtime: SteadyRuntime = {
    pause: 10,
    tries: 50,
    gonePause: 1,
    goneTries: 15,
    sleep: async (milliseconds) => {
      waits.push(milliseconds);
      if (!wrote) {
        wrote = true;
        // The folder is there, the file appears on the next look: the
        // rename's moment.
        await fs.writeFile(file, "{}");
      }
    },
  };
  expect((await readFileSteady(file, runtime)).toString()).toBe("{}");
  expect(waits.length).toBeGreaterThan(0);
});

it("gives up on a file that is really gone after the bounded wait", async () => {
  const file = path.join(directory, "absent.json");
  const { runtime, waits } = counting();
  await expect(readFileSteady(file, runtime)).rejects.toMatchObject({ code: "ENOENT" });
  expect(waits).toEqual(Array.from({ length: 15 }, () => 1));
});

it("does not wait when the folder isn't there either", async () => {
  const file = path.join(directory, "missing", "state.json");
  const { runtime, waits } = counting();
  await expect(readFileSteady(file, runtime)).rejects.toMatchObject({ code: "ENOENT" });
  expect(waits).toEqual([]);
});
