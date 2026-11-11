import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGatewayKeyCommand } from "./index.js";

// each case drives several commands, each starting a config store
vi.setConfig({ testTimeout: 60_000 });

let home: string;
let printed: string[];

interface KeyConfig {
  keys: Array<
    | string
    | {
        key: string;
        label?: string;
        models: string[];
        limits?: Array<Record<string, unknown>>;
        readOnly?: boolean;
        issues?: boolean;
        expiresAt?: string;
        issuer?: string;
      }
  >;
}

function writeConfig(value: unknown): void {
  writeFileSync(join(home, "gateway.json"), JSON.stringify(value));
}

function config(): KeyConfig {
  return JSON.parse(readFileSync(join(home, "gateway.json"), "utf8")) as KeyConfig;
}

async function run(...args: string[]): Promise<string[]> {
  printed = [];
  const write = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: string | Uint8Array) => {
      printed.push(String(chunk));
      return true;
    });
  try {
    await createGatewayKeyCommand().parseAsync(args, { from: "user" });
  } finally {
    write.mockRestore();
  }
  return printed
    .join("")
    .split("\n")
    .filter((line) => line !== "");
}

/** A key made by `add`, its secret alone on the last line. */
async function addKey(name: string, ...rest: string[]): Promise<string> {
  const lines = await run("add", name, ...rest);
  return lines[lines.length - 1]!;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "neox-gateway-keys-"));
  process.env.NEOLIX_HOME = home;
  writeConfig({ keys: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.NEOLIX_HOME;
});

describe("gateway-key add and list", () => {
  it("adds a key myna would make and lists it masked", async () => {
    const secret = await addKey("Desk display");
    expect(secret).toMatch(/^sk-[a-z]+-key-[0-9a-f]{48}$/);
    const lines = await run("list");
    expect(lines[0]).toBe(
      ["ID", "NAME", "STATE", "GATEWAY KEY", "LIMIT", "MODELS", "ACCOUNTS", "ACCESS"].join("\t"),
    );
    const row = lines[1]!.split("\t");
    expect(row[0]).toMatch(/^[0-9a-f]{24}$/);
    expect(row[1]).toBe("Desk display");
    expect(row[2]).toBe("enabled");
    expect(row[3]).toBe(`${secret.slice(0, 4)}…${secret.slice(-4)}`);
    expect(row[4]).toBe("-");
    expect(row[5]).toBe("all");
    expect(row[6]).toBe("all");
    expect(row[7]).toBe("full");
  });

  it("names a key by its id once it has one", async () => {
    await addKey("One");
    const id = (config().keys[0] as { id: string }).id;
    await run("rotate", id, "--key", "sk-rotated");
    expect((config().keys[0] as { key: string }).key).toBe("sk-rotated");
    // a key written before ids existed is still named by its label or secret
    writeConfig({ keys: [{ key: "sk-old", label: "Old", models: [] }] });
    await run("rotate", "Old", "--key", "sk-new");
    expect((config().keys[0] as { key: string }).key).toBe("sk-new");
    expect((await run("list"))[1]!.split("\t")[0]).toBe("-");
  });

  it("lists when given no words, as myna does", async () => {
    await addKey("One");
    expect((await run())[0]).toContain("NAME");
  });

  it("reads the gateway.json of --home, not NEOLIX_HOME", async () => {
    await addKey("One");
    const other = mkdtempSync(join(tmpdir(), "neox-gateway-keys-other-"));
    process.env.NEOLIX_HOME = other;
    const lines = await run("list", "--home", home);
    expect(lines.some((line) => line.includes("One"))).toBe(true);
  });

  it("prints the key list as JSON", async () => {
    await addKey("One");
    const rows = JSON.parse((await run("list", "--json")).join("\n")) as Array<{
      name: string;
      models: string[];
    }>;
    expect(rows[0]).toMatchObject({ name: "One", models: [] });
  });

  it("refuses --host: the keys are this computer's file", async () => {
    await expect(run("list", "--host", "127.0.0.1:6767")).rejects.toMatchObject({
      code: "LOCAL_OPERATION",
    });
  });

  it("keeps a key its clients already send, and refuses a duplicate", async () => {
    const lines = await run("add", "Handed out", "--key", "sk-their-own");
    expect(lines[lines.length - 1]).toBe("sk-their-own");
    await expect(run("add", "Another", "--key", "sk-their-own")).rejects.toThrow(/another here/);
  });

  it("adds a read-only key", async () => {
    await addKey("Display", "--read-only");
    expect(config().keys[0]).toMatchObject({ label: "Display", readOnly: true });
    const row = (await run("list"))[1]!.split("\t");
    expect(row[7]).toBe("read-only");
  });
});

