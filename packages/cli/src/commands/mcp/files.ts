import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { GatewayTarget } from "./gateway.js";
import { getFromGateway } from "./gateway.js";

/**
 * Where a generation goes, as myna's image MCP saves it
 * (myna internal/imagemcp/imagemcp.go:717): under the project the agent
 * works in, in generated-images/ or generated-videos/, named from the
 * prompt and the time, never over a file already there.
 */

const IMAGE_EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/avif": ".avif",
};

const VIDEO_EXT: Record<string, string> = {
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/quicktime": ".mov",
};

export interface MadeFile {
  path: string;
  url?: string;
}

function extension(mime: string, video: boolean): string {
  return (video ? VIDEO_EXT[mime] : IMAGE_EXT[mime]) ?? (video ? ".mp4" : ".png");
}

function slug(prompt: string): string {
  const text = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return text === "" ? "image" : text;
}

function stamp(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(
    now.getHours(),
  )}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

async function freePath(directory: string, base: string, ext: string): Promise<string> {
  const first = path.join(directory, `${base}${ext}`);
  try {
    await stat(first);
  } catch {
    return first;
  }
  for (let index = 2; ; index++) {
    const candidate = path.join(directory, `${base}-${index}${ext}`);
    try {
      await stat(candidate);
    } catch {
      return candidate;
    }
  }
}

/** Writes one file made by the image MCP into the project. */
export async function saveMadeFile(input: {
  cwd: string;
  prompt: string;
  bytes: Buffer;
  mime: string;
  index: number;
  most: number;
  video: boolean;
  now?: Date;
}): Promise<string> {
  const video = input.video || input.mime.startsWith("video/");
  const directory = path.join(input.cwd, video ? "generated-videos" : "generated-images");
  await mkdir(directory, { recursive: true, mode: 0o755 });
  const base = `${slug(input.prompt)}-${stamp(input.now ?? new Date())}${
    input.most > 1 ? `-${input.index + 1}` : ""
  }`;
  const file = await freePath(directory, base, extension(input.mime, video));
  await writeFile(file, input.bytes);
  return file;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function gatewayFileUrl(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /(https?:\/\/\S+\/mcp\/myna\/image\/files\/\S+)/.exec(line);
    if (match?.[1]) {
      out.push(match[1]);
    }
  }
  return out;
}

/**
 * Saves what an image MCP call made into the project, and adds a line
 * naming each file to the answer, as myna's server answers with the path.
 * Only this daemon's own file URLs are fetched; a vendor's stays a link.
 */
export async function saveGeneratedFiles(input: {
  target: GatewayTarget;
  cwd: string;
  body: unknown;
  promptFor: (id: unknown) => string;
  video: boolean;
  now?: Date;
}): Promise<MadeFile[]> {
  const messages = Array.isArray(input.body) ? input.body : [input.body];
  const made: MadeFile[] = [];
  for (const message of messages) {
    if (!record(message) || !record(message.result) || !Array.isArray(message.result.content)) {
      continue;
    }
    const prompt = input.promptFor(message.id);
    const content = message.result.content as unknown[];
    const files = content.filter(
      (item): item is Record<string, unknown> =>
        record(item) && item.type === "image" && typeof item.data === "string",
    );
    const saved: string[] = [];
    for (const [index, item] of files.entries()) {
      const mime = typeof item.mimeType === "string" ? item.mimeType : "image/png";
      const file = await saveMadeFile({
        cwd: input.cwd,
        prompt,
        bytes: Buffer.from(item.data as string, "base64"),
        mime,
        index,
        most: files.length,
        video: input.video,
        ...(input.now ? { now: input.now } : {}),
      });
      saved.push(file);
      made.push({ path: file });
    }
    if (saved.length === 0) {
      // A file too large to inline: the answer gives its gateway URL.
      const urls = [
        ...new Set(
          content.flatMap((item) =>
            record(item) && item.type === "text" && typeof item.text === "string"
              ? gatewayFileUrl(item.text)
              : [],
          ),
        ),
      ];
      for (const [index, url] of urls.entries()) {
        try {
          const answer = await getFromGateway(input.target, url);
          const mime = answer.contentType?.split(";")[0]?.trim() ?? "image/png";
          const file = await saveMadeFile({
            cwd: input.cwd,
            prompt,
            bytes: answer.bytes,
            mime,
            index,
            most: urls.length,
            video: input.video,
            ...(input.now ? { now: input.now } : {}),
          });
          saved.push(file);
          made.push({ path: file, url });
        } catch {
          // the link in the answer still reaches it
        }
      }
    }
    if (saved.length > 0) {
      content.push({ type: "text", text: saved.map((file) => `Saved to ${file}`).join("\n") });
    }
  }
  return made;
}
