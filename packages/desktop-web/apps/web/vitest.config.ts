// FILE: vitest.config.ts
// Purpose: Node unit-test config. Pins the UI language so assertions do not
//          depend on the host machine's locale.
// Layer: Test configuration
// Depends on: vite.config.ts and the shared language setup file.

import { defineConfig, mergeConfig } from "vitest/config";

import viteConfig from "./vite.config";

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      setupFiles: ["./src/test/setupLanguage.ts"],
    },
  }),
);
