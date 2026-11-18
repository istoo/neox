import { defineConfig } from "vitest/config";

import { vitestMaxWorkers } from "../../scripts/vitest-max-workers.mjs";

export default defineConfig({
  test: {
    maxWorkers: vitestMaxWorkers(),
  },
});
