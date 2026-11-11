/**
 * Reads the vendors' own status pages.
 *
 * A request that fails while a vendor's API is down looks the same as a bad key
 * in the app, so the provider list says when the vendor itself reports trouble.
 * Only the parts the gateway's requests stand on are read (Anthropic's API and
 * Claude Code, not claude.ai). A page that could not be read is unknown, never
 * "all well".
 */

export type UpstreamLevel = "ok" | "maintenance" | "degraded" | "partial" | "major";

export interface UpstreamPart {
  name: string;
  status: string;
}

export interface UpstreamIncident {
  name: string;
  impact?: string;
  url?: string;
}

export interface UpstreamStatus {
  vendor: string;
  name: string;
  page: string;
  /** The API hosts this vendor answers on, so the app can match providers. */
  hosts: string[];
  /** `null` when the page was not read (none to read, or it failed). */
  level: UpstreamLevel | null;
  parts: UpstreamPart[];
  incidents: UpstreamIncident[];
  /** When the page was read, ISO; `null` for a vendor with no readable page. */
  readAt: string | null;
  error?: string;
}

export interface UpstreamVendor {
  id: string;
  name: string;
  /** The status page people read. */
  page: string;
  /** Its Statuspage-style summary JSON; absent for a page that has none. */
  summary?: string;
  /** The API hosts a provider calls the vendor on. */
  hosts: string[];
  /** Whether a component of the page is one the API stands on. */
  part: (name: string) => boolean;
}

/**
 * The vendors whose pages were checked by hand. OpenAI's summary is
 * incident.io's, which answers the same shape.
 */
export const UPSTREAM_VENDORS: UpstreamVendor[] = [
  {
    id: "anthropic",
    name: "Anthropic",
    page: "https://status.claude.com",
    summary: "https://status.claude.com/api/v2/summary.json",
    hosts: ["api.anthropic.com"],
    // "Claude API (api.anthropic.com)", and "Claude Code", which a Claude
    // subscription's requests run through.
    part: (name) => name.startsWith("Claude API") || name === "Claude Code",
  },
  {
    id: "openai",
    name: "OpenAI",
    page: "https://status.openai.com",
    summary: "https://status.openai.com/api/v2/summary.json",
    hosts: ["api.openai.com", "chatgpt.com"],
    // A ChatGPT account's Codex requests are Responses requests; "Codex in
    // ChatGPT Desktop" is the app, not the API.
    part: (name) => ["Chat Completions", "Responses", "Codex", "Codex CLI"].includes(name),
  },
  {
    id: "moonshot",
    name: "Moonshot AI",
    page: "https://status.moonshot.cn",
    summary: "https://status.moonshot.cn/api/v2/summary.json",
    hosts: ["api.moonshot.cn", "api.moonshot.ai"],
    // The Open API and its models, not Kimi's website or sign-up.
    part: (name) =>
      name === "Open API" || name === "API Service" || name === "Model" || name.endsWith(" Model"),
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    page: "https://status.deepseek.com",
    hosts: ["api.deepseek.com"],
    // Its status page (Flashduty) has no summary JSON the daemon can read.
    part: () => false,
  },
];

/** How long a reading is kept: outages change by the minute, not the second. */
const FRESH_MS = 5 * 60 * 1000;
const READ_TIMEOUT_MS = 10_000;
const MAX_SUMMARY_BYTES = 4 * 1024 * 1024;

const kept = new Map<string, UpstreamStatus>();
const asking = new Map<string, Promise<UpstreamStatus>>();

/** The vendor a provider calling these base URLs reaches, when it is known. */
export function vendorOf(bases: string[]): UpstreamVendor | undefined {
  for (const base of bases) {
    const host = hostOf(base);
    const vendor = UPSTREAM_VENDORS.find((entry) => entry.hosts.includes(host));
    if (vendor !== undefined) {
      return vendor;
    }
  }
  return undefined;
}

export function hostOf(value: string): string {
  const raw = value.trim();
  try {
    return new URL(raw.includes("://") ? raw : `https://${raw}`).host.toLowerCase();
  } catch {
    return raw.toLowerCase();
  }
}

/** Every known vendor's reading, refreshed when older than five minutes. */
export async function readUpstreamStatuses(vendorIds?: string[]): Promise<UpstreamStatus[]> {
  const wanted =
    vendorIds === undefined
      ? UPSTREAM_VENDORS
      : UPSTREAM_VENDORS.filter((vendor) => vendorIds.includes(vendor.id));
  return await Promise.all(wanted.map((vendor) => statusOf(vendor)));
}

async function statusOf(vendor: UpstreamVendor): Promise<UpstreamStatus> {
  const cached = kept.get(vendor.id);
  if (cached !== undefined && isFresh(cached)) {
    return cached;
  }
  if (vendor.summary === undefined) {
    const unreadable: UpstreamStatus = {
      vendor: vendor.id,
      name: vendor.name,
      page: vendor.page,
      hosts: vendor.hosts,
      level: null,
      parts: [],
      incidents: [],
      readAt: null,
    };
    kept.set(vendor.id, unreadable);
    return unreadable;
  }
  const running = asking.get(vendor.id);
  if (running !== undefined) {
    return await running;
  }
  const reading = readVendorStatus(vendor).then((status) => {
    asking.delete(vendor.id);
    kept.set(vendor.id, status);
    return status;
  });
  asking.set(vendor.id, reading);
  return await reading;
}

