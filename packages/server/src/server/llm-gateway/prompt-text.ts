/**
 * The text behind the context window card: the masked body of the last few
 * requests, in memory only, so a prompt's part can be read again by the
 * request it belongs to — myna's `prompt_text.go`. Nothing here is written
 * to disk or sent anywhere; a restart loses it.
 */

const BODIES_MOST = 10;
const BODY_MOST = 32 << 20;
const TOTAL_MOST = 64 << 20;

interface KeptBody {
  id: string;
  protocol: string;
  body: string;
  at: number;
}

const kept: KeptBody[] = [];

/** Keeps a request's masked body for its prompt's text. */
export function keepPromptBody(id: string, protocol: string, body: Record<string, unknown>): void {
  let text: string;
  try {
    text = JSON.stringify(body);
  } catch {
    return;
  }
  if (text.length === 0 || text.length > BODY_MOST) {
    return;
  }
  const existing = kept.findIndex((entry) => entry.id === id);
  if (existing >= 0) {
    kept.splice(existing, 1);
  }
  kept.push({ id, protocol, body: text, at: Date.now() });
  let total = kept.reduce((sum, entry) => sum + entry.body.length, 0);
  while (kept.length > BODIES_MOST || total > TOTAL_MOST) {
    const oldest = kept.shift();
    total -= oldest?.body.length ?? 0;
  }
}

/** The body kept for a request, or null once it is older than the last few. */
export function promptBody(id: string): { protocol: string; body: string } | null {
  const entry = kept.find((candidate) => candidate.id === id);
  return entry === undefined ? null : { protocol: entry.protocol, body: entry.body };
}

/** Forgets every kept body (tests, and a daemon shutting down). */
export function clearPromptBodies(): void {
  kept.length = 0;
}
