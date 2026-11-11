import { useCallback, useMemo, useRef, useState } from "react";
import type { ComponentType, ReactNode, RefObject } from "react";
import { Pressable, ScrollView, Text, View, type PressableStateCallbackType } from "react-native";
import { usePathname, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import {
  ArrowLeft,
  Blocks,
  Bot,
  Boxes,
  FolderGit2,
  Gauge,
  Mic,
  Network,
  Plus,
  Search,
  Server,
  Smartphone,
  Sparkles,
  SquareTerminal,
  X,
} from "lucide-react-native";
import { useHosts } from "@/runtime/host-runtime";
import {
  orderHostsLocalFirst,
  resolveActiveHostServerId,
  type HostProfile,
} from "@/types/host-connection";
import { TitlebarDragRegion } from "@/components/desktop/titlebar-drag-region";
import { Button } from "@/components/ui/button";
import { WindowChromeRegion, WindowChromeSafeArea } from "@/utils/desktop-window";
import { BackHeader } from "@/components/headers/back-header";
import { PageLayout } from "@/components/page-layout";
import {
  SETTINGS_PAGES,
  SETTINGS_PAGE_BY_ID,
  SETTINGS_PAGE_LEGACY_SECTION_MAP,
  isSettingsPageAvailable,
  useSettingsSearch,
  type SettingsPageId,
  type SettingsSearchGroup,
} from "@/screens/settings/app";
import {
  selectSettingsHost,
  useSettingsHostSelection,
  useSettingsSidebarScroll,
} from "@/navigation/settings-presentation";
import { EditingTextInput, type EditingTextInputHandle } from "@/components/ui/text-input";
import { ComboboxTrigger } from "@/components/ui/combobox-trigger";
import { HostPicker as SharedHostPicker } from "@/components/hosts/host-picker";
import { HostStatusDot } from "@/components/host-status-dot";
import { useAddHost } from "@/hosts/add-host";
import { useEnableBuiltInDaemonOption } from "@/desktop/hooks/use-enable-built-in-daemon-option";
import { isElectronRuntime } from "@/desktop/host";
import { useHardwareKeyboardPresent } from "@/keyboard";
import { usePluginDisplayName } from "@/plugins/plugin-list";
import { PluginSettingsContent } from "@/plugins/settings";
import {
  HostAgentsPage,
  HostConnectionsPage,
  HostPairDevicePage,
  HostProvidersPage,
  HostSettingsPage,
  HostTerminalsPage,
  HostUsagePage,
  HostWorkspacesPage,
} from "@/screens/settings/host-page";
import { HostPluginsPage } from "@/screens/settings/plugins-page";
import { MetadataGenerationPage } from "@/screens/settings/metadata-generation-page";
import { HostVoicePage } from "@/screens/settings/voice/voice-page";
import { HostSessionsPage } from "@/screens/settings/sessions/sessions-page";
import { HostLibraryPage } from "@/screens/settings/library/library-page";
import { GatewaySettingsSection, type GatewayPane } from "@/screens/settings/gateway-section";
import ProjectsScreen from "@/screens/projects-screen";
import ProjectSettingsScreen from "@/screens/project-settings-screen";
import { useSettingsSubviewStore } from "@/stores/settings-subview-store";
import {
  SETTINGS_DESKTOP_DETAIL_MIN_WIDTH,
  SETTINGS_DESKTOP_SIDEBAR_WIDTH,
  useIsCompactFormFactor,
} from "@/constants/layout";
import { density, densityIconBox, densityIconSize } from "@/styles/density";
import { useLocalDaemonServerId } from "@/hooks/use-is-local-daemon";
import {
  buildSettingsHostSectionRoute,
  buildSettingsSectionRoute,
  type HostSectionSlug,
  type SettingsSectionSlug,
} from "@/utils/host-routes";
import { returnFromSettings, type SettingsView } from "@/navigation/settings-navigation";
import { resolveSettingsRouteSelection } from "@/utils/settings-route-selection";

// ---------------------------------------------------------------------------
// View model
// ---------------------------------------------------------------------------

// The app-level pages and their order live in `@/screens/settings/app`
// (myna's parts first, then Neolix-only pages).
/** A tab page's slug to the sidebar entry that owns it. */
// ---------------------------------------------------------------------------
// Host settings content
// ---------------------------------------------------------------------------

/** The header a host section route shows. */
const HOST_SECTION_TITLES: Record<HostSectionSlug, string> = {
  projects: "settings.hostSections.projects",
  connections: "settings.hostSections.connections",
  "pair-device": "openProject.tiles.pairDevice.title",
  agents: "settings.hostSections.agents",
  metadata: "settings.hostSections.metadata",
  voice: "settings.hostSections.voice",
  workspaces: "settings.hostSections.workspaces",
  providers: "settings.hostSections.providers",
  sessions: "settings.hostSections.sessions",
  library: "settings.hostSections.library",
  gateway: "settings.hostSections.gateway",
  "gateway-providers": "settings.hostSections.gatewayProviders",
  "gateway-routing": "settings.hostSections.gatewayRouting",
  "gateway-keys": "settings.hostSections.gatewayKeys",
  "gateway-advanced": "settings.hostSections.gatewayAdvanced",
  usage: "settings.hostSections.usage",
  terminals: "settings.hostSections.terminals",
  masking: "settings.hostSections.masking",
  plugins: "settings.hostSections.plugins",
  host: "settings.hostSections.host",
};

interface HostSectionItem {
  id: HostSectionSlug;
  icon: ComponentType<{ size: number; color: string; strokeWidth?: number }>;
}

/** The host-scoped rows, in the order the host group has always shown them. */
const HOST_SECTION_ITEMS: HostSectionItem[] = [
  { id: "host", icon: Server },
  { id: "projects", icon: FolderGit2 },
  { id: "connections", icon: Network },
  { id: "pair-device", icon: Smartphone },
  { id: "agents", icon: Bot },
  { id: "metadata", icon: Sparkles },
  { id: "voice", icon: Mic },
  { id: "workspaces", icon: FolderGit2 },
  { id: "providers", icon: Boxes },
  { id: "usage", icon: Gauge },
  { id: "terminals", icon: SquareTerminal },
  { id: "plugins", icon: Blocks },
];

/** The page that draws a section, via the app registry's slug-to-page map. */
function settingsPageIdFor(section: SettingsSectionSlug): SettingsPageId {
  return SETTINGS_PAGE_LEGACY_SECTION_MAP[section] ?? (section as SettingsPageId);
}

/** The Library page's tabs live in the shared subview store, as myna mirrors them. */
function LibrarySettingsContent({ serverId }: { serverId: string }) {
  const view = useSettingsSubviewStore((state) => state.library);
  const setView = useSettingsSubviewStore((state) => state.setLibrary);
  return <HostLibraryPage serverId={serverId} view={view} onViewChange={setView} showTabs />;
}

/** The host sections that are panes of the gateway page. */
const HOST_SECTION_GATEWAY_PANES: Partial<Record<HostSectionSlug, GatewayPane>> = {
  gateway: "overview",
  "gateway-providers": "providers",
  "gateway-routing": "routing",
  "gateway-keys": "keys",
  "gateway-advanced": "advanced",
  masking: "masking",
};

function renderHostSettingsContent(
  view: Extract<SettingsView, { kind: "host" }>,
  onHostRemoved: () => void,
): ReactNode {
  const gatewayPane = HOST_SECTION_GATEWAY_PANES[view.section];
  if (gatewayPane !== undefined) {
    return (
      <GatewaySettingsSection
        serverId={view.serverId}
        pane={gatewayPane}
        focusRecord={view.focusRecord}
      />
    );
  }
  switch (view.section) {
    case "projects":
      return <ProjectsScreen serverId={view.serverId} />;
    case "connections":
      return <HostConnectionsPage serverId={view.serverId} />;
    case "pair-device":
      return <HostPairDevicePage serverId={view.serverId} />;
    case "agents":
      return <HostAgentsPage serverId={view.serverId} />;
    case "metadata":
      return <MetadataGenerationPage serverId={view.serverId} />;
    case "voice":
      return <HostVoicePage serverId={view.serverId} />;
    case "workspaces":
      return <HostWorkspacesPage serverId={view.serverId} />;
    case "providers":
      return <HostProvidersPage serverId={view.serverId} />;
    case "sessions":
      return <HostSessionsPage serverId={view.serverId} />;
    case "library":
      return <LibrarySettingsContent serverId={view.serverId} />;
    case "usage":
      return <HostUsagePage serverId={view.serverId} />;
    case "terminals":
      return <HostTerminalsPage serverId={view.serverId} />;
    case "plugins":
      return <HostPluginsPage serverId={view.serverId} />;
    case "host":
      return <HostSettingsPage serverId={view.serverId} onHostRemoved={onHostRemoved} />;
  }
}

// ---------------------------------------------------------------------------
// Trigger + sidebar style helpers
// ---------------------------------------------------------------------------

function sidebarItemStyle({
  hovered,
  pressed,
}: PressableStateCallbackType & { hovered?: boolean }) {
  return [
    sidebarStyles.item,
    Boolean(hovered) && sidebarStyles.itemHovered,
    pressed && sidebarStyles.itemPressed,
  ];
}

function selectedSidebarItemStyle({
  hovered,
  pressed,
}: PressableStateCallbackType & { hovered?: boolean }) {
  return [
    sidebarStyles.item,
    Boolean(hovered) && sidebarStyles.itemHovered,
    sidebarStyles.itemSelected,
    pressed && sidebarStyles.itemPressed,
  ];
}

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

/**
 * Local daemon first, then remaining hosts in their existing order.
 */
function useSortedHosts(hosts: HostProfile[], localServerId: string | null): HostProfile[] {
  return useMemo(() => orderHostsLocalFirst(hosts, localServerId), [hosts, localServerId]);
}

interface SidebarSectionButtonProps {
  itemId: SettingsSectionSlug;
  label: string;
  icon: ComponentType<{ size: number; color: string; strokeWidth?: number }>;
  isSelected: boolean;
  onSelect: (section: SettingsSectionSlug) => void;
}

// Lighter than lucide's default 2px stroke so the nav reads quieter than the content.
const SIDEBAR_ICON_STROKE_WIDTH = 1.5;

function SidebarSectionButton({
  itemId,
  label,
  icon: IconComponent,
  isSelected,
  onSelect,
}: SidebarSectionButtonProps) {
  const { theme, rt } = useUnistyles();
  const handlePress = useCallback(() => {
    onSelect(itemId);
  }, [onSelect, itemId]);
  const accessibilityState = useMemo(() => ({ selected: isSelected }), [isSelected]);
  const labelStyle = useMemo(
    () => [sidebarStyles.label, isSelected && { color: theme.colors.foreground }],
    [isSelected, theme.colors.foreground],
  );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      onPress={handlePress}
      style={isSelected ? selectedSidebarItemStyle : sidebarItemStyle}
    >
      <IconComponent
        size={densityIconSize(rt, "md")}
        color={isSelected ? theme.colors.foreground : theme.colors.foregroundMuted}
        strokeWidth={SIDEBAR_ICON_STROKE_WIDTH}
      />
      <Text style={labelStyle} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * Scopes the host sections to a host. Reuses the canonical sidebar host
 * switcher pattern (left-sidebar.tsx): a quiet row-styled trigger opening a
 * <Combobox>. The local host is listed first, each row shows the connection it
 * is using right now; an "Add host" row is always reachable from the list —
 * even with a single host.
 */
interface SidebarHostSectionButtonProps {
  itemId: HostSectionSlug;
  label: string;
  icon: ComponentType<{ size: number; color: string; strokeWidth?: number }>;
  isSelected: boolean;
  onSelect: (section: HostSectionSlug) => void;
}

function SidebarHostSectionButton({
  itemId,
  label,
  icon: IconComponent,
  isSelected,
  onSelect,
}: SidebarHostSectionButtonProps) {
  const { theme, rt } = useUnistyles();
  const handlePress = useCallback(() => {
    onSelect(itemId);
  }, [onSelect, itemId]);
  const accessibilityState = useMemo(() => ({ selected: isSelected }), [isSelected]);
  const labelStyle = useMemo(
    () => [sidebarStyles.label, isSelected && { color: theme.colors.foreground }],
    [isSelected, theme.colors.foreground],
  );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      onPress={handlePress}
      testID={`settings-host-section-${itemId}`}
      style={isSelected ? selectedSidebarItemStyle : sidebarItemStyle}
    >
      <IconComponent
        size={densityIconSize(rt, "md")}
        color={isSelected ? theme.colors.foreground : theme.colors.foregroundMuted}
        strokeWidth={SIDEBAR_ICON_STROKE_WIDTH}
      />
      <Text style={labelStyle} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

interface HostPickerProps {
  activeServerId: string | null;
  sortedHosts: HostProfile[];
  onSelectHost: (serverId: string) => void;
  onAddHost: () => void;
  enableBuiltInDaemonOption: { visible: boolean; onPress: () => void };
}

function HostPicker({
  activeServerId,
  sortedHosts,
  onSelectHost,
  onAddHost,
  enableBuiltInDaemonOption,
}: HostPickerProps) {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const triggerRef = useRef<View | null>(null);
  const activeHost =
    sortedHosts.find((host) => host.serverId === activeServerId) ?? sortedHosts[0] ?? null;

  const handleOpen = useCallback(() => setIsOpen(true), []);
  const hostOptionTestID = useCallback(
    (serverId: string) => `settings-host-picker-item-${serverId}`,
    [],
  );
  const triggerStyle = useCallback(
    ({ hovered = false, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      sidebarStyles.pickerTrigger,
      hovered && sidebarStyles.pickerTriggerHovered,
      pressed && sidebarStyles.itemPressed,
    ],
    [],
  );

  return (
    <SharedHostPicker
      hosts={sortedHosts}
      value={activeServerId ?? ""}
      onSelect={onSelectHost}
      open={isOpen}
      onOpenChange={setIsOpen}
      anchorRef={triggerRef}
      includeAddHost
      onAddHost={onAddHost}
      includeEnableBuiltInDaemon={enableBuiltInDaemonOption.visible}
      onEnableBuiltInDaemon={enableBuiltInDaemonOption.onPress}
      showActiveConnection
      searchable={false}
      title={t("settings.hostPicker.switchHost")}
      desktopMinWidth={240}
      addHostTestID="settings-add-host"
      hostOptionTestID={hostOptionTestID}
    >
      <ComboboxTrigger
        ref={triggerRef}
        block
        style={triggerStyle}
        onPress={handleOpen}
        accessibilityRole="button"
        accessibilityLabel={t("settings.hostPicker.switchHost")}
        testID="settings-host-picker"
      >
        {activeHost ? (
          <View style={sidebarStyles.pickerTriggerDot}>
            <HostStatusDot serverId={activeHost.serverId} />
          </View>
        ) : null}
        <Text style={sidebarStyles.pickerTriggerLabel} numberOfLines={1}>
          {activeHost?.label ?? t("settings.groups.host")}
        </Text>
      </ComboboxTrigger>
    </SharedHostPicker>
  );
}

/** A labelled group of sidebar rows. On compact layouts the rows sit together in one island. */
function SidebarGroup({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <View style={sidebarStyles.group}>
      {label ? <Text style={sidebarStyles.groupLabel}>{label}</Text> : null}
      <View style={sidebarStyles.island}>{children}</View>
    </View>
  );
}

function SettingsSearchField({
  inputRef,
  value,
  onChangeText,
  onClear,
}: {
  inputRef: RefObject<EditingTextInputHandle | null>;
  value: string;
  onChangeText: (text: string) => void;
  onClear: () => void;
}) {
  const { t } = useTranslation();
  const { theme, rt } = useUnistyles();
  const inputStyle = useMemo(
    () => [sidebarStyles.searchInput, { color: theme.colors.foreground }],
    [theme.colors.foreground],
  );
  return (
    <View style={sidebarStyles.searchField}>
      <Search
        size={densityIconSize(rt, "sm")}
        color={theme.colors.foregroundMuted}
        strokeWidth={SIDEBAR_ICON_STROKE_WIDTH}
      />
      <EditingTextInput
        ref={inputRef}
        initialValue={value}
        onChangeText={onChangeText}
        placeholder={t("settings.searchPlaceholder")}
        placeholderTextColor={theme.colors.foregroundMuted}
        style={inputStyle}
        testID="settings-search-input"
        accessibilityLabel={t("settings.searchPlaceholder")}
      />
      {value.length > 0 ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("common.actions.dismiss")}
          onPress={onClear}
          style={sidebarStyles.searchClear}
          testID="settings-search-clear"
        >
          <X
            size={densityIconSize(rt, "sm")}
            color={theme.colors.foregroundMuted}
            strokeWidth={SIDEBAR_ICON_STROKE_WIDTH}
          />
        </Pressable>
      ) : null}
    </View>
  );
}

function SettingsSearchRow({
  label,
  section,
  onSelect,
}: {
  label: string;
  section: SettingsSectionSlug;
  onSelect: (section: SettingsSectionSlug) => void;
}) {
  const handlePress = useCallback(() => onSelect(section), [onSelect, section]);
  return (
    <Pressable accessibilityRole="button" onPress={handlePress} style={sidebarItemStyle}>
      <Text style={sidebarStyles.label} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

/** Rows matching the settings search, one group per page. */
function SettingsSearchResults({
  groups,
  onSelect,
  showEmpty,
}: {
  groups: SettingsSearchGroup[];
  onSelect: (section: SettingsSectionSlug) => void;
  showEmpty: boolean;
}) {
  const { t } = useTranslation();
  if (groups.length === 0) {
    return showEmpty ? (
      <Text style={sidebarStyles.searchEmpty}>{t("settings.searchEmpty")}</Text>
    ) : null;
  }
  return (
    <>
      {groups.map((group) => {
        return (
          <SidebarGroup key={group.pageId} label={t(group.titleKey)}>
            {group.entries.map((entry) => (
              <SettingsSearchRow
                key={`${group.pageId}:${entry.titleKey}`}
                label={t(entry.titleKey)}
                section={group.pageId}
                onSelect={onSelect}
              />
            ))}
          </SidebarGroup>
        );
      })}
    </>
  );
}

interface SettingsSidebarProps {
  onSelectSection: (section: SettingsSectionSlug) => void;
  onSelectHostSection: (section: HostSectionSlug) => void;
  onSelectHost: (serverId: string) => void;
  onAddHost: () => void;
  onBackToWorkspace: () => void;
  activeHostServerId: string | null;
  layout: "desktop" | "mobile";
}

function SettingsSidebar({
  onSelectSection,
  onSelectHostSection,
  onSelectHost,
  onAddHost,
  onBackToWorkspace,
  activeHostServerId,
  layout,
}: SettingsSidebarProps) {
  const { theme, rt } = useUnistyles();
  const { t } = useTranslation();
  const hosts = useHosts();
  const localServerId = useLocalDaemonServerId();
  const sortedHosts = useSortedHosts(hosts, localServerId);
  const hasHosts = sortedHosts.length > 0;
  const enableBuiltInDaemonOption = useEnableBuiltInDaemonOption();
  const isDesktopApp = isElectronRuntime();
  const hardwareKeyboardPresent = useHardwareKeyboardPresent();
  const items = SETTINGS_PAGES.filter((page) =>
    isSettingsPageAvailable(page, isDesktopApp, hardwareKeyboardPresent),
  );
  const insets = useSafeAreaInsets();
  const isDesktop = layout === "desktop";
  const [query, setQuery] = useState("");
  const searchResults = useSettingsSearch(query);
  const isSearching = query.trim().length > 0;
  const searchInputRef = useRef<EditingTextInputHandle>(null);
  const clearSearch = useCallback(() => {
    setQuery("");
    searchInputRef.current?.replaceText("");
  }, []);
  const handleSearchSelect = useCallback(
    (section: SettingsSectionSlug) => {
      setQuery("");
      searchInputRef.current?.replaceText("");
      onSelectSection(section);
    },
    [onSelectSection],
  );
  const sidebarScroll = useSettingsSidebarScroll(isDesktop);
  const outerContainerStyle = useMemo(
    () => [isDesktop ? sidebarStyles.desktopContainer : sidebarStyles.mobileContainer],
    [isDesktop],
  );
  const innerContainerStyle = useMemo(
    () => [{ flex: 1 }, isDesktop ? { paddingTop: insets.top } : null],
    [insets.top, isDesktop],
  );
  // The page whose sidebar row is selected comes from the route on top. A
  // retained sibling route keeps its own `view` prop, so reading the pathname
  // is what keeps the highlight aligned after a replace.
  const pathname = usePathname();
  const routeSelection = useMemo(() => resolveSettingsRouteSelection(pathname), [pathname]);
  const selectedPageId =
    routeSelection.kind === "section" ? settingsPageIdFor(routeSelection.section) : null;
  let selectedHostSection: HostSectionSlug | null = null;
  if (routeSelection.kind === "host") selectedHostSection = routeSelection.section;
  if (routeSelection.kind === "project") selectedHostSection = "projects";
  if (routeSelection.kind === "plugin") selectedHostSection = "plugins";

  const sidebarBody = (
    <>
      <SidebarGroup label={t("settings.groups.app")}>
        {items.map((page) => (
          <SidebarSectionButton
            key={page.id}
            itemId={page.id}
            label={t(page.titleKey)}
            icon={page.icon}
            isSelected={selectedPageId === page.id}
            onSelect={onSelectSection}
          />
        ))}
      </SidebarGroup>
      {hasHosts ? (
        <SidebarGroup label={t("settings.groups.host")}>
          <HostPicker
            activeServerId={activeHostServerId}
            sortedHosts={sortedHosts}
            onSelectHost={onSelectHost}
            onAddHost={onAddHost}
            enableBuiltInDaemonOption={enableBuiltInDaemonOption}
          />
          {HOST_SECTION_ITEMS.map((item) => (
            <SidebarHostSectionButton
              key={item.id}
              itemId={item.id}
              label={t(HOST_SECTION_TITLES[item.id])}
              icon={item.icon}
              isSelected={selectedHostSection === item.id}
              onSelect={onSelectHostSection}
            />
          ))}
        </SidebarGroup>
      ) : (
        <SidebarGroup>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("settings.addHost")}
            onPress={onAddHost}
            testID="settings-add-host"
            style={sidebarItemStyle}
          >
            <Plus
              size={densityIconSize(rt, "md")}
              color={theme.colors.foregroundMuted}
              strokeWidth={SIDEBAR_ICON_STROKE_WIDTH}
            />
            <Text style={sidebarStyles.label} numberOfLines={1}>
              {t("settings.addHost")}
            </Text>
          </Pressable>
          {enableBuiltInDaemonOption.visible ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("settings.enableBuiltInDaemon")}
              onPress={enableBuiltInDaemonOption.onPress}
              testID="settings-enable-built-in-daemon"
              style={sidebarItemStyle}
            >
              <Server
                size={densityIconSize(rt, "md")}
                color={theme.colors.foregroundMuted}
                strokeWidth={SIDEBAR_ICON_STROKE_WIDTH}
              />
              <Text style={sidebarStyles.label} numberOfLines={1}>
                {t("settings.enableBuiltInDaemon")}
              </Text>
            </Pressable>
          ) : null}
        </SidebarGroup>
      )}
    </>
  );

  return (
    <View
      accessibilityLabel={t("settings.title")}
      role="navigation"
      style={outerContainerStyle}
      testID="settings-sidebar"
    >
      {isDesktop ? (
        <View style={innerContainerStyle}>
          <View style={sidebarStyles.sidebarDragArea}>
            <TitlebarDragRegion />
            <WindowChromeSafeArea placement="below" />
            {/* Desktop's split view has no header back affordance, so the way out of
                settings lives at the top of its own column. */}
            <Button
              variant="ghost"
              size="sm"
              leftIcon={ArrowLeft}
              onPress={onBackToWorkspace}
              style={sidebarStyles.backToWorkspace}
              textStyle={sidebarStyles.backToWorkspaceLabel}
              testID="settings-back-to-workspace"
              accessibilityLabel={t("settings.backToWorkspace")}
            >
              {t("settings.backToWorkspace")}
            </Button>
            <SettingsSearchField
              inputRef={searchInputRef}
              value={query}
              onChangeText={setQuery}
              onClear={clearSearch}
            />
          </View>
          <ScrollView
            style={sidebarStyles.scrollBody}
            showsVerticalScrollIndicator={false}
            testID="settings-sidebar-scroll-body"
            {...sidebarScroll}
          >
            {isSearching ? (
              <SettingsSearchResults
                groups={searchResults}
                onSelect={handleSearchSelect}
                showEmpty
              />
            ) : (
              sidebarBody
            )}
          </ScrollView>
        </View>
      ) : (
        sidebarBody
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Main screen
// ---------------------------------------------------------------------------

export interface SettingsScreenProps {
  view: SettingsView;
}

export default function SettingsScreen({ view }: SettingsScreenProps) {
  const router = useRouter();
  const { t } = useTranslation();
  const isCompactLayout = useIsCompactFormFactor();
  const insets = useSafeAreaInsets();
  const insetBottomStyle = useMemo(() => ({ paddingBottom: insets.bottom }), [insets.bottom]);
  const hosts = useHosts();
  const localServerId = useLocalDaemonServerId();
  const sortedHosts = useSortedHosts(hosts, localServerId);
  const selectedSettingsHostServerId = useSettingsHostSelection();
  const isDesktopApp = isElectronRuntime();
  const hardwareKeyboardPresent = useHardwareKeyboardPresent();

  // The host the four sections scope to: the host on the active view, otherwise
  // the picker choice, otherwise the connected local daemon, otherwise the first host.
  const activeHostServerId = useMemo(() => {
    if (view.kind === "host" || view.kind === "project" || view.kind === "plugin")
      return view.serverId;
    return resolveActiveHostServerId({
      selectedServerId: selectedSettingsHostServerId,
      localServerId,
      hosts,
      orderedHosts: sortedHosts,
    });
  }, [view, selectedSettingsHostServerId, localServerId, hosts, sortedHosts]);

  const handleSelectSection = useCallback(
    (section: SettingsSectionSlug) => {
      const target = buildSettingsSectionRoute(section);
      if (isCompactLayout) {
        router.push(target);
      } else {
        router.replace(target);
      }
    },
    [isCompactLayout, router],
  );

  const handleHostAdded = useCallback(
    (serverId: string) => {
      selectSettingsHost(serverId);
      const target = buildSettingsHostSectionRoute(serverId, "host");
      if (isCompactLayout) {
        router.push(target);
      } else {
        router.replace(target);
      }
    },
    [isCompactLayout, router],
  );

  const handleAddHost = useAddHost({ onAdded: handleHostAdded });

  // Picker: choose the host for host-section rows. If the user is already on a
  // host detail route, keep that detail section and swap only the host segment.
  const handleSelectHost = useCallback(
    (serverId: string) => {
      selectSettingsHost(serverId);
      if (view.kind === "project") {
        const target = buildSettingsHostSectionRoute(serverId, "projects");
        if (isCompactLayout) {
          router.push(target);
        } else {
          router.replace(target);
        }
        return;
      }
      if (view.kind !== "host") {
        return;
      }
      const target = buildSettingsHostSectionRoute(serverId, view.section);
      if (isCompactLayout) {
        router.push(target);
      } else {
        router.replace(target);
      }
    },
    [isCompactLayout, router, view],
  );

  const handleSelectHostSection = useCallback(
    (section: HostSectionSlug) => {
      if (!activeHostServerId) {
        handleAddHost();
        return;
      }
      const target = buildSettingsHostSectionRoute(activeHostServerId, section);
      if (isCompactLayout) {
        router.push(target);
      } else {
        router.replace(target);
      }
    },
    [activeHostServerId, handleAddHost, isCompactLayout, router],
  );

  const handleHostRemoved = useCallback(() => {
    if (isCompactLayout) {
      router.replace("/settings");
    } else {
      router.replace(buildSettingsSectionRoute("general"));
    }
  }, [isCompactLayout, router]);

  const handleBackFromDetail = useCallback(() => {
    returnFromSettings(view);
  }, [view]);

  const handleBackToWorkspace = useCallback(() => {
    returnFromSettings({ kind: "root" });
  }, []);

  const pluginDisplayName = usePluginDisplayName(view.kind === "plugin" ? view : null);
  const detailTitle = ((): string | undefined => {
    if (view.kind === "section") {
      const page = SETTINGS_PAGE_BY_ID.get(settingsPageIdFor(view.section));
      return page === undefined ? undefined : t(page.titleKey);
    }
    if (view.kind === "plugin") return pluginDisplayName;
    if (view.kind === "host") return t(HOST_SECTION_TITLES[view.section]);
    if (view.kind === "project") return t("settings.projects");
    return undefined;
  })();

  const content: ReactNode = (() => {
    if (view.kind === "plugin")
      return (
        <PluginSettingsContent
          serverId={view.serverId}
          pluginId={view.pluginId}
          screenId={view.screenId}
          onBackToPlugins={handleBackFromDetail}
          showBackToPlugins={!isCompactLayout}
        />
      );
    if (view.kind === "host") {
      return renderHostSettingsContent(view, handleHostRemoved);
    }
    if (view.kind === "project") {
      return (
        <ProjectSettingsScreen
          serverId={view.serverId}
          projectId={view.projectId}
          onBackToProjects={handleBackFromDetail}
          showBackToProjects={!isCompactLayout}
        />
      );
    }
    if (view.kind === "section") {
      const page = SETTINGS_PAGE_BY_ID.get(settingsPageIdFor(view.section));
      if (
        page === undefined ||
        !isSettingsPageAvailable(page, isDesktopApp, hardwareKeyboardPresent)
      ) {
        return null;
      }
      return <page.Component />;
    }
    return null;
  })();

  // Mobile root: full-screen sidebar-as-list.
  if (isCompactLayout && view.kind === "root") {
    return (
      <View style={styles.container}>
        <BackHeader title={t("settings.title")} onBack={handleBackToWorkspace} />
        <ScrollView style={styles.scrollView} contentContainerStyle={insetBottomStyle}>
          <SettingsSidebar
            onSelectSection={handleSelectSection}
            onSelectHostSection={handleSelectHostSection}
            onSelectHost={handleSelectHost}
            onAddHost={handleAddHost}
            onBackToWorkspace={handleBackToWorkspace}
            activeHostServerId={activeHostServerId}
            layout="mobile"
          />
        </ScrollView>
      </View>
    );
  }

  if (isCompactLayout) {
    return (
      <View style={styles.container}>
        <PageLayout title={detailTitle} onBack={handleBackFromDetail}>
          {content}
        </PageLayout>
      </View>
    );
  }

  // Desktop split view — mirrors AppContainer: sidebar owns the titlebar drag
  // region + traffic-light padding; detail pane renders whatever header the
  // selected section provides.
  return (
    <View style={styles.container}>
      <View style={desktopStyles.row}>
        <WindowChromeRegion corners="top-left">
          <SettingsSidebar
            onSelectSection={handleSelectSection}
            onSelectHostSection={handleSelectHostSection}
            onSelectHost={handleSelectHost}
            onAddHost={handleAddHost}
            onBackToWorkspace={handleBackToWorkspace}
            activeHostServerId={activeHostServerId}
            layout="desktop"
          />
        </WindowChromeRegion>
        <WindowChromeRegion corners="top-right">
          <View style={desktopStyles.contentPane} testID="settings-detail-pane">
            <PageLayout
              title={detailTitle}
              titleTestID="settings-detail-header-title"
              testID="settings-detail-scroll-body"
            >
              {content}
            </PageLayout>
          </View>
        </WindowChromeRegion>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create((theme) => ({
  groupTabs: {
    gap: theme.spacing[4],
  },
  groupTabsBody: {
    gap: theme.spacing[4],
  },
  loadingContainer: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
    alignItems: "center",
    justifyContent: "center",
  },
  loadingText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  scrollView: {
    flex: 1,
  },
  aboutValue: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  aboutVersionMismatch: {
    color: theme.colors.palette.amber[500],
  },
  aboutErrorText: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.sm,
    marginTop: theme.spacing[1],
  },
  aboutCommunity: {
    marginTop: theme.spacing[4],
  },
  aboutUpdateActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  placeholder: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: theme.spacing[8],
  },
  placeholderText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
}));

const desktopStyles = StyleSheet.create({
  row: {
    flex: 1,
    flexDirection: "row",
  },
  contentPane: {
    flex: 1,
    minWidth: SETTINGS_DESKTOP_DETAIL_MIN_WIDTH,
  },
});

const sidebarStyles = StyleSheet.create((theme) => ({
  desktopContainer: {
    width: SETTINGS_DESKTOP_SIDEBAR_WIDTH,
    flexShrink: 1,
    borderRightWidth: 1,
    borderRightColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceSidebar,
  },
  scrollBody: {
    flex: 1,
  },
  sidebarDragArea: {
    position: "relative",
  },
  mobileContainer: {
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
  },
  // Compact values draw each group as an island of tiles; desktop keeps a plain list.
  group: {
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    gap: { xs: theme.spacing[1], md: theme.spacing[0.5] },
  },
  groupLabel: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundExtraMuted,
    paddingHorizontal: { xs: theme.spacing[4], md: theme.spacing[2] },
    paddingVertical: theme.spacing[1],
  },
  island: {
    gap: { xs: 2, md: theme.spacing[0.5] },
    borderRadius: { xs: theme.borderRadius["2xl"], md: 0 },
    overflow: "hidden",
  },
  item: {
    flexDirection: "row",
    alignItems: "center",
    gap: { xs: theme.spacing[3], md: theme.spacing[2] },
    minHeight: { xs: 52, md: density.tightRowHeight.md },
    paddingVertical: theme.spacing[1],
    paddingHorizontal: { xs: theme.spacing[4], md: theme.spacing[2] },
    borderRadius: { xs: 0, md: theme.borderRadius.lg },
    backgroundColor: { xs: theme.colors.surface1, md: "transparent" },
  },
  itemHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  itemSelected: {
    backgroundColor: theme.colors.surfaceSidebarSelected,
  },
  // The workspace rows' pressed fill.
  itemPressed: {
    backgroundColor: theme.colors.surface2,
  },
  // A page's mirrored tabs: indented under its item, a rule down their left.
  subList: {
    marginLeft: theme.spacing[6],
    paddingLeft: theme.spacing[2],
    borderLeftWidth: 1,
    borderLeftColor: theme.colors.border,
    gap: 1,
    marginBottom: theme.spacing[1],
  },
  subItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
  },
  subItemSelected: {
    backgroundColor: theme.colors.surface2,
  },
  subLabel: {
    flex: 1,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  subLabelSelected: {
    color: theme.colors.foreground,
  },
  subCount: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  label: {
    fontSize: { xs: theme.fontSize.lg, md: theme.fontSize.base },
    color: theme.colors.foregroundMuted,
    fontWeight: theme.fontWeight.normal,
    flex: 1,
  },
  // Sits below the window-chrome safe area, so it clears the Electron traffic lights.
  backToWorkspace: {
    alignSelf: "flex-start",
    justifyContent: "flex-start",
    marginHorizontal: theme.spacing[2],
    marginTop: theme.spacing[1],
    userSelect: "none",
  },
  backToWorkspaceLabel: {
    fontSize: theme.fontSize.base,
    color: theme.colors.foregroundMuted,
  },
  searchField: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    height: 36,
    marginHorizontal: theme.spacing[2],
    marginTop: theme.spacing[1],
    marginBottom: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface2,
  },
  searchInput: {
    flex: 1,
    minWidth: 0,
    paddingVertical: 0,
    fontSize: theme.fontSize.base,
  },
  searchClear: {
    width: 20,
    height: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  searchEmpty: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  pickerTrigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: { xs: theme.spacing[3], md: theme.spacing[2] },
    minHeight: { xs: 52, md: density.tightRowHeight.md },
    paddingVertical: theme.spacing[1],
    paddingHorizontal: { xs: theme.spacing[4], md: theme.spacing[2] },
    borderRadius: { xs: 0, md: theme.borderRadius.lg },
    backgroundColor: { xs: theme.colors.surface1, md: "transparent" },
  },
  pickerTriggerHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  pickerTriggerLabel: {
    flex: 1,
    minWidth: 0,
    fontSize: { xs: theme.fontSize.lg, md: theme.fontSize.base },
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.normal,
  },
  footerDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginHorizontal: 10,
  },
  footerDotOn: {
    backgroundColor: theme.colors.success,
  },
  footerDotOff: {
    backgroundColor: theme.colors.foregroundExtraMuted,
  },
  // Match the setting items' icon footprint so the host label aligns with them.
  pickerTriggerDot: {
    width: densityIconBox("md"),
    height: densityIconBox("md"),
    alignItems: "center",
    justifyContent: "center",
  },
}));
