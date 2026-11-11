/**
 * What the CLI reads and writes for sync and backup without a daemon: the
 * setup file, the last sync's state, and a sealed file. Runtime actions
 * (`now`, `restore`, `undo`, `upload`, `dismiss`) go through the daemon's
 * RPCs instead, so the daemon's in-memory config stays authoritative.
 */
export {
  backendOf,
  defaultSyncConfig,
  loadSyncConfig,
  MANUAL_INTERVAL,
  saveSyncConfig,
  syncConfigPath,
  syncConfigView,
  type SyncConfig,
  type SyncConfigView,
} from "./config.js";
export { loadState, stateKey, type SyncState } from "./engine.js";
export {
  BACKUP_EXT,
  backupsDir,
  exportBackup,
  listBackups,
  loadAutoConfig,
  restoreBackup,
  runAutoBackup,
  saveAutoConfig,
  type BackupAutoConfig,
  type BackupEntry,
} from "./backup.js";
export { SYNC_PARTS, type SyncPart } from "./parts.js";
