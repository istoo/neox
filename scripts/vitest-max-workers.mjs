import os from "node:os";

// A full local sweep runs next to the developer's own work. Vitest's non-watch
// default is `cores - 1` forks, and these suites spawn daemons, git and shells
// inside each worker, so an 18-core machine pins the load average near 40.
// Half the cores, capped at four, keeps the machine responsive.
const LOCAL_MAX_WORKERS = 4;

/**
 * Worker limit for the Vitest configs in this repo.
 *
 * Precedence: NEOX_TEST_MAX_WORKERS override, then CI (leave Vitest's own
 * default so runner throughput is unchanged), then the local cap. An explicit
 * `--maxWorkers` on the command line still wins over the returned config value.
 */
export function vitestMaxWorkers(
  env = process.env,
  availableParallelism = os.availableParallelism,
) {
  const override = Number(env.NEOX_TEST_MAX_WORKERS);
  if (Number.isInteger(override) && override > 0) return override;
  if (env.CI) return undefined;
  return Math.max(1, Math.min(LOCAL_MAX_WORKERS, Math.floor(availableParallelism() / 2)));
}
