#!/usr/bin/env node
/**
 * Probes the client-facing routes myna serves on a running myna and a running
 * Neolix gateway, and reports where one answers a route the other does not.
 * Bodies are empty or invalid on purpose: a probe must not spend a model call.
 *
 *   node scripts/myna-parity.mjs --myna http://127.0.0.1:3425 --neolix http://127.0.0.1:6768
 */
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { writeFile } from "node:fs/promises";

const args = process.argv.slice(2);
function arg(name, fallback) {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
}

const MYNA = arg("myna", "http://127.0.0.1:3425");
const NEOLIX = arg("neolix", "http://127.0.0.1:6768");
const OUT = arg("out", "artifacts/myna-parity-report.json");

const PROBES = [
  ["GET", "/v1"],
  ["GET", "/v1/models"],
  ["GET", "/models"],
  ["GET", "/v1/models/local/model-a"],
  ["GET", "/muse-code/models"],
  ["GET", "/v1/codex/models"],
  ["GET", "/api/hello"],
  ["GET", "/api/version"],
  ["GET", "/api/tags"],
  ["GET", "/v1beta/models"],
  ["GET", "/v1/myna/quotas"],
  ["GET", "/v1/myna/usage"],
  ["GET", "/v1/myna/usage/requests"],
  ["GET", "/v1/myna/quotas/history"],
  ["GET", "/v1/myna/route"],
  ["GET", "/v1/myna/statusline"],
  ["GET", "/v1/myna/trace"],
  ["GET", "/v1/myna/route-events/snapshot"],
  ["GET", "/v1/myna/concurrency"],
  ["GET", "/v1/myna/limit"],
  ["GET", "/v1/myna/mcp"],
  ["GET", "/v1/myna/keys"],
  ["GET", "/v1/myna/keys/oidc"],
  ["GET", "/v1/myna/claude-runs"],
  ["GET", "/v1/myna/heap"],
  ["GET", "/v1/myna/cpu?seconds=0.1"],
  ["GET", "/v1/myna/goroutines"],
  ["GET", "/v1/myna/omarchy"],
  ["GET", "/me"],
  ["GET", "/v1/myna/me"],
  ["GET", "/v1/responses"],
  ["GET", "/v1/myna/native/myna/models"],
  ["POST", "/v1/chat/completions", {}],
  ["POST", "/v1/responses", {}],
  ["POST", "/v1/messages", {}],
  ["POST", "/v1/messages/count_tokens", {}],
  ["POST", "/v1/systemone", {}],
  ["POST", "/v1/alpha/search", {}],
  ["POST", "/v1/images/generations", {}],
  ["POST", "/v1/embeddings", {}],
  ["POST", "/v1/rerank", {}],
  ["POST", "/v1/audio/speech", {}],
  ["POST", "/v1/audio/transcriptions", {}],
  ["POST", "/v1/videos", {}],
  ["POST", "/api/chat", {}],
  ["POST", "/api/generate", {}],
  ["POST", "/api/show", {}],
  ["POST", "/v1/myna/keys/oidc", {}],
  ["POST", "/mcp/myna/web-search", { jsonrpc: "2.0", id: 1, method: "tools/list" }],
  ["POST", "/mcp/myna/tools", { jsonrpc: "2.0", id: 1, method: "tools/list" }],
  ["POST", "/mcp/myna/vision", { jsonrpc: "2.0", id: 1, method: "tools/list" }],
  ["POST", "/mcp/myna/image", { jsonrpc: "2.0", id: 1, method: "tools/list" }],
  ["POST", "/mcp/myna/browser", { jsonrpc: "2.0", id: 1, method: "tools/list" }],
  ["POST", "/mcp/myna/hub", { jsonrpc: "2.0", id: 1, method: "tools/list" }],
  ["POST", "/mcp/run/demo", { jsonrpc: "2.0", id: 1, method: "tools/list" }],
  ["GET", "/v1/videos/abc"],
  ["GET", "/v1/videos/abc/content"],
  ["POST", "/v1beta/models/x:generateContent", {}],
  ["POST", "/v1beta/models/x:streamGenerateContent", {}],
  ["POST", "/v1/usage/requests", {}],
  ["POST", "/backend-api/codex/responses", {}],
  ["POST", "/v1/myna/usage/requests", {}],
];

