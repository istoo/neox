import { createHash, createHmac } from "node:crypto";
import type { GatewayProvider } from "./config.js";

/**
 * The plan a provider serves, read from the vendor's control plane with the
 * provider's account access key (myna's `volcengine_usage.go` and
 * `tencent_usage.go`): Volcengine Ark's Coding and Agent Plans, whose
 * 5-hour, weekly and monthly windows only `open.volcengineapi.com` tells
 * (signed with the AccessKey ID and Secret), and Tencent Cloud's Token Plan
 * 企业版, whose cycle usage only `tokenhub.tencentcloudapi.com` tells (signed
 * with the SecretId and SecretKey). Neither is the plan's inference key.
 */

const DAY_MS = 24 * 60 * 60_000;
const VOLC_HOST = "open.volcengineapi.com";
const VOLC_VERSION = "2024-01-01";
const VOLC_SERVICE = "ark";
const VOLC_DEFAULT_REGION = "cn-beijing";
const VOLC_HINT =
  "check the AccessKey ID and Secret in the provider's editor, and that the access key may query Ark (IAM)";
const TC_HOST = "tokenhub.tencentcloudapi.com";
const TC_VERSION = "2026-03-22";
const TC_SERVICE = "tokenhub";
const TC_CONTENT_TYPE = "application/json; charset=utf-8";
const TC_PLAN = "Token Plan Enterprise";
const TC_HINT =
  "check the SecretId and SecretKey in the provider's editor (Tencent Cloud console → Access management → API keys), and that the key may read TokenHub (CAM)";

/** One window a plan's control plane reports. */
export interface PlanWindow {
  id: string;
  /** The vendor's word for it ("5 hours", "Weekly", "Month"). */
  name: string;
  usedPercent: number;
  remaining: number | null;
  limit: number | null;
  resetsAt: number | null;
  windowMs: number;
}

/** One plan the account holds: Ark's Coding or Agent Plan, or one TokenHub team plan. */
export interface PlanCard {
  /** Stable within the provider: the action, or the team's id. */
  id: string;
  /** "Coding Plan", "Agent Plan <tier>", "Token Plan Enterprise". */
  plan: string;
  /** The team a multi-team Token Plan card is of, as myna names it. */
  user?: string;
  windows: PlanWindow[];
  /** Why this plan has no windows, when it doesn't. */
  error?: string;
}

/** One answer from a plan's control plane. */
export interface PlanReading {
  cards: PlanCard[];
  readAt: number;
}

/** The control plane and account a provider's plan is read from. */
export interface PlanSource {
  vendor: "volcengine" | "tencent";
  plan: string;
  region: string;
  /** Volcengine's control-plane action; null for Tencent's two. */
  action: string | null;
  accessKeyId: string;
  secretAccessKey: string;
}

export type PlanLookup =
  | { kind: "read"; source: PlanSource }
  /** The plan endpoint is in use but the access key is not filled in. */
  | {
      kind: "no-key";
      vendor: PlanSource["vendor"];
      plan: string;
      region: string;
      action: string | null;
    };

/** The provider's plan and where to read it, from its endpoint and access key. */
export function planLookupOf(provider: GatewayProvider): PlanLookup | null {
  const volc = volcPlanOf(provider);
  if (volc !== null) {
    return planLookup(volc, provider);
  }
  const region = tencentPlanRegion(provider);
  if (region === null) {
    return null;
  }
  return planLookup({ vendor: "tencent", plan: TC_PLAN, region, action: null }, provider);
}

function planLookup(
  base: Omit<PlanSource, "accessKeyId" | "secretAccessKey">,
  provider: GatewayProvider,
): PlanLookup {
  const accessKeyId = provider.accessKeyId?.trim() ?? "";
  const secretAccessKey = provider.secretAccessKey?.trim() ?? "";
  if (accessKeyId.length === 0 || secretAccessKey.length === 0) {
    return { kind: "no-key", ...base };
  }
  return { kind: "read", source: { ...base, accessKeyId, secretAccessKey } };
}

/** The map key a plan reading is kept under: one per access key and plan. */
export function planKeyOf(
  source: Omit<PlanSource, "accessKeyId" | "secretAccessKey"> & {
    accessKeyId: string;
  },
): string {
  return `${source.vendor}:${source.action ?? source.region}:${source.accessKeyId}`;
}

