import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPluginMarket, searchNpmPlugins } from "./market.js";

const servers: Server[] = [];

interface StubRoutes {
  index?: unknown;
  search?: unknown;
  downloads?: unknown;
  indexStatus?: number;
}

async function stubServer(routes: StubRoutes): Promise<string> {
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://stub").pathname;
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (path === "/index.json") {
      send(routes.indexStatus ?? 200, routes.index ?? {});
      return;
    }
    if (path === "/-/v1/search") {
      send(200, routes.search ?? { objects: [] });
      return;
    }
    if (path.startsWith("/downloads/")) {
      send(200, routes.downloads ?? { downloads: 0 });
      return;
    }
    send(404, { error: "not found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No stub address");
  return `http://127.0.0.1:${address.port}`;
}

function publishedPlugin(id: string, artifact: Record<string, unknown>) {
  return {
    id,
    name: id.split("/")[1],
    description: "A plugin",
    categories: ["utils"],
    author: { github: id.split("/")[0] },
    repository: { url: "https://github.com/acme/plugin" },
    artifact,
    media: [],
    submittedAt: "2026-10-01T00:00:00.000Z",
    reviewedAt: "2026-10-02T00:00:00.000Z",
    updatedAt: "2026-10-03T00:00:00.000Z",
    publishedAt: "2026-10-03T00:00:00.000Z",
  };
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

describe("plugin market", () => {
  it("loads the registry index with npm's weekly downloads for npm artifacts", async () => {
    const base = await stubServer({
      index: {
        schemaVersion: 1,
        registry: { name: "Stub plugins", url: "https://plugins.example.test" },
        categories: [{ slug: "utils", label: "Utils" }],
        plugins: [
          publishedPlugin("acme/tool", {
            kind: "npm",
            package: "@acme/tool",
            version: "1.0.0",
            resolved: "https://registry.npmjs.org/@acme/tool/-/tool-1.0.0.tgz",
            integrity: "sha512-AAAA",
          }),
          publishedPlugin("acme/git-tool", {
            kind: "git",
            remote: "https://github.com/acme/git-tool.git",
            commit: "a".repeat(40),
          }),
        ],
        featured: [],
        generatedAt: "2026-10-03T00:00:00.000Z",
      },
      downloads: { downloads: 4242 },
    });

    const market = await loadPluginMarket({
      baseUrl: base,
      npmDownloadsUrl: `${base}/downloads`,
    });

    expect(market.registry).toEqual({ name: "Stub plugins", url: "https://plugins.example.test" });
    expect(market.categories).toEqual([{ slug: "utils", label: "Utils" }]);
    expect(market.plugins.map((plugin) => plugin.id)).toEqual(["acme/tool", "acme/git-tool"]);
    expect(market.weeklyDownloads).toEqual({ "acme/tool": 4242 });
  });

  it("rejects an index the registry cannot serve", async () => {
    const base = await stubServer({ indexStatus: 503 });

    await expect(loadPluginMarket({ baseUrl: base })).rejects.toThrow("returned 503");
  });

  it("searches npm through the mirror and falls back to the official registry", async () => {
    const base = await stubServer({
      search: {
        objects: [
          {
            package: {
              name: "neolix-goal-mode",
              version: "1.2.3",
              description: "Keeps an agent on one goal",
              publisher: { username: "acme" },
            },
          },
        ],
      },
      downloads: { downloads: 1200 },
    });

    const hits = await searchNpmPlugins("goal", {
      mirror: true,
      // A closed port proves the mirror was attempted first and the official registry still answered.
      npmMirrorUrl: "http://127.0.0.1:9",
      npmRegistryUrl: base,
      npmDownloadsUrl: `${base}/downloads`,
    });

    expect(hits).toEqual([
      {
        package: "neolix-goal-mode",
        name: "neolix-goal-mode",
        version: "1.2.3",
        description: "Keeps an agent on one goal",
        publisher: "acme",
        weeklyDownloads: 1200,
      },
    ]);
  });
});
