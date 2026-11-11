import {
  ProjectEntryMutationResult,
  ProjectDownloadFileResult,
  ProjectFileChangeEvent,
  ProjectListDirectoriesResult,
  ProjectReadFileResult,
  ProjectSearchContentResult,
  ProjectSearchEntriesResult,
  ProjectSearchLocalEntriesResult,
  ProjectWriteFileResult,
  WS_METHODS,
  WsRpcError,
} from "@synara/contracts";
import { Effect, Schema, Stream } from "effect";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { BridgeModel } from "./model.ts";
import {
  assertEntryName,
  decodeTextFile,
  detectLineEnding,
  encodeTextFile,
  makeFileHandlers,
  resolveWithinRoot,
} from "./filesRpc.ts";
import type { AnyHandler } from "./stubs.ts";

const AT = "2026-11-08T00:00:00.000Z";

const encode = <S extends Schema.Top>(schema: S, value: unknown) =>
  Schema.encodeUnknownSync(schema as never)(value);

function run<A>(handler: AnyHandler | undefined, payload: unknown): Promise<A> {
  if (!handler) throw new Error("handler is missing");
  return Effect.runPromise(handler(payload, {}) as Effect.Effect<A, WsRpcError>);
}

function makeFiles(fake: Record<string, unknown>) {
  const model = { client: fake } as unknown as BridgeModel;
  return makeFileHandlers(model);
}

describe("filesRpc path guards", () => {
  it("resolves nested relative paths under the workspace root", () => {
    expect(resolveWithinRoot("/repo", "src/main.ts")).toBe("/repo/src/main.ts");
    expect(resolveWithinRoot("/repo", ".")).toBe("/repo");
  });

  it("rejects parent traversal and absolute paths outside the root", () => {
    expect(() => resolveWithinRoot("/repo", "../etc/passwd")).toThrow(WsRpcError);
    expect(() => resolveWithinRoot("/repo", "/etc/passwd")).toThrow(WsRpcError);
    expect(() => resolveWithinRoot("/repo", "src/../../etc/passwd")).toThrow(WsRpcError);
    expect(() => resolveWithinRoot("relative/root", "a.txt")).toThrow(WsRpcError);
  });

  it("allows the explicit whole-filesystem root used by local previews", () => {
    expect(resolveWithinRoot("/", "/Users/me/notes.md")).toBe("/Users/me/notes.md");
  });
});

describe("filesRpc text codec", () => {
  it("strips a UTF-8 BOM and reports it", () => {
    const decoded = decodeTextFile(new TextEncoder().encode("﻿hello\r\nworld\r\n"));
    expect(decoded).toEqual({ contents: "hello\r\nworld\r\n", encoding: "utf8-bom" });
    expect(detectLineEnding(decoded.contents)).toBe("crlf");
  });

  it("classifies line endings", () => {
    expect(detectLineEnding("a\nb\n")).toBe("lf");
    expect(detectLineEnding("a\r\nb\r\n")).toBe("crlf");
    expect(detectLineEnding("a\rb\r")).toBe("cr");
    expect(detectLineEnding("a\nb\r\n")).toBe("mixed");
    expect(detectLineEnding("no newline")).toBe("lf");
  });

  it("re-encodes contents with the requested BOM and line ending", () => {
    expect(encodeTextFile("a\nb\n", "utf8", "crlf")).toBe("a\r\nb\r\n");
    expect(encodeTextFile("a\r\nb", "utf8", "lf")).toBe("a\nb");
    expect(encodeTextFile("a\nb", "utf8-bom", "crlf")).toBe("﻿a\r\nb");
    expect(encodeTextFile("a\nb", "utf8", "mixed")).toBe("a\nb");
  });
});

