import type { ToolCallDetail } from "../agent-types.js";
import { getNeolixToolLeafName, isNeolixToolName } from "../tool-name-normalization.js";
import { getNeolixToolEntry, NEOLIX_TOOL_CATALOG, type NeolixToolName } from "./catalog.js";
import { toSummaryText } from "./summary-text.js";

export { buildAgentMessageDisplay, type AgentMessageDisplay } from "./agent-message.js";
export {
  buildNeolixToolDetailSections,
  type NeolixToolDetailField,
  type NeolixToolDetailSection,
} from "./detail-sections.js";
export { MAX_SUMMARY_CHARS } from "./summary-text.js";
export type { NeolixToolName };

export interface NeolixToolDisplayInput {
  toolName: string;
  detail: ToolCallDetail;
  /** Title of the agent named by the call's `agentId`, when the caller knows it. */
  targetAgentTitle?: string;
}

export interface NeolixToolDisplay {
  displayName: string;
  summary?: string;
}

export const NEOLIX_TOOL_NAMES = Object.keys(NEOLIX_TOOL_CATALOG) as readonly NeolixToolName[];

/** Returns null for tools outside the Neolix namespace. */
export function buildNeolixToolDisplay(input: NeolixToolDisplayInput): NeolixToolDisplay | null {
  // Canonical details own internal lifecycle rows such as worktree setup.
  if (input.detail.type !== "unknown") return null;
  const leafName = neolixLeafName(input.toolName);
  if (!leafName) return null;
  const entry = getNeolixToolEntry(leafName);
  if (!entry) return { displayName: humanizeLeafName(leafName) };

  const toolInput = readToolInput(input.detail);
  const targetAgent = input.targetAgentTitle ?? readString(toolInput.agentId);
  const summary = formatContext(entry.context?.(toolInput, targetAgent));
  return { displayName: entry.label, ...(summary ? { summary } : {}) };
}

/** A semantic action label for summaries, sharing the tool presentation catalog. */
export function getNeolixToolActionLabel(toolName: string): string | null {
  const leafName = neolixLeafName(toolName);
  if (!leafName) return null;
  return getNeolixToolEntry(leafName)?.completedLabel ?? humanizeLeafName(leafName);
}

/** The agent a Neolix call acts on, so callers can resolve its title. */
export function getNeolixToolTargetAgentId(
  toolName: string,
  detail: ToolCallDetail | undefined,
): string | null {
  if (!detail || !neolixLeafName(toolName)) return null;
  return readString(readToolInput(detail).agentId) ?? null;
}

function neolixLeafName(toolName: string): string | null {
  if (isNeolixToolName(toolName)) return getNeolixToolLeafName(toolName);
  const normalized = toolName.trim().toLowerCase();
  return normalized.startsWith("neolix_") && !normalized.startsWith("neolix__")
    ? normalized.slice("neolix_".length)
    : null;
}

function readToolInput(detail: ToolCallDetail): Readonly<Record<string, unknown>> {
  if (detail.type !== "unknown") return {};
  const value = detail.input;
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function formatContext(value: unknown): string | undefined {
  if (typeof value === "string") return toSummaryText(value);
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) {
    const [first, ...rest] = value;
    const head = typeof first === "string" ? toSummaryText(first) : undefined;
    if (!head) return undefined;
    return rest.length > 0 ? `${head} +${rest.length}` : head;
  }
  return undefined;
}

function humanizeLeafName(leafName: string): string {
  const sentence = leafName
    .replace(/[._-]+/g, " ")
    .trim()
    .toLowerCase();
  return `${sentence[0]?.toUpperCase() ?? ""}${sentence.slice(1)}`;
}
