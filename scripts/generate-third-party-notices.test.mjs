import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  collectDesktopWebPackages,
  mergePackages,
  parseBunLock,
  renderNotices,
} from "./generate-third-party-notices.mjs";

const MIT_TEXT = `The MIT License (MIT)

Permission is hereby granted, free of charge, to any person obtaining a copy.
`;

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function writePackage(dir, pkg, extraFiles = {}) {
  writeJson(path.join(dir, "package.json"), pkg);
  for (const [name, contents] of Object.entries(extraFiles)) {
    writeFileSync(path.join(dir, name), contents);
  }
}

function writeBunLock(desktopWebDir) {
  // Trailing commas match Bun's on-disk format.
  writeFileSync(
    path.join(desktopWebDir, "bun.lock"),
    `{
  "lockfileVersion": 3,
  "workspaces": {
    "": { "name": "@fixture/workspace", },
    "apps/web": {
      "name": "@fixture/web",
      "dependencies": { "alpha": "^1.0.0", "@fixture/lib": "workspace:*", "delta": "^1.0.0" },
      "devDependencies": { "vitest": "catalog:" },
    },
    "apps/bridge": {
      "name": "@fixture/bridge",
      "dependencies": { "beta": "^2.0.0" },
    },
    "packages/lib": {
      "name": "@fixture/lib",
      "dependencies": { "alpha": "^1.0.0", "gamma": "^3.0.0" },
    },
  },
  "packages": {
    "alpha": ["alpha@1.0.0", "", { "dependencies": { "shared": "^1.0.0" } }, "sha512-alpha"],
    "beta": ["beta@2.0.0", { "dependencies": {} }, "sha512-beta"],
    "delta": ["delta@1.0.0", "", {}, "sha512-delta"],
    "gamma": ["gamma@3.0.0", "", {}, "sha512-gamma"],
    "shared": ["shared@1.0.0", "", {}, "sha512-shared"],
  },
}
`,
    "utf8",
  );
}

function createFixture(t) {
  const desktopWebDir = mkdtempSync(path.join(tmpdir(), "neolix-notices-"));
  t.after(() => rmSync(desktopWebDir, { recursive: true, force: true }));

  writeBunLock(desktopWebDir);
  writeJson(path.join(desktopWebDir, "apps/web/package.json"), {
    name: "@fixture/web",
    dependencies: { alpha: "^1.0.0", "@fixture/lib": "workspace:*", delta: "^1.0.0" },
    devDependencies: { vitest: "catalog:" },
  });
  writeJson(path.join(desktopWebDir, "apps/bridge/package.json"), {
    name: "@fixture/bridge",
    dependencies: { beta: "^2.0.0" },
  });

  writePackage(path.join(desktopWebDir, "packages/lib"), {
    name: "@fixture/lib",
    dependencies: { alpha: "^1.0.0", gamma: "^3.0.0" },
  });

  writePackage(path.join(desktopWebDir, "apps/web/node_modules/alpha"), {
    name: "alpha",
    version: "1.0.0",
    license: "MIT",
    dependencies: { shared: "^1.0.0" },
  });
  writePackage(
    path.join(desktopWebDir, "apps/web/node_modules/shared"),
    {
      name: "shared",
      version: "1.0.0",
    },
    {
      // Lowercase LICENSE file, as some packages ship.
      license: MIT_TEXT,
    },
  );
  writePackage(path.join(desktopWebDir, "apps/web/node_modules/delta"), {
    name: "delta",
    version: "1.0.0",
  });
  writePackage(path.join(desktopWebDir, "apps/bridge/node_modules/beta"), {
    name: "beta",
    version: "2.0.0",
    license: "Apache-2.0",
  });
  writePackage(path.join(desktopWebDir, "packages/lib/node_modules/alpha"), {
    name: "alpha",
    version: "1.0.0",
    license: "MIT",
    dependencies: { shared: "^1.0.0" },
  });
  writePackage(path.join(desktopWebDir, "packages/lib/node_modules/gamma"), {
    name: "gamma",
    version: "3.0.0",
    license: "ISC",
  });
  return desktopWebDir;
}

test("parses Bun's lockfile despite trailing commas", () => {
  const lock = parseBunLock('{ "packages": { "alpha": ["alpha@1.0.0", "", {},], }, }');
  assert.deepEqual(lock.packages.alpha, ["alpha@1.0.0", "", {}]);
});

test("collects the production dependency closure of apps/web and apps/bridge", (t) => {
  const desktopWebDir = createFixture(t);
  const { packages, missing } = collectDesktopWebPackages(desktopWebDir);
  const byName = new Map(packages.map((entry) => [entry.name, entry]));

  assert.deepEqual(missing, []);
  assert.deepEqual([...byName.keys()].sort(), ["alpha", "beta", "delta", "gamma", "shared"]);
  // Workspace packages are Neolix's own; devDependencies (vitest) never ship.
  assert.ok(!byName.has("@fixture/lib"));
  assert.ok(!byName.has("@fixture/web"));
  assert.ok(!byName.has("vitest"));
  // Reached through both apps/web and packages/lib, listed once.
  assert.equal(packages.filter((entry) => entry.name === "alpha").length, 1);
  assert.deepEqual(byName.get("beta"), {
    name: "beta",
    version: "2.0.0",
    license: "Apache-2.0",
  });
  // Missing package.json license falls back to the LICENSE file.
  assert.equal(byName.get("shared").license, "MIT");
  // Nothing to read: stays UNKNOWN rather than guessing.
  assert.equal(byName.get("delta").license, "UNKNOWN");
});

test("reports dependencies that are not installed", (t) => {
  const desktopWebDir = createFixture(t);
  writeJson(path.join(desktopWebDir, "apps/bridge/package.json"), {
    dependencies: { absent: "^1.0.0" },
  });

  const { missing } = collectDesktopWebPackages(desktopWebDir);
  assert.deepEqual(missing, ["absent (required by apps/bridge)"]);
});

test("merges lockfile and desktop-web entries without duplicates", () => {
  const merged = mergePackages(
    [
      { name: "zeta", version: "1.0.0", license: "MIT" },
      { name: "alpha", version: "2.0.0", license: "MIT" },
    ],
    [
      { name: "alpha", version: "2.0.0", license: "Apache-2.0" },
      { name: "alpha", version: "10.0.0", license: "MIT" },
    ],
  );

  assert.deepEqual(merged, [
    { name: "alpha", version: "2.0.0", license: "Apache-2.0" },
    { name: "alpha", version: "10.0.0", license: "MIT" },
    { name: "zeta", version: "1.0.0", license: "MIT" },
  ]);
});

test("renders the existing notices format", () => {
  const text = renderNotices([
    { name: "alpha", version: "1.0.0", license: "MIT" },
    { name: "zeta", version: "2.0.0", license: "Apache-2.0" },
  ]);

  assert.equal(
    text,
    [
      "Neox third-party notices",
      "========================",
      "",
      "Neox is built with the following third-party packages. Each is used",
      "under the license named beside it; the full license text ships inside",
      "the package in node_modules.",
      "",
      "alpha 1.0.0 — MIT",
      "zeta 2.0.0 — Apache-2.0",
      "",
    ].join("\n"),
  );
});
