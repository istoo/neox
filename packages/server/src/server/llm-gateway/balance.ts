/**
 * What is left on a provider's key, as the provider's own balance endpoint
 * reports it. A provider may name the endpoint and where the amount sits in
 * the reply; without one, the vendor it calls is known by its host and asked
 * the way myna asks it. `{key}` in a URL is replaced with the key.
 */

export interface BalanceTarget {
  /** The user's own endpoint; when empty the vendor's default is asked. */
  balanceUrl?: string;
  /** The amount's field in the reply, dot-separated (`data.balance`). */
  balancePath?: string;
  apiKey?: string;
  /** The provider's base URLs, which name the vendor for the default table. */
  baseUrls?: string[];
  headers?: Record<string, string>;
  /** GET unless said; POST carries no body, which is all some endpoints answer. */
  method?: "GET" | "POST";
  /** The account's own token, asked instead of the key where a vendor wants one. */
  token?: string;
}

export interface BalanceResult {
  /** The amount as the provider words it; `null` when it could not be read. */
  amount: string | null;
  error?: string;
}

const TIMEOUT_MS = 10_000;
const MAX_REPLY_BYTES = 1024 * 1024;
/** Fields a reply usually keeps the amount in when the path is not given. */
const COMMON_FIELDS = ["balance", "credits", "total_balance", "remain", "quota"];

interface VendorBalance {
  /** The hosts whose providers are asked this vendor's endpoint. */
  hosts: string[];
  /** The endpoint, which takes the matched host. */
  url: (host: string) => string;
  /** The amount the reply tells, or `null` when it tells none. */
  read: (body: unknown) => string | null;
  /** Words a refusal only this vendor gives, in place of the status. */
  failed?: (status: number, body: unknown) => string | undefined;
}

/**
 * The vendors myna knows, read off the provider's base URL's host. Exported
 * so tests can point a vendor at a local server, as myna's Vendors are.
 */
export const VENDOR_BALANCES: VendorBalance[] = [
  {
    hosts: ["api.deepseek.com"],
    url: () => "https://api.deepseek.com/user/balance",
    read: readDeepSeek,
  },
  {
    hosts: ["api.moonshot.cn"],
    url: () => "https://api.moonshot.cn/v1/users/me/balance",
    read: (body) => readMoonshot(body, "¥"),
  },
  {
    hosts: ["api.moonshot.ai"],
    url: () => "https://api.moonshot.ai/v1/users/me/balance",
    read: (body) => readMoonshot(body, "$"),
  },
  {
    hosts: ["openrouter.ai"],
    url: () => "https://openrouter.ai/api/v1/credits",
    read: readOpenRouter,
  },
  {
    hosts: ["api.siliconflow.cn"],
    url: () => "https://api.siliconflow.cn/v1/user/info",
    read: (body) => readSiliconFlow(body, "¥"),
    failed: siliconFlowRetired("https://cloud.siliconflow.cn", " (余额充值 → 代金券)"),
  },
  {
    hosts: ["api.siliconflow.com"],
    url: () => "https://api.siliconflow.com/v1/user/info",
    read: (body) => readSiliconFlow(body, "$"),
    failed: siliconFlowRetired("https://cloud.siliconflow.com", ""),
  },
  {
    hosts: ["api.stepfun.com"],
    url: () => "https://api.stepfun.com/v1/accounts",
    read: (body) => readStepFun(body, "¥"),
  },
  {
    hosts: ["api.stepfun.ai"],
    url: () => "https://api.stepfun.ai/v1/accounts",
    read: (body) => readStepFun(body, "$"),
  },
  {
    hosts: ["api.commandcode.ai"],
    url: () => "https://api.commandcode.ai/alpha/billing/credits",
    read: readCommandCode,
  },
  {
    // The credits bought past the plan's allowance.
    hosts: ["ollama.com"],
    url: () => "https://ollama.com/api/balance",
    read: readOllama,
  },
  {
    // Despite its name, `total_usage` is what is left on the key.
    hosts: ["aihubmix.com"],
    url: () => "https://aihubmix.com/dashboard/billing/remain",
    read: readAiHubMix,
  },
  {
    // The account report their consoles read; a coding plan's endpoints are
    // skipped in defaultBalanceFor.
    hosts: ["open.bigmodel.cn"],
    url: (host) => `https://${host}/api/biz/account/query-customer-account-report`,
    read: (body) => readZhipu(body, "¥"),
  },
  {
    hosts: ["api.z.ai"],
    url: (host) => `https://${host}/api/biz/account/query-customer-account-report`,
    read: (body) => readZhipu(body, "$"),
  },
];

