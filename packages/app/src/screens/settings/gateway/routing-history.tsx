/* eslint-disable react-perf/jsx-no-new-function-as-prop, react-perf/jsx-no-new-object-as-prop, react-perf/jsx-no-new-array-as-prop, react/no-array-index-key -- history rows and their detail: a handful of closures per press, none in a hot list; a stream's events have no id but their place. */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type {
  GatewayArchivePartWire,
  GatewayArchiveRecordWire,
  GatewayHistoryRouteWire,
  GatewayPromptTextWire,
  GatewayReplyWire,
} from "@neolix/protocol/gateway";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { SelectField } from "@/components/ui/select-field";
import {
  useGatewayArchivedCall,
  useGatewayDiagnosticsSupported,
  useGatewayHeldReport,
  useGatewayHeldReports,
  useGatewayPromptReply,
  useGatewayPromptText,
  useGatewayRoutingHistory,
} from "@/hooks/use-gateway-diagnostics";
import { copyToClipboard } from "@/utils/copy-to-clipboard";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { formatCallTime, formatMs } from "./usage-data";
import { JsonTreeView } from "./json-tree-view";
import { selectedHistoryDay } from "./routing-history-day";
import { settingsStyles } from "@/styles/settings";
import { loadHistoryBodyTab, saveHistoryBodyTab } from "./history-view-preference";
import { initialSseView, loadSseView, saveSseView, type SseView } from "./sse-view-preference";
import {
  parseSseEvents,
  sseEventText,
  sseReply,
  sseStreamText,
  type SseEvent,
  type SseReply,
} from "./sse-view";

/** How much of one body the page draws before the reader asks for more. */
const BODY_STEP = 20_000;

/** What the row says besides its client and time: its archive, held report, title turn. */
function extraDetails(route: GatewayHistoryRouteWire, t: TFunction): string[] {
  return [
    ...(route.archive === undefined || route.archive.length === 0
      ? []
      : [t("settings.gatewayPages.routing.history.archived")]),
    ...(route.held === undefined ? [] : [t("settings.gatewayPages.routing.history.heldRow")]),
    ...(route.kind !== undefined && TITLE_KINDS.has(route.kind)
      ? [t("settings.gatewayPages.routing.history.titleRow")]
      : []),
  ];
}

/** Codex's hidden turns that only name a conversation. */
const TITLE_KINDS = new Set(["thread_title", "thread_title_reconsideration", "title_generation"]);

interface RouteGroup {
  key: string;
  /** The conversation's own name, when it has one. */
  label: string | null;
  /** A title turn's conversation was inferred, not named by the client. */
  matched: boolean;
  routes: GatewayHistoryRouteWire[];
}

/** Rows by the conversation they belong to; title turns under their parent. */
function groupRoutes(routes: GatewayHistoryRouteWire[]): RouteGroup[] {
  const groups = new Map<string, RouteGroup>();
  for (const route of routes) {
    const parent = route.parentSession;
    const key = parent ?? route.session ?? route.id;
    const group = groups.get(key) ?? {
      key,
      label: parent ?? route.session ?? null,
      matched: false,
      routes: [],
    };
    group.matched = group.matched || route.parentMatched === true;
    group.routes.push(route);
    groups.set(key, group);
  }
  return [...groups.values()];
}

type BodyTab = "request" | "response" | "upstream" | "prompt" | "reply";

/**
 * The Routing page's past requests: the history kept a day to a file, newest
 * first, and the request and response of the one opened — from the request
 * archive when it kept them, and the prompt's text while it is still in
 * memory. myna's routing history, on the page it belongs to.
 */
