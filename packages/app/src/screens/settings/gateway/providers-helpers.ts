import type {
  GatewayAccountWire,
  GatewayPriceWire,
  GatewayProviderWire,
  GatewayRateWindowWire,
} from "@neolix/protocol/gateway";
import type { GatewayProviderPreset } from "./providers-presets";

type GatewayModelWire = GatewayProviderWire["models"][number];

/** Pure helpers for the Providers page: what a row says, and how a draft becomes a provider. */

export type GatewayProtocol = GatewayProviderWire["protocol"];
export type GatewayVideoApi = NonNullable<GatewayProviderWire["videoApi"]>;
export type GatewayModelKind = NonNullable<GatewayModelWire["kind"]>;
export type GatewayModelMode = NonNullable<GatewayProviderWire["modelMode"]>;
export type GatewayBalanceMethod = NonNullable<GatewayProviderWire["balanceMethod"]>;

/** A rate window as the editor keeps it, numbers still as the user typed them. */
export interface RateWindowDraft {
  days: number[];
  start: string;
  end: string;
  rate: string;
}

/** A model's hand-set price as the editor keeps it, everything still text. */
export interface ModelPriceDraft {
  input: string;
  output: string;
  cacheRead: string;
  cacheWrite: string;
  cacheWrite1h: string;
  tierAbove: string;
  tierInput: string;
  tierOutput: string;
}

export type ModelPriceDrafts = Record<string, ModelPriceDraft>;

export interface ProviderHeaderDraft {
  name: string;
  value: string;
}

/** Google Vertex AI's settings as the editor keeps them. */
export interface VertexDraft {
  project: string;
  location: string;
  credentials: string;
  impersonate: string;
}

/** The editor's own copy of a provider, with numbers kept as the user typed them. */
export interface ProviderDraft {
  id: string;
  label: string;
  protocol: GatewayProtocol;
  baseUrl: string;
  /** Present when the provider is Google Vertex AI; null for every other. */
  vertex: VertexDraft | null;
  /** Where its model list is, when it isn't `${baseUrl}/models` (myna's ModelsURL). */
  modelsUrl: string;
  /** The tag its models go by in what agents are shown (myna's Family). */
  family: string;
  /** A decision API's address (myna's Decide), in place of serving models. */
  decide: string;
  /** The `{WorkspaceId}` a decision address names, as the user types it. */
  workspace: string;
  /** A preset that only decides (`bailian-decision`): serves no model of its own. */
  decideOnly: boolean;
  apiKey: string;
  accounts: GatewayAccountWire[];
  headers: ProviderHeaderDraft[];
  maxAccounts: string;
  queueWaitMs: string;
  sink: boolean;
  priceRate: string;
  /** Time-of-day multipliers; the first holding a call's time wins. */
  rateWindows: RateWindowDraft[];
  /** Model id → its hand-set price, for the models whose price differs from the catalog's. */
  prices: ModelPriceDrafts;
  /** Model id → the model id it is the same as, as myna's ModelSameAs. */
  sameAs: Record<string, string>;
  models: GatewayModelWire[];
  videoApi: GatewayVideoApi | null;
  enabled: boolean;
  /** Skip TLS verification, for a server whose certificate nothing trusts. */
  insecureTls: boolean;
  /** JSON text merged into every upstream request body. */
  extraBody: string;
  /** Listed to gateway clients; off means its models are used but not offered. */
  exposeModels: boolean;
  /**
   * myna's SwitchOnly: neolix only moves the agent's own sign-in between its
   * accounts, serving no request on them through the gateway.
   */
  switchOnly: boolean;
  /**
   * myna's RestartApp: restart the Codex app's app-server for a switch back
   * Neolix makes by itself. A switch off a spent account restarts it anyway.
   */
  restartApp: boolean;
  /** Which of its models it serves: all, the picked ones, the newest per family, or none. */
  modelMode: GatewayModelMode;
  /** A glyph the app draws in the row, stored beside the provider. */
  icon: string;
  /** Where the provider reports what is left on its key; `{key}` takes the key. */
  balanceUrl: string;
  /** The amount's field in that reply. */
  balancePath: string;
  /** How the balance URL is asked; POST carries no body. */
  balanceMethod: GatewayBalanceMethod;
  /** An account's own token, asked instead of the key where a vendor wants one. */
  balanceToken: string;
  /** Requests to this provider go unmasked. */
  unredacted: boolean;
  /** Codex's compaction is carried by the provider (Responses API only). */
  nativeCompaction: boolean;
  /** Its models are free, for the `free` and `cheap` routings. */
  countFree: boolean;
  /** The upstream itself answers a web search tool. */
  searches: boolean;
  /** The daemon's verdict for the saved provider; false for one not saved yet. */
  searchesUpstream: boolean;
}

