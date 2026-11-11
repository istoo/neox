import type { GatewayProvider } from "./config.js";

/**
 * Codex offers its image tool, the namespace `image_gen` with the function
 * `imagegen`, to the provider it reads as the OpenAI actor. A vendor's plain
 * Responses API that knows no namespaces turns the whole request away with a
 * bare 400, so such a provider is asked again without the tool, and once that
 * works the tool is not offered there again. Ported from myna's
 * `image_tool.go`.
 */

const IMAGE_NAMESPACE = "image_gen";

const refused = new Set<string>();

/** A provider that may not take Codex's image tool: anything but OpenAI's own API. */
export function mayDropImageTool(provider: GatewayProvider): boolean {
  if (provider.protocol !== "openai-responses") {
    return false;
  }
  try {
    const host = new URL(provider.baseUrl).hostname.toLowerCase();
    return host !== "openai.com" && !host.endsWith(".openai.com");
  } catch {
    return false;
  }
}

/** Whether this provider turned the request away over the image tool before. */
export function imageToolRefusedBefore(providerId: string): boolean {
  return refused.has(providerId);
}

export function markImageToolRefused(providerId: string): void {
  refused.add(providerId);
}

/** The body with Codex's image tool taken out, and whether it had one. */
export function withoutImageTool(body: Record<string, unknown>): {
  body: Record<string, unknown>;
  had: boolean;
} {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const kept = tools.filter(
    (tool) => !(isRecord(tool) && tool.type === "namespace" && tool.name === IMAGE_NAMESPACE),
  );
  if (kept.length === tools.length) {
    return { body, had: false };
  }
  const next: Record<string, unknown> = { ...body, tools: kept };
  if (kept.length === 0) {
    delete next.tools;
    delete next.tool_choice;
  }
  return { body: next, had: true };
}

/**
 * A translated Responses request with Codex's image tool gone. Codex offers
 * it flat as `image_gen__imagegen`, so a tool whose name carries the
 * namespace prefix goes with it.
 */
export function withoutImageToolRequest(body: Record<string, unknown>): {
  body: Record<string, unknown>;
  had: boolean;
} {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const kept = tools.filter((tool) => {
    if (typeof tool === "string") {
      return !tool.startsWith(`${IMAGE_NAMESPACE}__`);
    }
    if (!isRecord(tool)) {
      return true;
    }
    if (tool.type === "namespace" && tool.name === IMAGE_NAMESPACE) {
      return false;
    }
    return !toolName(tool).startsWith(`${IMAGE_NAMESPACE}__`);
  });
  if (kept.length === tools.length) {
    return { body, had: false };
  }
  const next: Record<string, unknown> = { ...body, tools: kept };
  if (kept.length === 0) {
    delete next.tools;
    delete next.tool_choice;
  }
  return { body: next, had: true };
}

/** Responses spells a function's name flat; Chat nests it under function. */
function toolName(tool: Record<string, unknown>): string {
  if (typeof tool.name === "string") {
    return tool.name;
  }
  return isRecord(tool.function) && typeof tool.function.name === "string"
    ? tool.function.name
    : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
