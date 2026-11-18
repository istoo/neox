import { spawn } from "node:child_process";
import { cp, mkdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assertEmbedBundle } from "./embed-bundle-guard.mjs";

// Builds the desktop web app the daemon serves on its own port and places it where
// the daemon looks for it (packages/server/src/server/web-app.ts):
//   packages/server/dist/server/web-app/embed.js — the routes, as one Node bundle
//   packages/server/dist/server/web-app/web/     — the page (apps/web/dist)

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const DESKTOP_WEB = path.join(REPO_ROOT, "packages", "desktop-web");
const BRIDGE_DIR = path.join(DESKTOP_WEB, "apps", "bridge");
const WEB_DIR = path.join(DESKTOP_WEB, "apps", "web");
const TARGET = path.join(REPO_ROOT, "packages", "server", "dist", "server", "web-app");

function run(command, args, cwd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit", shell: false, env });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} failed with exit code ${code}`));
    });
  });
}

async function requireFile(filePath, what) {
  const info = await stat(filePath).catch(() => null);
  if (!info?.isFile()) throw new Error(`${what} not found at ${filePath}`);
}

async function main() {
  console.log("Building the web app's routes bundle...");
  await run("bun", ["run", "build:bundle"], BRIDGE_DIR);
  console.log("Building the web app's page...");
  // Bound the Vite build's memory so it fits a 6 GiB builder:
  // - NODE_OPTIONS caps V8's old space. The React Compiler needs more than
  //   2304 MiB on this graph; 3072 leaves headroom while keeping the peak
  //   around 4.8 GB instead of letting V8 grow to its default limit.
  // - Rolldown renders and minifies chunks on a Rayon pool sized to the host's
  //   CPU count; two threads keeps per-thread render buffers from adding up.
  // Output bytes are identical at any thread count.
  await run("bun", ["run", "build"], WEB_DIR, {
    ...process.env,
    NODE_OPTIONS: "--max-old-space-size=3072",
    RAYON_NUM_THREADS: "2",
  });

  const bundle = path.join(BRIDGE_DIR, "dist", "embed.js");
  const webDist = path.join(WEB_DIR, "dist");
  await requireFile(bundle, "Web app bundle");
  await requireFile(path.join(webDist, "index.html"), "Web app page");

  // The daemon injects the client and protocol at runtime; a bundle carrying its own copy
  // would double those tables in every daemon start. Fail before copying it into dist.
  const bundleBytes = await readFile(bundle);
  assertEmbedBundle(bundle, {
    source: bundleBytes.toString("utf8"),
    byteLength: bundleBytes.byteLength,
  });
  console.log(
    `Embed guard passed: ${(bundleBytes.byteLength / 1024 / 1024).toFixed(2)} MB, no generated validators, only node: imports.`,
  );

  console.log(`Copying into ${path.relative(REPO_ROOT, TARGET)}...`);
  await rm(TARGET, { recursive: true, force: true });
  await mkdir(TARGET, { recursive: true });
  await cp(bundle, path.join(TARGET, "embed.js"));
  await cp(webDist, path.join(TARGET, "web"), { recursive: true });
  console.log("Daemon web app ready.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
