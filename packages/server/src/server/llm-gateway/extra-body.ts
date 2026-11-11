/**
 * A provider's own JSON fields, added to every request body the gateway sends
 * it. A field the request already carries is kept; `!name` replaces it, which
 * is how myna spells "replace".
 */
export function applyExtraBody(
  body: Record<string, unknown>,
  extra: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (extra === undefined) {
    return body;
  }
  const merged: Record<string, unknown> = { ...body };
  for (const [key, value] of Object.entries(extra)) {
    if (key.startsWith("!")) {
      merged[key.slice(1)] = value;
    } else if (!(key in merged)) {
      merged[key] = value;
    }
  }
  return merged;
}
