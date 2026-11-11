import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const helper = path.join(path.dirname(fileURLToPath(import.meta.url)), "mcp-helper.mjs");
const cleanup: string[] = [];

afterEach(async () => {
  for (const dir of cleanup.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

interface Helper {
  ask(message: unknown): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

async function startHelper(): Promise<{
  helper: Helper;
  calls: Array<Record<string, unknown>>;
  listedFile: string;
}> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "neolix-mcp-helper-"));
  cleanup.push(dir);
  const calls: Array<Record<string, unknown>> = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      calls.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ content: [{ type: "text", text: "contents" }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("no address");
  }
  const callbackFile = path.join(dir, "callback");
  const toolsFile = path.join(dir, "tools.json");
  const listedFile = path.join(dir, "listed");
  await writeFile(callbackFile, `http://127.0.0.1:${address.port}/v1/myna/claude-run/token`);
  await writeFile(
    toolsFile,
    JSON.stringify([{ name: "read", description: "Read a file", inputSchema: { type: "object" } }]),
  );
  const child = spawn(process.execPath, [helper, callbackFile, toolsFile, listedFile], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  // The helper says it is ready on stderr once its files are read; asking
  // before then would race its startup, not its answers.
  const errors = readline.createInterface({ input: child.stderr, crlfDelay: Infinity });
  await new Promise<void>((resolve, reject) => {
    errors.on("line", (line) => {
      if (line === "mcp-helper ready") {
        resolve();
      }
    });
    child.on("error", reject);
    child.on("exit", (code) => reject(new Error(`helper ended before it was ready (${code})`)));
  });
  errors.close();
  child.stderr.resume();
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  // answers by the request id JSON-RPC gave them: they may come in any
  // order, and a late one must not be taken for another request's
  const pending = new Map<string, (answer: string) => void>();
  lines.on("line", (line) => {
    let answer: { id?: unknown };
    try {
      answer = JSON.parse(line) as { id?: unknown };
    } catch {
      return;
    }
    const waiter = pending.get(String(answer.id));
    if (waiter === undefined) {
      return;
    }
    pending.delete(String(answer.id));
    waiter(line);
  });
  child.on("exit", (code) => {
    for (const waiter of pending.values()) {
      waiter(JSON.stringify({ error: { code: -32000, message: `helper ended (${code})` } }));
    }
    pending.clear();
  });
  let nextId = 0;
  const ask = (message: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const id = `q${nextId}`;
    nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("helper did not answer"));
      }, 10_000);
      pending.set(id, (line) => {
        clearTimeout(timer);
        resolve(JSON.parse(line) as Record<string, unknown>);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, ...message })}\n`);
    });
  };
  return {
    helper: {
      ask,
      close: async () => {
        child.stdin.end();
        await new Promise<void>((resolve) => child.on("close", () => resolve()));
        await new Promise<void>((resolve) => server.close(() => resolve()));
      },
    },
    calls,
    listedFile,
  };
}

describe("mcp-helper", { timeout: 20_000 }, () => {
  it("lists the bridge's tools and forwards a call to the daemon", async () => {
    const { helper: client, calls } = await startHelper();
    const initialize = await client.ask({ method: "initialize", params: {} });
    expect(initialize.result).toMatchObject({ protocolVersion: "2025-06-18" });

    const list = await client.ask({ method: "tools/list", params: {} });
    expect(list.result).toMatchObject({ tools: [{ name: "read" }] });

    const call = await client.ask({
      method: "tools/call",
      params: {
        name: "read",
        arguments: { path: "a" },
        _meta: { "claudecode/toolUseId": "toolu_1" },
      },
    });
    expect(call.result).toEqual({ content: [{ type: "text", text: "contents" }], isError: false });
    expect(calls).toEqual([{ tool_call_id: "toolu_1", name: "read", arguments: { path: "a" } }]);
    await client.close();
  });

  it("writes the file Claude Code's first message waits for once tools are listed", async () => {
    const { helper: client, listedFile } = await startHelper();
    expect(await readFile(listedFile, "utf8").catch(() => "")).toBe("");
    await client.ask({ method: "tools/list", params: {} });
    await expect(readFile(listedFile, "utf8")).resolves.toBe("");
    await client.close();
  });

  it("answers an unknown method with a JSON-RPC error", async () => {
    const { helper: client } = await startHelper();
    const answer = await client.ask({ method: "resources/list", params: {} });
    expect(answer.error).toMatchObject({ code: -32601 });
    await client.close();
  });
});
