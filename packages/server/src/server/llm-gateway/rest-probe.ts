import type { Logger } from "pino";
import type { GatewayAccount, GatewayProvider } from "./config.js";
import type { RestTable } from "./routing.js";
import { fetchProviderModels } from "./provider-probe.js";

/**
 * A key resting after an outage that names no time — a 5xx, its vendor
 * unreachable — rests while the keys beside it take the requests, so nothing
 * asks it whether it is back before its rest ends (myna's rest_probe.go).
 * The gateway asks it in the background instead: its vendor's model list,
 * with the key and its base URL, a minute into its rest, then two minutes on,
 * then five, then every ten, and lifts the rest as soon as the list answers.
 *
 * A list costs no allowance. None is asked of an account signed in as an
 * agent, a rest the vendor or the user named (out of quota or credit, a
 * Retry-After), or one model alone.
 */

const STEPS_MS = [60_000, 2 * 60_000, 5 * 60_000, 10 * 60_000] as const;
const PROBE_WAIT_MS = 20_000;
export const PROBE_MISS_MS = 30 * 60_000;
const TICK_MS = 5_000;

interface Probe {
  provider: GatewayProvider;
  account: GatewayAccount | null;
  until: number;
  next: number;
  step: number;
  busy: boolean;
}

interface Config {
  rest: RestTable;
  logger: Logger;
  /** Asks the vendor's model list; overridable in tests. */
  listModels?: (provider: GatewayProvider, account: GatewayAccount | null) => Promise<void>;
  /** Called when a probe lifted a rest, for persistence. */
  onCleared?: (key: string) => void;
}

let config: Config | null = null;
let timer: NodeJS.Timeout | null = null;
const probes = new Map<string, Probe>();
const lifted = new Map<string, number>();
const missed = new Set<string>();

/** Wires the prober to a gateway's rests; called once at daemon start. */
export function configureRestProbe(input: Config): void {
  config = input;
  if (timer === null) {
    timer = setInterval(() => void runRestProbes(), TICK_MS);
    timer.unref();
  }
}

export function disposeRestProbe(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
  probes.clear();
  lifted.clear();
  missed.clear();
  config = null;
}

/** Whether a rest just taken is one asked again in the background. */
export function probeableRest(
  account: GatewayAccount | null,
  status: number,
  retryAfterMs: number,
  until: number,
  now: number,
): boolean {
  if (retryAfterMs > 0 || account?.agent !== undefined) {
    return false;
  }
  if (status !== 0 && status !== 408 && status < 500) {
    return false;
  }
  // Worth asking only if the first ask comes at least half a step before the
  // rest ends on its own.
  return now + STEPS_MS[0] < until - STEPS_MS[0] / 2;
}

/** Has the gateway ask the key again during its rest. */
export function scheduleRestProbe(input: {
  key: string;
  provider: GatewayProvider;
  account: GatewayAccount | null;
  until: number;
  status: number;
  retryAfterMs?: number;
  now?: number;
}): void {
  if (config === null || probes.has(input.key)) {
    return;
  }
  const now = input.now ?? Date.now();
  if (!probeableRest(input.account, input.status, input.retryAfterMs ?? 0, input.until, now)) {
    return;
  }
  if (missed.has(input.key)) {
    return;
  }
  probes.set(input.key, {
    provider: input.provider,
    account: input.account,
    until: input.until,
    next: now + STEPS_MS[0],
    step: 0,
    busy: false,
  });
}

/** A probe lifted this key's rest a moment ago and it failed again. */
export function restProbeMissed(key: string, now: number = Date.now()): boolean {
  const at = lifted.get(key);
  if (at !== undefined) {
    lifted.delete(key);
    if (now - at < PROBE_MISS_MS) {
      missed.add(key);
    }
  }
  return missed.has(key);
}

/** The key answered a request: a later outage may be asked again. */
export function restProbeAnswered(key: string): void {
  lifted.delete(key);
  missed.delete(key);
}

export async function runRestProbes(now: number = Date.now()): Promise<void> {
  const current = config;
  if (current === null) {
    return;
  }
  for (const [key, probe] of probes) {
    if (!restingAt(current.rest, key, probe.until, now)) {
      probes.delete(key);
      continue;
    }
    if (probe.busy || now < probe.next) {
      continue;
    }
    probe.busy = true;
    await ask(current, key, probe, now);
  }
}

function restingAt(rest: RestTable, key: string, until: number, now: number): boolean {
  return rest.until(key, now) === until;
}

async function ask(current: Config, key: string, probe: Probe, now: number): Promise<void> {
  const list = current.listModels ?? defaultListModels;
  let failed = false;
  try {
    await withTimeout(list(probe.provider, probe.account), PROBE_WAIT_MS);
  } catch {
    failed = true;
  }
  // The tick's clock: what the rest was timed against, not the wall clock a
  // list spent its wait on.
  const after = now;
  if (failed) {
    probe.busy = false;
    probe.step += 1;
    probe.next = after + STEPS_MS[Math.min(probe.step, STEPS_MS.length - 1)]!;
    if (probe.next < probe.until - STEPS_MS[0] / 2) {
      probes.set(key, probe);
    } else {
      probes.delete(key);
    }
    return;
  }
  probes.delete(key);
  if (!restingAt(current.rest, key, probe.until, after)) {
    return;
  }
  current.rest.clear(key);
  current.onCleared?.(key);
  lifted.set(key, after);
  current.logger.info(
    { key, provider: probe.provider.id },
    "A resting account answered again; its rest is lifted",
  );
  void now;
}

function defaultListModels(
  provider: GatewayProvider,
  account: GatewayAccount | null,
): Promise<void> {
  return fetchProviderModels({
    protocol: provider.protocol,
    baseUrl: account?.baseUrl ?? provider.baseUrl,
    apiKey: account?.apiKey ?? provider.apiKey,
    headers: { ...provider.headers, ...account?.headers },
    insecureTls: provider.insecureTls,
    // The account's requests go through its proxy; asking its vendor
    // directly would report a proxy-only account as down (myna's probe
    // uses the same upstream connection settings).
    ...(account?.proxy === undefined ? {} : { proxy: account.proxy }),
  }).then(() => undefined);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("probe timed out")), ms);
      timeout.unref();
    }),
  ]);
}