/** The key a provider's plan reading is kept under, when it has one. */
export function planReadingKeyOf(provider: GatewayProvider): string | null {
  const lookup = planLookupOf(provider);
  return lookup?.kind === "read" ? planKeyOf(lookup.source) : null;
}

/**
 * Why a plan's card has no windows when its access key is missing: what to
 * give, and where (myna's noAccessKeyError).
 */
export function noAccessKeyError(provider: GatewayProvider, vendor: PlanSource["vendor"]): string {
  const fields = vendor === "tencent" ? "SecretId and SecretKey" : "AccessKey ID and Secret";
  const name = provider.label ?? provider.id;
  return `this plan's usage is read with the account's access key: give its ${fields} in ${name}'s settings`;
}

/** Ark's Coding Plan or Agent Plan, from the endpoint's host and path. */
function volcPlanOf(
  provider: GatewayProvider,
): Omit<PlanSource, "accessKeyId" | "secretAccessKey"> | null {
  let url: URL;
  try {
    url = new URL(provider.baseUrl);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (!host.startsWith("ark.") || !host.endsWith(".volces.com")) {
    return null;
  }
  const path = `${url.pathname.replace(/\/$/, "")}/`;
  if (path.startsWith("/api/coding/")) {
    return {
      vendor: "volcengine",
      plan: "Coding Plan",
      region: volcRegion(host),
      action: "GetCodingPlanUsage",
    };
  }
  if (path.startsWith("/api/plan/")) {
    return {
      vendor: "volcengine",
      plan: "Agent Plan",
      region: volcRegion(host),
      action: "GetAFPUsage",
    };
  }
  return null;
}

/** ark.cn-beijing.volces.com is cn-beijing; cn-beijing when the host names none. */
function volcRegion(host: string): string {
  const labels = host.split(".");
  return labels.length === 4 && labels[0] === "ark" && labels[1] !== ""
    ? labels[1]!
    : VOLC_DEFAULT_REGION;
}

/**
 * TokenHub's Token Plan endpoint: ap-guangzhou for
 * tokenhub.tencentmaas.com/plan, ap-singapore for
 * tokenhub-intl.tencentmaas.com/plan; null for pay as you go or elsewhere.
 */
function tencentPlanRegion(provider: GatewayProvider): string | null {
  let url: URL;
  try {
    url = new URL(provider.baseUrl);
  } catch {
    return null;
  }
  if (!`${url.pathname.replace(/\/$/, "")}/`.startsWith("/plan/")) {
    return null;
  }
  switch (url.hostname.toLowerCase()) {
    case "tokenhub.tencentmaas.com":
      return "ap-guangzhou";
    case "tokenhub-intl.tencentmaas.com":
      return "ap-singapore";
    default:
      return null;
  }
}

/** Reads a plan now; the network is asked only here. */
export async function readPlanUsage(
  source: PlanSource,
  options: { now?: number; fetch?: typeof fetch } = {},
): Promise<PlanReading> {
  const now = options.now ?? Date.now();
  const fetchImpl = options.fetch ?? fetch;
  try {
    if (source.vendor === "volcengine") {
      return await readVolc(source, now, fetchImpl);
    }
    return await readTencent(source, now, fetchImpl);
  } catch (error) {
    return errorReading(source, now, messageOf(error));
  }
}

/** A failed read as one card that says why, named for the plan it asked about. */
function errorReading(
  source: Omit<PlanSource, "accessKeyId" | "secretAccessKey">,
  now: number,
  error: string,
  id = source.action === "GetAFPUsage" ? "afp" : "coding",
): PlanReading {
  return { cards: [{ id, plan: source.plan, windows: [], error }], readAt: now };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/* ------------------------------------------------------------- Volcengine */

async function readVolc(
  source: PlanSource,
  now: number,
  fetchImpl: typeof fetch,
): Promise<PlanReading> {
  const action = source.action ?? "GetCodingPlanUsage";
  const query = new URLSearchParams({ Action: action, Version: VOLC_VERSION });
  const body = "{}";
  const signed = volcSign(
    source.accessKeyId,
    source.secretAccessKey,
    source.region,
    query,
    body,
    now,
  );
  const headers = new Headers();
  headers.set("Content-Type", "application/json");
  headers.set("X-Date", signed.xDate);
  headers.set("X-Content-Sha256", signed.contentSha);
  headers.set("Accept", "application/json");
  headers.set("Authorization", signed.authorization);
  const response = await fetchImpl(`https://${VOLC_HOST}/?${volcQuery(query)}`, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(10_000),
  });
  const raw = await response.text();
  return finishVolc(source, now, action, response, raw);
}

function finishVolc(
  source: PlanSource,
  now: number,
  action: string,
  response: Response,
  raw: string,
): PlanReading {
  const payload = parseJson(raw);
  const error = volcError(payload);
  if (error !== null) {
    return errorReading(source, now, error);
  }
  if (response.status === 401 || response.status === 403) {
    return errorReading(source, now, `Volcengine ${action}: ${response.status}; ${VOLC_HINT}`);
  }
  if (response.status >= 300) {
    return errorReading(source, now, `Volcengine ${action}: ${response.status}: ${head(raw)}`);
  }
  const result = recordOf(payload)?.["Result"];
  const read = action === "GetAFPUsage" ? volcReadAfp(result) : { windows: volcReadCoding(result) };
  if (read.windows.length === 0) {
    return errorReading(
      source,
      now,
      `this Volcengine account has no ${source.plan}, or Ark answered ${action} in a form Neox doesn't know: ${head(raw)}`,
    );
  }
  const tier = "tier" in read ? (read.tier ?? "") : "";
  return {
    cards: [
      {
        id: action === "GetAFPUsage" ? "afp" : "coding",
        plan: tier === "" ? source.plan : `${source.plan} ${tier}`,
        windows: read.windows,
      },
    ],
    readAt: now,
  };
}

function volcError(payload: unknown): string | null {
  const metadata = recordOf(recordOf(payload)?.["ResponseMetadata"]);
  const error = recordOf(metadata?.["Error"]);
  if (error === undefined) {
    return null;
  }
  const code = textOf(error["Code"]);
  const message = textOf(error["Message"]);
  if (code === "" && message === "") {
    return null;
  }
  const hint = volcRefusesKey(code) ? `; ${VOLC_HINT}` : "";
  return `Volcengine ${code} ${message}${hint}`.trim();
}

function volcRefusesKey(code: string): boolean {
  const lowered = code.toLowerCase();
  return [
    "accesskey",
    "signature",
    "accessdenied",
    "unauthorized",
    "forbidden",
    "credential",
    "authfailure",
  ].some((word) => lowered.includes(word));
}

const VOLC_WINDOWS: Record<string, { id: string; name: string; span: number }> = {
  session: { id: "plan-session", name: "5 hours", span: 5 * 60 * 60_000 },
  weekly: { id: "plan-weekly", name: "Weekly", span: 7 * DAY_MS },
  monthly: { id: "plan-month", name: "Month", span: 30 * DAY_MS },
};

interface VolcWindowRead {
  windows: PlanWindow[];
  tier?: string;
}

function volcReadCoding(result: unknown): PlanWindow[] {
  const usage = recordOf(result)?.["QuotaUsage"];
  if (!Array.isArray(usage)) {
    return [];
  }
  const windows: PlanWindow[] = [];
  for (const item of usage) {
    const entry = recordOf(item);
    if (entry === undefined) {
      continue;
    }
    const window = VOLC_WINDOWS[textOf(entry["Level"]).toLowerCase()];
    const used = numberOf(entry["Percent"]);
    if (window === undefined || used === null) {
      continue;
    }
    windows.push(planWindow(window, used, null, null, timeOf(entry["ResetTimestamp"])));
  }
  return windows;
}

function volcReadAfp(result: unknown): VolcWindowRead {
  const record = recordOf(result);
  if (record === undefined) {
    return { windows: [] };
  }
  const windows: PlanWindow[] = [];
  const buckets: Array<[string, unknown]> = [
    ["session", record["AFPFiveHour"]],
    ["weekly", record["AFPWeekly"]],
    ["monthly", record["AFPMonthly"]],
  ];
  for (const [level, raw] of buckets) {
    const bucket = recordOf(raw);
    const window = VOLC_WINDOWS[level];
    if (bucket === undefined || window === undefined) {
      continue;
    }
    const read = afpShare(bucket);
    if (read === null) {
      continue;
    }
    const reset = timeOf(bucket["ResetTime"]) ?? timeOf(bucket["ResetTimestamp"]);
    windows.push(planWindow(window, read.usedPercent, read.used, read.limit, reset));
  }
  return { windows, tier: textOf(record["Tier"]).trim() };
}

function afpShare(bucket: Record<string, unknown>): {
  usedPercent: number;
  used: number | null;
  limit: number | null;
} | null {
  const percent = numberOf(bucket["Percent"]);
  if (percent !== null) {
    return { usedPercent: percent, used: null, limit: null };
  }
  const used = numberOf(bucket["Used"]);
  const limit = numberOf(bucket["Quota"]) ?? numberOf(bucket["Total"]);
  if (used === null || limit === null || limit <= 0) {
    return null;
  }
  return { usedPercent: (used / limit) * 100, used, limit };
}

/* ---------------------------------------------------------------- Tencent */

async function readTencent(
  source: PlanSource,
  now: number,
  fetchImpl: typeof fetch,
): Promise<PlanReading> {
  const list = await tencentCall(
    source,
    "DescribeTokenPlanList",
    { Offset: 0, Limit: 100 },
    now,
    fetchImpl,
  );
  const entries = tencentPlans(list.payload);
  if (entries.length === 0) {
    return errorReading(
      { ...source, action: null },
      now,
      `this Tencent Cloud account has no ${source.plan} in ${source.region} that its API key can see (a sub-user sees only the plans it made)`,
      "tencent",
    );
  }
  const details = await Promise.all(
    entries.map(async (entry) => tencentDetail(source, entry, now, fetchImpl).catch(() => entry)),
  );
  const cards: PlanCard[] = details.map((entry) => {
    const window = tencentWindow(entry, now);
    const card: PlanCard = {
      id: entry.teamId,
      plan: tencentPlanLabel(entry, source.plan),
      windows: window === null ? [] : [window],
    };
    // A team's name distinguishes its card only when there is more than
    // one, as myna's User does.
    if (details.length > 1) {
      card.user = entry.name;
    }
    if (window === null) {
      card.error = `Tencent Cloud told no quota for this ${source.plan}: ${head(JSON.stringify(list.payload))}`;
    }
    return card;
  });
  return { cards, readAt: now };
}

/** The plan as a card names it: myna adds the status of a plan that is not enabled. */
function tencentPlanLabel(entry: TencentPlan, plan: string): string {
  const status = entry.status.trim();
  return status === "" || status.toLowerCase() === "enable" ? plan : `${plan} · ${status}`;
}

interface TencentCall {
  payload: unknown;
}

async function tencentCall(
  source: PlanSource,
  action: string,
  params: Record<string, unknown>,
  now: number,
  fetchImpl: typeof fetch,
): Promise<TencentCall> {
  const body = JSON.stringify(params);
  const headers = new Headers();
  headers.set("Content-Type", TC_CONTENT_TYPE);
  headers.set("X-TC-Action", action);
  headers.set("X-TC-Version", TC_VERSION);
  headers.set("X-TC-Region", source.region);
  headers.set("X-TC-Timestamp", String(Math.floor(now / 1000)));
  const sign = tc3Sign;
  const signature = sign(
    source.accessKeyId,
    source.secretAccessKey,
    TC_SERVICE,
    TC_HOST,
    action,
    body,
    now,
  );
  headers.set("Authorization", signature);
  const response = await fetchImpl(`https://${TC_HOST}/`, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(10_000),
  });
  const raw = await response.text();
  const payload = parseJson(raw);
  const error = tencentError(payload);
  if (error !== null) {
    throw new Error(error);
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error(`Tencent Cloud ${action}: ${response.status}; ${TC_HINT}`);
  }
  if (response.status >= 300) {
    throw new Error(`Tencent Cloud ${action}: ${response.status}: ${head(raw)}`);
  }
  return { payload };
}

