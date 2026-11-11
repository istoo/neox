import { fetch as undiciFetch } from "undici";
import { upstreamDispatcher } from "./dispatchers.js";

/**
 * The fetch a sign-in or a token refresh goes through. myna signs in
 * through the proxy the account's requests will use
 * (`provider/signin.go:145-160`): the vendor then sees the account signed
 * in from where it is used from. A proxy is an address, "direct" for
 * none, or "" for the daemon's own (settings, environment, system).
 */
export function fetchThroughProxy(
  proxy: string | null | undefined,
  base?: typeof fetch,
): typeof fetch {
  const choice = (proxy ?? "").trim();
  const inner = base ?? (undiciFetch as unknown as typeof fetch);
  if (choice === "") {
    return inner;
  }
  const dispatcher = upstreamDispatcher({ proxy: choice });
  return ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    inner(input as never, { ...init, dispatcher } as never)) as typeof fetch;
}

/** The proxy an account's requests go through; "" when it names none. */
export function proxyOfAccount(account: { proxy?: string | null }): string {
  return (account.proxy ?? "").trim();
}
