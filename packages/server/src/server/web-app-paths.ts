import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Where the built desktop web app may live. Kept apart from `web-app.ts`:
 * configuration asks for these paths while it resolves the daemon config, and
 * that module loads the client and its wire schemas once the app starts.
 */
export interface WebAppPaths {
  /** `embed.js`: exports `startEmbeddedWebApp`. */
  bundlePath: string;
  /** Built `apps/web/dist`. */
  distDir: string;
}

/**
 * Where the built web app may be, best first: an explicit override, the packaged
 * desktop's resources, the server's own build, this checkout's desktop-web builds.
 * Pure: `resolveWebAppPaths` checks which one exists.
 */
export function webAppCandidates(input: {
  env: NodeJS.ProcessEnv;
  resourcesPath?: string;
  moduleUrl?: string;
}): WebAppPaths[] {
  const candidates: WebAppPaths[] = [];
  const bundleOverride = input.env.NEOLIX_WEB_APP_BUNDLE?.trim();
  const distOverride = input.env.NEOLIX_WEB_APP_DIST?.trim();
  if (bundleOverride && distOverride) {
    candidates.push({
      bundlePath: path.resolve(bundleOverride),
      distDir: path.resolve(distOverride),
    });
  }
  if (input.resourcesPath) {
    const root = path.join(input.resourcesPath, "desktop-web");
    candidates.push({
      bundlePath: path.join(root, "bridge", "embed.js"),
      distDir: path.join(root, "web"),
    });
  }
  const moduleDir = path.dirname(fileURLToPath(input.moduleUrl ?? import.meta.url));
  // dist/server/server/web-app-paths.js → dist/server/web-app; src/server/web-app-paths.ts → dist/server/web-app.
  const serverPackageDir =
    path.basename(path.dirname(moduleDir)) === "src"
      ? path.resolve(moduleDir, "..", "..")
      : path.resolve(moduleDir, "..", "..", "..");
  const builtRoot = path.join(serverPackageDir, "dist", "server", "web-app");
  candidates.push({
    bundlePath: path.join(builtRoot, "embed.js"),
    distDir: path.join(builtRoot, "web"),
  });
  const desktopWeb = path.resolve(serverPackageDir, "..", "desktop-web", "apps");
  candidates.push({
    bundlePath: path.join(desktopWeb, "bridge", "dist", "embed.js"),
    distDir: path.join(desktopWeb, "web", "dist"),
  });
  return candidates;
}