function tencentError(payload: unknown): string | null {
  const error = recordOf(recordOf(payload)?.["Response"])?.["Error"];
  const record = recordOf(error);
  if (record === undefined) {
    return null;
  }
  const code = textOf(record["Code"]);
  const message = textOf(record["Message"]);
  if (code === "" && message === "") {
    return null;
  }
  const hint = tencentRefusesKey(code) ? `; ${TC_HINT}` : "";
  return `Tencent Cloud ${code} ${message}${hint}`.trim();
}

function tencentRefusesKey(code: string): boolean {
  const lowered = code.toLowerCase();
  return lowered.startsWith("authfailure") || lowered.includes("unauthorized");
}

interface TencentPlan {
  teamId: string;
  name: string;
  status: string;
  productType: string;
  packageInfo: Record<string, unknown> | undefined;
  tokenSummary: Record<string, unknown> | undefined;
}

function tencentPlans(payload: unknown): TencentPlan[] {
  const set = recordOf(recordOf(payload)?.["Response"])?.["TokenPlanSet"];
  if (!Array.isArray(set)) {
    return [];
  }
  const plans: TencentPlan[] = [];
  for (const raw of set) {
    const entry = tencentPlanOf(raw);
    if (entry !== null) {
      plans.push(entry);
    }
  }
  return plans;
}