export async function readProviderBalance(target: BalanceTarget): Promise<BalanceResult> {
  const custom = target.balanceUrl?.trim() ?? "";
  const fallback = custom.length === 0 ? defaultBalanceFor(target.baseUrls ?? []) : null;
  const url = custom.length > 0 ? custom : (fallback?.url ?? "");
  if (url.length === 0) {
    return { amount: null, error: "No balance URL" };
  }
  if (!/^https?:\/\//i.test(url)) {
    return { amount: null, error: "The balance URL must be http or https" };
  }
  const key = target.apiKey?.trim() ?? "";
  const asked = await askBalance({
    url: withKey(url, key),
    method: custom.length > 0 ? (target.method ?? "GET") : "GET",
    headers: balanceHeaders(target.headers, target.token, key),
    fallback,
  });
  if ("error" in asked) {
    return { amount: null, error: asked.error };
  }
  if (fallback !== null) {
    return amountResult(fallback.read(asked.body), "");
  }
  const path = target.balancePath?.trim() || defaultPathFor(url);
  return amountResult(readAmount(asked.body, path), path);
}

/** The provider's own headers, with the account token or else the key. */
function balanceHeaders(
  headers: Record<string, string> | undefined,
  token: string | undefined,
  key: string,
): Record<string, string> {
  const out: Record<string, string> = { ...headers, Accept: "application/json" };
  const authorization = token?.trim() ?? "";
  if (authorization.length > 0) {
    out.Authorization = `Bearer ${authorization}`;
  } else if (key.length > 0) {
    out.Authorization = `Bearer ${key}`;
  }
  return out;
}

function amountResult(amount: string | null, path: string): BalanceResult {
  if (amount !== null) {
    return { amount };
  }
  return {
    amount: null,
    error: path.length === 0 ? "No amount in the balance reply" : `No ${path} in the balance reply`,
  };
}

