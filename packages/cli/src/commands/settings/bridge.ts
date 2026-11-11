import { connectToDaemon } from "../../utils/client.js";
import type { CommandOptions } from "../../output/index.js";

/**
 * The app's settings live in the app's own storage; the daemon keeps a copy
 * the app pushes (sync.app_settings.export) and hands a single key back to the
 * app to apply (sync.app_settings.patch). A key the app owns is read and
 * written here, and a daemon that can't be reached is an error rather than a
 * write that never lands.
 */

type Daemon = Awaited<ReturnType<typeof connectToDaemon>>;

function causeText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

async function withDaemon<T>(
  options: CommandOptions,
  work: (client: Daemon) => Promise<T>,
): Promise<T> {
  let client: Daemon;
  try {
    client = await connectToDaemon({ target: options.daemonTarget, timeout: 1_500 });
  } catch (cause) {
    throw new Error(
      `app settings are kept by the app and read through the daemon, which is not reachable: ${causeText(cause)}. Nothing was changed.`,
      { cause },
    );
  }
  try {
    return await work(client);
  } finally {
    await client.close();
  }
}

/** The app's settings, as the daemon keeps its copy; null before the app pushes one. */
export function readAppSettings(options: CommandOptions): Promise<Record<string, unknown> | null> {
  return withDaemon(options, async (client) => {
    const answer = await client.getSyncAppSettings();
    return answer.settings ?? null;
  });
}

/** Writes one app setting; the app applies it when it receives the change. Null unsets it. */
export function patchAppSetting(
  options: CommandOptions,
  key: string,
  value: unknown,
): Promise<void> {
  return withDaemon(options, async (client) => {
    const answer = await client.patchSyncAppSetting(key, value);
    if (answer.error !== undefined) {
      throw new Error(`${key}: ${answer.error}: nothing was changed`);
    }
  });
}
