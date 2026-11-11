import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ChatAttachment } from "@synara/contracts";
import { Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AttachmentStore } from "./attachments.ts";
import type { DaemonClient } from "./neolix.ts";

function fakeClient(uploads: unknown[]): DaemonClient {
  return {
    uploadFile: async (input: { fileName: string; mimeType: string; bytes: Uint8Array }) => {
      uploads.push(input);
      return {
        file: {
          type: "uploaded_file",
          id: "uploaded-1",
          fileName: input.fileName,
          mimeType: input.mimeType,
          size: input.bytes.byteLength,
          path: "/tmp/uploaded-1",
        },
      };
    },
  } as unknown as DaemonClient;
}

describe("attachments", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("serves an image the daemon persisted, so a reloaded thread still shows it", () => {
    const home = mkdtempSync(path.join(tmpdir(), "neolix-bridge-attachments-"));
    try {
      vi.stubEnv("NEOLIX_HOME", home);
      mkdirSync(path.join(home, "attachments"));
      const id = "0f8fad5b-d9cb-469f-a165-70867728950e";
      writeFileSync(path.join(home, "attachments", `${id}.png`), Buffer.from([1, 2, 3]));

      const store = new AttachmentStore();
      const stored = store.get(id);
      expect(stored).toMatchObject({ type: "image", mimeType: "image/png" });
      expect(Array.from(stored!.bytes)).toEqual([1, 2, 3]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("never turns an arbitrary id into a path outside the attachment directory", () => {
    const home = mkdtempSync(path.join(tmpdir(), "neolix-bridge-attachments-"));
    try {
      vi.stubEnv("NEOLIX_HOME", home);
      const store = new AttachmentStore();
      expect(store.get("../../etc/passwd")).toBeUndefined();
      expect(store.get("0f8fad5b-d9cb-469f-a165-70867728950e")).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("stages an image and describes it as a chat attachment", () => {
    const store = new AttachmentStore();
    const staged = store.stage({
      type: "image",
      name: "shot.png",
      mimeType: "image/png",
      bytes: new Uint8Array([1, 2, 3]),
    });
    expect(() => Schema.encodeUnknownSync(ChatAttachment as never)(staged)).not.toThrow();
    expect(staged).toMatchObject({ type: "image", name: "shot.png", sizeBytes: 3 });
  });

  it("sends images inline and uploads files to the daemon", async () => {
    const store = new AttachmentStore();
    const uploads: unknown[] = [];
    const image = store.stage({
      type: "image",
      name: "a.png",
      mimeType: "image/png",
      bytes: new Uint8Array([7, 8]),
    });
    const file = store.stage({
      type: "file",
      name: "notes.txt",
      mimeType: "text/plain",
      bytes: new Uint8Array([9]),
    });
    const resolved = await store.resolve(fakeClient(uploads), [image, file]);
    expect(resolved.images).toEqual([{ data: "Bwg=", mimeType: "image/png" }]);
    expect(resolved.attachments).toEqual([
      expect.objectContaining({ type: "uploaded_file", fileName: "notes.txt" }),
    ]);
    expect(uploads).toHaveLength(1);
  });

  it("turns an assistant selection into a text attachment", async () => {
    const store = new AttachmentStore();
    const resolved = await store.resolve(fakeClient([]), [
      {
        type: "assistant-selection",
        id: "selection-1",
        assistantMessageId: "msg-1",
        text: "quoted answer",
      } as never,
    ]);
    expect(resolved.attachments).toEqual([
      { type: "text", mimeType: "text/plain", title: "Selected text", text: "quoted answer" },
    ]);
  });

  it("forwards a structured review to the daemon with the review mime type", async () => {
    const store = new AttachmentStore();
    const review = {
      type: "review" as const,
      id: "review-1",
      cwd: "/repo",
      mode: "uncommitted" as const,
      comments: [
        {
          filePath: "src/app.ts",
          side: "new" as const,
          lineNumber: 12,
          body: "guard this",
          context: {
            hunkHeader: "@@ -10,2 +10,2 @@",
            targetLine: {
              oldLineNumber: null,
              newLineNumber: 12,
              type: "add" as const,
              content: "guard",
            },
            lines: [
              {
                oldLineNumber: null,
                newLineNumber: 12,
                type: "add" as const,
                content: "guard",
              },
            ],
          },
        },
      ],
    };
    expect(() => Schema.encodeUnknownSync(ChatAttachment as never)(review)).not.toThrow();
    const resolved = await store.resolve(fakeClient([]), [review]);
    expect(resolved.attachments).toEqual([
      {
        type: "review",
        mimeType: "application/neolix-review",
        cwd: "/repo",
        mode: "uncommitted",
        comments: review.comments,
      },
    ]);
  });

  it("rejects a missing staged attachment instead of dropping it", async () => {
    const store = new AttachmentStore();
    await expect(
      store.resolve(fakeClient([]), [
        { type: "file", id: "gone", name: "gone.txt", mimeType: "text/plain", sizeBytes: 1 },
      ]),
    ).rejects.toThrow(/no longer available/u);
  });

  it("rejects an image upload without an image content type", () => {
    const store = new AttachmentStore();
    expect(() =>
      store.stage({
        type: "image",
        name: "a.txt",
        mimeType: "text/plain",
        bytes: new Uint8Array([1]),
      }),
    ).toThrow(/image content type/u);
  });

  it("cancels a staged attachment", () => {
    const store = new AttachmentStore();
    const staged = store.stage({
      type: "file",
      name: "a.txt",
      mimeType: "text/plain",
      bytes: new Uint8Array([1]),
    });
    store.delete(staged.id);
    expect(store.get(staged.id)).toBeUndefined();
  });
});
