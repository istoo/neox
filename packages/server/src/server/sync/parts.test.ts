import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { applyPart, collectPart, sanitizeLibrary } from "./parts.js";
import type { StoredLibrary } from "../library/store.js";

const homes: string[] = [];

const HASH = `$2b$10$${"a".repeat(53)}`;

async function home(files: Record<string, unknown>): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "neolix-parts-"));
  homes.push(dir);
  for (const [name, value] of Object.entries(files)) {
    const target = path.join(dir, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(value, null, 2)}\n`);
  }
  return dir;
}

afterEach(async () => {
  await Promise.all(homes.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function json(file: { content: Buffer | string }): Record<string, unknown> {
  return JSON.parse(Buffer.from(file.content).toString("utf8")) as Record<string, unknown>;
}

const PROVIDER = {
  id: "lab",
  label: "Lab",
  protocol: "anthropic",
  baseUrl: "https://api.example/v1",
  apiKey: "{{SECRET_8wn2kd7m}}",
  accounts: [
    { id: "one", apiKey: "{{SECRET_5tm4pl0q}}", headers: { "x-key": "{{SECRET_1kx8qv3z}}" } },
  ],
  queueWaitMs: 0,
  sink: false,
  priceRate: 1,
  models: [],
};

describe("collectPart", () => {
  it("takes provider credentials out of a keyless sources part", async () => {
    const dir = await home({ "gateway.json": { version: 1, providers: [PROVIDER] } });
    const keyless = await collectPart("sources", { neolixHome: dir, keys: false });
    const sources = json(keyless.files[0]!) as {
      providers: { apiKey?: string; accounts: { apiKey?: string; headers?: unknown }[] }[];
    };
    expect(sources.providers[0]?.apiKey).toBeUndefined();
    expect(sources.providers[0]?.accounts[0]?.apiKey).toBeUndefined();
    expect(sources.providers[0]?.accounts[0]?.headers).toBeUndefined();

    const keyed = await collectPart("sources", { neolixHome: dir, keys: true });
    const kept = json(keyed.files[0]!) as { providers: { apiKey?: string }[] };
    expect(kept.providers[0]?.apiKey).toBeTruthy();
  });

  it("leaves gateway keys and OTel headers out unless asked", async () => {
    const dir = await home({
      "gateway.json": {
        version: 1,
        keys: [{ key: "gw-1", models: [] }],
        otel: { enabled: true, endpoint: "https://otel.example/v1/traces", headers: { a: "b" } },
      },
    });
    const keyless = await collectPart("settings", { neolixHome: dir, keys: false });
    const settings = json(keyless.files[0]!) as {
      gateway: { keys?: unknown; otel?: { headers?: unknown } };
    };
    expect(settings.gateway.keys).toBeUndefined();
    expect(settings.gateway.otel?.headers).toBeUndefined();

    const keyed = await collectPart("settings", { neolixHome: dir, keys: true });
    const withKeys = json(keyed.files[0]!) as { gateway: { keys?: unknown } };
    expect(withKeys.gateway.keys).toEqual([{ key: "gw-1", models: [] }]);
  });

  it("keeps this computer's own library fields out, and credentials unless asked", () => {
    const library = {
      version: 1,
      instructions: { agents: [], sets: [], active: "" },
      mcp: [
        {
          name: "srv",
          transport: "stdio",
          command: "x",
          agents: ["claude"],
          env: { TOKEN: "{{SECRET_pl9dv2xe}}" },
          oauth: { clientId: "id", clientSecret: "{{SECRET_0rm3tg7n}}" },
        },
        { name: "only-here", transport: "stdio", command: "y", agents: [], local: true },
      ],
      skills: [{ name: "a", agents: ["claude"], offHere: true }],
      hooks: [],
      subagents: [],
      applied: { claude: { instructions: true } },
      seenSkills: { "owner/repo@main": ["a"] },
    } as unknown as StoredLibrary;
    const keyless = sanitizeLibrary(library, false);
    expect(keyless.applied).toBeUndefined();
    expect(keyless.seenSkills).toBeUndefined();
    expect(keyless.skills[0]?.offHere).toBeUndefined();
    expect(keyless.mcp[0]?.env).toBeUndefined();
    expect(keyless.mcp[0]?.oauth?.clientSecret).toBeUndefined();
    expect(keyless.mcp.map((server) => server.name)).toEqual(["srv"]);

    const keyed = sanitizeLibrary(library, true);
    expect(keyed.mcp[0]?.env).toEqual({ TOKEN: "{{SECRET_pl9dv2xe}}" });
  });
});

describe("applyPart", () => {
  it("keeps this computer's gateway keys when a keyless part is brought in", async () => {
    const dir = await home({
      "gateway.json": {
        version: 1,
        keys: [{ key: "gw-local", models: [] }],
        providers: [PROVIDER],
      },
    });
    await applyPart(
      "settings",
      [
        {
          path: "settings.json",
          content: JSON.stringify({ gateway: { enabled: false }, config: {} }),
        },
      ],
      { neolixHome: dir, keys: false },
    );
    const gateway = JSON.parse(await readFile(path.join(dir, "gateway.json"), "utf8")) as {
      enabled: boolean;
      keys?: { key: string }[];
    };
    expect(gateway.enabled).toBe(false);
    expect(gateway.keys?.map((entry) => entry.key)).toEqual(["gw-local"]);
  });

  it("keeps another computer's same-named server aside while a local one has the name", async () => {
    const empty = {
      version: 1,
      instructions: { agents: [], sets: [], active: "" },
      skills: [],
      hooks: [],
      subagents: [],
      applied: {},
    };
    const dir = await home({
      "library/library.json": {
        ...empty,
        mcp: [{ name: "mine", transport: "stdio", command: "here", agents: [], local: true }],
      },
    });
    await applyPart(
      "library",
      [
        {
          path: "library.json",
          content: JSON.stringify({
            ...empty,
            mcp: [
              { name: "mine", transport: "stdio", command: "theirs", agents: [] },
              { name: "other", transport: "stdio", command: "other", agents: [] },
            ],
          }),
        },
      ],
      { neolixHome: dir, keys: false },
    );
    const library = JSON.parse(
      await readFile(path.join(dir, "library", "library.json"), "utf8"),
    ) as {
      mcp: { name: string; command: string; local?: boolean }[];
      away?: { name: string; command: string; local?: boolean }[];
    };
    expect(library.mcp.map((server) => [server.name, server.command])).toEqual([
      ["mine", "here"],
      ["other", "other"],
    ]);
    expect(library.away?.map((server) => [server.name, server.command])).toEqual([
      ["mine", "theirs"],
    ]);
    expect(library.away?.[0]?.local).toBeUndefined();
  });

  it("refuses a library key that escapes the library directory", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "neolix-parts-escape-"));
    homes.push(base);
    const dir = path.join(base, "home");
    await mkdir(dir, { recursive: true });

    await expect(
      applyPart("library", [{ path: "../../outside-home.txt", content: "PWNED-BY-PACK" }], {
        neolixHome: dir,
        keys: false,
      }),
    ).rejects.toThrow(/escapes the library directory/);
    await expect(readFile(path.join(base, "outside-home.txt"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("refuses an absolute library key", async () => {
    const dir = await home({});
    const outside = path.join(os.tmpdir(), `neolix-parts-absolute-${Date.now()}.txt`);

    await expect(
      applyPart("library", [{ path: outside, content: "PWNED-BY-PACK" }], {
        neolixHome: dir,
        keys: false,
      }),
    ).rejects.toThrow(/must be relative/);
    await expect(readFile(outside, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never writes a daemon password or this computer's address", async () => {
    const dir = await home({
      "config.json": {
        version: 1,
        daemon: { listen: "127.0.0.1:6768", auth: { password: HASH } },
      },
    });
    await applyPart(
      "settings",
      [
        {
          path: "settings.json",
          content: JSON.stringify({
            gateway: {},
            config: { daemon: { autoArchiveAfterMerge: true } },
          }),
        },
      ],
      { neolixHome: dir, keys: false },
    );
    const config = JSON.parse(await readFile(path.join(dir, "config.json"), "utf8")) as {
      daemon: { listen: string; auth?: unknown; autoArchiveAfterMerge?: boolean };
    };
    expect(config.daemon.listen).toBe("127.0.0.1:6768");
    expect(config.daemon.auth).toEqual({ password: HASH });
    expect(config.daemon.autoArchiveAfterMerge).toBe(true);
  });
});

describe("sign-ins", () => {
  it("rides the settings part only when credentials are allowed", async () => {
    const dir = await home({
      "gateway.json": { version: 1 },
      "gateway/codex-accounts.json": [
        { id: "codex:one", accountId: "one", expiresAt: 100, addedAt: 1 },
      ],
    });
    const keyless = await collectPart("settings", { neolixHome: dir, keys: false });
    expect(keyless.files.some((file) => file.path === "signins.json")).toBe(false);

    const keyed = await collectPart("settings", { neolixHome: dir, keys: true });
    const signins = keyed.files.find((file) => file.path === "signins.json");
    expect(signins).toBeDefined();
    expect(Buffer.from(signins!.content).toString("utf8")).toContain("codex:one");
  });

  it("carries the Google store Gemini and Antigravity share", async () => {
    const dir = await home({
      "gateway/google-accounts.json": [
        { id: "google:one", agent: "gemini", expiresAt: 5, addedAt: 1 },
      ],
    });
    const keyed = await collectPart("settings", { neolixHome: dir, keys: true });
    const signins = keyed.files.find((file) => file.path === "signins.json");
    expect(Buffer.from(signins!.content).toString("utf8")).toContain("google:one");
  });

  it("merges per account, the later renewal winning, keeping a local-only one", async () => {
    const dir = await home({
      "gateway/codex-accounts.json": [
        { id: "codex:one", accountId: "one", expiresAt: 500, addedAt: 1, accessToken: "old" },
        { id: "codex:local", accountId: "local", expiresAt: 100, addedAt: 1 },
      ],
    });
    await applyPart(
      "settings",
      [
        {
          path: "signins.json",
          content: JSON.stringify({
            files: {
              "gateway/codex-accounts.json": [
                {
                  id: "codex:one",
                  accountId: "one",
                  expiresAt: 900,
                  addedAt: 1,
                  accessToken: "new",
                },
              ],
            },
          }),
        },
      ],
      { neolixHome: dir, keys: true },
    );
    const accounts = JSON.parse(
      await readFile(path.join(dir, "gateway/codex-accounts.json"), "utf8"),
    ) as { id: string; accessToken?: string }[];
    expect(accounts.find((entry) => entry.id === "codex:one")?.accessToken).toBe("new");
    expect(accounts.some((entry) => entry.id === "codex:local")).toBe(true);
  });
});
