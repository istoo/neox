import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { submittedPromptAttachments } from "./agent-manager";

const PNG_BYTES = Buffer.from("89504e470d0a1a0a", "hex");

describe("submitted prompt attachments", () => {
  const homes: string[] = [];

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  });

  it("keeps an attached image on disk so a reloaded thread still shows it", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "neolix-attachments-"));
    homes.push(home);
    vi.stubEnv("NEOLIX_HOME", home);

    const { attachments, writes } = submittedPromptAttachments([
      { type: "text", text: "look" },
      { type: "image", data: PNG_BYTES.toString("base64"), mimeType: "image/png" },
    ]);
    await Promise.all(writes);

    expect(attachments).toHaveLength(1);
    const image = attachments?.[0];
    expect(image).toMatchObject({ type: "stored_image", mimeType: "image/png", size: 8 });
    const stored = image as { id: string; path: string };
    expect(stored.path).toBe(path.join(home, "attachments", `${stored.id}.png`));
    expect(existsSync(stored.path)).toBe(true);
    expect(readFileSync(stored.path)).toEqual(PNG_BYTES);
  });

  it("returns nothing for a plain text prompt", () => {
    expect(submittedPromptAttachments("hello").attachments).toBeUndefined();
  });
});
