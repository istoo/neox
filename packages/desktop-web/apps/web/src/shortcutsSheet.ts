// FILE: shortcutsSheet.ts
// Purpose: Build the shortcut reference sections shown by the keyboard shortcuts sheet, and list
//          the commands the Settings shortcut editor can bind.
// Layer: UI helper
// Depends on: keybinding label resolution, project script command mapping, and platform helpers.

import {
  SPACE_JUMP_KEYBINDING_COMMANDS,
  STATIC_KEYBINDING_COMMANDS,
  THREAD_JUMP_KEYBINDING_COMMANDS,
  type KeybindingCommand,
  type ResolvedKeybindingRule,
  type ResolvedKeybindingsConfig,
} from "@synara/contracts";
import { NATIVE_EDITOR_ON } from "./betaFeatures";
import { t } from "./i18n";
import { isMacPlatform } from "./lib/utils";
import { formatShortcutLabel, resolveKeybindingForCommand } from "./keybindings";
import { commandForProjectScript } from "./projectScripts";
import type { ProjectScript } from "./types";

export interface ShortcutSheetContext {
  terminalFocus: boolean;
  terminalOpen: boolean;
  terminalWorkspaceOpen: boolean;
  [key: string]: boolean;
}

export interface ShortcutSheetEntry {
  id: string;
  command: KeybindingCommand | null;
  binding: ResolvedKeybindingRule | null;
  label: string;
  description: string;
  shortcutLabel: string;
}

export interface ShortcutSheetSection {
  id: string;
  title: string;
  description: string;
  tone?: "default" | "muted";
  entries: ShortcutSheetEntry[];
}

interface BuildShortcutSheetSectionsOptions {
  keybindings: ResolvedKeybindingsConfig;
  projectScripts: ReadonlyArray<ProjectScript>;
  platform: string;
  context: ShortcutSheetContext;
}

interface ShortcutDefinition {
  command: KeybindingCommand | readonly KeybindingCommand[];
  labelKey: string;
  labelValues?: Record<string, unknown> | undefined;
  descriptionKey: string;
  descriptionValues?: Record<string, unknown> | undefined;
}

function definitionLabel(definition: ShortcutDefinition): string {
  return t(definition.labelKey, definition.labelValues);
}

function definitionDescription(definition: ShortcutDefinition): string {
  return t(definition.descriptionKey, definition.descriptionValues);
}

const EFFORT_CYCLE_DEFINITION: ShortcutDefinition = {
  command: "model.effort.next",
  labelKey: "shortcuts:modelEffortNextLabel",
  descriptionKey: "shortcuts:modelEffortNextDescription",
};

// Space jumps address the switcher's visual tab order, so slot 1 is always Void.
const SPACE_JUMP_DEFINITIONS: readonly ShortcutDefinition[] = Array.from(
  { length: 9 },
  (_, index) => ({
    command: `space.jump.${index + 1}` as KeybindingCommand,
    labelKey: index === 0 ? "shortcuts:spaceJumpVoidLabel" : "shortcuts:spaceJumpLabel",
    labelValues: index === 0 ? undefined : { index: index + 1 },
    descriptionKey:
      index === 0 ? "shortcuts:spaceJumpVoidDescription" : "shortcuts:spaceJumpDescription",
  }),
);

