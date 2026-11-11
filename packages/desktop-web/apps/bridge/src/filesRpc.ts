// Synara project-file RPCs backed by the Neox daemon's file explorer API.
//
// Every path is validated before it reaches the daemon: the request's cwd is the
// root, and the requested path may not escape it (`..` segments and absolute
// paths outside the root are rejected). The daemon enforces the same rule again
// after resolving symlinks, so this check is the cheap first line.
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  type ProjectCreateEntryInput,
  type ProjectDeleteEntryInput,
  type ProjectDownloadFileInput,
  type ProjectDuplicateEntryInput,
  type ProjectEntryMutationResult,
  type ProjectFileChangeEvent,
  type ProjectListDirectoriesInput,
  type ProjectReadFileInput,
  type ProjectRenameEntryInput,
  type ProjectSearchContentInput,
  type ProjectSearchEntriesInput,
  type ProjectSearchLocalEntriesInput,
  type ProjectWriteFileInput,
  PROJECT_DOWNLOAD_FILE_MAX_BYTES,
  PROJECT_SEARCH_CONTENT_MAX_LIMIT,
  PROJECT_SEARCH_CONTENT_MAX_LINE_LENGTH,
  PROJECT_SEARCH_CONTENT_MIN_QUERY_LENGTH,
  WS_METHODS,
  WsRpcError,
} from "@synara/contracts";
import { WORKSPACE_FILE_WRITE_CONFLICT_CODE } from "@synara/shared/workspaceFileWrite";
import { Effect, Queue, Stream } from "effect";

import type { BridgeModel } from "./model.ts";
import { bridgeError, fromPromise, rpcError } from "./rpcErrors.ts";
import type { AnyHandler } from "./stubs.ts";

const PATH_ESCAPE_CODE = "projects.path-outside-root";
const INVALID_NAME_CODE = "projects.invalid-name";
const REVISION_PATTERN = /^\d+:\d+:\d+:\d+$/;

function pathError(method: string, detail: string): WsRpcError {
  return new WsRpcError({
    message: `${method}: ${detail}`,
    code: PATH_ESCAPE_CODE,
    retryable: false,
  });
}

/**
 * Resolves `relativePath` under `cwd` and throws when the result leaves the
 * root. `..` is rejected syntactically too, so a path that normalizes back
 * inside cannot be used to probe siblings.
 */
