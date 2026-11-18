// FILE: GatewayHistoryDetail.tsx
// Purpose: One past gateway call: what was asked, what the model answered, the
//          upstream attempts, the prompt text and the reply, with a streamed
//          response readable as events or as the reply it spells.
// Layer: Settings UI components

import type {
  GatewayArchivePart,
  GatewayArchiveRecord,
  GatewayPromptText,
  GatewayReply,
  GatewayRouteHistoryRow,
} from "~/lib/gatewayTypes";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { useTranslation } from "~/i18n";
import { neolixGatewayApi } from "~/lib/neolixGatewayApi";
import { cn } from "~/lib/utils";

import { Button } from "../../ui/button";
import { GatewayHeldRouteReport } from "./GatewayHeldReports";
import { JsonTreeView } from "./JsonTreeView";
import { parseJsonBody } from "./jsonTree.logic";
import {
  initialSseView,
  loadHistoryBodyTab,
  resolveSseView,
  saveHistoryBodyTab,
  saveSseView,
  type HistoryBodyTab,
  type SseView,
} from "./gatewayViewPreferences.logic";
import {
  parseSseEvents,
  sseEventText,
  sseReply,
  sseStreamText,
  type SseEvent,
} from "./gatewaySse.logic";

/** How much of one body the page draws before the reader asks for more. */
const BODY_STEP = 20_000;

/** How many SSE events a stream draws before the reader asks for more. */
const SSE_EVENT_PAGE = 200;

const TABS: readonly HistoryBodyTab[] = ["request", "response", "upstream", "prompt", "reply"];

function splitArchive(reference: string | undefined): { date: string; id: string } | null {
  if (reference === undefined) return null;
  const [date, id] = reference.split("/");
  if (date === undefined || id === undefined || date === "" || id === "") return null;
  return { date, id };
}

export function GatewayHistoryDetail({
  row,
  onEditArchive,
}: {
  row: GatewayRouteHistoryRow;
  onEditArchive?: (() => void) | undefined;
}) {
  const { t } = useTranslation();
  const split = splitArchive(row.archive);
  const [tab, setTab] = useState<HistoryBodyTab>(loadHistoryBodyTab);
  const archiveQuery = useQuery({
    queryKey: ["neolix-gateway", "archive", row.archive ?? ""],
    queryFn: () => neolixGatewayApi.getArchive(split ?? { date: "", id: "" }),
    enabled: split !== null,
    staleTime: 30_000,
  });
  const promptQuery = useQuery({
    queryKey: ["neolix-gateway", "prompt", row.id],
    queryFn: () => neolixGatewayApi.getPromptText(row.id),
    staleTime: 0,
  });
  const replyQuery = useQuery({
    queryKey: ["neolix-gateway", "reply", row.archive ?? ""],
    queryFn: () => neolixGatewayApi.getPromptReply(split?.date ?? "", split?.id ?? ""),
    enabled: split !== null,
    staleTime: 30_000,
  });

  const selectTab = (next: HistoryBodyTab) => {
    setTab(next);
    saveHistoryBodyTab(next);
  };

  return (
    <div className="rounded-md border border-[color:var(--color-border)] p-2.5">
      <DetailFacts row={row} />
      <RouteFlow row={row} />
      {row.held === undefined ? null : <GatewayHeldRouteReport name={row.held} />}
      <div className="mt-2 flex flex-wrap gap-1">
        {TABS.map((entry) => (
          <button
            key={entry}
            type="button"
            aria-pressed={tab === entry}
            onClick={() => selectTab(entry)}
            className={cn(
              "rounded border px-2 py-0.5 text-ui-xs",
              tab === entry
                ? "border-foreground/25 bg-foreground/8 text-foreground"
                : "border-[color:var(--color-border)] text-muted-foreground",
            )}
          >
            {t(tabLabelKey(entry))}
          </button>
        ))}
      </div>
      {archiveQuery.error !== null ? (
        <div className="mt-2 text-ui-sm text-destructive">{String(archiveQuery.error)}</div>
      ) : null}
      {archiveQuery.isLoading ? (
        <div className="mt-2 text-ui-sm text-muted-foreground">{t("gateway:history_reading")}</div>
      ) : (
        <TabBody
          tab={tab}
          row={row}
          call={archiveQuery.data ?? null}
          prompt={promptQuery.data ?? null}
          promptLoading={promptQuery.isLoading}
          promptError={promptQuery.error}
          reply={replyQuery.data ?? null}
          replyLoading={replyQuery.isLoading}
          replyError={replyQuery.error}
          onEditArchive={onEditArchive}
        />
      )}
    </div>
  );
}

function tabLabelKey(tab: HistoryBodyTab): string {
  return `gateway:archive_tab_${tab}`;
}

