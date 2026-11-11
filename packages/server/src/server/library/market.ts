export interface SkillMarketHit {
  /** owner/repo/skill, as skills.sh keys it. */
  id: string;
  name: string;
  /** owner/repo, the git address to install from. */
  source: string;
  installs: number;
  url: string;
}

interface MarketRow {
  id?: unknown;
  name?: unknown;
  source?: unknown;
  installs?: unknown;
}

function marketUrl(id: string): string {
  const [source, ...rest] = id.split("/");
  return rest.length > 0 ? `https://skills.sh/${source}/${rest.join("/")}` : "https://skills.sh/";
}

/**
 * skills.sh's search, the same directory myna links a skill to. The daemon
 * asks it directly; a failed or slow answer is an empty result, not a crash.
 */
export async function searchSkillMarket(
  query: string,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<SkillMarketHit[]> {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return [];
  }
  const doFetch = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);
  try {
    const response = await doFetch(
      `https://skills.sh/api/search?q=${encodeURIComponent(trimmed)}`,
      { signal: controller.signal, headers: { accept: "application/json" } },
    );
    if (!response.ok) {
      throw new Error(`skills.sh answered ${response.status}`);
    }
    const body = (await response.json()) as { skills?: unknown };
    if (!Array.isArray(body.skills)) {
      return [];
    }
    const hits: SkillMarketHit[] = [];
    for (const entry of body.skills as MarketRow[]) {
      if (
        typeof entry.id !== "string" ||
        typeof entry.name !== "string" ||
        typeof entry.source !== "string"
      ) {
        continue;
      }
      hits.push({
        id: entry.id,
        name: entry.name,
        source: entry.source,
        installs: typeof entry.installs === "number" ? entry.installs : 0,
        url: marketUrl(entry.id),
      });
    }
    return hits;
  } finally {
    clearTimeout(timer);
  }
}