function missingFrameworkRoute(status, body) {
  if (status !== 404) {
    return false;
  }
  return (
    body.trim().length === 0 ||
    body.includes("Cannot ") ||
    body.includes("myna serves /v1/chat") ||
    body.trimStart().startsWith("<!doctype") ||
    body.trimStart().startsWith("<html")
  );
}

async function probe(base, [method, path, body]) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    });
    const text = await response.text();
    return {
      status: response.status,
      exists: !missingFrameworkRoute(response.status, text),
      body: text.slice(0, 200),
    };
  } catch (error) {
    return { status: 0, exists: false, body: String(error) };
  } finally {
    clearTimeout(timer);
  }
}

const rows = [];
for (const probeSpec of PROBES) {
  const [method, path] = probeSpec;
  const [myna, neolix] = await Promise.all([probe(MYNA, probeSpec), probe(NEOLIX, probeSpec)]);
  rows.push({ method, path, myna, neolix });
}

const gaps = rows.filter((row) => row.myna.exists && !row.neolix.exists);
const extra = rows.filter((row) => !row.myna.exists && row.neolix.exists);
const pad = (value, width) => String(value).padEnd(width);
for (const row of rows) {
  const mark = row.myna.exists && !row.neolix.exists ? "GAP" : "";
  console.log(
    `${pad(row.method, 5)} ${pad(row.path, 38)} myna ${pad(row.myna.status, 4)} neolix ${pad(
      row.neolix.status,
      4,
    )} ${mark}`,
  );
}

const TOOL_ENDPOINTS = [
  "/mcp/myna/web-search",
  "/mcp/myna/tools",
  "/mcp/myna/vision",
  "/mcp/myna/image",
  "/mcp/myna/browser",
  "/mcp/myna/hub",
];

