// FILE: scopedKeys.ts
// Purpose: Environment-scoped cache keys, so a project or thread id that exists
//   on two hosts never collides in renderer-local caches.
// Layer: Client runtime identity helper

/** `environmentId:localId`, the one separator used by every scoped cache. */
export function scopedKey(environmentId: string, localId: string): string {
  return `${environmentId}:${localId}`;
}

export function parseScopedKey(
  key: string,
): { readonly environmentId: string; readonly localId: string } | null {
  const separatorIndex = key.indexOf(":");
  if (separatorIndex <= 0 || separatorIndex >= key.length - 1) return null;
  return {
    environmentId: key.slice(0, separatorIndex),
    localId: key.slice(separatorIndex + 1),
  };
}
