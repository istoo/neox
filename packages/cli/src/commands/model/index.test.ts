import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createModelCommand, parsePrice, parseTokens, tokenCount, tokenSize } from "./index.js";

let home: string;
let printed: string[];

function writeConfig(value: unknown): void {
  writeFileSync(join(home, "gateway.json"), JSON.stringify(value));
}

function readConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(home, "gateway.json"), "utf8")) as Record<string, unknown>;
}

async function run(...args: string[]): Promise<string[]> {
  printed = [];
  vi.spyOn(console, "log").mockImplementation((...values: unknown[]) => {
    printed.push(values.map(String).join(" "));
  });
  await createModelCommand().parseAsync(args, { from: "user" });
  return printed;
}

const base = {
  providers: [
    {
      id: "relay-a",
      protocol: "openai",
      baseUrl: "https://relay.test/v1",
      models: [
        { id: "claude-opus-5-5", label: "Opus 5.5", contextWindow: 200000, maxOutputTokens: 64000 },
        { id: "gpt-5-5" },
      ],
    },
  ],
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "neolix-model-cli-"));
  process.env.NEOLIX_HOME = home;
  writeConfig(base);
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.NEOLIX_HOME;
});

describe("model name", () => {
  it("reads, sets and resets a name", async () => {
    expect((await run("name", "relay-a/claude-opus-5-5")).join(" ")).toContain("Opus 5.5");
    expect((await run("name", "relay-a/gpt-5-5", "GPT", "5.5")).join(" ")).toContain(
      "is called GPT 5.5",
    );
    const models = (readConfig().providers as Array<{ models: Array<Record<string, unknown>> }>)[0]!
      .models;
    expect(models[1]?.label).toBe("GPT 5.5");
    await run("name", "relay-a/gpt-5-5", "--reset");
    const reset = (readConfig().providers as Array<{ models: Array<Record<string, unknown>> }>)[0]!
      .models;
    expect(reset[1]?.label).toBeUndefined();
  });
});

describe("model names", () => {
  it("lists the models named", async () => {
    const lines = await run("names");
    expect(lines.join("\n")).toContain("relay-a/claude-opus-5-5");
    expect(lines.join("\n")).toContain("Opus 5.5");
  });
});

describe("model price", () => {
  it("sets a price and reads it back, then resets it", async () => {
    const set = await run("price", "relay-a/gpt-5-5", "0.12,0.6,0.01,0.15");
    expect(set.join(" ")).toContain("costs");
    expect(
      (readConfig().pricing as Record<string, { inputPerMTok: number }>)["relay-a/gpt-5-5"]
        ?.inputPerMTok,
    ).toBe(0.12);
    expect((await run("price", "relay-a/gpt-5-5")).join(" ")).toContain("$0.12/$0.6 per 1M in/out");
    await run("price", "relay-a/gpt-5-5", "--reset");
    expect((readConfig().pricing as Record<string, unknown>)["relay-a/gpt-5-5"]).toBeUndefined();
  });

  it("reads tiers as myna does", () => {
    expect(parsePrice(["0.12,0.6,0.01,0.15", "--tier", "272k", "0.24,1.2,0.02,0.3"])).toMatchObject(
      {
        inputPerMTok: 0.12,
        tiers: [{ aboveTokens: 272_000, inputPerMTok: 0.24, outputPerMTok: 1.2 }],
      },
    );
    expect(() => parsePrice(["0.12,0.6"])).toThrow(/four parts/);
  });

  it("lists the prices given", async () => {
    await run("price", "relay-a/gpt-5-5", "0.12,0.6,0.01,0.15");
    expect((await run("prices")).join("\n")).toContain("relay-a/gpt-5-5");
  });

  it("prints the prices as JSON", async () => {
    await run("price", "relay-a/gpt-5-5", "0.12,0.6,0.01,0.15");
    const chunks: string[] = [];
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        chunks.push(String(chunk));
        return true;
      });
    try {
      await createModelCommand().parseAsync(["prices", "--json"], { from: "user" });
    } finally {
      write.mockRestore();
    }
    expect(JSON.parse(chunks.join(""))).toMatchObject({
      "relay-a/gpt-5-5": { inputPerMTok: 0.12 },
    });
  });

  it("reads the gateway.json of --home, not NEOLIX_HOME", async () => {
    const other = mkdtempSync(join(tmpdir(), "neolix-model-other-"));
    process.env.NEOLIX_HOME = other;
    expect((await run("names", "--home", home)).join(" ")).toContain("Opus 5.5");
  });

  it("refuses --host: the model settings are this computer's file", async () => {
    await expect(run("names", "--host", "127.0.0.1:6767")).rejects.toMatchObject({
      code: "LOCAL_OPERATION",
    });
  });
});

describe("model context and output", () => {
  it("sets, reads and resets a window", async () => {
    await run("context", "relay-a/gpt-5-5", "1m");
    expect((await run("context", "relay-a/gpt-5-5")).join(" ")).toContain("1M");
    await run("context", "relay-a/gpt-5-5", "--reset");
    const models = (readConfig().providers as Array<{ models: Array<Record<string, unknown>> }>)[0]!
      .models;
    expect(models[1]?.contextWindow).toBeUndefined();

    await run("output", "relay-a/gpt-5-5", "128k");
    const saved = (readConfig().providers as Array<{ models: Array<Record<string, unknown>> }>)[0]!
      .models;
    expect(saved[1]?.maxOutputTokens).toBe(128_000);
    expect((await run("output", "relay-a/gpt-5-5")).join(" ")).toContain("128k");
  });
});

