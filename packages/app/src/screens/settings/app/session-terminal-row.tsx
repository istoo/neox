import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { SettingsRow } from "@/components/settings";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { DropdownTrigger } from "@/components/ui/dropdown-trigger";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useSettingsHostServerId } from "./shared";

const TERMINAL_APP_ID = "com.apple.Terminal";

export interface TerminalOption {
  id: string;
  name: string;
}

export interface TerminalDiscovery {
  apps: TerminalOption[];
  default?: string;
}

export interface TerminalLabels {
  system: (name: string) => string;
  fixed: (name: string) => string;
  unavailable: (id: string) => string;
}

/**
 * myna's Session terminal row (plugins/sessions/settings.js:7): the host
 * asks Launch Services which installed apps open `.command` files, and the
 * chosen bundle id lives in that host's config, next to myna's own settings.
 * A terminal the host doesn't report is drawn as unavailable rather than
 * silently falling back.
 */
export function terminalOptions(
  found: TerminalDiscovery,
  chosen: string,
  labels: TerminalLabels,
): TerminalOption[] {
  const apps = [...found.apps];
  if (!apps.some((app) => app.id === TERMINAL_APP_ID)) {
    apps.unshift({ id: TERMINAL_APP_ID, name: "Terminal" });
  }
  const defaultApp =
    apps.find((app) => app.id === found.default) ?? apps.find((app) => app.id === TERMINAL_APP_ID);
  const options: TerminalOption[] = [
    { id: "system", name: labels.system(defaultApp?.name ?? "Terminal") },
  ];
  for (const app of apps) {
    if (app.id === defaultApp?.id && app.id !== chosen) {
      continue;
    }
    options.push({
      id: app.id,
      name: app.id === defaultApp?.id ? labels.fixed(app.name) : app.name,
    });
  }
  if (!options.some((option) => option.id === chosen)) {
    options.push({ id: chosen, name: labels.unavailable(chosen) });
  }
  return options;
}

function TerminalOptionItem({
  option,
  selected,
  onChange,
}: {
  option: TerminalOption;
  selected: boolean;
  onChange: (value: string) => void;
}) {
  const handleSelect = useCallback(() => onChange(option.id), [onChange, option.id]);
  return (
    <DropdownMenuItem selected={selected} onSelect={handleSelect}>
      {option.name}
    </DropdownMenuItem>
  );
}

export function SessionTerminalRow() {
  const { t } = useTranslation();
  const serverId = useSettingsHostServerId();
  const supported = useHostFeature(serverId, "sessionTerminal");
  const client = useHostRuntimeClient(serverId ?? "");
  const { config, patchConfig } = useDaemonConfig(serverId);
  const [found, setFound] = useState<TerminalDiscovery | null>(null);

  useEffect(() => {
    if (!supported || client === null) {
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const result = await client.listSessionTerminals();
        if (!cancelled) {
          setFound(
            result.supported && result.error === null
              ? { apps: result.apps, default: result.defaultId ?? "" }
              : null,
          );
        }
      } catch {
        if (!cancelled) {
          setFound(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, supported]);

  const labels = useMemo<TerminalLabels>(
    () => ({
      system: (name) => t("settings.pages.general.sessionTerminalSystem", { name }),
      fixed: (name) => t("settings.pages.general.sessionTerminalFixed", { name }),
      unavailable: (id) => t("settings.pages.general.sessionTerminalUnavailable", { id }),
    }),
    [t],
  );
  const chosen = config?.sessionTerminal ? config.sessionTerminal : "system";
  const options = useMemo(
    () => (found === null ? [] : terminalOptions(found, chosen, labels)),
    [found, chosen, labels],
  );
  const handleChange = useCallback(
    (value: string) => void patchConfig({ sessionTerminal: value === "system" ? "" : value }),
    [patchConfig],
  );
  const selected = options.find((option) => option.id === chosen);

  if (!supported || found === null || options.length === 0) {
    return null;
  }
  return (
    <SettingsRow
      label={t("settings.pages.general.sessionTerminal")}
      hint={t("settings.pages.general.sessionTerminalHint")}
    >
      <DropdownMenu>
        <DropdownTrigger accessibilityRole="button" accessibilityLabel={selected?.name ?? chosen}>
          {selected?.name ?? chosen}
        </DropdownTrigger>
        <DropdownMenuContent side="bottom" align="end" width={300}>
          {options.map((option) => (
            <TerminalOptionItem
              key={option.id}
              option={option}
              selected={option.id === chosen}
              onChange={handleChange}
            />
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </SettingsRow>
  );
}
