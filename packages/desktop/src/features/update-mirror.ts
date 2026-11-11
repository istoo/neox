/**
 * myna's UpdateMirror: a prefix put before a release's github.com download
 * URL (https://mirror.example/https://github.com/…). The update feed and its
 * SHA-256 still come from GitHub, so the mirror only moves bytes.
 */

const RELEASE_PATH = "/releases/download/";

/** Whether a URL is a GitHub release asset download, the only kind mirrored. */
export function isGithubReleaseDownload(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname === "github.com" && parsed.pathname.includes(RELEASE_PATH);
  } catch {
    return false;
  }
}

/** The URL to fetch instead, or the same one when no mirror applies. */
export function mirroredDownloadUrl(mirror: string, url: string): string {
  const prefix = mirror.trim().replace(/\/+$/, "");
  if (prefix.length === 0 || !isGithubReleaseDownload(url)) {
    return url;
  }
  return `${prefix}/${url}`;
}
