// FILE: errorLocalization.ts
// Purpose: Render daemon/bridge failures in the reader's language. The daemon
//   is not localized, so recognizable failures are mapped here by stable
//   phrases; anything unknown keeps its original text after the RPC wrapper
//   (`Request failed: … requestType=… code=…`) is removed.
// Layer: Web settings logic.

import { t as i18nT } from "~/i18n";

export type Translator = (key: string, values?: Record<string, unknown>) => string;

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Removes the bridge's call wrapper, keeping the reason the daemon gave. */
export function unwrapRpcMessage(message: string): string {
  const marker = "Request failed:";
  const at = message.lastIndexOf(marker);
  const body = at >= 0 ? message.slice(at + marker.length) : message;
  return body.replace(/\s*requestType=[\w.]+\s*code=[\w-]+\s*$/u, "").trim();
}

function includesAny(text: string, phrases: readonly string[]): boolean {
  const lower = text.toLowerCase();
  return phrases.some((phrase) => lower.includes(phrase));
}

/**
 * Settings › Sync refusals raised by the daemon's `validateConfig`
 * (`packages/server/src/server/sync/service.ts`). The phrases are the daemon's
 * stable wording; an unknown failure falls through unchanged.
 */
export function localizeSyncError(error: unknown, translate: Translator = i18nT): string {
  const message = unwrapRpcMessage(messageOf(error));
  if (includesAny(message, ["the passphrase is the github token"])) {
    return translate("settings:hostData_syncGithubTokenIsPassphrase");
  }
  if (includesAny(message, ["github sync needs a token"])) {
    return translate("settings:hostData_syncNeedsGithubToken");
  }
  if (includesAny(message, ["the passphrase is the access key's secret"])) {
    return translate("settings:hostData_syncS3SecretIsPassphrase");
  }
  if (includesAny(message, ["s3 sync needs an access key id"])) {
    return translate("settings:hostData_syncNeedsS3AccessKey");
  }
  if (includesAny(message, ["type the secret for the access key"])) {
    return translate("settings:hostData_syncNeedsS3Secret");
  }
  if (includesAny(message, ["the passphrase is the server's password"])) {
    return translate("settings:hostData_syncPasswordIsPassphrase");
  }
  if (includesAny(message, ["sync needs a passphrase"])) {
    return translate("settings:hostData_syncNeedsPassphrase");
  }
  if (includesAny(message, ["type the password for this server"])) {
    return translate("settings:hostData_syncNeedsPasswordForServer");
  }
  return message;
}

/** Network and browser-page failures the daemon reports in English. */
export function localizeNetworkError(error: unknown, translate: Translator = i18nT): string {
  const message = unwrapRpcMessage(messageOf(error));
  if (includesAny(message, ["the listen address is controlled by neolix_listen"])) {
    return translate("settings:host_errorListenControlled");
  }
  const taken = /port\s+(\d+)\s+is taken by another program/iu.exec(message);
  if (taken !== null) {
    return translate("settings:host_pageErrorPortTaken", { port: taken[1] ?? "" });
  }
  const unavailable = /port\s+(\d+)\s+can't be taken\s*\(([^)]*)\)/iu.exec(message);
  if (unavailable !== null) {
    return translate("settings:host_pageErrorPortUnavailable", {
      port: unavailable[1] ?? "",
      detail: unavailable[2] ?? "",
    });
  }
  return message;
}

function quotedPath(message: string): string | null {
  const named = /no such file or directory,\s*(?:lstat|open|stat|access)\s+'([^']+)'/iu.exec(
    message,
  );
  if (named !== null) return named[1] ?? null;
  const firstPath = /'([^']*[\\/][^']*)'/u.exec(message);
  return firstPath?.[1] ?? null;
}

/**
 * Library (skills, MCP, hooks, subagents) failures. The bridge wraps the
 * daemon's reason, and git/file causes are common enough to explain in the
 * reader's language; anything else is shown unwrapped.
 */
export function localizeLibraryError(error: unknown, translate: Translator = i18nT): string {
  const message = unwrapRpcMessage(messageOf(error));
  if (includesAny(message, ["enoent", "no such file or directory", "lstat"])) {
    const path = quotedPath(message);
    return path === null
      ? translate("settings:library_errorPathMissingGeneric")
      : translate("settings:library_errorPathMissing", { path });
  }
  if (
    includesAny(message, [
      "url rejected",
      "malformed input to a url",
      "unable to access",
      "repository not found",
      "not a git repository",
      "could not read from remote repository",
      "could not resolve host",
    ])
  ) {
    return translate("settings:library_errorRepository");
  }
  if (includesAny(message, ["eacces", "eperm", "permission denied", "operation not permitted"])) {
    return translate("settings:library_errorPermission");
  }
  return message.length > 0 ? message : messageOf(error);
}
