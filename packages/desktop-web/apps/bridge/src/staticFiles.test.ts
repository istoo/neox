import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  APP_SHELL_CSP,
  resolveStaticAsset,
  staticCacheControl,
  staticResponseHeaders,
} from "./staticFiles.ts";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "neolix-bridge-static-"));
  await mkdir(path.join(root, "assets"));
  await writeFile(path.join(root, "index.html"), "<!doctype html>");
  await writeFile(path.join(root, "assets", "app-123.js"), "console.log(1)");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("resolveStaticAsset", () => {
  it("serves an existing asset", async () => {
    await expect(
      resolveStaticAsset({ webDistDir: root, pathname: "/assets/app-123.js" }),
    ).resolves.toEqual({ filePath: path.join(root, "assets", "app-123.js"), kind: "file" });
  });

  it("falls back to index.html for an extensionless route", async () => {
    await expect(
      resolveStaticAsset({ webDistDir: root, pathname: "/settings/appearance" }),
    ).resolves.toEqual({ filePath: path.join(root, "index.html"), kind: "spa" });
  });

  it("does not serve the shell for a missing asset", async () => {
    await expect(
      resolveStaticAsset({ webDistDir: root, pathname: "/assets/missing.js" }),
    ).resolves.toBeNull();
  });

  it("rejects traversal outside the dist directory", async () => {
    await expect(
      resolveStaticAsset({ webDistDir: root, pathname: "/../../etc/passwd" }),
    ).resolves.toBeNull();
    await expect(
      resolveStaticAsset({ webDistDir: root, pathname: "/%2e%2e/%2e%2e/etc/passwd" }),
    ).resolves.toBeNull();
  });

  it("rejects malformed percent encoding and NUL bytes", async () => {
    await expect(
      resolveStaticAsset({ webDistDir: root, pathname: "/%E0%A4%A" }),
    ).resolves.toBeNull();
    await expect(
      resolveStaticAsset({ webDistDir: root, pathname: "/index.html%00.png" }),
    ).resolves.toBeNull();
  });
});

describe("staticCacheControl", () => {
  it("keeps the shell out of caches and marks hashed assets immutable", () => {
    expect(staticCacheControl({ filePath: "index.html", kind: "spa" }, "/settings")).toBe(
      "no-store",
    );
    expect(staticCacheControl({ filePath: "app.js", kind: "file" }, "/assets/app-123.js")).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(staticCacheControl({ filePath: "favicon.ico", kind: "file" }, "/favicon.ico")).toBe(
      "no-cache",
    );
  });
});

describe("staticResponseHeaders", () => {
  it("puts the script-limiting CSP on HTML documents only", () => {
    const shell = staticResponseHeaders({ filePath: "/dist/index.html", kind: "spa" }, "/settings");
    expect(shell["Content-Security-Policy"]).toBe(APP_SHELL_CSP);
    expect(APP_SHELL_CSP).toContain("script-src 'self'");
    expect(APP_SHELL_CSP).not.toMatch(/'unsafe-inline'|'unsafe-eval'/);
    expect(
      staticResponseHeaders({ filePath: "/dist/index.html", kind: "file" }, "/index.html")[
        "Content-Security-Policy"
      ],
    ).toBe(APP_SHELL_CSP);
    expect(
      staticResponseHeaders({ filePath: "/dist/assets/app.js", kind: "file" }, "/assets/app.js"),
    ).toEqual({ "Cache-Control": "public, max-age=31536000, immutable" });
  });
});