async function toolNames(base, path) {
  try {
    const response = await rawPost(`${base}${path}`, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    const payload = JSON.parse(response.text);
    const tools = payload?.result?.tools;
    return Array.isArray(tools) ? tools.map((tool) => tool.name).sort() : [];
  } catch {
    return [];
  }
}

const toolRows = [];
for (const path of TOOL_ENDPOINTS) {
  const [mynaTools, neolixTools] = await Promise.all([
    toolNames(MYNA, path),
    toolNames(NEOLIX, path),
  ]);
  toolRows.push({
    path,
    myna: mynaTools,
    neolix: neolixTools,
    equal: mynaTools.join() === neolixTools.join(),
  });
}
for (const row of toolRows) {
  console.log(
    `TOOLS ${row.path.padEnd(28)} myna [${row.myna.join(", ")}] neolix [${row.neolix.join(", ")}] ${
      row.equal ? "" : "DIFF"
    }`,
  );
}

const behaviourPaths = [
  ["GET", "/v1/myna/route", undefined],
  ["GET", "/v1/responses", undefined],
  ["POST", "/api/show", {}],
  ["POST", "/v1/myna/keys/oidc", {}],
  ["POST", "/v1/myna/keys/oidc", "bad-token"],
];
const behaviourRows = [];
for (const spec of behaviourPaths) {
  const [method, path, body] = spec;
  const [myna, neolix] = await Promise.all([
    probe(MYNA, [method, path, body === "bad-token" ? {} : body]),
    probe(NEOLIX, [method, path, body === "bad-token" ? {} : body]),
  ]);
  behaviourRows.push({ method, path, myna, neolix, equal: myna.status === neolix.status });
}
for (const row of behaviourRows) {
  console.log(
    `BEHAVIOUR ${row.method} ${row.path.padEnd(26)} myna ${row.myna.status} neolix ${row.neolix.status} ${
      row.equal ? "" : "DIFF"
    }`,
  );
}

async function htmlShape(base) {
  try {
    const response = await fetch(`${base}/me`, { signal: AbortSignal.timeout(8_000) });
    const text = await response.text();
    return { status: response.status, input: /<input/i.test(text), html: /<html/i.test(text) };
  } catch {
    return { status: 0, input: false, html: false };
  }
}

async function searchCallShape(base) {
  try {
    const response = await fetch(`${base}/mcp/myna/web-search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "web_search", arguments: {} },
      }),
      signal: AbortSignal.timeout(8_000),
    });
    const payload = await response.json();
    return { status: response.status, isError: payload?.result?.isError === true };
  } catch {
    return { status: 0, isError: false };
  }
}

const [mynaPage, neolixPage] = await Promise.all([htmlShape(MYNA), htmlShape(NEOLIX)]);
console.log(
  `SHAPE /me myna ${JSON.stringify(mynaPage)} neolix ${JSON.stringify(neolixPage)} ${
    mynaPage.status === neolixPage.status && mynaPage.input === neolixPage.input ? "" : "DIFF"
  }`,
);
const [mynaSearchCall, neolixSearchCall] = await Promise.all([
  searchCallShape(MYNA),
  searchCallShape(NEOLIX),
]);
console.log(
  `SHAPE web_search/empty myna ${JSON.stringify(mynaSearchCall)} neolix ${JSON.stringify(neolixSearchCall)} ${
    mynaSearchCall.status === neolixSearchCall.status &&
    mynaSearchCall.isError === neolixSearchCall.isError
      ? ""
      : "DIFF"
  }`,
);

const calcCalls = [
  ["calc_eval", { expression: "0.1+0.2" }],
  ["calc_convert", { value: "1.5", from: "GiB", to: "MB" }],
  ["calc_date", { date: "2026-01-01", add: "30d" }],
];

async function calcCall(base, name, callArgs) {
  try {
    const response = await fetch(`${base}/mcp/myna/tools`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: callArgs },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const payload = await response.json();
    const text = payload?.result?.content?.[0]?.text ?? "";
    return { status: response.status, isError: payload?.result?.isError, text };
  } catch (error) {
    return { status: 0, isError: true, text: String(error) };
  }
}

const calcRows = [];
for (const [name, callArgs] of calcCalls) {
  const [myna, neolix] = await Promise.all([
    calcCall(MYNA, name, callArgs),
    calcCall(NEOLIX, name, callArgs),
  ]);
  calcRows.push({
    name,
    args: callArgs,
    myna,
    neolix,
    equal: myna.status === neolix.status && myna.text === neolix.text,
  });
}
for (const row of calcRows) {
  console.log(
    `TOOLCALL ${row.name.padEnd(14)} myna ${row.myna.text} neolix ${row.neolix.text} ${
      row.equal ? "" : "DIFF"
    }`,
  );
}

console.log(
  `\n${rows.length} probes, ${gaps.length} gaps, ${extra.length} Neolix-only answers; ` +
    `${toolRows.filter((row) => !row.equal).length} tool-list differences; ` +
    `${behaviourRows.filter((row) => !row.equal).length} behaviour differences; ` +
    `${calcRows.filter((row) => !row.equal).length} calc-tool differences`,
);

async function visionCall(base) {
  const image =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  try {
    const response = await fetch(`${base}/mcp/myna/vision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "analyze_image",
          arguments: { image, prompt: "What color is this pixel? One word." },
        },
      }),
      signal: AbortSignal.timeout(120_000),
    });
    const payload = await response.json();
    return {
      status: response.status,
      isError: payload?.result?.isError,
      text: payload?.result?.content?.[0]?.text ?? "",
    };
  } catch (error) {
    return { status: 0, isError: true, text: String(error) };
  }
}

async function restartState(base) {
  try {
    const response = await fetch(`${base}/v1/myna/restart`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(8_000),
    });
    const payload = await response.json();
    return { status: response.status, state: payload.state };
  } catch (error) {
    return { status: 0, state: String(error) };
  }
}

