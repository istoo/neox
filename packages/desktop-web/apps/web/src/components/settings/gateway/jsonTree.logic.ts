// FILE: jsonTree.logic.ts
// Purpose: The parts of the JSON tree that are not React: which nodes the
//          reader folded, when a body is JSON at all, and what a node copies.
//          Folds are kept outside React so a tab switch, which remounts the
//          tree, does not forget them.
// Layer: Settings gateway logic

/**
 * A container wider than this starts folded: request bodies can hold hundreds
 * of messages, and drawing all of them before the reader asks is the slowest
 * thing this page can do. Smaller bodies keep myna's all-open default.
 */
export const JSON_LAZY_CHILD_THRESHOLD = 50;

/** How many children one open container draws before offering the rest. */
export const JSON_CHILD_PAGE = 100;

const MAX_REMEMBERED_NODES = 5000;

const nodeOpen = new Map<string, boolean>();

/** The key a node's state is kept under: its body and its place in it. */
export function jsonNodeKey(stateKey: string, path: string): string {
  return `${stateKey}|${path}`;
}

/** A container nobody folded is open when it is small enough to draw whole. */
export function jsonDefaultOpen(childCount: number): boolean {
  return childCount <= JSON_LAZY_CHILD_THRESHOLD;
}

/** Open unless the reader folded this node, or it is too large to draw whole. */
export function jsonNodeOpen(stateKey: string, path: string, childCount: number): boolean {
  return nodeOpen.get(jsonNodeKey(stateKey, path)) ?? jsonDefaultOpen(childCount);
}

/** Keeps a fold or an unfold, forgetting the oldest node past the cap. */
export function rememberJsonNode(stateKey: string, path: string, open: boolean): void {
  const key = jsonNodeKey(stateKey, path);
  nodeOpen.delete(key);
  nodeOpen.set(key, open);
  if (nodeOpen.size > MAX_REMEMBERED_NODES) {
    const oldest = nodeOpen.keys().next().value;
    if (oldest !== undefined) {
      nodeOpen.delete(oldest);
    }
  }
}

/** Forgets every fold, so one test does not decide another's. */
export function resetJsonFolds(): void {
  nodeOpen.clear();
}

/**
 * The parsed body when it is a JSON object or array; null when it is text, a
 * cut-off body, or a bare primitive, all of which stay with the plain view.
 */
export function parseJsonBody(text: string): unknown[] | Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return null;
  }
  try {
    const value: unknown = JSON.parse(trimmed);
    return typeof value === "object" && value !== null
      ? (value as unknown[] | Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** The tree's rows for a container, objects by key and arrays by position. */
export function jsonEntries(value: unknown[] | Record<string, unknown>): [string, unknown][] {
  return Array.isArray(value)
    ? value.map((item, index) => [String(index), item])
    : Object.entries(value);
}

/** What Copy value puts on the clipboard: a string as written, else its JSON. */
export function valueCopyText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value, null, 2) ?? String(value);
}

/** A primitive as it appears in JSON; undefined survives as its name. */
export function primitiveText(value: unknown): string {
  const text = JSON.stringify(value);
  return text === undefined ? String(value) : text;
}