export interface ProviderDraftErrors {
  id?: string;
  baseUrl?: string;
  /** A Vertex provider with no project's id, or one that can't be a project's. */
  vertexProject?: string;
  /** A Vertex provider's location that can't be one. */
  vertexLocation?: string;
  extraBody?: string;
  balanceUrl?: string;
  rateWindows?: string;
  prices?: string;
}

export const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9-]*$/;

/** myna's `vertexProject` and `vertexLocation` (`provider/vertex.go:100-103`). */
const VERTEX_PROJECT_ID = /^[a-z0-9][a-z0-9.:-]*[a-z0-9]$/;
const VERTEX_LOCATION = /^[a-z]+(-[a-z0-9]+)*$/;

export function maskApiKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed.length === 0) {
    return "";
  }
  if (trimmed.length <= 8) {
    return `${trimmed.slice(0, 2)}…`;
  }
  return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`;
}

export function providerHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

export function isLocalAddress(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      host === "0.0.0.0" ||
      host.endsWith(".local")
    );
  } catch {
    return false;
  }
}

/** The accounts a provider actually has: an explicit list, or the implicit key. */
export function providerAccountsOf(provider: GatewayProviderWire): GatewayAccountWire[] {
  if ((provider.accounts?.length ?? 0) > 0) {
    return provider.accounts ?? [];
  }
  if (provider.apiKey !== undefined && provider.apiKey.length > 0) {
    return [{ id: "default", apiKey: provider.apiKey, enabled: true }];
  }
  return [];
}

export type ProviderKeyTone = "success" | "warning" | "muted";

export interface ProviderKeySummary {
  /** The first enabled account's credential, already masked when asked for. */
  text: string;
  /**
   * `key` when there is a credential to show; otherwise why the row has none,
   * so the row can say it in the reader's language.
   */
  kind: "key" | "needsKey" | "noKeyNeeded" | "noActiveAccount";
  tone: ProviderKeyTone;
}

/**
 * A key is always shown masked; "mask accounts" hides the accounts' own names,
 * which is what myna's switch does for a signed-in account's user and plan.
 */
export function providerKeySummary(provider: GatewayProviderWire): ProviderKeySummary {
  const accounts = providerAccountsOf(provider);
  const active = accounts.filter((account) => account.enabled !== false);
  const key = active.find((account) => (account.apiKey ?? "").length > 0)?.apiKey ?? "";
  if (key.length > 0) {
    return { text: maskApiKey(key), kind: "key", tone: "success" };
  }
  if (accounts.length > 0) {
    return { text: "", kind: "noActiveAccount", tone: "warning" };
  }
  if (isLocalAddress(provider.baseUrl)) {
    return { text: "", kind: "noKeyNeeded", tone: "muted" };
  }
  return { text: "", kind: "needsKey", tone: "warning" };
}

/** The name of the first enabled account, when it has one of its own. */
export function providerAccountName(provider: GatewayProviderWire): string | null {
  const active = providerAccountsOf(provider).filter((account) => account.enabled !== false);
  const named = active.find((account) => (account.label ?? "").trim().length > 0);
  if (named !== undefined) {
    return (named.label ?? "").trim();
  }
  const explicit = active.find(
    (account) => account.id !== "default" || (provider.accounts?.length ?? 0) > 0,
  );
  return explicit === undefined ? null : explicit.id;
}

export function providerModelCount(provider: GatewayProviderWire): number {
  return provider.models.length;
}

/** Case-insensitive match over the fields a provider row hides but the user remembers. */
export function providerMatchesQuery(provider: GatewayProviderWire, query: string): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return true;
  }
  const haystack = [
    provider.id,
    provider.label ?? "",
    provider.baseUrl,
    provider.protocol,
    ...provider.models.map((model) => model.id),
    ...providerAccountsOf(provider).flatMap((account) => [account.id, account.label ?? ""]),
  ]
    .join(" ")
    .toLowerCase();
  return words.every((word) => haystack.includes(word));
}

export function isProviderOn(provider: GatewayProviderWire): boolean {
  return provider.enabled !== false;
}

/**
 * Whether a row's up/down arrows act. A search shows a subset while
 * `moveProvider` swaps neighbours in the full list, so a visible row's arrow
 * could move an invisible one and leave the screen unchanged; search turns
 * the arrows off until the list is whole again.
 */
export function providerCanMove(
  index: number,
  count: number,
  searching: boolean,
): { up: boolean; down: boolean } {
  if (searching) {
    return { up: false, down: false };
  }
  return { up: index > 0, down: index < count - 1 };
}

/**
 * Moves one switched-on provider past its neighbour, leaving the switched-off
 * ones in their places: the order is the order requests try providers in.
 * Returns null when the move would leave the list.
 */
export function moveProvider(
  providers: readonly GatewayProviderWire[],
  id: string,
  delta: -1 | 1,
): GatewayProviderWire[] | null {
  const onSlots: number[] = [];
  providers.forEach((provider, index) => {
    if (isProviderOn(provider)) {
      onSlots.push(index);
    }
  });
  const position = onSlots.findIndex((slot) => providers[slot]?.id === id);
  const target = position + delta;
  if (position < 0 || target < 0 || target >= onSlots.length) {
    return null;
  }
  const order = onSlots.map((slot) => providers[slot]!);
  const moved = order[position]!;
  order[position] = order[target]!;
  order[target] = moved;
  const next = [...providers];
  onSlots.forEach((slot, index) => {
    next[slot] = order[index]!;
  });
  return next;
}

/** The draft of a provider that isn't there yet. */
function emptyProviderDraft(): ProviderDraft {
  return {
    id: "",
    label: "",
    protocol: "openai",
    baseUrl: "",
    vertex: null,
    modelsUrl: "",
    family: "",
    decide: "",
    workspace: "",
    decideOnly: false,
    apiKey: "",
    accounts: [],
    headers: [],
    maxAccounts: "",
    queueWaitMs: "",
    sink: false,
    priceRate: "",
    rateWindows: [],
    prices: {},
    sameAs: {},
    models: [],
    videoApi: null,
    enabled: true,
    insecureTls: false,
    extraBody: "",
    exposeModels: true,
    switchOnly: false,
    restartApp: false,
    modelMode: "list",
    icon: "",
    balanceUrl: "",
    balancePath: "",
    balanceMethod: "GET",
    balanceToken: "",
    unredacted: false,
    nativeCompaction: false,
    countFree: false,
    searches: false,
    searchesUpstream: false,
  };
}

type ProviderTextField =
  | "label"
  | "modelsUrl"
  | "family"
  | "decide"
  | "apiKey"
  | "icon"
  | "balanceUrl"
  | "balancePath"
  | "balanceMethod"
  | "balanceToken";

/** The provider's optional text fields as the editor keeps them: empty when unset. */
function textDraftOf(provider: GatewayProviderWire): Pick<ProviderDraft, ProviderTextField> {
  return {
    label: provider.label ?? "",
    modelsUrl: provider.modelsUrl ?? "",
    family: provider.family ?? "",
    decide: provider.decide ?? "",
    apiKey: provider.apiKey ?? "",
    icon: provider.icon ?? "",
    balanceUrl: provider.balanceUrl ?? "",
    balancePath: provider.balancePath ?? "",
    balanceMethod: provider.balanceMethod ?? "GET",
    balanceToken: provider.balanceToken ?? "",
  };
}

export function openProviderDraft(
  provider: GatewayProviderWire | null,
  pricing: Record<string, GatewayPriceWire> = {},
  modelSameAs: Record<string, string> = {},
): ProviderDraft {
  if (provider === null) {
    return emptyProviderDraft();
  }
  return {
    id: provider.id,
    ...textDraftOf(provider),
    protocol: provider.protocol,
    baseUrl: provider.baseUrl,
    vertex: vertexDraftOf(provider),
    workspace: "",
    decideOnly: provider.decide !== undefined && provider.modelMode === "none",
    accounts: (provider.accounts ?? []).map((account) => Object.assign({}, account)),
    headers: Object.entries(provider.headers ?? {}).map(([name, value]) => ({ name, value })),
    maxAccounts: provider.maxAccounts === undefined ? "" : String(provider.maxAccounts),
    queueWaitMs: provider.queueWaitMs === undefined ? "" : String(provider.queueWaitMs),
    sink: provider.sink === true,
    priceRate: provider.priceRate === undefined ? "" : String(provider.priceRate),
    rateWindows: (provider.rateWindows ?? []).map((window) => ({
      days: [...(window.days ?? [])],
      start: window.start,
      end: window.end,
      rate: String(window.rate),
    })),
    prices: modelPriceDraftsOf(provider, pricing),
    sameAs: modelSameDraftsOf(provider, modelSameAs),
    models: provider.models.map((model) => Object.assign({}, model)),
    videoApi: provider.videoApi ?? null,
    enabled: provider.enabled !== false,
    insecureTls: provider.insecureTls === true,
    extraBody: provider.extraBody === undefined ? "" : JSON.stringify(provider.extraBody, null, 2),
    exposeModels: provider.exposeModels !== false,
    switchOnly: provider.switchOnly === true,
    restartApp: provider.restartApp === true,
    modelMode: provider.modelMode ?? "list",
    unredacted: provider.unredacted === true,
    nativeCompaction: provider.nativeCompaction === true,
    countFree: provider.countFree === true,
    // An upstream's own search is the daemon's verdict when the user said
    // nothing; the page does not infer it from the protocol.
    searchesUpstream: provider.searchesUpstream === true,
    searches: provider.searches ?? provider.searchesUpstream === true,
  };
}

/** A provider's Vertex settings as the editor keeps them; null when it isn't one. */
function vertexDraftOf(provider: GatewayProviderWire): VertexDraft | null {
  if (provider.vertex === undefined) {
    return null;
  }
  return {
    project: provider.vertex.project ?? "",
    location: provider.vertex.location ?? "",
    credentials: provider.vertex.credentials ?? "",
    impersonate: provider.vertex.impersonate ?? "",
  };
}

/** The protocol a preset starts on: chat completions, else Messages, else Responses. */
export function presetProtocol(preset: GatewayProviderPreset): GatewayProtocol {
  if (preset.endpoints.openai !== undefined) {
    return "openai";
  }
  if (preset.endpoints.anthropic !== undefined) {
    return "anthropic";
  }
  if (preset.endpoints["openai-responses"] !== undefined) {
    return "openai-responses";
  }
  if (preset.endpoints.gemini !== undefined) {
    return "gemini";
  }
  return "openai";
}

/** A provider id the daemon accepts and no other provider uses. */
export function uniqueProviderId(
  preferred: string,
  providers: readonly GatewayProviderWire[],
): string {
  const base = preferred.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  const first = /^[a-z]/.test(base) ? base : `p-${base}`;
  let candidate = first;
  let suffix = 2;
  while (providers.some((provider) => provider.id === candidate)) {
    candidate = `${first}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

