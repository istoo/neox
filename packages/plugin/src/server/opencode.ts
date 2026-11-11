import type { PluginAccounts } from "./accounts.js";
import type {
  SubscriptionModel,
  SubscriptionPrompt,
  SubscriptionProviderRegistration,
  SubscriptionProtocol,
  SubscriptionSignInMethod,
  SubscriptionSignInOutcome,
} from "./subscription.js";

/**
 * Adapts a myna OpenCode auth plugin (`@magpie-community/opencode-*-auth`)
 * to a Neolix subscription provider: its `auth` hooks are registered as
 * they are, and its sign-ins are kept in the plugin's own account store.
 *
 * The community plugins only ask their host for `client.auth.set`, and
 * take an auth getter in every hook. `getAuth` here reads the account the
 * gateway names, falling back to the provider's default account.
 */

type Auth = Record<string, unknown>;
type GetAuth = () => Promise<Auth | null>;

export interface OpenCodeFetchInit {
  method: string;
  headers: Record<string, string>;
  body: string;
}

export interface OpenCodeAuthHooks {
  methods: Array<{
    type: "oauth" | "api";
    label: string;
    prompts?: SubscriptionPrompt[];
    authorize(inputs: Record<string, string>): unknown;
  }>;
  loader(getAuth: GetAuth): unknown;
  usage?(getAuth: GetAuth): unknown;
  checkin?(getAuth: GetAuth): unknown;
  refresh?(auth: Auth): unknown;
}

export interface OpenCodeContribution {
  auth: OpenCodeAuthHooks;
  config?(config: Record<string, unknown>): unknown;
  provider?: {
    id?: string;
    models?(provider: Record<string, unknown>, input: { auth?: Auth }): unknown;
  };
}

export interface OpenCodeSubscriptionOptions {
  accounts: PluginAccounts;
  /** The provider id the gateway and account store use. */
  id: string;
  label: string;
  protocol: SubscriptionProtocol;
  /** The account a hook reads when the gateway names none. */
  accountId?: string;
  /** What a myna-aware plugin asks of its host (`option`, a directory). */
  host?: { magpie?: unknown; directory?: string };
  plugin(input: {
    client: {
      auth: {
        get(input: { path: { id: string } }): Promise<Auth | null>;
        set(input: { path: { id: string }; body: Auth }): Promise<void>;
      };
    };
    magpie?: unknown;
    directory?: string;
  }): OpenCodeContribution | Promise<OpenCodeContribution>;
}

/** The Neolix subscription provider a community auth plugin makes. */
export async function openCodeSubscriptionProvider(
  options: OpenCodeSubscriptionOptions,
): Promise<SubscriptionProviderRegistration> {
  const defaultAccount = options.accountId ?? options.id;
  const getAuth =
    (accountId?: string): GetAuth =>
    () =>
      options.accounts.read(
        accountId === undefined || accountId === "" ? defaultAccount : accountId,
      );
  const contributed = await options.plugin({
    client: {
      auth: {
        get: ({ path }) => options.accounts.read(path.id),
        set: async ({ path, body }) => {
          await options.accounts.write(path.id, body);
        },
      },
    },
    ...(options.host?.magpie === undefined ? {} : { magpie: options.host.magpie }),
    ...(options.host?.directory === undefined ? {} : { directory: options.host.directory }),
  });
  const auth = contributed.auth;
  const providerConfig = providerConfigOf(contributed, options.id);
  const methods: SubscriptionSignInMethod[] = [];
  for (const method of auth.methods) {
    const adapted: SubscriptionSignInMethod = {
      type: method.type,
      label: method.label,
      ...(method.prompts === undefined ? {} : { prompts: method.prompts }),
      async authorize(inputs) {
        return adaptSignIn(await method.authorize(inputs));
      },
    };
    methods.push(adapted);
  }
  return {
    id: options.id,
    label: options.label,
    protocol: options.protocol,
    methods,
    async loader(input) {
      const loaded = await auth.loader(getAuth(input.accountId));
      return loadedOf(loaded, options.label);
    },
    async models(input) {
      const account = await getAuth(input.accountId)();
      const contributor = contributed.provider;
      if (contributor?.models === undefined) return modelsOf(providerConfig);
      try {
        const listed = await contributor.models(
          providerConfig,
          account === null ? {} : { auth: account },
        );
        return modelsOf(listed);
      } catch {
        return modelsOf(providerConfig);
      }
    },
    ...(auth.usage === undefined
      ? {}
      : { usage: async (input: { accountId: string }) => auth.usage?.(getAuth(input.accountId)) }),
    ...(auth.checkin === undefined
      ? {}
      : {
          checkin: async (input: { accountId: string }) => auth.checkin?.(getAuth(input.accountId)),
        }),
    ...(auth.refresh === undefined
      ? {}
      : {
          refresh: async (input: { accountId: string }) => {
            const accountId = input.accountId === "" ? defaultAccount : input.accountId;
            const current = await options.accounts.read(accountId);
            if (current === null) return;
            const next = await auth.refresh?.(current);
            if (isRecord(next)) await options.accounts.write(accountId, { ...current, ...next });
          },
        }),
  };
}

