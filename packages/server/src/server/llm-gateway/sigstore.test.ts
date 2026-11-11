import { existsSync, mkdtempSync, statSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { configureSigstore, keepSignature, keptSignature, SIG_KEY_LENGTH } from "./sigstore.js";
import { signCallId, unsignCallId } from "./gemini-signature.js";

describe("the signature store", () => {
  afterEach(() => {
    configureSigstore(null);
  });

  it("keeps a value under a short key, privately", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "neolix-sig-"));
    configureSigstore(home);
    const value = "a-long-signature-".repeat(40);
    const key = keepSignature(value);
    expect(key).toMatch(new RegExp(`^[A-Za-z0-9_-]{${SIG_KEY_LENGTH}}$`));
    expect(keptSignature(key ?? "")).toBe(value);
    const file = statSync(path.join(home, "gateway-sig", key ?? ""));
    expect(file.mode & 0o777).toBe(0o600);
  });

  it("turns keeping off without a home", () => {
    configureSigstore(null);
    expect(keepSignature("value")).toBeNull();
    expect(keptSignature("a".repeat(16))).toBeNull();
  });

  it("puts a long signature's key in the call's id", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "neolix-sig-"));
    configureSigstore(home);
    const signature = "s".repeat(600);
    const signed = signCallId("call_1", signature);
    expect(signed.startsWith("call_1__tsk16__")).toBe(true);
    expect(signed.length).toBeLessThan(60);
    expect(unsignCallId(signed)).toEqual({ id: "call_1", signature });
    // The key of another home reads as no signature.
    configureSigstore(mkdtempSync(path.join(os.tmpdir(), "neolix-sig-")));
    expect(unsignCallId(signed)).toEqual({ id: signed, signature: null });
  });
});

describe("the value store's pruning", () => {
  afterEach(() => {
    configureSigstore(null);
  });

  it("removes values no call read for 90 days", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "neolix-sig-"));
    configureSigstore(home);
    const stale = keepSignature("stale-value") ?? "";
    const kept = keepSignature("kept-value") ?? "";
    const stalePath = path.join(home, "gateway-sig", stale);
    const old = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
    utimesSync(stalePath, old, old);
    const temp = path.join(home, "gateway-sig", ".tmp-leftover");
    writeFileSync(temp, "half a write");
    utimesSync(temp, old, old);
    const freshTemp = path.join(home, "gateway-sig", ".tmp-fresh");
    writeFileSync(freshTemp, "being written");

    configureSigstore(home); // a new session's first write prunes
    keepSignature("another-value");

    expect(existsSync(stalePath)).toBe(false);
    expect(existsSync(path.join(home, "gateway-sig", kept))).toBe(true);
    expect(existsSync(temp)).toBe(false);
    expect(existsSync(freshTemp)).toBe(true);
  });

  it("keeps what a read touches", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "neolix-sig-"));
    configureSigstore(home);
    const key = keepSignature("still-needed") ?? "";
    const file = path.join(home, "gateway-sig", key);
    const almostOld = new Date(Date.now() - 80 * 24 * 60 * 60 * 1000);
    utimesSync(file, almostOld, almostOld);
    expect(keptSignature(key)).toBe("still-needed");
    expect(Date.now() - statSync(file).mtimeMs).toBeLessThan(60_000);

    configureSigstore(home);
    keepSignature("another-value");
    expect(existsSync(file)).toBe(true);
  });
});