/** The draft a picked preset opens: its name, its first endpoint, a free id. */
export function presetDraft(
  preset: GatewayProviderPreset,
  providers: readonly GatewayProviderWire[],
): ProviderDraft {
  const protocol = presetProtocol(preset);
  return {
    ...openProviderDraft(null),
    id: uniqueProviderId(preset.id, providers),
    label: preset.name,
    protocol,
    baseUrl: preset.endpoints[protocol] ?? preset.decide ?? "",
    decide: preset.decide ?? "",
    decideOnly: Object.keys(preset.endpoints).length === 0 && preset.decide !== undefined,
    vertex:
      preset.vertex === true
        ? { project: "", location: "", credentials: "", impersonate: "" }
        : null,
    models: (preset.models ?? []).map((id) => ({ id })),
  };
}

/** An ID no other provider uses, so a new provider saves without a collision. */
export function nextProviderId(providers: readonly GatewayProviderWire[]): string {
  const taken = new Set(providers.map((provider) => provider.id));
  let index = providers.length + 1;
  while (taken.has(`provider-${index}`)) {
    index += 1;
  }
  return `provider-${index}`;
}

export function validateProviderDraft(
  draft: ProviderDraft,
  providers: readonly GatewayProviderWire[],
  originalId: string | null,
): ProviderDraftErrors {
  const errors: ProviderDraftErrors = {};
  if (!PROVIDER_ID_PATTERN.test(draft.id)) {
    errors.id = "invalid";
  } else if (draft.id !== originalId && providers.some((provider) => provider.id === draft.id)) {
    errors.id = "taken";
  }
  if (!isHttpUrl(draft.baseUrl)) {
    errors.baseUrl = draft.baseUrl.trim().length === 0 ? "missing" : "invalid";
  }
  if (draft.vertex !== null) {
    const project = draft.vertex.project.trim().toLowerCase();
    if (project === "") {
      errors.vertexProject = "missing";
    } else if (!VERTEX_PROJECT_ID.test(project)) {
      errors.vertexProject = "invalid";
    }
    const location = draft.vertex.location.trim().toLowerCase();
    if (location !== "" && !VERTEX_LOCATION.test(location)) {
      errors.vertexLocation = "invalid";
    }
  }
  if (!isExtraBodyText(draft.extraBody)) {
    errors.extraBody = "invalid";
  }
  if (draft.balanceUrl.trim().length > 0 && !isHttpUrl(draft.balanceUrl)) {
    errors.balanceUrl = "invalid";
  }
  const windows = parseRateWindowsDraft(draft.rateWindows);
  if ("error" in windows) {
    errors.rateWindows = "invalid";
  }
  for (const [modelId, price] of Object.entries(draft.prices)) {
    if (modelPriceDraftInvalid(price)) {
      errors.prices = modelId;
      break;
    }
  }
  return errors;
}