/** The provider block the OpenCode plugin writes into its config. */
function providerConfigOf(contributed: OpenCodeContribution, id: string): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  try {
    contributed.config?.(config);
  } catch {
    // a config hook that can't run leaves the plugin's own fallback list
  }
  const providers = isRecord(config.provider) ? config.provider : {};
  const entry = providers[id];
  return isRecord(entry) ? entry : { id, models: {} };
}

/** A loader's answer, with the auth header a key names. */
function loadedOf(
  value: unknown,
  label: string,
): {
  baseUrl: string;
  headers: Record<string, string>;
  fetch?: (input: string, init: OpenCodeFetchInit) => Promise<Response>;
} {
  if (!isRecord(value)) throw new Error(`${label} loader returned no address`);
  let baseUrl = "";
  if (typeof value.baseURL === "string") baseUrl = value.baseURL;
  else if (typeof value.baseUrl === "string") baseUrl = value.baseUrl;
  const headers: Record<string, string> = {};
  if (isRecord(value.headers)) {
    for (const [name, header] of Object.entries(value.headers)) {
      if (typeof header === "string") headers[name] = header;
    }
  }
  if (typeof value.apiKey === "string" && value.apiKey !== "") {
    headers.authorization = `Bearer ${value.apiKey}`;
  }
  const loaded = value.fetch;
  if (baseUrl === "" && typeof loaded !== "function") {
    throw new Error(`${label} loader returned no address`);
  }
  return {
    baseUrl,
    headers,
    ...(typeof loaded === "function"
      ? {
          fetch: (input: string, init: OpenCodeFetchInit) =>
            (loaded as (input: string, init: OpenCodeFetchInit) => Promise<Response>)(input, init),
        }
      : {}),
  };
}

/** A provider's model config as the adapter's list. */
function modelsOf(value: unknown): SubscriptionModel[] {
  const source = isRecord(value) && isRecord(value.models) ? value.models : value;
  if (!isRecord(source)) return [];
  const out: SubscriptionModel[] = [];
  for (const [id, raw] of Object.entries(source)) {
    if (!isRecord(raw) || (raw.name === undefined && raw.api === undefined)) continue;
    out.push(modelOf(id, raw));
  }
  return out;
}

/** One model's entry as the adapter's model. */
function modelOf(id: string, raw: Record<string, unknown>): SubscriptionModel {
  const limit = isRecord(raw.limit) ? raw.limit : {};
  const api = isRecord(raw.api) ? raw.api : {};
  const model: SubscriptionModel = { id };
  if (typeof raw.name === "string") model.name = raw.name;
  if (typeof limit.context === "number" && limit.context > 0) model.context = limit.context;
  if (typeof limit.output === "number" && limit.output > 0) model.maxOutput = limit.output;
  if (typeof raw.reasoning === "boolean") model.reasoning = raw.reasoning;
  if (typeof raw.images === "boolean") model.images = raw.images;
  if (typeof api.url === "string" && api.url !== "") model.baseUrl = api.url;
  const protocol = typeof api.npm === "string" ? protocolOf(api.npm) : undefined;
  if (protocol !== undefined) model.protocol = protocol;
  return model;
}

/** An OpenCode API package's wire. */
function protocolOf(npm: string): SubscriptionProtocol | undefined {
  if (npm.includes("anthropic")) return "anthropic";
  if (npm.includes("google")) return "gemini";
  if (npm.includes("openai")) return "openai";
  return undefined;
}

/** A community sign-in's answer: an auth object, or a flow to finish. */
function adaptSignIn(value: unknown): SubscriptionSignInOutcome {
  if (!isRecord(value)) throw new Error("the plugin's sign-in returned nothing");
  if (typeof value.callback === "function") {
    const callback = value.callback as () => unknown;
    return {
      ...(typeof value.url === "string" ? { url: value.url } : {}),
      ...(typeof value.instructions === "string" ? { instructions: value.instructions } : {}),
      complete: async () => authOf(await callback()),
    };
  }
  return authOf(value);
}

function authOf(value: unknown): Auth {
  if (!isRecord(value)) throw new Error("the plugin's sign-in returned no auth");
  const nested = value.auth;
  return normalizeAuth(isRecord(nested) ? nested : value);
}

/**
 * An OpenCode sign-in result as the auth the account store keeps: `success`
 * with a `refresh` is an OAuth account, `success` with a `key` an API one
 * (myna's `save` in `internal/plugin/host.js`). A `provider` names the
 * provider the account belongs to, when the plugin signs in to another.
 */
function normalizeAuth(result: Auth): Auth {
  if ("refresh" in result) {
    const auth: Auth = { type: "oauth" };
    for (const [key, value] of Object.entries(result)) {
      if (key === "type") continue;
      auth[key] = value;
    }
    return auth;
  }
  if ("key" in result) {
    const auth: Auth = { type: "api", key: result.key };
    if (result.provider !== undefined) auth.provider = result.provider;
    if (isRecord(result.metadata)) auth.metadata = result.metadata;
    return auth;
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
