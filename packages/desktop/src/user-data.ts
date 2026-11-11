import path from "node:path";

export interface UserDataDirOptions {
  /** NEOLIX_ELECTRON_USER_DATA_DIR, when a caller forces a directory. */
  forcedDir?: string | null;
  isPackaged: boolean;
  /** Basename of the git worktree in dev; null for the main checkout. */
  devWorktreeName?: string | null;
  /**
   * Electron's appData directory, read only when a forced directory is not given.
   * On Windows app.getPath("appData") never returned in the packaged smoke's isolated
   * environment (HOME and USERPROFILE redirected to a temp dir, userData forced), which
   * left the app hung before it opened a window.
   */
  appDataDir: () => string;
}

/**
 * Resolve the userData directory. app.setName() names Electron's default
 * directory after the app, which is <appData>/Neox; the explicit path here
 * keeps dev worktrees isolated from each other and from the main checkout.
 */
export function resolveUserDataDir(options: UserDataDirOptions): string {
  if (options.forcedDir) {
    return options.forcedDir;
  }
  if (!options.isPackaged && options.devWorktreeName) {
    return path.join(options.appDataDir(), `Neox-${options.devWorktreeName}`);
  }
  return path.join(options.appDataDir(), "Neox");
}
