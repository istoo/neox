import { isCancel, password as passwordPrompt } from "@clack/prompts";

/** Reads stdin once, for the words a scripted run pipes in. */
let piped: string[] | null = null;

async function pipedLines(): Promise<string[]> {
  if (piped !== null) {
    return piped;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  piped = Buffer.concat(chunks)
    .toString("utf8")
    .split(/\r?\n/)
    .filter((line, index, all) => line.length > 0 || index < all.length - 1);
  return piped;
}

/**
 * A secret asked for without echo, as myna asks for a password or
 * passphrase; piped in, it is the next line of stdin
 * (`internal/cli/backup_cmd.go` `passphrase`).
 */
export async function askSecret(message: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const lines = await pipedLines();
    return lines.shift() ?? "";
  }
  const value = await passwordPrompt({ message });
  if (isCancel(value)) {
    throw new Error("cancelled");
  }
  return String(value);
}

/** A passphrase asked for twice, as `myna backup` does. */
export async function askPassphrase(message: string, confirm: boolean): Promise<string> {
  const first = await askSecret(message);
  // Piped in, there is nothing to confirm with: the first line is it.
  if (!confirm || !process.stdin.isTTY) {
    return first;
  }
  const again = await askSecret("Again: ");
  if (first !== again) {
    throw new Error("the two passphrases differ");
  }
  return first;
}