describe("gateway-key rotate, remove and move", () => {
  it("rotates a key and prints the new secret alone", async () => {
    const first = await addKey("One");
    const lines = await run("rotate", "One");
    const next = lines[lines.length - 1]!;
    expect(next).not.toBe(first);
    expect((config().keys[0] as { key: string }).key).toBe(next);
  });

  it("moves the keys issued under a rotated one with it", async () => {
    await addKey("Parent");
    await run("issuer", "Parent", "on");
    await run("issue", "--ttl", "1h", "--name", "Child", "--from", "Parent");
    const lines = await run("rotate", "Parent");
    const next = lines[lines.length - 1]!;
    const child = config().keys.find(
      (entry) => typeof entry !== "string" && entry.label === "Child",
    ) as { issuer?: string };
    expect(child.issuer).toBe(next);
  });

  it("gives a key a value of its own", async () => {
    await addKey("One");
    await run("rotate", "One", "--key", "sk-mine");
    expect((config().keys[0] as { key: string }).key).toBe("sk-mine");
  });

  it("removes a key", async () => {
    await addKey("One");
    expect(await run("remove", "One")).toEqual(["Gateway key removed"]);
    expect(config().keys).toEqual([]);
    await expect(run("remove", "One")).rejects.toThrow("Key not found");
  });

  it("moves a key to a place counted from 1", async () => {
    await addKey("One");
    await addKey("Two");
    await addKey("Three");
    expect(await run("move", "Three", "1")).toEqual(["Gateway key moved to place 1"]);
    expect(config().keys.map((entry) => (entry as { label: string }).label)).toEqual([
      "Three",
      "One",
      "Two",
    ]);
    await expect(run("move", "Three", "9")).rejects.toThrow(/place is 1 to 3/);
  });
});

describe("gateway-key limit", () => {
  it("sets a day's tokens and cost, and reads them back", async () => {
    await addKey("One");
    const lines = await run("limit", "One", "day", "--tokens", "1m", "--cost", "5");
    const text = lines.join("\n");
    expect(text).toContain("Key\tOne");
    expect(text).toContain("this day");
    expect(text).toContain("Tokens\t0 used of 1000000, 1000000 left");
    expect(text).toContain("Cost\t$0.00 used of $5.00, $5.00 left");
    expect(text).toContain("State\topen");
    expect(config().keys[0]).toMatchObject({
      limits: [{ period: "day", tokens: 1000000, cost: 5, cacheReads: false }],
    });
  });

  it("adds several limits and refuses two in one window", async () => {
    await addKey("One");
    await run("limit", "One", "day", "--tokens", "1000");
    await run("limit", "One", "add", "5h", "--tokens", "2000");
    expect((config().keys[0] as { limits: unknown[] }).limits).toHaveLength(2);
    await expect(run("limit", "One", "add", "5h", "--tokens", "3000")).rejects.toThrow(
      /already has a limit every 5 hours/,
    );
    await expect(run("limit", "One", "week", "--tokens", "9000")).rejects.toThrow(
      /has 2 limits and none per week/,
    );
  });

  it("replaces the only limit, takes it off, and resets one", async () => {
    await addKey("One");
    await run("limit", "One", "day", "--tokens", "1000");
    await run("limit", "One", "week", "--tokens", "5000");
    expect((config().keys[0] as { limits: Array<{ period: string }> }).limits).toEqual([
      expect.objectContaining({ period: "week", tokens: 5000 }),
    ]);
    await run("limit", "One", "reset");
    expect(
      (config().keys[0] as { limits: Array<{ since?: string }> }).limits[0]?.since,
    ).toBeDefined();
    await run("limit", "One", "off");
    expect((config().keys[0] as { limits?: unknown }).limits).toBeUndefined();
    expect((await run("limit", "One")).join("\n")).toContain("One: no limit");
  });

  it("takes off the nth limit by the number the list shows", async () => {
    await addKey("One");
    await run("limit", "One", "day", "--tokens", "1000");
    await run("limit", "One", "add", "week", "--cost", "5");
    const listed = (await run("limit", "One")).join("\n");
    expect(listed).toContain("Limit 1");
    expect(listed).toContain("Limit 2");
    await run("limit", "One", "remove", "1");
    expect((config().keys[0] as { limits: Array<{ period: string }> }).limits).toEqual([
      expect.objectContaining({ period: "week" }),
    ]);
    await expect(run("limit", "One", "remove", "5")).rejects.toThrow(/number is 1 to 1/);
  });

  it("refuses a limit with no cap", async () => {
    await addKey("One");
    await expect(run("limit", "One", "day")).rejects.toThrow(
      "say --tokens, --cost or both, or off for no limit",
    );
  });
});

