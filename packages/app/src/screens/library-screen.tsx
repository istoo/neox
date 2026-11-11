import { router, useLocalSearchParams } from "expo-router";
import { useCallback, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, Text, View } from "react-native";
import { PageLayout } from "@/components/page-layout";
import { LibrarySidebar } from "@/components/sidebar/library-sidebar";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useActiveHostServerId } from "@/hooks/use-active-host-server-id";
import {
  HostLibraryPage,
  LIBRARY_VIEWS,
  type LibraryView,
} from "@/screens/settings/library/library-page";
import { settingsStyles } from "@/styles/settings";

function isLibraryView(value: string | undefined): value is LibraryView {
  return value !== undefined && (LIBRARY_VIEWS as readonly string[]).includes(value);
}

/**
 * Library is a workspace page: instructions, MCP, skills and hooks across
 * agents. The list of sections is its own column beside the detail on wide
 * layouts; on compact, picking a section pushes its full screen.
 */
export function LibraryScreen() {
  const { t } = useTranslation();
  const serverId = useActiveHostServerId();
  const isCompact = useIsCompactFormFactor();
  const params = useLocalSearchParams<{ view?: string }>();
  const view: LibraryView = isLibraryView(params.view) ? params.view : "instructions";
  const hasSelection = isLibraryView(params.view);
  const onViewChange = useCallback((next: LibraryView) => {
    router.setParams({ view: next });
  }, []);
  const backToList = useCallback(() => {
    router.setParams({ view: undefined });
  }, []);

  let body: ReactElement;
  if (serverId === null) {
    body = <LibraryNoHost />;
  } else {
    body = (
      <HostLibraryPage
        serverId={serverId}
        view={view}
        onViewChange={onViewChange}
        showTabs={false}
      />
    );
  }

  const detail = (
    <PageLayout
      title={t(`settings.usePages.library.tabs.${view}`)}
      onBack={isCompact ? backToList : undefined}
    >
      {body}
    </PageLayout>
  );

  if (isCompact) {
    return hasSelection ? detail : <LibrarySidebar compact />;
  }

  return (
    <View style={styles.split}>
      <LibrarySidebar />
      {detail}
    </View>
  );
}

function LibraryNoHost() {
  const { t } = useTranslation();
  return (
    <View style={settingsStyles.card}>
      <View style={settingsStyles.row}>
        <Text style={settingsStyles.rowHint}>{t("quickPanel.noHost")}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  split: {
    flex: 1,
    flexDirection: "row",
    minHeight: 0,
  },
});
