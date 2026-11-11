import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { importGoogleAccounts, parseGoogleImport } from "./google-import.js";
import { loadAnySubscriptionAccounts, saveSubscriptionAccounts } from "./subscription-store.js";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "neolix-google-import-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function jsonAnswer(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const TOKEN = "https://oauth2.googleapis.com/token";
const USERINFO = "https://www.googleapis.com/oauth2/v2/userinfo?alt=json";
const LOAD = "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist";

function googleFetcher(emails: Record<string, string>): typeof fetch {
  return (input) => {
    const url = String(input);
    if (url === TOKEN) {
      return Promise.resolve(jsonAnswer({ access_token: "access", expires_in: 3600 }));
    }
    if (url === USERINFO) {
      return Promise.resolve(jsonAnswer({ email: emails.access ?? "me@example.com" }));
    }
    if (url === LOAD) {
      return Promise.resolve(
        jsonAnswer({ cloudaicompanionProject: "proj-1", currentTier: { name: "Free" } }),
      );
    }
    throw new Error(`unexpected request to ${url}`);
  };
}

describe("parseGoogleImport", () => {
  it("reads Cockpit and Manager exports", () => {
    expect(parseGoogleImport("antigravity", '[{"email":"a@b.c","refresh_token":"r1"}]')).toEqual([
      { n: 1, email: "a@b.c", refreshToken: "r1", project: "", error: "" },
    ]);
    expect(
      parseGoogleImport(
        "antigravity",
        '{"accounts":[{"email":"a@b.c","token":{"refresh_token":"r1","project_id":"p"}}]}',
      ),
    ).toEqual([{ n: 1, email: "a@b.c", refreshToken: "r1", project: "p", error: "" }]);
  });

  it("reads CLIProxyAPI's file, refusing another app's sign-in", () => {
    const [entry] = parseGoogleImport(
      "antigravity",
      '{"type":"antigravity","email":"a@b.c","refresh_token":"r1"}',
    );
    expect(entry).toMatchObject({ email: "a@b.c", refreshToken: "r1", error: "" });
    const [wrong] = parseGoogleImport("antigravity", '{"type":"gemini","refresh_token":"r1"}');
    expect(wrong?.error).toContain("not Antigravity's");
  });

  it("takes bare refresh tokens, one a line, and importer comments", () => {
    expect(parseGoogleImport("antigravity", "# mine\nr1\n\nr2")).toEqual([
      { n: 1, email: "", refreshToken: "r1", project: "", error: "" },
      { n: 2, email: "", refreshToken: "r2", project: "", error: "" },
    ]);
  });

  it("says the same account twice, and says nothing to import", () => {
    expect(parseGoogleImport("antigravity", "r1\nr1")[1]?.error).toBe("in the file twice");
    expect(() => parseGoogleImport("antigravity", "  ")).toThrow("nothing to import");
  });
});

describe("importGoogleAccounts", () => {
  it("checks each account with Google and keeps it", async () => {
    const gatewayDir = tempDir();
    const results = await importGoogleAccounts({
      gatewayDir,
      texts: ['[{"email":"me@example.com","refresh_token":"r1"}]'],
      now: () => 5_000,
      fetchImpl: googleFetcher({ access: "me@example.com" }),
    });
    expect(results).toEqual([{ user: "me@example.com", status: "added", plan: "Free" }]);
    const accounts = await loadAnySubscriptionAccounts(join(gatewayDir, "google-accounts.json"));
    expect(accounts).toEqual([
      expect.objectContaining({
        agent: "antigravity",
        user: "me@example.com",
        refreshToken: "r1",
        project: "proj-1",
      }),
    ]);
  });

  it("reports an account it already has rather than adding it twice", async () => {
    const gatewayDir = tempDir();
    const fetchImpl = googleFetcher({ access: "me@example.com" });
    await importGoogleAccounts({
      gatewayDir,
      texts: ['[{"refresh_token":"r1"}]'],
      fetchImpl,
    });
    const again = await importGoogleAccounts({
      gatewayDir,
      texts: ['[{"refresh_token":"r1"}]'],
      fetchImpl,
    });
    expect(again).toEqual([{ user: "me@example.com", status: "exists" }]);
  });

  it("keeps Gemini CLI's accounts in the shared file", async () => {
    const gatewayDir = tempDir();
    const file = join(gatewayDir, "google-accounts.json");
    await saveSubscriptionAccounts(file, [
      {
        agent: "gemini",
        id: "gemini:one",
        user: "gem@example.com",
        plan: null,
        addedAt: 1,
        lapsed: null,
        accessToken: "a",
        refreshToken: "g1",
        expiresAt: 0,
        project: null,
      },
    ]);
    await importGoogleAccounts({
      gatewayDir,
      texts: ['[{"refresh_token":"r1"}]'],
      fetchImpl: googleFetcher({ access: "me@example.com" }),
    });
    const accounts = await loadAnySubscriptionAccounts(file);
    expect(accounts.map((account) => account.agent).sort()).toEqual(["antigravity", "gemini"]);
  });

  it("says why an account Google refused", async () => {
    const gatewayDir = tempDir();
    const results = await importGoogleAccounts({
      gatewayDir,
      texts: ['[{"email":"bad@example.com","refresh_token":"r1"}]'],
      fetchImpl: () => Promise.resolve(jsonAnswer({ error: "invalid_grant" }, 400)),
    });
    expect(results).toEqual([
      {
        user: "bad@example.com",
        status: "failed",
        error: "Google refused the refresh token (400)",
      },
    ]);
  });
});
