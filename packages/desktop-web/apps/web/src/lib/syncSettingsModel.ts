// FILE: syncSettingsModel.ts
// Purpose: Turn the backend picked in Settings › Sync into the address form the
//   daemon accepts. The daemon derives the backend from the URL scheme alone
//   (`packages/server/src/server/sync/config.ts`), so the UI has to encode the
//   picked backend into `github://`, `s3://` or an HTTPS WebDAV address.
// Layer: Web settings logic.

export type SyncBackend = "webdav" | "s3" | "github";

export interface NormalizedSyncTarget {
  url: string;
  /** A branch read from a GitHub tree URL, when one was typed. */
  branch?: string;
}

const GITHUB_COM =
  /^https?:\/\/(?:www\.)?github\.com\/([^/?#]+)\/([^/?#]+?)(?:\.git)?(?:\/tree\/([^/?#]+)(?:\/(.*?))?)?\/?(?:[?#].*)?$/iu;

/**
 * The address to send for the picked backend. `github://owner/repo/prefix`
 * and `s3://bucket/prefix` are the daemon's own forms; a pasted GitHub web
 * address is reduced to the same shape so it is not mistaken for WebDAV.
 */
export function syncUrlForBackend(backend: SyncBackend, raw: string): NormalizedSyncTarget {
  const url = raw.trim();
  if (backend === "webdav") return { url };
  if (backend === "s3") {
    return { url: /^s3:\/\//iu.test(url) ? url : `s3://${url.replace(/^\/+/u, "")}` };
  }
  if (/^github:\/\//iu.test(url)) return { url };
  const github = GITHUB_COM.exec(url);
  if (github !== null) {
    const owner = github[1] ?? "";
    const repo = github[2] ?? "";
    const branch = github[3];
    const path = (github[4] ?? "").replace(/^\/+|\/+$/gu, "");
    return {
      url: `github://${owner}/${repo}${path ? `/${path}` : ""}`,
      ...(branch ? { branch } : {}),
    };
  }
  if (/^https?:\/\//iu.test(url)) {
    // Another host cannot be a GitHub address; leave it for the host to refuse.
    return { url };
  }
  return { url: `github://${url.replace(/^\/+/u, "")}` };
}
