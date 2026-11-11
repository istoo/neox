import { promises as fs } from "node:fs";
import path from "node:path";

export interface StaticAsset {
  readonly filePath: string;
  /** `spa` also means "serve this when the route has no matching file". */
  readonly kind: "file" | "spa";
}

export interface ResolveStaticAssetInput {
  readonly webDistDir: string;
  /** `URL.pathname` from the request, already percent-encoded. */
  readonly pathname: string;
}

const ASSET_DIRECTORY = /\/assets\//;
const HAS_EXTENSION = /\.[A-Za-z0-9]+$/;

function decodePathname(pathname: string): string | null {
  try {
    const decoded = decodeURIComponent(pathname);
    // NUL bytes truncate paths in native APIs; reject them before any filesystem call.
    return decoded.includes("\u0000") ? null : decoded;
  } catch {
    return null;
  }
}

function isInsideRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative.length === 0 || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function isFile(candidate: string): Promise<boolean> {
  try {
    return (await fs.stat(candidate)).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve a request to a file in the built web app. Paths never escape
 * `webDistDir`; requests for a route without an extension fall back to
 * `index.html`, while a missing asset (a path with an extension) returns null
 * so the caller can answer 404 instead of the SPA shell.
 */
export async function resolveStaticAsset(
  input: ResolveStaticAssetInput,
): Promise<StaticAsset | null> {
  const root = path.resolve(input.webDistDir);
  const decoded = decodePathname(input.pathname);
  if (decoded === null) {
    return null;
  }

  const relativePath = decoded.replace(/^\/+/, "");
  const candidate = path.resolve(root, relativePath);
  if (!isInsideRoot(root, candidate)) {
    return null;
  }

  if (await isFile(candidate)) {
    return { filePath: candidate, kind: "file" };
  }

  if (HAS_EXTENSION.test(relativePath)) {
    return null;
  }

  const index = path.join(root, "index.html");
  return (await isFile(index)) ? { filePath: index, kind: "spa" } : null;
}

/** Hashed Vite output is immutable; the HTML shell and public files are not. */
export function staticCacheControl(asset: StaticAsset, pathname: string): string {
  if (asset.kind === "spa" || pathname.endsWith(".html")) {
    return "no-store";
  }
  if (ASSET_DIRECTORY.test(`/${pathname.replace(/^\/+/, "")}`)) {
    return "public, max-age=31536000, immutable";
  }
  return "no-cache";
}

/**
 * The app shell renders agent output (Markdown, HTML previews, tool results), so scripts are
 * limited to the bridge's own bundle: no inline or injected script, no `eval`. Workers come
 * from the bundle or a `blob:` the bundle created (Monaco, pdf.js); `wasm-unsafe-eval` lets the
 * syntax highlighter compile its grammar engine. Styles, images, fonts and connections are left
 * open because the transcript shows remote images and the shell loads web fonts.
 *
 * msgpackr probes `Function("")` once at load and falls back to its interpreter when it throws,
 * so each page load logs one expected `script-src` eval violation from that probe.
 */
export const APP_SHELL_CSP = [
  "script-src 'self' 'wasm-unsafe-eval' blob:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
].join("; ");

/** Headers for a static response; HTML documents also carry the shell's CSP. */
export function staticResponseHeaders(
  asset: StaticAsset,
  pathname: string,
): Record<string, string> {
  const cacheControl = staticCacheControl(asset, pathname);
  return asset.kind === "spa" || asset.filePath.endsWith(".html")
    ? { "Cache-Control": cacheControl, "Content-Security-Policy": APP_SHELL_CSP }
    : { "Cache-Control": cacheControl };
}