function isFresh(status: UpstreamStatus): boolean {
  if (status.readAt === null) {
    return true;
  }
  return Date.now() - Date.parse(status.readAt) < FRESH_MS;
}

interface SummaryComponent {
  id?: unknown;
  name?: unknown;
  status?: unknown;
  group?: unknown;
}

interface SummaryIncident {
  name?: unknown;
  status?: unknown;
  impact?: unknown;
  shortlink?: unknown;
  components?: unknown;
}

const LEVELS: Record<string, number> = {
  under_maintenance: 1,
  degraded_performance: 2,
  partial_outage: 3,
  major_outage: 4,
};
const LEVEL_NAMES: UpstreamLevel[] = ["ok", "maintenance", "degraded", "partial", "major"];

/** Reads one vendor's summary and says what it reports of the API. */
export async function readVendorStatus(vendor: UpstreamVendor): Promise<UpstreamStatus> {
  const status: UpstreamStatus = {
    vendor: vendor.id,
    name: vendor.name,
    page: vendor.page,
    hosts: vendor.hosts,
    level: null,
    parts: [],
    incidents: [],
    readAt: null,
  };
  if (vendor.summary === undefined) {
    return status;
  }
  status.readAt = new Date().toISOString();
  const read = await fetchSummary(vendor, vendor.summary);
  if ("error" in read) {
    status.error = read.error;
    return status;
  }
  const components = Array.isArray(read.summary.components) ? read.summary.components : [];
  const incidents = Array.isArray(read.summary.incidents) ? read.summary.incidents : [];
  const { mine, worst, parts } = readComponents(vendor, components);
  if (mine.size === 0) {
    status.error = `${vendor.page} lists none of its API's parts`;
    return status;
  }
  status.level = LEVEL_NAMES[worst]!;
  status.parts = parts;
  status.incidents = incidents
    .map((raw) => raw as SummaryIncident)
    .filter((incident) => isOpenIncident(incident) && incidentOnParts(incident, mine, worst))
    .map(incidentEntry);
  return status;
}

interface Summary {
  components?: unknown;
  incidents?: unknown;
}

async function fetchSummary(
  vendor: UpstreamVendor,
  summaryUrl: string,
): Promise<{ summary: Summary } | { error: string }> {
  try {
    const response = await fetch(summaryUrl, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
    if (!response.ok) {
      return { error: `${vendor.page} answered ${response.status}` };
    }
    const text = await response.text();
    if (text.length > MAX_SUMMARY_BYTES) {
      return { error: `${vendor.page}'s summary is too large` };
    }
    return { summary: JSON.parse(text) as Summary };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

interface ComponentsReading {
  /** The ids and names of the API's parts, for matching incidents. */
  mine: Set<string>;
  /** The worst state among them, 0 when all are operational. */
  worst: number;
  parts: UpstreamPart[];
}

function readComponents(vendor: UpstreamVendor, components: unknown[]): ComponentsReading {
  const mine = new Set<string>();
  const parts: UpstreamPart[] = [];
  let worst = 0;
  for (const raw of components) {
    const component = raw as SummaryComponent;
    const name = typeof component.name === "string" ? component.name : "";
    if (component.group === true || name.length === 0 || !vendor.part(name)) {
      continue;
    }
    if (typeof component.id === "string") {
      mine.add(component.id);
    }
    mine.add(name);
    const state = typeof component.status === "string" ? component.status : "unknown";
    const rank = LEVELS[state] ?? 0;
    if (rank > 0) {
      worst = Math.max(worst, rank);
      parts.push({ name, status: state });
    }
  }
  return { mine, worst, parts };
}

function isOpenIncident(incident: SummaryIncident): boolean {
  const state = typeof incident.status === "string" ? incident.status : "";
  return state !== "resolved" && state !== "postmortem";
}

/**
 * An incident on the API's parts; one that names no parts (OpenAI's do not)
 * only while those parts say they are affected.
 */
function incidentOnParts(incident: SummaryIncident, mine: Set<string>, worst: number): boolean {
  if (!Array.isArray(incident.components)) {
    return worst > 0;
  }
  if (incident.components.length === 0) {
    return worst > 0;
  }
  for (const rawPart of incident.components) {
    const part = rawPart as SummaryComponent;
    const name = typeof part.name === "string" ? part.name : "";
    if ((typeof part.id === "string" && mine.has(part.id)) || (name.length > 0 && mine.has(name))) {
      return true;
    }
  }
  return false;
}

function incidentEntry(incident: SummaryIncident): UpstreamIncident {
  const impact = typeof incident.impact === "string" ? incident.impact : "";
  const url = typeof incident.shortlink === "string" ? incident.shortlink : "";
  return {
    name: typeof incident.name === "string" ? incident.name : "",
    ...(impact.length > 0 ? { impact } : {}),
    ...(url.length > 0 ? { url } : {}),
  };
}

/** Drops every reading, for tests. */
export function resetUpstreamCache(): void {
  kept.clear();
  asking.clear();
}
