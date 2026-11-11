import { describe, expect, it } from "vitest";
import {
  bridgeName,
  bridgeToolAliases,
  bridgeToolName,
  bridgeTools,
  declaredToolName,
  mcpConfigJson,
} from "./tools.js";

describe("bridgeToolName", () => {
  it("keeps a name Claude Code can take", () => {
    expect(bridgeToolName("read")).toBe("read");
    expect(bridgeToolName("spawn_agent")).toBe("spawn_agent");
  });

  it("gives a name Claude Code would change a stable hash", () => {
    const first = bridgeToolName("spawn.agent");
    const second = bridgeToolName("spawn.agent");
    expect(first).toBe(second);
    expect(first).toMatch(/^spawn_agent_[0-9a-f]{12}$/);
    expect(bridgeToolName("a".repeat(80))).toHaveLength(38 + 1 + 12);
  });

  it("takes the bridge's own prefix off a tool the client already names", () => {
    expect(bridgeToolName("mcp__neox__browser_click")).toBe("browser_click");
    expect(bridgeName("read")).toBe("mcp__neox__read");
  });
});

describe("aliases", () => {
  it("maps only the names that differ", () => {
    const aliases = bridgeToolAliases([{ name: "read" }, { name: "spawn.agent" }]);
    expect(aliases.get("read")).toBeUndefined();
    expect(aliases.get(bridgeToolName("spawn.agent"))).toBe("spawn.agent");
    expect(declaredToolName(aliases, "read")).toBe("read");
  });
});

describe("bridgeTools", () => {
  it("offers every caller tool with a schema", () => {
    expect(bridgeTools([{ name: "read", description: "Read a file" }])).toEqual([
      {
        name: "read",
        description: "Read a file",
        inputSchema: { type: "object", properties: {} },
      },
    ]);
  });

  it("offers only the tool the caller chose by name", () => {
    expect(bridgeTools([{ name: "a" }, { name: "b" }], "b").map((tool) => tool.name)).toEqual([
      "b",
    ]);
  });
});

describe("mcpConfigJson", () => {
  it("mounts one strict server: this bridge's helper", () => {
    expect(JSON.parse(mcpConfigJson("/usr/bin/node", ["/x/mcp-helper.mjs", "/tmp/cb"]))).toEqual({
      mcpServers: {
        neox: {
          command: "/usr/bin/node",
          args: ["/x/mcp-helper.mjs", "/tmp/cb"],
        },
      },
    });
  });
});
