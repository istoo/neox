import { describe, expect, it } from "vitest";
import {
  buildPacks,
  openPack,
  packFileName,
  sealPack,
  unpackFiles,
  unpackPacks,
  type SyncPack,
} from "./archive.js";

const PASSPHRASE = "correct horse battery staple";

function pack(overrides: Partial<SyncPack> = {}): SyncPack {
  return {
    version: 1,
    part: "settings",
    device: "laptop",
    takenAt: "2026-01-02T03:04:05.000Z",
    index: 0,
    count: 1,
    files: {
      "config.json": { sha256: "", mode: 0o600, data: "" },
    },
    ...overrides,
  };
}

describe("buildPacks", () => {
  it("records each file's hash, mode and bytes", () => {
    const [built] = buildPacks({
      part: "settings",
      device: "laptop",
      files: [
        { path: "config.json", content: "{}", mode: 0o600 },
        { path: "notes/a.txt", content: "hello" },
      ],
    });
    expect(built?.part).toBe("settings");
    expect(built?.files["config.json"]?.mode).toBe(0o600);
    expect(built?.files["notes/a.txt"]?.sha256).toMatch(/^[0-9a-f]{64}$/);
    const files = unpackFiles(built!);
    expect(files.map((file) => file.path)).toEqual(["config.json", "notes/a.txt"]);
    expect(files[1]?.content.toString("utf8")).toBe("hello");
  });

  it("splits a part too large for one file by whole files", () => {
    const packs = buildPacks({
      part: "library",
      device: "laptop",
      maxPartBytes: 10,
      files: [
        { path: "a", content: "aaaa" },
        { path: "b", content: "bbbb" },
        { path: "c", content: "cccc" },
      ],
    });
    expect(packs).toHaveLength(2);
    expect(packs.map((entry) => entry.count)).toEqual([2, 2]);
    expect(packs.map((entry) => entry.index)).toEqual([0, 1]);
    expect(Object.keys(packs[0]?.files ?? {})).toEqual(["a", "b"]);
    expect(Object.keys(packs[1]?.files ?? {})).toEqual(["c"]);
  });

  it("sends a file bigger than a part in pieces and joins them back", () => {
    const packs = buildPacks({
      part: "library",
      device: "laptop",
      maxPartBytes: 4,
      files: [{ path: "big", content: "0123456789" }],
    });
    expect(packs).toHaveLength(3);
    const files = unpackPacks(packs);
    expect(files).toHaveLength(1);
    expect(files[0]?.path).toBe("big");
    expect(files[0]?.content.toString()).toBe("0123456789");
  });

  it("refuses a part whose pieces don't add up", () => {
    const packs = buildPacks({
      part: "library",
      device: "laptop",
      maxPartBytes: 4,
      files: [{ path: "big", content: "0123456789" }],
    });
    delete packs[1]!.files[Object.keys(packs[1]!.files)[0]!];
    expect(() => unpackPacks(packs)).toThrow(/missing part of itself/);
  });
});

describe("sealing", () => {
  it("round-trips a pack", () => {
    const sealed = sealPack(pack(), PASSPHRASE);
    expect(sealed.subarray(0, 11).toString("utf8")).toBe("NEOLIXSYNC1");
    expect(openPack(sealed, PASSPHRASE)).toEqual(pack());
  });

  it("does not leave the contents in the open", () => {
    const sealed = sealPack(
      pack({ files: { "gateway.json": { sha256: "", mode: 0o600, data: "" } } }),
      PASSPHRASE,
    );
    expect(sealed.toString("utf8")).not.toContain("gateway.json");
  });

  it("rejects a wrong passphrase", () => {
    const sealed = sealPack(pack(), PASSPHRASE);
    expect(() => openPack(sealed, "wrong")).toThrow();
  });

  it("rejects a changed byte", () => {
    const sealed = sealPack(pack(), PASSPHRASE);
    const at = sealed.byteLength - 1;
    sealed[at] = (sealed[at] ?? 0) ^ 0xff;
    expect(() => openPack(sealed, PASSPHRASE)).toThrow();
  });

  it("rejects a truncated file", () => {
    expect(() => openPack(Buffer.from("NEOLIXSYNC1"), PASSPHRASE)).toThrow(/truncated/);
  });

  it("refuses to seal without a passphrase", () => {
    expect(() => sealPack(pack(), "")).toThrow(/passphrase/);
  });
});

describe("packFileName", () => {
  it("names each split part in order", () => {
    expect(packFileName(pack({ index: 2 }))).toBe("settings.002.neolixsync");
  });
});
