// FILE: SidebarDisplayOptionsMenu.tsx
// Purpose: One surface for the sidebar's display decisions — grouping, sorting, row title
//          source, row fields, trailing slot, and host/project/label filters.
// Layer: Sidebar presentation
// Exports: SidebarDisplayOptionsMenu

import type {
  SidebarGroupBy,
  SidebarProjectSortOrder,
  SidebarRowItems,
  SidebarThreadSortOrder,
  SidebarThreadTrailing,
  SidebarTitleSource,
} from "~/appSettings";
import type { NeolixWorkspaceLabelDefinition } from "@synara/contracts";

import { ComposerPickerMenuPopup } from "./chat/ComposerPickerMenuPopup";
import { SidebarIconButton } from "./SidebarIconButton";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "./ui/menu";
import { FilterIcon, SettingsIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { workspaceLabelColorClass } from "~/lib/workspaceLabels";
import { useTranslation } from "~/i18n";

export type SidebarDisplayHostOption = {
  readonly id: string;
  readonly label: string;
};

export type SidebarDisplayProjectOption = {
  readonly key: string;
  readonly label: string;
};

const ROW_ITEM_KEYS = [
  "branch",
  "project",
  "host",
  "changeRequest",
  "checks",
  "services",
  "labels",
] as const;

const ROW_ITEM_LABEL_KEYS: Record<(typeof ROW_ITEM_KEYS)[number], string> = {
  branch: "workspace:display_rowBranch",
  project: "workspace:display_rowProject",
  host: "workspace:display_rowHost",
  changeRequest: "workspace:display_rowChangeRequest",
  checks: "workspace:display_rowChecks",
  services: "workspace:display_rowServices",
  labels: "workspace:display_rowLabels",
};

const TRAILING_LABEL_KEYS: Record<SidebarThreadTrailing, string> = {
  none: "workspace:display_trailingNone",
  time: "workspace:display_trailingTime",
  diff: "workspace:display_trailingDiff",
};

export function SidebarDisplayOptionsMenu({
  groupBy,
  onGroupByChange,
  threadSortOrder,
  onThreadSortOrderChange,
  threadAttentionFirst,
  onThreadAttentionFirstChange,
  projectSortOrder,
  onProjectSortOrderChange,
  titleSource,
  onTitleSourceChange,
  rowItems,
  onToggleRowItem,
  trailing,
  onTrailingChange,
  labels,
  selectedLabels,
  onToggleLabel,
  onClearLabelFilter,
  onManageLabels,
  hosts,
  hostFilters,
  onToggleHost,
  onClearHostFilters,
  projects,
  projectFilters,
  onToggleProject,
  onClearProjectFilters,
}: {
  groupBy: SidebarGroupBy;
  onGroupByChange: (next: SidebarGroupBy) => void;
  threadSortOrder: SidebarThreadSortOrder;
  onThreadSortOrderChange: (next: SidebarThreadSortOrder) => void;
  threadAttentionFirst: boolean;
  onThreadAttentionFirstChange: (next: boolean) => void;
  projectSortOrder: SidebarProjectSortOrder;
  onProjectSortOrderChange: (next: SidebarProjectSortOrder) => void;
  titleSource: SidebarTitleSource;
  onTitleSourceChange: (next: SidebarTitleSource) => void;
  rowItems: SidebarRowItems;
  onToggleRowItem: (item: keyof SidebarRowItems) => void;
  trailing: SidebarThreadTrailing;
  onTrailingChange: (next: SidebarThreadTrailing) => void;
  labels: ReadonlyArray<NeolixWorkspaceLabelDefinition>;
  selectedLabels: ReadonlyArray<string>;
  onToggleLabel: (name: string) => void;
  onClearLabelFilter: () => void;
  onManageLabels: () => void;
  hosts: ReadonlyArray<SidebarDisplayHostOption>;
  hostFilters: ReadonlyArray<string>;
  onToggleHost: (id: string) => void;
  onClearHostFilters: () => void;
  projects: ReadonlyArray<SidebarDisplayProjectOption>;
  projectFilters: ReadonlyArray<string>;
  onToggleProject: (key: string) => void;
  onClearProjectFilters: () => void;
}) {
  const { t } = useTranslation();
  const selectedLabelNames = new Set(selectedLabels.map((name) => name.toLowerCase()));
  const filtersActive =
    hostFilters.length > 0 || projectFilters.length > 0 || selectedLabels.length > 0;

  return (
    <Menu>
      <SidebarIconButton
        render={<MenuTrigger />}
        icon={FilterIcon}
        label={t("workspace:display_options")}
        tooltip={t("workspace:display_options")}
        tooltipSide="right"
        className={filtersActive ? "text-foreground" : undefined}
      />
      <ComposerPickerMenuPopup align="end" side="bottom" className="w-64">
        {/* The composer popup body clips at the viewport height; this inner scroller
            keeps the tall project/label filters reachable instead of painting them
            outside the menu frame. */}
        <div className="max-h-[min(80vh,38rem)] overflow-y-auto">
          <MenuGroup>
            <MenuGroupLabel>{t("workspace:display_groupBy")}</MenuGroupLabel>
            <MenuRadioGroup
              value={groupBy}
              onValueChange={(value) => onGroupByChange(value as SidebarGroupBy)}
            >
              <MenuRadioItem value="project" className="min-h-7 py-1 text-ui">
                {t("workspace:display_groupProject")}
              </MenuRadioItem>
              <MenuRadioItem value="label" className="min-h-7 py-1 text-ui">
                {t("workspace:display_groupLabel")}
              </MenuRadioItem>
              <MenuRadioItem value="status" className="min-h-7 py-1 text-ui">
                {t("workspace:display_groupStatus")}
              </MenuRadioItem>
            </MenuRadioGroup>
          </MenuGroup>

          {groupBy === "project" ? (
            <>
              <MenuSeparator />
              <MenuGroup>
                <MenuGroupLabel>{t("workspace:display_sortProjects")}</MenuGroupLabel>
                <MenuRadioGroup
                  value={projectSortOrder}
                  onValueChange={(value) =>
                    onProjectSortOrderChange(value as SidebarProjectSortOrder)
                  }
                >
                  <MenuRadioItem value="manual" className="min-h-7 py-1 text-ui">
                    {t("workspace:display_sortManual")}
                  </MenuRadioItem>
                  <MenuRadioItem value="updated_at" className="min-h-7 py-1 text-ui">
                    {t("workspace:display_sortLastPrompt")}
                  </MenuRadioItem>
                  <MenuRadioItem value="created_at" className="min-h-7 py-1 text-ui">
                    {t("workspace:display_sortCreatedAt")}
                  </MenuRadioItem>
                </MenuRadioGroup>
              </MenuGroup>
            </>
          ) : null}

          <MenuSeparator />
          <MenuGroup>
            <MenuGroupLabel>{t("workspace:display_sortThreads")}</MenuGroupLabel>
            <MenuRadioGroup
              value={threadSortOrder}
              onValueChange={(value) => onThreadSortOrderChange(value as SidebarThreadSortOrder)}
            >
              <MenuRadioItem value="updated_at" className="min-h-7 py-1 text-ui">
                {t("workspace:display_sortLastPrompt")}
              </MenuRadioItem>
              <MenuRadioItem value="created_at" className="min-h-7 py-1 text-ui">
                {t("workspace:display_sortCreatedAt")}
              </MenuRadioItem>
              <MenuRadioItem value="manual" className="min-h-7 py-1 text-ui">
                {t("workspace:display_sortManual")}
              </MenuRadioItem>
            </MenuRadioGroup>
            <MenuCheckboxItem
              variant="switch"
              checked={threadAttentionFirst}
              disabled={threadSortOrder !== "updated_at"}
              onCheckedChange={(checked) => onThreadAttentionFirstChange(checked === true)}
              className="min-h-7 py-1 text-ui"
            >
              {t("workspace:workingAndUnreadOnTop")}
            </MenuCheckboxItem>
          </MenuGroup>

          <MenuSeparator />
          <MenuGroup>
            <MenuGroupLabel>{t("workspace:display_titleSource")}</MenuGroupLabel>
            <MenuRadioGroup
              value={titleSource}
              onValueChange={(value) => onTitleSourceChange(value as SidebarTitleSource)}
            >
              <MenuRadioItem value="title" className="min-h-7 py-1 text-ui">
                {t("workspace:display_titleSourceTitle")}
              </MenuRadioItem>
              <MenuRadioItem value="branch" className="min-h-7 py-1 text-ui">
                {t("workspace:display_titleSourceBranch")}
              </MenuRadioItem>
            </MenuRadioGroup>
          </MenuGroup>

          <MenuSeparator />
          <MenuGroup>
            <MenuGroupLabel>{t("workspace:display_rowFields")}</MenuGroupLabel>
            {ROW_ITEM_KEYS.map((item) => (
              <MenuCheckboxItem
                key={item}
                checked={rowItems[item]}
                onCheckedChange={() => onToggleRowItem(item)}
                className="min-h-7 py-1 text-ui"
              >
                {t(ROW_ITEM_LABEL_KEYS[item])}
              </MenuCheckboxItem>
            ))}
          </MenuGroup>

          <MenuSeparator />
          <MenuGroup>
            <MenuGroupLabel>{t("workspace:display_trailing")}</MenuGroupLabel>
            <MenuRadioGroup
              value={trailing}
              onValueChange={(value) => onTrailingChange(value as SidebarThreadTrailing)}
            >
              {(["none", "time", "diff"] as const).map((value) => (
                <MenuRadioItem key={value} value={value} className="min-h-7 py-1 text-ui">
                  {t(TRAILING_LABEL_KEYS[value])}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuGroup>

          {hosts.length > 1 || hostFilters.length > 0 ? (
            <>
              <MenuSeparator />
              <MenuGroup>
                <MenuGroupLabel>{t("workspace:display_hostFilter")}</MenuGroupLabel>
                {hosts.map((host) => (
                  <MenuCheckboxItem
                    key={host.id}
                    checked={hostFilters.includes(host.id)}
                    onCheckedChange={() => onToggleHost(host.id)}
                    className="min-h-7 py-1 text-ui"
                  >
                    <span className="truncate">{host.label}</span>
                  </MenuCheckboxItem>
                ))}
                {hostFilters.length > 0 ? (
                  <MenuItem className="min-h-7 py-1 text-ui" onClick={onClearHostFilters}>
                    {t("workspace:display_filterAllHosts")}
                  </MenuItem>
                ) : null}
              </MenuGroup>
            </>
          ) : null}

          {projects.length > 1 || projectFilters.length > 0 ? (
            <>
              <MenuSeparator />
              <MenuGroup>
                <MenuGroupLabel>{t("workspace:display_projectFilter")}</MenuGroupLabel>
                {projects.map((project) => (
                  <MenuCheckboxItem
                    key={project.key}
                    checked={projectFilters.includes(project.key)}
                    onCheckedChange={() => onToggleProject(project.key)}
                    className="min-h-7 py-1 text-ui"
                  >
                    <span className="truncate">{project.label}</span>
                  </MenuCheckboxItem>
                ))}
                {projectFilters.length > 0 ? (
                  <MenuItem className="min-h-7 py-1 text-ui" onClick={onClearProjectFilters}>
                    {t("workspace:display_filterAllProjects")}
                  </MenuItem>
                ) : null}
              </MenuGroup>
            </>
          ) : null}

          {labels.length > 0 || selectedLabels.length > 0 ? (
            <>
              <MenuSeparator />
              <MenuGroup>
                <MenuGroupLabel>{t("workspace:labels_filter")}</MenuGroupLabel>
                {labels.map((label) => (
                  <MenuCheckboxItem
                    key={label.name}
                    checked={selectedLabelNames.has(label.name.toLowerCase())}
                    onCheckedChange={() => onToggleLabel(label.name)}
                    className="min-h-7 py-1 text-ui"
                  >
                    <span className="flex items-center gap-2">
                      <span
                        aria-hidden
                        className={cn("size-2 rounded-full", workspaceLabelColorClass(label.color))}
                      />
                      <span className="truncate">{label.name}</span>
                    </span>
                  </MenuCheckboxItem>
                ))}
                {selectedLabels.length > 0 ? (
                  <MenuItem className="min-h-7 py-1 text-ui" onClick={onClearLabelFilter}>
                    {t("workspace:labels_clearFilter")}
                  </MenuItem>
                ) : null}
                <MenuItem className="min-h-7 py-1 text-ui" onClick={onManageLabels}>
                  <SettingsIcon className="size-3.5" />
                  {t("workspace:labels_manage")}
                </MenuItem>
              </MenuGroup>
            </>
          ) : null}
        </div>
      </ComposerPickerMenuPopup>
    </Menu>
  );
}
