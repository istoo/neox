import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSearchCommand, runSearchCommand } from "./index.js";

let home: string;
let out: string[];

function writeConfig(value: unknown): void {
  writeFileSync(join(home, "gateway.json"), JSON.stringify(value));
}

function readConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(home, "gateway.json"), "utf8")) as Record<string, unknown>;
}

function apis(): Array<Record<string, unknown>> {
  const search = readConfig().search as { apis?: Array<Record<string, unknown>> } | undefined;
  return search?.apis ?? [];
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "neolix-search-cli-"));
  process.env.NEOLIX_HOME = home;
  writeConfig({ providers: [] });
  out = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    out.push(String(chunk));
    return true;
  });
  vi.spyOn(console, "log").mockImplementation((...values: unknown[]) => {
    out.push(values.map(String).join(" "));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.NEOLIX_HOME;
});

const text = () => out.join("");

describe("neox search", () => {
  it("says there is no API yet", async () => {
    await runSearchCommand([]);
    expect(text()).toContain("no search API");
  });

  it("adds an API with its key, then lists it masked", async () => {
    await runSearchCommand(["add", "tavily", "tvly-secret-key"]);
    expect(apis()).toEqual([{ vendor: "tavily", key: "tvly-secret-key", pick: undefined }]);
    expect(text()).toContain("search API 1 of 1");
    out = [];
    await runSearchCommand([]);
    expect(text()).toContain("Tavily");
    expect(text()).toContain("tvly…-key");
    expect(text()).not.toContain("tvly-secret-key");
  });

  it("keeps the address when a new key alone is given, and url= resets it", async () => {
    await runSearchCommand(["add", "searxng", "url=https://searx.example.com"]);
    expect(apis()[0]?.url).toBe("https://searx.example.com");
    await runSearchCommand(["add", "searxng", "k2"]);
    expect(apis()[0]).toMatchObject({ key: "k2", url: "https://searx.example.com" });
    await runSearchCommand(["add", "searxng", "url="]);
    expect(apis()[0]?.url).toBeUndefined();
  });

  it("turns one off and on, moves it, and removes it", async () => {
    await runSearchCommand(["add", "tavily", "k1"]);
    await runSearchCommand(["add", "brave", "k2"]);
    await runSearchCommand(["off", "brave"]);
    expect(apis()[1]?.off).toBe(true);
    await runSearchCommand(["on", "brave"]);
    expect(apis()[1]?.off).toBeUndefined();
    await runSearchCommand(["move", "brave", "1"]);
    expect(apis().map((api) => api.vendor)).toEqual(["brave", "tavily"]);
    await runSearchCommand(["rm", "brave"]);
    expect(apis().map((api) => api.vendor)).toEqual(["tavily"]);
  });

  it("refuses an unknown API and a bad place", async () => {
    await expect(runSearchCommand(["add", "nope", "k"])).rejects.toThrow("no nope search API");
    await runSearchCommand(["add", "tavily", "k"]);
    await expect(runSearchCommand(["move", "tavily", "3"])).rejects.toThrow("n from 1 to 1");
  });

  it("registers as `neox search` and keeps pick=order", async () => {
    await createSearchCommand().parseAsync(["add", "you", "pick=order"], { from: "user" });
    expect(apis()[0]).toMatchObject({ vendor: "you", pick: "order" });
  });
});
