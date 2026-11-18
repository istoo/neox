// FILE: vitest.config.ts
// Purpose: Node unit-test config. Pins the UI language so assertions do not
//          depend on the host machine's locale.
// Layer: Test configuration
// Depends on: vite.config.ts and the shared language setup file.

import { defineConfig, mergeConfig } from "vitest/config";

import { vitestMaxWorkers } from "../../../../scripts/vitest-max-workers.mjs";
import viteConfig from "./vite.config";

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      maxWorkers: vitestMaxWorkers(),
      setupFiles: ["./src/test/setupLanguage.ts"],
    },
  }),
);
