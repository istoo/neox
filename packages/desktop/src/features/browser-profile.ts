// Electron persists this partition on disk; changing it would drop the user's in-app browser logins.
export const NEOLIX_BROWSER_PROFILE_PARTITION = "persist:neolix-browser";
const LEGACY_BROWSER_ID_PATTERN =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|\d{13,}-[0-9a-f]+)$/i;
const MAX_LEGACY_BROWSER_PROFILES = 1000;
// Chromium stores `persist:foo` under `Partitions/foo`; that is the only place a
// retired legacy profile is still visible once the old app stopped naming it.
const LEGACY_BROWSER_PARTITION_DIRECTORY_PREFIX = `${NEOLIX_BROWSER_PROFILE_PARTITION.replace(
  /^persist:/,
  "",
)}-`;

const NEOLIX_BROWSER_STORAGE_TYPES = [
  "cookies",
  "filesystem",
  "indexdb",
  "localstorage",
  "serviceworkers",
  "cachestorage",
  "shadercache",
] as const;

interface BrowserProfileSession {
  clearStorageData(options: {
    storages: Array<(typeof NEOLIX_BROWSER_STORAGE_TYPES)[number]>;
  }): Promise<void>;
  clearCache(): Promise<void>;
  clearAuthCache(): Promise<void>;
}

interface BrowserProfileGuest {
  readonly id: number;
  isDestroyed(): boolean;
  reload(): void;
}

interface BrowserProfileWebContents extends BrowserProfileGuest {
  readonly session: object;
  getType(): string;
}

interface ListBrowserProfileGuestsInput {
  profileSession: object;
  webContents: BrowserProfileWebContents[];
}

interface ClearBrowserProfileInput {
  profileSessions: BrowserProfileSession[];
  listGuests(): BrowserProfileGuest[];
  logReloadError(guestId: number, error: unknown): void;
}

interface ElectronSessions {
  fromPartition(partition: string): BrowserProfileSession;
}

export function getNeolixBrowserProfileSession(sessions: ElectronSessions): BrowserProfileSession {
  return sessions.fromPartition(NEOLIX_BROWSER_PROFILE_PARTITION);
}

export function readLegacyNeolixBrowserIds(input: unknown): string[] {
  if (!Array.isArray(input)) {
    return [];
  }
  const browserIds = new Set<string>();
  for (const value of input) {
    if (typeof value === "string" && LEGACY_BROWSER_ID_PATTERN.test(value)) {
      browserIds.add(value);
      if (browserIds.size >= MAX_LEGACY_BROWSER_PROFILES) {
        break;
      }
    }
  }
  return [...browserIds];
}

/**
 * Chromium stores a persistent partition under `Partitions/<name>` with the
 * `persist:` prefix stripped, so `persist:neolix-browser-<id>` leaves a
 * `neolix-browser-<id>` directory behind. Recover those ids from the directory
 * names; a partition only lives on disk if some retired tab actually used it.
 */
export function readLegacyNeolixBrowserIdsFromPartitionDirectory(
  names: Iterable<string>,
): string[] {
  const legacyBrowserIds: string[] = [];
  for (const name of names) {
    if (!name.startsWith(LEGACY_BROWSER_PARTITION_DIRECTORY_PREFIX)) {
      continue;
    }
    legacyBrowserIds.push(name.slice(LEGACY_BROWSER_PARTITION_DIRECTORY_PREFIX.length));
  }
  return readLegacyNeolixBrowserIds(legacyBrowserIds);
}

export function getNeolixBrowserProfileSessions(
  sessions: ElectronSessions,
  legacyBrowserIds: string[],
): [BrowserProfileSession, ...BrowserProfileSession[]] {
  return [
    getNeolixBrowserProfileSession(sessions),
    // COMPAT(browserProfile): added in v0.1.108; remove after 2027-01-15.
    ...legacyBrowserIds.map((browserId) =>
      sessions.fromPartition(`${NEOLIX_BROWSER_PROFILE_PARTITION}-${browserId}`),
    ),
  ];
}

export function getLegacyNeolixBrowserProfileSession(
  sessions: ElectronSessions,
  browserId: string,
): BrowserProfileSession | null {
  const [legacyBrowserId] = readLegacyNeolixBrowserIds([browserId]);
  return legacyBrowserId
    ? sessions.fromPartition(`${NEOLIX_BROWSER_PROFILE_PARTITION}-${legacyBrowserId}`)
    : null;
}

export function listNeolixBrowserProfileGuests(
  input: ListBrowserProfileGuestsInput,
): BrowserProfileGuest[] {
  return input.webContents.filter(
    (contents) =>
      !contents.isDestroyed() &&
      (contents.getType() === "webview" || contents.getType() === "window") &&
      contents.session === input.profileSession,
  );
}

export async function clearNeolixBrowserProfile(input: ClearBrowserProfileInput): Promise<void> {
  await Promise.all(
    input.profileSessions.flatMap((profileSession) => [
      profileSession.clearStorageData({ storages: [...NEOLIX_BROWSER_STORAGE_TYPES] }),
      profileSession.clearCache(),
      profileSession.clearAuthCache(),
    ]),
  );

  for (const guest of input.listGuests()) {
    if (guest.isDestroyed()) {
      continue;
    }
    try {
      guest.reload();
    } catch (error) {
      input.logReloadError(guest.id, error);
    }
  }
}
