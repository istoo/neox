// FILE: appSettingsSync.logic.ts
// Purpose: Pure rules for adopting the daemon's synced copy of the app settings:
//   which keys were written outside this app while it was closed, and how the
//   opaque JSON record becomes a typed settings patch.
// Layer: Web settings logic

/**
 * The daemon keeps a copy of the app's settings and the time each key was last
 * written from outside the app — a `neolix settings set`, a sync pull or a
 * backup restore. At start the app adopts the keys changed while it was closed
 * — anything written after the app's own last save — and pushes its merged
 * settings back. A null entry is an unset: the daemon dropped the key, and
 * adopting null lets the caller fall back to its own default.
 *
 * debt: the daemon's clock times the writes while this app's clock times its
 * own save; a host whose clock is skewed can order them the wrong way. Upgrade
 * path: compare a daemon-issued version or per-key vector instead.
 */
export function patchedSettingsSince(
  settings: Record<string, unknown> | null,
  patchedAt: Record<string, string> | undefined,
  localUpdatedAt: string | null,
): Record<string, unknown> {
  if (settings === null || patchedAt === undefined) return {};
  const since = localUpdatedAt === null ? 0 : Date.parse(localUpdatedAt);
  if (!Number.isFinite(since)) return {};
  const adopted: Record<string, unknown> = {};
  for (const [key, at] of Object.entries(patchedAt)) {
    const when = Date.parse(at);
    if (Number.isFinite(when) && when > since) {
      adopted[key] = settings[key] ?? null;
    }
  }
  return adopted;
}

/**
 * Keeps only the keys this build knows, and turns a daemon-side `null` into the
 * caller's default: the wire record is schema-less, so an unknown key must
 * never reach the settings patch as a surprise field.
 */
export function toSettingsPatch(
  adopted: Record<string, unknown>,
  defaults: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(adopted)) {
    if (!Object.hasOwn(defaults, key)) continue;
    patch[key] = value === null ? defaults[key] : value;
  }
  return patch;
}