export function GatewayRoutingHistory({
  serverId,
  onEditArchive,
}: {
  serverId: string;
  /** Opens Settings → Gateway → Usage → Requests, where the archive is turned on. */
  onEditArchive?: () => void;
}) {
  const { t } = useTranslation();
  const supported = useGatewayDiagnosticsSupported(serverId);
  const [day, setDay] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const history = useGatewayRoutingHistory(serverId, day);

  const dayOptions = useMemo(
    () => history.days.toReversed().map((value) => ({ id: value, value, label: value })),
    [history.days],
  );
  const dayValue = selectedHistoryDay(day, history.days);
  const selectedDay = useMemo(() => ({ label: dayValue }), [dayValue]);
  const changeDay = useCallback((next: string) => {
    setDay(next);
    setOpenId(null);
  }, []);
  const toggle = useCallback((id: string) => {
    setOpenId((current) => (current === id ? null : id));
  }, []);

  if (!supported) {
    return (
      <View style={[settingsStyles.card, styles.card]}>
        <Text style={styles.note}>{t("settings.gatewayPages.routing.history.updateHost")}</Text>
      </View>
    );
  }

  const routes = history.routes.toReversed();
  const groups = groupRoutes(routes);

  return (
    <View style={[settingsStyles.card, styles.card]} testID="gateway-routing-history">
      <View style={styles.head}>
        <View style={styles.headMain}>
          <Text style={styles.title}>{t("settings.gatewayPages.routing.history.title")}</Text>
          <Text style={styles.note}>{t("settings.gatewayPages.routing.history.hint")}</Text>
        </View>
        {dayOptions.length === 0 ? null : (
          <View style={styles.daySelect}>
            <SelectField
              label={t("settings.gatewayPages.routing.history.day")}
              value={dayValue}
              selectedDisplay={selectedDay}
              options={dayOptions}
              onChange={changeDay}
              placeholder={t("settings.gatewayPages.routing.history.day")}
              emptyText={t("settings.gatewayPages.routing.history.empty")}
              title={t("settings.gatewayPages.routing.history.day")}
              size="sm"
              field={false}
              searchable={dayOptions.length > 6}
              testID="gateway-history-day"
            />
          </View>
        )}
      </View>

      {history.error === null ? null : <Text style={styles.error}>{history.error.message}</Text>}
      {!history.isLoading && routes.length === 0 ? (
        <Text style={styles.empty}>{t("settings.gatewayPages.routing.history.empty")}</Text>
      ) : null}

      {groups.map((group) => (
        <View key={group.key}>
          {group.label === null ? null : (
            <View style={styles.groupHead}>
              <Text style={styles.groupLabel} numberOfLines={1}>
                {group.label}
              </Text>
              {group.matched ? (
                <Text style={styles.note}>
                  {t("settings.gatewayPages.routing.history.titleMatched")}
                </Text>
              ) : null}
            </View>
          )}
          {group.routes.map((route) => (
            <View key={route.id} style={styles.entry}>
              <HistoryRow route={route} open={route.id === openId} onPress={toggle} />
              {route.id === openId ? (
                <HistoryDetail route={route} serverId={serverId} onEditArchive={onEditArchive} />
              ) : null}
            </View>
          ))}
        </View>
      ))}

      <HeldReports serverId={serverId} />
    </View>
  );
}

/**
 * The reports Neolix writes when a request waits too long for an account
 * (myna's held reports): the last few, opened as text. myna shows one from
 * the request that was held; the route records do not carry their name yet.
 */
