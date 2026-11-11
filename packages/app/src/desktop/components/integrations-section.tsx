import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useFocusEffect } from "expo-router/react-navigation";
import { Switch } from "@/components/ui/switch";
import { useCliInstall } from "@/desktop/hooks/use-install-status";
import { SettingsCard, SettingsRow, SettingsSection } from "@/components/settings";

const CLI_DOCS_URL = "https://github.com/istoo/neox/tree/main/public-docs/cli.md";

export function IntegrationsSection() {
  const { t } = useTranslation();
  const { available, row } = useCommandLineSetting();
  const docsLink = useMemo(
    () => ({
      href: CLI_DOCS_URL,
      label: t("settings.integrations.docs.cli"),
      accessibilityLabel: t("settings.integrations.docs.openCli"),
    }),
    [t],
  );
  if (!available) return null;
  return (
    <SettingsSection title={t("settings.integrations.title")} link={docsLink}>
      <SettingsCard>
        <CommandLineRow {...row} />
      </SettingsCard>
    </SettingsSection>
  );
}

/**
 * The CLI row's state, shared by Settings › Integrations and About (myna
 * app.js:19910 puts the same row in both). The status refreshes when the
 * screen comes back into focus, since installing happens in a terminal.
 */
export function useCommandLineSetting(): {
  available: boolean;
  row: { value: boolean; onValueChange: (next: boolean) => void; disabled: boolean };
} {
  const cli = useCliInstall();
  const { available, refresh, setInstalled } = cli;
  useFocusEffect(
    useCallback(() => {
      if (available) refresh();
      return undefined;
    }, [refresh, available]),
  );
  const onValueChange = useCallback(
    (next: boolean) => {
      void setInstalled(next);
    },
    [setInstalled],
  );
  return {
    available,
    row: {
      value: cli.status?.installed ?? false,
      onValueChange,
      disabled: cli.status === null || cli.isWorking,
    },
  };
}

/** The `neolix` CLI row: on means installed on this computer. */
export function CommandLineRow({
  value,
  onValueChange,
  disabled,
}: {
  value: boolean;
  onValueChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <SettingsRow
      label={t("settings.integrations.commandLine.title")}
      hint={t("settings.integrations.commandLine.description")}
    >
      <Switch
        value={value}
        onValueChange={onValueChange}
        disabled={disabled}
        accessibilityLabel={t("settings.integrations.commandLine.accessibilityLabel")}
      />
    </SettingsRow>
  );
}
