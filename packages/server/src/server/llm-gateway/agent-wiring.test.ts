import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentConfigFormat, writeAgentWiring } from "./agent-wiring.js";

const directories: string[] = [];

async function directory(): Promise<string> {
  const created = await mkdtemp(path.join(tmpdir(), "neolix-agent-wiring-"));
  directories.push(created);
  return created;
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    directories.splice(0).map((entry) => rm(entry, { recursive: true, force: true })),
  );
});

describe("agentConfigFormat", () => {
  it("reads the declared format first, then the file's name", () => {
    expect(agentConfigFormat("aider.conf.yml", undefined)).toBe("yaml");
    expect(agentConfigFormat("config.json", "env")).toBe("env");
    expect(agentConfigFormat(".env.local", undefined)).toBe("env");
    expect(() => agentConfigFormat("aider.conf", undefined)).toThrow();
  });
});

describe("writeAgentWiring", () => {
  it("keeps a JSON config's values, writes the wired ones and the model path", async () => {
    const dir = await directory();
    const file = path.join(dir, "agent.json");
    await writeFile(file, JSON.stringify({ theme: "dark", provider: { existing: true } }), "utf8");
    const written = await writeAgentWiring({
      config: file,
      settings: { baseURL: "http://127.0.0.1:6767/v1", apiKey: "local" },
      modelPath: "provider.model",
      model: "group/coding",
    });
    expect(written.keys).toEqual(["baseURL", "apiKey", "provider.model"]);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      theme: "dark",
      provider: { existing: true, model: "group/coding" },
      baseURL: "http://127.0.0.1:6767/v1",
      apiKey: "local",
    });
    expect(JSON.parse(await readFile(`${file}.neolix.bak`, "utf8"))).toEqual({
      theme: "dark",
      provider: { existing: true },
    });
  });

  it("merges env keys and keeps its lines", async () => {
    const dir = await directory();
    const file = path.join(dir, ".env");
    await writeFile(file, "EXISTING=1\n", "utf8");
    await writeAgentWiring({
      config: file,
      settings: { OPENAI_BASE_URL: "http://gateway/v1", OPENAI_API_KEY: "local" },
      model: "m",
    });
    expect(await readFile(file, "utf8")).toBe(
      "EXISTING=1\nOPENAI_BASE_URL=http://gateway/v1\nOPENAI_API_KEY=local\n",
    );
  });

  it("merges YAML without flattening it", async () => {
    const dir = await directory();
    const file = path.join(dir, "agent.yaml");
    await writeFile(file, "provider:\n  existing: true\n", "utf8");
    await writeAgentWiring({
      config: file,
      settings: { baseURL: "http://gateway/v1" },
      modelPath: "provider.model",
      model: "m",
    });
    const text = await readFile(file, "utf8");
    expect(text).toContain("existing: true");
    expect(text).toContain("model: m");
    expect(text).toContain("baseURL: http://gateway/v1");
  });
});
