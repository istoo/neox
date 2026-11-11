import { describe, expect, it } from "vitest";
import {
  CurrentImageError,
  hasImages,
  imageSource,
  omitImages,
  parseDataUrl,
  textBlock,
  walkImages,
  withImageData,
  type GatewayImageSite,
} from "./vision-images.js";

function sites(protocol: Parameters<typeof walkImages>[0], body: Record<string, unknown>) {
  const found: GatewayImageSite[] = [];
  walkImages(protocol, body, (site) => {
    found.push(site);
    return null;
  });
  return found;
}

describe("walking images", () => {
  it("finds an OpenAI image URL in its two spellings", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "read" },
            { type: "image_url", image_url: "data:image/png;base64,aGVsbG8=" },
            { type: "image_url", image_url: { url: "https://example.com/a.png", detail: "high" } },
          ],
        },
      ],
    };
    expect(sites("openai", body).map((site) => site.src)).toEqual([
      "data:image/png;base64,aGVsbG8=",
      "https://example.com/a.png",
    ]);
    expect(sites("openai", body).every((site) => site.current)).toBe(true);
  });

  it("finds an Anthropic image and one inside a tool result", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_1",
              content: [
                {
                  type: "image",
                  source: { type: "base64", media_type: "image/jpeg", data: "b2xk" },
                },
              ],
            },
          ],
        },
      ],
    };
    const found = sites("anthropic", body);
    expect(found.map((site) => [site.src, site.current, site.tool])).toEqual([
      ["data:image/png;base64,aGVsbG8=", false, false],
      ["data:image/jpeg;base64,b2xk", false, true],
    ]);
  });

  it("finds Responses input images and treats a file_id as vendor only", () => {
    const found = sites("openai-responses", {
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "read" },
            { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" },
            { type: "input_image", file_id: "file-123" },
          ],
        },
      ],
    });
    expect(found.map((site) => site.src)).toEqual(["data:image/png;base64,aGVsbG8=", ""]);
  });

  it("finds Gemini inline images, and a file of unknown type counts as one", () => {
    const found = sites("gemini", {
      contents: [
        {
          role: "user",
          parts: [
            { text: "read" },
            { inlineData: { mimeType: "image/png", data: "aGVsbG8=" } },
            { fileData: { mimeType: "application/pdf", fileUri: "files/1" } },
            { fileData: { fileUri: "files/2" } },
          ],
        },
      ],
    });
    expect(found.map((site) => site.src)).toEqual(["data:image/png;base64,aGVsbG8=", ""]);
  });

  it("reports whether a body carries any image at all", () => {
    expect(
      hasImages("openai", {
        messages: [{ role: "user", content: [{ type: "image_url", image_url: "x" }] }],
      }),
    ).toBe(true);
    expect(
      hasImages("openai", {
        messages: [{ role: "user", content: [{ type: "text", text: "x" }] }],
      }),
    ).toBe(false);
    expect(hasImages("openai", { messages: "not a list" })).toBe(false);
  });

  it("returns the body as it was when nothing was swapped", () => {
    const body = {
      messages: [{ role: "user", content: [{ type: "text", text: "x" }] }],
    };
    expect(walkImages("openai", body, () => null)).toBe(body);
  });

  it("keeps an image's other fields when it replaces the block", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: "https://example.com/a.png", detail: "high" },
            },
          ],
        },
      ],
    };
    const walked = walkImages("openai", body, () => ({ type: "text", text: "gone" }));
    expect(walked).toEqual({
      messages: [{ role: "user", content: [{ type: "text", text: "gone" }] }],
    });
  });
});

describe("omitting images", () => {
  const omitted = "[Image omitted: this model accepts text only.]";

  it("replaces older turns' images with the line", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [{ type: "image_url", image_url: "data:image/png;base64,b2xk" }],
        },
        { role: "assistant", content: "seen" },
        { role: "user", content: "and now?" },
      ],
    };
    expect(omitImages("openai", body, omitted)).toEqual({
      messages: [
        { role: "user", content: [{ type: "text", text: omitted }] },
        { role: "assistant", content: "seen" },
        { role: "user", content: "and now?" },
      ],
    });
  });

  it("refuses the latest turn's image", () => {
    const body = {
      messages: [
        { role: "user", content: "old" },
        {
          role: "assistant",
          content: [{ type: "image_url", image_url: "data:image/png;base64,b2xk" }],
        },
      ],
    };
    expect(() => omitImages("openai", body, omitted)).toThrow(CurrentImageError);
  });

  it("omits an image a tool returned in the latest turn", () => {
    const body = {
      messages: [
        {
          role: "tool",
          tool_call_id: "call_1",
          content: [{ type: "image_url", image_url: "data:image/png;base64,b2xk" }],
        },
      ],
    };
    expect(omitImages("openai", body, omitted)).toEqual({
      messages: [
        {
          role: "tool",
          tool_call_id: "call_1",
          content: [{ type: "text", text: omitted }],
        },
      ],
    });
  });
});

describe("image blocks", () => {
  it("writes a text block in each protocol's shape", () => {
    expect(textBlock("openai", "x")).toEqual({ type: "text", text: "x" });
    expect(textBlock("anthropic", "x")).toEqual({ type: "text", text: "x" });
    expect(textBlock("openai-responses", "x")).toEqual({ type: "input_text", text: "x" });
    expect(textBlock("gemini", "x")).toEqual({ text: "x" });
  });

  it("replaces the bytes and keeps the fields around them", () => {
    expect(
      withImageData(
        "openai",
        { type: "image_url", image_url: { url: "https://x/a.heic", detail: "high" } },
        "image/jpeg",
        "aGVsbG8=",
      ),
    ).toEqual({
      type: "image_url",
      image_url: { url: "data:image/jpeg;base64,aGVsbG8=", detail: "high" },
    });
    expect(
      withImageData(
        "anthropic",
        {
          type: "image",
          source: { type: "url", url: "https://x/a.heic" },
          cache_control: { type: "ephemeral" },
        },
        "image/png",
        "aGVsbG8=",
      ),
    ).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" },
      cache_control: { type: "ephemeral" },
    });
    expect(
      withImageData(
        "gemini",
        { inlineData: { mimeType: "image/heic", data: "b2xk" } },
        "image/jpeg",
        "aGVsbG8=",
      ),
    ).toEqual({ inlineData: { mimeType: "image/jpeg", data: "aGVsbG8=" } });
  });

  it("reads only a base64 data URL", () => {
    expect(parseDataUrl("data:image/png;base64,aGVsbG8=")).toEqual({
      mediaType: "image/png",
      base64: "aGVsbG8=",
      bytes: Buffer.from("hello"),
    });
    expect(parseDataUrl("data:image/png,hello")).toBeNull();
    expect(parseDataUrl("https://example.com/a.png")).toBeNull();
    expect(parseDataUrl("data:image/png;base64,")).toBeNull();
  });

  it("reads a URL image source and ignores other blocks", () => {
    expect(
      imageSource("anthropic", {
        type: "image",
        source: { type: "url", url: "https://example.com/a.png" },
      }),
    ).toBe("https://example.com/a.png");
    expect(imageSource("anthropic", { type: "text", text: "x" })).toBeNull();
    expect(imageSource("openai", { type: "image_url" })).toBe("");
  });
});