const AVAILABLE_NOW_DEFINITIONS: readonly ShortcutDefinition[] = [
  {
    command: "sidebar.addProject",
    labelKey: "shortcuts:sidebarAddProjectLabel",
    descriptionKey: "shortcuts:sidebarAddProjectDescription",
  },
  {
    command: "sidebar.search",
    labelKey: "shortcuts:sidebarSearchLabel",
    descriptionKey: "shortcuts:sidebarSearchDescription",
  },
  {
    command: "sidebar.activity",
    labelKey: "shortcuts:sidebarActivityLabel",
    descriptionKey: "shortcuts:sidebarActivityDescription",
  },
  {
    command: "sidebar.importThread",
    labelKey: "shortcuts:sidebarImportThreadLabel",
    descriptionKey: "shortcuts:sidebarImportThreadDescription",
  },
  {
    command: "space.previous",
    labelKey: "shortcuts:spacePreviousLabel",
    descriptionKey: "shortcuts:spacePreviousDescription",
  },
  {
    command: "space.next",
    labelKey: "shortcuts:spaceNextLabel",
    descriptionKey: "shortcuts:spaceNextDescription",
  },
  ...SPACE_JUMP_DEFINITIONS,
  {
    command: "chat.new",
    labelKey: "shortcuts:chatNewLabel",
    descriptionKey: "shortcuts:chatNewDescription",
  },
  {
    command: "chat.newLatestProject",
    labelKey: "shortcuts:chatNewLatestProjectLabel",
    descriptionKey: "shortcuts:chatNewLatestProjectDescription",
  },
  {
    command: ["chat.newChat", "chat.newLocal"],
    labelKey: "shortcuts:chatNewChatLabel",
    descriptionKey: "shortcuts:chatNewChatDescription",
  },
  {
    command: "chat.newTerminal",
    labelKey: "shortcuts:chatNewTerminalLabel",
    descriptionKey: "shortcuts:chatNewTerminalDescription",
  },
  {
    command: "chat.newClaude",
    labelKey: "shortcuts:chatNewClaudeLabel",
    descriptionKey: "shortcuts:chatNewClaudeDescription",
  },
  {
    command: "chat.newCodex",
    labelKey: "shortcuts:chatNewCodexLabel",
    descriptionKey: "shortcuts:chatNewCodexDescription",
  },
  {
    command: "chat.newCursor",
    labelKey: "shortcuts:chatNewCursorLabel",
    descriptionKey: "shortcuts:chatNewCursorDescription",
  },
  {
    command: "chat.split",
    labelKey: "shortcuts:chatSplitLabel",
    descriptionKey: "shortcuts:chatSplitDescription",
  },
  {
    command: "pane.splitDown",
    labelKey: "shortcuts:paneSplitDownLabel",
    descriptionKey: "shortcuts:paneSplitDownDescription",
  },
  {
    command: "pane.splitLeft",
    labelKey: "shortcuts:paneSplitLeftLabel",
    descriptionKey: "shortcuts:paneSplitLeftDescription",
  },
  {
    command: "pane.splitRight",
    labelKey: "shortcuts:paneSplitRightLabel",
    descriptionKey: "shortcuts:paneSplitRightDescription",
  },
  {
    command: "pane.splitUp",
    labelKey: "shortcuts:paneSplitUpLabel",
    descriptionKey: "shortcuts:paneSplitUpDescription",
  },
  {
    command: "pane.focusLeft",
    labelKey: "shortcuts:paneFocusLeftLabel",
    descriptionKey: "shortcuts:paneFocusLeftDescription",
  },
  {
    command: "pane.focusRight",
    labelKey: "shortcuts:paneFocusRightLabel",
    descriptionKey: "shortcuts:paneFocusRightDescription",
  },
  {
    command: "pane.focusUp",
    labelKey: "shortcuts:paneFocusUpLabel",
    descriptionKey: "shortcuts:paneFocusUpDescription",
  },
  {
    command: "pane.focusDown",
    labelKey: "shortcuts:paneFocusDownLabel",
    descriptionKey: "shortcuts:paneFocusDownDescription",
  },
  {
    command: "pane.moveLeft",
    labelKey: "shortcuts:paneMoveLeftLabel",
    descriptionKey: "shortcuts:paneMoveLeftDescription",
  },
  {
    command: "pane.moveRight",
    labelKey: "shortcuts:paneMoveRightLabel",
    descriptionKey: "shortcuts:paneMoveRightDescription",
  },
  {
    command: "pane.moveUp",
    labelKey: "shortcuts:paneMoveUpLabel",
    descriptionKey: "shortcuts:paneMoveUpDescription",
  },
  {
    command: "pane.moveDown",
    labelKey: "shortcuts:paneMoveDownLabel",
    descriptionKey: "shortcuts:paneMoveDownDescription",
  },
  {
    command: "pane.maximize",
    labelKey: "shortcuts:paneMaximizeLabel",
    descriptionKey: "shortcuts:paneMaximizeDescription",
  },
  {
    command: "pane.close",
    labelKey: "shortcuts:paneCloseLabel",
    descriptionKey: "shortcuts:paneCloseDescription",
  },
  {
    command: "view.focusMode.toggle",
    labelKey: "shortcuts:viewFocusModeToggleLabel",
    descriptionKey: "shortcuts:viewFocusModeToggleDescription",
  },
  {
    command: "theme.cycle",
    labelKey: "shortcuts:themeCycleLabel",
    descriptionKey: "shortcuts:themeCycleDescription",
  },
  {
    command: "sidebar.toggleRight",
    labelKey: "shortcuts:sidebarToggleRightLabel",
    descriptionKey: "shortcuts:sidebarToggleRightDescription",
  },
  {
    command: "view.recent.previous",
    labelKey: "shortcuts:viewRecentPreviousLabel",
    descriptionKey: "shortcuts:viewRecentPreviousDescription",
  },
  {
    command: "view.recent.next",
    labelKey: "shortcuts:viewRecentNextLabel",
    descriptionKey: "shortcuts:viewRecentNextDescription",
  },
  {
    command: "modelPicker.toggle",
    labelKey: "shortcuts:modelPickerToggleLabel",
    descriptionKey: "shortcuts:modelPickerToggleDescription",
  },
  {
    command: "model.next",
    labelKey: "shortcuts:modelNextLabel",
    descriptionKey: "shortcuts:modelNextDescription",
  },
  {
    command: "model.previous",
    labelKey: "shortcuts:modelPreviousLabel",
    descriptionKey: "shortcuts:modelPreviousDescription",
  },
  EFFORT_CYCLE_DEFINITION,
  {
    command: "traitsPicker.toggle",
    labelKey: "shortcuts:traitsPickerToggleLabel",
    descriptionKey: "shortcuts:traitsPickerToggleDescription",
  },
  {
    command: "settings.usage",
    labelKey: "shortcuts:settingsUsageLabel",
    descriptionKey: "shortcuts:settingsUsageDescription",
  },
  {
    command: "composer.focus.toggle",
    labelKey: "shortcuts:composerFocusToggleLabel",
    descriptionKey: "shortcuts:composerFocusToggleDescription",
  },
  {
    command: "chat.find",
    labelKey: "shortcuts:chatFindLabel",
    descriptionKey: "shortcuts:chatFindDescription",
  },
  {
    command: "search.files",
    labelKey: "shortcuts:searchFilesLabel",
    descriptionKey: "shortcuts:searchFilesDescription",
  },
  {
    command: "search.content",
    labelKey: "shortcuts:searchContentLabel",
    descriptionKey: "shortcuts:searchContentDescription",
  },
  {
    command: "terminal.toggle",
    labelKey: "shortcuts:terminalToggleLabel",
    descriptionKey: "shortcuts:terminalToggleDescription",
  },
  {
    command: "terminal.new",
    labelKey: "shortcuts:terminalNewLabel",
    descriptionKey: "shortcuts:terminalNewDescription",
  },
  {
    command: "terminal.close",
    labelKey: "shortcuts:terminalCloseLabel",
    descriptionKey: "shortcuts:terminalCloseDescription",
  },
  {
    command: "diff.toggle",
    labelKey: "shortcuts:diffToggleLabel",
    descriptionKey: "shortcuts:diffToggleDescription",
  },
  {
    command: "diff.change.next",
    labelKey: "shortcuts:diffChangeNextLabel",
    descriptionKey: "shortcuts:diffChangeNextDescription",
  },
  {
    command: "diff.change.previous",
    labelKey: "shortcuts:diffChangePreviousLabel",
    descriptionKey: "shortcuts:diffChangePreviousDescription",
  },
  {
    command: "sidechat.toggle",
    labelKey: "shortcuts:sidechatToggleLabel",
    descriptionKey: "shortcuts:sidechatToggleDescription",
  },
  {
    command: "browser.toggle",
    labelKey: "shortcuts:browserToggleLabel",
    descriptionKey: "shortcuts:browserToggleDescription",
  },
  {
    command: "device.toggle",
    labelKey: "shortcuts:deviceToggleLabel",
    descriptionKey: "shortcuts:deviceToggleDescription",
  },
  {
    command: "thread.copyId",
    labelKey: "shortcuts:threadCopyIdLabel",
    descriptionKey: "shortcuts:threadCopyIdDescription",
  },
  {
    command: "thread.archive",
    labelKey: "shortcuts:threadArchiveLabel",
    descriptionKey: "shortcuts:threadArchiveDescription",
  },
  {
    command: "thread.snooze",
    labelKey: "shortcuts:threadSnoozeLabel",
    descriptionKey: "shortcuts:threadSnoozeDescription",
  },
  {
    command: "thread.markUnread",
    labelKey: "shortcuts:threadMarkUnreadLabel",
    descriptionKey: "shortcuts:threadMarkUnreadDescription",
  },
  {
    command: "chat.visible.previous",
    labelKey: "shortcuts:chatVisiblePreviousLabel",
    descriptionKey: "shortcuts:chatVisiblePreviousDescription",
  },
  {
    command: "chat.visible.next",
    labelKey: "shortcuts:chatVisibleNextLabel",
    descriptionKey: "shortcuts:chatVisibleNextDescription",
  },
  {
    command: "chat.attention.next",
    labelKey: "shortcuts:chatAttentionNextLabel",
    descriptionKey: "shortcuts:chatAttentionNextDescription",
  },
  {
    command: "threadTab.previous",
    labelKey: "shortcuts:threadTabPreviousLabel",
    descriptionKey: "shortcuts:threadTabPreviousDescription",
  },
  {
    command: "threadTab.next",
    labelKey: "shortcuts:threadTabNextLabel",
    descriptionKey: "shortcuts:threadTabNextDescription",
  },
  {
    command: "threadTab.close",
    labelKey: "shortcuts:threadTabCloseLabel",
    descriptionKey: "shortcuts:threadTabCloseDescription",
  },
  {
    command: "editor.openFavorite",
    labelKey: "shortcuts:editorOpenFavoriteLabel",
    descriptionKey: "shortcuts:editorOpenFavoriteDescription",
  },
  {
    command: "editor.file.save",
    labelKey: "shortcuts:editorFileSaveLabel",
    descriptionKey: "shortcuts:editorFileSaveDescription",
  },
  {
    command: "git.commitAndPush",
    labelKey: "shortcuts:gitCommitAndPushLabel",
    descriptionKey: "shortcuts:gitCommitAndPushDescription",
  },
] as const;

