import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { ArchiveRestore, Download, Folder, RefreshCw } from "lucide-react-native";
import type { LibrarySnapshot, LibrarySyncResult } from "@neolix/protocol/library";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { PressHighlight } from "@/components/ui/press-highlight";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useToast } from "@/contexts/toast-api-context";
import { useLibrary } from "@/hooks/use-library";
import { useOpenOutsideWorkspaceFolder } from "@/workspace/open-in-file-manager/outside-folder";
import { InstructionsTab } from "./instructions-tab";
import { McpTab } from "./mcp-tab";
import { SkillsTab } from "./skills-tab";
import { HooksTab } from "./hooks-tab";
import { SubagentsTab } from "./subagents-tab";
import { RtkTab } from "./rtk-tab";
import { DiscoverSheet } from "./discover-sheet";
import { BackupsSheet } from "./backups-sheet";
import { firstReportableLibraryProblem, resolveLibraryPageState } from "./library-page-state";
import type { LibraryTabProps } from "./types";

export type LibraryView = "instructions" | "mcp" | "skills" | "hooks" | "subagents" | "rtk";

export const LIBRARY_VIEWS: readonly LibraryView[] = [
  "instructions",
  "mcp",
  "skills",
  "hooks",
  "subagents",
  "rtk",
];

/** Sidebar counts: every view with a number beside it. */
export function libraryViewCounts(
  library: LibrarySnapshot | null,
): Partial<Record<LibraryView, number>> {
  if (!library) {
    return {};
  }
  return {
    mcp: library.counts.mcp,
    skills: library.counts.skills,
    hooks: library.counts.hooks,
    subagents: library.counts.subagents,
    rtk: library.counts.rtk,
  };
}

function TabBar({
  active,
  counts,
  onSelect,
}: {
  active: LibraryView;
  counts: Partial<Record<LibraryView, number>>;
  onSelect: (view: LibraryView) => void;
}) {
  const { t } = useTranslation();
  return (
    <View style={styles.tabs}>
      {LIBRARY_VIEWS.map((view) => (
        <TabButton
          key={view}
          view={view}
          label={t(`settings.usePages.library.tabs.${view}`)}
          count={counts[view]}
          active={view === active}
          onSelect={onSelect}
        />
      ))}
    </View>
  );
}

function TabButton({
  view,
  label,
  count,
  active,
  onSelect,
}: {
  view: LibraryView;
  label: string;
  count: number | undefined;
  active: boolean;
  onSelect: (view: LibraryView) => void;
}) {
  const press = useCallback(() => onSelect(view), [onSelect, view]);
  const accessibilityState = useMemo(() => ({ selected: active }), [active]);
  const style = useMemo(() => [styles.tab, active && styles.tabActive], [active]);
  const labelStyle = useMemo(() => [styles.tabLabel, active && styles.tabLabelActive], [active]);
  return (
    <PressHighlight
      accessibilityRole="tab"
      accessibilityState={accessibilityState}
      onPress={press}
      style={style}
    >
      <Text style={labelStyle}>{label}</Text>
      {count !== undefined && count > 0 ? <Text style={styles.count}>{count}</Text> : null}
    </PressHighlight>
  );
}

function TabContent(props: LibraryTabProps & { view: LibraryView }) {
  switch (props.view) {
    case "instructions":
      return <InstructionsTab {...props} />;
    case "mcp":
      return <McpTab {...props} />;
    case "skills":
      return <SkillsTab {...props} />;
    case "hooks":
      return <HooksTab {...props} />;
    case "subagents":
      return <SubagentsTab {...props} />;
    case "rtk":
      return <RtkTab {...props} />;
  }
}

