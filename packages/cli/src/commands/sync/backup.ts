import { promises as fs } from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { exportBackup, restoreBackup, type SyncPart } from "@neolix/server/sync";
import { withOutput } from "../../output/index.js";
import { addLocalDaemonOptions } from "../../utils/command-options.js";
import type { CommandOptions } from "../../output/index.js";
import { askPassphrase, askSecret } from "./secret.js";
import { localHome, textResult } from "./shared.js";

/**
 * myna's `backup` (`internal/cli/backup_cmd.go:22`): providers, settings,
 * profiles, agents' models and the library in one file sealed with a
 * passphrase. `--sign-ins` carries the subscription sign-ins too;
 * `--no-library` leaves the library out.
 */
export function backupCommand(): Command {
  return addLocalDaemonOptions(
    new Command("backup")
      .description(
        "Write providers, settings, profiles, agents' models and the library to one sealed file",
      )
      .option("--no-keys", "Leave the providers' API keys and library credentials out")
      .option("--no-library", "Leave the library out")
      .option("--sign-ins", "Carry the subscription sign-ins too")
      .argument("[file]", "File to write (default: a new file in $NEOLIX_HOME/backups)"),
  ).action(withOutput<Record<string, unknown>, [string | undefined]>(runBackupCommand));
}

async function runBackupCommand(file: string | undefined, options: CommandOptions) {
  const home = localHome(options);
  const keys = options.keys !== false;
  const signIns = options.signIns === true;
  const parts: Partial<Record<SyncPart, boolean>> | undefined =
    options.library === false ? { library: false } : undefined;
  const passphrase = await askPassphrase("Passphrase for the backup: ", true);
  const written = await exportBackup({
    neolixHome: home,
    passphrase,
    keys,
    signIns,
    ...(parts ? { parts } : {}),
  });
  let saved = written.file;
  if (file) {
    saved = path.resolve(file);
    await fs.mkdir(path.dirname(saved), { recursive: true });
    await fs.rename(written.file, saved);
    await fs.chmod(saved, 0o600).catch(() => {});
  }
  const what = keys ? "with their keys" : "without keys";
  const lines = [
    `saved ${saved}: ${written.parts.join(", ")} ${what}; ${written.files} files, ${written.size} bytes`,
  ];
  lines.push(
    signIns
      ? "The subscriptions' sign-ins are in it, sealed with the passphrase: anyone with the file and the passphrase can use those accounts. Keep the passphrase: without it the file can't be opened."
      : "Subscriptions are not in it: sign in to them on the other computer (or back up with --sign-ins). Keep the passphrase: without it the file can't be opened.",
  );
  return textResult(lines.join("\n"), {
    file: saved,
    keys,
    parts: written.parts,
    files: written.files,
    size: written.size,
  });
}

/** myna's `restore` (`internal/cli/backup_cmd.go:92`). */
export function restoreCommand(): Command {
  return addLocalDaemonOptions(
    new Command("restore")
      .description("Put a sealed backup in on this computer")
      .option("--no-agents", "Leave the profiles and agents' models as they are here")
      .option("--no-library", "Leave the library as it is here")
      .option("--no-sign-ins", "Leave the subscription sign-ins as they are here")
      .argument("<file>", "The backup to restore"),
  ).action(withOutput<Record<string, unknown>, [string]>(runRestoreCommand));
}

async function runRestoreCommand(file: string, options: CommandOptions) {
  const home = localHome(options);
  const parts: Partial<Record<SyncPart, boolean>> = {};
  if (options.agents === false) {
    // myna's agents part is Neolix's profiles and models together.
    parts.profiles = false;
    parts.models = false;
  }
  if (options.library === false) {
    parts.library = false;
  }
  const passphrase = await askSecret("Passphrase: ");
  const result = await restoreBackup({
    neolixHome: home,
    file: path.resolve(file),
    passphrase,
    keys: false,
    // A backup's sign-ins are brought in when it has them (myna's default).
    signIns: options.signIns !== false,
    ...(Object.keys(parts).length > 0 ? { parts } : {}),
  });
  const lines = [`restored: ${result.parts.join(", ")}`];
  if (result.saved) {
    lines.push(
      `What was here before is kept in ${result.saved}; restore that file to put it back.`,
    );
  }
  return textResult(lines.join("\n"), {
    parts: result.parts,
    ...(result.saved ? { saved: result.saved } : {}),
  });
}
