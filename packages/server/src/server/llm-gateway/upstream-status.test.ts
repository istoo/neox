import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  readVendorStatus,
  resetUpstreamCache,
  UPSTREAM_VENDORS,
  vendorOf,
  type UpstreamVendor,
} from "./upstream-status.js";

const anthropic = UPSTREAM_VENDORS.find((vendor) => vendor.id === "anthropic")!;
const openai = UPSTREAM_VENDORS.find((vendor) => vendor.id === "openai")!;

let server: Server | undefined;

afterEach(async () => {
  resetUpstreamCache();
  if (server !== undefined) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

/** Serves `body` at /api/v2/summary.json and returns the vendor pointed at it. */
async function serve(vendor: UpstreamVendor, body: string, status = 200): Promise<UpstreamVendor> {
  server = createServer((_request, response) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(body);
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("no server address");
  }
  return { ...vendor, summary: `http://127.0.0.1:${address.port}/api/v2/summary.json` };
}

function page(components: unknown[], incidents: unknown[] = []): string {
  return JSON.stringify({
    status: { indicator: "none", description: "All Systems Operational" },
    components,
    incidents,
  });
}

describe("readVendorStatus", () => {
  it("says all is well when the API's parts are operational", async () => {
    const vendor = await serve(
      anthropic,
      page([
        { id: "web", name: "claude.ai", status: "major_outage", group: false },
        { id: "api", name: "Claude API (api.anthropic.com)", status: "operational", group: false },
        { id: "group", name: "Claude", status: "operational", group: true },
      ]),
    );
    const status = await readVendorStatus(vendor);
    expect(status.level).toBe("ok");
    expect(status.parts).toEqual([]);
    expect(status.incidents).toEqual([]);
    expect(status.error).toBeUndefined();
  });

  it("reports the worst part and the incident on it", async () => {
    const vendor = await serve(
      anthropic,
      page(
        [
          { id: "api", name: "Claude API (api.anthropic.com)", status: "degraded_performance" },
          { id: "code", name: "Claude Code", status: "operational" },
          { id: "web", name: "claude.ai", status: "major_outage" },
        ],
        [
          {
            name: "Elevated errors",
            status: "investigating",
            impact: "minor",
            shortlink: "https://stspg.io/abc",
            components: [{ id: "api", name: "Claude API (api.anthropic.com)" }],
          },
          { name: "Old outage", status: "resolved", components: [{ id: "api" }] },
          { name: "claude.ai outage", status: "investigating", components: [{ id: "web" }] },
        ],
      ),
    );
    const status = await readVendorStatus(vendor);
    expect(status.level).toBe("degraded");
    expect(status.parts).toEqual([
      { name: "Claude API (api.anthropic.com)", status: "degraded_performance" },
    ]);
    expect(status.incidents).toEqual([
      { name: "Elevated errors", impact: "minor", url: "https://stspg.io/abc" },
    ]);
  });

  it("counts a major outage as the worst", async () => {
    const vendor = await serve(
      openai,
      page([
        { id: "chat", name: "Chat Completions", status: "major_outage" },
        { id: "responses", name: "Responses", status: "degraded_performance" },
        { id: "voice", name: "Voice mode", status: "major_outage" },
      ]),
    );
    const status = await readVendorStatus(vendor);
    expect(status.level).toBe("major");
    expect(status.parts.map((part) => part.name)).toEqual(["Chat Completions", "Responses"]);
  });

  it("keeps an incident that names no parts while the API is affected", async () => {
    const vendor = await serve(
      openai,
      page(
        [
          { id: "chat", name: "Chat Completions", status: "partial_outage" },
          { id: "responses", name: "Responses", status: "operational" },
        ],
        [{ name: "Partial system degradation", status: "identified", impact: "major" }],
      ),
    );
    const status = await readVendorStatus(vendor);
    expect(status.level).toBe("partial");
    expect(status.incidents).toEqual([{ name: "Partial system degradation", impact: "major" }]);
  });

  it("is unknown, not all well, when the page lists none of the API's parts", async () => {
    const vendor = await serve(
      anthropic,
      page([{ id: "web", name: "claude.ai", status: "operational" }]),
    );
    const status = await readVendorStatus(vendor);
    expect(status.level).toBeNull();
    expect(status.error).toContain("lists none of its API's parts");
  });

  it("is unknown when the page answers with an error", async () => {
    const vendor = await serve(anthropic, "{}", 503);
    const status = await readVendorStatus(vendor);
    expect(status.level).toBeNull();
    expect(status.error).toContain("503");
  });

  it("is unknown when the page is not JSON", async () => {
    const vendor = await serve(anthropic, "<html>maintenance</html>");
    const status = await readVendorStatus(vendor);
    expect(status.level).toBeNull();
    expect(status.error).toBeDefined();
  });

  it("has no page to read for DeepSeek", async () => {
    const deepseek = UPSTREAM_VENDORS.find((vendor) => vendor.id === "deepseek")!;
    const status = await readVendorStatus(deepseek);
    expect(status.level).toBeNull();
    expect(status.readAt).toBeNull();
    expect(status.error).toBeUndefined();
  });
});

describe("vendorOf", () => {
  it("finds the vendor a base URL reaches", () => {
    expect(vendorOf(["https://api.anthropic.com/v1"])?.id).toBe("anthropic");
    expect(vendorOf(["https://chatgpt.com/backend-api/codex"])?.id).toBe("openai");
    expect(vendorOf(["https://api.moonshot.ai/v1"])?.id).toBe("moonshot");
    expect(vendorOf(["api.deepseek.com"])?.id).toBe("deepseek");
  });

  it("knows nothing of a relay or a local server", () => {
    expect(vendorOf(["https://openrouter.ai/api/v1"])).toBeUndefined();
    expect(vendorOf(["http://127.0.0.1:11434/v1"])).toBeUndefined();
  });
});