/** Empty is fine; anything else must parse to a JSON object. */
export function isExtraBodyText(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return true;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

export function parseExtraBody(value: string): Record<string, unknown> | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  const parsed: unknown = JSON.parse(trimmed);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  return parsed as Record<string, unknown>;
}

export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function buildProvider(draft: ProviderDraft): GatewayProviderWire {
  const provider: GatewayProviderWire = {
    id: draft.id.trim(),
    protocol: draft.protocol,
    baseUrl: providerBaseUrl(draft),
    models: draft.models.map((model) => Object.assign({}, model)),
  };
  const label = draft.label.trim();
  if (label.length > 0) {
    provider.label = label;
  }
  const apiKey = draft.apiKey.trim();
  if (apiKey.length > 0) {
    provider.apiKey = apiKey;
  }
  if (draft.accounts.length > 0) {
    provider.accounts = draft.accounts.map((account) => Object.assign({}, account));
  }
  const headers = draftHeaders(draft);
  if (headers !== undefined) {
    provider.headers = headers;
  }
  if (draft.vertex !== null) {
    const project = draft.vertex.project.trim().toLowerCase();
    const location = draft.vertex.location.trim().toLowerCase();
    const credentials = draft.vertex.credentials.trim();
    const impersonate = draft.vertex.impersonate.trim().toLowerCase();
    provider.vertex = {
      project,
      location: location === "" ? "global" : location,
      ...(credentials === "" ? {} : { credentials }),
      ...(impersonate === "" ? {} : { impersonate }),
    };
  }
  const modelsUrl = draft.modelsUrl.trim();
  if (modelsUrl.length > 0) {
    provider.modelsUrl = modelsUrl;
  }
  const maxAccounts = parsePositiveInt(draft.maxAccounts);
  if (maxAccounts !== undefined) {
    provider.maxAccounts = maxAccounts;
  }
  const queueWaitMs = parseNonNegativeInt(draft.queueWaitMs);
  if (queueWaitMs !== undefined) {
    provider.queueWaitMs = queueWaitMs;
  }
  applyAdvancedFields(provider, draft);
  return provider;
}

