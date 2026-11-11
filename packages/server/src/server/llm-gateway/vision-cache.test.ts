import { createHash } from "node:crypto";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VisionCache } from "./vision-cache.js";

const dirs: string[] = [];

async function home(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "neolix-vision-cache-"));
  dirs.push(dir);
  return dir;
}

function key(name: string): string {
  return createHash("sha256").update(name).digest("hex");
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("the description cache", () => {
  it("keeps an inline image's description across a restart", async () => {
    const neolixHome = await home();
    const first = new VisionCache(neolixHome);
    await first.start();
    first.set(key("a"), { text: "a red square", by: "probe/eye" }, true);
    await first.dispose();

    const second = new VisionCache(neolixHome);
    await second.start();
    expect(second.get(key("a"))).toEqual({ text: "a red square", by: "probe/eye" });
    const saved = await readFile(second.filePath, "utf8");
    expect(saved).toContain('"version":2');
    expect(saved).toContain('"kind":"inline"');
  });

  it("keeps a URL's description in memory only", async () => {
    const neolixHome = await home();
    const first = new VisionCache(neolixHome);
    await first.start();
    first.set(key("b"), { text: "a photo", by: "probe/eye" }, false);
    expect(first.get(key("b"))).toEqual({ text: "a photo", by: "probe/eye" });
    await first.dispose();

    const second = new VisionCache(neolixHome);
    await second.start();
    expect(second.get(key("b"))).toBeNull();
  });

  it("skips lines it cannot read, and takes the newest for a key", async () => {
    const neolixHome = await home();
    const cache = new VisionCache(neolixHome);
    await cache.start();
    cache.set(key("c"), { text: "old", by: "probe/eye" }, true);
    await cache.dispose();
    await appendFile(cache.filePath, "not json\n");
    await appendFile(
      cache.filePath,
      `${JSON.stringify({ version: 1, kind: "inline", key: key("c"), text: "old", by: "x" })}\n`,
    );
    await appendFile(
      cache.filePath,
      `${JSON.stringify({ version: 2, kind: "inline", key: key("c"), text: "new", by: "probe/eye" })}\n`,
    );

    const loaded = new VisionCache(neolixHome);
    await loaded.start();
    expect(loaded.get(key("c"))).toEqual({ text: "new", by: "probe/eye" });
  });

  it("keeps the newest 2048 descriptions, and one used again outlives newer ones", async () => {
    const cache = new VisionCache(await home());
    await cache.start();
    for (let index = 0; index < 2048; index += 1) {
      cache.set(key(`entry-${index}`), { text: `text ${index}`, by: "probe/eye" }, false);
    }
    expect(cache.get(key("entry-0"))).not.toBeNull();

    cache.set(key("extra"), { text: "extra", by: "probe/eye" }, false);
    expect(cache.get(key("entry-0"))).not.toBeNull();
    expect(cache.get(key("entry-1"))).toBeNull();
    expect(cache.get(key("extra"))).not.toBeNull();
  });

  it("writes the file readable only by its owner", async () => {
    const neolixHome = await home();
    const cache = new VisionCache(neolixHome);
    await cache.start();
    cache.set(key("d"), { text: "a chart", by: "probe/eye" }, true);
    await cache.dispose();
    const { mode } = await import("node:fs/promises").then((fs) => fs.stat(cache.filePath));
    expect(mode & 0o777).toBe(0o600);
  });
});
