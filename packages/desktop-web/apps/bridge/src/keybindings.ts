// Default shortcuts copied from Synara apps/server/src/keybindings.ts (MIT, Copyright (c) 2026
// T3 Tools Inc.). The bridge serves them as-is; editing shortcuts is not supported yet.
import type { KeybindingRule, ResolvedKeybindingsConfig } from "@synara/contracts";
import { compileKeybindingRule } from "@synara/shared/keybindingRules";

const SIDEBAR_SEARCH_DEFAULT_KEYBINDINGS = [
  // Cmd-only on macOS so Ctrl+K stays available for kill-to-end-of-line.
  // Keep Ctrl+K on Windows/Linux (where `mod` would otherwise be Ctrl).
  { key: "cmd+k", command: "sidebar.search" },
  { key: "ctrl+k", command: "sidebar.search", when: "!isMac" },
] as const satisfies ReadonlyArray<KeybindingRule>;

export const DEFAULT_KEYBINDINGS: ReadonlyArray<KeybindingRule> = [
  { key: "mod+b", command: "sidebar.toggle", when: "!terminalFocus" },
  ...SIDEBAR_SEARCH_DEFAULT_KEYBINDINGS,
  { key: "mod+alt+u", command: "sidebar.activity", when: "!terminalFocus || isMac" },
  { key: "mod+shift+o", command: "sidebar.addProject", when: "!terminalFocus" },
  { key: "mod+i", command: "sidebar.importThread", when: "!terminalFocus" },
  { key: "mod+alt+arrowleft", command: "space.previous", when: "!terminalFocus" },
  { key: "mod+alt+arrowright", command: "space.next", when: "!terminalFocus" },
  // Numbered space jumps address tabs in the switcher's visual order, so mod+alt+1 is
  // always Void. Same `|| isMac` escape hatch as the new-surface chords below: Cmd
  // chords never reach the PTY on macOS, while Ctrl+Alt+digit is AltGr territory on
  // Linux/Windows layouts and must keep yielding to focused terminals there.
  { key: "mod+alt+1", command: "space.jump.1", when: "!terminalFocus || isMac" },
  { key: "mod+alt+2", command: "space.jump.2", when: "!terminalFocus || isMac" },
  { key: "mod+alt+3", command: "space.jump.3", when: "!terminalFocus || isMac" },
  { key: "mod+alt+4", command: "space.jump.4", when: "!terminalFocus || isMac" },
  { key: "mod+alt+5", command: "space.jump.5", when: "!terminalFocus || isMac" },
  { key: "mod+alt+6", command: "space.jump.6", when: "!terminalFocus || isMac" },
  { key: "mod+alt+7", command: "space.jump.7", when: "!terminalFocus || isMac" },
  { key: "mod+alt+8", command: "space.jump.8", when: "!terminalFocus || isMac" },
  { key: "mod+alt+9", command: "space.jump.9", when: "!terminalFocus || isMac" },
  { key: "mod+j", command: "terminal.toggle" },
  // Reserve Cmd/Ctrl+T for the terminal workspace's "new tab" action while focused.
  { key: "mod+t", command: "terminal.new", when: "terminalFocus" },
  { key: "mod+w", command: "terminal.close", when: "terminalFocus" },
  { key: "mod+shift+j", command: "terminal.workspace.newFullWidth" },
  { key: "mod+w", command: "terminal.workspace.closeActive", when: "terminalWorkspaceOpen" },
  // With no terminal focused and no workspace open, Cmd/Ctrl+W owns the regular
  // chat surface instead of Electron's native window-close role: it closes the
  // active open-thread tab like a browser tab.
  { key: "mod+w", command: "threadTab.close", when: "!terminalFocus && !terminalWorkspaceOpen" },
  // Keep workspace tabs on literal Ctrl so Cmd+1…9 remains consistent app navigation
  // on macOS even when a thread was opened directly as a full-width terminal.
  { key: "ctrl+1", command: "terminal.workspace.terminal", when: "terminalWorkspaceOpen" },
  { key: "ctrl+2", command: "terminal.workspace.chat", when: "terminalWorkspaceOpen" },
  { key: "mod+shift+b", command: "browser.toggle", when: "!terminalFocus" },
  { key: "mod+alt+s", command: "sidechat.toggle", when: "!terminalFocus || isMac" },
  { key: "mod+d", command: "diff.toggle", when: "!terminalFocus" },
  { key: "alt+arrowdown", command: "diff.change.next", when: "!terminalFocus" },
  { key: "alt+arrowup", command: "diff.change.previous", when: "!terminalFocus" },
  // Cmd-only instead of mod so Ctrl+L remains available to shells on non-macOS.
  { key: "cmd+l", command: "composer.focus.toggle", when: "!terminalFocus" },
  { key: "mod+f", command: "chat.find", when: "!terminalFocus" },
  // Workspace search palette: file names and snippet content. Keep these off terminal focus
  // so Ctrl+P/Ctrl+Shift+F remain available to the shell on Windows/Linux.
  { key: "mod+p", command: "search.files", when: "!terminalFocus" },
  { key: "mod+shift+f", command: "search.content", when: "!terminalFocus" },
  { key: "mod+shift+m", command: "modelPicker.toggle", when: "!terminalFocus" },
  // Cycle models within the active provider (favorites first, then remaining list).
  { key: "alt+]", command: "model.next", when: "!terminalFocus" },
  { key: "alt+[", command: "model.previous", when: "!terminalFocus" },
  // Preserve reverse focus navigation outside the composer and its effort picker.
  { key: "shift+tab", command: "model.effort.next", when: "composerFocus" },
  { key: "mod+shift+e", command: "traitsPicker.toggle", when: "!terminalFocus" },
  { key: "mod+shift+u", command: "settings.usage", when: "!terminalFocus" },
  // New thread (chat.new) is the primary create action; it falls back to the most
  // recent project when no project is active.
  //
  // These new-surface chords use `!terminalFocus || isMac`: on macOS `mod` is Cmd and
  // xterm never forwards a Cmd-chord to the PTY, so the bare `!terminalFocus` guard just
  // dropped the chord while the terminal had focus (you couldn't open a new chat/terminal
  // from the terminal). The `|| isMac` escape hatch fires them on macOS regardless of
  // focus, while Linux/Windows keep `!terminalFocus` so Ctrl-chords still reach the shell.
  { key: "mod+n", command: "chat.new", when: "!terminalFocus || isMac" },
  { key: "mod+shift+n", command: "chat.newLatestProject", when: "!terminalFocus || isMac" },
  { key: "mod+alt+n", command: "chat.newChat", when: "!terminalFocus || isMac" },
  { key: "mod+shift+t", command: "chat.newTerminal", when: "!terminalFocus || isMac" },
  { key: "mod+alt+c", command: "chat.newClaude", when: "!terminalFocus || isMac" },
  { key: "mod+alt+x", command: "chat.newCodex", when: "!terminalFocus || isMac" },
  { key: "mod+alt+r", command: "chat.newCursor", when: "!terminalFocus || isMac" },
  { key: "mod+\\", command: "chat.split", when: "!terminalFocus || isMac" },
  // Recent-view switcher (Ctrl+Tab) is an installed-app feature only: Electron and
  // standalone PWA windows have no tab strip, so the chord reaches the page. It remains
  // app-level even with terminal focus; the web route captures it before xterm input.
  { key: "ctrl+tab", command: "view.recent.next" },
  { key: "ctrl+shift+tab", command: "view.recent.previous" },
  {
    key: "mod+1",
    command: "thread.jump.1",
    when: "(!terminalFocus && !terminalWorkspaceOpen) || isMac",
  },
  {
    key: "mod+2",
    command: "thread.jump.2",
    when: "(!terminalFocus && !terminalWorkspaceOpen) || isMac",
  },
  {
    key: "mod+3",
    command: "thread.jump.3",
    when: "(!terminalFocus && !terminalWorkspaceOpen) || isMac",
  },
  {
    key: "mod+4",
    command: "thread.jump.4",
    when: "(!terminalFocus && !terminalWorkspaceOpen) || isMac",
  },
  {
    key: "mod+5",
    command: "thread.jump.5",
    when: "(!terminalFocus && !terminalWorkspaceOpen) || isMac",
  },
  {
    key: "mod+6",
    command: "thread.jump.6",
    when: "(!terminalFocus && !terminalWorkspaceOpen) || isMac",
  },
  {
    key: "mod+7",
    command: "thread.jump.7",
    when: "(!terminalFocus && !terminalWorkspaceOpen) || isMac",
  },
  {
    key: "mod+8",
    command: "thread.jump.8",
    when: "(!terminalFocus && !terminalWorkspaceOpen) || isMac",
  },
  {
    key: "mod+9",
    command: "thread.jump.9",
    when: "(!terminalFocus && !terminalWorkspaceOpen) || isMac",
  },
  // Copying the active thread id is not terminal input on macOS, but Ctrl+Shift+C is the
  // terminal copy chord on Linux/Windows, so it keeps the same `|| isMac` escape hatch.
  { key: "mod+shift+c", command: "thread.copyId", when: "!terminalFocus || isMac" },
  // Keep these distinct from browser Save As / View Source and side-chat / Activity.
  { key: "mod+alt+shift+a", command: "thread.archive", when: "!terminalFocus || isMac" },
  { key: "mod+alt+shift+s", command: "thread.snooze", when: "!terminalFocus || isMac" },
  { key: "mod+alt+shift+u", command: "thread.markUnread", when: "!terminalFocus || isMac" },
  { key: "mod+shift+]", command: "chat.visible.next", when: "!terminalFocus" },
  { key: "mod+shift+[", command: "chat.visible.previous", when: "!terminalFocus" },
  // Codex's chord for the same jump; Cmd+Option+Shift+A stays Archive.
  { key: "mod+alt+a", command: "chat.attention.next", when: "!terminalFocus || isMac" },
  // Open thread tabs, browser-style: Cmd+Ctrl+Left/Right on macOS (Cmd+Shift+Left/Right
  // selects to the line edge in the composer, Cmd+Option+Arrow switches spaces, and
  // xterm never sees a Cmd-chord), and
  // Ctrl+PageUp/PageDown elsewhere, where Ctrl+Alt+Left/Right switches desktop workspaces.
  { key: "mod+ctrl+arrowright", command: "threadTab.next", when: "isMac" },
  { key: "mod+ctrl+arrowleft", command: "threadTab.previous", when: "isMac" },
  { key: "ctrl+pagedown", command: "threadTab.next", when: "!terminalFocus && !isMac" },
  { key: "ctrl+pageup", command: "threadTab.previous", when: "!terminalFocus && !isMac" },
  { key: "meta+ctrl+p", command: "git.commitAndPush", when: "!terminalFocus && isMac" },
  { key: "ctrl+alt+p", command: "git.commitAndPush", when: "!terminalFocus && !isMac" },
  { key: "mod+o", command: "editor.openFavorite" },
  { key: "mod+s", command: "editor.file.save", when: "!terminalFocus" },
  // In-app code editor. The editor only runs these while it has focus; the guard keeps
  // F-keys flowing to terminal programs. Go to symbol, Go to line and Show problems ship
  // unassigned: their usual chords (Mod+Shift+O / Mod+G / Mod+Shift+M) already add a
  // project, toggle the terminal and open the model picker.
  { key: "f1", command: "editor.commands", when: "!terminalFocus" },
  { key: "f2", command: "editor.rename", when: "!terminalFocus" },
  { key: "f12", command: "editor.goToDefinition", when: "!terminalFocus" },
  { key: "shift+f12", command: "editor.findReferences", when: "!terminalFocus" },
  { key: "mod+.", command: "editor.quickFix", when: "!terminalFocus" },
  { key: "f5", command: "editor.debug.start", when: "!terminalFocus" },
  { key: "shift+f5", command: "editor.debug.stop", when: "!terminalFocus" },
  { key: "f9", command: "editor.debug.toggleBreakpoint", when: "!terminalFocus" },
  { key: "f10", command: "editor.debug.stepOver", when: "!terminalFocus" },
  { key: "f11", command: "editor.debug.stepInto", when: "!terminalFocus" },
  { key: "shift+f11", command: "editor.debug.stepOut", when: "!terminalFocus" },
];

export const DEFAULT_RESOLVED_KEYBINDINGS: ResolvedKeybindingsConfig = DEFAULT_KEYBINDINGS.flatMap(
  (rule) => {
    const compiled = compileKeybindingRule(rule);
    return compiled ? [compiled] : [];
  },
);
