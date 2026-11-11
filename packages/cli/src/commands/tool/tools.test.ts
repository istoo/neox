import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createCli } from "../../cli.js";
import type { GatewayTarget } from "../mcp/gateway.js";
import { FILES_META, listTools, PENDING_META, unknownTool } from "./catalog.js";
import { answerText, callTool, parseToolArgs, saveMade, targetPath } from "./call.js";

const PNG = Buffer.from("89504e470d0a1a0a", "hex");

const TOOLS: Record<string, unknown[]> = {
  "/mcp/myna/image": [
    {
      name: "generate_image",
      description: "Generate an image from a text prompt. More words follow.",
      inputSchema: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "What to draw." },
          size: { type: "string", description: "WIDTHxHEIGHT." },
          n: { type: "integer", minimum: 1, maximum: 4, description: "How many." },
          quality: { type: "string", enum: ["low", "medium", "high", "auto"] },
          reference_images: {
            type: "array",
            items: { type: "string" },
            description: "Images to edit.",
          },
        },
        required: ["prompt"],
      },
    },
    {
      name: "generate_video",
      description: "Generate a short video from a text prompt.",
      inputSchema: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "What happens." },
          seconds: { type: "integer", minimum: 1, maximum: 15 },
        },
        required: ["prompt"],
      },
    },
  ],
  "/mcp/myna/vision": [
    {
      name: "analyze_image",
      description: "Looks at an image and answers in text.",
      inputSchema: {
        type: "object",
        properties: {
          image: { type: "string", description: "The image file path." },
          prompt: { type: "string", description: "What to find out." },
        },
        required: ["image"],
      },
    },
  ],
  "/mcp/myna/web-search": [
    {
      name: "web_search",
      description: "Search the web for current information.",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string", description: "What to search for." } },
        required: ["query"],
      },
    },
  ],
  "/mcp/myna/tools": [
    {
      name: "calc_eval",
      description: "Evaluate an arithmetic expression exactly.",
      inputSchema: {
        type: "object",
        properties: { expression: { type: "string" }, places: { type: "number" } },
        required: ["expression"],
      },
    },
    {
      name: "calc_convert",
      description: "Convert between units.",
      inputSchema: {
        type: "object",
        properties: {
          value: { type: "number" },
          from: { type: "string" },
          to: { type: "string" },
        },
        required: ["value", "from", "to"],
      },
    },
  ],
};

interface FakeGateway {
  target: GatewayTarget;
  calls: {
    path: string;
    authorization: string | undefined;
    userAgent: string | undefined;
    body: unknown;
  }[];
}

const open: Server[] = [];

afterEach(async () => {
  await Promise.all(
    open.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function answerCall(body: string): unknown {
  const message = JSON.parse(body) as {
    id?: unknown;
    method?: string;
    params?: { name?: string; arguments?: Record<string, unknown> };
  };
  if (message.method === "tools/call" && message.params?.name === "generate_image") {
    return {
      jsonrpc: "2.0",
      id: message.id,
      result: {
        content: [
          { type: "text", text: "A red fox\n" },
          { type: "image", data: PNG.toString("base64"), mimeType: "image/png" },
        ],
        _meta: {
          [FILES_META]: [{ url: "/mcp/myna/image/files/a.png", inline: true }],
        },
      },
    };
  }
  if (message.method === "tools/call" && message.params?.name === "web_search") {
    return {
      jsonrpc: "2.0",
      id: message.id,
      result: { content: [{ type: "text", text: "Go 1.27 release notes\n" }] },
    };
  }
  return {
    jsonrpc: "2.0",
    id: message.id,
    error: { code: -32601, message: `no ${message.method ?? "call"}` },
  };
}

async function fakeGateway(): Promise<FakeGateway> {
  const state: FakeGateway = { target: { base: "" }, calls: [] };
  const server = createServer((req, res) => {
    void serveGateway(req, res, state);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  open.push(server);
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected a TCP address");
  }
  state.target = { base: `http://127.0.0.1:${address.port}`, key: "k-1" };
  return state;
}

async function serveGateway(
  req: IncomingMessage,
  res: ServerResponse,
  state: FakeGateway,
): Promise<void> {
  const body = await readBody(req);
  if (req.method === "GET" && req.url?.startsWith("/mcp/myna/image/files/")) {
    res.writeHead(200, { "content-type": "image/png" });
    res.end(PNG);
    return;
  }
  state.calls.push({
    path: req.url ?? "",
    authorization: req.headers["authorization"] as string | undefined,
    userAgent: req.headers["user-agent"] as string | undefined,
    body: JSON.parse(body) as unknown,
  });
  const message = JSON.parse(body) as { id?: unknown; method?: string };
  if (message.method === "tools/list") {
    const requestPath = (req.url ?? "").split("?")[0] ?? "";
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        result: { tools: TOOLS[requestPath] ?? [] },
      }),
    );
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(answerCall(body)));
}

function pendingHandler(
  bodies: { name?: string; arguments?: Record<string, unknown> }[],
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    void (async () => {
      const body = await readBody(req);
      const message = JSON.parse(body) as {
        id?: unknown;
        params?: { name?: string; arguments?: Record<string, unknown> };
      };
      bodies.push(message.params ?? {});
      res.writeHead(200, { "content-type": "application/json" });
      const result =
        bodies.length === 1
          ? {
              content: [{ type: "text", text: 'still making; use generation_result with id "g1"' }],
              _meta: { [PENDING_META]: "g1" },
            }
          : { content: [{ type: "text", text: "made" }], _meta: {} };
      res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    })();
  };
}

