import type { Command } from "commander";
import { backupCommand, restoreCommand } from "./backup.js";
import { githubCommand, s3Command, webdavCommand } from "./remote.js";

/**
 * myna's `backup`, `restore`, `webdav`, `s3` and `github`
 * (`internal/cli/main.go:72-78`): a sealed file to carry by hand, and the
 * three remotes that keep the setup the same on every computer.
 */
export function createSyncCommands(): Command[] {
  return [backupCommand(), restoreCommand(), webdavCommand(), s3Command(), githubCommand()];
}
