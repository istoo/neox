import type { SessionReadsFound, SessionReadsSnapshot } from "@neolix/protocol/messages";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { SettingsRow } from "@/components/settings";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { useToast } from "@/contexts/toast-context";
import { useHostRuntimeClient } from "@/runtime/host-runtime";

interface ReadsChange {
  all?: boolean;
  agents?: Record<string, boolean>;
}
type SaveReads = (change: ReadsChange) => void;

/**
 * myna's Privacy › Agents' session history (plugins/sessions/settings.js:58):
 * "Agents found later" and a row for each agent found on this computer. The
 * setting is gateway.json's codexSessionReads, through
 * `sessions.reads.get/set`; the daemon's session listers read the same value.
 */
export function SessionReadsRows({ serverId }: { serverId: string | null }) {
  const { t } = useTranslation();
  const toast = useToast();
  const client = useHostRuntimeClient(serverId ?? "");
  const [snapshot, setSnapshot] = useState<SessionReadsSnapshot | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (client === null) {
      return;
    }
    let live = true;
    void client
      .getSessionReads()
      .then((result) => {
        if (live && result.snapshot !== null) {
          setSnapshot(result.snapshot);
        }
        return undefined;
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [client]);

  const save = useCallback(
    async (change: ReadsChange) => {
      if (client === null) {
        return;
      }
      setBusy(true);
      try {
        const result = await client.setSessionReads(change);
        if (result.snapshot !== null) {
          setSnapshot(result.snapshot);
        } else if (result.error !== null) {
          toast.error(t("settings.pages.privacy.sessionReadsFailed", { error: result.error }));
        }
      } catch (error) {
        toast.error(
          t("settings.pages.privacy.sessionReadsFailed", {
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      } finally {
        setBusy(false);
      }
    },
    [client, t, toast],
  );

  const disabled = client === null || snapshot === null || busy;
  const options = useMemo<SegmentedControlOption<"off" | "on">[]>(
    () => [
      { value: "off", label: t("settings.pages.privacy.off"), disabled },
      { value: "on", label: t("settings.pages.privacy.on"), disabled },
    ],
    [disabled, t],
  );

  const changeLater = useCallback(
    (value: string) => {
      if (snapshot === null) {
        return;
      }
      const on = value === "on";
      // The agents with a row keep what their rows show (myna sends them too).
      const agents = Object.fromEntries(snapshot.found.map((entry) => [entry.agent, entry.on]));
      void save(Object.keys(agents).length > 0 ? { all: on, agents } : { all: on });
    },
    [save, snapshot],
  );

  const hint =
    serverId === null || snapshot === null
      ? t("settings.pages.actions.noHost")
      : t("settings.pages.privacy.agentsFoundLaterHint");

  return (
    <>
      <SettingsRow
        label={t("settings.pages.privacy.agentsFoundLater")}
        hint={hint}
        testID="settings-agents-found-later"
      >
        <SegmentedControl
          value={snapshot?.all === true ? "on" : "off"}
          onValueChange={changeLater}
          options={options}
        />
      </SettingsRow>
      {(snapshot?.found ?? []).map((entry) => (
        <SessionReadRow key={entry.agent} entry={entry} options={options} onSave={save} />
      ))}
    </>
  );
}

function SessionReadRow({
  entry,
  options,
  onSave,
}: {
  entry: SessionReadsFound;
  options: SegmentedControlOption<"off" | "on">[];
  onSave: SaveReads;
}) {
  const { t } = useTranslation();
  const change = useCallback(
    (value: string) => onSave({ agents: { [entry.agent]: value === "on" } }),
    [entry.agent, onSave],
  );
  return (
    <SettingsRow
      label={entry.name}
      hint={t("settings.pages.privacy.sessionReadsAgentHint")}
      testID={`settings-session-reads-${entry.agent}`}
    >
      <SegmentedControl value={entry.on ? "on" : "off"} onValueChange={change} options={options} />
    </SettingsRow>
  );
}
