// Build-time guard for the daemon-hosted web app bundle (`embed.js`). The daemon already
// has the Neox client, its protocol validators and the credential reader loaded, so it
// injects them at runtime (packages/desktop-web/apps/bridge/src/clientRuntime.ts). If the
// bundle pulls any of that in, it ships a second copy (~16 MB) and the daemon pays for it
// on every start. This guard fails the build before such a bundle reaches dist.
import { readFile } from "node:fs/promises";

import { isMainModule } from "./is-main-module.mjs";

/** Ceiling for the embedded bundle; the current one is around 1 MB. */
export const EMBED_MAX_BYTES = 3 * 1024 * 1024;
/** Generated protocol validator marker; those tables belong to the daemon, not the bundle. */
export const FORBIDDEN_PROTOCOL_MARKER = "ws-outbound.aot";

const STATIC_IMPORT = /\b(?:import|export)\b\s*(?:[^;]*?\bfrom\s*)?(\d+)/g;
const DYNAMIC_IMPORT = /\bimport\s*\(\s*(\d+)/g;
const REQUIRE_CALL = /\brequire\s*\(\s*(\d+)/g;

/** Real module specifiers only; generated code strings can contain arbitrary characters. */
const SPECIFIER_SHAPE = /^[A-Za-z0-9@_./#:~+-]+$/;

function isModuleSpecifier(value) {
  return typeof value === "string" && SPECIFIER_SHAPE.test(value);
}

function isBareSpecifier(specifier) {
  return (
    isModuleSpecifier(specifier) &&
    !specifier.startsWith("node:") &&
    !specifier.startsWith(".") &&
    !specifier.startsWith("/") &&
    !specifier.startsWith("file:") &&
    !specifier.startsWith("#")
  );
}

/**
 * Replaces every string literal with `<index>` and every comment with a space.
 * The bundle contains generated schema metadata whose *strings* say `import * as Cause from
 * "effect/Cause"`; scanning raw source would treat those as real imports. Matching on this
 * skeleton sees only code, then resolves the captured index back to the literal value.
 */
function maskLiteralsAndComments(source) {
  const literals = [];
  const out = [];
  let codeStart = 0;
  let index = 0;

  const flushCode = (end) => {
    if (end > codeStart) out.push(source.slice(codeStart, end));
  };
  const flushLiteral = (start, end, value) => {
    flushCode(start);
    literals.push(value);
    out.push(`${literals.length - 1}`);
    codeStart = end;
  };
  const flushComment = (start, end) => {
    flushCode(start);
    out.push(" ");
    codeStart = end;
  };

  while (index < source.length) {
    const char = source[index];
    if (char === '"' || char === "'" || char === "`") {
      const start = index;
      let value = "";
      let chunkStart = index + 1;
      index += 1;
      while (index < source.length) {
        if (source[index] === "\\") {
          value += source.slice(chunkStart, index) + source.slice(index, index + 2);
          index += 2;
          chunkStart = index;
          continue;
        }
        if (source[index] === char) break;
        index += 1;
      }
      value += source.slice(chunkStart, index);
      if (index < source.length) index += 1;
      flushLiteral(start, index, value);
      continue;
    }
    if (char === "/" && source[index + 1] === "/") {
      const start = index;
      index += 2;
      while (index < source.length && source[index] !== "\n") index += 1;
      flushComment(start, index);
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      const start = index;
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        index += 1;
      }
      index = Math.min(source.length, index + 2);
      flushComment(start, index);
      continue;
    }
    index += 1;
  }
  flushCode(source.length);
  return { skeleton: out.join(""), literals };
}

/** Package names imported without bundling; Node built-ins and relative files are fine. */
export function bareImportSpecifiers(source) {
  const { skeleton, literals } = maskLiteralsAndComments(source);
  const found = new Set();
  for (const pattern of [STATIC_IMPORT, DYNAMIC_IMPORT, REQUIRE_CALL]) {
    pattern.lastIndex = 0;
    for (const match of skeleton.matchAll(pattern)) {
      const specifier = literals[Number(match[1])];
      if (isBareSpecifier(specifier)) found.add(specifier);
    }
  }
  return [...found].sort();
}

function megabytes(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/**
 * Returns every way the bundle violates the contract. Empty means the bundle is safe to
 * ship; each violation carries both the reason and the fix, so a failing build says what
 * to change instead of only that it failed.
 */
export function inspectEmbedBundle({ source, byteLength }) {
  const violations = [];
  if (byteLength > EMBED_MAX_BYTES) {
    violations.push({
      reason: `bundle is ${megabytes(byteLength)}, above the ${megabytes(EMBED_MAX_BYTES)} limit`,
      fix: "keep the Neox client out of the bundle: embed.ts must not import clientRuntime.node.ts, and client/protocol imports must stay `import type` (see apps/bridge/src/clientRuntime.ts)",
    });
  }
  if (source.includes(FORBIDDEN_PROTOCOL_MARKER)) {
    violations.push({
      reason: `bundle contains the generated protocol validators ("${FORBIDDEN_PROTOCOL_MARKER}")`,
      fix: "the daemon injects its validator tables through clientRuntime; import protocol types only, never the generated validation modules",
    });
  }
  const bare = bareImportSpecifiers(source);
  if (bare.length > 0) {
    violations.push({
      reason: `bundle has bare package imports: ${bare.join(", ")}`,
      fix: "the daemon-hosted bundle must be self-contained: let bun bundle the dependency, or use `node:` built-ins; client and server packages come from the injected clientRuntime instead",
    });
  }
  return violations;
}

export function formatEmbedBundleFailure(file, violations) {
  const lines = [
    `Refusing to ship the web app bundle at ${file}:`,
    ...violations.flatMap((violation) => [`- ${violation.reason}`, `  fix: ${violation.fix}`]),
  ];
  return lines.join("\n");
}

/** Throws with the full reason and fix list when the bundle violates the contract. */
export function assertEmbedBundle(file, bundle) {
  const violations = inspectEmbedBundle(bundle);
  if (violations.length > 0) {
    throw new Error(formatEmbedBundleFailure(file, violations));
  }
}

if (isMainModule(import.meta.url)) {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: node scripts/embed-bundle-guard.mjs <path-to-embed.js>");
    process.exit(2);
  }
  const bytes = await readFile(file);
  assertEmbedBundle(file, {
    source: bytes.toString("utf8"),
    byteLength: bytes.byteLength,
  });
  console.log(`Embed guard passed: ${file} is ${megabytes(bytes.byteLength)}.`);
}
