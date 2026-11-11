import { createInterface } from "node:readline";
import { saveGeneratedFiles } from "./files.js";
import { postToGateway, type GatewayTarget } from "./gateway.js";

/**
 * `neolix mcp <name>`: an MCP server on stdio, for an agent that starts its
 * MCP servers as commands (myna internal/browsermcp/browsermcp.go). Each
 * message is passed to the daemon's gateway `/mcp/<name>` and its answer
 * written back; the agent reaches Neolix's browser, search, vision and image
 * servers exactly as one that speaks HTTP does.
 *
 * A generation's files are saved into the project the bridge runs in, as
 * myna's image MCP saves them (files.ts).
 */

export interface BridgeIo {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  error: NodeJS.WritableStream;
  /** The project a generated image is saved under; defaults to cwd. */
  cwd?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageId(value: unknown): unknown {
  if (Array.isArray(value)) {
    const first = value.find((entry) => isRecord(entry) && entry.id !== undefined);
    return isRecord(first) ? first.id : null;
  }
  return isRecord(value) && value.id !== undefined ? value.id : null;
}

function errorAnswer(id: unknown, message: string): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code: -32603, message },
  };
}

function promptOf(value: unknown): string {
  if (!isRecord(value) || !isRecord(value.params)) {
    return "";
  }
  const args = isRecord(value.params.arguments) ? value.params.arguments : {};
  return typeof args.prompt === "string" ? args.prompt : "";
}

export async function runMcpBridge(
  name: string,
  target: GatewayTarget,
  io: BridgeIo,
): Promise<void> {
  const cwd = io.cwd ?? process.cwd();
  // A generation answers with a small file inline and a large one by URL;
  // the prompt names the file, and a job's result names no prompt, so the
  // request is remembered by id.
  const prompts = new Map<string, string>();
  const lines = createInterface({ input: io.input, crlfDelay: Number.POSITIVE_INFINITY });

  for await (const raw of lines) {
    await handleLine({ name, target, io, cwd, prompts, raw });
  }
}

async function handleLine(input: {
  name: string;
  target: GatewayTarget;
  io: BridgeIo;
  cwd: string;
  prompts: Map<string, string>;
  raw: string;
}): Promise<void> {
  const { name, target, io, cwd, prompts } = input;
  const line = input.raw.trim();
  if (line.length === 0) {
    return;
  }
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch (error) {
    io.output.write(`${JSON.stringify(errorAnswer(null, `This isn't JSON: ${String(error)}`))}\n`);
    return;
  }
  const entries = Array.isArray(message) ? message : [message];
  for (const entry of entries) {
    if (isRecord(entry) && entry.id !== undefined && entry.method === "tools/call") {
      prompts.set(JSON.stringify(entry.id), promptOf(entry));
    }
  }
  const video =
    name === "image" &&
    entries.some(
      (entry) =>
        isRecord(entry) &&
        entry.method === "tools/call" &&
        isRecord(entry.params) &&
        entry.params.name === "generate_video",
    );

  let answer: Awaited<ReturnType<typeof postToGateway>>;
  try {
    answer = await postToGateway(target, name, line);
  } catch (error) {
    io.output.write(
      `${JSON.stringify(
        errorAnswer(messageId(message), `Neox's daemon is unreachable: ${String(error)}`),
      )}\n`,
    );
    return;
  }
  if (answer.status === 202 || answer.status === 204 || answer.body.trim() === "") {
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(answer.body);
  } catch {
    const text = answer.body.trim() || `The gateway answered ${answer.status}`;
    io.output.write(`${JSON.stringify(errorAnswer(messageId(message), text))}\n`);
    return;
  }
  if (name === "image" && answer.status >= 200 && answer.status < 300) {
    try {
      await saveGeneratedFiles({
        target,
        cwd,
        body: parsed,
        promptFor: (id) => prompts.get(JSON.stringify(id)) ?? "",
        video,
      });
    } catch (error) {
      io.error.write(`neox mcp image: cannot save the generation: ${String(error)}\n`);
    }
  }
  io.output.write(`${JSON.stringify(parsed)}\n`);
}