describe("gateway-key models, access and issuer", () => {
  it("shows and sets the models a key may use", async () => {
    await addKey("One");
    expect((await run("models", "One")).join("")).toContain("One: every model");
    await run("models", "One", "alpha/*", "beta/m1");
    expect((await run("models", "One")).join("")).toContain("One: only alpha/*, beta/m1");
    await run("models", "One", "all");
    expect((await run("models", "One")).join("")).toContain("One: every model");
  });

  it("shows and sets access", async () => {
    await addKey("One");
    expect((await run("access", "One")).join("")).toContain(
      "One: full access, models and stats as its other limits let it",
    );
    await run("access", "One", "read-only");
    expect((await run("access", "One")).join("")).toContain(
      "One: read-only, it reads quotas and usage and uses no model, MCP server or write",
    );
  });

  it("lets a key issue keys, and not an issued one", async () => {
    await addKey("Parent");
    expect((await run("issuer", "Parent")).join("")).toContain("Parent: issues no keys");
    await run("issuer", "Parent", "on");
    expect((await run("issuer", "Parent")).join("")).toContain(
      "Parent: may issue short-lived keys",
    );
    const issued = await run("issue", "--ttl", "1h", "--name", "Child", "--from", "Parent");
    const child = issued[issued.length - 1]!;
    expect(child).toMatch(/^sk-[a-z]+-key-[0-9a-f]{48}$/);
    await expect(run("issuer", "Child", "on")).rejects.toThrow(
      "An issued key can't issue keys of its own: let a key of yours issue them",
    );
  });
});

describe("gateway-key issue", () => {
  it("makes a key that stops by itself and prints it alone", async () => {
    const lines = await run("issue", "--ttl", "30m", "--name", "Sandbox", "--tokens", "100");
    const secret = lines[lines.length - 1]!;
    const entry = (
      config().keys[0] as { expiresAt?: string; limits?: Array<Record<string, unknown>> }
    ).expiresAt;
    expect(entry).toBeDefined();
    expect(config().keys[0]).toMatchObject({ label: "Sandbox", models: [] });
    expect(
      (config().keys[0] as { limits: Array<Record<string, unknown>> }).limits[0],
    ).toMatchObject({ period: "hours", tokens: 100 });
    const listed = (await run("list"))[1]!.split("\t");
    expect(listed[2]).toMatch(/^until /);
    expect(listed[1]).toBe("Sandbox");
    expect(secret).toMatch(/^sk-[a-z]+-key-/);
  });

  it("reads --json", async () => {
    const lines = await run("issue", "--ttl", "1h", "--name", "Sandbox", "--json");
    const value = JSON.parse(lines.join("\n")) as Record<string, unknown>;
    expect(value.name).toBe("Sandbox");
    expect(value.key).toMatch(/^sk-[a-z]+-key-/);
    expect(value.expires).toBeDefined();
  });

  it("refuses a ttl out of myna's range", async () => {
    await expect(run("issue", "--ttl", "10s")).rejects.toThrow(/lives from 1m0s to 30 days/);
    await expect(run("issue")).rejects.toThrow(/--ttl/);
  });
});

describe("gateway-key accounts and quotas", () => {
  const withProvider = {
    keys: [],
    providers: [
      {
        id: "codex",
        protocol: "openai",
        baseUrl: "https://codex.test/v1",
        accounts: [
          { id: "acct-1", apiKey: "k1" },
          { id: "acct-2", label: "Work", apiKey: "k2" },
        ],
        models: [],
      },
    ],
  };

  it("holds a key to the accounts its provider has, by id or name", async () => {
    writeConfig(withProvider);
    await addKey("One");
    await run("accounts", "One", "codex/acct-1", "codex/Work");
    expect((config().keys[0] as { accounts: string[] }).accounts).toEqual([
      "codex/acct-1",
      "codex/acct-2",
    ]);
    expect((await run("accounts", "One")).join("")).toContain(
      "One: only codex/acct-1, codex/acct-2",
    );
    expect((await run("list"))[1]!.split("\t")[6]).toBe("codex/acct-1,codex/acct-2");
    await run("accounts", "One", "all");
    expect((config().keys[0] as { accounts?: string[] }).accounts).toEqual([]);
    expect((await run("accounts", "One")).join("")).toContain("One: every account");
  });

  it("refuses a provider or account it has none of", async () => {
    writeConfig(withProvider);
    await addKey("One");
    await expect(run("accounts", "One", "nope/x")).rejects.toThrow(/no provider/);
    await expect(run("accounts", "One", "codex/nope")).rejects.toThrow(/has no account/);
    await expect(run("accounts", "One", "codex")).rejects.toThrow(/A key's account is/);
  });

  it("turns being told quotas on and off", async () => {
    writeConfig(withProvider);
    await addKey("One");
    expect((await run("quotas", "One")).join("")).toContain(
      "One: told no quotas when held to a budget, models or accounts",
    );
    await run("quotas", "One", "on");
    expect((config().keys[0] as { quotas: boolean }).quotas).toBe(true);
    expect((await run("quotas", "One")).join("")).toContain(
      "One: told the quotas of the providers and accounts it may use",
    );
    await run("quotas", "One", "off");
    expect((config().keys[0] as { quotas: boolean }).quotas).toBe(false);
    await expect(run("quotas", "One", "maybe")).rejects.toThrow(/usage: neox gateway-key quotas/);
  });
});
