import { createServer, type Server } from "node:http";
import { afterAll, describe, expect, it } from "vitest";
import {
  ImageFetchError,
  isPrivateAddress,
  loadImageSource,
  setFetchPrivate,
  sniffImageType,
} from "./vision-fetch.js";

// myna's table (internal/netguard/netguard_test.go): the special ranges an
// image URL must not reach, and the ones it may.
const PRIVATE = [
  "127.0.0.1",
  "127.9.9.9",
  "10.1.2.3",
  "172.16.0.1",
  "192.168.1.1",
  "169.254.169.254",
  "100.64.0.1",
  "100.100.100.100",
  "0.0.0.0",
  "224.0.0.1",
  "255.255.255.255",
  "192.0.2.1",
  "198.18.0.7",
  "198.51.100.1",
  "203.0.113.1",
  "240.0.0.1",
  "::1",
  "::",
  "::ffff:127.0.0.1",
  "::ffff:7f00:1",
  "::ffff:10.0.0.1",
  "::ffff:169.254.169.254",
  "::ffff:100.64.0.1",
  "::ffff:198.18.0.7",
  "fe80::1",
  "fc00::1",
  "fd12::1",
  "ff02::1",
  "fec0::1",
  "::7f00:1",
  // 6to4 of 127.0.0.1: bits 16–47 carry the IPv4 address.
  ["2002", "7f00", "1", "0", "0", "0", "0", "1"].join(":"),
  // Teredo is refused whole.
  ["2001", "0", "0", "0", "0", "0", "0", "1"].join(":"),
  "64:ff9b::7f00:1",
  "64:ff9b:1::1",
  "64:ff9b::a00:1",
  "100::1",
  "localhost",
  "not-an-address",
];

const PUBLIC = [
  "8.8.8.8",
  "::ffff:8.8.8.8",
  "64:ff9b::808:808",
  ["2002", "808", "808", "0", "0", "0", "0", "1"].join(":"),
];

describe("private addresses", () => {
  for (const address of PRIVATE) {
    it(`refuses ${address}`, () => {
      expect(isPrivateAddress(address)).toBe(true);
    });
  }
  for (const address of PUBLIC) {
    it(`allows ${address}`, () => {
      expect(isPrivateAddress(address)).toBe(false);
    });
  }
});

describe("sniffing an image's type", () => {
  it("reads the formats Neox sends", () => {
    expect(sniffImageType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(
      "image/png",
    );
    expect(sniffImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffImageType(Buffer.from("GIF89a"))).toBe("image/gif");
    expect(sniffImageType(Buffer.from("RIFF\0\0\0\0WEBP", "latin1"))).toBe("image/webp");
    expect(sniffImageType(Buffer.from("\0\0\0\0ftypheic", "latin1"))).toBe("image/heic");
    expect(sniffImageType(Buffer.from("%PDF-1.4"))).toBeNull();
  });
});

describe("loading an image source", () => {
  it("reads a data URL, trusting its bytes over its name", () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
    const image = loadImageSource(`data:image/jpeg;base64,${png.toString("base64")}`);
    return expect(image).resolves.toEqual({ bytes: png, mediaType: "image/png" });
  });

  it("keeps the declared type when the bytes are not a known image", async () => {
    const image = await loadImageSource("data:image/avif;base64,aGVsbG8=");
    expect(image.mediaType).toBe("image/avif");
    expect(image.bytes.toString()).toBe("hello");
  });

  it("refuses a source that is neither a data URL nor http(s)", async () => {
    await expect(loadImageSource("")).rejects.toThrow(ImageFetchError);
    await expect(loadImageSource("file:///etc/passwd")).rejects.toThrow(
      "is not a data URL or an http(s) URL",
    );
  });
});

describe("fetching an image URL", () => {
  let server: Server | null = null;
  const hits: string[] = [];

  afterAll(() => {
    setFetchPrivate([]);
    server?.close();
  });

  async function listen(): Promise<string> {
    server = createServer((request, response) => {
      hits.push(request.url ?? "");
      response.end("reached");
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("no test address");
    }
    return `http://127.0.0.1:${address.port}`;
  }

  it("does not connect to a private address, however the URL names it", async () => {
    const base = await listen();
    for (const url of [`${base}/a.png`, `${base.replace("127.0.0.1", "localhost")}/a.png`]) {
      await expect(loadImageSource(url)).rejects.toThrow(/private address|localhost/);
    }
    await expect(loadImageSource("http://169.254.169.254/latest/meta-data/")).rejects.toThrow(
      "private address",
    );
    expect(hits).toEqual([]);
  });

  it("reaches a private address the user named in fetchPrivate", async () => {
    const base = await listen();
    const host = new URL(base).hostname;
    hits.length = 0;
    for (const entries of [[host], ["127.0.0.0/8"], [`${host}:${new URL(base).port}`]]) {
      setFetchPrivate(entries);
      try {
        // The test server answers words, not an image: reaching it is what
        // the allowlist changes.
        await expect(loadImageSource(`${base}/a.png`)).rejects.toThrow(
          "did not answer with an image",
        );
        expect(hits).toContain("/a.png");
      } finally {
        setFetchPrivate([]);
      }
    }
  });

  it("still refuses a private address the user did not name", async () => {
    const base = await listen();
    setFetchPrivate(["192.168.0.1"]);
    try {
      await expect(loadImageSource(`${base}/a.png`)).rejects.toThrow("private address");
    } finally {
      setFetchPrivate([]);
    }
  });
});
