import type { ExternalSession, ExternalTranscriptPart } from "@neolix/protocol/messages";
import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronDown, ChevronRight } from "lucide-react-native";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { PressHighlight } from "@/components/ui/press-highlight";
import { useToast } from "@/contexts/toast-context";
import { useFetchQuery } from "@/data/query";
import { i18n as appI18n } from "@/i18n/i18next";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import type { Theme } from "@/styles/theme";
import { formatAgo } from "@/usage/format";
import { saveMarkdownFile } from "./save-markdown";
import { subagentTree, talkLines, type SessionsT, type SubagentNode } from "./sessions-view";

const PART_PAGE = 50;

const ThemedChevronRight = withUnistyles(ChevronRight);
const ThemedChevronDown = withUnistyles(ChevronDown);

const mutedIcon = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

interface ConversationProps {
  serverId: string;
  session: ExternalSession;
  sub?: string;
  t: SessionsT;
}

/** What was said in a session (or one of its subagents), read a page at a time. */
export function ConversationPanel({ serverId, session, sub, t }: ConversationProps) {
  const client = useHostRuntimeClient(serverId);
  const toast = useToast();
  const [limit, setLimit] = useState(PART_PAGE);
  const [exporting, setExporting] = useState(false);
  const transcriptQuery = useFetchQuery({
    queryKey: [
      "external-session-transcript",
      serverId,
      session.agent,
      session.id,
      sub ?? "",
      limit,
    ],
    enabled: client !== null,
    dataShape: "value" as const,
    staleTimeMs: 60_000,
    queryFn: () => {
      if (client === null) {
        throw new Error(t("hostDisconnected"));
      }
      return client.getExternalSessionTranscript({
        agent: session.agent,
        id: session.id,
        ...(sub === undefined ? {} : { sub }),
        limit,
      });
    },
  });
  const data = transcriptQuery.data;
  const lines = useMemo(() => talkLines(data?.parts ?? []), [data]);
  const more = (data?.total ?? 0) > lines.length;
  const showMore = useCallback(() => setLimit((previous) => previous + PART_PAGE), []);
  const exportAll = useCallback(async () => {
    if (client === null) {
      return;
    }
    setExporting(true);
    try {
      const result = await client.exportExternalSession(session.agent, session.id);
      if (result.error !== null) {
        toast.error(result.error);
        return;
      }
      await saveMarkdownFile(result.fileName, result.markdown, t("noCacheFolder"));
      toast.show(t("exported", { file: result.fileName }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setExporting(false);
    }
  }, [client, session.agent, session.id, t, toast]);
  return (
    <View style={styles.panel}>
      <View style={styles.panelBar}>
        <Text style={styles.panelSource} numberOfLines={2}>
          {data?.source === "gateway" ? t("sourceGateway") : t("sourceFile")}
        </Text>
        <View style={styles.grow} />
        <Button
          variant="ghost"
          disabled={exporting || client === null || data === undefined}
          onPress={exportAll}
        >
          {t("exportMarkdown")}
        </Button>
      </View>
      <TalkBody
        lines={lines}
        loading={data === undefined && transcriptQuery.isFetching}
        error={transcriptQuery.isError ? errorText(transcriptQuery.error) : null}
        emptyNote={data?.source === "gateway" ? t("noGatewayContent") : t("nothingSaid")}
        t={t}
      />
      {more ? (
        <Button variant="ghost" onPress={showMore}>
          {t("showMoreParts", { count: Math.min(PART_PAGE, (data?.total ?? 0) - lines.length) })}
        </Button>
      ) : null}
      {data?.cut === true ? <Text style={styles.note}>{t("transcriptCut")}</Text> : null}
    </View>
  );
}

function TalkBody({
  lines,
  loading,
  error,
  emptyNote,
  t,
}: {
  lines: ReturnType<typeof talkLines>;
  loading: boolean;
  error: string | null;
  emptyNote: string;
  t: SessionsT;
}) {
  if (loading) {
    return (
      <View style={styles.reading}>
        <LoadingSpinner size="small" color={styles.spinner.color} />
        <Text style={styles.muted}>{t("reading")}</Text>
      </View>
    );
  }
  if (error !== null) {
    return <Text style={styles.muted}>{error}</Text>;
  }
  if (lines.length === 0) {
    return <Text style={styles.muted}>{emptyNote}</Text>;
  }
  return (
    <View style={styles.talk}>
      {lines.map((line) => (
        <TalkPart key={line.key} line={line} t={t} />
      ))}
    </View>
  );
}

function TalkPart({ line, t }: { line: ReturnType<typeof talkLines>[number]; t: SessionsT }) {
  const part = line.part;
  return (
    <View style={styles.talkPart}>
      {line.heading !== null ? (
        <Text style={styles.talkHeading}>
          {t(line.heading === "assistant" ? "roleAssistant" : "roleUser")}
          {line.model.length > 0 ? ` · ${line.model}` : ""}
        </Text>
      ) : null}
      {line.heading === null && line.model.length > 0 ? (
        <Text style={styles.talkModel}>{line.model}</Text>
      ) : null}
      <PartBody part={part} t={t} />
      {part.cut !== undefined && part.cut > 0 ? (
        <Text style={styles.note}>{t("partCut", { count: part.cut })}</Text>
      ) : null}
    </View>
  );
}

function PartBody({ part, t }: { part: ExternalTranscriptPart; t: SessionsT }) {
  if (part.kind === "thinking") {
    return (
      <>
        <Text style={styles.talkLabel}>{t("thinking")}</Text>
        <Text style={styles.talkText}>{part.text}</Text>
      </>
    );
  }
  if (part.kind === "tool_use") {
    return (
      <>
        <Text style={styles.talkLabel}>{t("toolCall", { name: part.name ?? "tool" })}</Text>
        <Text style={styles.talkCode}>{part.text}</Text>
      </>
    );
  }
  if (part.kind === "tool_result") {
    return (
      <>
        <Text style={styles.talkLabel}>
          {part.name === undefined ? t("toolResult") : t("toolResultNamed", { name: part.name })}
        </Text>
        <Text style={styles.talkCode}>{part.text}</Text>
      </>
    );
  }
  if (part.kind === "context") {
    return (
      <>
        <Text style={styles.talkLabel}>{t("context")}</Text>
        <Text style={styles.talkCode}>{part.text}</Text>
      </>
    );
  }
  if (part.kind === "image") {
    return <Text style={styles.talkLabel}>{t("image")}</Text>;
  }
  return <Text style={styles.talkText}>{part.text}</Text>;
}

/** The subagents a session started, folded under it as myna draws them. */
export function SubagentsFold({ serverId, session, t }: Omit<ConversationProps, "sub">) {
  const [open, setOpen] = useState(false);
  const tree = useMemo(() => subagentTree(session.subagents ?? []), [session.subagents]);
  const label = useMemo(() => ({ expanded: open }), [open]);
  const toggle = useCallback(() => setOpen((previous) => !previous), []);
  if (tree.length === 0) {
    return null;
  }
  return (
    <View style={styles.subs}>
      <PressHighlight
        onPress={toggle}
        style={styles.subsFold}
        accessibilityRole="button"
        accessibilityState={label}
      >
        {open ? (
          <ThemedChevronDown size={12} uniProps={mutedIcon} />
        ) : (
          <ThemedChevronRight size={12} uniProps={mutedIcon} />
        )}
        <Text style={styles.subsCount}>
          {tree.length === 1 ? t("oneSubagent") : t("subagentsCount", { count: tree.length })}
        </Text>
      </PressHighlight>
      {open
        ? tree.map((node) => (
            <SubagentRow
              key={node.sub.id}
              serverId={serverId}
              session={session}
              node={node}
              t={t}
            />
          ))
        : null}
    </View>
  );
}

function SubagentRow({
  serverId,
  session,
  node,
  t,
}: {
  serverId: string;
  session: ExternalSession;
  node: SubagentNode;
  t: SessionsT;
}) {
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((previous) => !previous), []);
  const indent = useMemo(() => ({ marginLeft: node.depth * 12 }), [node.depth]);
  const expand = useMemo(() => ({ expanded: open }), [open]);
  const sub = node.sub;
  const ago = formatAgo(sub.last ?? sub.start ?? "", Date.now(), appI18n.t) ?? "";
  const line = [sub.title.length > 0 ? sub.kind : "", ago, sub.id.slice(0, 8)]
    .filter(Boolean)
    .join(" · ");
  const name = subagentName(sub);
  return (
    <View style={indent}>
      <PressHighlight
        onPress={toggle}
        style={styles.subRow}
        accessibilityRole="button"
        accessibilityState={expand}
      >
        <View style={styles.subMain}>
          <Text style={styles.subTitle} numberOfLines={1}>
            {name}
          </Text>
          {line.length > 0 ? (
            <Text style={styles.subWhere} numberOfLines={1}>
              {line}
            </Text>
          ) : null}
        </View>
      </PressHighlight>
      {open ? <ConversationPanel serverId={serverId} session={session} sub={sub.id} t={t} /> : null}
    </View>
  );
}

function subagentName(sub: { title: string; kind: string; id: string }): string {
  if (sub.title.length > 0) {
    return sub.title;
  }
  return sub.kind.length > 0 ? sub.kind : sub.id;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const styles = StyleSheet.create((theme) => ({
  panel: {
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    backgroundColor: theme.colors.surface1,
    borderTopColor: theme.colors.border,
    borderTopWidth: theme.borderWidth[1],
  },
  panelBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  panelSource: {
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  grow: {
    flex: 1,
  },
  reading: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  spinner: {
    color: theme.colors.foregroundMuted,
  },
  muted: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  note: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  talk: {
    gap: theme.spacing[2],
  },
  talkPart: {
    gap: 2,
  },
  talkHeading: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    marginTop: theme.spacing[1],
  },
  talkModel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  talkLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  talkText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.5,
  },
  talkCode: {
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.4,
  },
  subs: {
    borderTopColor: theme.colors.border,
    borderTopWidth: theme.borderWidth[1],
    paddingVertical: theme.spacing[1],
  },
  subsFold: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[3],
  },
  subsCount: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  subRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: theme.spacing[1],
    paddingRight: theme.spacing[3],
    paddingLeft: theme.spacing[4],
  },
  subMain: {
    flex: 1,
    minWidth: 0,
  },
  subTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  subWhere: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
