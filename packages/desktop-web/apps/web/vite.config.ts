// FILE: vite.config.ts
// Purpose: Builds the Synara web client and controls diagnostic source maps.
// Layer: Web build config
// Depends on: Vite, Tailwind, React compiler, TanStack Router.

import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { promisify } from "node:util";
import tailwindcss from "@tailwindcss/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { defineConfig, type Plugin } from "vite";
import pkg from "./package.json" with { type: "json" };
import { listFiles, pruneProductionIcons } from "./scripts/production-assets";

const port = Number(process.env.PORT ?? 5733);
const sourcemapEnv = process.env.SYNARA_WEB_SOURCEMAP?.trim().toLowerCase();

/**
 * The product version is the repository root `package.json`'s `version` (Neolix),
 * not this web package's upstream Synara version. Walk up from the working
 * directory so isolated QA copies without the monorepo root still build.
 */
function resolveAppVersion(): string {
  const override = process.env.NEOLIX_APP_VERSION?.trim();
  if (override) return override;
  let directory = process.cwd();
  while (true) {
    try {
      const candidate = JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8")) as {
        name?: string;
        version?: string;
      };
      if (candidate.name === "neolix" && typeof candidate.version === "string") {
        return candidate.version;
      }
    } catch {
      // No readable package.json here; keep walking to the repository root.
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return pkg.version;
}

const appVersion = resolveAppVersion();

const buildSourcemap =
  sourcemapEnv === "1" || sourcemapEnv === "true"
    ? true
    : sourcemapEnv === "hidden"
      ? "hidden"
      : false;

// Prune before compression. closeBundle hooks are parallel by default;
// enforce: "post" alone does not make the asynchronous compression hook wait.
function centralIconPrunePlugin(): Plugin {
  let resolvedRoot = process.cwd();
  let resolvedOutDir = "dist";
  return {
    name: "synara-central-icon-prune",
    apply: "build",
    configResolved(config) {
      resolvedRoot = config.root;
      resolvedOutDir = path.resolve(config.root, config.build.outDir);
    },
    closeBundle: {
      order: "pre",
      sequential: true,
      async handler() {
        await pruneProductionIcons(path.join(resolvedRoot, "public"), resolvedOutDir, [
          path.join(resolvedRoot, "src"),
          path.resolve(resolvedRoot, "../../packages/contracts/src"),
          path.resolve(resolvedRoot, "../../packages/shared/src"),
        ]);
        // MSW is used by the dev-served browser tests, never the production app.
        await Promise.all(
          ["", ".gz", ".br"].map((suffix) =>
            fs.rm(path.join(resolvedOutDir, `mockServiceWorker.js${suffix}`), { force: true }),
          ),
        );
      },
    },
  };
}

const gzip = promisify(zlib.gzip);
const brotliCompress = promisify(zlib.brotliCompress);

const PRECOMPRESS_EXTENSIONS = new Set([".js", ".mjs", ".css", ".html", ".svg", ".json", ".map"]);
// Below this size, compression savings don't beat the extra header bytes and
// the sidecar file overhead.
const PRECOMPRESS_MIN_BYTES = 1024;
const PRECOMPRESS_CONCURRENCY = 4;

// Emits .gz and .br sidecars next to compressible build outputs so the server
// can serve precompressed bytes by Accept-Encoding instead of compressing on
// the request path (apps/server/src/http.ts static route).
function precompressPlugin(): Plugin {
  let resolvedOutDir = "dist";
  return {
    name: "synara-precompress",
    apply: "build",
    // Run after central-icon pruning so removed files don't get sidecars.
    enforce: "post",
    configResolved(config) {
      resolvedOutDir = path.resolve(config.root, config.build.outDir);
    },
    async closeBundle() {
      const files = (await listFiles(resolvedOutDir)).filter((file) =>
        PRECOMPRESS_EXTENSIONS.has(path.extname(file)),
      );
      // A sidecar whose source shrank below threshold or stopped compressing
      // smaller must be removed, not just skipped: emptyOutDir protects full
      // builds, but partial/watch builds would otherwise serve a stale
      // compressed body under a current filename.
      const removeStale = (sidecarPath: string) => fs.rm(sidecarPath, { force: true });
      // Write to a temp file and rename: a watch-build server reading a
      // sidecar mid-write would otherwise get a truncated compressed stream.
      // Rename is atomic within a directory, so readers see either the old
      // sidecar or the complete new one.
      let tempSequence = 0;
      const writeSidecarAtomically = async (sidecarPath: string, data: Buffer) => {
        // Unique per write so concurrent builds against one outDir cannot
        // clobber each other's staging file.
        tempSequence += 1;
        const tempPath = `${sidecarPath}.${process.pid}.${tempSequence}.tmp`;
        await fs.writeFile(tempPath, data);
        await fs.rename(tempPath, sidecarPath);
      };
      let sidecarCount = 0;
      // Compressing every file at once keeps hundreds of native brotli encoder
      // states alive (max-quality brotli reserves large hash tables), adding a
      // large spike on top of the transform and render peaks. Bound the
      // in-flight files; output is identical.
      const pending = [...files];
      const workers = Array.from(
        { length: Math.min(PRECOMPRESS_CONCURRENCY, pending.length) },
        async () => {
          while (pending.length > 0) {
            const file = pending.shift();
            if (!file) return;
            const source = await fs.readFile(file);
            if (source.byteLength < PRECOMPRESS_MIN_BYTES) {
              await Promise.all([removeStale(`${file}.gz`), removeStale(`${file}.br`)]);
              continue;
            }
            // Max-quality brotli on thousands of small files dominates plugin
            // wall-clock; below 16 KiB quality 9 is byte-for-byte competitive.
            const brotliQuality =
              source.byteLength < 16 * 1024 ? 9 : zlib.constants.BROTLI_MAX_QUALITY;
            const [gzipped, brotlied] = await Promise.all([
              gzip(source, { level: zlib.constants.Z_BEST_COMPRESSION }),
              brotliCompress(source, {
                params: {
                  [zlib.constants.BROTLI_PARAM_QUALITY]: brotliQuality,
                  [zlib.constants.BROTLI_PARAM_SIZE_HINT]: source.byteLength,
                },
              }),
            ]);
            await Promise.all([
              gzipped.byteLength < source.byteLength
                ? writeSidecarAtomically(`${file}.gz`, gzipped)
                : removeStale(`${file}.gz`),
              brotlied.byteLength < source.byteLength
                ? writeSidecarAtomically(`${file}.br`, brotlied)
                : removeStale(`${file}.br`),
            ]);
            sidecarCount += 1;
          }
        },
      );
      await Promise.all(workers);
      console.info(`[precompress] emitted gzip+brotli sidecars for ${sidecarCount} files.`);
    },
  };
}

export default defineConfig({
  plugins: [
    tanstackRouter({
      target: "react",
      autoCodeSplitting: true,
    }),
    react(),
    babel({
      // We need to be explicit about the parser options after moving to @vitejs/plugin-react v6.0.0
      // This is because the babel plugin only automatically parses typescript and jsx based on relative paths (e.g. "**/*.ts")
      // whereas the previous version of the plugin parsed all files with a .ts extension.
      // This is causing our packages/ directory to fail to parse, as they are not relative to the CWD.
      parserOpts: { plugins: ["typescript", "jsx"] },
      presets: [reactCompilerPreset()],
    }).then((plugin) => ({
      ...plugin,
      // Large chat modules make the compiler expensive on cold loads and every
      // edit. Oxc still provides JSX/TypeScript transforms and Fast Refresh.
      // Keep production builds and browser tests compiled, with an opt-in for
      // debugging compiler-specific behavior in the development app.
      apply: ((_config, { command, mode }) =>
        command === "build" ||
        mode === "test" ||
        /^(1|true)$/i.test(
          process.env.SYNARA_DEV_REACT_COMPILER?.trim() ?? "",
        )) satisfies Plugin["apply"],
    })),
    tailwindcss(),
    centralIconPrunePlugin(),
    precompressPlugin(),
  ],
  optimizeDeps: {
    include: [
      "@pierre/diffs",
      "@pierre/diffs/react",
      "@pierre/diffs/worker/worker.js",
      "react-icons/gr",
    ],
  },
  define: {
    // In dev mode, tell the web app where the WebSocket server lives
    "import.meta.env.VITE_WS_URL": JSON.stringify(process.env.VITE_WS_URL ?? ""),
    "import.meta.env.APP_VERSION": JSON.stringify(appVersion),
  },
  resolve: {
    tsconfigPaths: true,
    alias: {
      // monaco-vim's `browser` export condition points at its UMD build, which calls
      // require() and cannot load in the browser. Use the ESM build.
      "monaco-vim": new URL("./node_modules/monaco-vim/dist/index.mjs", import.meta.url).pathname,
      // monaco-vim 0.4 targets monaco 0.33's deep paths; 0.57's exports map would
      // double-prefix them. Point both at editorRuntime's specifiers so both
      // load the same monaco instance and the optimizer agrees on the URL.
      "monaco-editor/esm/vs/editor/editor.api": "monaco-editor/editor/editor.api",
      "monaco-editor/esm/vs/editor/common/commands/shiftCommand":
        "monaco-editor/editor/common/commands/shiftCommand",
    },
  },
  server: {
    port,
    strictPort: true,
    hmr: {
      // Explicit config so Vite's HMR WebSocket connects reliably
      // inside Electron's BrowserWindow. Vite 8 uses console.debug for
      // connection logs — enable "Verbose" in DevTools to see them.
      protocol: "ws",
      host: "localhost",
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: buildSourcemap,
    // The largest chunks are intentionally lazy-loaded editor grammars,
    // terminal runtime code, and the chat route—not initial-load bundles.
    chunkSizeWarningLimit: 850,
    rolldownOptions: {
      checks: {
        // React Compiler is expected to dominate transform time in this app.
        pluginTimings: false,
      },
    },
  },
});
