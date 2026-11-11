import type { ExternalCodexMove, ExternalSession } from "@neolix/protocol/messages";
import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Check, Square } from "lucide-react-native";
import { Button } from "@/components/ui/button";
import { PressHighlight } from "@/components/ui/press-highlight";
import { EditingTextInput } from "@/components/ui/text-input";
import { useToast } from "@/contexts/toast-context";
import { i18n as appI18n } from "@/i18n/i18next";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import type { Theme } from "@/styles/theme";
import { formatAgo } from "@/usage/format";
import { formatFileSize } from "@/utils/format-file-size";
import type { SessionsT } from "./sessions-view";

const ThemedCheck = withUnistyles(Check);
const ThemedSquare = withUnistyles(Square);
const mutedIcon = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const foregroundIcon = (theme: Theme) => ({ color: theme.colors.foreground });

/**
 * Codex lists only the sessions made with the provider it uses now. The ones
 * made with another are here as files but hidden from its history, and can be
 * moved over; the last move can be undone.
 */
export function ProviderBar({
  hidden,
  moved,
  disabled,
  onMove,
  onUndo,
  t,
}: {
  hidden: readonly ExternalSession[];
  moved: readonly ExternalCodexMove[] | null;
  disabled: boolean;
  onMove: () => void;
  onUndo: () => void;
  t: SessionsT;
}) {
  const undo = moved !== null && moved.length > 0;
  if (hidden.length === 0 && !undo) {
    return null;
  }
  const to = hidden[0]?.usesProvider ?? "";
  const from = [...new Set(hidden.map((session) => session.provider ?? ""))]
    .filter(Boolean)
    .join(", ");
  return (
    <View style={styles.bar}>
      {hidden.length > 0 ? (
        <Text style={styles.barText}>
          {hidden.length === 1
            ? t("providerHiddenOne", { from, to })
            : t("providerHiddenMany", { count: hidden.length, from, to })}
        </Text>
      ) : (
        <Text style={styles.barText}>
          {moved !== null && moved.length === 1
            ? t("providerMovedOne", { to: moved[0]?.to ?? "" })
            : t("providerMovedMany", { count: moved?.length ?? 0, to: moved?.[0]?.to ?? "" })}
        </Text>
      )}
      <View style={styles.grow} />
      {hidden.length > 0 ? (
        <Button variant="secondary" disabled={disabled} onPress={onMove}>
          {t("providerMoveTo", { to })}
        </Button>
      ) : null}
      {undo ? (
        <Button variant="ghost" disabled={disabled} onPress={onUndo}>
          {t("undo")}
        </Button>
      ) : null}
    </View>
  );
}