const THREAD_JUMP_DEFINITIONS: readonly ShortcutDefinition[] = Array.from(
  { length: 9 },
  (_, index) => ({
    command: `thread.jump.${index + 1}` as KeybindingCommand,
    labelKey: "shortcuts:threadJumpLabel",
    labelValues: { index: index + 1 },
    descriptionKey: "shortcuts:threadJumpDescription",
  }),
);

const WORKSPACE_DEFINITIONS: readonly ShortcutDefinition[] = [
  {
    command: "terminal.workspace.newFullWidth",
    labelKey: "shortcuts:terminalWorkspaceNewFullWidthLabel",
    descriptionKey: "shortcuts:terminalWorkspaceNewFullWidthDescription",
  },
  {
    command: "terminal.workspace.terminal",
    labelKey: "shortcuts:terminalWorkspaceTerminalLabel",
    descriptionKey: "shortcuts:terminalWorkspaceTerminalDescription",
  },
  {
    command: "terminal.workspace.chat",
    labelKey: "shortcuts:terminalWorkspaceChatLabel",
    descriptionKey: "shortcuts:terminalWorkspaceChatDescription",
  },
  {
    command: "terminal.workspace.closeActive",
    labelKey: "shortcuts:terminalWorkspaceCloseActiveLabel",
    descriptionKey: "shortcuts:terminalWorkspaceCloseActiveDescription",
  },
] as const;

