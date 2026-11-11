// FILE: hostSettingsValidation.ts
// Purpose: The small input checks the host settings panels share: ports, the
//   collector endpoint, and whether a selection may be deleted.
// Layer: Web settings logic.

/** A daemon port the dialog accepts: 1024–65535; 0 is not offered here. */
export function parseDaemonPort(value: string): number | null {
  const text = value.trim();
  if (!/^\d+$/u.test(text)) return null;
  const port = Number(text);
  return port >= 1024 && port <= 65535 ? port : null;
}

/** An OpenTelemetry collector endpoint: an HTTP(S) URL with a host. */
export function isCollectorEndpoint(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname.length > 0;
  } catch {
    return false;
  }
}

/** A session group's heading; an unrecorded cwd gets a localized fallback. */
export function groupTitleOf(cwd: string, unknownLabel: string): string {
  return cwd.trim().length > 0 ? cwd : unknownLabel;
}

/** A selection is deletable only when every session in it allows deletion. */
export function canDeleteSessions(
  sessions: ReadonlyArray<{ readonly deletable: boolean }>,
): boolean {
  return sessions.length > 0 && sessions.every((session) => session.deletable);
}
