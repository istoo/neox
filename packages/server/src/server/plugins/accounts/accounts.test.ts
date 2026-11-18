import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PluginAccountsError } from "@neolix/plugin/server/accounts";
import { PluginAccountsStore } from "./index.js";

async function directory(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "neolix-plugin-accounts-"));
}

describe("PluginAccountsStore", () => {
  it("reads and writes one plugin's sign-ins, sorted by id", async () => {
    const store = new PluginAccountsStore(await directory());
    await expect(store.list()).resolves.toEqual([]);
    await expect(store.read("qoder")).resolves.toBeNull();

    await store.write("qoder#second", { access: "b", expires: 2 });
    await store.write("qoder", { access: "a", refresh: "r", expires: 1 });

    await expect(store.list()).resolves.toEqual(["qoder", "qoder#second"]);
    await expect(store.read("qoder")).resolves.toEqual({ access: "a", refresh: "r", expires: 1 });
    await expect(store.read("qoder#second")).resolves.toEqual({ access: "b", expires: 2 });
  });

  it("keeps the file private", async () => {
    const dir = await directory();
    const store = new PluginAccountsStore(dir);
    await store.write("qoder", { access: "a" });
    // Windows cannot express POSIX permissions; the file is private by location there.
    if (process.platform !== "win32") {
      const info = await stat(path.join(dir, "accounts.json"));
      expect(info.mode & 0o777).toBe(0o600);
    }
    const saved = JSON.parse(await readFile(path.join(dir, "accounts.json"), "utf8")) as {
      version: number;
    };
    expect(saved.version).toBe(1);
  });

  it("serializes concurrent writes instead of losing one", async () => {
    const store = new PluginAccountsStore(await directory());
    await Promise.all([
      store.write("a", { access: "1" }),
      store.write("b", { access: "2" }),
      store.write("c", { access: "3" }),
    ]);
    await expect(store.list()).resolves.toEqual(["a", "b", "c"]);
    await expect(store.read("b")).resolves.toEqual({ access: "2" });
  });

  it("removes an entry and says whether there was one", async () => {
    const store = new PluginAccountsStore(await directory());
    await store.write("a", { access: "1" });
    await expect(store.remove("a")).resolves.toBe(true);
    await expect(store.remove("a")).resolves.toBe(false);
    await expect(store.list()).resolves.toEqual([]);
  });

  it("refuses to write over a file it can't read", async () => {
    const dir = await directory();
    const file = path.join(dir, "accounts.json");
    await writeFile(file, "{not json", "utf8");
    const store = new PluginAccountsStore(dir);
    await expect(store.read("a")).rejects.toBeInstanceOf(PluginAccountsError);
    await expect(store.write("a", { access: "1" })).rejects.toBeInstanceOf(PluginAccountsError);
    await expect(store.remove("a")).rejects.toBeInstanceOf(PluginAccountsError);
    await expect(readFile(file, "utf8")).resolves.toBe("{not json");
  });

  it("rejects ids and auth that aren't storable", async () => {
    const store = new PluginAccountsStore(await directory());
    await expect(store.write("", {})).rejects.toBeInstanceOf(PluginAccountsError);
    await expect(store.write("a/b", {})).rejects.toBeInstanceOf(PluginAccountsError);
    await expect(store.write("a", [])).rejects.toBeInstanceOf(PluginAccountsError);
    await expect(store.write("a", null as never)).rejects.toBeInstanceOf(PluginAccountsError);
    await expect(store.write("a", { fn: () => 1 } as never)).rejects.toBeInstanceOf(
      PluginAccountsError,
    );
  });
});
