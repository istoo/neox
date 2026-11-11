/**
 * A provider's model list kept fresh on its own schedule (myna's
 * KeepListsFresh, autolist.go): the provider that sets `refreshEveryMs` is
 * asked for its list that often, and the models a rule newly matches join
 * what it serves (`auto-include.ts`).
 *
 * When a list was last fetched is kept on the provider (`listFetchedAt`,
 * myna's Fetched), so a daemon start asks only a list that is due; a
 * failed fetch is tried again after a retry, as myna's listRetry.
 */
import type { Logger } from "pino";
import type { GatewayProvider } from "./config.js";

/** myna's listsEvery: how often a due list is looked for. */
const TICK_MS = 60_000;
/** myna's first look after start. */
const FIRST_TICK_MS = 30_000;
/** myna's MinRefreshEvery, and listRetry. */
const MIN_EVERY_MS = 10 * 60_000;
const RETRY_MS = 15 * 60_000;

export interface ListRefreshOptions {
  providers: () => readonly GatewayProvider[];
  /** Fetches one provider's model list now; throws when the vendor refuses. */
  fetchModels: (provider: GatewayProvider) => Promise<readonly string[]>;
  /** Merges a fetched list into the saved provider; answers the models taken. */
  take: (providerId: string, listed: readonly string[]) => Promise<readonly string[]>;
  logger: Logger;
  now?: () => number;
}

export class ListRefreshScheduler {
  private readonly nextAt = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private firstTimer: NodeJS.Timeout | null = null;

  constructor(private readonly options: ListRefreshOptions) {}

  public start(): void {
    this.firstTimer = setTimeout(() => {
      void this.tick();
    }, FIRST_TICK_MS);
    this.firstTimer.unref();
    this.timer = setInterval(() => {
      void this.tick();
    }, TICK_MS);
    this.timer.unref();
  }

  public dispose(): void {
    if (this.firstTimer !== null) {
      clearTimeout(this.firstTimer);
      this.firstTimer = null;
    }
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Fetches every provider whose list is due now, one after another. */
  public async tick(): Promise<void> {
    const now = this.now();
    for (const provider of this.options.providers()) {
      if (this.due(provider, now)) {
        await this.refreshOne(provider, now);
      }
    }
  }

  /**
   * Fetches a provider's list now, through the scheduler's own path: the
   * retry guard applies and a fetched list is merged and stamped, but an
   * ask counts whatever the schedule says. Naming one provider asks it even
   * when an account or a decision API keeps its list (myna's
   * `RefreshLists`, which `neolix sync` uses); with no id, every provider of
   * the user's own is asked. Answers the providers asked, so an RPC can
   * reuse the same de-duplication and retry.
   */
  public async refreshNow(providerId?: string): Promise<string[]> {
    const now = this.now();
    const asked: string[] = [];
    for (const provider of this.options.providers()) {
      if (providerId !== undefined && provider.id !== providerId) {
        continue;
      }
      const eligible =
        providerId === undefined ? this.ownList(provider) : provider.enabled !== false;
      if (!eligible || now < (this.nextAt.get(provider.id) ?? 0)) {
        continue;
      }
      await this.refreshOne(provider, now);
      asked.push(provider.id);
    }
    return asked;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  /** Whether the provider's own list is due at now (myna's Fetched). */
  private due(provider: GatewayProvider, now: number): boolean {
    const every = provider.refreshEveryMs;
    if (every === undefined || !this.ownList(provider)) {
      return false;
    }
    const interval = Math.max(every, MIN_EVERY_MS);
    if (now < (this.nextAt.get(provider.id) ?? 0)) {
      return false;
    }
    // The list is due once the fetch it records is that old; one never
    // fetched is due at once, as myna reads it.
    const fetchedAt = provider.listFetchedAt;
    return fetchedAt === undefined || now - fetchedAt >= interval;
  }

  /**
   * myna's ownList: a key+URL provider's list is the user's to keep fresh;
   * an account's list, a plugin's and a decision API's are fetched for
   * them, not here.
   */
  private ownList(provider: GatewayProvider): boolean {
    return (
      provider.enabled !== false &&
      (provider.accounts?.length ?? 0) === 0 &&
      provider.decide === undefined
    );
  }

  private async refreshOne(provider: GatewayProvider, now: number): Promise<void> {
    const interval = Math.max(provider.refreshEveryMs ?? MIN_EVERY_MS, MIN_EVERY_MS);
    try {
      const listed = await this.options.fetchModels(provider);
      const taken = await this.options.take(provider.id, listed);
      this.nextAt.set(provider.id, now + interval);
      if (taken.length > 0) {
        this.options.logger.info(
          { provider: provider.id, models: [...taken] },
          "Its list listed new models a rule takes",
        );
      }
    } catch (error) {
      // myna's listRetry: a failed fetch waits, less when the schedule is
      // shorter than the retry.
      this.nextAt.set(provider.id, now + Math.min(interval, RETRY_MS));
      this.options.logger.warn(
        { err: error, provider: provider.id },
        "Cannot refresh the provider's model list",
      );
    }
  }
}