const [mynaRestart, neolixRestart] = await Promise.all([restartState(MYNA), restartState(NEOLIX)]);
console.log(
  `SHAPE restart myna ${JSON.stringify(mynaRestart)} neolix ${JSON.stringify(neolixRestart)} ${
    mynaRestart.state === neolixRestart.state ? "" : "DIFF"
  }`,
);

/** A program's call: no Sec-Fetch headers, as curl sends. */
function rawPost(url, body) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const payload = JSON.stringify(body);
    const request = (target.protocol === "https:" ? httpsRequest : httpRequest)(
      target,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
        },
        timeout: 60_000,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            text: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    request.on("timeout", () => request.destroy(new Error("timed out")));
    request.on("error", reject);
    request.end(payload);
  });
}

async function programToolCall(base, endpoint, name, callArgs) {
  try {
    const response = await rawPost(`${base}/mcp/myna/${endpoint}`, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: callArgs },
    });
    let payload = null;
    try {
      payload = JSON.parse(response.text);
    } catch {
      payload = null;
    }
    return {
      status: response.status,
      text: payload?.result?.content?.[0]?.text ?? response.text.slice(0, 80),
      isError: payload?.result?.isError ?? payload === null,
    };
  } catch (error) {
    return { status: 0, text: String(error), isError: true };
  }
}

async function toolCall(base, endpoint, name, callArgs) {
  try {
    const response = await fetch(`${base}/mcp/myna/${endpoint}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: callArgs },
      }),
      signal: AbortSignal.timeout(60_000),
    });
    const payload = await response.json();
    return {
      status: response.status,
      isError: payload?.result?.isError ?? payload?.error !== undefined,
      text: payload?.result?.content?.[0]?.text ?? JSON.stringify(payload?.error ?? ""),
    };
  } catch (error) {
    return { status: 0, isError: true, text: String(error) };
  }
}

if (process.env.MYNA_PARITY_TOOLS === "1") {
  const [mynaBrowser, neolixBrowser] = await Promise.all([
    programToolCall(MYNA, "browser", "browser", { action: "tabs" }),
    programToolCall(NEOLIX, "browser", "browser", { action: "tabs" }),
  ]);
  console.log(
    `TOOLCALL browser(program) myna ${JSON.stringify(mynaBrowser.status)} ${mynaBrowser.text.slice(0, 40)} neolix ${JSON.stringify(neolixBrowser.status)} ${neolixBrowser.text.slice(0, 40)} ${
      mynaBrowser.status === neolixBrowser.status && mynaBrowser.text === neolixBrowser.text
        ? ""
        : "DIFF"
    }`,
  );
  const toolCases = [
    ["image", "generation_result", { id: "does-not-exist" }],
    ["image", "generate_image", { prompt: "" }],
  ];
  for (const [endpoint, name, callArgs] of toolCases) {
    const [myna, neolix] = await Promise.all([
      toolCall(MYNA, endpoint, name, callArgs),
      toolCall(NEOLIX, endpoint, name, callArgs),
    ]);
    console.log(
      `TOOLCALL ${name.padEnd(16)} myna ${JSON.stringify(myna)} neolix ${JSON.stringify(neolix)} ${
        myna.status === neolix.status && myna.text === neolix.text ? "" : "DIFF"
      }`,
    );
  }
}

if (process.env.MYNA_PARITY_VISION === "1") {
  const [myna, neolix] = await Promise.all([visionCall(MYNA), visionCall(NEOLIX)]);
  console.log(
    `TOOLCALL analyze_image   myna ${JSON.stringify(myna)} neolix ${JSON.stringify(neolix)} ${
      myna.text === neolix.text && myna.status === neolix.status ? "" : "DIFF"
    }`,
  );
}

const report = {
  checkedAt: new Date().toISOString(),
  myna: MYNA,
  neolix: NEOLIX,
  rows,
  gaps,
  toolRows,
  behaviourRows,
  calcRows,
};
await writeFile(OUT, `${JSON.stringify(report, null, 2)}\n`);
console.log(`wrote ${OUT}`);
process.exitCode = gaps.length === 0 ? 0 : 1;