/**
 * The provider fields this editor doesn't show but must not erase: ones
 * the CLI sets (`neolix provider fallback`, `auto-include`, `quota-rest`,
 * `rest-cap`, `queue`, `spend-cap`, …). A saved draft replaces the whole
 * provider, so they are carried from the one being edited.
 */
const PRESERVED_PROVIDER_FIELDS = [
  "family",
  "fallback",
  "routing",
  "restartApp",
  "modelsUrl",
  "website",
  "keysUrl",
  "catalog",
  "passUserAgent",
  "promptAsWritten",
  "codexAsSent",
  "additionalTools",
  "patienceMs",
  "refreshEveryMs",
  "autoInclude",
  "quotaRest",
  "restCapMs",
  "queueLength",
  "stopAtCap",
  "unlisted",
  "hiddenDrawers",
  "listFetchedAt",
] as const;

/** Keeps the fields above from the provider as it was, before the draft is saved. */
export function withPreservedProviderFields(
  provider: GatewayProviderWire,
  previous: GatewayProviderWire | undefined,
): GatewayProviderWire {
  if (previous === undefined) {
    return provider;
  }
  const merged: Record<string, unknown> = { ...provider };
  const source = previous as Record<string, unknown>;
  for (const field of PRESERVED_PROVIDER_FIELDS) {
    if (merged[field] === undefined && source[field] !== undefined) {
      merged[field] = source[field];
    }
  }
  return merged as GatewayProviderWire;
}

/** The fields a provider only carries when the user changed them. */
/** An address with the workspace the user typed filled in, when there is one. */
function withWorkspace(draft: ProviderDraft, text: string): string {
  const workspace = draft.workspace.trim();
  return workspace.length > 0 ? text.replaceAll("{WorkspaceId}", workspace) : text;
}

/** A decision address with the workspace the user typed filled in. */
function filledDecide(draft: ProviderDraft): string {
  return withWorkspace(draft, draft.decide.trim());
}

/**
 * The address requests are made to: the user's own, or for a preset that
 * only decides, its decision address (myna's Decide) with the workspace
 * filled in.
 */
function providerBaseUrl(draft: ProviderDraft): string {
  const base = withWorkspace(draft, draft.baseUrl.trim());
  return base.length > 0 ? base : filledDecide(draft);
}

