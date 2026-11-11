import { describe, expect, it } from "vitest";

import { mermaidSvgDataUrl, mermaidSvgSize } from "./mermaidRender";

describe("mermaidSvgSize", () => {
  it("reads the diagram size from the viewBox, not the 100% width", () => {
    const svg = '<svg width="100%" viewBox="-8 -8 316.5 64" style="max-width: 316.5px;"></svg>';
    expect(mermaidSvgSize(svg)).toEqual({ width: 317, height: 64 });
  });

  it("returns null without a usable viewBox", () => {
    expect(mermaidSvgSize("<svg></svg>")).toBeNull();
    expect(mermaidSvgSize('<svg viewBox="0 0 0 10"></svg>')).toBeNull();
  });
});

describe("mermaidSvgDataUrl", () => {
  it("percent-encodes the SVG so it loads as an inert image", () => {
    expect(mermaidSvgDataUrl('<svg a="#"/>')).toBe(
      "data:image/svg+xml;charset=utf-8,%3Csvg%20a%3D%22%23%22%2F%3E",
    );
  });
});
