import type { GatewayProvider } from "./config.js";

/**
 * Peak billing, ported from myna: a few vendors sell DeepSeek's models at an
 * off-peak list price and bill twice it in their peak hours. Each one's own
 * pricing page says so; models.dev's cost multiplier that would say it is
 * left out of its api.json.
 */

/** The vendors that bill by the hour, and the hours they bill. */
export type PeakKind = "deepseek" | "weekdays" | "ollama";

/** What a call in the peak hours costs, times the off-peak price. */
export const PEAK_FACTOR = 2;

interface PeakBill {
  /** Whether a base URL is the vendor's API. */
  at: (base: string) => boolean;
  /** Its ids, for a provider with no URL of its own (a plugin's, one removed since). */
  ids: readonly string[];
  kind: PeakKind;
  /** The ids it bills so, without a maker's prefix; undefined: every model. */
  models?: readonly string[];
  /** A listed model with a tag after a colon is the same model. */
  tagged?: boolean;
}

const PEAK_BILLS: readonly PeakBill[] = [
  // DeepSeek's own API, every model: "Off-peak rates are half of the peak
  // rates" (https://api-docs.deepseek.com/quick_start/pricing).
  {
    at: (base) => hostOf(base) === "api.deepseek.com",
    ids: ["deepseek"],
    kind: "deepseek",
  },
  // Command Code's DeepSeek V4 models; its deepseek-v4-flash-fast is one
  // price at every hour (https://commandcode.ai/docs/resources/pricing-limits).
  {
    at: (base) => hostOf(base) === "api.commandcode.ai",
    ids: ["commandcode", "commandcode-plan"],
    kind: "weekdays",
    models: [
      "deepseek-v4.1-flash",
      "deepseek-v4.1-flash-fast",
      "deepseek-v4-flash",
      "deepseek-v4-flash-vision-exp",
      "deepseek-v4-pro",
    ],
  },
  // OpenCode Go's (https://opencode.ai/docs/go); Zen's is one price.
  {
    at: (base) => openCodeGateway(base) === "go",
    ids: ["opencode-go"],
    kind: "weekdays",
    models: ["deepseek-v4.1-flash", "deepseek-v4-pro"],
  },
  // Ollama Cloud's two Off-Peak rows (https://ollama.com/pricing).
  {
    at: (base) => hostOf(base) === "ollama.com",
    ids: ["ollama-cloud"],
    kind: "ollama",
    models: ["deepseek-v4.1-flash", "deepseek-v4-pro"],
    tagged: true,
  },
];

/**
 * The hours a call to `modelId` at `provider` is billed double in, by the
 * vendor it sends it to: its base URL says which, and a provider whose base
 * names no vendor (a plugin's) is told by its id. Null for any other provider
 * or model, which keeps one price at every hour.
 */
export function peakOf(
  provider: Pick<GatewayProvider, "id" | "baseUrl">,
  modelId: string,
): PeakKind | null {
  const model = bareModelId(modelId);
  const base = provider.baseUrl.trim();
  const url = base !== "" && !base.startsWith("plugin://") ? base : null;
  for (const bill of PEAK_BILLS) {
    if (!billServes(bill, model)) {
      continue;
    }
    if (url !== null) {
      if (bill.at(url)) {
        return bill.kind;
      }
      continue;
    }
    if (bill.ids.includes(provider.id)) {
      return bill.kind;
    }
  }
  return null;
}

function billServes(bill: PeakBill, model: string): boolean {
  if (bill.models === undefined || bill.models.includes(model)) {
    return true;
  }
  const colon = model.indexOf(":");
  return bill.tagged === true && colon >= 0 && bill.models.includes(model.slice(0, colon));
}

function bareModelId(modelId: string): string {
  const model = modelId.trim().toLowerCase();
  return model.slice(model.lastIndexOf("/") + 1);
}

/** myna's HostOf: the host a base URL names, without its scheme or path. */
function hostOf(base: string): string {
  let host = base.trim();
  const scheme = host.indexOf("://");
  if (scheme >= 0) {
    host = host.slice(scheme + 3);
  }
  const end = host.search(/[/?#]/);
  return (end < 0 ? host : host.slice(0, end)).toLowerCase();
}

/** "go" for OpenCode Go's gateway, "zen" for Zen's, "" for any other. */
function openCodeGateway(base: string): "go" | "zen" | "" {
  let url: URL;
  try {
    url = new URL(base.trim());
  } catch {
    return "";
  }
  if (!openCodeHost(url.hostname)) {
    return "";
  }
  const segments = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
  if (segments[0] !== "zen" && segments[0] !== "inference") {
    return "";
  }
  if (segments.length > 1) {
    if (segments[1] === "go") {
      return "go";
    }
    if (segments[1] === "custom") {
      return "";
    }
  }
  return "zen";
}

function openCodeHost(host: string): boolean {
  const name = host.toLowerCase().replace(/\.$/, "");
  return name === "opencode.ai" || name.endsWith(".opencode.ai");
}

/**
 * Whether a call made at `at` is in the peak hours of `peak`: weekdays in UTC,
 * never a weekend, and DeepSeek's own never on a Chinese public holiday. A
 * time that isn't known is not at peak.
 */
export function peakAt(peak: PeakKind | null, at: number): boolean {
  if (peak === null || !Number.isFinite(at)) {
    return false;
  }
  const date = new Date(at);
  const day = date.getUTCDay();
  if (day === 0 || day === 6) {
    return false;
  }
  const hour = date.getUTCHours();
  if (peak === "ollama") {
    return hour >= 12 && hour < 18;
  }
  if (!((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10))) {
    return false;
  }
  // The peak hours are 09:00 to 18:00 in China, so a holiday's date is the
  // same in UTC.
  return peak !== "deepseek" || !chinaHoliday(at);
}

/**
 * The days off of China's public holidays, as the State Council's notice for
 * each year lists them. It needs a year added each November, when the notice
 * for the next year comes out; a year it doesn't have counts no holiday, so
 * its weekdays are all at peak hours' price, the most a call could have cost.
 */
const CN_HOLIDAYS: Record<number, readonly string[]> = {
  // 国务院办公厅关于2026年部分节假日安排的通知, 2025-11-04.
  2026: [
    "01-01",
    "01-02",
    "01-03", // 元旦
    "02-15",
    "02-16",
    "02-17",
    "02-18",
    "02-19",
    "02-20",
    "02-21",
    "02-22",
    "02-23", // 春节
    "04-04",
    "04-05",
    "04-06", // 清明节
    "05-01",
    "05-02",
    "05-03",
    "05-04",
    "05-05", // 劳动节
    "06-19",
    "06-20",
    "06-21", // 端午节
    "09-25",
    "09-26",
    "09-27", // 中秋节
    "10-01",
    "10-02",
    "10-03",
    "10-04",
    "10-05",
    "10-06",
    "10-07", // 国庆节
  ],
};

/** Whether `at`'s date, in China (UTC+8 all year), is a day off. */
export function chinaHoliday(at: number): boolean {
  const china = new Date(at + 8 * 60 * 60 * 1000);
  const month = String(china.getUTCMonth() + 1).padStart(2, "0");
  const day = String(china.getUTCDate()).padStart(2, "0");
  return (CN_HOLIDAYS[china.getUTCFullYear()] ?? []).includes(`${month}-${day}`);
}
