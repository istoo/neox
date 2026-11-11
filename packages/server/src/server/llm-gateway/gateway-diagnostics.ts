import {
  GatewayArchiveRecordWireSchema,
  GatewayHistoryRouteWireSchema,
  type GatewayArchiveRecordWire,
  type GatewayHistoryRouteWire,
} from "@neolix/protocol/gateway";
import type { GatewayArchive } from "./gateway-archive.js";
import { promptBody } from "./prompt-text.js";
import { replyPieces, type ReplyRead } from "./prompt-reply.js";
import type { GatewayProtocol } from "./upstream.js";
import { routesAfter } from "./route-events.js";
import type { RouteHistory } from "./route-history.js";

/**
 * Reads for the settings UI's request views: the routing history by day, one
 * archived call, the prompt text still in memory, and the route-events ring
 * a reconnecting client resumes from. The HTTP endpoints serve clients that
 * are not Neolix's own; the app asks for these through session RPCs.
 */

export interface RoutingHistoryRead {
  days: string[];
  day: string;
  routes: GatewayHistoryRouteWire[];
}

export async function readRoutingHistory(
  history: RouteHistory | undefined,
  day: string,
): Promise<RoutingHistoryRead> {
  const days = history === undefined ? [] : await history.days();
  // No day named opens the latest the history keeps, as the page does.
  const wanted = day.length === 0 ? (days.at(-1) ?? "") : day;
  const routes = history === undefined || wanted.length === 0 ? [] : await history.routes(wanted);
  return { days, day: wanted, routes: wireRoutes(routes) };
}

export async function readArchivedCall(
  archive: GatewayArchive | undefined,
  date: string,
  id: string,
): Promise<GatewayArchiveRecordWire | null> {
  const record = archive === undefined ? null : await archive.read(date, id);
  if (record === null) {
    return null;
  }
  const parsed = GatewayArchiveRecordWireSchema.safeParse(record);
  return parsed.success ? parsed.data : null;
}

/**
 * The reply an archived call got, piece by piece, as the prompt viewer shows
 * it beside the prompt's text (myna's prompt_reply). The body was masked when
 * it was archived, so nothing further is needed.
 */
export async function readPromptReply(
  archive: GatewayArchive | undefined,
  date: string,
  id: string,
): Promise<ReplyRead | null> {
  const record = await readArchivedCall(archive, date, id);
  if (record === null) {
    return null;
  }
  const protocol = protocolOfPath(record.request.path ?? "");
  return replyPieces(protocol, record.response.body, record.response.truncated === true);
}

/** The protocol an archived request's path was written in. */
function protocolOfPath(path: string): GatewayProtocol {
  if (path.includes("/messages")) {
    return "anthropic";
  }
  if (path.includes("/responses")) {
    return "openai-responses";
  }
  if (path.includes(":generateContent") || path.includes("/v1beta/")) {
    return "gemini";
  }
  return "openai";
}

/** The masked body of a request still in memory, or null once it is gone. */
export function readPromptText(id: string): { id: string; protocol: string; body: string } | null {
  const kept = promptBody(id);
  return kept === null ? null : { id, protocol: kept.protocol, body: kept.body };
}

export interface RouteEventsRead {
  cursor: number;
  routes: { cursor: number; route: GatewayHistoryRouteWire }[];
}

/** The ring's routes after a cursor, for a client that reconnected. */
export function readRouteEvents(after: number): RouteEventsRead {
  const ring = routesAfter(Number.isFinite(after) && after >= 0 ? after : 0);
  const routes: { cursor: number; route: GatewayHistoryRouteWire }[] = [];
  for (const entry of ring.routes) {
    const parsed = GatewayHistoryRouteWireSchema.safeParse(entry.route);
    if (parsed.success) {
      routes.push({ cursor: entry.cursor, route: parsed.data });
    }
  }
  return { cursor: ring.cursor, routes };
}

/** The routes a day file holds, dropping any line that is not a route. */
function wireRoutes(routes: Record<string, unknown>[]): GatewayHistoryRouteWire[] {
  const out: GatewayHistoryRouteWire[] = [];
  for (const route of routes) {
    const parsed = GatewayHistoryRouteWireSchema.safeParse(route);
    if (parsed.success) {
      out.push(parsed.data);
    }
  }
  return out;
}
