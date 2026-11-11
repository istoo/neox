import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  UnreadableFileError,
  backupPath,
  isValidJson,
  keepLastGood,
  readLastGood,
  readLastGoodSync,
  recoveredFiles,
  resetRecoveredFiles,
} from "./last-good.js";
import { writeJsonFileAtomicKeepingLastGood } from "./atomic-file.js";

let directory: string;
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "neolix-last-good-"));
  resetRecoveredFiles();
});
afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});

it("keeps the previous generation as .bak before a write", async () => {
  const file = path.join(directory, "config.json");
  await fs.writeFile(file, JSON.stringify({ a: 1 }));
  await writeJsonFileAtomicKeepingLastGood(file, { a: 2 });
  expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({ a: 2 });
  expect(JSON.parse(await fs.readFile(backupPath(file), "utf8"))).toEqual({ a: 1 });
});

it("reads the .bak when the file is a full length of zeros", async () => {
  const file = path.join(directory, "logins.json");
  await fs.writeFile(backupPath(file), JSON.stringify({ accounts: ["a"] }));
  await fs.writeFile(file, Buffer.alloc(64));
  const contents = await readLastGood(file, isValidJson);
  expect(JSON.parse(contents.toString("utf8"))).toEqual({ accounts: ["a"] });
  expect(recoveredFiles()).toHaveLength(1);
  expect(recoveredFiles()[0]?.why).toBe("64 bytes, every one zero");
});

it("reports an unreadable file with no good backup instead of an empty one", async () => {
  const file = path.join(directory, "logins.json");
  await fs.writeFile(file, "{not json");
  await expect(readLastGood(file, isValidJson)).rejects.toBeInstanceOf(UnreadableFileError);
  expect(recoveredFiles()).toHaveLength(0);
});

it("treats an empty file as unreadable, not empty", async () => {
  const file = path.join(directory, "settings.json");
  await fs.writeFile(file, "   \n");
  await expect(readLastGood(file, isValidJson)).rejects.toBeInstanceOf(UnreadableFileError);
});

it("keeps a bad file aside before writing over it", async () => {
  const file = path.join(directory, "accounts.json");
  await fs.writeFile(file, Buffer.alloc(8));
  await writeJsonFileAtomicKeepingLastGood(file, { ok: true });
  const kept = (await fs.readdir(directory)).filter((name) =>
    name.startsWith("accounts.json.bad-"),
  );
  expect(kept).toHaveLength(1);
  expect((await fs.readFile(path.join(directory, kept[0]!), "utf8")).length).toBe(8);
  expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({ ok: true });
});

it("keeps one copy of the same bad contents", async () => {
  const file = path.join(directory, "accounts.json");
  await fs.writeFile(file, Buffer.alloc(8));
  await keepLastGood(file, isValidJson);
  await fs.writeFile(file, Buffer.alloc(8));
  await keepLastGood(file, isValidJson);
  const kept = (await fs.readdir(directory)).filter((name) =>
    name.startsWith("accounts.json.bad-"),
  );
  expect(kept).toHaveLength(1);
});

it("a file that is not there is not a recovery", async () => {
  const file = path.join(directory, "absent.json");
  await expect(readLastGood(file, isValidJson)).rejects.toMatchObject({ code: "ENOENT" });
  await keepLastGood(file, isValidJson);
  expect(await fs.readdir(directory)).toEqual([]);
});

it("reads the last good generation on a synchronous startup path", async () => {
  const file = path.join(directory, "config.json");
  await fs.writeFile(backupPath(file), JSON.stringify({ good: true }));
  await fs.writeFile(file, "");
  expect(JSON.parse(readLastGoodSync(file, isValidJson).toString("utf8"))).toEqual({ good: true });
});