function applyAdvancedFields(provider: GatewayProviderWire, draft: ProviderDraft): void {
  applySwitches(provider, draft);
  const family = draft.family.trim();
  if (family.length > 0) {
    provider.family = family;
  }
  const decide = filledDecide(draft);
  if (decide.length > 0) {
    provider.decide = decide;
  }
  if (draft.decideOnly) {
    // A decision-only preset serves no model (myna's DecideOnly): routing
    // groups ask it, agents are never offered it.
    provider.modelMode = "none";
    provider.exposeModels = false;
  }
  const priceRate = parsePositiveNumber(draft.priceRate);
  if (priceRate !== undefined) {
    provider.priceRate = priceRate;
  }
  const windows = parseRateWindowsDraft(draft.rateWindows);
  if ("windows" in windows && windows.windows.length > 0) {
    provider.rateWindows = windows.windows;
  }
  if (draft.videoApi !== null) {
    provider.videoApi = draft.videoApi;
  }
  if (!draft.enabled) {
    provider.enabled = false;
  }
  if (draft.insecureTls) {
    provider.insecureTls = true;
  }
  const extraBody = parseExtraBody(draft.extraBody);
  if (extraBody !== undefined) {
    provider.extraBody = extraBody;
  }
  if (!draft.exposeModels) {
    provider.exposeModels = false;
  }
  if (draft.switchOnly) {
    provider.switchOnly = true;
  }
  if (draft.restartApp) {
    provider.restartApp = true;
  }
  if (draft.modelMode !== "list") {
    provider.modelMode = draft.modelMode;
  }
  const icon = draft.icon.trim();
  if (icon.length > 0) {
    provider.icon = icon;
  }
  const balanceUrl = draft.balanceUrl.trim();
  if (balanceUrl.length > 0) {
    provider.balanceUrl = balanceUrl;
  }
  const balancePath = draft.balancePath.trim();
  if (balancePath.length > 0) {
    provider.balancePath = balancePath;
  }
  if (draft.balanceMethod !== "GET") {
    provider.balanceMethod = draft.balanceMethod;
  }
  const balanceToken = draft.balanceToken.trim();
  if (balanceToken.length > 0) {
    provider.balanceToken = balanceToken;
  }
}

/** The on/off fields, each written only when the user turned it on. */
function applySwitches(provider: GatewayProviderWire, draft: ProviderDraft): void {
  if (draft.sink) {
    provider.sink = true;
  }
  if (draft.unredacted) {
    provider.unredacted = true;
  }
  // Only a Responses API provider can carry Codex's compaction.
  if (draft.nativeCompaction && draft.protocol === "openai-responses") {
    provider.nativeCompaction = true;
  }
  if (draft.countFree) {
    provider.countFree = true;
  }
  // The daemon's verdict unless the user said otherwise: an explicit value
  // overrides it, and the default writes nothing.
  if (draft.searches !== draft.searchesUpstream) {
    provider.searches = draft.searches;
  }
}

