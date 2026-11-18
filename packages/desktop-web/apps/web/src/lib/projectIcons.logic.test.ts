import { describe, expect, it, vi } from "vitest";

import {
  MAX_PROJECT_ICON_BYTES,
  importProjectIconFromUrl,
  projectIconDataUri,
} from "./projectIcons.logic";

function response(input: {
  body?: string | Uint8Array;
  contentType?: string;
  status?: number;
  contentLength?: number;
}): Response {
  const body = input.body ?? "";
  return new Response(body as BodyInit, {
    status: input.status ?? 200,
    headers: {
      "content-type": input.contentType ?? "application/octet-stream",
      ...(input.contentLength === undefined
        ? {}
        : { "content-length": String(input.contentLength) }),
    },
  });
}

describe("projectIconDataUri", () => {
  it("builds a data URI from the daemon's icon", () => {
    expect(projectIconDataUri({ data: "AAAA", mimeType: "image/png" })).toBe(
      "data:image/png;base64,AAAA",
    );
  });

  it("has no URI without an icon", () => {
    expect(projectIconDataUri(null)).toBeNull();
  });
});

describe("importProjectIconFromUrl", () => {
  it("reads a direct image", async () => {
    const fetchIcon = vi.fn(async () => response({ body: "PNG", contentType: "image/png" }));
    await expect(importProjectIconFromUrl("https://example.com/logo.png", fetchIcon)).resolves.toBe(
      btoa("PNG"),
    );
    expect(fetchIcon).toHaveBeenCalledTimes(1);
  });

  it("uses the first declared icon on an HTML page", async () => {
    const fetchIcon = vi.fn(async (input: string | URL) => {
      const url = String(input).replace(/\/$/, "");
      if (url === "https://example.com") {
        return response({
          body: '<html><head><link rel="icon" href="/icons/app.png"></head></html>',
          contentType: "text/html; charset=utf-8",
        });
      }
      return response({ body: "ICON", contentType: "image/png" });
    });
    await expect(importProjectIconFromUrl("https://example.com", fetchIcon)).resolves.toBe(
      btoa("ICON"),
    );
    expect(String(fetchIcon.mock.calls[1]?.[0])).toBe("https://example.com/icons/app.png");
  });

  it("falls back to the conventional favicon", async () => {
    const fetchIcon = vi.fn(async (input: string | URL) => {
      const url = String(input).replace(/\/$/, "");
      if (url === "https://example.com") {
        return response({ body: "<html></html>", contentType: "text/html" });
      }
      if (url.endsWith("/favicon.ico"))
        return response({ body: "ICO", contentType: "image/x-icon" });
      return response({ body: "", status: 404 });
    });
    await expect(importProjectIconFromUrl("https://example.com", fetchIcon)).resolves.toBe(
      btoa("ICO"),
    );
  });

  it("rejects a non-HTTP URL", async () => {
    await expect(importProjectIconFromUrl("file:///etc/passwd")).rejects.toThrow(
      "URL must use HTTP or HTTPS",
    );
  });

  it("rejects an oversized image before reading it", async () => {
    const fetchIcon = vi.fn(async () =>
      response({
        body: new Uint8Array(MAX_PROJECT_ICON_BYTES + 1),
        contentType: "image/png",
        contentLength: MAX_PROJECT_ICON_BYTES + 1,
      }),
    );
    await expect(
      importProjectIconFromUrl("https://example.com/logo.png", fetchIcon),
    ).rejects.toThrow("512 KB");
  });

  it("reports a page with no usable icon", async () => {
    const fetchIcon = vi.fn(async (input: string | URL) => {
      const url = String(input).replace(/\/$/, "");
      if (url === "https://example.com") {
        return response({ body: "<html></html>", contentType: "text/html" });
      }
      return response({ body: "", status: 404 });
    });
    await expect(importProjectIconFromUrl("https://example.com", fetchIcon)).rejects.toThrow(
      "Download failed (404)",
    );
  });
});