function DetailFacts({ row }: { row: GatewayRouteHistoryRow }) {
  const { t } = useTranslation();
  const facts = [
    row.time,
    ...(row.session === undefined ? [] : [t("gateway:history_session", { session: row.session })]),
    ...(row.responseId === undefined
      ? []
      : [t("gateway:history_responseIdValue", { id: row.responseId })]),
    ...(row.archive === undefined
      ? [t("gateway:history_notArchived")]
      : [t("gateway:history_archive", { archive: row.archive })]),
  ];
  return <div className="text-ui-xs text-muted-foreground">{facts.join("  ·  ")}</div>;
}

/** The call's decision chain: what it asked, each upstream try, and how it ended. */
function RouteFlow({ row }: { row: GatewayRouteHistoryRow }) {
  const { t } = useTranslation();
  const tries = row.tries ?? [];
  const prompt = row.prompt;
  const lines = [
    ...(row.group === undefined ? [] : [t("gateway:history_flow_group", { group: row.group })]),
    ...(tries.length === 0
      ? []
      : [
          t("gateway:history_flow_tries", {
            seats: tries
              .map((attempt) => {
                // A record written before tries named their provider kept
                // `provider/model` in `model`; draw the parts it has rather
                // than a question mark where the provider belongs.
                const seat =
                  attempt.provider === undefined
                    ? attempt.model
                    : attempt.model == null
                      ? attempt.provider
                      : `${attempt.provider}/${attempt.model}`;
                // An old record may lack the status or the try's own
                // duration; leave those parts out rather than draw "…" for
                // them.
                const parts = [seat ?? "…"];
                if (attempt.status != null) {
                  parts.push(String(attempt.status));
                }
                if (attempt.millis != null) {
                  parts.push(`${Math.round(attempt.millis)}ms`);
                }
                return parts.join(" · ");
              })
              .join(" → "),
          }),
        ]),
    ...(row.error === undefined ? [] : [t("gateway:history_flow_failed", { error: row.error })]),
    ...(prompt === undefined
      ? []
      : [
          t("gateway:history_flow_prompt", {
            tokens: prompt.tokens.toLocaleString(),
          }),
        ]),
  ];
  if (lines.length === 0) return null;
  return (
    <div className="mt-1 space-y-0.5 text-ui-xs text-muted-foreground">
      {lines.map((line) => (
        <div key={line}>{line}</div>
      ))}
    </div>
  );
}

function TabBody({
  tab,
  row,
  call,
  prompt,
  promptLoading,
  promptError,
  reply,
  replyLoading,
  replyError,
  onEditArchive,
}: {
  tab: HistoryBodyTab;
  row: GatewayRouteHistoryRow;
  call: GatewayArchiveRecord | null;
  prompt: GatewayPromptText | null;
  promptLoading: boolean;
  promptError: unknown;
  reply: GatewayReply | null;
  replyLoading: boolean;
  replyError: unknown;
  onEditArchive?: (() => void) | undefined;
}) {
  const { t } = useTranslation();
  if (tab === "reply") {
    if (replyLoading) {
      return <Reading />;
    }
    if (replyError !== null && replyError !== undefined) {
      return <ErrorText error={replyError} />;
    }
    if (reply === null) {
      return <Gone why="reply" onEditArchive={onEditArchive} />;
    }
    return <ReplyView reply={reply} />;
  }
  if (tab === "upstream") {
    if (call === null) {
      return <Gone why="upstream" onEditArchive={onEditArchive} />;
    }
    return <UpstreamHeaders call={call} />;
  }
  if (tab === "prompt") {
    if (promptLoading) {
      return <Reading />;
    }
    if (promptError !== null && promptError !== undefined) {
      return <ErrorText error={promptError} />;
    }
    if (prompt !== null) {
      return <BodyText text={prompt.body} label={t("gateway:history_masked")} />;
    }
    if (call !== null) {
      return (
        <>
          <div className="mb-1 text-ui-xs text-muted-foreground">
            {t("gateway:history_promptFromArchive")}
          </div>
          <BodyText text={call.request.body} truncated={call.request.truncated === true} />
        </>
      );
    }
    return <Gone why="prompt" kept="10" onEditArchive={onEditArchive} />;
  }
  if (call === null) {
    return (
      <Gone why={row.archive === undefined ? "off" : "missing"} onEditArchive={onEditArchive} />
    );
  }
  return (
    <ArchivedBody
      part={tab === "request" ? call.request : call.response}
      stream={tab === "response"}
      stateKey={`${row.id}|${tab}`}
    />
  );
}

function Reading() {
  const { t } = useTranslation();
  return (
    <div className="mt-2 text-ui-sm text-muted-foreground">{t("gateway:history_reading")}</div>
  );
}

