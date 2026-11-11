// FILE: terminalFileDrop.ts
// Purpose: Turn terminal drops and clipboard images into shell-ready paths.
// Layer: Terminal UI helper (browser)
// Exports: path quoting, clipboard/drop file readers, and the upload call.

import { resolveDroppedFileAbsolutePath, readDroppedPathReferences } from "~/lib/composerDropPaths";
import { resolveWsHttpUrl } from "~/lib/wsHttpUrl";

// Mirrors the daemon's client-side path quoting: the path is pasted into a
// shell or TUI, so a space or one of these characters must not split it.
const DANGEROUS_NON_WINDOWS_PATH_CHARS = /[`$|&>~#!^*;<]/g;
const WINDOWS_PATH = /^(?:[A-Za-z]:[\\/]|\\\\)/;

function escapeNonWindowsPath(path: string): string {
  let nextPath = path;
  if (nextPath.includes("\\")) {
    nextPath = nextPath.replace(/\\/g, "\\\\");
  }
  nextPath = nextPath.replace(DANGEROUS_NON_WINDOWS_PATH_CHARS, "");
  if (nextPath.includes("'") && nextPath.includes('"')) {
    return `$'${nextPath.replace(/'/g, "\\'")}'`;
  }
  if (nextPath.includes("'")) {
    return `'${nextPath.replace(/'/g, "\\'")}'`;
  }
  return `'${nextPath}'`;
}

function escapeWindowsPath(path: string): string {
  return path.includes(" ") ? `"${path}"` : path;
}

export function prepareTerminalPath(path: string): string {
  return WINDOWS_PATH.test(path) ? escapeWindowsPath(path) : escapeNonWindowsPath(path);
}

export function prepareDroppedPathsForTerminal(paths: readonly string[]): string {
  return paths.map(prepareTerminalPath).join(" ");
}

/** The host path is pasted into a shell; keep its last segment unquotable. */
export function toShellSafeFileName(fileName: string): string {
  return fileName.replace(/[^\w.-]/g, "_");
}

export function imageExtension(mimeType: string): string {
  const subtype = mimeType.split("/")[1]?.split(/[+;]/)[0] ?? "";
  return subtype === "jpeg" ? "jpg" : subtype || "png";
}

/** Image files carried by a paste, with a generated name for nameless clipboard bytes. */
export function clipboardImageFiles(clipboardData: Pick<DataTransfer, "files" | "items">): File[] {
  const files = Array.from(clipboardData.files).filter((file) => file.type.startsWith("image/"));
  if (files.length > 0) return files;
  for (const item of Array.from(clipboardData.items)) {
    if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
    try {
      const file = item.getAsFile();
      if (file) files.push(file);
    } catch {
      continue;
    }
  }
  return files;
}

export function hasClipboardText(clipboardData: Pick<DataTransfer, "getData">): boolean {
  return clipboardData.getData("text/plain").length > 0;
}

export function namedClipboardImage(file: File): File {
  if (file.name.trim().length > 0) return file;
  return new File([file], `pasted-image-${Date.now()}.${imageExtension(file.type)}`, {
    type: file.type,
  });
}

export function droppedFilePaths(
  dataTransfer: Pick<DataTransfer, "files" | "items" | "types" | "getData">,
): { files: File[]; referencedPaths: string[] } {
  return {
    files: Array.from(dataTransfer.files),
    referencedPaths: readDroppedPathReferences(dataTransfer),
  };
}

export function absolutePathForDroppedFile(file: File): string | null {
  return resolveDroppedFileAbsolutePath(file);
}

/**
 * Uploads bytes to the host through the bridge and returns the path the
 * terminal should paste. Throws when the backend is remote: its upload route is
 * not part of the typed remote-resource surface.
 */
export async function uploadTerminalFile(file: File): Promise<string> {
  const name = toShellSafeFileName(file.name.trim() || `pasted-${Date.now()}`);
  const mimeType = file.type.trim() || "application/octet-stream";
  const query = new URLSearchParams({ name, mimeType }).toString();
  const response = await fetch(
    resolveWsHttpUrl(`/api/terminal/upload?${query}`, { requireBackend: true }),
    { method: "POST", body: file },
  );
  const payload = (await response.json().catch(() => null)) as { path?: unknown } | null;
  if (!response.ok || typeof payload?.path !== "string" || payload.path.length === 0) {
    throw new Error(`Uploading "${file.name}" failed.`);
  }
  return payload.path;
}
