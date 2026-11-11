import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readJsonObject, writeJsonObject } from "./config-files.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(tmpdir(), "neolix-config-files-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("writeJsonObject", () => {
  it("edits a commented JSONC file where it changed, keeping comments and order", async () => {
    const file = path.join(dir, "config.json");
    await fs.writeFile(
      file,
      [
        "{",
        "  // the reader's theme",
        '  "theme": "dark",',
        '  "env": { "A": "1" }, /* beside it */',
        '  "list": [1, 2]',
        "}",
        "",
      ].join("\n"),
    );
    const value = await readJsonObject(file);
    (value.env as Record<string, unknown>).A = "2";
    (value.env as Record<string, unknown>).B = "3";
    value.theme = "light";

    const text = await writeJsonObject(file, value);
    expect(text).toContain("// the reader's theme");
    expect(text).toContain("/* beside it */");
    expect(text).toContain('"A": "2"');
    expect(text).toContain('"B": "3"');
    expect(text).toContain('"theme": "light"');
    expect(text.indexOf('"theme"')).toBeLessThan(text.indexOf('"env"'));
    expect(await readJsonObject(file)).toEqual({
      theme: "light",
      env: { A: "2", B: "3" },
      list: [1, 2],
    });
  });

  it("takes a key out and leaves the rest of the file as it was", async () => {
    const file = path.join(dir, "config.json");
    await fs.writeFile(
      file,
      ["{", "  // keep me", '  "keep": true,', '  "gone": { "nested": 1 }', "}", ""].join("\n"),
    );
    const value = await readJsonObject(file);
    delete value.gone;
    const text = await writeJsonObject(file, value);
    expect(text).toContain("// keep me");
    expect(text).not.toContain('"gone"');
    expect(await readJsonObject(file)).toEqual({ keep: true });
  });

  it("keeps a key the user added after the caller read the file", async () => {
    const file = path.join(dir, "settings.json");
    await fs.writeFile(file, `${JSON.stringify({ env: { A: "1" } }, null, 2)}\n`);
    const value = await readJsonObject(file);
    const base = structuredClone(value);
    // The user edits the file while the caller holds its copy.
    await fs.writeFile(
      file,
      `${JSON.stringify({ env: { A: "1" }, userKept: { important: true } }, null, 2)}\n`,
    );
    (value.env as Record<string, unknown>).B = "2";

    await writeJsonObject(file, value, base);

    expect(await readJsonObject(file)).toEqual({
      env: { A: "1", B: "2" },
      userKept: { important: true },
    });
  });

  it("keeps the user's key and comments beside a JSONC edit", async () => {
    const file = path.join(dir, "config.json");
    await fs.writeFile(file, ["{", '  "env": { "A": "1" }', "}", ""].join("\n"));
    const value = await readJsonObject(file);
    const base = structuredClone(value);
    // The user adds a key and a comment while the caller holds its copy.
    await fs.writeFile(
      file,
      ["{", "  // the user's note", '  "env": { "A": "1" },', '  "userKept": true', "}", ""].join(
        "\n",
      ),
    );
    (value.env as Record<string, unknown>).B = "2";

    const text = await writeJsonObject(file, value, base);

    expect(text).toContain("// the user's note");
    expect(await readJsonObject(file)).toEqual({
      env: { A: "1", B: "2" },
      userKept: true,
    });
  });
});
