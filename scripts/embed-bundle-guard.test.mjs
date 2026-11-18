import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  EMBED_MAX_BYTES,
  FORBIDDEN_PROTOCOL_MARKER,
  bareImportSpecifiers,
  formatEmbedBundleFailure,
  inspectEmbedBundle,
} from "./embed-bundle-guard.mjs";

const guardPath = fileURLToPath(new URL("./embed-bundle-guard.mjs", import.meta.url));

function bundle(source) {
  return { source, byteLength: Buffer.byteLength(source) };
}

test("accepts a bundle with only built-in and relative imports", () => {
  const source = [
    'import { readFile } from "node:fs/promises";',
    'import path from "node:path";',
    'import "./setup.js";',
    'import "#internal/thing";',
    'const lazy = import("./chunk.js");',
  ].join("\n");
  assert.deepEqual(bareImportSpecifiers(source), []);
  assert.deepEqual(inspectEmbedBundle(bundle(source)), []);
});

test("rejects a bundle above the size ceiling with the limit and the fix", () => {
  const violations = inspectEmbedBundle({
    source: "",
    byteLength: EMBED_MAX_BYTES + 1,
  });
  assert.equal(violations.length, 1);
  assert.match(violations[0].reason, /above the 3\.00 MB limit/);
  assert.match(violations[0].fix, /clientRuntime/);
});

test("rejects generated protocol validators", () => {
  const violations = inspectEmbedBundle(bundle(`const table = "${FORBIDDEN_PROTOCOL_MARKER}";`));
  assert.equal(violations.length, 1);
  assert.match(violations[0].reason, /ws-outbound\.aot/);
  assert.match(violations[0].fix, /protocol types only/);
});

test("rejects static, dynamic, require and re-export bare imports", () => {
  const source = [
    'import { Effect } from "effect";',
    'const lazy = import("zod");',
    'const copy = require("fs-extra");',
    'export { thing } from "@synara/contracts";',
  ].join("\n");
  assert.deepEqual(bareImportSpecifiers(source), [
    "@synara/contracts",
    "effect",
    "fs-extra",
    "zod",
  ]);
  const violations = inspectEmbedBundle(bundle(source));
  assert.equal(violations.length, 1);
  assert.match(violations[0].reason, /bare package imports: @synara\/contracts, effect/);
});

test("ignores import-looking text inside strings and comments", () => {
  // Effect's schema metadata embeds this exact declaration as a string.
  const source = [
    "const declaration = 'import * as Cause from \"effect/Cause\"';",
    'const template = `from "zod"`;',
    '// import x from "fs-extra";',
    '/* require("acorn"); */',
    "console.log(declaration, template);",
  ].join("\n");
  assert.deepEqual(bareImportSpecifiers(source), []);
  assert.deepEqual(inspectEmbedBundle(bundle(source)), []);
});

test("formats every violation with its reason and fix", () => {
  const message = formatEmbedBundleFailure("/tmp/embed.js", [
    { reason: "first", fix: "do this" },
    { reason: "second", fix: "do that" },
  ]);
  assert.match(message, /Refusing to ship the web app bundle at \/tmp\/embed\.js/);
  assert.match(message, /- first\n {2}fix: do this/);
  assert.match(message, /- second\n {2}fix: do that/);
});

test("the command succeeds on a clean bundle and fails on a violating one", () => {
  const dir = mkdtempSync(join(tmpdir(), "embed-guard-"));
  try {
    const clean = join(dir, "clean.js");
    writeFileSync(clean, 'import path from "node:path";\nconsole.log(path);\n');
    const passed = spawnSync(process.execPath, [guardPath, clean], { encoding: "utf8" });
    assert.equal(passed.status, 0);
    assert.match(passed.stdout, /Embed guard passed/);

    const leaked = join(dir, "leaked.js");
    writeFileSync(leaked, 'import { Effect } from "effect";\n');
    const failed = spawnSync(process.execPath, [guardPath, leaked], { encoding: "utf8" });
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /bare package imports: effect/);
    assert.match(failed.stderr, /fix: the daemon-hosted bundle must be self-contained/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
