/**
 * A provider a plugin signs in to and serves through the gateway, shaped as
 * myna's OpenCode plugin `auth` hook: sign-in methods, a loader that names
 * where and how one account's requests go, the account's models, and its
 * usage/check-in/refresh hooks.
 *
 * The plugin owns the sign-in and the tokens; the gateway asks `loader`
 * before each attempt and never sees more than the headers it returns.
 */

export type SubscriptionProtocol = "anthropic" | "openai" | "openai-responses" | "gemini";

export interface SubscriptionPrompt {
  type: "text" | "select";
  key: string;
  message: string;
  placeholder?: string;
  options?: Array<{ label: string; value: string }>;
  /** A validation message, or undefined when the value is taken. */
  validate?(value: string): string | undefined;
}

export interface SubscriptionSignInMethod {
  type: "oauth" | "api";
  label: string;
  prompts?: SubscriptionPrompt[];
  /**
   * Runs the sign-in. An auth object is kept and reported at once; a flow
   * is reported with its URL/instructions and completed by polling.
   */
  authorize?(inputs: Record<string, string>): Promise<SubscriptionSignInOutcome>;
  /** For an API key method, what to ask for before `authorize`. */
  apiKey?: { label: string; placeholder?: string };
}

/** A sign-in the user finishes elsewhere (myna's device flow). */
export interface SubscriptionSignInFlow {
  url?: string;
  instructions?: string;
  /** Resolves with the auth once the user authorizes; throws when it lapses. */
  complete(): Promise<Record<string, unknown>>;
}

export type SubscriptionSignInOutcome = Record<string, unknown> | SubscriptionSignInFlow;

export interface SubscriptionModel {
  id: string;
  name?: string;
  context?: number;
  maxOutput?: number;
  reasoning?: boolean;
  images?: boolean;
  /** Where this model is served, when the vendor puts it on another base. */
  baseUrl?: string;
  /** The wire this model is served on, when it differs from the provider's. */
  protocol?: SubscriptionProtocol;
}

export interface SubscriptionLoaderInput {
  accountId: string;
  model: string;
  /** The request body the gateway is about to send, for a loader that signs it. */
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

export interface SubscriptionLoaderResult {
  /** Where the request goes: the vendor's base for this protocol. */
  baseUrl: string;
  /** Headers the loader adds over the provider's own. */
  headers: Record<string, string>;
  /** A body the loader shaped for its vendor; the gateway's otherwise. */
  body?: Record<string, unknown>;
  /**
   * The plugin's own fetch, for a vendor whose request must be signed or
   * rewritten as it goes (myna's OpenCode `loader` returns one). The
   * gateway sends the request through the plugin process instead of
   * fetching it itself.
   */
  fetch?(input: string, init: SubscriptionFetchInit): Promise<Response>;
}

export interface SubscriptionFetchInit {
  method: string;
  headers: Record<string, string>;
  body: string;
}

export interface SubscriptionProviderRegistration {
  id: string;
  label: string;
  /** The wire its models are asked on; one provider serves one protocol. */
  protocol: SubscriptionProtocol;
  methods: SubscriptionSignInMethod[];
  loader(input: SubscriptionLoaderInput): Promise<SubscriptionLoaderResult>;
  models(input: { accountId: string }): Promise<SubscriptionModel[]>;
  usage?(input: { accountId: string }): Promise<unknown>;
  checkin?(input: { accountId: string }): Promise<unknown>;
  refresh?(input: { accountId: string }): Promise<void>;
  options?: Record<string, unknown>;
}

/** What the daemon knows about a provider without the plugin's functions. */
export interface SubscriptionProviderMetadata {
  id: string;
  label: string;
  protocol: SubscriptionProtocol;
  methods: Array<{
    type: "oauth" | "api";
    label: string;
    prompts?: SubscriptionPrompt[];
    apiKey?: { label: string; placeholder?: string };
  }>;
  options?: Record<string, unknown>;
}
