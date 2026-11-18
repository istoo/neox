import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { OrchestrationThreadShell } from "@synara/contracts";

import { DraftThreads } from "./draftThreads.ts";

const AT = "2026-11-10T06:00:00.000Z";
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function draft(id: string): OrchestrationThreadShell {
  return {
    id,
    projectId: "prj_1",
    title: "New terminal",
    createdAt: AT,
    updatedAt: AT,
  } as unknown as OrchestrationThreadShell;
}

async function makeFile() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-draft-threads-"));
  dirs.push(dir);
  return path.join(dir, "desktop-web", "draft-threads.json");
}

describe("DraftThreads", () => {
  it("keeps each host's drafts across restarts", async () => {
    const file = await makeFile();
    await new DraftThreads({ file, scope: "host-a", log: () => {} }).save([draft("a1")]);
    await new DraftThreads({ file, scope: "host-b", log: () => {} }).save([draft("b1")]);

    const a = await new DraftThreads({ file, scope: "host-a", log: () => {} }).load();
    const b = await new DraftThreads({ file, scope: "host-b", log: () => {} }).load();
    expect(a.map((shell) => shell.id)).toEqual(["a1"]);
    expect(b.map((shell) => shell.id)).toEqual(["b1"]);
  });

  it("moves drafts from the address-derived scope to the stable one", async () => {
    const file = await makeFile();
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(
      file,
      JSON.stringify({ "neolix-host-reg-1": [draft("old"), draft("same")] }),
    );

    const store = new DraftThreads({
      file,
      scope: "srv-remote",
      legacyScopes: ["neolix-host-reg-1"],
      log: () => {},
    });
    const loaded = await store.load();
    expect(loaded.map((shell) => shell.id)).toEqual(["old", "same"]);

    const stored = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
    expect((stored["srv-remote"] as Array<{ id: string }>).map((row) => row.id)).toEqual([
      "old",
      "same",
    ]);
    // The legacy key stays readable so a downgraded bridge still sees the draft.
    expect((stored["neolix-host-reg-1"] as Array<{ id: string }>).map((row) => row.id)).toEqual([
      "old",
      "same",
    ]);

    // Deleting a migrated draft must stick; a stale legacy copy cannot bring it back.
    await new DraftThreads({ file, scope: "srv-remote", log: () => {} }).save([draft("same")]);
    const restarted = new DraftThreads({
      file,
      scope: "srv-remote",
      legacyScopes: ["neolix-host-reg-1"],
      log: () => {},
    });
    expect((await restarted.load()).map((shell) => shell.id)).toEqual(["same"]);
  });

  it("applies saves in order", async () => {
    const file = await makeFile();
    const store = new DraftThreads({ file, scope: "host-a", log: () => {} });
    void store.save([draft("a1"), draft("a2")]);
    await store.save([draft("a2")]);

    const loaded = await new DraftThreads({ file, scope: "host-a", log: () => {} }).load();
    expect(loaded.map((shell) => shell.id)).toEqual(["a2"]);
  });

  it("skips rows that are not draft shells and survives an unreadable file", async () => {
    const file = await makeFile();
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ "host-a": [draft("ok"), { id: 7 }, null] }));
    const loaded = await new DraftThreads({ file, scope: "host-a", log: () => {} }).load();
    expect(loaded.map((shell) => shell.id)).toEqual(["ok"]);

    await fs.writeFile(file, "{ not json");
    const lines: string[] = [];
    const broken = new DraftThreads({ file, scope: "host-a", log: (line) => lines.push(line) });
    expect(await broken.load()).toEqual([]);
    expect(lines[0]).toContain("unreadable");
  });
});
