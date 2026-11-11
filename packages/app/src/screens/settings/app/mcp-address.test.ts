import { describe, expect, it } from "vitest";
import { mcpAddress } from "./mcp-address";

describe("mcpAddress", () => {
  it("puts the server's path under where this computer's daemon listens", () => {
    expect(mcpAddress("", "127.0.0.1:6768", "/mcp/myna/vision")).toBe(
      "http://127.0.0.1:6768/mcp/myna/vision",
    );
  });

  it("uses a network address when that is what the daemon published", () => {
    expect(mcpAddress("", "192.168.1.20:3425", "/mcp/myna/image")).toBe(
      "http://192.168.1.20:3425/mcp/myna/image",
    );
  });

  it("prefers the public address an agent elsewhere reaches", () => {
    expect(
      mcpAddress("https://neolix.example.com/", "127.0.0.1:6768", "/mcp/myna/web-search"),
    ).toBe("https://neolix.example.com/mcp/myna/web-search");
  });

  it("has no address for a socket, or before the daemon says where it listens", () => {
    expect(mcpAddress("", "/tmp/neolix.sock", "/mcp/myna/vision")).toBe("");
    expect(mcpAddress("", null, "/mcp/myna/vision")).toBe("");
  });
});
