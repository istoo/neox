#!/usr/bin/env node
// Generates the third-party license list Neolix ships: `neolix licenses` and
// Settings › About. It merges two sources:
//   - the production entries in the root package-lock.json (daemon and CLI), and
//   - the production closure of packages/desktop-web (a separate Bun workspace)
//     whose web page and bridge embed.js ship with the app.
//
// The desktop-web closure starts at apps/web and apps/bridge, follows
// `dependencies` through bun.lock and each workspace package.json, and stops at
// devDependencies. License identifiers come from the installed package.json,
// falling back to the package's LICENSE file.
//
// The list names each package, its version and its license. Full texts live
// in the packages themselves; run `npm run generate:notices` after a
// dependency change and commit the result.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isMainModule } from "./is-main-module.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DESKTOP_WEB_DIR = path.join(repoRoot, "packages", "desktop-web");
const DESKTOP_WEB_APPS = ["apps/web", "apps/bridge"];
const OUTPUT = path.join(repoRoot, "packages/protocol/src/generated/third-party-notices.ts");
const NOTICE_TITLE = "Neox third-party notices";
const LICENSE_FILE_PATTERN = /^(?:licen[cs]e|copying|notice|unlicense)(?:\..*)?$/i;

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

export function packageNameFromPath(entryPath) {
  const marker = "node_modules/";
  const index = entryPath.lastIndexOf(marker);
  if (index < 0) {
    return null;
  }
  const parts = entryPath.slice(index + marker.length).split("/");
  if (parts[0]?.startsWith("@")) {
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
  }
  return parts[0] ?? null;
}

export function licenseName(license) {
  if (typeof license === "string" && license.trim()) {
    return license.trim();
  }
  if (license && typeof license === "object" && typeof license.type === "string") {
    return license.type.trim();
  }
  return "UNKNOWN";
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Bun's lockfile is JSON with trailing commas. */
export function parseBunLock(source) {
  let output = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }
    if (char === ",") {
      let next = index + 1;
      while (next < source.length && /\s/.test(source[next])) {
        next += 1;
      }
      if (source[next] === "}" || source[next] === "]") {
        continue;
      }
    }
    output += char;
  }
  return JSON.parse(output);
}

/** A lock key is `name` or `name@version`; scoped names start with `@`. */
function lockEntryName(key) {
  const at = key.lastIndexOf("@");
  if (at > 0 && /^[0-9]/.test(key.slice(at + 1))) {
    return key.slice(0, at);
  }
  return key;
}

export function lockPackagesByName(lock) {
  const byName = new Map();
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    if (!Array.isArray(entry)) {
      continue;
    }
    // Registry entries carry "" at index 1; URL/git entries put metadata there.
    const metadata =
      entry.find((value) => value !== null && typeof value === "object" && !Array.isArray(value)) ??
      {};
    const dependencies =
      metadata.dependencies && typeof metadata.dependencies === "object"
        ? metadata.dependencies
        : {};
    const name = lockEntryName(key);
    const entries = byName.get(name) ?? [];
    entries.push({
      resolved: typeof entry[0] === "string" ? entry[0] : "",
      dependencies,
    });
    byName.set(name, entries);
  }
  return byName;
}

function findLockEntry(entries, version) {
  if (!entries || entries.length === 0) {
    return null;
  }
  return entries.find((entry) => entry.resolved.endsWith(`@${version}`)) ?? entries[0];
}

/** Workspace package names resolve to their source directory, not node_modules. */
export function workspacePackages(desktopWebDir, lock) {
  const packages = new Map();
  for (const key of Object.keys(lock.workspaces ?? {})) {
    if (!key) {
      continue;
    }
    const dir = path.resolve(desktopWebDir, key);
    if (!isInside(desktopWebDir, dir)) {
      continue;
    }
    const packageJsonPath = path.join(dir, "package.json");
    if (!existsSync(packageJsonPath)) {
      continue;
    }
    const pkg = readJson(packageJsonPath);
    if (typeof pkg.name === "string" && pkg.name) {
      packages.set(pkg.name, { dir, pkg });
    }
  }
  return packages;
}