function ErrorText({ error }: { error: unknown }) {
  return <div className="mt-2 text-ui-sm text-destructive">{String(error)}</div>;
}

const REPLY_ROLE_KEYS = {
  assistant: "gateway:history_replyAssistant",
  thinking: "gateway:history_replyThinking",
  call: "gateway:history_replyCall",
} as const;

function ReplyView({ reply }: { reply: GatewayReply }) {
  const { t } = useTranslation();
  return (
    <div className="mt-2 space-y-2">
      {reply.cut === true ? (
        <div className="text-ui-xs text-muted-foreground">{t("gateway:history_replyCut")}</div>
      ) : null}
      {reply.pieces.map((piece, index) => (
        // A reply's pieces have no id but their place.
        // oxlint-disable-next-line react/no-array-index-key
        <div key={`${piece.role}-${index}`} className="space-y-0.5">
          <div className="text-ui-xs font-medium text-muted-foreground">
            {t(REPLY_ROLE_KEYS[piece.role])}
            {piece.name === undefined ? "" : ` · ${piece.name}`}
          </div>
          <BodyText text={piece.text} />
        </div>
      ))}
    </div>
  );
}

/** One side of an archived call, drawn as SSE events when it is a stream. */
function ArchivedBody({
  part,
  stream,
  stateKey,
}: {
  part: GatewayArchivePart;
  stream: boolean;
  stateKey: string;
}) {
  const { t } = useTranslation();
  const events = useMemo(() => (stream ? parseSseEvents(part.body) : null), [part.body, stream]);
  const json = useMemo(() => parseJsonBody(part.body), [part.body]);
  if (part.body.length === 0) {
    return (
      <div className="mt-2 text-ui-sm text-muted-foreground">{t("gateway:archive_empty")}</div>
    );
  }
  if (events !== null) {
    return (
      <SseBody
        raw={part.body}
        events={events}
        truncated={part.truncated === true}
        stateKey={stateKey}
      />
    );
  }
  if (json !== null) {
    return <JsonBody value={json} truncated={part.truncated === true} stateKey={stateKey} />;
  }
  return <BodyText text={part.body} truncated={part.truncated === true} />;
}

/** A JSON body as the foldable tree; a body that is not JSON stays text. */
function JsonBody({
  value,
  truncated,
  stateKey,
}: {
  value: unknown[] | Record<string, unknown>;
  truncated: boolean;
  stateKey: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="mt-2 space-y-1">
      {truncated ? (
        <div className="text-ui-xs text-muted-foreground">{t("gateway:history_truncated")}</div>
      ) : null}
      <JsonTreeView value={value} stateKey={stateKey} />
    </div>
  );
}

function sseCopyText(
  view: SseView,
  reply: ReturnType<typeof sseReply>,
  raw: string,
  events: SseEvent[],
): string {
  if (view === "reply" && reply !== null) {
    return JSON.stringify(reply, null, 2);
  }
  if (view === "raw") {
    return raw;
  }
  return sseStreamText(events);
}

/**
 * A streamed response read three ways: the reply it spells, its events one by
 * one, or the body as it came. Reply is absent when the stream spells none.
 */
