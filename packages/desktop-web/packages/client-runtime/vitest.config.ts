import { defineConfig } from "vitest/config";

import { vitestMaxWorkers } from "../../../../scripts/vitest-max-workers.mjs";

// This bun workspace has no shared Vitest config layer, so each package reads
// the repo-level helper directly. See scripts/vitest-max-workers.mjs.
export default defineConfig({
  test: {
    maxWorkers: vitestMaxWorkers(),
  },
});
