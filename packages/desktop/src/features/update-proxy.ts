/**
 * myna's update client takes the proxy the rest of its requests take
 * (update.go proxied(), netproxy). Neolix's updater runs on Electron's net
 * stack: the system's proxy is the default, and the environment's proxy
 * variables are honored when they are set.
 */
export type UpdateProxyConfig =
  | { mode: "system" }
  | { proxyRules: string; proxyBypassRules?: string };

const PROXY_VARIABLES = [
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "ALL_PROXY",
  "all_proxy",
] as const;

function bypassRules(env: NodeJS.ProcessEnv): string | undefined {
  const value = env.NO_PROXY ?? env.no_proxy;
  if (!value?.trim()) {
    return undefined;
  }
  const rules = value
    .split(",")
    .map((rule) => rule.trim())
    .filter((rule) => rule !== "");
  return rules.length > 0 ? rules.join(",") : undefined;
}

/** The proxy the updater's downloads take: the environment's, else the system's. */
export function resolveUpdateProxy(env: NodeJS.ProcessEnv): UpdateProxyConfig {
  for (const variable of PROXY_VARIABLES) {
    const value = env[variable]?.trim();
    if (value) {
      const bypass = bypassRules(env);
      return {
        proxyRules: value,
        ...(bypass === undefined ? {} : { proxyBypassRules: bypass }),
      };
    }
  }
  return { mode: "system" };
}

/** Applies the resolved proxy to the session the updater downloads through. */
export async function applyUpdateProxy(
  setProxy: (config: UpdateProxyConfig) => Promise<void>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  try {
    await setProxy(resolveUpdateProxy(env));
  } catch {
    // A proxy the system refuses leaves Electron's own default in place.
  }
}