/** Node resolution over Bun's isolated install layout (deps live beside packages). */
export function resolveInstalledPackage(fromDir, name, desktopWebDir) {
  let current = fromDir;
  while (isInside(desktopWebDir, current)) {
    if (path.basename(current) !== "node_modules") {
      const candidate = path.join(current, "node_modules", name);
      if (existsSync(candidate)) {
        return realpathSync(candidate);
      }
    }
    if (current === desktopWebDir) {
      break;
    }
    current = path.dirname(current);
  }
  return null;
}

function detectLicense(text) {
  const sample = text.slice(0, 16_384);
  if (/apache license/i.test(sample)) return "Apache-2.0";
  if (/mit license|permission is hereby granted, free of charge/i.test(sample)) return "MIT";
  if (/isc license|permission to use, copy, modify, and\/or distribute/i.test(sample)) return "ISC";
  if (/bsd 2-clause/i.test(sample)) return "BSD-2-Clause";
  if (/bsd 3-clause|redistribution and use in source and binary forms/i.test(sample)) {
    return "BSD-3-Clause";
  }
  if (/mozilla public license version 2\.0/i.test(sample)) return "MPL-2.0";
  if (/gnu lesser general public license/i.test(sample)) return "LGPL-3.0";
  if (/gnu general public license/i.test(sample)) return "GPL-3.0";
  if (/the unlicense/i.test(sample)) return "Unlicense";
  if (/cc0/i.test(sample)) return "CC0-1.0";
  return null;
}

/** package.json's license wins; some packages only ship a LICENSE file. */
export function readPackageLicense(dir, pkg) {
  const declared = licenseName(pkg.license);
  if (declared !== "UNKNOWN") {
    return declared;
  }
  let entries = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return "UNKNOWN";
  }
  for (const file of entries.filter((entry) => LICENSE_FILE_PATTERN.test(entry)).sort()) {
    const detected = detectLicense(readFileSync(path.join(dir, file), "utf8"));
    if (detected) {
      return detected;
    }
  }
  return "UNKNOWN";
}

/**
 * Production dependency closure of the desktop-web entry points. Dev-only
 * dependencies and the workspace's own packages are excluded.
 */
export function collectDesktopWebPackages(desktopWebDir, { appDirs = DESKTOP_WEB_APPS } = {}) {
  // Installed dependencies resolve to real paths; compare inside the same root.
  const webRoot = realpathSync(desktopWebDir);
  const lock = parseBunLock(readFileSync(path.join(webRoot, "bun.lock"), "utf8"));
  const workspaces = workspacePackages(webRoot, lock);
  const lockByName = lockPackagesByName(lock);
  const collected = new Map();
  const visited = new Set();
  const missing = [];
  const queue = [];

  const enqueueDependencies = (dependencies, fromDir) => {
    for (const name of Object.keys(dependencies ?? {})) {
      queue.push({ name, fromDir });
    }
  };

  for (const app of appDirs) {
    const dir = path.join(webRoot, app);
    enqueueDependencies(readJson(path.join(dir, "package.json")).dependencies, dir);
  }

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const { name, fromDir } = queue[cursor];
    const workspace = workspaces.get(name);
    if (workspace) {
      const identity = `workspace:${name}`;
      if (!visited.has(identity)) {
        visited.add(identity);
        enqueueDependencies(workspace.pkg.dependencies, workspace.dir);
      }
      continue;
    }

    const dir = resolveInstalledPackage(fromDir, name, webRoot);
    if (!dir) {
      missing.push(`${name} (required by ${path.relative(webRoot, fromDir) || "."})`);
      continue;
    }
    const pkg = readJson(path.join(dir, "package.json"));
    if (typeof pkg.name !== "string" || typeof pkg.version !== "string") {
      missing.push(`${name} (invalid package.json at ${path.relative(webRoot, dir)})`);
      continue;
    }
    const identity = `${pkg.name}\u0000${pkg.version}`;
    if (visited.has(identity)) {
      continue;
    }
    visited.add(identity);
    collected.set(identity, {
      name: pkg.name,
      version: pkg.version,
      license: readPackageLicense(dir, pkg),
    });

    const lockEntry = findLockEntry(lockByName.get(pkg.name), pkg.version);
    enqueueDependencies(lockEntry?.dependencies ?? pkg.dependencies, dir);
  }

  return { packages: [...collected.values()], missing };
}