// Run by the in-app code editor while it has focus; listed in their own sheet section.
const CODE_EDITOR_DEFINITIONS: readonly ShortcutDefinition[] = [
  {
    command: "editor.commands",
    labelKey: "shortcuts:editorCommandsLabel",
    descriptionKey: "shortcuts:editorCommandsDescription",
  },
  {
    command: "editor.rename",
    labelKey: "shortcuts:editorRenameLabel",
    descriptionKey: "shortcuts:editorRenameDescription",
  },
  {
    command: "editor.goToDefinition",
    labelKey: "shortcuts:editorGoToDefinitionLabel",
    descriptionKey: "shortcuts:editorGoToDefinitionDescription",
  },
  {
    command: "editor.findReferences",
    labelKey: "shortcuts:editorFindReferencesLabel",
    descriptionKey: "shortcuts:editorFindReferencesDescription",
  },
  {
    command: "editor.goToSymbol",
    labelKey: "shortcuts:editorGoToSymbolLabel",
    descriptionKey: "shortcuts:editorGoToSymbolDescription",
  },
  {
    command: "editor.goToLine",
    labelKey: "shortcuts:editorGoToLineLabel",
    descriptionKey: "shortcuts:editorGoToLineDescription",
  },
  {
    command: "editor.problems",
    labelKey: "shortcuts:editorProblemsLabel",
    descriptionKey: "shortcuts:editorProblemsDescription",
  },
  {
    command: "editor.quickFix",
    labelKey: "shortcuts:editorQuickFixLabel",
    descriptionKey: "shortcuts:editorQuickFixDescription",
  },
  {
    command: "editor.debug.start",
    labelKey: "shortcuts:editorDebugStartLabel",
    descriptionKey: "shortcuts:editorDebugStartDescription",
  },
  {
    command: "editor.debug.stop",
    labelKey: "shortcuts:editorDebugStopLabel",
    descriptionKey: "shortcuts:editorDebugStopDescription",
  },
  {
    command: "editor.debug.toggleBreakpoint",
    labelKey: "shortcuts:editorDebugToggleBreakpointLabel",
    descriptionKey: "shortcuts:editorDebugToggleBreakpointDescription",
  },
  {
    command: "editor.debug.stepOver",
    labelKey: "shortcuts:editorDebugStepOverLabel",
    descriptionKey: "shortcuts:editorDebugStepOverDescription",
  },
  {
    command: "editor.debug.stepInto",
    labelKey: "shortcuts:editorDebugStepIntoLabel",
    descriptionKey: "shortcuts:editorDebugStepIntoDescription",
  },
  {
    command: "editor.debug.stepOut",
    labelKey: "shortcuts:editorDebugStepOutLabel",
    descriptionKey: "shortcuts:editorDebugStepOutDescription",
  },
] as const;

