/**
 * What the reader folded in a JSON tree, by the body's key and the node's
 * path — myna's jsonFolds (plugins/gateway/client.js). A node nobody folded
 * is open, whatever its depth: a body opened for the first time is drawn
 * whole. Kept outside React so a tab switch, which remounts the tree, does
 * not forget it.
 */

const nodeOpen = new Map<string, boolean>();
const MAX_REMEMBERED_NODES = 5000;

/** The key a node's state is kept under: its body and its place in it. */
export function jsonNodeKey(stateKey: string, path: string): string {
  return `${stateKey}|${path}`;
}

/** Open unless the reader folded this node before. */
export function jsonNodeOpen(stateKey: string, path: string): boolean {
  return nodeOpen.get(jsonNodeKey(stateKey, path)) ?? true;
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