describe("filesRpc handlers", () => {
  it("reads a project file and maps the daemon version/encoding", async () => {
    const handlers = makeFiles({
      readFile: async () => ({
        bytes: new TextEncoder().encode("﻿one\r\ntwo\r\n"),
        size: 13,
        path: "src/notes.md",
        modifiedAt: AT,
        revision: "1:2:15:3",
      }),
    });
    const result = await run<ProjectReadFileResult>(handlers[WS_METHODS.projectsReadFile], {
      cwd: "/repo",
      relativePath: "src/notes.md",
    });
    expect(result).toMatchObject({
      relativePath: "src/notes.md",
      contents: "one\r\ntwo\r\n",
      truncated: false,
      version: "1:2:15:3",
      encoding: "utf8-bom",
      lineEnding: "crlf",
    });
    expect(() => encode(ProjectReadFileResult, result)).not.toThrow();
  });

  it("marks a capped read as truncated", async () => {
    const handlers = makeFiles({
      readFile: async () => ({
        bytes: new TextEncoder().encode("abc"),
        size: 9000,
        path: "big.txt",
        modifiedAt: AT,
      }),
    });
    const result = await run<ProjectReadFileResult>(handlers[WS_METHODS.projectsReadFile], {
      cwd: "/repo",
      relativePath: "big.txt",
      maxBytes: 3,
    });
    expect(result.truncated).toBe(true);
    expect(result.version).toBe(AT);
    expect(() => encode(ProjectReadFileResult, result)).not.toThrow();
  });

  it("downloads raw bytes without decoding them as text", async () => {
    const handlers = makeFiles({
      readFile: async () => ({
        bytes: new Uint8Array([0, 255, 128, 65]),
        size: 4,
        mime: "application/octet-stream",
        path: "assets/blob.bin",
        modifiedAt: AT,
      }),
    });
    const result = await run<ProjectDownloadFileResult>(handlers[WS_METHODS.projectsDownloadFile], {
      cwd: "/repo",
      relativePath: "assets/blob.bin",
    });
    expect(result).toMatchObject({
      relativePath: "assets/blob.bin",
      fileName: "blob.bin",
      mimeType: "application/octet-stream",
      size: 4,
      bytesBase64: Buffer.from([0, 255, 128, 65]).toString("base64"),
    });
    expect(() => encode(ProjectDownloadFileResult, result)).not.toThrow();
  });

  it("reports an oversized download with a clear message", async () => {
    const handlers = makeFiles({
      readFile: async () => {
        throw new Error("File is too large to display");
      },
    });
    await expect(
      run(handlers[WS_METHODS.projectsDownloadFile], {
        cwd: "/repo",
        relativePath: "huge.bin",
      }),
    ).rejects.toMatchObject({ message: expect.stringContaining("larger than") });
  });

  it("rejects downloads that leave the workspace root", async () => {
    const handlers = makeFiles({});
    await expect(
      run(handlers[WS_METHODS.projectsDownloadFile], { cwd: "/repo", relativePath: "../secret" }),
    ).rejects.toMatchObject({ code: "projects.path-outside-root" });
  });

  it("rejects reads that leave the workspace root", async () => {
    const handlers = makeFiles({});
    await expect(
      run(handlers[WS_METHODS.projectsReadFile], { cwd: "/repo", relativePath: "../secret" }),
    ).rejects.toMatchObject({ code: "projects.path-outside-root" });
  });

  it("writes with the revision guard carried by the read version", async () => {
    const writes: Array<Record<string, unknown>> = [];
    const handlers = makeFiles({
      writeFile: async (input: Record<string, unknown>) => {
        writes.push(input);
        return { status: "written", modifiedAt: AT, size: 6, revision: "9:8:6:5" };
      },
    });
    const result = await run<ProjectWriteFileResult>(handlers[WS_METHODS.projectsWriteFile], {
      cwd: "/repo",
      relativePath: "a.txt",
      contents: "a\nb",
      expectedVersion: "1:2:3:4",
      encoding: "utf8-bom",
      lineEnding: "crlf",
    });
    expect(writes[0]).toMatchObject({
      cwd: "/repo",
      path: "a.txt",
      content: "﻿a\r\nb",
      expectedRevision: "1:2:3:4",
    });
    expect(result).toEqual({ relativePath: "a.txt", version: "9:8:6:5" });
    expect(() => encode(ProjectWriteFileResult, result)).not.toThrow();
  });

  it("reads the current version before an unguarded write", async () => {
    const writes: Array<Record<string, unknown>> = [];
    const handlers = makeFiles({
      readFile: async () => ({
        bytes: new Uint8Array(),
        size: 0,
        path: "a.txt",
        modifiedAt: AT,
        revision: "2:3:0:1",
      }),
      writeFile: async (input: Record<string, unknown>) => {
        writes.push(input);
        return { status: "written", modifiedAt: AT, size: 1, revision: "4:5:1:2" };
      },
    });
    await run(handlers[WS_METHODS.projectsWriteFile], {
      cwd: "/repo",
      relativePath: "a.txt",
      contents: "x",
    });
    expect(writes[0]).toMatchObject({ expectedRevision: "2:3:0:1", expectedModifiedAt: AT });
  });

  it("surfaces a guarded-write conflict with the editor's conflict code", async () => {
    const handlers = makeFiles({
      writeFile: async () => ({
        status: "conflict",
        version: { status: "ready", cwd: "/repo", path: "a.txt", size: 1, modifiedAt: AT },
      }),
    });
    await expect(
      run(handlers[WS_METHODS.projectsWriteFile], {
        cwd: "/repo",
        relativePath: "a.txt",
        contents: "x",
        expectedVersion: AT,
      }),
    ).rejects.toMatchObject({ code: "WORKSPACE_FILE_CONFLICT" });
  });

  it("lists a directory and honors includeFiles", async () => {
    const handlers = makeFiles({
      listDirectory: async () => ({
        path: "src",
        entries: [
          { name: "a.ts", path: "src/a.ts", kind: "file", size: 1, modifiedAt: AT },
          { name: "nested", path: "src/nested", kind: "directory", size: 0, modifiedAt: AT },
        ],
      }),
    });
    const result = await run<ProjectListDirectoriesResult>(
      handlers[WS_METHODS.projectsListDirectories],
      { cwd: "/repo", relativePath: "src", includeFiles: false },
    );
    expect(result.entries).toEqual([
      {
        path: "src/nested",
        name: "nested",
        kind: "directory",
        modifiedAt: AT,
        size: 0,
        parentPath: "src",
      },
    ]);
    expect(() => encode(ProjectListDirectoriesResult, result)).not.toThrow();
  });

  it("maps directory suggestions onto entry search results", async () => {
    const calls: unknown[] = [];
    const handlers = makeFiles({
      getDirectorySuggestions: async (input: unknown) => {
        calls.push(input);
        return {
          directories: [],
          entries: [
            { path: "src/main.ts", kind: "file" },
            { path: "src/lib", kind: "directory" },
          ],
          error: null,
          requestId: "r",
        };
      },
    });
    const result = await run<ProjectSearchEntriesResult>(
      handlers[WS_METHODS.projectsSearchEntries],
      { cwd: "/repo", query: "src", limit: 50, kind: "file" },
    );
    expect(calls[0]).toMatchObject({
      cwd: "/repo",
      includeFiles: true,
      includeDirectories: false,
      matchMode: "fuzzy",
    });
    expect(result.entries).toEqual([{ path: "src/main.ts", kind: "file", parentPath: "src" }]);
    expect(() => encode(ProjectSearchEntriesResult, result)).not.toThrow();
  });

  it("maps local entry search paths to their basename", async () => {
    const handlers = makeFiles({
      getDirectorySuggestions: async () => ({
        directories: [],
        entries: [{ path: "docs/readme.md", kind: "file" }],
        error: null,
        requestId: "r",
      }),
    });
    const result = await run<ProjectSearchLocalEntriesResult>(
      handlers[WS_METHODS.projectsSearchLocalEntries],
      { rootPath: "/Users/me", query: "readme", includeFiles: true },
    );
    expect(result.entries).toEqual([
      { path: "docs/readme.md", name: "readme.md", kind: "file", parentPath: "docs" },
    ]);
    expect(() => encode(ProjectSearchLocalEntriesResult, result)).not.toThrow();
  });

  it("streams file changes from the daemon watcher", async () => {
    const handlers = makeFiles({
      observeFile: () => ({
        subscriptionId: "sub-1",
        ready: Promise.resolve({}),
        subscribe: (observer: {
          update(message: {
            type: string;
            payload: { subscriptionId: string; version: Record<string, unknown> };
          }): void;
        }) => {
          setTimeout(() => {
            observer.update({
              type: "fs.file.update",
              payload: {
                subscriptionId: "sub-1",
                version: {
                  status: "ready",
                  cwd: "/repo",
                  path: "a.txt",
                  size: 2,
                  modifiedAt: AT,
                },
              },
            });
          }, 0);
          return () => {};
        },
        release: async () => {},
      }),
    });
    const stream = handlers[WS_METHODS.projectsSubscribeFileChange]!(
      { cwd: "/repo", relativePath: "a.txt" },
      {},
    ) as Stream.Stream<unknown>;
    const [event] = await Effect.runPromise(Stream.runCollect(Stream.take(stream, 1))).then(
      (chunk) => [...chunk],
    );
    expect(event).toEqual({ type: "changed", relativePath: "a.txt", mtimeMs: Date.parse(AT) });
    expect(() => encode(ProjectFileChangeEvent, event)).not.toThrow();
  });
});