const SIDEBAR_TOGGLE_DEFINITION: ShortcutDefinition = {
  command: "sidebar.toggle",
  labelKey: "shortcuts:sidebarToggleLabel",
  descriptionKey: "shortcuts:sidebarToggleDescription",
};

export interface ShortcutEditorDefinition {
  id: string;
  label: string;
  description: string;
  /**
   * Commands the row edits together: one, the aliases of one action, or the nine
   * members of a numbered family in key order.
   */
  commands: readonly KeybindingCommand[];
  /** Set for a numbered family; one single-command definition per number key. */
  members?: readonly ShortcutEditorDefinition[];
}

function singleCommandEditorDefinitions(
  definitions: ReadonlyArray<ShortcutDefinition>,
): ShortcutEditorDefinition[] {
  return definitions.map((definition) => {
    const commands = Array.isArray(definition.command) ? definition.command : [definition.command];
    return {
      id: commands[0] ?? definition.labelKey,
      label: definitionLabel(definition),
      description: definitionDescription(definition),
      commands,
    };
  });
}

/**
 * Every built-in command in the order Settings → Keybindings lists it, bound or not.
 * The two 1–9 families come back as one definition each so the editor can show and
 * rebind them as a single shortcut.
 */
export function listShortcutEditorDefinitions(): ShortcutEditorDefinition[] {
  const spaceJumpCommands = new Set<KeybindingCommand>(SPACE_JUMP_KEYBINDING_COMMANDS);
  const definitions: ShortcutEditorDefinition[] = [
    ...singleCommandEditorDefinitions([SIDEBAR_TOGGLE_DEFINITION]),
    ...singleCommandEditorDefinitions(
      AVAILABLE_NOW_DEFINITIONS.filter(
        (definition) =>
          Array.isArray(definition.command) ||
          !spaceJumpCommands.has(definition.command as KeybindingCommand),
      ),
    ),
    ...(NATIVE_EDITOR_ON ? singleCommandEditorDefinitions(CODE_EDITOR_DEFINITIONS) : []),
    ...singleCommandEditorDefinitions(WORKSPACE_DEFINITIONS),
    {
      id: "thread.jump",
      label: t("shortcuts:threadJumpFamilyLabel"),
      description: t("shortcuts:threadJumpDescription"),
      commands: THREAD_JUMP_KEYBINDING_COMMANDS,
      members: singleCommandEditorDefinitions(THREAD_JUMP_DEFINITIONS),
    },
    {
      id: "space.jump",
      label: t("shortcuts:spaceJumpFamilyLabel"),
      description: t("shortcuts:spaceJumpFamilyDescription"),
      commands: SPACE_JUMP_KEYBINDING_COMMANDS,
      members: singleCommandEditorDefinitions(SPACE_JUMP_DEFINITIONS),
    },
  ];

  const covered = new Set(definitions.flatMap((definition) => definition.commands));
  // Keep editor commands aligned with the editing engine available on this host.
  const hidden = new Set(
    NATIVE_EDITOR_ON
      ? []
      : singleCommandEditorDefinitions(CODE_EDITOR_DEFINITIONS).flatMap((d) => d.commands),
  );
  for (const command of STATIC_KEYBINDING_COMMANDS) {
    if (covered.has(command) || hidden.has(command) || command.startsWith("terminal.split")) {
      continue;
    }
    definitions.push({
      id: command,
      label: command,
      description: t("shortcuts:genericCommandDescription"),
      commands: [command],
    });
  }
  return definitions;
}

