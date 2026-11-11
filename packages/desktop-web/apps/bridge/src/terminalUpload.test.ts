import { Effect } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { describe, expect, it } from "vitest";

import { makeTerminalUploadHandler, type TerminalUpload } from "./terminalUpload.ts";

async function post(upload: TerminalUpload, origin?: string) {
  const request = HttpServerRequest.fromWeb(
    new Request("http://127.0.0.1/api/terminal/upload?name=a.txt&mimeType=text/plain", {
      method: "POST",
      body: "hi",
      headers: origin ? { origin } : {},
    }),
  );
  const response = HttpServerResponse.toWeb(
    await Effect.runPromise(makeTerminalUploadHandler(upload)(request)),
  );
  return { status: response.status, body: await response.text() };
}

describe("terminal upload route", () => {
  it("returns the stored host path", async () => {
    const result = await post(async () => "/tmp/uploads/a.txt");
    expect(result).toEqual({ status: 200, body: JSON.stringify({ path: "/tmp/uploads/a.txt" }) });
  });

  it("reports the daemon's error when the upload fails", async () => {
    const result = await post(async () => {
      throw new Error("daemon refused the upload");
    });
    expect(result).toEqual({ status: 500, body: "daemon refused the upload" });
  });

  it("rejects a non-loopback origin", async () => {
    const result = await post(async () => "/tmp/uploads/a.txt", "https://example.com");
    expect(result.status).toBe(403);
  });
});
