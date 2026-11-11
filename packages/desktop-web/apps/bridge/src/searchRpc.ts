// Full-history search. Neox keeps a per-agent timeline search, so the bridge asks every
// thread the daemon reported and reads the matched message for the client's excerpt.
// debt: this is a linear scan with one search request per thread; switch to a daemon-side
// cross-agent index (with excerpts) when the daemon exposes one.
import type { OrchestrationSearchThreadsResult } from "@synara/contracts";

import type { BridgeModel } from "./model.ts";
import type { DaemonClient } from "./neolix.ts";
import type { NeolixTimelineEntry } from "./translate.ts";

const SEARCH_CONCURRENCY = 6;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const MAX_EXCERPT_CHARS = 320;

interface ThreadSearchHit {
  readonly threadId: string;
  readonly title: string;
  readonly locations: ReadonlyArray<{ readonly seq: number; readonly count?: number | undefined }>;
  readonly titleMatched: boolean;
}

function matchesQuery(text: string, query: string): boolean {
  return text.toLocaleLowerCase().includes(query.toLocaleLowerCase());
}

function excerptAround(text: string, query: string): string {
  const trimmed = text.trim();
  const index = trimmed.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  if (index < 0) return trimmed.slice(0, MAX_EXCERPT_CHARS);
  const windowSize = MAX_EXCERPT_CHARS - 2;
  const start = Math.max(0, index - Math.floor((windowSize - query.length) / 2));
  const end = Math.min(trimmed.length, start + windowSize);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < trimmed.length ? "…" : "";
  return `${prefix}${trimmed.slice(start, end).trim()}${suffix}`;
}

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length }, () => undefined as R);
  let index = 0;
  const worker = async () => {
    while (index < items.length) {
      const current = index;
      index += 1;
      results[current] = await run(items[current] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function timelineText(entry: NeolixTimelineEntry | undefined): string | undefined {
  if (!entry) return undefined;
  const item = entry.item as { type?: string; text?: unknown };
  return item.type === "user_message" || item.type === "assistant_message"
    ? typeof item.text === "string"
      ? item.text
      : undefined
    : undefined;
}

export async function searchThreads(
  model: BridgeModel,
  client: DaemonClient,
  input: { readonly query: string; readonly limit?: number | undefined },
): Promise<OrchestrationSearchThreadsResult> {
  const query = input.query.trim();
  if (!query) return { matches: [] };
  const limit = Math.min(MAX_LIMIT, Math.max(1, input.limit ?? DEFAULT_LIMIT));
  const entries = model
    .allEntries()
    .toSorted((left, right) => right.agent.updatedAt.localeCompare(left.agent.updatedAt));

  const hits = (
    await mapLimit(entries, SEARCH_CONCURRENCY, async (entry): Promise<ThreadSearchHit | null> => {
      const title = entry.agent.title?.trim() ?? "";
      const titleMatched = matchesQuery(title, query);
      let locations: ThreadSearchHit["locations"] = [];
      try {
        const payload = await client.searchAgentTimeline({
          agentId: entry.agent.id,
          query,
        });
        locations = (payload.locations ?? []).map((location) =>
          typeof location.count === "number"
            ? { seq: location.seq, count: location.count }
            : { seq: location.seq },
        );
      } catch {
        // A thread whose provider search fails still qualifies on its title below.
      }
      if (locations.length === 0 && !titleMatched) return null;
      return { threadId: entry.agent.id, title, locations, titleMatched };
    })
  ).filter((hit): hit is ThreadSearchHit => hit !== null);

  const selected = hits
    .toSorted((left, right) => {
      const leftCount = left.locations.reduce((sum, location) => sum + (location.count ?? 1), 0);
      const rightCount = right.locations.reduce((sum, location) => sum + (location.count ?? 1), 0);
      return rightCount - leftCount || left.title.localeCompare(right.title);
    })
    .slice(0, limit);

  const matches = await mapLimit(selected, SEARCH_CONCURRENCY, async (hit) => {
    const matchCount = Math.max(
      1,
      hit.locations.reduce((sum, location) => sum + (location.count ?? 1), 0),
    );
    let excerpt = hit.title;
    if (hit.locations.length > 0) {
      try {
        const timeline = await client.fetchAgentTimeline(hit.threadId, {
          direction: "tail",
          limit: 0,
          projection: "projected",
        });
        const bySeq = new Map(timeline.entries.map((entry) => [entry.seqStart, entry]));
        for (const location of hit.locations) {
          const text = timelineText(bySeq.get(location.seq));
          if (text && matchesQuery(text, query)) {
            excerpt = excerptAround(text, query);
            break;
          }
        }
      } catch {
        // The hit still stands; the title is a usable excerpt when the timeline cannot load.
      }
    }
    return {
      threadId: hit.threadId as OrchestrationSearchThreadsResult["matches"][number]["threadId"],
      excerpt: excerpt.slice(0, MAX_EXCERPT_CHARS),
      matchCount,
    };
  });

  return { matches };
}
