import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { loadPluginReadme } from "./readme.js";

const servers: Server[] = [];

interface StubResponse {
  status?: number;
  body: string;
}

async function stubServer(routes: Record<string, StubResponse>): Promise<string> {
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://stub").pathname;
    const route = routes[path] ?? routes[decodeURIComponent(path)];
    if (!route) {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("not found");
      return;
    }
    response.writeHead(route.status ?? 200, { "content-type": "text/plain" });
    response.end(route.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No stub address");
  return `http://127.0.0.1:${address.port}`;
}

function publishedDetail(readme: string, overviewTranslations?: Record<string, string>) {
  return JSON.stringify({
    id: "acme/readme-plugin",
    name: "readme-plugin",
    description: "A plugin",
    categories: ["utils"],
    author: { github: "acme" },
    repository: { url: "https://github.com/acme/readme-plugin" },
    artifact: {
      kind: "npm",
      package: "neolix-plugin-readme",
      version: "1.0.0",
      resolved: "https://registry.npmjs.org/neolix-plugin-readme/-/neolix-plugin-readme-1.0.0.tgz",
      integrity: "sha512-AAAA",
    },
    media: [],
    submittedAt: "2026-10-01T00:00:00.000Z",
    reviewedAt: "2026-10-02T00:00:00.000Z",
    updatedAt: "2026-10-03T00:00:00.000Z",
    publishedAt: "2026-10-03T00:00:00.000Z",
    readme,
    ...(overviewTranslations ? { overviewTranslations } : {}),
  });
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

describe("loadPluginReadme", () => {
  it("serves the registry README translated for the requested locale", async () => {
    const baseUrl = await stubServer({
      "/plugins/acme/readme-locale.json": {
        body: publishedDetail("# English", { "zh-CN": "# 中文" }),
      },
    });

    const markdown = await loadPluginReadme(
      { kind: "registry", id: "acme/readme-locale" },
      { baseUrl },
      "zh-CN",
    );

    expect(markdown).toBe("# 中文");
  });

  it("falls back to the registry README when the locale has no translation", async () => {
    const baseUrl = await stubServer({
      "/plugins/acme/readme-fallback.json": { body: publishedDetail("# English") },
    });

    const markdown = await loadPluginReadme(
      { kind: "registry", id: "acme/readme-fallback" },
      { baseUrl },
      "ja",
    );

    expect(markdown).toBe("# English");
  });

  it("reads the README field from an npm package document", async () => {
    const npmRegistryUrl = await stubServer({
      "/@acme/neolix-plugin-readme-npm": {
        body: JSON.stringify({ readme: "# npm package" }),
      },
    });

    const markdown = await loadPluginReadme(
      { kind: "npm", package: "@acme/neolix-plugin-readme-npm" },
      { npmRegistryUrl },
    );

    expect(markdown).toBe("# npm package");
  });

  it("tries the GitHub README candidates until one exists", async () => {
    const githubRawUrl = await stubServer({
      "/acme/neolix-plugin-readme-git/HEAD/readme.md": { body: "# lowercase" },
    });

    const markdown = await loadPluginReadme(
      { kind: "github", remote: "https://github.com/acme/neolix-plugin-readme-git.git" },
      { githubRawUrl },
    );

    expect(markdown).toBe("# lowercase");
  });

  it("rejects a repository that is not on GitHub", async () => {
    await expect(
      loadPluginReadme({ kind: "github", remote: "https://gitlab.com/acme/plugin.git" }),
    ).rejects.toThrow("Only GitHub repositories");
  });
});
