// Opt-in startup trace for launches that hang before the app can log anything.
//
// NEOLIX_DESKTOP_STARTUP_TRACE names a file; every module the main process requires and
// every startup phase is appended to it synchronously, so the last line shows where a
// stuck launch stopped. The packaged smoke sets it and prints the tail on failure.
// main.ts imports this module first, before any other module is evaluated.
import { appendFileSync } from "node:fs";
import Module from "node:module";

const tracePath = process.env.NEOLIX_DESKTOP_STARTUP_TRACE?.trim() || null;

export function traceStartup(phase: string): void {
  if (tracePath === null) {
    return;
  }
  try {
    appendFileSync(tracePath, `${new Date().toISOString()} ${process.pid} ${phase}\n`);
  } catch {
    // A trace that cannot be written must not change how the app starts.
  }
}

interface ModuleLoader {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
}

if (tracePath !== null) {
  const loader = Module as unknown as ModuleLoader;
  const load = loader._load;
  loader._load = function tracedLoad(request, parent, isMain) {
    // A module whose evaluation hangs has a "require" line and no matching "loaded" line.
    traceStartup(`require ${request}`);
    const loaded = load.call(this, request, parent, isMain);
    traceStartup(`loaded ${request}`);
    return loaded;
  };
  traceStartup(`main process start ${process.argv.join(" ")}`);
}
