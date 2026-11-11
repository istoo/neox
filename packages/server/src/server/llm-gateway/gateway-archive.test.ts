import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { NextFunction, Request, Response } from "express";
import pino from "pino";
import { afterAll, describe, expect, it } from "vitest";
import type { GatewayConfig } from "./config.js";
import { ARCHIVE_HEADER, captureRawBody, GatewayArchive } from "./gateway-archive.js";
import type { Masker } from "./masking.js";

const logger = pino({ level: "silent" });
const homes: string[] = [];

afterAll(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

const masker = {
  maskText: (text: string) => text.replaceAll("sk-secret", "[masked]"),
  maskValueWithHits: (value: unknown) => ({
    value: JSON.parse(JSON.stringify(value).replaceAll("sk-secret", "[masked]")),
    hits: [],
    blocked: false,
  }),
} as unknown as Masker;

function config(local: boolean): { get(): GatewayConfig } {
  return {
    get: () =>
      ({
        version: 1,
        enabled: true,
        keys: [],
        providers: [],
        groups: [],
        archive: local ? { local: true, maxMB: 1 } : undefined,
      }) as GatewayConfig,
  };
}

interface Fake {
  req: Request;
  res: Response;
  headers: Record<string, string>;
  finish: () => void;
}

function fake(body: unknown): Fake {
  const headers: Record<string, string> = {};
  const listeners: Array<() => void> = [];
  let written = "";
  const res = {
    statusCode: 200,
    locals: {},
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value;
    },
    getHeaders: () => headers,
    write(chunk: unknown) {
      written += Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
      return true;
    },
    end(chunk?: unknown) {
      if (chunk !== undefined && chunk !== null) {
        written += Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
      }
      for (const listener of listeners) {
        listener();
      }
      return res;
    },
    once(event: string, listener: () => void) {
      if (event === "finish") {
        listeners.push(listener);
      }
      return res;
    },
  } as unknown as Response;
  const req = {
    method: "POST",
    path: "/v1/chat/completions",
    originalUrl: "/v1/chat/completions?key=sk-secret",
    headers: { authorization: "Bearer sk-secret", "user-agent": "test/1" },
    body,
  } as unknown as Request;
  return {
    req,
    res,
    headers,
    finish: () => {
      (res as unknown as { end: (chunk?: unknown) => void }).end(written);
    },
  };
}

async function archive(): Promise<{ archive: GatewayArchive; home: string }> {
  const home = await mkdtemp(path.join(tmpdir(), "neolix-archive-"));
  homes.push(home);
  return { archive: new GatewayArchive({ neolixHome: home, logger }), home };
}

describe("the request archive on this computer", () => {
  it("keeps a call, maskes its secrets, and sends its id", async () => {
    const made = await archive();
    const call = fake({ prompt: "hello", api_key: "sk-secret" });
    let nexted = false;
    const next: NextFunction = () => {
      nexted = true;
    };
    made.archive.middleware({ configStore: config(true), masker })(call.req, call.res, next);
    expect(nexted).toBe(true);
    const id = call.headers[ARCHIVE_HEADER.toLowerCase()] ?? "";
    expect(id).toMatch(/^\d{6}-[0-9a-f]{16}$/);
    captureRawBody(call.req, Buffer.from('{"prompt":"hello","api_key":"sk-secret"}'));

    call.res.locals.archiveWire = [
      {
        method: "POST",
        url: "https://api.example.com/v1/chat?key=sk-secret",
        request: { authorization: "Bearer sk-secret" },
        status: 200,
        response: { "x-token": "sk-secret" },
        millis: 12,
      },
    ];
    call.res.setHeader("x-test", "sk-secret");
    (call.res as unknown as { write: (chunk: string) => void }).write('{"answer":"');
    call.finish();
    // the write is queued after the call ends
    await made.archive.dispose();

    const day = new Date().toISOString().slice(0, 10);
    const record = await made.archive.read(day, id);
    expect(record).not.toBeNull();
    expect(record?.response.body).toContain('{"answer":"');
    expect(record?.request.body).toContain('"hello"');
    expect(JSON.stringify(record)).not.toContain("sk-secret");
    expect(JSON.stringify(record)).toContain("[masked]");
    expect(record?.upstream?.[0]).toMatchObject({ status: 200, millis: 12 });
    expect(record?.upstream?.[0]?.url).toContain("key=%5Bredacted%5D");
  });

  it("uploads to sync's bucket when it has one", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "neolix-archive-"));
    homes.push(home);
    const objects = new Map<string, Buffer>();
    const bucket = {
      put: async (name: string, data: Buffer) => {
        objects.set(name, data);
      },
      get: async (name: string) => objects.get(name) ?? null,
    };
    const made = new GatewayArchive({ neolixHome: home, logger, bucket: () => bucket });
    const call = fake({ prompt: "hello" });
    made.middleware({ configStore: config(true), masker })(call.req, call.res, () => undefined);
    const id = call.headers[ARCHIVE_HEADER.toLowerCase()] ?? "";
    call.finish();
    await made.dispose();

    const day = new Date().toISOString().slice(0, 10);
    expect([...objects.keys()]).toEqual([`myna/archive/${day}/${id}.json`]);
    const record = await made.read(day, id);
    expect(record?.request.body).toContain('"hello"');
    // Nothing is written here when the bucket took it.
    await expect(readFile(path.join(home, "request-archive", day, `${id}.json`))).rejects.toThrow();
  });

  it("keeps nothing while its switch is off", async () => {
    const made = await archive();
    const call = fake({ prompt: "hello" });
    let nexted = false;
    made.archive.middleware({ configStore: config(false), masker })(call.req, call.res, () => {
      nexted = true;
    });
    expect(nexted).toBe(true);
    expect(call.headers[ARCHIVE_HEADER.toLowerCase()]).toBeUndefined();
    call.finish();
    await made.archive.dispose();
    expect(await made.archive.read("2026-01-01", "nothing")).toBeNull();
  });
});
