// FILE: SettingsSidebarNav.tsx
// Purpose: Settings section sidebar navigation with central icons and reference-style pill rows.
//          Doubles as a settings search surface: typing swaps the section list for ranked
//          row matches (same behavior as the editor file search), each jumping to its section.
// Layer: UI component
// Exports: SettingsSidebarNav

import { type KeyboardEvent as ReactKeyboardEvent, useState } from "react";

import { CentralIcon } from "~/lib/central-icons";
import { cn } from "~/lib/utils";
import { useBuiltinFeatures } from "~/hooks/useBuiltinFeatures";
import { SearchInput } from "./ui/search-input";
import { SidebarLeadingIcon } from "./SidebarLeadingIcon";
import {
  SETTINGS_PAGE_GROUPS,
  settingsPageForSection,
  settingsPagesWithoutSections,
  type SettingsSectionId,
} from "../settingsNavigation";
import {
  rankSettingsSearchEntries,
  settingsSearchEntryTarget,
  settingsSectionLabel,
  type SettingsSearchContext,
  type SettingsSearchEntry,
} from "../settingsSearchIndex";
import {
  SIDEBAR_ROW_HOVER_CLASS_NAME,
  SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME,
  SIDEBAR_THREAD_ROW_BASE_CLASS_NAME,
} from "../sidebarRowStyles";
import {
  SETTINGS_SIDEBAR_ICON_CLASS_NAME,
  SETTINGS_SIDEBAR_ITEM_CLASS_NAME,
  SETTINGS_SIDEBAR_ITEM_LABEL_CLASS_NAME,
  SETTINGS_SIDEBAR_LIST_GAP_CLASS_NAME,
  SETTINGS_SIDEBAR_ROW_FILL_ACTIVE_CLASS_NAME,
  SETTINGS_SIDEBAR_ROW_FILL_HOVER_CLASS_NAME,
  SETTINGS_SIDEBAR_SECTION_CLASS_NAME,
  SETTINGS_SIDEBAR_SECTION_LABEL_CLASS_NAME,
} from "../settingsSidebarNavStyles";
import { useTranslation } from "~/i18n";

// Cap the result list so a broad query stays a quick scan rather than a wall of rows.
const SETTINGS_SEARCH_RESULTS_LIMIT = 12;

function SettingsSearchResultRow(props: {
  entry: SettingsSearchEntry;
  onSelect: (entry: SettingsSearchEntry) => void;
}) {
  const { t } = useTranslation();
  const { entry, onSelect } = props;
  const icon = settingsPageForSection(entry.section).icon;
  // Mirrors the project header + nested thread layout: the section reuses the nav row
  // (muted icon + label) and the matched setting sits below as an indented thread-style row.
  return (
    <li>
      <button
        type="button"
        className={cn(SETTINGS_SIDEBAR_ITEM_CLASS_NAME, SETTINGS_SIDEBAR_ROW_FILL_HOVER_CLASS_NAME)}
        onClick={() => onSelect(entry)}
      >
        <SidebarLeadingIcon size="sm" tone="text-inherit">
          <CentralIcon name={icon} className={SETTINGS_SIDEBAR_ICON_CLASS_NAME} />
        </SidebarLeadingIcon>
        <span className={SETTINGS_SIDEBAR_ITEM_LABEL_CLASS_NAME}>
          {settingsSectionLabel(entry.section)}
        </span>
      </button>
      <button
        type="button"
        className={cn(
          SIDEBAR_THREAD_ROW_BASE_CLASS_NAME,
          SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME,
          SIDEBAR_ROW_HOVER_CLASS_NAME,
          "flex items-center",
        )}
        onClick={() => onSelect(entry)}
      >
        <span className="min-w-0 truncate">{t(entry.title)}</span>
      </button>
    </li>
  );
}