describe("neox tools", () => {
  test("lists every own server's tools in myna's order", async () => {
    const gateway = await fakeGateway();
    const { tools, notes } = await listTools(gateway.target);
    expect(notes).toEqual([]);
    expect(tools.map((tool) => `${tool.server}/${tool.name}`)).toEqual([
      "image/generate_image",
      "image/generate_video",
      "vision/analyze_image",
      "web-search/web_search",
      "tools/calc_eval",
      "tools/calc_convert",
    ]);
    expect(gateway.calls.map((call) => call.path)).toEqual([
      "/mcp/myna/image",
      "/mcp/myna/vision",
      "/mcp/myna/web-search",
      "/mcp/myna/tools",
    ]);
    expect(gateway.calls[0]?.authorization).toBe("Bearer k-1");
    expect(gateway.calls[0]?.userAgent).toBe("neolix-tool/1");
  });

  test("names an unknown tool and lists what there is", async () => {
    const gateway = await fakeGateway();
    const { tools, notes } = await listTools(gateway.target);
    const error = unknownTool("draw", tools, notes);
    expect(error.message).toContain('no tool called "draw"');
    expect(error.message).toContain("generate_image");
    expect(error.message).toContain("(neox tools)");
  });

  test("lists through the daemon address in a temporary NEOLIX_HOME", async () => {
    const gateway = await fakeGateway();
    const home = await mkdtemp(path.join(tmpdir(), "neolix-tool-home-"));
    const address = (gateway.target.base ?? "").replace("http://", "");
    await writeFile(
      path.join(home, "config.json"),
      JSON.stringify({ version: 1, daemon: { listen: address } }),
    );
    const written: string[] = [];
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        written.push(String(chunk));
        return true;
      });
    try {
      await createCli().parseAsync(["tools", "--home", home], { from: "user" });
    } finally {
      write.mockRestore();
    }
    const output = written.join("");
    expect(output).toContain("generate_image");
    expect(output).toContain("--prompt <text> (required)");
    expect(output).toContain("neox tool <name>");
  });

  test("calls a tool through the CLI, passing its own flags through", async () => {
    const gateway = await fakeGateway();
    const home = await mkdtemp(path.join(tmpdir(), "neolix-tool-home-"));
    const address = (gateway.target.base ?? "").replace("http://", "");
    await writeFile(
      path.join(home, "config.json"),
      JSON.stringify({ version: 1, daemon: { listen: address } }),
    );
    const written: string[] = [];
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        written.push(String(chunk));
        return true;
      });
    try {
      await createCli().parseAsync(["tool", "web_search", "--home", home, "--query", "go 1.27"], {
        from: "user",
      });
    } finally {
      write.mockRestore();
    }
    expect(written.join("")).toContain("Go 1.27 release notes");
    const called = gateway.calls.find(
      (call) => (call.body as { method?: string }).method === "tools/call",
    );
    const calledBody = called?.body as { params?: { arguments?: unknown } } | undefined;
    expect(calledBody?.params?.arguments).toEqual({ query: "go 1.27" });
  });
});

