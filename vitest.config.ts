import path from "node:path";
import { configDefaults, defineConfig } from "vitest/config";

// React's test APIs require its development build, even in a production shell.
process.env.NODE_ENV = "test";

export default defineConfig({
  resolve: {
    extensions: [
      ".web.mjs",
      ".web.js",
      ".web.mts",
      ".web.ts",
      ".web.jsx",
      ".web.tsx",
      ".mjs",
      ".js",
      ".mts",
      ".ts",
      ".jsx",
      ".tsx",
      ".json",
    ],
    alias: [
      {
        find: /^@neolix\/relay\/e2ee$/,
        replacement: path.resolve(__dirname, "packages/relay/src/e2ee.ts"),
      },
      {
        find: /^@neolix\/relay$/,
        replacement: path.resolve(__dirname, "packages/relay/src/index.ts"),
      },
      { find: "@server", replacement: path.resolve(__dirname, "packages/server/src") },
    ],
  },
  test: {
    // Fake-timer suites freeze p-throttle's clock, so a real per-second cap deadlocks them.
    env: {
      NEOLIX_GIT_MAX_PROCESSES_PER_SECOND: "10000",
    },
    exclude: [...configDefaults.exclude, "**/.claude/**", "**/.dev/**"],
  },
});