function HeldReports({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const reports = useGatewayHeldReports(serverId);
  const [openName, setOpenName] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const toggleHeld = useCallback((name: string) => {
    setOpenName((current) => (current === name ? null : name));
  }, []);
  const reveal = useCallback(
    async (name?: string) => {
      if (client === null) {
        return;
      }
      const result = await client.revealGatewayHeldReport(name);
      setFailure(
        result.ok
          ? null
          : (result.error ?? t("settings.gatewayPages.routing.history.revealFailed")),
      );
    },
    [client, t],
  );

  if (reports.names.length === 0) {
    return null;
  }

  return (
    <View style={styles.held} testID="gateway-held-reports">
      <View style={styles.heldHead}>
        <Text style={styles.title}>{t("settings.gatewayPages.routing.history.heldTitle")}</Text>
        <Button variant="ghost" size="sm" onPress={() => void reveal()}>
          {t("settings.gatewayPages.routing.history.openHeldFolder")}
        </Button>
      </View>
      <Text style={styles.note}>{t("settings.gatewayPages.routing.history.heldHint")}</Text>
      {failure === null ? null : <Text style={styles.error}>{failure}</Text>}
      {reports.names.map((name) => (
        <View key={name} style={styles.heldEntry}>
          <Button
            variant="ghost"
            size="sm"
            onPress={() => toggleHeld(name)}
            testID={`gateway-held-${name}`}
          >
            {name}
          </Button>
          {name === openName ? <HeldReportText serverId={serverId} name={name} /> : null}
        </View>
      ))}
    </View>
  );
}

/** The report of the request that was held, with myna's Copy action. */
function HeldRouteReport({ serverId, name }: { serverId: string; name: string }) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const report = useGatewayHeldReport(serverId, name);
  const [failure, setFailure] = useState<string | null>(null);
  const copy = useCallback(() => {
    if (report.text !== null) {
      void copyToClipboard(report.text);
    }
  }, [report.text]);
  const reveal = useCallback(async () => {
    if (client === null) {
      return;
    }
    const result = await client.revealGatewayHeldReport(name);
    setFailure(
      result.ok ? null : (result.error ?? t("settings.gatewayPages.routing.history.revealFailed")),
    );
  }, [client, name, t]);
  return (
    <View style={styles.heldRoute}>
      <View style={styles.heldHead}>
        <Text style={styles.title}>{t("settings.gatewayPages.routing.history.heldTitle")}</Text>
        <View style={styles.actions}>
          <Button variant="ghost" size="sm" onPress={() => void reveal()}>
            {t("settings.gatewayPages.routing.history.openHeldFolder")}
          </Button>
          <Button variant="ghost" size="sm" onPress={copy} disabled={report.text === null}>
            {t("settings.gatewayPages.routing.history.copyReport")}
          </Button>
        </View>
      </View>
      {failure === null ? null : <Text style={styles.error}>{failure}</Text>}
      <HeldReportText serverId={serverId} name={name} />
    </View>
  );
}

function HeldReportText({ serverId, name }: { serverId: string; name: string }) {
  const { t } = useTranslation();
  const report = useGatewayHeldReport(serverId, name);
  if (report.isLoading) {
    return <Text style={styles.note}>{t("settings.gatewayPages.routing.history.reading")}</Text>;
  }
  if (report.error !== null) {
    return <Text style={styles.error}>{report.error.message}</Text>;
  }
  if (report.text === null) {
    return <Text style={styles.note}>{t("settings.gatewayPages.routing.history.heldGone")}</Text>;
  }
  return <BodyText text={report.text} />;
}