describe("neox tool arguments", () => {
  async function tool(
    name: string,
  ): Promise<Awaited<ReturnType<typeof listTools>>["tools"][number]> {
    const gateway = await fakeGateway();
    const { tools } = await listTools(gateway.target);
    const found = tools.find((entry) => entry.name === name);
    if (found === undefined) {
      throw new Error(`missing ${name}`);
    }
    return found;
  }

  test("reads parameters, words, lists and booleans", async () => {
    const generate = await tool("generate_image");
    const call = await parseToolArgs(generate, [
      "--n=2",
      "--quality",
      "high",
      "--reference_images",
      "a.png",
      "--reference-images",
      "b.png",
      "a fox",
      "-o",
      "out/",
    ]);
    expect(call.args).toEqual({
      n: 2,
      quality: "high",
      reference_images: ["a.png", "b.png"],
      prompt: "a fox",
    });
    expect(call.output).toBe("out/");
    expect(call.json).toBe(false);
  });

  test("refuses an unknown parameter before calling anything", async () => {
    const generate = await tool("generate_image");
    await expect(parseToolArgs(generate, ["--loud", "x", "a fox"])).rejects.toThrow(
      "takes no --loud",
    );
  });

  test("refuses an enum value it doesn't take", async () => {
    const generate = await tool("generate_image");
    await expect(parseToolArgs(generate, ["--quality", "ultra", "a fox"])).rejects.toThrow(
      "--quality takes <low|medium|high|auto>",
    );
  });

  test("refuses a missing required parameter", async () => {
    const generate = await tool("generate_image");
    await expect(parseToolArgs(generate, ["--n", "1"])).rejects.toThrow(
      "generate_image needs --prompt",
    );
  });

  test("refuses a scalar given twice and a flag given as a word", async () => {
    const generate = await tool("generate_image");
    await expect(parseToolArgs(generate, ["--n", "1", "--n", "2"])).rejects.toThrow(
      "--n is given twice",
    );
    await expect(parseToolArgs(generate, ["-x"])).rejects.toThrow("unknown flag -x");
  });

  test("gives words to the one required text, else prompt", async () => {
    const vision = await tool("analyze_image");
    const words = await parseToolArgs(vision, ["shot.png"]);
    expect(words.args).toEqual({ image: "shot.png" });
    const call = await parseToolArgs(vision, ["--image", "shot.png", "--prompt", "what is this"]);
    expect(call.args).toEqual({ image: "shot.png", prompt: "what is this" });
    await expect(parseToolArgs(vision, ["--image", "shot.png", "words"])).rejects.toThrow(
      "--image is given, and the words",
    );
    const convert = await tool("calc_convert");
    await expect(
      parseToolArgs(convert, ["--value", "1", "--from", "m", "--to", "km", "words"]),
    ).rejects.toThrow("calc_convert takes no words");
  });
});

describe("neox tool results", () => {
  test("saves an inline image into generated-images and names the file", async () => {
    const gateway = await fakeGateway();
    const { tools } = await listTools(gateway.target);
    const tool = tools.find((entry) => entry.name === "generate_image");
    if (tool === undefined) {
      throw new Error("missing generate_image");
    }
    const call = await parseToolArgs(tool, ["a red fox"]);
    const received = await callTool(gateway.target, tool, call.args);
    expect(received.isError).toBe(false);
    expect(answerText(received)).toBe("A red fox\n");

    const cwd = await mkdtemp(path.join(tmpdir(), "neolix-tool-"));
    const saved = await saveMade({
      target: gateway.target,
      cwd,
      answer: received,
      output: "",
      prompt: "a red fox",
      now: new Date(2026, 10, 6, 7, 8, 9),
    });
    expect(saved).toHaveLength(1);
    expect(path.dirname(saved[0] ?? "")).toBe(path.join(cwd, "generated-images"));
    expect(path.basename(saved[0] ?? "")).toBe("a-red-fox-20261106-070809.png");
    expect(await readFile(saved[0] ?? "")).toEqual(PNG);
  });

  test("honours -o as a folder, numbers n > 1 and never writes over", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "neolix-tool-out-"));
    const at = await targetPath({
      cwd,
      output: "out/",
      prompt: "icon",
      ext: ".png",
      index: 1,
      most: 2,
      now: new Date(2026, 10, 6, 7, 8, 9),
    });
    expect(at).toBe(path.join(cwd, "out", "icon-20261106-070809-2.png"));
    await expect(readdir(cwd)).resolves.toEqual([]);
  });

  test("keeps a name's image extension but gives an unknown one the real one", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "neolix-tool-name-"));
    const named = await targetPath({
      cwd,
      output: "hero.png",
      prompt: "icon",
      ext: ".jpg",
      index: 0,
      most: 1,
    });
    expect(path.basename(named)).toBe("hero.jpg");
    const versioned = await targetPath({
      cwd,
      output: "hero.v2",
      prompt: "icon",
      ext: ".png",
      index: 0,
      most: 1,
    });
    expect(path.basename(versioned)).toBe("hero.v2.png");
  });

  test("waits on a generation and asks again by id", async () => {
    const bodies: { name?: string; arguments?: Record<string, unknown> }[] = [];
    const server = createServer(pendingHandler(bodies));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    open.push(server);
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Expected a TCP address");
    }
    let time = 0;
    const receivedCall = await callTool(
      { base: `http://127.0.0.1:${address.port}` },
      {
        server: "image",
        path: "/mcp/myna/image",
        name: "generate_image",
        description: "",
        inputSchema: { properties: { prompt: { type: "string" } }, required: ["prompt"] },
      },
      { prompt: "a fox" },
      { now: () => (time += 1_000), sleep: () => Promise.resolve(), say: () => undefined },
    );
    expect(answerText(receivedCall)).toBe("made\n");
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toEqual({ name: "generation_result", arguments: { id: "g1" } });
  });
});
