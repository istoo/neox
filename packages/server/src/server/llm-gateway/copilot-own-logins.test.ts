import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ownLoginAccount, readCopilotOwnLogins } from "./copilot-own-logins.js";

const dirs: string[] = [];

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "neolix-copilot-own-"));
  dirs.push(dir);
  return dir;
}

function write(path: string, body: unknown | string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body));
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("readCopilotOwnLogins", () => {
  it("reads the editors' sign-ins on github.com and an enterprise's host", async () => {
    const home = tempHome();
    const source = join(home, ".config", "github-copilot", "apps.json");
    write(source, {
      "github.com": { user: "user1", oauth_token: "token-a" },
      "acme.ghe.com:Iv1.abc": { user: "user2", oauth_token: "token-b" },
    });
    expect(await readCopilotOwnLogins({ home })).toEqual([
      { login: "user1", user: "user1", token: "token-a", host: "", cli: false, source },
      {
        login: "user2",
        user: ["user2", "acme.ghe.com"].join("@"),
        token: "token-b",
        host: "acme.ghe.com",
        cli: false,
        source,
      },
    ]);
  });

  it("reads the Copilot CLI's plaintext token, with its comments", async () => {
    const home = tempHome();
    write(
      join(home, ".copilot", "config.json"),
      [
        "{",
        "  // the CLI writes JSONC",
        '  "lastLoggedInUser": { "login": "user3", "host": "https://github.com" },',
        '  "copilotTokens": { "https://github.com:user3": "token-c" }',
        "}",
      ].join("\n"),
    );
    expect(await readCopilotOwnLogins({ home })).toEqual([
      expect.objectContaining({ login: "user3", token: "token-c", host: "", cli: true }),
    ]);
  });

  it("leaves out a CLI sign-in whose token is only in the keychain", async () => {
    const home = tempHome();
    write(join(home, ".copilot", "config.json"), {
      lastLoggedInUser: { login: "user3", host: "https://github.com" },
      copilotTokens: {},
    });
    expect(await readCopilotOwnLogins({ home })).toEqual([]);
  });

  it("keeps one editor sign-in per host", async () => {
    const home = tempHome();
    write(join(home, ".config", "github-copilot", "apps.json"), {
      "github.com": { user: "user1", oauth_token: "token-a" },
    });
    write(join(home, ".config", "github-copilot", "hosts.json"), {
      "github.com": { user: "user4", oauth_token: "token-d" },
    });
    expect((await readCopilotOwnLogins({ home })).map((login) => login.token)).toEqual(["token-a"]);
  });

  it("reads nothing while account discovery is off", async () => {
    const home = tempHome();
    write(join(home, ".config", "github-copilot", "apps.json"), {
      "github.com": { user: "user1", oauth_token: "token-a" },
    });
    write(join(home, ".copilot", "config.json"), {
      lastLoggedInUser: { login: "user3", host: "https://github.com" },
      copilotTokens: { "https://github.com:user3": "token-c" },
    });
    expect(await readCopilotOwnLogins({ home, discovery: false })).toEqual([]);
  });

  it("makes an own login an account the gateway can serve", async () => {
    const account = ownLoginAccount({
      login: "user1",
      user: "user1",
      token: "token-a",
      host: "",
      cli: false,
      source: "x",
    });
    expect(account).toMatchObject({ agent: "copilot", user: "user1", own: true });
    expect(account.id).toMatch(/^copilot:/);
  });
});