export function resolveWithinRoot(cwd: string, relativePath: string): string {
  if (cwd.includes("\0") || relativePath.includes("\0")) {
    throw pathError("projects", "paths may not contain NUL bytes.");
  }
  if (!path.isAbsolute(cwd)) {
    throw pathError("projects", `"${cwd}" is not an absolute workspace root.`);
  }
  if (relativePath.split(/[\\/]/).includes("..")) {
    throw pathError("projects", `"${relativePath}" escapes the workspace root.`);
  }
  const root = path.resolve(cwd);
  const target = path.isAbsolute(relativePath)
    ? path.resolve(relativePath)
    : path.resolve(root, relativePath);
  if (
    target !== root &&
    !target.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`)
  ) {
    throw pathError("projects", `"${relativePath}" escapes the workspace root.`);
  }
  return target;
}

function nameError(method: string, detail: string): WsRpcError {
  return new WsRpcError({
    message: `${method}: ${detail}`,
    code: INVALID_NAME_CODE,
    retryable: false,
  });
}

/**
 * Explorer writes take a bare file/folder name, never a path: the daemon rejects
 * separators too, but rejecting them here keeps the request from reaching it.
 */
export function assertEntryName(method: string, rawName: string): string {
  const name = rawName.trim();
  if (!name || name === "." || name === "..") {
    throw nameError(method, "names may not be empty, '.' or '..'.");
  }
  if (name.includes("/") || name.includes("\\") || name.includes("\0")) {
    throw nameError(method, "names may not contain path separators.");
  }
  return name;
}

function parentOf(relativePath: string): string | undefined {
  const parent = path.posix.dirname(relativePath);
  return parent === "." || parent === "" ? undefined : parent;
}

export interface DecodedTextFile {
  readonly contents: string;
  readonly encoding: "utf8" | "utf8-bom";
}

/** Decodes editor text and reports whether the on-disk bytes carried a BOM. */
export function decodeTextFile(bytes: Uint8Array): DecodedTextFile {
  // `ignoreBOM: true` keeps the marker in the string; the default strips it and
  // would make the encoding impossible to describe to the editor.
  const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
  if (text.charCodeAt(0) === 0xfeff) {
    return { contents: text.slice(1), encoding: "utf8-bom" };
  }
  return { contents: text, encoding: "utf8" };
}

/** Classifies the dominant line ending; mixed files must stay read-only. */
export function detectLineEnding(contents: string): "lf" | "crlf" | "cr" | "mixed" {
  let crlf = 0;
  let lf = 0;
  let cr = 0;
  for (let index = 0; index < contents.length; index += 1) {
    const code = contents.charCodeAt(index);
    if (code === 13) {
      if (contents.charCodeAt(index + 1) === 10) {
        crlf += 1;
        index += 1;
      } else {
        cr += 1;
      }
    } else if (code === 10) {
      lf += 1;
    }
  }
  const present = [crlf > 0, lf > 0, cr > 0].filter(Boolean).length;
  if (present > 1) return "mixed";
  if (crlf > 0) return "crlf";
  if (cr > 0) return "cr";
  return "lf";
}

/** Re-encodes editor contents into the requested BOM and line-ending form. */
export function encodeTextFile(
  contents: string,
  encoding: "utf8" | "utf8-bom",
  lineEnding: "lf" | "crlf" | "cr" | "mixed",
): string {
  const withoutBom = contents.charCodeAt(0) === 0xfeff ? contents.slice(1) : contents;
  const normalizedEndings =
    lineEnding === "mixed"
      ? withoutBom
      : withoutBom.replace(
          /\r\n|\r|\n/g,
          lineEnding === "crlf" ? "\r\n" : lineEnding === "cr" ? "\r" : "\n",
        );
  return encoding === "utf8-bom" ? `﻿${normalizedEndings}` : normalizedEndings;
}

/**
 * Synara's write RPC carries one opaque `expectedVersion`; the daemon's guard
 * takes either an mtime or its revision string. Reads return the revision when
 * present, so a revision-shaped version is compared as a revision.
 */
function expectedGuard(version: string | null | undefined): {
  expectedModifiedAt: string;
  expectedRevision?: string;
} {
  if (version && REVISION_PATTERN.test(version)) {
    return { expectedModifiedAt: new Date(0).toISOString(), expectedRevision: version };
  }
  return { expectedModifiedAt: version ?? new Date(0).toISOString() };
}

function resultVersion(file: { modifiedAt: string; revision?: string }): string {
  return file.revision ?? file.modifiedAt;
}

function fromSubscription<A>(subscribe: (emit: (item: A) => void) => () => void): Stream.Stream<A> {
  return Stream.callback<A>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => subscribe((item) => Queue.offerUnsafe(queue, item))),
      (unsubscribe) => Effect.sync(unsubscribe),
    ),
  );
}

/** Directories a code search never enters: VCS data, dependencies, build output. */
const SEARCH_SKIP_DIRECTORIES = new Set([
  ".git",
  ".svn",
  ".hg",
  "node_modules",
  "bower_components",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  "dist",
  "build",
  "target",
  "vendor",
  ".venv",
  "venv",
  "__pycache__",
]);

/** debt: a linear walk with fixed caps. A repo big enough to hit them needs real gitignore
 *  awareness and an incremental index; until then a truncated result is honest. */
const SEARCH_MAX_VISITED_FILES = 4000;
const SEARCH_MAX_FILE_BYTES = 256 * 1024;

async function searchContentWithinRoot(input: {
  cwd: string;
  query: string;
  limit: number;
}): Promise<{
  matches: Array<{ path: string; lineNumber: number; lineText: string }>;
  truncated: boolean;
}> {
  const root = await fs.realpath(input.cwd);
  const needle = input.query.toLowerCase();
  const matches: Array<{ path: string; lineNumber: number; lineText: string }> = [];
  let visitedFiles = 0;
  let truncated = false;

  const walk = async (directory: string): Promise<void> => {
    if (truncated) return;
    let entries: Array<Dirent>;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (truncated) return;
      // Symlinks are skipped: resolving one could leave the workspace root, and the
      // daemon's file APIs refuse those paths too.
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (SEARCH_SKIP_DIRECTORIES.has(entry.name)) continue;
        await walk(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      visitedFiles += 1;
      if (visitedFiles > SEARCH_MAX_VISITED_FILES) {
        truncated = true;
        return;
      }
      let size: number;
      try {
        size = (await fs.stat(absolute)).size;
      } catch {
        continue;
      }
      if (size > SEARCH_MAX_FILE_BYTES) continue;
      let text: string;
      try {
        text = await fs.readFile(absolute, "utf8");
      } catch {
        continue;
      }
      // A NUL byte in text mode means the file is binary, not source.
      if (text.includes("\0")) continue;
      const lines = text.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]!;
        if (!line.toLowerCase().includes(needle)) continue;
        matches.push({
          path: path.relative(root, absolute).split(path.sep).join("/"),
          lineNumber: index + 1,
          lineText:
            line.length > PROJECT_SEARCH_CONTENT_MAX_LINE_LENGTH
              ? line.slice(0, PROJECT_SEARCH_CONTENT_MAX_LINE_LENGTH)
              : line,
        });
        if (matches.length >= input.limit) {
          truncated = true;
          return;
        }
      }
    }
  };

  await walk(root);
  return { matches, truncated };
}

export function makeFileHandlers(model: BridgeModel): Record<string, AnyHandler> {
  const client = model.client;

  return {
    [WS_METHODS.projectsReadFile]: (payload) =>
      fromPromise("projects.readFile", async () => {
        const input = payload as ProjectReadFileInput;
        resolveWithinRoot(input.cwd, input.relativePath);
        const file = await client.readFile(
          input.cwd,
          input.relativePath,
          undefined,
          input.maxBytes,
        );
        const decoded = decodeTextFile(file.bytes);
        return {
          // Absolute inputs were explicitly requested (local preview) and keep
          // their absolute form; workspace reads report the daemon's resolved path.
          relativePath: path.isAbsolute(input.relativePath)
            ? input.relativePath
            : file.path || input.relativePath,
          contents: decoded.contents,
          truncated: file.bytes.byteLength < file.size,
          version: resultVersion(file),
          encoding: decoded.encoding,
          lineEnding: detectLineEnding(decoded.contents),
        };
      }),

    [WS_METHODS.projectsDownloadFile]: (payload) =>
      fromPromise("projects.downloadFile", async () => {
        const input = payload as ProjectDownloadFileInput;
        resolveWithinRoot(input.cwd, input.relativePath);
        let file: Awaited<ReturnType<typeof client.readFile>>;
        try {
          file = await client.readFile(
            input.cwd,
            input.relativePath,
            undefined,
            PROJECT_DOWNLOAD_FILE_MAX_BYTES,
          );
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause);
          if (/too large/i.test(message)) {
            throw bridgeError(
              "file.download-too-large",
              `This file is larger than ${Math.round(PROJECT_DOWNLOAD_FILE_MAX_BYTES / 1_000_000)} MB and cannot be downloaded here.`,
              { size: Math.round(PROJECT_DOWNLOAD_FILE_MAX_BYTES / 1_000_000) },
            );
          }
          throw cause;
        }
        return {
          relativePath: input.relativePath,
          fileName: path.posix.basename(file.path || input.relativePath) || input.relativePath,
          mimeType: file.mime || "application/octet-stream",
          size: file.size,
          // debt: one JSON frame carries the whole file; stream chunks when downloads grow.
          bytesBase64: Buffer.from(file.bytes).toString("base64"),
        };
      }),

    [WS_METHODS.projectsWriteFile]: (payload) =>
      fromPromise("projects.writeFile", async () => {
        const input = payload as ProjectWriteFileInput;
        resolveWithinRoot(input.cwd, input.relativePath);
        let guard = expectedGuard(input.expectedVersion);
        if (!input.expectedVersion) {
          // No guard was carried: read the current version so the daemon still
          // rejects a write that raced with another writer.
          const current = await client.readFile(input.cwd, input.relativePath);
          guard = {
            expectedModifiedAt: current.modifiedAt,
            ...(current.revision ? { expectedRevision: current.revision } : {}),
          };
        }
        const content = encodeTextFile(
          input.contents,
          input.encoding ?? "utf8",
          input.lineEnding ?? "lf",
        );
        const result = await client.writeFile({
          cwd: input.cwd,
          path: input.relativePath,
          content,
          contentEncoding: "utf-8",
          expectedModifiedAt: guard.expectedModifiedAt,
          ...(guard.expectedRevision ? { expectedRevision: guard.expectedRevision } : {}),
        });
        if (result.status === "conflict") {
          throw new WsRpcError({
            message: "projects.writeFile failed: the file changed on disk.",
            code: WORKSPACE_FILE_WRITE_CONFLICT_CODE,
            retryable: false,
          });
        }
        if (result.status === "error") {
          throw bridgeError("file.write-failed", result.error, { detail: result.error });
        }
        return {
          relativePath: input.relativePath,
          version: result.revision ?? result.modifiedAt,
        };
      }),

    [WS_METHODS.projectsCreateEntry]: (payload) =>
      fromPromise("projects.createEntry", async () => {
        const input = payload as ProjectCreateEntryInput;
        const parentPath = input.parentPath?.trim() || ".";
        resolveWithinRoot(input.cwd, parentPath);
        const name = assertEntryName("projects.createEntry", input.name);
        // The daemon enforces the same root scoping after resolving symlinks.
        const result = await client.createFileEntry({
          cwd: input.cwd,
          parentPath,
          name,
          kind: input.kind,
        });
        if (!result.success || !result.path) {
          throw bridgeError(
            "file.create-failed",
            result.error ?? "the entry could not be created.",
            result.error ? { detail: result.error } : undefined,
          );
        }
        return { relativePath: result.path } satisfies ProjectEntryMutationResult;
      }),

    [WS_METHODS.projectsRenameEntry]: (payload) =>
      fromPromise("projects.renameEntry", async () => {
        const input = payload as ProjectRenameEntryInput;
        resolveWithinRoot(input.cwd, input.relativePath);
        const name = assertEntryName("projects.renameEntry", input.name);
        const result = await client.renameFileEntry({
          cwd: input.cwd,
          path: input.relativePath,
          name,
        });
        if (!result.success || !result.renamedPath) {
          throw bridgeError(
            "file.rename-failed",
            result.error ?? "the entry could not be renamed.",
            result.error ? { detail: result.error } : undefined,
          );
        }
        return { relativePath: result.renamedPath } satisfies ProjectEntryMutationResult;
      }),

    [WS_METHODS.projectsDuplicateEntry]: (payload) =>
      fromPromise("projects.duplicateEntry", async () => {
        const input = payload as ProjectDuplicateEntryInput;
        resolveWithinRoot(input.cwd, input.relativePath);
        const result = await client.duplicateFileEntry({
          cwd: input.cwd,
          path: input.relativePath,
        });
        if (!result.success || !result.duplicatedPath) {
          throw bridgeError(
            "file.duplicate-failed",
            result.error ?? "the entry could not be duplicated.",
            result.error ? { detail: result.error } : undefined,
          );
        }
        return { relativePath: result.duplicatedPath } satisfies ProjectEntryMutationResult;
      }),

    [WS_METHODS.projectsDeleteEntry]: (payload) =>
      fromPromise("projects.deleteEntry", async () => {
        const input = payload as ProjectDeleteEntryInput;
        resolveWithinRoot(input.cwd, input.relativePath);
        const result = await client.deleteFileEntry({
          cwd: input.cwd,
          path: input.relativePath,
        });
        if (!result.success) {
          throw bridgeError(
            "file.delete-failed",
            result.error ?? "the entry could not be deleted.",
            result.error ? { detail: result.error } : undefined,
          );
        }
        return { relativePath: input.relativePath } satisfies ProjectEntryMutationResult;
      }),

    [WS_METHODS.projectsListDirectories]: (payload) =>
      fromPromise("projects.listDirectories", async () => {
        const input = payload as ProjectListDirectoriesInput;
        const relativePath = input.relativePath?.trim() || ".";
        resolveWithinRoot(input.cwd, relativePath);
        const directory = await client.listDirectory(input.cwd, relativePath);
        return {
          entries: directory.entries
            .filter((entry) => (input.includeFiles ?? true) || entry.kind === "directory")
            .map((entry) => ({
              path: entry.path,
              name: entry.name,
              kind: entry.kind,
              modifiedAt: entry.modifiedAt,
              size: entry.size,
              ...(parentOf(entry.path) ? { parentPath: parentOf(entry.path) } : {}),
            })),
        };
      }),

    [WS_METHODS.projectsSearchEntries]: (payload) =>
      fromPromise("projects.searchEntries", async () => {
        const input = payload as ProjectSearchEntriesInput;
        resolveWithinRoot(input.cwd, ".");
        const response = await client.getDirectorySuggestions({
          query: input.query,
          cwd: input.cwd,
          limit: input.limit,
          matchMode: "fuzzy",
          includeFiles: input.kind !== "directory",
          includeDirectories: input.kind !== "file",
        });
        if (response.error) {
          throw bridgeError("file.search-failed", response.error, { detail: response.error });
        }
        const raw =
          response.entries.length > 0
            ? response.entries
            : response.directories.map((entryPath) => ({
                path: entryPath,
                kind: "directory" as const,
              }));
        const entries = raw
          .filter((entry) => !input.kind || entry.kind === input.kind)
          .slice(0, input.limit);
        return {
          entries: entries.map((entry) => ({
            path: entry.path,
            kind: entry.kind,
            ...(parentOf(entry.path) ? { parentPath: parentOf(entry.path) } : {}),
          })),
          truncated: raw.length >= input.limit,
        };
      }),

    [WS_METHODS.projectsSearchLocalEntries]: (payload) =>
      fromPromise("projects.searchLocalEntries", async () => {
        const input = payload as ProjectSearchLocalEntriesInput;
        resolveWithinRoot(input.rootPath, ".");
        const limit = input.limit ?? 100;
        const response = await client.getDirectorySuggestions({
          query: input.query,
          cwd: input.rootPath,
          limit,
          matchMode: "fuzzy",
          includeFiles: input.includeFiles ?? true,
          includeDirectories: true,
        });
        if (response.error) {
          throw bridgeError("file.search-failed", response.error, { detail: response.error });
        }
        const entries = response.entries.slice(0, limit);
        return {
          entries: entries.map((entry) => ({
            path: entry.path,
            name: path.posix.basename(entry.path) || entry.path,
            kind: entry.kind,
            ...(parentOf(entry.path) ? { parentPath: parentOf(entry.path) } : {}),
          })),
          truncated: response.entries.length >= limit,
        };
      }),

    [WS_METHODS.projectsSearchContent]: (payload) =>
      fromPromise("projects.searchContent", async () => {
        const input = payload as ProjectSearchContentInput;
        // The contract validates these too; repeat them here so the bridge stays
        // safe if a caller bypasses the schema.
        const query = input.query.trim();
        if (query.length < PROJECT_SEARCH_CONTENT_MIN_QUERY_LENGTH) {
          throw bridgeError(
            "file.search-query-too-short",
            `Search needs at least ${PROJECT_SEARCH_CONTENT_MIN_QUERY_LENGTH} characters.`,
            { count: PROJECT_SEARCH_CONTENT_MIN_QUERY_LENGTH },
          );
        }
        if (query.length > 256) {
          throw bridgeError(
            "file.search-query-too-long",
            "Search queries may not exceed 256 characters.",
            { count: 256 },
          );
        }
        resolveWithinRoot(input.cwd, ".");
        const limit = Math.min(Math.max(1, input.limit ?? 50), PROJECT_SEARCH_CONTENT_MAX_LIMIT);
        return searchContentWithinRoot({ cwd: input.cwd, query, limit });
      }),

    [WS_METHODS.projectsPrewarmSearchIndex]: (payload) => {
      // The daemon has no content index; the bridge searches on demand. Answering
      // immediately keeps the palette's fire-and-forget warm-up from failing.
      const input = payload as { cwd: string };
      resolveWithinRoot(input.cwd, ".");
      return Effect.succeed({ started: false });
    },

    [WS_METHODS.projectsSubscribeFileChange]: (payload) => {
      const input = payload as { cwd: string; relativePath: string };
      try {
        resolveWithinRoot(input.cwd, input.relativePath);
      } catch (cause) {
        return Stream.fail(cause instanceof WsRpcError ? cause : rpcError(cause));
      }
      return fromSubscription<ProjectFileChangeEvent>((emit) => {
        const subscription = client.observeFile({
          cwd: input.cwd,
          path: input.relativePath,
        });
        const unsubscribe = subscription.subscribe({
          // The initial version mirrors what the caller just read; only later
          // updates are changes worth telling the editor about.
          snapshot: () => {},
          update: (message) => {
            if (message.type !== "fs.file.update") return;
            const version = message.payload.version;
            if (version.status === "ready") {
              emit({
                type: "changed",
                relativePath: version.path || input.relativePath,
                mtimeMs: Date.parse(version.modifiedAt),
              });
            } else if (version.status === "missing") {
              emit({ type: "deleted", relativePath: input.relativePath });
            }
          },
          error: () => {},
        });
        return () => {
          unsubscribe();
          void subscription.release();
        };
      });
    },
  };
}