function draftHeaders(draft: ProviderDraft): Record<string, string> | undefined {
  const entries = draft.headers
    .map((header) => [header.name.trim(), header.value] as const)
    .filter(([name]) => name.length > 0);
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

export function parsePositiveInt(value: string): number | undefined {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function parseNonNegativeInt(value: string): number | undefined {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

export function parsePositiveNumber(value: string): number | undefined {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/** Models kept as a draft list, adding a kind only when it is not the chat default. */
export function modelWithKind(id: string, kind: GatewayModelKind | null): GatewayModelWire {
  return kind === null || kind === "chat" ? { id } : { id, kind };
}

export function hasVideoModels(models: readonly GatewayModelWire[]): boolean {
  return models.some((model) => model.kind === "video");
}

/** A clock as minutes past midnight; `24:00` is 1440, anything else null. */
export function clockOf(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (match === null) {
    return null;
  }
  const hours = Number.parseInt(match[1]!, 10);
  const minutes = Number.parseInt(match[2]!, 10);
  const total = hours * 60 + minutes;
  return hours > 24 || minutes > 59 || total > 1440 ? null : total;
}

export function decimalOf(value: string): number | null {
  const trimmed = value.trim();
  if (!/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
    return null;
  }
  const parsed = Number.parseFloat(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The editor's windows as saved (myna's rateWindowsOfDraft): every start and
 * end a clock, a start that isn't 24:00, the two different, and a rate above
 * 0 and at most 1000 with at most three decimals.
 */
export function parseRateWindowsDraft(
  drafts: readonly RateWindowDraft[],
): { windows: GatewayRateWindowWire[] } | { error: "invalid" } {
  if (drafts.length > 8) {
    return { error: "invalid" };
  }
  const windows: GatewayRateWindowWire[] = [];
  for (const draft of drafts) {
    const start = clockOf(draft.start);
    const end = clockOf(draft.end);
    if (start === null || start === 1440 || end === null || start === end) {
      return { error: "invalid" };
    }
    const rate = decimalOf(draft.rate);
    if (
      rate === null ||
      rate <= 0 ||
      rate > 1000 ||
      Math.abs(rate * 1000 - Math.round(rate * 1000)) > 1e-6
    ) {
      return { error: "invalid" };
    }
    const days = [...new Set(draft.days)].sort((a, b) => a - b);
    windows.push({
      ...(days.length === 0 ? {} : { days }),
      start: draft.start.trim(),
      end: draft.end.trim(),
      rate,
    });
  }
  return { windows };
}

/** Whether a price draft has a field that isn't a number (or a token size). */
export function modelPriceDraftInvalid(draft: ModelPriceDraft): boolean {
  for (const field of [
    draft.input,
    draft.output,
    draft.cacheRead,
    draft.cacheWrite,
    draft.cacheWrite1h,
    draft.tierInput,
    draft.tierOutput,
  ]) {
    if (field.trim().length > 0) {
      const value = decimalOf(field);
      if (value === null || value < 0) {
        return true;
      }
    }
  }
  return draft.tierAbove.trim().length > 0 && parseTokenSize(draft.tierAbove) === null;
}

/** `272K`, `1M` or a plain number of tokens; null when it is none of them. */
export function parseTokenSize(value: string): number | null {
  const match = /^(\d+(?:\.\d+)?)\s*([kKmM]?)$/.exec(value.trim());
  if (match === null) {
    return null;
  }
  const size = Number.parseFloat(match[1]!) * sizeMultiplier(match[2] ?? "");
  return Number.isFinite(size) && size > 0 ? Math.round(size) : null;
}

function sizeMultiplier(unit: string): number {
  switch (unit.toLowerCase()) {
    case "m":
      return 1_000_000;
    case "k":
      return 1_000;
    default:
      return 1;
  }
}

/** Two prices alike in every part (myna's samePrice). */
export function samePrice(a: GatewayPriceWire, b: GatewayPriceWire): boolean {
  const norm = (price: GatewayPriceWire) =>
    JSON.stringify([
      price.inputPerMTok,
      price.outputPerMTok,
      price.cacheReadPerMTok ?? 0,
      price.cacheWritePerMTok ?? 0,
      price.cacheWrite1hPerMTok ?? 0,
      (price.tiers ?? []).map((tier) => [
        tier.aboveTokens,
        tier.inputPerMTok,
        tier.outputPerMTok,
        tier.cacheReadPerMTok ?? 0,
        tier.cacheWritePerMTok ?? 0,
        tier.cacheWrite1hPerMTok ?? 0,
      ]),
    ]);
  return norm(a) === norm(b);
}

export function emptyModelPriceDraft(): ModelPriceDraft {
  return {
    input: "",
    output: "",
    cacheRead: "",
    cacheWrite: "",
    cacheWrite1h: "",
    tierAbove: "",
    tierInput: "",
    tierOutput: "",
  };
}

function modelPriceDraftOf(price: GatewayPriceWire): ModelPriceDraft {
  const tier = price.tiers?.[0];
  const text = (value: number | undefined) => (value === undefined ? "" : String(value));
  return {
    input: text(price.inputPerMTok),
    output: text(price.outputPerMTok),
    cacheRead: text(price.cacheReadPerMTok),
    cacheWrite: text(price.cacheWritePerMTok),
    cacheWrite1h: text(price.cacheWrite1hPerMTok),
    tierAbove: tier === undefined ? "" : String(tier.aboveTokens),
    tierInput: tier === undefined ? "" : text(tier.inputPerMTok),
    tierOutput: tier === undefined ? "" : text(tier.outputPerMTok),
  };
}

function modelPriceDraftsOf(
  provider: GatewayProviderWire,
  pricing: Record<string, GatewayPriceWire>,
): ModelPriceDrafts {
  const drafts: ModelPriceDrafts = {};
  for (const model of provider.models) {
    const price = pricing[`${provider.id}/${model.id}`];
    if (price !== undefined) {
      drafts[model.id] = modelPriceDraftOf(price);
    }
  }
  return drafts;
}

/** The models this provider says it is the same as, by its own model id. */
function modelSameDraftsOf(
  provider: GatewayProviderWire,
  modelSameAs: Record<string, string>,
): Record<string, string> {
  const drafts: Record<string, string> = {};
  for (const model of provider.models) {
    const same = modelSameAs[`${provider.id}/${model.id}`];
    if (same !== undefined && same.length > 0) {
      drafts[model.id] = same;
    }
  }
  return drafts;
}

/**
 * One model's price as saved, from what the user typed and the catalog's
 * price: a price identical to the catalog's is not written at all (null).
 */
export function parseModelPriceDraft(
  draft: ModelPriceDraft,
  catalog: GatewayPriceWire | null,
): { price: GatewayPriceWire | null; error?: "invalid" | "tier" } {
  if (Object.values(draft).every((value) => value.trim().length === 0)) {
    return { price: null };
  }
  const values = priceValues(draft, catalog);
  if (values === null) {
    return { price: null, error: "invalid" };
  }
  const tier = priceTier(draft, values);
  if (tier === "invalid") {
    return { price: null, error: "tier" };
  }
  const price: GatewayPriceWire = {
    inputPerMTok: values.input,
    outputPerMTok: values.output,
    ...(values.cacheRead > 0 ? { cacheReadPerMTok: values.cacheRead } : {}),
    ...(values.cacheWrite > 0 ? { cacheWritePerMTok: values.cacheWrite } : {}),
    ...(values.cacheWrite1h > 0 ? { cacheWrite1hPerMTok: values.cacheWrite1h } : {}),
    ...(tier === null ? {} : { tiers: [tier] }),
  };
  if (catalog !== null && samePrice(price, catalog)) {
    return { price: null };
  }
  return { price };
}

interface PriceValues {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h: number;
}

/** The five prices, empty fields taken from the catalog; null when one is bad. */
function priceValues(draft: ModelPriceDraft, catalog: GatewayPriceWire | null): PriceValues | null {
  const valueOf = (text: string, fallback: number | undefined) => {
    if (text.trim().length === 0) {
      return fallback;
    }
    const value = decimalOf(text);
    return value === null || value < 0 ? undefined : value;
  };
  const input = valueOf(draft.input, catalog?.inputPerMTok);
  const output = valueOf(draft.output, catalog?.outputPerMTok);
  const cacheRead = valueOf(draft.cacheRead, catalog?.cacheReadPerMTok ?? 0);
  const cacheWrite = valueOf(draft.cacheWrite, catalog?.cacheWritePerMTok ?? 0);
  const cacheWrite1h = valueOf(draft.cacheWrite1h, catalog?.cacheWrite1hPerMTok ?? 0);
  if (
    input === undefined ||
    output === undefined ||
    cacheRead === undefined ||
    cacheWrite === undefined ||
    cacheWrite1h === undefined
  ) {
    return null;
  }
  return { input, output, cacheRead, cacheWrite, cacheWrite1h };
}

type PriceTierWire = NonNullable<GatewayPriceWire["tiers"]>[number];

/** The long-context tier, null when none was typed, "invalid" when it is wrong. */
function priceTier(draft: ModelPriceDraft, values: PriceValues): PriceTierWire | null | "invalid" {
  if (
    [draft.tierAbove, draft.tierInput, draft.tierOutput].every((value) => value.trim().length === 0)
  ) {
    return null;
  }
  const aboveTokens = parseTokenSize(draft.tierAbove);
  const tierInput = draft.tierInput.trim().length === 0 ? values.input : decimalOf(draft.tierInput);
  const tierOutput =
    draft.tierOutput.trim().length === 0 ? values.output : decimalOf(draft.tierOutput);
  if (
    aboveTokens === null ||
    tierInput === null ||
    tierOutput === null ||
    tierInput < 0 ||
    tierOutput < 0
  ) {
    return "invalid";
  }
  return { aboveTokens, inputPerMTok: tierInput, outputPerMTok: tierOutput };
}

/** Every model's price as the save writes it; null means the key is deleted. */
export function modelPriceUpdates(
  draft: ProviderDraft,
  catalog: Record<string, GatewayPriceWire | null>,
): { prices: Record<string, GatewayPriceWire | null>; error?: "invalid" | "tier"; model?: string } {
  const prices: Record<string, GatewayPriceWire | null> = {};
  for (const model of draft.models) {
    const priceDraft = draft.prices[model.id] ?? emptyModelPriceDraft();
    const parsed = parseModelPriceDraft(priceDraft, catalog[model.id] ?? null);
    if (parsed.error !== undefined) {
      return { prices: {}, error: parsed.error, model: model.id };
    }
    prices[model.id] = parsed.price;
  }
  return { prices };
}
