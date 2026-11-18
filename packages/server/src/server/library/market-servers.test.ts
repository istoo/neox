import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

import { fromRegistry, searchMarketServers } from "./market-servers.js";

interface TestIcon {
  src?: unknown;
  theme?: unknown;
}

function registryServer(icons: TestIcon[] | undefined): Parameters<typeof fromRegistry>[0] {
  return {
    name: "io.github.acme/demo-mcp",
    title: "Demo",
    description: "A demo server",
    repository: { url: "https://github.com/acme/demo-mcp" },
    icons,
    packages: [
      {
        registryType: "npm",
        identifier: "@acme/demo-mcp",
        transport: { type: "stdio" },
      },
    ],
  };
}

describe("market servers' registry icons", () => {
  test("takes the first light and the first dark icon by theme", () => {
    const server = fromRegistry(
      registryServer([
        { src: "https://acme.test/first-light.png", theme: "light" },
        { src: "https://acme.test/first-dark.png", theme: "dark" },
        { src: "https://acme.test/second-light.png", theme: "light" },
        { src: "https://acme.test/second-dark.png", theme: "dark" },
      ]),
    );
    expect(server?.icon).toBe("https://acme.test/first-light.png");
    expect(server?.iconDark).toBe("https://acme.test/first-dark.png");
  });

  test("treats an icon without a theme as the light one", () => {
    const server = fromRegistry(
      registryServer([
        { src: "https://acme.test/any-theme.png" },
        { src: "https://acme.test/dark.png", theme: "dark" },
      ]),
    );
    expect(server?.icon).toBe("https://acme.test/any-theme.png");
    expect(server?.iconDark).toBe("https://acme.test/dark.png");
  });

  test("uses a dark icon for both when it is the only one", () => {
    const server = fromRegistry(
      registryServer([{ src: "https://acme.test/dark.png", theme: "dark" }]),
    );
    expect(server?.icon).toBe("https://acme.test/dark.png");
    expect(server?.iconDark).toBe("https://acme.test/dark.png");
  });

  test("skips icons that are not https", () => {
    const server = fromRegistry(
      registryServer([
        { src: "http://acme.test/plain.png" },
        { src: "javascript:alert(1)", theme: "dark" },
        { src: "https://acme.test/light.png", theme: "light" },
      ]),
    );
    expect(server?.icon).toBe("https://acme.test/light.png");
    expect(server?.iconDark).toBeUndefined();
  });

  test("falls back to the owner's avatar when every icon is unsafe", () => {
    const server = fromRegistry(registryServer([{ src: "http://acme.test/plain.png" }]));
    expect(server?.icon).toBe("https://github.com/acme.png?size=96");
    expect(server?.iconDark).toBeUndefined();
  });

  test("carries both icons into the market's answer", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "neolix-market-icons-"));
    try {
      const snapshot = path.join(dir, "snapshot.json");
      await writeFile(
        snapshot,
        JSON.stringify([
          registryServer([
            { src: "https://acme.test/light.png", theme: "light" },
            { src: "https://acme.test/dark.png", theme: "dark" },
          ]),
        ]),
      );
      const found = await searchMarketServers("demo", { mcp: [] }, { snapshot, live: false });
      const entry = found.servers.find((server) => server.name === "demo");
      expect(entry?.icon).toBe("https://acme.test/light.png");
      expect(entry?.iconDark).toBe("https://acme.test/dark.png");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