describe("filesRpc explorer writes", () => {
  it("rejects unsafe entry names", () => {
    expect(assertEntryName("test", " notes.md ")).toBe("notes.md");
    for (const name of ["", ".", "..", "a/b", "a\\b", "a\0b"]) {
      expect(() => assertEntryName("test", name)).toThrow(WsRpcError);
    }
  });

  it("creates a file under the requested parent and maps the daemon path", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const handlers = makeFiles({
      createFileEntry: async (input: Record<string, unknown>) => {
        calls.push(input);
        return {
          cwd: "/repo",
          parentPath: "src",
          path: "src/new.ts",
          success: true,
          error: null,
          requestId: "r",
        };
      },
    });
    const result = await run<ProjectEntryMutationResult>(handlers[WS_METHODS.projectsCreateEntry], {
      cwd: "/repo",
      parentPath: "src",
      name: "new.ts",
      kind: "file",
    });
    expect(calls[0]).toEqual({
      cwd: "/repo",
      parentPath: "src",
      name: "new.ts",
      kind: "file",
    });
    expect(result).toEqual({ relativePath: "src/new.ts" });
    expect(() => encode(ProjectEntryMutationResult, result)).not.toThrow();
  });

  it("creates at the workspace root when the parent is omitted", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const handlers = makeFiles({
      createFileEntry: async (input: Record<string, unknown>) => {
        calls.push(input);
        return {
          cwd: "/repo",
          parentPath: ".",
          path: "notes.md",
          success: true,
          error: null,
          requestId: "r",
        };
      },
    });
    const result = await run<ProjectEntryMutationResult>(handlers[WS_METHODS.projectsCreateEntry], {
      cwd: "/repo",
      name: "notes.md",
      kind: "file",
    });
    expect(calls[0]).toMatchObject({ parentPath: "." });
    expect(result).toEqual({ relativePath: "notes.md" });
  });

  it("rejects create requests whose parent or name escapes the workspace", async () => {
    const handlers = makeFiles({});
    await expect(
      run(handlers[WS_METHODS.projectsCreateEntry], {
        cwd: "/repo",
        parentPath: "../outside",
        name: "a.txt",
        kind: "file",
      }),
    ).rejects.toMatchObject({ code: "projects.path-outside-root" });
    await expect(
      run(handlers[WS_METHODS.projectsCreateEntry], {
        cwd: "/repo",
        parentPath: "src",
        name: "../a.txt",
        kind: "file",
      }),
    ).rejects.toMatchObject({ code: "projects.invalid-name" });
  });

  it("renames, duplicates, and deletes with the daemon's resulting paths", async () => {
    const handlers = makeFiles({
      renameFileEntry: async () => ({
        cwd: "/repo",
        path: "old.txt",
        renamedPath: "new.txt",
        success: true,
        error: null,
        requestId: "r",
      }),
      duplicateFileEntry: async () => ({
        cwd: "/repo",
        path: "new.txt",
        duplicatedPath: "new copy.txt",
        success: true,
        error: null,
        requestId: "r",
      }),
      deleteFileEntry: async () => ({
        cwd: "/repo",
        path: "new copy.txt",
        success: true,
        error: null,
        requestId: "r",
      }),
    });
    await expect(
      run<ProjectEntryMutationResult>(handlers[WS_METHODS.projectsRenameEntry], {
        cwd: "/repo",
        relativePath: "old.txt",
        name: "new.txt",
      }),
    ).resolves.toEqual({ relativePath: "new.txt" });
    await expect(
      run<ProjectEntryMutationResult>(handlers[WS_METHODS.projectsDuplicateEntry], {
        cwd: "/repo",
        relativePath: "new.txt",
      }),
    ).resolves.toEqual({ relativePath: "new copy.txt" });
    await expect(
      run<ProjectEntryMutationResult>(handlers[WS_METHODS.projectsDeleteEntry], {
        cwd: "/repo",
        relativePath: "new copy.txt",
      }),
    ).resolves.toEqual({ relativePath: "new copy.txt" });
  });

  it("surfaces a daemon refusal as the RPC error", async () => {
    const handlers = makeFiles({
      createFileEntry: async () => ({
        cwd: "/repo",
        parentPath: ".",
        path: null,
        success: false,
        error: '"a.txt" already exists',
        requestId: "r",
      }),
    });
    await expect(
      run(handlers[WS_METHODS.projectsCreateEntry], {
        cwd: "/repo",
        name: "a.txt",
        kind: "file",
      }),
    ).rejects.toThrow('"a.txt" already exists');
  });
});

