#!/usr/bin/env node
// The stdio MCP server Claude Code is given for the Claude subscription
// bridge. It lists the caller's tools and hands each call to the daemon over
// HTTP, blocking until the caller's next request brings the result.
//
// Usage: node mcp-helper.mjs <callback-file-or-url> <tools.json> [listed-file]
//
// Plain JavaScript on purpose: the daemon starts it with process.execPath, in
// development and in a build alike, without a TypeScript build step.

import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import readline from "node:readline";

const PROTOCOL_VERSION = "2025-06-18";
const [callbackFile, toolsFile, listedFile] = process.argv.slice(2);

if (callbackFile === undefined || toolsFile === undefined) {
  process.stderr.write("mcp-helper expects a callback URL and a tools file\n");
  process.exit(2);
}

const callbackUrl =
  callbackFile.startsWith("http://") || callbackFile.startsWith("https://")
    ? callbackFile
    : (await readFile(callbackFile, "utf8")).trim();
let tools = JSON.parse(await readFile(toolsFile, "utf8"));
if (!Array.isArray(tools)) {
  tools = [];
}

const transport = callbackUrl.startsWith("https://") ? https : http;
const agent = new transport.Agent({ keepAlive: true });

function respond(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function callDaemon(payload) {
  return new Promise((resolve, reject) => {
    const url = new URL(callbackUrl);
    const body = Buffer.from(JSON.stringify(payload));
    const request = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: "POST",
        agent,
        headers: {
          "content-type": "application/json",
          "content-length": String(body.length),
        },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed = null;
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = null;
          }
          resolve({ status: response.statusCode ?? 0, body: parsed, text });
        });
      },
    );
    request.on("error", reject);
    request.end(body);
  });
}

function callIdFrom(meta) {
  const id = meta && typeof meta === "object" ? meta["claudecode/toolUseId"] : undefined;
  if (typeof id === "string" && id !== "") {
    return id;
  }
  return `call_${randomBytes(12).toString("hex")}`;
}

async function toolCall(params) {
  const name = typeof params?.name === "string" ? params.name : "";
  const args = params?.arguments ?? {};
  const id = callIdFrom(params?._meta);
  let answer;
  try {
    answer = await callDaemon({ tool_call_id: id, name, arguments: args });
  } catch (error) {
    return { error: { code: -32000, message: String(error?.message ?? error) } };
  }
  if (answer.status !== 200) {
    return {
      error: { code: -32000, message: answer.text || `callback answered ${answer.status}` },
    };
  }
  const body = answer.body ?? {};
  return { result: { content: body.content ?? [], isError: body.is_error === true } };
}

async function handle(request) {
  switch (request.method) {
    case "initialize":
      return {
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "neox", version: "1" },
        },
      };
    case "tools/list":
      if (listedFile !== undefined) {
        await writeFile(listedFile, "").catch(() => {});
      }
      return { result: { tools } };
    case "tools/call":
      return toolCall(request.params ?? {});
    default:
      return { error: { code: -32601, message: "method not found" } };
  }
}

// A line on stderr says the helper is ready to read its input: a caller
// waiting on it (a test, a bridge starting it) has a signal rather than a
// guess from how long a process takes.
process.stderr.write("mcp-helper ready\n");

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  if (line.trim() === "") {
    return;
  }
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  if (request.id === undefined || request.id === null) {
    return; // a notification takes no answer
  }
  handle(request).then(
    (outcome) => {
      const response = { jsonrpc: "2.0", id: request.id };
      if (outcome.error !== undefined) {
        response.error = outcome.error;
      } else {
        response.result = outcome.result ?? null;
      }
      respond(response);
      return undefined;
    },
    (error) => {
      respond({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32000, message: String(error?.message ?? error) },
      });
      return undefined;
    },
  );
});

input.on("close", () => {
  process.exit(0);
});
