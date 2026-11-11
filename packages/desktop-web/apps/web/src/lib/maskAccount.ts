/**
 * An account's name with its middle hidden, for a card read over someone's shoulder.
 * An email keeps its domain and the first letter — that is how two accounts of one
 * vendor are told apart — and everything else keeps its first and last two characters.
 */
export function maskAccount(name: string): string {
  const trimmed = name.trim();
  const at = trimmed.lastIndexOf("@");
  if (at > 0) {
    const local = trimmed.slice(0, at);
    const domain = trimmed.slice(at);
    return `${local.slice(0, 1)}${"•".repeat(Math.max(2, Math.min(6, local.length - 1)))}${domain}`;
  }
  if (trimmed.length <= 4) {
    return "•".repeat(Math.max(2, trimmed.length));
  }
  return `${trimmed.slice(0, 2)}${"•".repeat(Math.min(6, trimmed.length - 4))}${trimmed.slice(-2)}`;
}
