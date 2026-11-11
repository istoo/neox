import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * The GitHub token the Library's API requests carry, when it has one
 * (myna's GitHubToken). Kept in `$NEOLIX_HOME/secrets.json`, a file only its
 * owner can read or write, beside gateway.json; the settings page shows
 * whether one is set, never the token itself.
 */
type Secrets = Record<string, unknown>;

const FILE_NAME = "secrets.json";
const FILE_MODE = 0o600;

export class SecretsStore {
  private readonly filePath: string;

  constructor(neolixHome: string) {
    this.filePath = path.join(neolixHome, FILE_NAME);
  }

  get path(): string {
    return this.filePath;
  }

  /** The token, or null when none is set or the file cannot be read. */
  async githubToken(): Promise<string | null> {
    const secrets = await this.read();
    const token = typeof secrets.githubToken === "string" ? secrets.githubToken.trim() : "";
    return token.length === 0 ? null : token;
  }

  /** Sets or clears the token, keeping every other key in the file. */
  async setGithubToken(token: string | null): Promise<void> {
    const secrets = await this.read();
    const trimmed = token?.trim() ?? "";
    if (trimmed.length === 0) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- keys unknown by design.
      delete secrets.githubToken;
    } else {
      secrets.githubToken = trimmed;
    }
    await this.write(secrets);
  }

  private async read(): Promise<Secrets> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.filePath, "utf8"));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return {};
      }
      return parsed as Secrets;
    } catch {
      return {};
    }
  }

  private async write(secrets: Secrets): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.tmp.${process.pid}`;
    await writeFile(temp, `${JSON.stringify(secrets, null, 2)}\n`, {
      encoding: "utf8",
      mode: FILE_MODE,
    });
    await chmod(temp, FILE_MODE);
    await rename(temp, this.filePath);
    await chmod(this.filePath, FILE_MODE);
  }
}
