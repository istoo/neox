// FILE: HostBehaviorSettingsSection.tsx
// Purpose: Settings › General host preferences the daemon owns: WSL agent discovery
//          (Windows hosts) and the Mac terminal a resumed session opens in. Both write
//          the daemon config through the existing host settings channel; a host that
//          cannot support one hides its row instead of showing a dead switch.
// Layer: Settings UI components
// Exports: HostBehaviorSettingsSection

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import type { NeolixSessionTerminals } from "@synara/contracts";
import { useTranslation } from "~/i18n";
import { listSessionTerminals } from "~/lib/neolixHostApi";
import { readExecutionContext } from "~/lib/hosts/executionContext";
import { SelectItem } from "../ui/select";
import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsSelectControl } from "./SettingControls";
import { SettingsRow, SettingsSection } from "./SettingsPanelPrimitives";
import { useHostConfig } from "./hostSettingsModel";

function bridgePlatformOs(): string | null {
  return readExecutionContext()?.execution.platform.os ?? null;
}

function WslAgentsRow() {
  const { t } = useTranslation();
  const { config, patch } = useHostConfig(true);
  if (bridgePlatformOs() !== "windows") {
    return null;
  }
  const enabled = config?.noWslAgents !== true;
  return (
    <SettingsRow
      id="setting-wsl-agents"
      title="settings:wslAgents"
      description={t("settings:wslAgentsDescription")}
      resetAction={
        config?.noWslAgents === true ? (
          <SettingResetButton
            label={t("settings:wslAgents")}
            onClick={() => void patch({ noWslAgents: false })}
          />
        ) : null
      }
      control={
        <Switch
          checked={enabled}
          onCheckedChange={(checked) => void patch({ noWslAgents: !checked })}
          aria-label={t("settings:wslAgents")}
        />
      }
    />
  );
}

function SessionTerminalRow({ found }: { found: NeolixSessionTerminals | undefined }) {
  const { t } = useTranslation();
  const { config, patch } = useHostConfig(true);

  const options = useMemo(() => {
    if (!found?.supported) return [];
    const defaultApp = found.apps.find((app) => app.id === found.defaultId);
    const chosen = config?.sessionTerminal ?? "";
    const rows = [
      {
        id: "system",
        name: t("settings:sessionTerminalSystem", {
          name: defaultApp?.name ?? found.apps[0]?.name ?? "Terminal",
        }),
      },
      ...found.apps
        .filter((app) => app.id !== found.defaultId)
        .map((app) => ({
          id: app.id,
          name: app.name,
        })),
    ];
    if (chosen.length > 0 && !rows.some((row) => row.id === chosen)) {
      rows.push({
        id: chosen,
        name: t("settings:sessionTerminalUnavailable", { id: chosen }),
      });
    }
    return rows;
  }, [config?.sessionTerminal, found, t]);

  if (!found?.supported || options.length === 0) {
    return null;
  }
  const chosen = config?.sessionTerminal ?? "";
  const selectedValue = chosen.length === 0 ? "system" : chosen;
  const selectedLabel = options.find((row) => row.id === selectedValue)?.name ?? chosen;

  return (
    <SettingsRow
      id="setting-session-terminal"
      title="settings:sessionTerminal"
      description={t("settings:sessionTerminalDescription")}
      resetAction={
        chosen.length > 0 ? (
          <SettingResetButton
            label={t("settings:sessionTerminal")}
            onClick={() => void patch({ sessionTerminal: "" })}
          />
        ) : null
      }
      control={
        <SettingsSelectControl
          value={selectedValue}
          onValueChange={(value) =>
            void patch({ sessionTerminal: value === "system" ? "" : value })
          }
          ariaLabel={t("settings:sessionTerminal")}
          valueContent={selectedLabel}
          triggerClassName="w-full sm:w-56"
        >
          {options.map((row) => (
            <SelectItem hideIndicator key={row.id} value={row.id}>
              {row.name}
            </SelectItem>
          ))}
        </SettingsSelectControl>
      }
    />
  );
}

export function HostBehaviorSettingsSection() {
  const terminals = useQuery({
    queryKey: ["neolix-session-terminals"],
    queryFn: listSessionTerminals,
    staleTime: 60_000,
  });
  const hasWslRow = bridgePlatformOs() === "windows";
  const hasSessionTerminal = terminals.data?.supported === true;
  if (!hasWslRow && !hasSessionTerminal) {
    return null;
  }
  return (
    <SettingsSection title="settings:hostPreferences">
      {hasWslRow ? <WslAgentsRow /> : null}
      {hasSessionTerminal ? <SessionTerminalRow found={terminals.data} /> : null}
    </SettingsSection>
  );
}