export function SettingsSidebarNav(props: {
  activeSection: SettingsSectionId;
  onSelectSection: (section: SettingsSectionId, options?: { target?: string }) => void;
  /**
   * Which conditionally-rendered rows exist on this machine, so the search
   * cannot offer a row the panel does not draw. Passed in rather than read here:
   * this component is a pure nav, and the one fact it needs is owned by a
   * surface that already has it.
   */
  searchContext?: SettingsSearchContext | undefined;
}) {
  const { t } = useTranslation();
  const { settingsSections: hiddenSections } = useBuiltinFeatures();
  const pages = settingsPagesWithoutSections(hiddenSections);

  const { onSelectSection } = props;
  const activePage = settingsPageForSection(props.activeSection);
  const [query, setQuery] = useState("");
  const trimmedQuery = query.trim();
  const isSearching = trimmedQuery.length > 0;
  const results = rankSettingsSearchEntries(trimmedQuery, SETTINGS_SEARCH_RESULTS_LIMIT, {
    computerBackendIsVisibleDesktop: props.searchContext?.computerBackendIsVisibleDesktop ?? false,
    hiddenSettingsSections: hiddenSections,
  });

  const handleSelectResult = (entry: SettingsSearchEntry) => {
    const target = settingsSearchEntryTarget(entry);
    onSelectSection(entry.section, target ? { target } : undefined);
    setQuery("");
  };

  const handleSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      const topMatch = results[0];
      if (topMatch) {
        handleSelectResult(topMatch);
      }
      return;
    }
    if (event.key === "Escape" && query.length > 0) {
      event.stopPropagation();
      setQuery("");
    }
  };

  return (
    <div className="px-1.5 py-1.5">
      <div className="mb-3 px-1">
        <SearchInput
          shape="capsule"
          value={query}
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          placeholder={t("settings:settings_searchPlaceholder")}
          aria-label={t("settings:searchSettings")}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={handleSearchKeyDown}
        />
      </div>

      {isSearching ? (
        results.length === 0 ? (
          <p className={SETTINGS_SIDEBAR_SECTION_LABEL_CLASS_NAME}>
            {t("settings:noMatchingSettings")}
          </p>
        ) : (
          <ul
            aria-label={t("settings:settings_searchResults")}
            className={cn("flex flex-col", SETTINGS_SIDEBAR_LIST_GAP_CLASS_NAME)}
          >
            {results.map((entry) => (
              <SettingsSearchResultRow key={entry.id} entry={entry} onSelect={handleSelectResult} />
            ))}
          </ul>
        )
      ) : (
        <nav aria-label={t("settings:settings_sections")} className="flex flex-col">
          {SETTINGS_PAGE_GROUPS.map((group) => {
            const groupPages = pages.filter((page) => page.group === group.id);
            if (groupPages.length === 0) {
              return null;
            }

            return (
              <section
                key={group.id}
                aria-labelledby={`settings-nav-${group.id}`}
                className={SETTINGS_SIDEBAR_SECTION_CLASS_NAME}
              >
                <h2
                  id={`settings-nav-${group.id}`}
                  className={SETTINGS_SIDEBAR_SECTION_LABEL_CLASS_NAME}
                >
                  {t(group.label)}
                </h2>
                <ul className={cn("flex flex-col", SETTINGS_SIDEBAR_LIST_GAP_CLASS_NAME)}>
                  {groupPages.map((page) => {
                    const isActive = page.id === activePage.id;
                    return (
                      <li key={page.id}>
                        <button
                          type="button"
                          aria-current={isActive ? "page" : undefined}
                          className={cn(
                            SETTINGS_SIDEBAR_ITEM_CLASS_NAME,
                            isActive
                              ? SETTINGS_SIDEBAR_ROW_FILL_ACTIVE_CLASS_NAME
                              : SETTINGS_SIDEBAR_ROW_FILL_HOVER_CLASS_NAME,
                          )}
                          onClick={() => {
                            if (!isActive) props.onSelectSection(page.tabs[0]!.section);
                          }}
                        >
                          <SidebarLeadingIcon size="sm" tone="text-inherit">
                            <CentralIcon
                              name={page.icon}
                              className={SETTINGS_SIDEBAR_ICON_CLASS_NAME}
                            />
                          </SidebarLeadingIcon>
                          <span className={SETTINGS_SIDEBAR_ITEM_LABEL_CLASS_NAME}>
                            {t(page.label)}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}
        </nav>
      )}
    </div>
  );
}