describe("model spec", () => {
  it("shows the spec, sets parts and resets them", async () => {
    const shown = (await run("spec", "relay-a/claude-opus-5-5")).join("\n");
    expect(shown).toContain("context 200k");
    expect(shown).toContain("output 64k");
    await run("spec", "relay-a/gpt-5-5", "--context", "1m", "--vision", "on");
    const models = (readConfig().providers as Array<{ models: Array<Record<string, unknown>> }>)[0]!
      .models;
    expect(models[1]).toMatchObject({ contextWindow: 1_000_000, images: true });
    await run("spec", "relay-a/gpt-5-5", "--reset");
    const reset = (readConfig().providers as Array<{ models: Array<Record<string, unknown>> }>)[0]!
      .models;
    expect(reset[1]).toMatchObject({ id: "gpt-5-5" });
  });

  it("lists the specs given", async () => {
    expect((await run("specs")).join("\n")).toContain("relay-a/claude-opus-5-5");
  });
});

describe("model suffix", () => {
  it("reads and sets the suffix mode", async () => {
    expect((await run("suffix")).join(" ")).toContain("on");
    await run("suffix", "off");
    expect(readConfig().modelNames).toBe("off");
    expect((await run("suffix")).join(" ")).toContain("off");
  });
});

describe("model compact", () => {
  it("reads, sets a size and turns it off", async () => {
    expect((await run("compact")).join(" ")).toContain("on");
    await run("compact", "500k");
    expect(readConfig()).toMatchObject({ compactAt: 500_000, fullContext: false });
    expect((await run("compact")).join(" ")).toContain("500K");
    await run("compact", "off");
    expect(readConfig().fullContext).toBe(true);
    expect((await run("compact")).join(" ")).toContain("off");
  });
});

describe("model sizes", () => {
  it("reads tokens as myna does", () => {
    expect(parseTokens("200000")).toBe(200_000);
    expect(parseTokens("128k")).toBe(128_000);
    expect(parseTokens("1m")).toBe(1_000_000);
    expect(() => parseTokens("soon")).toThrow(/a size is a number of tokens/);
    expect(tokenCount(1_000_000)).toBe("1M");
    expect(tokenCount(128_000)).toBe("128k");
    expect(tokenCount(undefined)).toBe("unknown");
    expect(tokenSize(272_000)).toBe("272K");
  });
});

describe("model efforts", () => {
  it("keeps the levels offered, sends none, and resets", async () => {
    await run("efforts", "relay-a/gpt-5-5", "low,high");
    expect((readConfig().modelEfforts as Record<string, string[]>)["relay-a/gpt-5-5"]).toEqual([
      "low",
      "high",
    ]);
    expect((await run("efforts", "relay-a/gpt-5-5")).join(" ")).toContain("low high");
    await run("efforts", "relay-a/gpt-5-5", "off");
    expect((readConfig().modelReasonless as Record<string, boolean>)["relay-a/gpt-5-5"]).toBe(true);
    await run("efforts", "relay-a/gpt-5-5", "--reset");
    expect(
      (readConfig().modelEfforts as Record<string, unknown>)["relay-a/gpt-5-5"],
    ).toBeUndefined();
    expect(
      (readConfig().modelReasonless as Record<string, unknown>)["relay-a/gpt-5-5"],
    ).toBeUndefined();
  });
});

describe("model wire", () => {
  it("sets a name, reads it, lists it and resets it", async () => {
    await run("wire", "relay-a/*", "vendor-c/*");
    expect((readConfig().modelWires as Record<string, string>)["relay-a/*"]).toBe("vendor-c/*");
    expect((await run("wire", "relay-a/gpt-5-5")).join(" ")).toContain("vendor-c/gpt-5-5");
    expect((await run("wires")).join("\n")).toContain("relay-a/*");
    await run("wire", "relay-a/*", "--reset");
    expect((readConfig().modelWires as Record<string, unknown>)["relay-a/*"]).toBeUndefined();
  });
});

describe("model id", () => {
  it("lists a model by the user's id and resets it", async () => {
    await run("id", "relay-a/gpt-5-5", "gpt-5.5");
    expect((readConfig().modelIDs as Record<string, string>)["relay-a/gpt-5.5"]).toBe("gpt-5-5");
    expect((await run("id", "relay-a/gpt-5-5")).join(" ")).toContain("relay-a/gpt-5.5");
    expect((await run("ids")).join("\n")).toContain("relay-a/gpt-5.5");
    await run("id", "relay-a/gpt-5-5", "--reset");
    expect((readConfig().modelIDs as Record<string, unknown>)["relay-a/gpt-5.5"]).toBeUndefined();
  });
});

describe("model alias", () => {
  it("counts usage under another id and resets it", async () => {
    await run("alias", "deepseek-v4.1-flash", "deepseek-flash");
    expect((readConfig().usageAliases as Record<string, string>)["deepseek-v4.1-flash"]).toBe(
      "deepseek-flash",
    );
    expect((await run("alias", "deepseek-v4.1-flash")).join(" ")).toContain("deepseek-flash");
    expect((await run("aliases")).join("\n")).toContain("deepseek-v4.1-flash");
    await run("alias", "deepseek-v4.1-flash", "--reset");
    expect(
      (readConfig().usageAliases as Record<string, unknown>)["deepseek-v4.1-flash"],
    ).toBeUndefined();
  });
});

describe("model disable", () => {
  it("turns models off, lists what they turn off, and enables them", async () => {
    await run("disable", "*gpt*");
    expect(readConfig().disabledModels).toEqual(["*gpt*"]);
    expect((await run("disabled")).join("\n")).toContain("relay-a/gpt-5-5");
    await run("enable", "*gpt*");
    expect(readConfig().disabledModels).toEqual([]);
    expect((await run("disabled")).join(" ")).toContain("no model is disabled");
  });
});
