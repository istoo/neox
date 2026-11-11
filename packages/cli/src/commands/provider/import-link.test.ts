import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseImportLink, runImportCommand } from "./import-link.js";

let home: string;
let out: string[];

function writeConfig(value: unknown): void {
  writeFileSync(join(home, "gateway.json"), JSON.stringify(value));
}

function providers(): Array<Record<string, unknown>> {
  return (
    (
      JSON.parse(readFileSync(join(home, "gateway.json"), "utf8")) as {
        providers?: Array<Record<string, unknown>>;
      }
    ).providers ?? []
  );
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "neolix-import-cli-"));
  process.env.NEOLIX_HOME = home;
  writeConfig({ providers: [] });
  out = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    out.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.NEOLIX_HOME;
});

describe("parseImportLink", () => {
  it("reads a preset link, with myna:// accepted beside neolix://", () => {
    const imported = parseImportLink("myna://import?preset=deepseek&key=sk-test&models=a,b");
    expect(imported.id).toBe("deepseek");
    expect(imported.args).toEqual(["deepseek", "models=a,b", "key=sk-test"]);
    expect(parseImportLink("neolix://import?preset=deepseek").id).toBe("deepseek");
  });

  it("reads a provider of its own from its endpoints", () => {
    const query = [
      "name=Acme%20Relay",
      "chat=https%3A%2F%2Frelay.test%2Fv1",
      "catalog=acme",
      "website=https%3A%2F%2Facme.test",
      "keys=https%3A%2F%2Facme.test%2Fkeys",
      "icon=https%3A%2F%2Frelay.test%2Ficon.png",
      "models=m1,m2",
      "key=k1",
    ].join("&");
    const imported = parseImportLink(`neolix://import?${query}`);
    expect(imported.id).toBe("acme-relay");
    expect(imported.endpoint).toEqual({ protocol: "openai", baseUrl: "https://relay.test/v1" });
    expect(imported.args).toContain("chat=https://relay.test/v1");
    expect(imported.args).toContain("icon=https://relay.test/icon.png");
    expect(imported.args).toContain("catalog=acme");
    expect(imported.args).toContain("website=https://acme.test");
    expect(imported.args).toContain("keys=https://acme.test/keys");
    expect(imported.args).toContain("models=m1,m2");
  });

  it("refuses what myna refuses", () => {
    expect(() => parseImportLink("https://import?preset=deepseek")).toThrow(
      "not a neolix:// or myna:// link",
    );
    expect(() => parseImportLink("myna://keys?preset=deepseek")).toThrow(
      "is not something Neox knows",
    );
    expect(() => parseImportLink("myna://import?name=Acme")).toThrow("no base URL");
    expect(() => parseImportLink("myna://import?preset=nope")).toThrow("no nope preset");
    expect(() => parseImportLink("myna://import?preset=google-vertex")).toThrow(
      "your own Google Cloud project",
    );
    expect(() =>
      parseImportLink("myna://import?name=Acme&chat=http%3A%2F%2Frelay.test%2Fv1"),
    ).toThrow("must use https");
  });
});

describe("neox provider import", () => {
  it("adds an https provider without asking with -y", async () => {
    const query = ["name=Acme%20Relay", "anthropic=https%3A%2F%2Frelay.test", "key=k1"].join("&");
    const lines = await runImportCommand(["-y", `neolix://import?${query}`], { home });
    expect(lines.join("\n")).toContain("added Acme Relay");
    expect(providers()[0]).toMatchObject({
      id: "acme-relay",
      label: "Acme Relay",
      protocol: "anthropic",
      baseUrl: "https://relay.test",
      apiKey: "k1",
    });
  });

  it("says the link has no key", async () => {
    const lines = await runImportCommand(["-y", "neolix://import?preset=deepseek&models=a"], {
      home,
    });
    expect(lines.join("\n")).toContain("the link has no key");
    expect(providers()[0]).toMatchObject({ id: "deepseek" });
  });

  it("asks before adding, and refuses without a terminal", async () => {
    await expect(
      runImportCommand(["neolix://import?preset=deepseek&key=k"], { home }),
    ).rejects.toThrow("add -y");
    expect(providers()).toEqual([]);
  });
});
