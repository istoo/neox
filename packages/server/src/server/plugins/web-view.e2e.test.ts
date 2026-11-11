import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestNeolixDaemon } from "../test-utils/neolix-daemon.js";

const exampleDirectory = fileURLToPath(
  new URL("../../../../../plugin-examples/web-view/", import.meta.url),
);

describe("declarative plugin contributions over the daemon", () => {
  it("lists contributions, serves a web asset, and invokes the plugin RPC", async () => {
    const daemon = await createTestNeolixDaemon({
      pluginsEnabled: true,
      plugins: {
        "web-view-example": {
          source: "directory",
          path: path.resolve(exampleDirectory),
          enabled: true,
        },
      },
    });
    const client = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      appVersion: "0.15.0",
    });
    try {
      await client.connect();
      await client.fetchAgents({ subscribe: {} });

      const [plugin] = await client.listPlugins();
      expect(plugin).toMatchObject({
        id: "web-view-example",
        enabled: true,
        status: "running",
        contributions: {
          commands: expect.arrayContaining([
            expect.objectContaining({ id: "open", action: { kind: "openView", view: "main" } }),
          ]),
          sidebarItems: [expect.objectContaining({ id: "main", view: "main" })],
        },
        web: {
          views: [
            expect.objectContaining({
              id: "main",
              entry: "web/main.html",
              permissions: ["rpc", "navigate", "resize"],
              rpcs: ["greet", "notes.search"],
            }),
          ],
        },
      });

      const asset = await client.getPluginWebAsset("web-view-example", "web/main.html");
      expect(asset.contentType).toBe("text/html");
      expect(asset.encoding).toBe("utf8");
      expect(asset.content).toContain('src="main.js"');
      const script = await client.getPluginWebAsset("web-view-example", "web/main.js");
      expect(script.contentType).toBe("text/javascript");
      expect(script.content).toContain("window.neolix");

      const output = await client.invokePluginRpc("web-view-example", "greet", { name: "Ada" });
      expect(output).toEqual({ message: expect.stringContaining("Ada") });

      const notes = await client.invokePluginRpc("web-view-example", "notes.search", {
        query: "沙箱",
      });
      expect((notes as { items: Array<{ id: string }> }).items.map((item) => item.id)).toContain(
        "note-security",
      );
    } finally {
      await client.close();
      await daemon.close();
    }
  }, 40_000);
});