export function HostLibraryPage({
  serverId,
  view: controlledView,
  onViewChange,
  showTabs = controlledView === undefined,
}: {
  serverId: string;
  /** Controlled subpage, for a sidebar mirroring the page's tabs. */
  view?: LibraryView;
  onViewChange?(view: LibraryView): void;
  showTabs?: boolean;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const { library, isLoading, error, supported, isConnected, client, applyLibrary } =
    useLibrary(serverId);
  const openFolder = useOpenOutsideWorkspaceFolder(serverId);
  const [activeView, setActiveView] = useState<LibraryView>("instructions");
  const view = controlledView ?? activeView;
  const [discoverOpen, setDiscoverOpen] = useState(false);
  const [backupsOpen, setBackupsOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const onSaved = useCallback(
    (result: LibrarySyncResult) => {
      const problem = firstReportableLibraryProblem(result);
      if (problem) {
        toast.error(`${problem.agent}: ${problem.error}`);
        return;
      }
      toast.show(t("settings.usePages.library.common.saved"));
    },
    [t, toast],
  );

  const onError = useCallback(
    (cause: unknown) => {
      toast.error(cause instanceof Error ? cause.message : String(cause));
    },
    [toast],
  );

  const counts = useMemo(() => libraryViewCounts(library), [library]);

  const changeView = useCallback(
    (next: LibraryView) => {
      setActiveView(next);
      onViewChange?.(next);
    },
    [onViewChange],
  );

  const sync = useCallback(() => {
    if (!client) {
      return;
    }
    setSyncing(true);
    void (async () => {
      try {
        const result = await client.syncLibrary();
        applyLibrary(result.library);
        onSaved(result.result);
      } catch (cause) {
        onError(cause);
      } finally {
        setSyncing(false);
      }
    })();
  }, [applyLibrary, client, onError, onSaved]);

  const openDiscover = useCallback(() => setDiscoverOpen(true), []);
  const closeDiscover = useCallback(() => setDiscoverOpen(false), []);
  const openBackups = useCallback(() => setBackupsOpen(true), []);
  const closeBackups = useCallback(() => setBackupsOpen(false), []);

  const openLibraryFolder = useCallback(() => {
    if (library) {
      openFolder(library.dir);
    }
  }, [library, openFolder]);

  const openBackupsFolder = useCallback(() => {
    if (library) {
      openFolder(library.backupsDir);
    }
  }, [library, openFolder]);

  const pageState = resolveLibraryPageState({
    supported,
    isConnected,
    error,
    isLoading,
    library,
    client,
  });

  if (pageState === "unsupported") {
    return <Alert variant="warning" description={t("settings.usePages.library.unsupported")} />;
  }

  if (pageState === "disconnected") {
    // The library query stays disabled offline; a spinner would never resolve.
    return (
      <Alert variant="warning" description={t("settings.gatewayPages.usage.errors.disconnected")} />
    );
  }

  if (pageState === "error") {
    return (
      <Alert
        variant="error"
        description={t("settings.usePages.library.loadFailed", { error: error?.message ?? "" })}
      />
    );
  }

  if (pageState === "loading" || !library || !client) {
    return (
      <View style={styles.loading}>
        <LoadingSpinner size="large" color={styles.spinnerColor.color} />
      </View>
    );
  }

  return (
    <View>
      <View style={styles.header}>
        {showTabs ? <TabBar active={view} counts={counts} onSelect={changeView} /> : null}
        <View style={styles.actions}>
          <Button variant="ghost" leftIcon={RefreshCw} onPress={sync} disabled={syncing}>
            {syncing
              ? t("settings.usePages.library.actions.syncing")
              : t("settings.usePages.library.actions.sync")}
          </Button>
          <Button variant="ghost" leftIcon={Download} onPress={openDiscover}>
            {t("settings.usePages.library.discover.button")}
          </Button>
          <Button variant="ghost" leftIcon={Folder} onPress={openLibraryFolder}>
            {t("settings.usePages.library.folder")}
          </Button>
          <Button variant="ghost" leftIcon={ArchiveRestore} onPress={openBackups}>
            {t("settings.usePages.library.backups")}
          </Button>
        </View>
      </View>

      <DiscoverSheet
        visible={discoverOpen}
        client={client}
        library={library}
        onClose={closeDiscover}
        onLibrary={applyLibrary}
        onSaved={onSaved}
        onError={onError}
      />
      <BackupsSheet
        visible={backupsOpen}
        client={client}
        library={library}
        onClose={closeBackups}
        onLibrary={applyLibrary}
        onOpenFolder={openBackupsFolder}
        onError={onError}
      />

      <TabContent
        view={view}
        serverId={serverId}
        library={library}
        client={client}
        onLibrary={applyLibrary}
        onSaved={onSaved}
        onError={onError}
        disabled={false}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  header: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    marginBottom: theme.spacing[4],
  },
  tabs: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[1],
    flexShrink: 1,
  },
  tab: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    borderRadius: theme.borderRadius.full,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1.5],
  },
  tabActive: {
    backgroundColor: theme.colors.surface3,
  },
  tabLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  tabLabelActive: {
    color: theme.colors.foreground,
  },
  count: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    flexShrink: 1,
    alignItems: "center",
    gap: theme.spacing[1],
  },
  loading: {
    paddingVertical: theme.spacing[8],
    alignItems: "center",
  },
  spinnerColor: {
    color: theme.colors.foregroundMuted,
  },
}));
