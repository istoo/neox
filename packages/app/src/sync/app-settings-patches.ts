/**
 * The daemon keeps a copy of the app's settings and the time each key was
 * last written from outside the app — a `neolix settings set`, a sync pull or
 * a backup restore. At start the app adopts the keys changed while it was
 * closed — anything written after the app's own last save — and pushes its
 * merged settings back. A null entry is an unset: the daemon dropped the key,
 * and adopting null lets the settings schema fall back to this platform's
 * default.
 *
 * debt: the daemon's clock times the writes while the app's clock times its own
 * save; a remote host whose clock is skewed can order them the wrong way.
 * Upgrade path: compare a daemon-issued version or per-key vector instead.
 */
export function patchedSettingsSince(
  settings: Record<string, unknown> | null,
  patchedAt: Record<string, string> | undefined,
  localUpdatedAt: string | null,
): Record<string, unknown> {
  if (settings === null || patchedAt === undefined) {
    return {};
  }
  const since = localUpdatedAt === null ? 0 : Date.parse(localUpdatedAt);
  if (!Number.isFinite(since)) {
    return {};
  }
  const adopted: Record<string, unknown> = {};
  for (const [key, at] of Object.entries(patchedAt)) {
    const when = Date.parse(at);
    // A patch made while the app was open already arrived as an apply event;
    // the app's later write is newer, so it is not adopted again at start.
    if (Number.isFinite(when) && when > since) {
      adopted[key] = settings[key] ?? null;
    }
  }
  return adopted;
}
