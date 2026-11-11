import { DatabaseSync } from "node:sqlite";

// debt: node:sqlite exposes only a synchronous API. Importing another app's
// providers is an explicit user action that reads one bounded query from a
// small database, so the daemon's event loop blocks for that read. Move it
// into a worker if a source database ever grows enough for that to show.

/** Reads every row of one query from a database another app owns, read-only. */
export function readSqliteRows(
  dbPath: string,
  sql: string,
  params: (string | number)[] = [],
): Record<string, unknown>[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 3000");
    return db.prepare(sql).all(...params) as Record<string, unknown>[];
  } finally {
    db.close();
  }
}