function tencentPlanOf(raw: unknown): TencentPlan | null {
  const record = recordOf(raw);
  const teamId = textOf(record?.["TeamId"]).trim();
  if (record === undefined || teamId === "") {
    return null;
  }
  return {
    teamId,
    name: textOf(record["Name"]).trim() || teamId,
    status: textOf(record["Status"]),
    productType: textOf(record["ProductType"]),
    packageInfo: recordOf(record["PackageInfo"]),
    tokenSummary: recordOf(record["TokenSummary"]),
  };
}

/** The plan's own reply carries its cycle's end; the list's package otherwise. */
async function tencentDetail(
  source: PlanSource,
  entry: TencentPlan,
  now: number,
  fetchImpl: typeof fetch,
): Promise<TencentPlan> {
  const detail = await tencentCall(
    source,
    "DescribeTokenPlan",
    { TeamId: entry.teamId },
    now,
    fetchImpl,
  );
  const record = recordOf(recordOf(detail.payload)?.["Response"]);
  if (record === undefined) {
    return entry;
  }
  return {
    ...entry,
    packageInfo: recordOf(record["PackageInfo"]) ?? entry.packageInfo,
    tokenSummary: recordOf(record["TokenSummary"]) ?? entry.tokenSummary,
    status: textOf(record["Status"]) || entry.status,
    productType: textOf(record["ProductType"]) || entry.productType,
  };
}

