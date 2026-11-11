// FILE: mermaidRender.ts
// Purpose: Render Mermaid source from agent replies to a standalone SVG string.
// Layer: Web chat utility
// Exports: renderMermaidSvg, mermaidSvgDataUrl
//
// Agent output is untrusted: Mermaid runs with securityLevel "strict" (no click handlers, labels
// sanitized) and HTML labels off, and callers show the SVG through an <img>, where scripts and
// external loads never run. Mermaid is loaded on first use so it stays out of the main bundle.

type MermaidApi = typeof import("mermaid").default;

let mermaidPromise: Promise<MermaidApi> | null = null;
let renderQueue: Promise<unknown> = Promise.resolve();
let renderSequence = 0;

function loadMermaid(): Promise<MermaidApi> {
  mermaidPromise ??= import("mermaid").then((module) => module.default);
  return mermaidPromise;
}

/**
 * Mermaid keeps its configuration global, so renders run one at a time with the theme each
 * one asked for. Rejects when the source does not parse.
 */
export function renderMermaidSvg(source: string, colorScheme: "light" | "dark"): Promise<string> {
  const job = renderQueue.then(async () => {
    const mermaid = await loadMermaid();
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      htmlLabels: false,
      flowchart: { htmlLabels: false },
      theme: colorScheme === "dark" ? "dark" : "default",
    });
    await mermaid.parse(source);
    renderSequence += 1;
    const { svg } = await mermaid.render(`neolix-mermaid-${renderSequence}`, source);
    return svg;
  });
  renderQueue = job.catch(() => undefined);
  return job;
}

export function mermaidSvgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/**
 * Mermaid sizes its SVG `width="100%"`, which an <img> resolves against its container, so the
 * diagram's own size comes from the viewBox.
 */
export function mermaidSvgSize(svg: string): { width: number; height: number } | null {
  const viewBox = /viewBox="([^"]+)"/
    .exec(svg)?.[1]
    ?.trim()
    .split(/[\s,]+/)
    .map(Number);
  if (!viewBox || viewBox.length !== 4) return null;
  const [, , width, height] = viewBox as [number, number, number, number];
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
    ? { width: Math.ceil(width), height: Math.ceil(height) }
    : null;
}
