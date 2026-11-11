import { Agent, ProxyAgent } from "undici";
import { isSocksProxy, parseProxyAddress } from "../network/proxy-config.js";
import { readyBridgeUrl } from "../network/bridge.js";

/**
 * The undici dispatcher an upstream request goes through. One permissive
 * agent and one direct agent are shared: the flags are the only inputs, and
 * an agent per request would leak connection pools.
 *
 * A proxy of a provider's own (myna's `With`) is "direct" for none,
 * socks5:// for a SOCKS proxy, or an http(s):// address. A SOCKS one is
 * replaced by its loopback bridge, which undici can speak to. An absent
 * proxy follows the daemon's dispatcher, which already carries the
 * settings, *_PROXY and system proxy.
 */
let permissiveAgent: Agent | undefined;
let directAgent: Agent | undefined;

export function upstreamDispatcher(input: {
  insecureTls?: boolean;
  proxy?: string;
}): Agent | ProxyAgent | undefined {
  if (input.proxy !== undefined) {
    const choice = input.proxy.trim();
    if (choice === "direct") {
      directAgent ??= new Agent();
      return directAgent;
    }
    const bridged = isSocksProxy(choice) ? readyBridgeUrl(choice) : null;
    const address = bridged ?? (isSocksProxy(choice) ? null : parseProxyAddress(choice)?.href);
    if (address !== null && address !== undefined) {
      return new ProxyAgent(address);
    }
    // A SOCKS proxy whose bridge isn't listening yet: the global dispatcher
    // starts it at the next refresh and takes over from there.
    return undefined;
  }
  if (input.insecureTls === true) {
    permissiveAgent ??= new Agent({ connect: { rejectUnauthorized: false } });
    return permissiveAgent;
  }
  return undefined;
}