function tencentWindow(entry: TencentPlan, now: number): PlanWindow | null {
  const pack = entry.packageInfo;
  if (pack === undefined) {
    return null;
  }
  const limit = numberOf(pack["CycleQuota"]) ?? numberOf(pack["TotalQuota"]);
  const used = numberOf(pack["TotalUsed"]);
  if (limit === null || used === null || limit <= 0) {
    return null;
  }
  const span = tencentSpan(pack, entry.tokenSummary, now);
  const unit = entry.productType.toLowerCase() === "enterprise-auto" ? "tokens" : "credits";
  return {
    id: `plan-month-${unit}`,
    name: "Month",
    usedPercent: Math.min(100, Math.max(0, (used / limit) * 100)),
    remaining: Math.max(0, limit - used),
    limit,
    resetsAt: span.resetsAt,
    windowMs: span.windowMs,
  };
}

/** The cycle's end and length: TokenSummary's, or the package's cycles on from its start. */
function tencentSpan(
  pack: Record<string, unknown>,
  summary: Record<string, unknown> | undefined,
  now: number,
): { resetsAt: number | null; windowMs: number } {
  const end = timeOf(summary?.["CycleEndTime"]);
  const start = timeOf(summary?.["CycleStartTime"]);
  if (end !== null) {
    return {
      resetsAt: end,
      windowMs: start !== null && end > start ? end - start : 30 * DAY_MS,
    };
  }
  const began = timeOf(pack["StartTime"]);
  if (began === null) {
    return { resetsAt: null, windowMs: 30 * DAY_MS };
  }
  const cycles = Math.max(1, Math.trunc(numberOf(pack["CurrentCycle"]) ?? 1));
  let endsAt = addMonths(began, cycles);
  for (let extra = cycles; !(endsAt > now) && extra < 1200; extra += 1) {
    endsAt = addMonths(began, extra + 1);
  }
  const expires = timeOf(pack["ExpireTime"]);
  if (expires !== null && expires < endsAt) {
    endsAt = expires;
  }
  return { resetsAt: endsAt, windowMs: Math.max(0, endsAt - began) || 30 * DAY_MS };
}

function addMonths(at: number, months: number): number {
  const date = new Date(at);
  const day = date.getUTCDate();
  const shifted = new Date(at);
  shifted.setUTCDate(1);
  shifted.setUTCMonth(shifted.getUTCMonth() + months);
  const lastDay = new Date(
    Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, 0),
  ).getUTCDate();
  shifted.setUTCDate(Math.min(day, lastDay));
  return shifted.getTime();
}

/* ------------------------------------------------------------ the signing */

interface VolcSignature {
  authorization: string;
  xDate: string;
  contentSha: string;
}

