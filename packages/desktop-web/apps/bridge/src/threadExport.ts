// `GET /api/thread-export?threadId=…`: the composer's `/export` command downloads a
// Markdown transcript. The route only reads the thread the daemon already knows; the
// thread id is a lookup key, never a path, so no caller-selected file is ever opened.
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { Effect } from "effect";
import { threadExportBlockedReason } from "@synara/shared/threadExport";

export const THREAD_EXPORT_PATH = "/api/thread-export";

/** Max characters kept in a filename before the extension. */
const MAX_FILENAME_STEM_CHARS = 80;
const THREAD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** The dev web app runs on another loopback port, so the download needs CORS. */
function isLoopbackOrigin(origin: string): boolean {
  try {
    const { hostname } = new URL(origin);
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

function downloadHeaders(origin: string | undefined): Record<string, string> {
  return origin
    ? {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Credentials": "true",
        "Access-Control-Expose-Headers": "Content-Disposition",
        Vary: "Origin",
      }
    : {};
}

export interface ThreadExportMessage {
  readonly role: string;
  readonly text: string;
  readonly createdAt: string;
  readonly streaming?: boolean;
}

export interface ThreadExportActivity {
  readonly kind: string;
  readonly summary: string;
  readonly createdAt: string;
  readonly sequence?: number | null | undefined;
  readonly payload?: unknown;
}

export interface ThreadExportThread {
  readonly title?: string | null;
  readonly messages: readonly ThreadExportMessage[];
  readonly activities: readonly ThreadExportActivity[];
  readonly latestTurn?: { readonly state: string } | null;
}

export interface ThreadExportLoadOptions {
  readonly loadThread: (threadId: string) => Promise<ThreadExportThread | null>;
  readonly now?: () => Date;
}

/** Only ids the daemon could own; anything path-shaped is rejected before the lookup. */
export function isValidThreadExportId(threadId: string): boolean {
  return THREAD_ID_PATTERN.test(threadId);
}

export function threadExportFilename(title: string | null | undefined, threadId: string): string {
  const base = (title ?? "")
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/gu, " ")
    .replace(/\s+/gu, " ")
    .replace(/^[.\s]+|[.\s]+$/gu, "");
  const stem = base.slice(0, MAX_FILENAME_STEM_CHARS).trim() || `thread-${threadId}`;
  return `${stem}.md`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function toolCallId(activity: ThreadExportActivity): string | null {
  const payload = asRecord(activity.payload);
  const data = asRecord(payload?.data);
  const id = data?.toolCallId ?? payload?.toolCallId;
  return typeof id === "string" && id.trim().length > 0 ? id.trim() : null;
}

function toolStatus(activity: ThreadExportActivity): string | null {
  const payload = asRecord(activity.payload);
  const status = payload?.status;
  return typeof status === "string" && status.trim().length > 0 ? status.trim() : null;
}

function toolTitle(activity: ThreadExportActivity): string {
  const payload = asRecord(activity.payload);
  const title = payload?.title;
  return typeof title === "string" && title.trim().length > 0
    ? title.trim()
    : activity.summary.trim();
}

type ExportEvent =
  | {
      readonly kind: "message";
      readonly at: string;
      readonly order: number;
      readonly message: ThreadExportMessage;
    }
  | {
      readonly kind: "tool";
      readonly at: string;
      readonly order: number;
      readonly activity: ThreadExportActivity;
    };

/**
 * Merges the transcript by time. Tool rows are deduplicated by call id, keeping the latest
 * snapshot so a running call does not appear twice next to its settled result.
 */
function exportEvents(thread: ThreadExportThread): ExportEvent[] {
  const events: ExportEvent[] = [];
  let order = 0;
  for (const message of thread.messages) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    events.push({ kind: "message", at: message.createdAt, order: order++, message });
  }
  const toolsById = new Map<string, ThreadExportActivity>();
  for (const activity of thread.activities) {
    if (
      activity.kind !== "tool.started" &&
      activity.kind !== "tool.updated" &&
      activity.kind !== "tool.completed"
    ) {
      continue;
    }
    const id = toolCallId(activity);
    if (!id) continue;
    const previous = toolsById.get(id);
    const activityMs = Date.parse(activity.createdAt);
    const previousMs = previous ? Date.parse(previous.createdAt) : Number.NaN;
    // Equal timestamps keep the settled snapshot rather than the "started" twin.
    const settledLater =
      previous !== undefined &&
      activity.kind === "tool.completed" &&
      previous.kind !== "tool.completed";
    if (
      previous === undefined ||
      activityMs > previousMs ||
      (activityMs === previousMs && settledLater)
    ) {
      toolsById.set(id, activity);
    }
  }
  for (const activity of toolsById.values()) {
    events.push({ kind: "tool", at: activity.createdAt, order: order++, activity });
  }
  return events.toSorted((left, right) => {
    const leftMs = Date.parse(left.at);
    const rightMs = Date.parse(right.at);
    if (Number.isFinite(leftMs) && Number.isFinite(rightMs) && leftMs !== rightMs) {
      return leftMs - rightMs;
    }
    return left.order - right.order;
  });
}

function sanitizeMessageText(text: string): string {
  return text.replace(/\r\n?/gu, "\n").trim();
}

export function buildThreadMarkdown(
  thread: ThreadExportThread,
  options: { readonly threadId: string; readonly exportedAt?: Date },
): string {
  const exportedAt = options.exportedAt ?? new Date();
  const title = thread.title?.trim() || `thread-${options.threadId}`;
  const lines: string[] = [`# ${title}`, "", `_Exported ${exportedAt.toISOString()}_`, ""];
  for (const event of exportEvents(thread)) {
    if (event.kind === "message") {
      const text = sanitizeMessageText(event.message.text);
      if (text.length === 0) continue;
      lines.push(event.message.role === "user" ? "## User" : "## Assistant", "", text, "");
      continue;
    }
    const heading = toolTitle(event.activity);
    const status = toolStatus(event.activity);
    const suffix = status ? ` (${status})` : "";
    lines.push("## Tool call", "", `${heading || "Tool"}${suffix}`, "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

/** RFC 5987 form used by browsers; the web download helper decodes `filename*`. */
function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/gu, "_").replace(/["\\]/gu, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export function makeThreadExportHandler(
  options: ThreadExportLoadOptions,
): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  never,
  HttpServerRequest.HttpServerRequest
> {
  return Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const origin = request.headers.origin;
    if (origin !== undefined && !isLoopbackOrigin(origin)) {
      return HttpServerResponse.text("Forbidden", { status: 403 });
    }
    const corsHeaders = downloadHeaders(origin);
    const responseHeaders = (extra: Record<string, string> = {}) => ({
      ...corsHeaders,
      ...extra,
    });
    const url = HttpServerRequest.toURL(request);
    if (!url)
      return HttpServerResponse.text("Bad request", { status: 400, headers: responseHeaders() });
    const threadId = url.searchParams.get("threadId")?.trim() ?? "";
    if (!isValidThreadExportId(threadId)) {
      return HttpServerResponse.text("Invalid thread id.", {
        status: 400,
        headers: responseHeaders(),
      });
    }
    const thread = yield* Effect.promise(() => options.loadThread(threadId));
    if (!thread)
      return HttpServerResponse.text("Thread not found.", {
        status: 404,
        headers: responseHeaders(),
      });
    const blocked = threadExportBlockedReason({
      latestTurn: thread.latestTurn ?? null,
      messages: thread.messages.map((message) => ({ streaming: message.streaming === true })),
    });
    if (blocked)
      return HttpServerResponse.text(blocked, {
        status: 409,
        headers: responseHeaders(),
      });
    const markdown = buildThreadMarkdown(thread, {
      threadId,
      ...(options.now ? { exportedAt: options.now() } : {}),
    });
    const filename = threadExportFilename(thread.title, threadId);
    return HttpServerResponse.text(markdown, {
      status: 200,
      contentType: "text/markdown; charset=utf-8",
      headers: responseHeaders({
        "Content-Disposition": contentDisposition(filename),
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store",
      }),
    });
  });
}