/** The Codex sessions to move, each ticked off before Move, as myna asks. */
export function ProviderMoveForm({
  sessions,
  to,
  disabled,
  onMove,
  onClose,
  t,
}: {
  sessions: readonly ExternalSession[];
  to: string;
  disabled: boolean;
  onMove: (ids: readonly string[]) => void;
  onClose: () => void;
  t: SessionsT;
}) {
  const [chosen, setChosen] = useState<ReadonlySet<string>>(
    () => new Set(sessions.map((session) => session.id)),
  );
  const toggle = useCallback((id: string) => {
    setChosen((previous) => {
      const next = new Set(previous);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);
  const move = useCallback(() => {
    onMove(sessions.filter((session) => chosen.has(session.id)).map((session) => session.id));
  }, [chosen, onMove, sessions]);
  return (
    <View style={styles.form}>
      <Text style={styles.formTitle}>{t("providerMoveTitle", { to })}</Text>
      {sessions.map((session) => (
        <ProviderChoice
          key={session.id}
          session={session}
          chosen={chosen.has(session.id)}
          onToggle={toggle}
        />
      ))}
      <Text style={styles.barText}>{t("providerMoveMessage")}</Text>
      <View style={styles.formBar}>
        <Text style={styles.barText}>{t("selectedCount", { count: chosen.size })}</Text>
        <View style={styles.grow} />
        <Button variant="ghost" onPress={onClose}>
          {t("cancel")}
        </Button>
        <Button variant="secondary" disabled={disabled || chosen.size === 0} onPress={move}>
          {t("move")}
        </Button>
      </View>
    </View>
  );
}

function ProviderChoice({
  session,
  chosen,
  onToggle,
}: {
  session: ExternalSession;
  chosen: boolean;
  onToggle: (id: string) => void;
}) {
  const toggle = useCallback(() => onToggle(session.id), [onToggle, session.id]);
  const state = useMemo(() => ({ checked: chosen }), [chosen]);
  const ago = formatAgo(session.last, Date.now(), appI18n.t) ?? "";
  return (
    <PressHighlight
      onPress={toggle}
      style={styles.choice}
      accessibilityRole="checkbox"
      accessibilityState={state}
      accessibilityLabel={session.title}
    >
      {chosen ? (
        <ThemedCheck size={16} uniProps={foregroundIcon} />
      ) : (
        <ThemedSquare size={16} uniProps={mutedIcon} />
      )}
      <Text style={styles.choiceName} numberOfLines={1}>
        {session.title.length > 0 ? session.title : session.id}
      </Text>
      <Text style={styles.barText}>{session.provider ?? ""}</Text>
      <Text style={styles.barText}>{ago}</Text>
    </PressHighlight>
  );
}

/**
 * Moves every session of a Claude project to the folder another absolute path
 * encodes: a preview first, then the same path with the preview's token.
 */
export function RelocateForm({
  serverId,
  from,
  onDone,
  onClose,
  t,
}: {
  serverId: string;
  from: string;
  onDone: () => void;
  onClose: () => void;
  t: SessionsT;
}) {
  const client = useHostRuntimeClient(serverId);
  const toast = useToast();
  const [to, setTo] = useState(from);
  const [token, setToken] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const change = useCallback((text: string) => {
    setTo(text);
    setToken(null);
    setNote("");
  }, []);
  const run = useCallback(async () => {
    if (client === null) {
      return;
    }
    const target = to.trim();
    setBusy(true);
    setNote("");
    try {
      const result = await client.relocateClaudeProject(
        token === null ? { from, to: target } : { from, to: target, token },
      );
      if (result.error !== null) {
        setToken(null);
        setNote(result.error);
        return;
      }
      if (result.backup !== null) {
        toast.show(t("relocated", { dir: result.backup }));
        onDone();
        return;
      }
      setToken(result.token);
      if (result.preview !== null) {
        setNote(
          t("relocatePreview", {
            count: result.preview.sessions,
            size: formatFileSize(result.preview.bytes),
            from: result.preview.from,
            to: result.preview.to,
          }),
        );
      }
    } catch (error) {
      setToken(null);
      setNote(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [client, from, onDone, t, to, toast, token]);
  return (
    <View style={styles.form}>
      <Text style={styles.formTitle}>{t("relocateTitle")}</Text>
      <Text style={styles.formPath}>{from}</Text>
      <Text style={styles.barText}>{t("relocateNote")}</Text>
      <EditingTextInput
        initialValue={from}
        onChangeText={change}
        style={styles.input}
        autoCapitalize="none"
        autoCorrect={false}
      />
      {note.length > 0 ? (
        <Text style={styles.barText} accessibilityLiveRegion="polite">
          {note}
        </Text>
      ) : null}
      <View style={styles.formBar}>
        <View style={styles.grow} />
        <Button variant="ghost" onPress={onClose}>
          {t("close")}
        </Button>
        <Button
          variant="secondary"
          disabled={busy || client === null || to.trim().length === 0}
          onPress={run}
        >
          {token === null ? t("previewRelocation") : t("confirmRelocation")}
        </Button>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  bar: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    backgroundColor: theme.colors.surface1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
  },
  barText: {
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.5,
  },
  grow: {
    flex: 1,
  },
  form: {
    gap: theme.spacing[2],
    padding: theme.spacing[3],
    backgroundColor: theme.colors.surface1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
  },
  formTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  formPath: {
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
  },
  input: {
    color: theme.colors.foreground,
    backgroundColor: theme.colors.surface2,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[2],
  },
  choice: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[1],
  },
  choiceName: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  formBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
}));
