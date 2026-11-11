// `GET /api/project-favicon?cwd=…&fallback=none`: the project glyph the desktop sidebar probes.
// Synara's server resolves a logo from the project folder; the bridge does the same, but only
// for folders the Neox project registry knows about, and it never follows a path out of that
// folder. Files are served with inert headers so repository-controlled bytes cannot execute.
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import * as path from "node:path";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { Effect } from "effect";

export const PROJECT_FAVICON_PATH = "/api/project-favicon";

const CACHE_CONTROL = "public, max-age=3600";
const MAX_FAVICON_BYTES = 2 * 1024 * 1024;
const SVG_SECURITY_HEADERS = {
  "Content-Security-Policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'",
  "X-Content-Type-Options": "nosniff",
} as const;

// Order matches Synara's resolver: a project-root logo, then framework conventions, then a
// nested web app's public folder. Only image files are ever read.
const FAVICON_CANDIDATES = [
  "favicon.svg",
  "favicon.ico",
  "favicon.png",
  "public/favicon.svg",
  "public/favicon.ico",
  "public/favicon.png",
  "app/favicon.ico",
  "app/favicon.png",
  "app/icon.svg",
  "app/icon.png",
  "app/icon.ico",
  "src/favicon.ico",
  "src/favicon.svg",
  "src/app/favicon.ico",
  "src/app/icon.svg",
  "src/app/icon.png",
  "assets/icon.svg",
  "assets/icon.png",
  "assets/logo.svg",
  "assets/logo.png",
  "apps/web/public/favicon.svg",
  "apps/web/public/favicon.ico",
  "apps/web/public/favicon.png",
  "web/public/favicon.svg",
  "web/public/favicon.ico",
  "web/public/favicon.png",
] as const;

const FALLBACK_FAVICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#6b728080" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" data-fallback="project-favicon"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2Z"/></svg>';

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

export interface ResolvedFavicon {
  readonly path: string;
  readonly contentType: string;
}

function contentTypeFor(filePath: string): string | null {
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? null;
}

/** True when `child` is `parent` or lives below it. Both must already be absolute/canonical. */
export function isContainedPath(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function hasTraversal(value: string): boolean {
  return value.split(/[\\/]+/).some((segment) => segment === "..");
}

/** Project roots the daemon has registered. Unreadable or malformed registries mean "none". */
export async function readProjectRoots(
  neolixHome = process.env.NEOLIX_HOME,
): Promise<readonly string[]> {
  if (!neolixHome) return [];
  try {
    const raw = await readFile(path.join(neolixHome, "projects", "projects.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry) =>
        entry &&
        typeof entry === "object" &&
        typeof (entry as { rootPath?: unknown }).rootPath === "string"
          ? ((entry as { rootPath: string }).rootPath as string)
          : null,
      )
      .filter((root): root is string => root !== null && path.isAbsolute(root));
  } catch {
    return [];
  }
}

async function canonical(directory: string): Promise<string | null> {
  try {
    return await realpath(directory);
  } catch {
    return null;
  }
}

async function findFile(base: string, relative: string): Promise<string | null> {
  if (hasTraversal(relative)) return null;
  const candidate = path.resolve(base, relative);
  if (!isContainedPath(base, candidate)) return null;
  if (!contentTypeFor(candidate)) return null;
  const canonicalPath = await canonical(candidate);
  if (!canonicalPath || !isContainedPath(base, canonicalPath)) return null;
  if (!contentTypeFor(canonicalPath)) return null;
  try {
    const info = await stat(canonicalPath);
    if (!info.isFile() || info.size > MAX_FAVICON_BYTES) return null;
  } catch {
    return null;
  }
  return canonicalPath;
}

async function findFirst(base: string, candidates: ReadonlyArray<string>): Promise<string | null> {
  for (const candidate of candidates) {
    const found = await findFile(base, candidate);
    if (found) return found;
  }
  return null;
}

/**
 * The project's own logo, or null. `cwd` must resolve inside one of `roots`; candidates are
 * canonicalized and re-checked so neither `..` nor a symlink can leave the project folder.
 */
export async function resolveProjectFavicon(
  cwd: string,
  roots: readonly string[],
): Promise<ResolvedFavicon | null> {
  if (!path.isAbsolute(cwd) || hasTraversal(cwd)) return null;
  const base = await canonical(cwd);
  if (!base) return null;

  let allowed = false;
  for (const root of roots) {
    const canonicalRoot = await canonical(root);
    if (canonicalRoot && isContainedPath(canonicalRoot, base)) {
      allowed = true;
      break;
    }
  }
  if (!allowed) return null;

  const direct = await findFirst(base, FAVICON_CANDIDATES);
  if (direct)
    return { path: direct, contentType: contentTypeFor(direct) ?? "application/octet-stream" };

  // Repositories that keep the web app one directory below the project root. Restrict the walk
  // to app-like folders so a sidebar refresh does not scan source trees or dependency folders.
  let children: string[] = [];
  try {
    children = await readdir(base);
  } catch {
    children = [];
  }
  const appFolders = children
    .filter((name) => !name.startsWith(".") && /(?:web|front|dash|app|client|site)/i.test(name))
    .sort()
    .slice(0, 16);
  for (const folder of appFolders) {
    const nested = await findFirst(
      base,
      ["favicon.svg", "favicon.ico", "favicon.png"].map((name) =>
        path.join(folder, "public", name),
      ),
    );
    if (nested) {
      return { path: nested, contentType: contentTypeFor(nested) ?? "application/octet-stream" };
    }
  }
  return null;
}

interface ProjectFaviconOptions {
  /** Overrides `NEOLIX_HOME`; tests point it at a fixture registry. */
  readonly neolixHome?: string;
}

export function makeProjectFaviconHandler(
  options: ProjectFaviconOptions = {},
): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  never,
  HttpServerRequest.HttpServerRequest
> {
  return Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (!url) return HttpServerResponse.text("Bad request", { status: 400 });
    const cwd = url.searchParams.get("cwd")?.trim() ?? "";
    if (!cwd) return HttpServerResponse.text("Missing cwd parameter", { status: 400 });

    const roots = yield* Effect.promise(() => readProjectRoots(options.neolixHome));
    const favicon = yield* Effect.promise(() => resolveProjectFavicon(cwd, roots));
    if (!favicon) {
      // The front end probes with `fallback=none` and renders its own folder glyph on an empty
      // answer; other callers get the same inert placeholder Synara serves.
      if (url.searchParams.get("fallback") === "none") {
        return HttpServerResponse.empty({
          status: 204,
          headers: { "Cache-Control": CACHE_CONTROL },
        });
      }
      return HttpServerResponse.text(FALLBACK_FAVICON_SVG, {
        status: 200,
        contentType: "image/svg+xml",
        headers: { "Cache-Control": CACHE_CONTROL, ...SVG_SECURITY_HEADERS },
      });
    }

    const bytes = yield* Effect.promise(() => readFile(favicon.path).catch(() => null));
    if (!bytes) {
      return HttpServerResponse.empty({ status: 404, headers: { "Cache-Control": CACHE_CONTROL } });
    }
    return HttpServerResponse.uint8Array(new Uint8Array(bytes), {
      status: 200,
      contentType: favicon.contentType,
      headers: { "Cache-Control": CACHE_CONTROL, ...SVG_SECURITY_HEADERS },
    });
  });
}
