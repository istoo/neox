// FILE: projectIcons.logic.ts
// Purpose: Pure helpers for the daemon-backed project icon: data-URI rendering,
//   selecting an image file, and acquiring an image from a website the same way
//   the native app does (page HTML → declared icons → /favicon.ico).
// Layer: Web project icon logic

import type { ProjectIcon } from "@synara/contracts";

export const MAX_PROJECT_ICON_BYTES = 512 * 1024;
const MAX_HTML_BYTES = 512 * 1024;
const MAX_ICON_CANDIDATES = 8;

export function projectIconDataUri(icon: ProjectIcon | null | undefined): string | null {
  if (!icon) return null;
  return `data:${icon.mimeType};base64,${icon.data}`;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

function parseHttpUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Enter a valid website or image URL");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("URL must use HTTP or HTTPS without credentials");
  }
  return url;
}

async function readBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error("Icon must be 512 KB or smaller");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > maxBytes) throw new Error("Icon must be 512 KB or smaller");
  return bytes;
}

function parseTagAttribute(tag: string, name: string): string | null {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, "i"));
  return match?.[1]?.trim() || null;
}

function iconCandidates(html: string, pageUrl: URL): URL[] {
  const candidates: URL[] = [];
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const rel = parseTagAttribute(tag, "rel")?.toLowerCase() ?? "";
    const href = parseTagAttribute(tag, "href");
    const type = parseTagAttribute(tag, "type")?.toLowerCase() ?? "";
    if (!href || !rel.includes("icon") || type.includes("svg") || href.endsWith(".svg")) continue;
    try {
      candidates.push(new URL(href, pageUrl));
    } catch {
      // Try the next declared icon and then the conventional fallback.
    }
  }
  candidates.push(new URL("/favicon.ico", pageUrl));
  return candidates.slice(0, MAX_ICON_CANDIDATES);
}

type FetchIcon = (input: string | URL) => Promise<Response>;

async function fetchOk(fetchIcon: FetchIcon, url: URL): Promise<Response> {
  const response = await fetchIcon(url);
  if (!response.ok) throw new Error(`Download failed (${response.status})`);
  return response;
}

/**
 * Turns an image URL into the daemon's upload payload. HTML pages are reduced
 * to their declared icon; anything else must already be the image.
 */
export async function importProjectIconFromUrl(
  value: string,
  fetchIcon: FetchIcon = (input) => fetch(input),
): Promise<string> {
  const url = parseHttpUrl(value.trim());
  const response = await fetchOk(fetchIcon, url);
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";

  if (!contentType.includes("text/html")) {
    return bytesToBase64(await readBytes(response, MAX_PROJECT_ICON_BYTES));
  }

  const html = new TextDecoder().decode(await readBytes(response, MAX_HTML_BYTES));
  let lastError: unknown = new Error("Website does not expose a supported icon");
  for (const candidate of iconCandidates(html, url)) {
    try {
      const iconResponse = await fetchOk(fetchIcon, candidate);
      return bytesToBase64(await readBytes(iconResponse, MAX_PROJECT_ICON_BYTES));
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

/** Reads a picked file into the same base64 payload. */
export async function projectIconFromFile(file: File): Promise<string> {
  if (file.size > MAX_PROJECT_ICON_BYTES) throw new Error("Icon must be 512 KB or smaller");
  return bytesToBase64(new Uint8Array(await file.arrayBuffer()));
}
