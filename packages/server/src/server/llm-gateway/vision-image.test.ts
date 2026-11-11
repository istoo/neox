import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { convertForVendor, fitForVision } from "./vision-image.js";
import { sniffImageType } from "./vision-fetch.js";

const CLAUDE_BASE64 = 5 << 20;

async function webp(options: { alpha: boolean }): Promise<Buffer> {
  return sharp({
    create: {
      width: 8,
      height: 8,
      channels: options.alpha ? 4 : 3,
      background: options.alpha ? { r: 255, g: 0, b: 0, alpha: 0.5 } : { r: 255, g: 0, b: 0 },
    },
  })
    .webp()
    .toBuffer();
}

async function heic(name: string): Promise<Buffer> {
  return readFile(new URL(`./testdata/${name}`, import.meta.url));
}

describe("converting formats a vendor refuses", () => {
  it("leaves an image in a format vendors take alone", async () => {
    const png = await sharp({
      create: { width: 8, height: 8, channels: 3, background: "#ff0000" },
    })
      .png()
      .toBuffer();
    const converted = await convertForVendor(png, "image/png", { convertWebp: false });
    expect(converted.bytes).toBe(png);
    expect(converted.mediaType).toBe("image/png");
  });

  it("rewrites a WebP only when asked", async () => {
    const bytes = await webp({ alpha: false });
    const unchanged = await convertForVendor(bytes, "image/webp", { convertWebp: false });
    expect(unchanged.bytes).toBe(bytes);
    expect(unchanged.mediaType).toBe("image/webp");

    const converted = await convertForVendor(bytes, "image/webp", { convertWebp: true });
    expect(converted.mediaType).toBe("image/jpeg");
    expect(sniffImageType(converted.bytes)).toBe("image/jpeg");
  });

  it("keeps a WebP's transparency as PNG", async () => {
    const converted = await convertForVendor(await webp({ alpha: true }), "image/webp", {
      convertWebp: true,
    });
    expect(converted.mediaType).toBe("image/png");
    expect(sniffImageType(converted.bytes)).toBe("image/png");
  });

  // sips is the decoder macOS already has; other platforms keep the bytes.
  it.runIf(process.platform === "darwin")("rewrites a HEIC as JPEG or PNG", async () => {
    const opaque = await convertForVendor(await heic("opaque.heic"), "image/heic", {
      convertWebp: false,
    });
    expect(opaque.mediaType).toBe("image/jpeg");
    expect(sniffImageType(opaque.bytes)).toBe("image/jpeg");
    await expect(sharp(opaque.bytes).metadata()).resolves.toMatchObject({ format: "jpeg" });

    const alpha = await convertForVendor(await heic("alpha.heic"), "image/heic", {
      convertWebp: false,
    });
    expect(alpha.mediaType).toBe("image/png");
    expect(sniffImageType(alpha.bytes)).toBe("image/png");
  });
});

describe("fitting an image for the description model", () => {
  it("keeps a small image as it is", async () => {
    const jpeg = await sharp({
      create: { width: 64, height: 64, channels: 3, background: "#ff0000" },
    })
      .jpeg()
      .toBuffer();
    const fitted = await fitForVision(jpeg, "image/jpeg");
    expect(fitted.bytes).toBe(jpeg);
    expect(fitted.mediaType).toBe("image/jpeg");
  });

  it("resizes to 2000 px a side and keeps the base64 under 5 MiB", async () => {
    const jpeg = await sharp({
      create: { width: 2400, height: 1200, channels: 3, background: "#ff0000" },
    })
      .jpeg()
      .toBuffer();
    const fitted = await fitForVision(jpeg, "image/jpeg");
    expect(fitted.mediaType).toBe("image/jpeg");
    expect(Math.ceil((fitted.bytes.length * 4) / 3)).toBeLessThanOrEqual(CLAUDE_BASE64);
    const metadata = await sharp(fitted.bytes).metadata();
    expect(metadata.width).toBeLessThanOrEqual(2000);
    expect(metadata.height).toBeLessThanOrEqual(2000);
  });

  it("rewrites a HEIC before fitting it", async () => {
    const fitted = await fitForVision(await heic("opaque.heic"), "image/heic");
    if (process.platform === "darwin") {
      expect(fitted.mediaType).toBe("image/jpeg");
    } else {
      // No HEVC decoder: the bytes go as they came.
      expect(fitted.mediaType).toBe("image/heic");
    }
  });
});
