import { useCallback } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import * as Clipboard from "expo-clipboard";
import { Button } from "@/components/ui/button";
import { SettingsRow } from "@/components/settings";
import { mcpAddress } from "./mcp-address";
import { useDaemonStatus, useSettingsHostServerId } from "./shared";

/**
 * A gateway MCP server's address, with a copy button: what myna shows in
 * Models › Images and Web search so an agent without the Library can mount
 * the same server (myna app.js:21434, 21435; plugins/search/settings.js:180).
 */
export function McpAddressRow({
  path,
  label,
  hint,
}: {
  path: string;
  label: string;
  hint: string;
}) {
  const { t } = useTranslation();
  const serverId = useSettingsHostServerId();
  const status = useDaemonStatus(serverId);
  const url = mcpAddress(status?.publicUrl, status?.listen, path);
  const copy = useCallback(() => {
    void Clipboard.setStringAsync(url);
  }, [url]);
  if (status === null || url === "") {
    return null;
  }
  return (
    <SettingsRow label={label} hint={hint} testID={`settings-mcp-address-${path}`}>
      <View style={styles.row}>
        <Text style={styles.url} numberOfLines={1}>
          {url}
        </Text>
        <Button
          variant="outline"
          size="sm"
          onPress={copy}
          testID={`settings-copy-mcp-address-${path}`}
        >
          {t("common.actions.copy")}
        </Button>
      </View>
    </SettingsRow>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    alignItems: "center",
    flexDirection: "row",
    gap: theme.spacing[2],
    flexShrink: 1,
  },
  url: {
    color: theme.colors.foregroundMuted,
    flexShrink: 1,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
  },
}));
