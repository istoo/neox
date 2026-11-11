/**
 * A web search API a plugin gives the gateway. The plugin's index.server.ts
 * registers it; the daemon lists it beside Tavily, Brave and the rest, keeps
 * the user's key and address, and asks it through the gateway's search path
 * (myna's plugin search hook).
 */
export interface SearchPage {
  title: string;
  url: string;
  text: string;
  /** When the page was published, as the vendor says it. */
  age?: string;
}

export interface SearchRequest {
  query: string;
  /** The key the user set for this API, when they set one. */
  key: string | null;
  /** The address the user set, for an API that needs one (a SearXNG's). */
  url: string | null;
}

export interface SearchApiRegistration {
  /** [a-z0-9-], at most 32 characters, unique in the plugin. */
  id: string;
  name: string;
  /** Where the user gets a key. */
  keysURL?: string;
  /** A search works without a key. */
  keyOptional?: boolean;
  /** The user gives an address, passed to `execute` as `url`. */
  needURL?: boolean;
  execute(request: SearchRequest): Promise<readonly SearchPage[]>;
}
