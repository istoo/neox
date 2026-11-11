import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, test } from "vitest";
import { runMcpBridge } from "./bridge.js";
import { resolveGatewayTarget } from "./gateway.js";

const open: Server[] = [];

afterEach(async () => {
  await Promise.all(
    open.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

const PNG = Buffer.from("89504e470d0a1a0a", "hex");
const MP4 = Buffer.from("0000001866747970", "hex");

interface FakeGateway {
  base: string;
  requests: { path: string; authorization: string | undefined; body: string }[];
  refuse?: string;
}

function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

/** The video the gateway keeps at a URL rather than in the answer. */
async function answerVideo(req: IncomingMessage, res: ServerResponse, base: string): Promise<void> {
  const body = await readRequestBody(req);
  if (req.url?.startsWith("/mcp/myna/image/files/v.mp4")) {
    res.writeHead(200, { "content-type": "video/mp4" });
    res.end(MP4);
    return;
  }
  const message = JSON.parse(body) as { id?: unknown };
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        content: [{ type: "text", text: `- ${base}/mcp/myna/image/files/v.mp4?t=x` }],
      },
    }),
  );
}

async function fakeGateway(): Promise<FakeGateway> {
  const state: FakeGateway = { base: "", requests: [] };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      state.requests.push({
        path: req.url ?? "",
        authorization: req.headers["authorization"] as string | undefined,
        body,
      });
      if (state.refuse !== undefined) {
        res.writeHead(502, { "content-type": "text/plain" });
        res.end(state.refuse);
        return;
      }
      if (req.url?.startsWith("/mcp/myna/image/files/v.mp4")) {
        res.writeHead(200, { "content-type": "video/mp4" });
        res.end(MP4);
        return;
      }
      const message = JSON.parse(body) as { id?: unknown; method?: string };
      const answer =
        message.method === "tools/call"
          ? {
              jsonrpc: "2.0",
              id: message.id,
              result: {
                content: [{ type: "image", data: PNG.toString("base64"), mimeType: "image/png" }],
              },
            }
          : { jsonrpc: "2.0", id: message.id, result: { tools: [] } };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(answer));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  open.push(server);
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected a TCP address");
  }
  state.base = `http://127.0.0.1:${address.port}`;
  return state;
}

interface BridgeRun {
  answers: Record<string, unknown>[];
  errors: string;
}

async function run(
  name: string,
  target: Parameters<typeof runMcpBridge>[1],
  lines: string[],
  cwd?: string,
): Promise<BridgeRun> {
  const input = new PassThrough();
  const output = new PassThrough();
  const error = new PassThrough();
  let text = "";
  let stderr = "";
  output.on("data", (chunk: Buffer) => {
    text += chunk.toString("utf8");
  });
  error.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const done = runMcpBridge(name, target, {
    input,
    output,
    error,
    ...(cwd ? { cwd } : {}),
  });
  for (const line of lines) {
    input.write(`${line}\n`);
  }
  input.end();
  await done;
  return {
    answers: text
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>),
    errors: stderr,
  };
}

describe("neox mcp", () => {
  test("relays a message to the gateway and writes its answer", async () => {
    const gateway = await fakeGateway();
    const answer = await run("image", { base: gateway.base, key: "k-1" }, [
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    ]);
    expect(gateway.requests[0]?.path).toBe("/mcp/myna/image");
    expect(gateway.requests[0]?.authorization).toBe("Bearer k-1");
    expect(answer.answers[0]).toMatchObject({ id: 1, result: { tools: [] } });
  });

  test("saves an inline image into the project and names the file", async () => {
    const gateway = await fakeGateway();
    const cwd = await mkdtemp(path.join(tmpdir(), "neolix-mcp-bridge-"));
    const answer = await run(
      "image",
      { base: gateway.base },
      [
        JSON.stringify({
          jsonrpc: "2.0",
          id: 7,
          method: "tools/call",
          params: { name: "generate_image", arguments: { prompt: "A red fox" } },
        }),
      ],
      cwd,
    );

    const result = answer.answers[0]?.result as { content: { type: string; text?: string }[] };
    const note = result.content.find((item) => item.type === "text")?.text ?? "";
    expect(note).toContain("Saved to ");

    const files = await readdir(path.join(cwd, "generated-images"));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^a-red-fox-\d{8}-\d{6}\.png$/);
    expect(await readFile(path.join(cwd, "generated-images", files[0] ?? ""))).toEqual(PNG);
  });

  test("downloads a video too large to inline into generated-videos", async () => {
    const gateway = await fakeGateway();
    const cwd = await mkdtemp(path.join(tmpdir(), "neolix-mcp-video-"));
    // The fake gateway answers an image; its text names a video file instead.
    const server = createServer((req, res) => {
      void answerVideo(req, res, gateway.base);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    open.push(server);
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Expected a TCP address");
    }
    const base = `http://127.0.0.1:${address.port}`;

    await run(
      "image",
      { base },
      [
        JSON.stringify({
          jsonrpc: "2.0",
          id: 8,
          method: "tools/call",
          params: { name: "generate_video", arguments: { prompt: "Waves" } },
        }),
      ],
      cwd,
    );

    const files = await readdir(path.join(cwd, "generated-videos"));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^waves-\d{8}-\d{6}\.mp4$/);
    expect(await readFile(path.join(cwd, "generated-videos", files[0] ?? ""))).toEqual(MP4);
  });

  test("answers a gateway refusal as a JSON-RPC error", async () => {
    const gateway = await fakeGateway();
    gateway.refuse = "Neox's sign-in to the MCP server image has run out: sign in to it again";
    const answer = await run("image", { base: gateway.base }, [
      JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" }),
    ]);
    expect(answer.answers[0]).toMatchObject({
      id: 9,
      error: { message: expect.stringContaining("sign in to it again") },
    });
  });

  test("resolves the gateway from NEOLIX_GATEWAY", async () => {
    const target = await resolveGatewayTarget({}, { NEOLIX_GATEWAY: "http://127.0.0.1:7000/" });
    expect(target).toEqual({ base: "http://127.0.0.1:7000" });
  });

  test("falls back to the daemon address in Neox's own config", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "neolix-mcp-home-"));
    await writeFile(
      path.join(home, "config.json"),
      JSON.stringify({ version: 1, daemon: { listen: "127.0.0.1:7123" } }),
    );
    const target = await resolveGatewayTarget({ home }, {});
    expect(target).toEqual({ base: "http://127.0.0.1:7123" });
  });
});