describe("filesRpc content search", () => {
  const roots: string[] = [];

  async function makeRoot(): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), "bridge-search-"));
    roots.push(root);
    await mkdir(path.join(root, "src"));
    await mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
    await writeFile(path.join(root, "src", "main.ts"), "const hello = 1;\nhello();\n");
    await writeFile(path.join(root, "README.md"), "# hello\n");
    await writeFile(path.join(root, "node_modules", "pkg", "index.js"), "hello\n");
    return root;
  }

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("finds matches in the workspace and skips dependencies", async () => {
    const root = await makeRoot();
    const handlers = makeFiles({});
    const result = await run<ProjectSearchContentResult>(
      handlers[WS_METHODS.projectsSearchContent],
      { cwd: root, query: "hello", limit: 10 },
    );
    expect(() => encode(ProjectSearchContentResult, result)).not.toThrow();
    expect(result.matches.map((match) => `${match.path}:${match.lineNumber}`)).toEqual([
      "README.md:1",
      "src/main.ts:1",
      "src/main.ts:2",
    ]);
    expect(result.truncated).toBe(false);
  });

  it("rejects short queries and roots outside the workspace", async () => {
    const root = await makeRoot();
    const handlers = makeFiles({});
    await expect(
      run(handlers[WS_METHODS.projectsSearchContent], { cwd: root, query: "h" }),
    ).rejects.toThrow("at least 2");
    await expect(
      run(handlers[WS_METHODS.projectsSearchContent], { cwd: "relative/root", query: "hello" }),
    ).rejects.toThrow(WsRpcError);
  });

  it("caps results and reports truncation", async () => {
    const root = await makeRoot();
    const handlers = makeFiles({});
    const result = await run<ProjectSearchContentResult>(
      handlers[WS_METHODS.projectsSearchContent],
      { cwd: root, query: "hello", limit: 1 },
    );
    expect(result.matches).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });
});
