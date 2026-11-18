import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SyncService } from "./service.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("SyncService shutdown", () => {
  it("waits for the tick in flight and starts none once stopped", async () => {
    const home = await mkdtemp(join(tmpdir(), "neolix-sync-shutdown-"));
    dirs.push(home);
    const service = new SyncService({ neolixHome: home });
    let started!: () => void;
    const tickStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const initializing = vi
      .spyOn(service, "initializeAppSettingsKeys")
      .mockImplementation(async () => {
        started();
        await gate;
        // The write the daemon would make while stop() is running.
        await writeFile(join(home, "in-flight.txt"), "written\n");
      });

    service.start();
    await tickStarted;
    const stopping = service.stop();
    expect(await Promise.race([stopping.then(() => "settled"), Promise.resolve("pending")])).toBe(
      "pending",
    );

    release();
    await stopping;
    // The write in flight finished before stop() resolved.
    expect(await readdir(home)).toContain("in-flight.txt");

    const written = (await readdir(home)).sort();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await readdir(home)).sort()).toEqual(written);

    service.start();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(initializing).toHaveBeenCalledTimes(1);
  });
});
