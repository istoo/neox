import { NEOLIX_HOST_WS_METHODS, type NeolixBackupFile } from "@synara/contracts";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { makeHostHandlers } from "./hostRpc.ts";
import type { BridgeModel } from "./model.ts";
import type { AnyHandler } from "./stubs.ts";

function run<A>(handler: AnyHandler | undefined, payload: unknown): Promise<A> {
  if (!handler) throw new Error("handler is missing");
  return Effect.runPromise(handler(payload, {}) as Effect.Effect<A, never>);
}

function handlersWith(base: string | undefined) {
  const requested: string[] = [];
  const client = {
    requestBackupDownloadToken: async (name: string) => {
      requested.push(name);
      return {
        requestId: "r",
        token: "token-1",
        fileName: name,
        mimeType: "application/octet-stream",
        size: 3,
        error: null,
      };
    },
  };
  const handlers = makeHostHandlers({ client } as unknown as BridgeModel, {
    daemonHttpBase: base,
  });
  return { handlers, requested };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("downloadBackup", () => {
  it("redeems the daemon token over its download route", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: URL) => {
      urls.push(url.toString());
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    });
    const { handlers, requested } = handlersWith("http://127.0.0.1:6768");
    const result = await run<NeolixBackupFile>(handlers[NEOLIX_HOST_WS_METHODS.downloadBackup], {
      name: "backup-1.zip",
    });
    expect(requested).toEqual(["backup-1.zip"]);
    expect(urls).toEqual(["http://127.0.0.1:6768/api/files/download?token=token-1"]);
    expect(result).toEqual({
      fileName: "backup-1.zip",
      mimeType: "application/octet-stream",
      bytesBase64: Buffer.from([1, 2, 3]).toString("base64"),
      error: null,
    });
  });

  it("reports a host whose backups are not reachable over HTTP", async () => {
    const { handlers } = handlersWith(undefined);
    const result = await run<NeolixBackupFile>(handlers[NEOLIX_HOST_WS_METHODS.downloadBackup], {
      name: "backup-1.zip",
    });
    expect(result.error).toContain("not reachable over HTTP");
  });

  it("reports an HTTP failure without pretending the file arrived", async () => {
    vi.stubGlobal("fetch", async () => new Response("gone", { status: 403 }));
    const { handlers } = handlersWith("http://127.0.0.1:6768");
    const result = await run<NeolixBackupFile>(handlers[NEOLIX_HOST_WS_METHODS.downloadBackup], {
      name: "backup-1.zip",
    });
    expect(result.error).toContain("403");
    expect(result.bytesBase64).toBe("");
  });
});
