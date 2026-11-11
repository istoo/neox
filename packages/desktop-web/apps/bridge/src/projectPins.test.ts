import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ProjectPins } from "./projectPins.ts";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makePins(scope: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-project-pins-"));
  dirs.push(dir);
  const file = path.join(dir, "desktop-web", "project-pins.json");
  return { file, pins: new ProjectPins({ file, scope, log: () => {} }) };
}

describe("projectPins", () => {
  it("keeps pins across restarts", async () => {
    const { file, pins } = await makePins("host-a");
    await pins.load();
    await pins.setPinned("prj_1", true);

    const restarted = new ProjectPins({ file, scope: "host-a", log: () => {} });
    await restarted.load();
    expect(restarted.isPinned("prj_1")).toBe(true);

    await restarted.setPinned("prj_1", false);
    const again = new ProjectPins({ file, scope: "host-a", log: () => {} });
    await again.load();
    expect(again.isPinned("prj_1")).toBe(false);
  });

  it("keeps each host's pins separate in one file", async () => {
    const { file, pins } = await makePins("host-a");
    await pins.load();
    await pins.setPinned("prj_a", true);

    const other = new ProjectPins({ file, scope: "host-b", log: () => {} });
    await other.load();
    await other.setPinned("prj_b", true);

    const first = new ProjectPins({ file, scope: "host-a", log: () => {} });
    await first.load();
    const second = new ProjectPins({ file, scope: "host-b", log: () => {} });
    await second.load();
    expect(first.isPinned("prj_a")).toBe(true);
    expect(first.isPinned("prj_b")).toBe(false);
    expect(second.isPinned("prj_b")).toBe(true);
  });

  it("starts empty when the file is missing or malformed", async () => {
    const { file, pins } = await makePins("host-a");
    await pins.load();
    expect(pins.isPinned("prj_1")).toBe(false);

    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "not json", "utf8");
    const malformed = new ProjectPins({ file, scope: "host-a", log: () => {} });
    await malformed.load();
    expect(malformed.isPinned("prj_1")).toBe(false);
  });
});