export function collectRootPackages(rootDir) {
  const lock = readJson(path.join(rootDir, "package-lock.json"));
  const packages = new Map();
  for (const [entryPath, entry] of Object.entries(lock.packages ?? {})) {
    // Workspace packages are Neolix's own; dev-only entries never ship.
    if (!entryPath.startsWith("node_modules/")) {
      continue;
    }
    if (entry.dev === true) {
      continue;
    }
    const name = packageNameFromPath(entryPath);
    const version = typeof entry.version === "string" ? entry.version : "";
    if (!name || !version) {
      continue;
    }
    packages.set(`${name}\u0000${version}`, {
      name,
      version,
      license: licenseName(entry.license),
    });
  }
  return [...packages.values()];
}

function comparePackages(a, b) {
  return (
    a.name.toLowerCase().localeCompare(b.name.toLowerCase()) ||
    a.name.localeCompare(b.name) ||
    a.version.localeCompare(b.version, undefined, { numeric: true })
  );
}

export function mergePackages(...groups) {
  const packages = new Map();
  for (const group of groups) {
    for (const entry of group) {
      packages.set(`${entry.name}\u0000${entry.version}`, entry);
    }
  }
  return [...packages.values()].sort(comparePackages);
}

export function renderNotices(packages) {
  const lines = [
    NOTICE_TITLE,
    "=".repeat(NOTICE_TITLE.length),
    "",
    "Neox is built with the following third-party packages. Each is used",
    "under the license named beside it; the full license text ships inside",
    "the package in node_modules.",
    "",
  ];
  for (const entry of packages) {
    lines.push(`${entry.name} ${entry.version} — ${entry.license}`);
  }
  lines.push("");
  return lines.join("\n");
}

export function generateThirdPartyNotices({
  rootDir = repoRoot,
  desktopWebDir = path.join(rootDir, "packages", "desktop-web"),
  output = OUTPUT,
} = {}) {
  const desktop = collectDesktopWebPackages(desktopWebDir);
  if (desktop.missing.length > 0) {
    throw new Error(
      `Cannot resolve desktop-web dependencies:\n  ${desktop.missing.join("\n  ")}\n` +
        "Run `bun install` in packages/desktop-web and retry.",
    );
  }
  const packages = mergePackages(collectRootPackages(rootDir), desktop.packages);
  const text = renderNotices(packages);
  const source =
    "// Generated by scripts/generate-third-party-notices.mjs. Do not edit.\n" +
    "// Run `npm run generate:notices` after changing dependencies.\n\n" +
    `export const THIRD_PARTY_NOTICES =\n  ${JSON.stringify(text)};\n`;
  return { packages, source, output };
}

function main() {
  if (!existsSync(path.join(DESKTOP_WEB_DIR, "node_modules"))) {
    // The notices need the installed desktop-web packages for their licenses.
    // Builds that run before `bun install` keep the committed file instead of
    // rewriting it without the app's frontend dependencies.
    process.stderr.write(
      "Skipping third-party notices: packages/desktop-web dependencies are not installed " +
        "(run `bun install` there). The committed notices file is unchanged.\n",
    );
    return;
  }
  const { packages, source, output } = generateThirdPartyNotices();
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, source, "utf8");
  process.stdout.write(`Wrote ${packages.length} packages to ${path.relative(repoRoot, output)}\n`);
}

if (isMainModule(import.meta.url)) {
  main();
}