function modSlashLabel(platform: string): string {
  return isMacPlatform(platform) ? "⌘/" : "Ctrl+/";
}

/** Human-readable sheet label for a keybinding command, e.g. `chat.new` → "New thread". */
export function shortcutSheetCommandLabel(command: KeybindingCommand): string | null {
  for (const definitions of [
    [SIDEBAR_TOGGLE_DEFINITION],
    AVAILABLE_NOW_DEFINITIONS,
    CODE_EDITOR_DEFINITIONS,
    WORKSPACE_DEFINITIONS,
    THREAD_JUMP_DEFINITIONS,
  ]) {
    for (const definition of definitions) {
      const commands = Array.isArray(definition.command)
        ? definition.command
        : [definition.command];
      if (commands.includes(command)) return definitionLabel(definition);
    }
  }
  return null;
}

function definitionToEntry(
  definition: ShortcutDefinition,
  keybindings: ResolvedKeybindingsConfig,
  platform: string,
  context: ShortcutSheetContext,
): ShortcutSheetEntry | null {
  const commands = Array.isArray(definition.command) ? definition.command : [definition.command];
  const binding = commands.reduce<ResolvedKeybindingRule | null>(
    (resolved, command) =>
      resolved ?? resolveKeybindingForCommand(keybindings, command, { platform, context }),
    null,
  );
  if (!binding) return null;
  return {
    id: binding.command,
    command: binding.command,
    binding,
    label: definitionLabel(definition),
    description: definitionDescription(definition),
    shortcutLabel: formatShortcutLabel(binding.shortcut, platform),
  };
}

function definitionsToEntries(
  definitions: ReadonlyArray<ShortcutDefinition>,
  keybindings: ResolvedKeybindingsConfig,
  platform: string,
  context: ShortcutSheetContext,
): ShortcutSheetEntry[] {
  return definitions
    .map((definition) => definitionToEntry(definition, keybindings, platform, context))
    .filter((entry): entry is ShortcutSheetEntry => entry !== null);
}

