import { describe, expect, it } from "vitest";

import { ProviderDirectory } from "./providers.ts";

function daemon(providers: string[]) {
  let reads = 0;
  return {
    get reads() {
      return reads;
    },
    listAvailableProviders: async () => {
      reads += 1;
      return { providers: providers.map((provider) => ({ provider })) };
    },
  };
}

describe("ProviderDirectory.resolve", () => {
  it("reads the daemon's list when a lookup arrives before the config read filled it", async () => {
    const directory = new ProviderDirectory();
    const client = daemon(["claude", "codex"]);
    expect(directory.neolixProviderFor({ provider: "codex" })).toBeNull();
    await expect(directory.resolve(client, { provider: "codex" })).resolves.toBe("codex");
    expect(client.reads).toBe(1);
  });

  it("does not re-read on every miss for a provider the daemon does not have", async () => {
    const directory = new ProviderDirectory();
    const client = daemon(["claude"]);
    await expect(directory.resolve(client, { provider: "grok" })).resolves.toBeNull();
    await expect(directory.resolve(client, { provider: "grok" })).resolves.toBeNull();
    expect(client.reads).toBe(1);
  });

  it("answers from the known list without asking the daemon", async () => {
    const directory = new ProviderDirectory();
    directory.update(["claude"]);
    const client = daemon(["claude"]);
    await expect(
      directory.resolve(client, { provider: "claudeAgent", instanceId: "claudeAgent" }),
    ).resolves.toBe("claude");
    expect(client.reads).toBe(0);
  });
});