function SseBody({
  raw,
  events,
  truncated,
  stateKey,
}: {
  raw: string;
  events: SseEvent[];
  truncated: boolean;
  stateKey: string;
}) {
  const { t } = useTranslation();
  const reply = useMemo(() => sseReply(events), [events]);
  const [view, setView] = useState<SseView>(() => initialSseView(reply !== null));
  const options: Array<{ value: SseView; label: string }> = [
    ...(reply === null ? [] : [{ value: "reply" as const, label: t("gateway:archive_tab_reply") }]),
    { value: "events" as const, label: t("gateway:history_sseEvents") },
    { value: "raw" as const, label: t("gateway:history_sseRaw") },
  ];
  const chooseView = (next: string) => {
    const picked = resolveSseView(next, reply !== null);
    setView(picked);
    saveSseView(picked);
  };
  const [shown, setShown] = useState(SSE_EVENT_PAGE);
  const visible = events.slice(0, shown);
  const count =
    events.length === 1
      ? t("gateway:history_sseEventOne")
      : t("gateway:history_sseEventCount", { n: events.length });
  const copyText = sseCopyText(view, reply, raw, events);
  return (
    <div className="mt-2 space-y-1">
      {truncated ? (
        <div className="text-ui-xs text-muted-foreground">{t("gateway:history_truncated")}</div>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-ui-xs text-muted-foreground">{count}</span>
        <div className="flex items-center gap-1">
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={view === option.value}
              onClick={() => chooseView(option.value)}
              className={cn(
                "rounded border px-2 py-0.5 text-ui-xs",
                view === option.value
                  ? "border-foreground/25 bg-foreground/8 text-foreground"
                  : "border-[color:var(--color-border)] text-muted-foreground",
              )}
            >
              {option.label}
            </button>
          ))}
          <Button
            size="xs"
            variant="ghost"
            onClick={() => void navigator.clipboard?.writeText(copyText)}
          >
            {t("gateway:archive_copy")}
          </Button>
        </div>
      </div>
      {view === "raw" ? <BodyText text={raw} /> : null}
      {view === "reply" && reply !== null ? (
        <JsonTreeView value={reply} stateKey={`${stateKey}|reply`} />
      ) : null}
      {view === "events" ? (
        <div className="space-y-1">
          {visible.map((event, index) => (
            // A stream's events have no id but their order.
            // oxlint-disable-next-line react/no-array-index-key
            <div key={`${stateKey}-event-${index}`}>
              {event.event.length === 0 ? null : (
                <div className="text-ui-xs text-muted-foreground">{`event: ${event.event}`}</div>
              )}
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-foreground/5 p-2 text-ui-xs">
                {sseEventText(event)}
              </pre>
            </div>
          ))}
          {events.length > shown ? (
            <Button size="xs" variant="ghost" onClick={() => setShown(shown + SSE_EVENT_PAGE)}>
              {t("gateway:history_sseShowMore", {
                n: Math.min(SSE_EVENT_PAGE, events.length - shown),
              })}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function UpstreamHeaders({ call }: { call: GatewayArchiveRecord }) {
  const { t } = useTranslation();
  if (call.upstream === undefined || call.upstream.length === 0) {
    return (
      <div className="mt-2 text-ui-sm text-muted-foreground">
        {t("gateway:archive_no_upstream")}
      </div>
    );
  }
  return (
    <div className="mt-2 space-y-2">
      {call.upstream.map((wire) => (
        <div key={`${wire.method} ${wire.url} ${wire.status}`} className="space-y-0.5">
          <div className="break-all font-mono text-ui-xs text-muted-foreground">
            {`${wire.method} ${wire.url}`}
          </div>
          <div className="font-mono text-ui-xs text-muted-foreground">
            {`→ ${wire.status} · ${Math.round(wire.millis)}ms`}
          </div>
          {Object.entries(wire.response).map(([name, values]) => (
            <div key={name} className="break-all font-mono text-ui-xs text-muted-foreground">
              {`${name}: ${values.join(", ")}`}
            </div>
          ))}
          {wire.error === undefined ? null : (
            <div className="text-ui-sm text-destructive">{wire.error}</div>
          )}
        </div>
      ))}
      <div className="text-ui-xs text-muted-foreground">{t("gateway:history_headersMasked")}</div>
    </div>
  );
}

function BodyText({
  text,
  truncated,
  label,
}: {
  text: string;
  truncated?: boolean | undefined;
  label?: string | undefined;
}) {
  const { t } = useTranslation();
  const [shown, setShown] = useState(BODY_STEP);
  const pretty = useMemo(() => prettyJson(text), [text]);
  const visible = pretty.length > shown ? pretty.slice(0, shown) : pretty;
  return (
    <div className="mt-2 space-y-1">
      {truncated === true ? (
        <div className="text-ui-xs text-muted-foreground">{t("gateway:history_truncated")}</div>
      ) : null}
      {label === undefined ? null : <div className="text-ui-xs text-muted-foreground">{label}</div>}
      <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded bg-foreground/5 p-2 text-ui-xs">
        {visible}
      </pre>
      {pretty.length > shown ? (
        <Button size="xs" variant="ghost" onClick={() => setShown(shown + BODY_STEP)}>
          {t("gateway:history_showMore", { n: (pretty.length - shown).toLocaleString() })}
        </Button>
      ) : null}
    </div>
  );
}

function Gone({
  why,
  kept,
  onEditArchive,
}: {
  why: "off" | "missing" | "upstream" | "prompt" | "reply";
  kept?: string | undefined;
  onEditArchive?: (() => void) | undefined;
}) {
  const { t } = useTranslation();
  const keys: Record<typeof why, string> = {
    off: "gateway:history_goneOff",
    missing: "gateway:history_goneMissing",
    upstream: "gateway:history_goneUpstream",
    prompt: "gateway:history_gonePrompt",
    reply: "gateway:history_goneReply",
  };
  return (
    <div className="mt-2 space-y-1">
      <div className="text-ui-sm leading-relaxed text-muted-foreground">
        {t(keys[why], kept === undefined ? {} : { kept })}
      </div>
      {onEditArchive === undefined ? null : (
        <Button size="xs" variant="ghost" onClick={onEditArchive}>
          {t("gateway:history_openArchive")}
        </Button>
      )}
    </div>
  );
}

/** A JSON body drawn indented; anything else as it came. */
function prettyJson(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return text;
  }
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return text;
  }
}