async function askBalance(input: {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  fallback: DefaultBalance | null;
}): Promise<{ body: unknown } | { error: string }> {
  let status = 0;
  let body: unknown = null;
  try {
    const response = await fetch(input.url, {
      method: input.method,
      headers: input.headers,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    status = response.status;
    const text = await response.text();
    if (text.length > MAX_REPLY_BYTES) {
      return { error: "The balance reply is too large" };
    }
    body = parseJson(text);
    if (!response.ok) {
      const failure = input.fallback?.failed?.(status, body);
      return { error: failure ?? `The balance endpoint answered ${status}` };
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  if (body === null) {
    return { error: "The balance reply is not JSON" };
  }
  return { body };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

interface DefaultBalance {
  url: string;
  read: (body: unknown) => string | null;
  failed?: (status: number, body: unknown) => string | undefined;
}

function defaultBalanceFor(bases: string[]): DefaultBalance | null {
  for (const base of bases) {
    const host = hostOf(base);
    // A GLM Coding Plan's windows are that key's allowance; its cash
    // balance would only be noise beside them.
    if (host === "open.bigmodel.cn" || host === "api.z.ai") {
      if (base.includes("/api/coding/")) {
        continue;
      }
    }
    const vendor = VENDOR_BALANCES.find((entry) => entry.hosts.includes(host));
    if (vendor !== undefined) {
      return {
        url: vendor.url(host),
        read: vendor.read,
        ...(vendor.failed === undefined ? {} : { failed: vendor.failed }),
      };
    }
  }
  return null;
}

function hostOf(value: string): string {
  try {
    return new URL(value.trim()).host.toLowerCase();
  } catch {
    return "";
  }
}

/** The amount's path a panel's reply is known by, when the user named none. */
function defaultPathFor(url: string): string {
  let path = "";
  try {
    path = new URL(url).pathname.replace(/\/+$/, "");
  } catch {
    return "";
  }
  switch (path) {
    case "/api/usage/token":
      // new-api's query for a key: what is left on it, $1 to 500000.
      return "$data.total_available / 500000";
    case "/api/user/self":
      // new-api's account query: the quota, in the same units.
      return "$data.quota / 500000";
    case "/api/v1/user/profile":
      // A sub2api panel's profile, asked with its login JWT.
      return "$data.balance";
    default:
      return path.endsWith("/dashboard/billing/credit_grants") ? "$total_available" : "";
  }
}

function withKey(url: string, key: string | undefined): string {
  if (key === undefined || key.length === 0 || !url.includes("{key}")) {
    return url;
  }
  return url.replaceAll("{key}", encodeURIComponent(key));
}

function readAmount(body: unknown, path: string): string | null {
  if (path.length > 0) {
    const expression = /^(.*?)(?:\s*([*/])\s*(\d+(?:\.\d+)?))?$/.exec(path);
    const field = expression?.[1]?.trim() ?? path;
    const operator = expression?.[2];
    const operand = expression?.[3];
    const found = amountAt(body, field);
    if (found === null) {
      return null;
    }
    if (operator === undefined || operand === undefined) {
      return found;
    }
    const value = Number.parseFloat(found);
    if (!Number.isFinite(value)) {
      return found;
    }
    const factor = Number.parseFloat(operand);
    const result = operator === "*" ? value * factor : value / factor;
    return String(Number(result.toFixed(6)));
  }
  if (typeof body === "string" || typeof body === "number") {
    return String(body);
  }
  const record = asRecord(body);
  for (const field of COMMON_FIELDS) {
    const found = amountAt(record, field);
    if (found !== null) {
      return found;
    }
  }
  const data = asRecord(record.data);
  for (const field of COMMON_FIELDS) {
    const found = amountAt(data, field);
    if (found !== null) {
      return found;
    }
  }
  return null;
}

function amountAt(value: unknown, path: string): string | null {
  let current: unknown = value;
  for (const part of path.replace(/^\$?\.?/, "").split(".")) {
    if (part.length === 0) {
      continue;
    }
    const record = asRecord(current);
    current = Array.isArray(current) ? current[Number.parseInt(part, 10)] : record[part];
    if (current === undefined) {
      return null;
    }
  }
  return textOf(current);
}

function textOf(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

/** An amount given as a JSON number or as a string of one. */
function numberOf(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number.parseFloat(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** How myna words an amount: its currency's sign and two decimals. */
function money(sign: string, value: number): string {
  return `${sign}${value.toFixed(2)}`;
}

function fieldsOf(body: unknown, ...fields: string[]): Record<string, unknown>[] {
  const record = asRecord(body);
  return fields.length === 0 ? [record] : fields.map((field) => asRecord(record[field]));
}

/** DeepSeek lists an account's currencies; money left first, then by code. */
function readDeepSeek(body: unknown): string | null {
  const infos = asRecord(body).balance_infos;
  if (!Array.isArray(infos)) {
    return null;
  }
  const amounts: { code: string; total: number }[] = [];
  for (const raw of infos) {
    const entry = asRecord(raw);
    const total = numberOf(entry.total_balance);
    if (total === null) {
      continue;
    }
    amounts.push({
      code: typeof entry.currency === "string" ? entry.currency.toUpperCase() : "",
      total,
    });
  }
  if (amounts.length === 0) {
    return null;
  }
  amounts.sort((a, b) => {
    if (a.total > 0 !== b.total > 0) {
      return a.total > 0 ? -1 : 1;
    }
    return a.code.localeCompare(b.code);
  });
  return amounts.map((entry) => money(currencySign(entry.code), entry.total)).join(" · ");
}

function currencySign(code: string): string {
  switch (code.toUpperCase()) {
    case "CNY":
    case "RMB":
      return "¥";
    case "USD":
      return "$";
    case "":
      return "";
    default:
      return `${code.toUpperCase()} `;
  }
}

/** `{"data":{"available_balance":49.58}}`. */
function readMoonshot(body: unknown, sign: string): string | null {
  const value = numberOf(fieldsOf(body, "data")[0]?.available_balance);
  return value === null ? null : money(sign, value);
}

/** `{"data":{"total_credits":20,"total_usage":3.5}}`, in dollars. */
function readOpenRouter(body: unknown): string | null {
  const data = fieldsOf(body, "data")[0];
  const credits = numberOf(data?.total_credits);
  if (credits === null) {
    return null;
  }
  return money("$", credits - (numberOf(data?.total_usage) ?? 0));
}

/** `{"data":{"totalBalance":"88.88"}}`. */
function readSiliconFlow(body: unknown, sign: string): string | null {
  const value = numberOf(fieldsOf(body, "data")[0]?.totalBalance);
  return value === null ? null : money(sign, value);
}

/**
 * SiliconFlow retired its balance query; the page it answers with says so,
 * and the console is where the balance is now.
 */
function siliconFlowRetired(
  console: string,
  where: string,
): (status: number, body: unknown) => string | undefined {
  return (status, body) => {
    const code = numberOf(asRecord(body).code);
    if (status !== 410 && code !== 20092) {
      return undefined;
    }
    return `SiliconFlow retired its balance query (/v1/user/info) and has no API for it in its place yet; the balance and vouchers are on ${console}${where}`;
  };
}

/** `{"object":"account","balance":26.00,…}`. */
function readStepFun(body: unknown, sign: string): string | null {
  const value = numberOf(asRecord(body).balance);
  return value === null ? null : money(sign, value);
}

/** The month's credits plus the bought and free ones, in dollars. */
function readCommandCode(body: unknown): string | null {
  const credits = fieldsOf(body, "credits")[0] ?? {};
  let left = 0;
  let found = false;
  for (const field of ["monthlyCredits", "purchasedCredits", "freeCredits"]) {
    const value = numberOf(credits[field]);
    if (value !== null) {
      left += Math.max(0, value);
      found = true;
    }
  }
  return found ? money("$", left) : null;
}

/** `{"purchased":{"balance_usd":…}}`: the credits bought past the plan. */
function readOllama(body: unknown): string | null {
  const value = numberOf(fieldsOf(body, "purchased")[0]?.balance_usd);
  return value === null ? null : money("$", value);
}

/**
 * `{"total_usage":12.5}`: what is left on the key, despite the name. A key
 * without a limit answers -1, and only the account's token is told that.
 */
function readAiHubMix(body: unknown): string | null {
  const value = numberOf(asRecord(body).total_usage);
  if (value === null) {
    return null;
  }
  if (value < 0) {
    return null;
  }
  return money("$", value);
}

/** `{"data":{"availableBalance":…}}`: what is left to spend, frozen part out. */
function readZhipu(body: unknown, sign: string): string | null {
  const value = numberOf(fieldsOf(body, "data")[0]?.availableBalance);
  return value === null ? null : money(sign, value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