/**
 * The Authorization header of a POST to Ark's control plane, as
 * volc-sdk-golang's GetSignRequest makes it: HMAC-SHA256 over the canonical
 * request, its scope date/region/ark/request, and a key derived from the
 * bare Secret.
 */
export function volcSign(
  accessKeyId: string,
  secretAccessKey: string,
  region: string,
  query: URLSearchParams,
  body: string,
  now: number,
): VolcSignature {
  const xDate = utcStamp(now);
  const date = xDate.slice(0, 8);
  const contentSha = sha256Hex(body);
  const signedHeaders = "content-type;host;x-content-sha256;x-date";
  const canonical = [
    "POST",
    "/",
    volcQuery(query),
    `content-type:application/json\nhost:${VOLC_HOST}\nx-content-sha256:${contentSha}\nx-date:${xDate}\n`,
    signedHeaders,
    contentSha,
  ].join("\n");
  const scope = `${date}/${region}/${VOLC_SERVICE}/request`;
  const toSign = ["HMAC-SHA256", xDate, scope, sha256Hex(canonical)].join("\n");
  let key = hmac(date, secretAccessKey);
  for (const part of [region, VOLC_SERVICE, "request"]) {
    key = hmac(part, key);
  }
  const signature = createHmac("sha256", key).update(toSign).digest("hex");
  return {
    authorization: `HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    xDate,
    contentSha,
  };
}

/** A query as the SDK signs and sends it: sorted by key, a space as %20. */
function volcQuery(query: URLSearchParams): string {
  return [...query.entries()]
    .sort(([left], [right]) => {
      if (left === right) {
        return 0;
      }
      return left < right ? -1 : 1;
    })
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
}

/**
 * The Authorization header of a POST to Tencent Cloud's API, as its
 * TC3-HMAC-SHA256 signing doc makes it: content-type, host and x-tc-action
 * signed, the scope date/service/tc3_request, and a key derived from "TC3"
 * and the SecretKey.
 */
export function tc3Sign(
  secretId: string,
  secretKey: string,
  service: string,
  host: string,
  action: string,
  payload: string,
  now: number,
): string {
  const date = new Date(now).toISOString().slice(0, 10);
  const signedHeaders = "content-type;host;x-tc-action";
  const canonical = [
    "POST",
    "/",
    "",
    `content-type:${TC_CONTENT_TYPE}\nhost:${host}\nx-tc-action:${action.toLowerCase()}\n`,
    signedHeaders,
    sha256Hex(payload),
  ].join("\n");
  const scope = `${date}/${service}/tc3_request`;
  const seconds = String(Math.floor(now / 1000));
  const toSign = ["TC3-HMAC-SHA256", seconds, scope, sha256Hex(canonical)].join("\n");
  let key = hmac(date, `TC3${secretKey}`);
  for (const part of [service, "tc3_request"]) {
    key = hmac(part, key);
  }
  const signature = createHmac("sha256", key).update(toSign).digest("hex");
  return `TC3-HMAC-SHA256 Credential=${secretId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

function hmac(message: string, key: string | Buffer): Buffer {
  return createHmac("sha256", key).update(message).digest();
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function utcStamp(now: number): string {
  return new Date(now)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

/* -------------------------------------------------------------- the reads */

function planWindow(
  spec: { id: string; name: string; span: number },
  usedPercent: number,
  used: number | null,
  limit: number | null,
  resetsAt: number | null,
): PlanWindow {
  const clamped = Math.min(100, Math.max(0, usedPercent));
  return {
    id: spec.id,
    name: spec.name,
    usedPercent: clamped,
    remaining: used !== null && limit !== null ? Math.max(0, limit - used) : null,
    limit,
    resetsAt,
    windowMs: spec.span,
  };
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** A JSON number, or a string of one. */
function numberOf(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** A reset as epoch seconds, milliseconds or RFC 3339. */
function timeOf(value: unknown): number | null {
  if (typeof value === "string") {
    const parsed = Date.parse(value.trim());
    return Number.isNaN(parsed) ? null : parsed;
  }
  const number = numberOf(value);
  if (number === null || number <= 0) {
    return null;
  }
  // 1e11 seconds is the year 5138, 1e11 ms 1973. A missing reset is on
  // neither side of it.
  return number > 1e11 ? number : number * 1000;
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/** The head of a reply, for an error to say what was answered. */
function head(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.length > 300 ? `${trimmed.slice(0, 300)}…` : trimmed;
}
