import path from "node:path";
import { defineConfig } from "vitest/config";

import { vitestMaxWorkers } from "../../scripts/vitest-max-workers.mjs";

export default defineConfig({
  resolve: {
    alias: {
      "@server": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    // Fake-timer suites freeze p-throttle's clock, so a real per-second cap deadlocks them.
    env: {
      NEOLIX_GIT_MAX_PROCESSES_PER_SECOND: "10000",
    },
    testTimeout: 30000,
    hookTimeout: 60000,
    globals: true,
    environment: "node",
    setupFiles: [path.resolve(__dirname, "./src/test-utils/vitest-setup.ts")],
    pool: "forks",
    fileParallelism: false,
    maxWorkers: vitestMaxWorkers(),
    exclude: ["**/node_modules/**", "**/dist/**", "**/.claude/**", "**/.dev/**"],
  },
});
