import type { RequestHandler } from "express";
import { ReplyScan, turnKey, type TurnTracker } from "./turndone.js";
import { clientOfUserAgent, sessionOfRequest } from "./usage.js";

/** The endpoints whose reply is an agent's turn; everything else is not. */
const COMPLETION_PATHS = new Set(["/v1/chat/completions", "/v1/responses", "/v1/messages"]);
/** Neolix's own gateway calls (titles, compaction) are not the agent's turn. */
const INTERNAL_HEADER = "x-neolix-gateway-internal";
/** A subagent's last reply is not its parent's turn. */
const SUBAGENT_HEADER = "x-claude-code-agent-id";

/**
 * Follows each gateway-served turn for myna's "done" notification: a request
 * with a session and an agent begins one, and its reply is read as it streams
 * to tell whether it asked for a tool and whether it ended whole. A turn that
 * calls no tool and is followed by nothing more ends (see `TurnTracker`).
 *
 * The session may come from the request body (the first user message) rather
 * than a header, and the body is only parsed by the route's own middleware
 * after this one. The turn therefore begins at the first byte written back,
 * still timed from the request's arrival.
 */
export function createTurnMiddleware(tracker: TurnTracker): RequestHandler {
  return (req, res, next) => {
    const agent = clientOfUserAgent(req.headers["user-agent"]);
    const skip =
      req.method !== "POST" ||
      !COMPLETION_PATHS.has(req.path) ||
      agent === "other" ||
      req.headers[INTERNAL_HEADER] !== undefined ||
      req.headers[SUBAGENT_HEADER] !== undefined;
    if (skip) {
      next();
      return;
    }

    const arrivedAt = Date.now();
    const scan = new ReplyScan();
    let key: string | null = null;
    let began = false;
    let reported = false;

    const ensureKey = (): string | null => {
      if (began) {
        return key;
      }
      began = true;
      const session = sessionOfRequest(req.headers, req.body);
      if (session === null) {
        return null;
      }
      key = turnKey(agent, session);
      tracker.begin(key, { agent, session }, arrivedAt);
      return key;
    };
    const report = (final: boolean) => {
      if (reported) {
        return;
      }
      reported = true;
      const turn = ensureKey();
      if (turn !== null) {
        tracker.end(turn, final);
      }
    };

    const originalWrite = res.write.bind(res) as (...args: unknown[]) => boolean;
    (res as unknown as { write: (...args: unknown[]) => boolean }).write = (
      chunk: unknown,
      ...rest: unknown[]
    ) => {
      ensureKey();
      scan.add(chunk);
      return originalWrite(chunk, ...rest);
    };
    const originalEnd = res.end.bind(res) as (...args: unknown[]) => unknown;
    (res as unknown as { end: (...args: unknown[]) => unknown }).end = (
      chunk?: unknown,
      ...rest: unknown[]
    ) => {
      ensureKey();
      scan.add(chunk);
      return originalEnd(chunk, ...rest);
    };

    res.on("finish", () => report(scan.final && res.statusCode < 400));
    res.on("close", () => report(false));
    next();
  };
}
