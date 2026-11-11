// One mapping between Neox providers and Synara provider instances, shared by thread
// translation and the provider RPCs so a thread's model always resolves to a listed instance.
// Every Neox provider becomes a Synara instance whose id is the Neox provider id; its driver
// is the Synara kind it runs as (that picks the icon and the per-driver UI). Providers Synara has
// no driver for run under Claude's driver, which matches how the Neox gateway runs them.
import type { ProviderKind } from "@synara/contracts";

const DRIVER_FOR_PROVIDER: Record<string, ProviderKind> = {
  claude: "claudeAgent",
  codex: "codex",
  opencode: "opencode",
  pi: "pi",
  antigravity: "antigravity",
  cursor: "cursor",
  grok: "grok",
  droid: "droid",
  devin: "devin",
};

export function driverForProvider(neolixProvider: string): ProviderKind {
  return DRIVER_FOR_PROVIDER[neolixProvider] ?? "claudeAgent";
}

/**
 * A Neox provider Synara has a driver for takes that driver's default instance id
 * (`claude` → `claudeAgent`), the one the front end always lists. Any other provider becomes
 * an extra instance whose id is a slug of its name (letter first, then letters, digits, `_`,
 * `-`), which the front end only knows once settings declare it ({@link providerInstanceConfigs}).
 */
export function instanceIdForProvider(neolixProvider: string): string {
  const driver = DRIVER_FOR_PROVIDER[neolixProvider];
  if (driver) return driver;
  const slug = neolixProvider.replace(/[^A-Za-z0-9_-]/g, "-").replace(/^[^A-Za-z]+/, "");
  return slug.length > 0 ? slug.slice(0, 64) : "neolix";
}

/**
 * Settings entries for the providers that are not a driver's default instance. None of them
 * has a driver of its own: Claude's driver only runs them, so `config.ownIdentity` tells the
 * front end to show the provider's own name and mark instead of filing it as a Claude account.
 */
export function providerInstanceConfigs(
  providers: readonly { readonly provider: string; readonly available: boolean }[],
  label: (neolixProvider: string) => string,
): Record<
  string,
  { driver: ProviderKind; displayName: string; enabled: boolean; config: { ownIdentity: true } }
> {
  const configs: Record<
    string,
    { driver: ProviderKind; displayName: string; enabled: boolean; config: { ownIdentity: true } }
  > = {};
  for (const { provider, available } of providers) {
    if (DRIVER_FOR_PROVIDER[provider]) continue;
    configs[instanceIdForProvider(provider)] = {
      driver: driverForProvider(provider),
      displayName: label(provider),
      enabled: available,
      config: { ownIdentity: true },
    };
  }
  return configs;
}

/** Reverse of {@link instanceIdForProvider} over the providers the daemon reported. */
/** How often a miss may re-read the daemon's provider list. */
const DIRECTORY_REFRESH_INTERVAL_MS = 5_000;

export class ProviderDirectory {
  private byInstance = new Map<string, string>();
  private refreshedAt = 0;

  update(neolixProviders: readonly string[]): void {
    this.byInstance = new Map(neolixProviders.map((p) => [instanceIdForProvider(p), p]));
    this.refreshedAt = Date.now();
  }

  neolixProviderFor(input: {
    readonly provider: string;
    readonly instanceId?: string | undefined;
  }): string | null {
    if (input.instanceId) {
      const direct = this.byInstance.get(input.instanceId);
      if (direct) return direct;
    }
    for (const neolix of this.byInstance.values()) {
      if (driverForProvider(neolix) === input.provider && DRIVER_FOR_PROVIDER[neolix])
        return neolix;
    }
    return null;
  }

  /**
   * Like {@link neolixProviderFor}, but a miss re-reads the daemon's list first. The list is
   * otherwise filled when the client reads the server config, so a model or command request
   * that arrives before that (or after a provider was added) would report the provider as
   * missing. Re-reads are spaced out so lookups for providers that really are absent stay cheap.
   */
  async resolve(
    client: {
      listAvailableProviders(): Promise<{ providers: ReadonlyArray<{ provider: string }> }>;
    },
    input: { readonly provider: string; readonly instanceId?: string | undefined },
  ): Promise<string | null> {
    const known = this.neolixProviderFor(input);
    if (known || Date.now() - this.refreshedAt < DIRECTORY_REFRESH_INTERVAL_MS) return known;
    const { providers } = await client.listAvailableProviders();
    this.update(providers.map((entry) => entry.provider));
    return this.neolixProviderFor(input);
  }
}
