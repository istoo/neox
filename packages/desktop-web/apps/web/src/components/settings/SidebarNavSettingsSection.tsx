// FILE: SidebarNavSettingsSection.tsx
// Purpose: Settings › Appearance › Sidebar navigation. One card per section,
//   listing every entry in display order with a visibility switch and move
//   controls, matching the native app's sidebar customizer.
// Layer: Settings UI component

import type { ComponentType } from "react";

import { useTranslation } from "~/i18n";
import {
  builtinSidebarNavLabelKey,
  canMoveSidebarNavItem,
  type SidebarNavItem,
  type SidebarNavSection,
} from "~/lib/sidebarNav.model";
import { useSidebarNavItems } from "~/hooks/useSidebarNavItems";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  HistoryIcon,
  NewThreadIcon,
  UsageGaugeIcon,
} from "~/lib/icons";
import { PluginGlyph } from "~/plugins/PluginGlyph";
import { Button } from "~/components/ui/button";
import { Switch } from "~/components/ui/switch";
import { SettingsListRow, SettingsSection } from "./SettingsPanelPrimitives";

const BUILTIN_ICONS: Record<string, ComponentType<{ className?: string }>> = {
  "new-thread": NewThreadIcon,
  history: HistoryIcon,
  usage: UsageGaugeIcon,
};

const SECTION_COPY = {
  header: { title: "settings:sidebarNav_header", description: "settings:sidebarNav_headerHint" },
  footer: { title: "settings:sidebarNav_footer", description: "settings:sidebarNav_footerHint" },
} as const satisfies Record<SidebarNavSection, { title: string; description: string }>;

function itemLabel(t: ReturnType<typeof useTranslation>["t"], item: SidebarNavItem): string {
  return item.kind === "builtin"
    ? t(builtinSidebarNavLabelKey(item.id))
    : item.entry.contribution.title;
}

function itemIcon(item: SidebarNavItem) {
  if (item.kind === "builtin") {
    const Icon = BUILTIN_ICONS[item.id] ?? UsageGaugeIcon;
    return <Icon className="size-4" />;
  }
  return <PluginGlyph name={item.entry.contribution.icon} className="size-4" />;
}

function SidebarNavItemsCard({ section }: { section: SidebarNavSection }) {
  const { t } = useTranslation();
  const { items, setVisible, move } = useSidebarNavItems(section);
  const copy = SECTION_COPY[section];

  return (
    <SettingsSection title={copy.title}>
      {items.length === 0 ? (
        <SettingsListRow title={t(copy.description)} />
      ) : (
        items.map((item) => {
          const canMoveUp = canMoveSidebarNavItem({ items, key: item.key, direction: "up" });
          const canMoveDown = canMoveSidebarNavItem({ items, key: item.key, direction: "down" });
          const label = itemLabel(t, item);
          return (
            <SettingsListRow
              key={item.key}
              title={label}
              leading={itemIcon(item)}
              actions={
                <>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t("settings:sidebarNav_moveUp", { item: label })}
                    disabled={!canMoveUp}
                    onClick={() => move(item.key, "up")}
                  >
                    <ArrowUpIcon className="size-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t("settings:sidebarNav_moveDown", { item: label })}
                    disabled={!canMoveDown}
                    onClick={() => move(item.key, "down")}
                  >
                    <ArrowDownIcon className="size-3.5" />
                  </Button>
                  <Switch
                    checked={item.visible}
                    onCheckedChange={(checked) => setVisible(item.key, Boolean(checked))}
                    aria-label={label}
                  />
                </>
              }
            />
          );
        })
      )}
    </SettingsSection>
  );
}

/** Settings › Sidebar: header rows, then the footer's orderable rows. */
export function SidebarNavSettingsSection() {
  return (
    <>
      <SidebarNavItemsCard section="header" />
      <SidebarNavItemsCard section="footer" />
    </>
  );
}