export function buildShortcutSheetSections(
  options: BuildShortcutSheetSectionsOptions,
): ShortcutSheetSection[] {
  const sections: ShortcutSheetSection[] = [];

  const currentEntries: ShortcutSheetEntry[] = [
    {
      id: "shortcuts.show",
      command: null,
      binding: null,
      label: t("shortcuts:showKeybindingsLabel"),
      description: t("shortcuts:showKeybindingsDescription"),
      shortcutLabel: modSlashLabel(options.platform),
    },
    ...definitionsToEntries(
      AVAILABLE_NOW_DEFINITIONS,
      options.keybindings,
      options.platform,
      options.context,
    ),
  ];

  const sidebarToggle = definitionToEntry(
    SIDEBAR_TOGGLE_DEFINITION,
    options.keybindings,
    options.platform,
    options.context,
  );
  if (sidebarToggle) {
    currentEntries.splice(1, 0, sidebarToggle);
  }

  const currentNavigationEntries = options.context.terminalWorkspaceOpen
    ? definitionsToEntries(
        WORKSPACE_DEFINITIONS,
        options.keybindings,
        options.platform,
        options.context,
      )
    : definitionsToEntries(
        THREAD_JUMP_DEFINITIONS,
        options.keybindings,
        options.platform,
        options.context,
      );

  sections.push({
    id: "available-now",
    title: t("shortcuts:sectionAvailableNowTitle"),
    description: options.context.terminalWorkspaceOpen
      ? t("shortcuts:sectionAvailableNowActiveDescription")
      : t("shortcuts:sectionAvailableNowChatDescription"),
    entries: [...currentEntries, ...currentNavigationEntries],
  });

  const alternateContext: ShortcutSheetContext = options.context.terminalWorkspaceOpen
    ? { ...options.context, terminalWorkspaceOpen: false }
    : {
        ...options.context,
        terminalOpen: true,
        terminalWorkspaceOpen: true,
      };
  const alternateDefinitions = options.context.terminalWorkspaceOpen
    ? THREAD_JUMP_DEFINITIONS
    : WORKSPACE_DEFINITIONS;
  const alternateEntries = definitionsToEntries(
    alternateDefinitions,
    options.keybindings,
    options.platform,
    alternateContext,
  );
  if (alternateEntries.length > 0) {
    sections.push({
      id: "alternate-context",
      title: options.context.terminalWorkspaceOpen
        ? t("shortcuts:sectionAlternateOutsideTitle")
        : t("shortcuts:sectionAlternateInWorkspaceTitle"),
      description: options.context.terminalWorkspaceOpen
        ? t("shortcuts:sectionAlternateOutsideDescription")
        : t("shortcuts:sectionAlternateInWorkspaceDescription"),
      tone: "muted",
      entries: alternateEntries,
    });
  }

  const projectScriptEntries = options.projectScripts
    .map<ShortcutSheetEntry | null>((script) => {
      const command = commandForProjectScript(script.id);
      const binding = resolveKeybindingForCommand(options.keybindings, command, {
        platform: options.platform,
      });
      if (!binding) return null;
      return {
        id: script.id,
        command,
        binding,
        label: script.runOnWorktreeCreate
          ? t("shortcuts:projectScriptSetupLabel", { name: script.name })
          : script.name,
        description: script.runOnWorktreeCreate
          ? t("shortcuts:projectScriptSetupDescription")
          : t("shortcuts:projectScriptRunDescription"),
        shortcutLabel: formatShortcutLabel(binding.shortcut, options.platform),
      };
    })
    .filter((entry): entry is ShortcutSheetEntry => entry !== null);

  if (projectScriptEntries.length > 0) {
    sections.push({
      id: "project-scripts",
      title: t("shortcuts:sectionProjectScriptsTitle"),
      description: t("shortcuts:sectionProjectScriptsDescription"),
      entries: projectScriptEntries,
    });
  }

  // The editor runs these only while it has focus, which the terminal then does not.
  // Stable edits with the Pierre engine, which has none of these commands.
  const codeEditorEntries = definitionsToEntries(
    NATIVE_EDITOR_ON ? CODE_EDITOR_DEFINITIONS : [],
    options.keybindings,
    options.platform,
    { ...options.context, terminalFocus: false },
  );
  if (codeEditorEntries.length > 0) {
    sections.push({
      id: "code-editor",
      title: t("shortcuts:sectionCodeEditorTitle"),
      description: t("shortcuts:sectionCodeEditorDescription"),
      tone: "muted",
      entries: codeEditorEntries,
    });
  }

  if (!currentEntries.some((entry) => entry.command === EFFORT_CYCLE_DEFINITION.command)) {
    const composerEntries = definitionsToEntries(
      [EFFORT_CYCLE_DEFINITION],
      options.keybindings,
      options.platform,
      { ...options.context, composerFocus: true, terminalFocus: false },
    );
    if (composerEntries.length > 0) {
      sections.push({
        id: "composer-context",
        title: t("shortcuts:sectionComposerTitle"),
        description: t("shortcuts:sectionComposerDescription"),
        tone: "muted",
        entries: composerEntries,
      });
    }
  }

  return sections;
}

// Match a single entry against a free-text query on the human-readable label, the
// description, and the rendered shortcut label, so a user can search by action name
// ("terminal"), intent ("split"), or even the key combo itself ("⌘N" / "ctrl+n").
function shortcutSheetEntryMatchesQuery(entry: ShortcutSheetEntry, needle: string): boolean {
  return (
    entry.label.toLowerCase().includes(needle) ||
    entry.description.toLowerCase().includes(needle) ||
    entry.shortcutLabel.toLowerCase().includes(needle)
  );
}

// Filter each section's entries against a free-text query, dropping sections that end up
// empty. Shared by the keyboard-shortcuts dialog (Mod+/) and the settings reference panel
// so the two surfaces search identically.
export function filterShortcutSheetSections(
  sections: ShortcutSheetSection[],
  query: string,
): ShortcutSheetSection[] {
  const trimmed = query.trim().toLowerCase();
  if (trimmed.length === 0) return sections;
  return sections
    .map((section) => ({
      ...section,
      entries: section.entries.filter((entry) => shortcutSheetEntryMatchesQuery(entry, trimmed)),
    }))
    .filter((section) => section.entries.length > 0);
}
