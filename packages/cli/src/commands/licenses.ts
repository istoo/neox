import { Command } from "commander";
import { THIRD_PARTY_NOTICES } from "@neolix/protocol/generated/third-party-notices";

/**
 * myna's `myna licenses` (internal/notices): the third-party notices the
 * binary carries, generated from package-lock.json at build time
 * (scripts/generate-third-party-notices.mjs). Settings › About shows the
 * same text.
 */
export function createLicensesCommand(): Command {
  return new Command("licenses")
    .description("Print Neox's third-party license notices")
    .action(() => {
      process.stdout.write(
        THIRD_PARTY_NOTICES.endsWith("\n") ? THIRD_PARTY_NOTICES : `${THIRD_PARTY_NOTICES}\n`,
      );
    });
}