function HistoryRow({
  route,
  open,
  onPress,
}: {
  route: GatewayHistoryRouteWire;
  open: boolean;
  onPress: (id: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const failed = route.status !== undefined && route.status !== null && route.status >= 400;
  const models =
    route.asked !== undefined && route.served !== undefined && route.asked !== route.served
      ? `${route.asked} → ${route.served}`
      : (route.served ?? route.asked ?? route.model ?? "");
  const details = [
    ...(route.client === undefined ? [] : [route.client]),
    ...(route.millis === undefined || route.millis === null ? [] : [formatMs(route.millis)]),
    ...(route.responseId === undefined
      ? []
      : [t("settings.gatewayPages.routing.history.responseId")]),
    ...extraDetails(route, t),
  ];
  const handlePress = useCallback(() => onPress(route.id), [onPress, route.id]);
  return (
    <Button
      variant="ghost"
      size="sm"
      onPress={handlePress}
      testID={`gateway-history-${route.id}`}
      style={styles.rowButton}
    >
      <View style={styles.row}>
        <Text style={styles.rowTime}>{formatCallTime(route.time, locale, Date.now())}</Text>
        <Text style={[styles.rowModel, failed ? styles.rowFailed : null]} numberOfLines={1}>
          {models}
        </Text>
        {failed ? <Text style={styles.rowFailed}>{route.status}</Text> : null}
        <Text style={styles.rowDetails} numberOfLines={1}>
          {details.join(" · ")}
        </Text>
        <Text style={styles.rowChevron}>{open ? "▾" : "▸"}</Text>
      </View>
    </Button>
  );
}

export function HistoryDetail({
  route,
  serverId,
  onEditArchive,
}: {
  route: GatewayHistoryRouteWire;
  serverId: string;
  onEditArchive?: () => void;
}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<BodyTab>("request");
  const archive = useGatewayArchivedCall(serverId, route.archive ?? null);
  const prompt = useGatewayPromptText(serverId, route.id);
  const reply = useGatewayPromptReply(serverId, route.archive ?? null);
  // myna remembers the view picked last (client.js:860,1120-1122); a tab it
  // does not know yet (an app without Events/Raw) opens Request instead.
  useEffect(() => {
    let live = true;
    void loadHistoryBodyTab().then((saved) => {
      if (live) {
        setTab(saved);
      }
      return undefined;
    });
    return () => {
      live = false;
    };
  }, []);
  const selectTab = useCallback((next: BodyTab) => {
    setTab(next);
    void saveHistoryBodyTab(next);
  }, []);
  const selectRequest = useCallback(() => selectTab("request"), [selectTab]);
  const selectResponse = useCallback(() => selectTab("response"), [selectTab]);
  const selectUpstream = useCallback(() => selectTab("upstream"), [selectTab]);
  const selectPrompt = useCallback(() => selectTab("prompt"), [selectTab]);
  const selectReply = useCallback(() => selectTab("reply"), [selectTab]);

  return (
    <View style={styles.detail}>
      <DetailFacts route={route} />
      {route.held === undefined ? null : <HeldRouteReport serverId={serverId} name={route.held} />}
      <View style={styles.tabs}>
        <TabButton
          label={t("settings.gatewayPages.routing.history.request")}
          active={tab === "request"}
          onPress={selectRequest}
        />
        <TabButton
          label={t("settings.gatewayPages.routing.history.response")}
          active={tab === "response"}
          onPress={selectResponse}
        />
        <TabButton
          label={t("settings.gatewayPages.routing.history.upstream")}
          active={tab === "upstream"}
          onPress={selectUpstream}
        />
        <TabButton
          label={t("settings.gatewayPages.routing.history.prompt")}
          active={tab === "prompt"}
          onPress={selectPrompt}
        />
        <TabButton
          label={t("settings.gatewayPages.routing.history.reply")}
          active={tab === "reply"}
          onPress={selectReply}
        />
      </View>

      {archive.error === null ? null : <Text style={styles.error}>{archive.error.message}</Text>}
      {archive.isLoading ? (
        <Text style={styles.note}>{t("settings.gatewayPages.routing.history.reading")}</Text>
      ) : (
        <TabBody
          tab={tab}
          route={route}
          call={archive.call}
          prompt={prompt.text}
          promptLoading={prompt.isLoading}
          promptError={prompt.error}
          reply={reply.reply}
          replyLoading={reply.isLoading}
          replyError={reply.error}
          onEditArchive={onEditArchive}
        />
      )}
    </View>
  );
}

function DetailFacts({ route }: { route: GatewayHistoryRouteWire }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const facts = [
    route.time,
    ...(route.session === undefined
      ? []
      : [t("settings.gatewayPages.routing.history.session", { session: route.session })]),
    ...(route.responseId === undefined
      ? []
      : [t("settings.gatewayPages.routing.history.responseIdValue", { id: route.responseId })]),
    ...(route.archive === undefined
      ? [t("settings.gatewayPages.routing.history.notArchived")]
      : [t("settings.gatewayPages.routing.history.archive", { archive: route.archive })]),
    ...(route.prompt === undefined || route.prompt.parts === undefined
      ? []
      : [
          t("settings.gatewayPages.routing.history.promptParts", {
            parts: route.prompt.parts
              .map((part) => `${part.kind} ${part.tokens.toLocaleString(locale)}`)
              .join(" · "),
          }),
        ]),
  ];
  return <Text style={styles.facts}>{facts.join("  ·  ")}</Text>;
}

function TabBody({
  tab,
  route,
  call,
  prompt,
  promptLoading,
  promptError,
  reply,
  replyLoading,
  replyError,
  onEditArchive,
}: {
  tab: BodyTab;
  route: GatewayHistoryRouteWire;
  call: GatewayArchiveRecordWire | null;
  prompt: GatewayPromptTextWire | null;
  promptLoading: boolean;
  promptError: Error | null;
  reply: GatewayReplyWire | null;
  replyLoading: boolean;
  replyError: Error | null;
  onEditArchive?: () => void;
}) {
  const { t } = useTranslation();
  if (tab === "reply") {
    if (replyLoading) {
      return <Text style={styles.note}>{t("settings.gatewayPages.routing.history.reading")}</Text>;
    }
    if (replyError !== null) {
      return <Text style={styles.error}>{replyError.message}</Text>;
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
      return <Text style={styles.note}>{t("settings.gatewayPages.routing.history.reading")}</Text>;
    }
    if (promptError !== null) {
      return <Text style={styles.error}>{promptError.message}</Text>;
    }
    if (prompt !== null) {
      return (
        <BodyText text={prompt.body} label={t("settings.gatewayPages.routing.history.masked")} />
      );
    }
    if (call !== null) {
      return (
        <>
          <Text style={styles.note}>
            {t("settings.gatewayPages.routing.history.promptFromArchive")}
          </Text>
          <BodyText text={call.request.body} truncated={call.request.truncated === true} />
        </>
      );
    }
    return <Gone why="prompt" kept="10" onEditArchive={onEditArchive} />;
  }
  if (call === null) {
    return (
      <Gone why={route.archive === undefined ? "off" : "missing"} onEditArchive={onEditArchive} />
    );
  }
  return (
    <ArchivedBody
      part={tab === "request" ? call.request : call.response}
      stream={tab === "response"}
      stateKey={`${route.id}|${tab}`}
    />
  );
}

/** The reply's pieces, as myna's prompt text view shows them beside it. */
function ReplyView({ reply }: { reply: GatewayReplyWire }) {
  const { t } = useTranslation();
  const pieces = useMemo(() => {
    let seen = 0;
    return reply.pieces.map((piece) => {
      seen += 1;
      return { key: `${piece.role}-${seen}`, piece };
    });
  }, [reply]);
  return (
    <View style={styles.reply}>
      {reply.cut === true ? (
        <Text style={styles.note}>{t("settings.gatewayPages.routing.history.replyCut")}</Text>
      ) : null}
      {pieces.map(({ key, piece }) => (
        <View key={key} style={styles.replyPiece}>
          <Text style={styles.replyRole}>
            {t(REPLY_ROLE_KEYS[piece.role])}
            {piece.name === undefined ? "" : ` · ${piece.name}`}
          </Text>
          <BodyText text={piece.text} />
        </View>
      ))}
    </View>
  );
}

const REPLY_ROLE_KEYS = {
  assistant: "settings.gatewayPages.routing.history.replyAssistant",
  thinking: "settings.gatewayPages.routing.history.replyThinking",
  call: "settings.gatewayPages.routing.history.replyCall",
} as const;

const REPLY_TAB_KEY = "settings.gatewayPages.routing.history.reply";

/** How many SSE events a stream draws before the reader asks for more (myna's SSE_PAGE). */
const SSE_EVENT_PAGE = 200;

function ArchivedBody({
  part,
  stream,
  stateKey,
}: {
  part: GatewayArchivePartWire;
  stream: boolean;
  stateKey: string;
}) {
  const { t } = useTranslation();
  const events = useMemo(() => (stream ? parseSseEvents(part.body) : null), [part.body, stream]);
  const json = useMemo(() => parseJsonBody(part.body), [part.body]);
  if (part.body.length === 0) {
    return <Text style={styles.note}>{t("settings.gatewayPages.routing.history.emptyBody")}</Text>;
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
  if (json !== undefined) {
    return <JsonBody value={json} truncated={part.truncated === true} stateKey={stateKey} />;
  }
  return <BodyText text={part.body} truncated={part.truncated === true} />;
}

/** A JSON body as myna's foldable tree; a body that is not JSON stays text. */
function JsonBody({
  value,
  truncated,
  stateKey,
}: {
  value: unknown;
  truncated: boolean;
  stateKey: string;
}) {
  const { t } = useTranslation();
  return (
    <View style={styles.bodyBox}>
      {truncated ? (
        <Text style={styles.note}>{t("settings.gatewayPages.routing.history.truncated")}</Text>
      ) : null}
      <JsonTreeView value={value} stateKey={stateKey} />
    </View>
  );
}

function sseCopyText(
  view: SseView,
  reply: SseReply | null,
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
 * A streamed response read three ways, as myna draws it (client.js:1111-1160):
 * the reply it spells, its events one by one, or the body as it came. The pick
 * is kept for the next call; Reply is absent when the stream spells none.
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
  useEffect(() => {
    let live = true;
    void loadSseView(reply !== null).then((saved) => {
      if (live) {
        setView(saved);
      }
      return undefined;
    });
    return () => {
      live = false;
    };
  }, [reply]);
  const chooseView = useCallback((next: string) => {
    const picked: SseView = next === "reply" || next === "raw" ? next : "events";
    setView(picked);
    void saveSseView(picked);
  }, []);
  const options = useMemo(() => {
    const replyOption = reply === null ? [] : [{ value: "reply", label: t(REPLY_TAB_KEY) }];
    return [
      ...replyOption,
      { value: "events", label: t("settings.gatewayPages.routing.history.sseEvents") },
      { value: "raw", label: t("settings.gatewayPages.routing.history.sseRaw") },
    ];
  }, [reply, t]);
  const [shown, setShown] = useState(SSE_EVENT_PAGE);
  const showMore = useCallback(() => setShown((current) => current + SSE_EVENT_PAGE), []);
  const visible = events.slice(0, shown);
  const count =
    events.length === 1
      ? t("settings.gatewayPages.routing.history.sseEventOne")
      : t("settings.gatewayPages.routing.history.sseEventCount", { n: events.length });
  // What the copy button copies is what the view shows, as myna's does.
  const copyText = sseCopyText(view, reply, raw, events);
  const copy = useCallback(() => void copyToClipboard(copyText), [copyText]);
  return (
    <View style={styles.bodyBox}>
      {truncated ? (
        <Text style={styles.note}>{t("settings.gatewayPages.routing.history.truncated")}</Text>
      ) : null}
      <View style={styles.sseHead}>
        <Text style={styles.note}>{count}</Text>
        <View style={styles.actions}>
          <SegmentedControl options={options} value={view} onValueChange={chooseView} />
          <Button variant="outline" size="sm" onPress={copy}>
            {t("common.actions.copy")}
          </Button>
        </View>
      </View>
      {view === "raw" ? <BodyText text={raw} /> : null}
      {view === "reply" && reply !== null ? (
        <JsonTreeView value={reply} stateKey={`${stateKey}|reply`} />
      ) : null}
      {view === "events" ? (
        <View>
          {visible.map((event, index) => (
            <View key={`event-${index}`} style={styles.sseEvent}>
              {event.event.length === 0 ? null : (
                <Text style={styles.sseEventName}>{`event: ${event.event}`}</Text>
              )}
              <Text style={styles.body} selectable>
                {sseEventText(event)}
              </Text>
            </View>
          ))}
          {events.length > shown ? (
            <Button variant="ghost" size="sm" onPress={showMore}>
              {t("settings.gatewayPages.routing.history.sseShowMore", {
                n: Math.min(SSE_EVENT_PAGE, events.length - shown),
              })}
            </Button>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function UpstreamHeaders({ call }: { call: GatewayArchiveRecordWire }) {
  const { t } = useTranslation();
  if (call.upstream === undefined || call.upstream.length === 0) {
    return <Text style={styles.note}>{t("settings.gatewayPages.routing.history.noUpstream")}</Text>;
  }
  return (
    <View>
      {call.upstream.map((wire) => (
        <View key={`${wire.method} ${wire.url} ${wire.status}`} style={styles.wire}>
          <Text style={styles.wireLine} selectable>
            {`${wire.method} ${wire.url}`}
          </Text>
          <Text style={styles.wireLine} selectable>
            {`→ ${wire.status} · ${formatMs(wire.millis)}`}
          </Text>
          {headerLines(wire.response).map((line) => (
            <Text key={line} style={styles.wireLine} selectable>
              {line}
            </Text>
          ))}
          {wire.error === undefined ? null : <Text style={styles.error}>{wire.error}</Text>}
        </View>
      ))}
      <Text style={styles.note}>{t("settings.gatewayPages.routing.history.headersMasked")}</Text>
    </View>
  );
}

function BodyText({
  text,
  truncated,
  label,
}: {
  text: string;
  truncated?: boolean;
  label?: string;
}) {
  const { t } = useTranslation();
  const [shown, setShown] = useState(BODY_STEP);
  const pretty = useMemo(() => prettyJson(text), [text]);
  const more = useCallback(() => setShown((current) => current + BODY_STEP), []);
  const visible = pretty.length > shown ? pretty.slice(0, shown) : pretty;
  return (
    <View style={styles.bodyBox}>
      {truncated === true ? (
        <Text style={styles.note}>{t("settings.gatewayPages.routing.history.truncated")}</Text>
      ) : null}
      {label === undefined ? null : <Text style={styles.note}>{label}</Text>}
      <Text style={styles.body} selectable>
        {visible}
      </Text>
      {pretty.length > shown ? (
        <Button variant="ghost" size="sm" onPress={more}>
          {t("settings.gatewayPages.routing.history.showMore", {
            n: (pretty.length - shown).toLocaleString(),
          })}
        </Button>
      ) : null}
    </View>
  );
}

function Gone({
  why,
  kept,
  onEditArchive,
}: {
  why: "off" | "missing" | "upstream" | "prompt" | "reply";
  kept?: string;
  onEditArchive?: () => void;
}) {
  const { t } = useTranslation();
  const key: Record<"off" | "missing" | "upstream" | "prompt" | "reply", string> = {
    off: "settings.gatewayPages.routing.history.goneOff",
    missing: "settings.gatewayPages.routing.history.goneMissing",
    upstream: "settings.gatewayPages.routing.history.goneUpstream",
    prompt: "settings.gatewayPages.routing.history.gonePrompt",
    reply: "settings.gatewayPages.routing.history.goneReply",
  };
  return (
    <View>
      <Text style={styles.note}>{t(key[why], kept === undefined ? {} : { kept })}</Text>
      {onEditArchive === undefined ? null : (
        <Button variant="ghost" size="sm" onPress={onEditArchive}>
          {t("settings.gatewayPages.routing.history.openArchive")}
        </Button>
      )}
    </View>
  );
}

function TabButton({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Button variant={active ? "secondary" : "ghost"} size="sm" onPress={onPress}>
      {label}
    </Button>
  );
}

function headerLines(headers: Record<string, string[]>): string[] {
  const lines: string[] = [];
  for (const [name, values] of Object.entries(headers)) {
    lines.push(`${name}: ${values.join(", ")}`);
  }
  return lines;
}

/** A body that is a JSON object or array, else undefined (truncated text stays text). */
function parseJsonBody(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
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

const styles = StyleSheet.create((theme) => ({
  card: {
    padding: theme.spacing[4],
  },
  head: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    marginBottom: theme.spacing[3],
  },
  headMain: {
    flexShrink: 1,
    gap: theme.spacing[1],
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  note: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  empty: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    paddingVertical: theme.spacing[4],
    textAlign: "center",
  },
  error: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.sm,
  },
  daySelect: {
    minWidth: 140,
  },
  groupHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    paddingTop: theme.spacing[2],
  },
  groupLabel: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    flexShrink: 1,
  },
  entry: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  held: {
    marginTop: theme.spacing[4],
    paddingTop: theme.spacing[3],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    gap: theme.spacing[1],
  },
  heldEntry: {
    gap: theme.spacing[1],
  },
  heldRoute: {
    gap: theme.spacing[1],
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  heldHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  rowButton: {
    justifyContent: "flex-start",
    width: "100%",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    width: "100%",
    paddingVertical: theme.spacing[1],
  },
  rowTime: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
  rowModel: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    flexShrink: 1,
  },
  rowFailed: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.sm,
  },
  rowDetails: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    flex: 1,
  },
  rowChevron: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.sm,
  },
  detail: {
    paddingVertical: theme.spacing[3],
    gap: theme.spacing[2],
  },
  facts: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  tabs: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[1],
  },
  reply: {
    gap: theme.spacing[3],
  },
  replyPiece: {
    gap: theme.spacing[1],
  },
  replyRole: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  bodyBox: {
    gap: theme.spacing[1],
  },
  body: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontFamily: theme.fontFamily.mono,
  },
  sseHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  sseEvent: {
    gap: theme.spacing[1],
    marginBottom: theme.spacing[3],
  },
  sseEventName: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontFamily: theme.fontFamily.mono,
  },
  wire: {
    gap: theme.spacing[1],
    marginBottom: theme.spacing[2],
  },
  wireLine: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontFamily: theme.fontFamily.mono,
  },
}));
