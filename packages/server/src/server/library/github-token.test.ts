import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SecretsStore } from "./github-token.js";

const directories: string[] = [];

async function store(): Promise<{ home: string; secrets: SecretsStore }> {
  const home = await mkdtemp(path.join(tmpdir(), "neolix-secrets-"));
  directories.push(home);
  return { home, secrets: new SecretsStore(home) };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("SecretsStore", () => {
  it("has no token until one is set", async () => {
    const { secrets } = await store();
    expect(await secrets.githubToken()).toBeNull();
  });

  it("keeps the token in an owner-only file beside gateway.json", async () => {
    const { home, secrets } = await store();
    await secrets.setGithubToken("  ghp_example  ");

    expect(await secrets.githubToken()).toBe("ghp_example");
    const filePath = path.join(home, "secrets.json");
    expect(path.basename(filePath)).toBe("secrets.json");
    if (process.platform !== "win32") {
      expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    }
    expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual({ githubToken: "ghp_example" });
  });

  it("clears the token and keeps the file", async () => {
    const { home, secrets } = await store();
    await secrets.setGithubToken("ghp_example");
    await secrets.setGithubToken("");

    expect(await secrets.githubToken()).toBeNull();
    expect(JSON.parse(await readFile(path.join(home, "secrets.json"), "utf8"))).toEqual({});
  });

  it("keeps keys written by another build", async () => {
    const { home, secrets } = await store();
    await writeFile(
      path.join(home, "secrets.json"),
      JSON.stringify({ futureToken: "kept", githubToken: "old" }),
    );
    await secrets.setGithubToken("new");

    const parsed = JSON.parse(await readFile(path.join(home, "secrets.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(parsed).toEqual({ futureToken: "kept", githubToken: "new" });
  });

  it("says nothing for an unreadable file", async () => {
    const { home, secrets } = await store();
    await writeFile(path.join(home, "secrets.json"), "{not json");
    expect(await secrets.githubToken()).toBeNull();
  });
});
