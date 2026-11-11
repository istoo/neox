import { createServer, type Server } from "node:http";
import * as zlib from "node:zlib";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { createDecodedBodyMiddleware, DEFAULT_BODY_LIMIT_BYTES } from "./request-bounds.js";

const zstd = zlib as unknown as { zstdCompressSync(input: Buffer): Buffer };
const openServers: Server[] = [];

afterEach(() => {
  for (const server of openServers.splice(0)) {
    server.closeAllConnections();
    server.close();
  }
});

async function startApp(limitBytes?: number): Promise<string> {
  const app = express();
  app.use(
    limitBytes === undefined
      ? createDecodedBodyMiddleware()
      : createDecodedBodyMiddleware(limitBytes),
  );
  app.use(express.json({ limit: "512mb" }));
  app.post("/v1/responses", (req, res) => {
    res.json({ body: req.body });
  });
  return new Promise((resolve) => {
    const server = createServer(app);
    openServers.push(server);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("expected a port");
      }
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

async function post(
  url: string,
  body: Buffer,
  headers: Record<string, string>,
): Promise<{ status: number; parsed: unknown }> {
  const response = await fetch(`${url}/v1/responses`, { method: "POST", headers, body });
  return { status: response.status, parsed: await response.json() };
}

describe("zstd request bodies", () => {
  it("decodes a zstd JSON body before the parser sees it", async () => {
    const url = await startApp();
    const body = zstd.zstdCompressSync(Buffer.from(JSON.stringify({ model: "m1", input: [] })));
    const reply = await post(url, body, {
      "content-type": "application/json",
      "content-encoding": "zstd",
    });
    expect(reply.status).toBe(200);
    expect(reply.parsed).toEqual({ body: { model: "m1", input: [] } });
  });

  it("leaves an identity body to the parser", async () => {
    const url = await startApp();
    const reply = await post(url, Buffer.from('{"model":"m1"}'), {
      "content-type": "application/json",
    });
    expect(reply.status).toBe(200);
    expect(reply.parsed).toEqual({ body: { model: "m1" } });
  });

  it("refuses a decoded body over the limit", async () => {
    const url = await startApp(512);
    const body = zstd.zstdCompressSync(Buffer.from(JSON.stringify({ text: "x".repeat(4096) })));
    const reply = await post(url, body, {
      "content-type": "application/json",
      "content-encoding": "zstd",
    });
    expect(reply.status).toBe(413);
  });

  it("refuses a zstd body that isn't JSON", async () => {
    const url = await startApp();
    const body = zstd.zstdCompressSync(Buffer.from("not json"));
    const reply = await post(url, body, {
      "content-type": "application/json",
      "content-encoding": "zstd",
    });
    expect(reply.status).toBe(400);
  });

  it("refuses a zstd body of another content type", async () => {
    const url = await startApp();
    const reply = await post(url, Buffer.from("x"), {
      "content-type": "text/plain",
      "content-encoding": "zstd",
    });
    expect(reply.status).toBe(415);
  });

  it("names a 512 MB default limit", () => {
    expect(DEFAULT_BODY_LIMIT_BYTES).toBe(512 << 20);
  });
});
