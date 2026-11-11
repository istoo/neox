// FILE: useSplitViewShortcuts.ts
// Purpose: Routes pane split / focus / close keybindings while a split view is on screen.
// Layer: UI hooks
// Exports: useSplitViewShortcuts

import type { ResolvedKeybindingsConfig } from "@synara/contracts";
import { useEffect } from "react";

import { useStableCallback } from "./useStableCallback";
import { resolveShortcutCommand } from "../keybindings";
import { isTerminalFocused } from "../lib/terminalFocus";
import type { PaneFocusDirection } from "../splitView.logic";
import type { SplitDirection, SplitDropSide } from "../splitViewStore";

export interface SplitViewShortcutHandlers {
  onSplit: (direction: SplitDirection, side: SplitDropSide) => void;
  onFocusDirection: (direction: PaneFocusDirection) => void;
  onClosePane: () => void;
  /** Moves the focused pane's content into the adjacent pane. */
  onMoveDirection: (direction: PaneFocusDirection) => void;
  /** Toggles maximizing the focused pane. */
  onToggleMaximize: () => void;
}

interface UseSplitViewShortcutsInput extends SplitViewShortcutHandlers {
  enabled: boolean;
  keybindings: ResolvedKeybindingsConfig;
}

const COMMANDS_BY_SPLIT: Readonly<
  Record<string, { direction: SplitDirection; side: SplitDropSide }>
> = {
  "chat.split": { direction: "horizontal", side: "second" },
  "pane.splitRight": { direction: "horizontal", side: "second" },
  "pane.splitLeft": { direction: "horizontal", side: "first" },
  "pane.splitDown": { direction: "vertical", side: "second" },
  "pane.splitUp": { direction: "vertical", side: "first" },
};

const COMMANDS_BY_FOCUS: Readonly<Record<string, PaneFocusDirection>> = {
  "pane.focusLeft": "left",
  "pane.focusRight": "right",
  "pane.focusUp": "up",
  "pane.focusDown": "down",
};

const COMMANDS_BY_MOVE: Readonly<Record<string, PaneFocusDirection>> = {
  "pane.moveLeft": "left",
  "pane.moveRight": "right",
  "pane.moveUp": "up",
  "pane.moveDown": "down",
};

// The split surface owns these bindings because each pane's ChatView only handles the chords that
// act on its own transcript. Focus guards live in the binding table, so a terminal keeps its own
// arrow chords and a user rebind is honoured without touching this handler.
export function useSplitViewShortcuts(input: UseSplitViewShortcutsInput): void {
  const { enabled, keybindings } = input;
  const onSplit = useStableCallback(input.onSplit);
  const onFocusDirection = useStableCallback(input.onFocusDirection);
  const onClosePane = useStableCallback(input.onClosePane);
  const onMoveDirection = useStableCallback(input.onMoveDirection);
  const onToggleMaximize = useStableCallback(input.onToggleMaximize);

  useEffect(() => {
    if (!enabled) return;

    const handler = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const command = resolveShortcutCommand(event, keybindings, {
        context: { terminalFocus: isTerminalFocused(), terminalOpen: false },
      });
      if (!command) return;

      const split = COMMANDS_BY_SPLIT[command];
      if (split) {
        event.preventDefault();
        event.stopPropagation();
        onSplit(split.direction, split.side);
        return;
      }
      const focusDirection = COMMANDS_BY_FOCUS[command];
      if (focusDirection) {
        event.preventDefault();
        event.stopPropagation();
        onFocusDirection(focusDirection);
        return;
      }
      const moveDirection = COMMANDS_BY_MOVE[command];
      if (moveDirection) {
        event.preventDefault();
        event.stopPropagation();
        onMoveDirection(moveDirection);
        return;
      }
      if (command === "pane.maximize") {
        event.preventDefault();
        event.stopPropagation();
        onToggleMaximize();
        return;
      }
      if (command === "pane.close") {
        event.preventDefault();
        event.stopPropagation();
        onClosePane();
      }
    };

    window.addEventListener("keydown", handler, { capture: true });
    return () => window.removeEventListener("keydown", handler, { capture: true });
  }, [
    enabled,
    keybindings,
    onSplit,
    onFocusDirection,
    onClosePane,
    onMoveDirection,
    onToggleMaximize,
  ]);
}
