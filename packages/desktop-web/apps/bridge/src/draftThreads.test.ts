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
