// FILE: SidebarWorkspaceLabelMenu.tsx
// Purpose: The sidebar's Neox label controls — group threads by project or by label, and
//          narrow the tree to chosen labels. The catalog manager lives one item away.
// Layer: Sidebar presentation
// Exports: SidebarWorkspaceLabelMenu, UNLABELED_LABEL_FILTER

import type { SidebarGroupBy } from "~/appSettings";
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
import { TagIcon, SettingsIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { workspaceLabelColorClass } from "~/lib/workspaceLabels";
import { useTranslation } from "~/i18n";

/** Filter sentinel for threads whose checkout carries no label. */
export const UNLABELED_LABEL_FILTER = "\u0000unlabeled";

export function SidebarWorkspaceLabelMenu({
  labels,
  groupBy,
  onGroupByChange,
  selectedLabels,
  onToggleLabel,
  onClearFilter,
  onManage,
}: {
  labels: ReadonlyArray<NeolixWorkspaceLabelDefinition>;
  groupBy: SidebarGroupBy;
  onGroupByChange: (next: SidebarGroupBy) => void;
  selectedLabels: ReadonlyArray<string>;
  onToggleLabel: (name: string) => void;
  onClearFilter: () => void;
  onManage: () => void;
}) {
  const { t } = useTranslation();
  const selected = new Set(selectedLabels.map((name) => name.toLowerCase()));

  return (
    <Menu>
      <SidebarIconButton
        render={<MenuTrigger />}
        icon={TagIcon}
        label={t("workspace:labels_menuTitle")}
        tooltip={t("workspace:labels_menuTitle")}
        tooltipSide="right"
      />
      <ComposerPickerMenuPopup align="end" side="bottom" className="min-w-52">
        <MenuGroup>
          <MenuGroupLabel>{t("workspace:labels_groupBy")}</MenuGroupLabel>
          <MenuRadioGroup
            value={groupBy}
            onValueChange={(value) => onGroupByChange(value as SidebarGroupBy)}
          >
            <MenuRadioItem value="project" className="min-h-7 py-1 text-ui">
              {t("workspace:labels_groupByProject")}
            </MenuRadioItem>
            <MenuRadioItem value="label" className="min-h-7 py-1 text-ui">
              {t("workspace:labels_groupByLabel")}
            </MenuRadioItem>
          </MenuRadioGroup>
        </MenuGroup>
        <MenuSeparator />
        <MenuGroup>
          <MenuGroupLabel>{t("workspace:labels_filter")}</MenuGroupLabel>
          {labels.map((label) => (
            <MenuCheckboxItem
              key={label.name}
              checked={selected.has(label.name.toLowerCase())}
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
          <MenuCheckboxItem
            checked={selected.has(UNLABELED_LABEL_FILTER)}
            onCheckedChange={() => onToggleLabel(UNLABELED_LABEL_FILTER)}
            className="min-h-7 py-1 text-ui"
          >
            <span className="flex items-center gap-2">
              <span aria-hidden className="size-2 rounded-full border border-muted-foreground/60" />
              <span>{t("workspace:labels_unlabeled")}</span>
            </span>
          </MenuCheckboxItem>
          {selectedLabels.length > 0 ? (
            <MenuItem className="min-h-7 py-1 text-ui" onClick={onClearFilter}>
              {t("workspace:labels_clearFilter")}
            </MenuItem>
          ) : null}
        </MenuGroup>
        <MenuSeparator />
        <MenuItem className="min-h-7 py-1 text-ui" onClick={onManage}>
          <SettingsIcon className="size-3.5" />
          {t("workspace:labels_manage")}
        </MenuItem>
      </ComposerPickerMenuPopup>
    </Menu>
  );
}
