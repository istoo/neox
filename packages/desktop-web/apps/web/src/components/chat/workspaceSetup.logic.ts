// FILE: workspaceSetup.logic.ts
// Purpose: Pure helpers for the worktree setup dock pane: status labels, log cleanup and
//          which command row should be expanded. Kept out of the component so the state
//          transitions are unit-testable without a DOM.
// Layer: Chat right-dock logic

import type { WorkspaceSetupSnapshot } from "@synara/contracts";

export type WorkspaceSetupStatusLabel = "waiting" | "running" | "completed" | "failed" | "blocked";

/** Process carriage returns so progress-bar output keeps its final frame. */
export function processSetupCarriageReturns(text: string): string {
  if (!text.includes("\r")) return text;
  return text
    .split("\n")
    .map((line) => {
      if (!line.includes("\r")) return line;
      const segments = line.split("\r");
      return segments[segments.length - 1] ?? "";
    })
    .join("\n");
}

export function formatSetupDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

export function setupStatusLabel(
  snapshot: WorkspaceSetupSnapshot | null | undefined,
): WorkspaceSetupStatusLabel {
  if (!snapshot) return "waiting";
  return snapshot.status;
}

/** The running command, else the last one, opens by default. */
export function setupAutoExpandIndex(
  snapshot: WorkspaceSetupSnapshot | null | undefined,
): number | null {
  const commands = snapshot?.detail.commands ?? [];
  const running = commands.find((command) => command.status === "running");
  if (running) return running.index;
  return commands.length > 0 ? commands[commands.length - 1]!.index : null;
}

export function setupHasNoCommands(snapshot: WorkspaceSetupSnapshot | null | undefined): boolean {
  return snapshot?.status === "completed" && (snapshot.detail.commands.length ?? 0) === 0;
}

/** A snapshot row is expandable unless it is still running with nothing to show. */
export function setupCommandIsExpandable(command: {
  readonly status: string;
  readonly log?: string | undefined;
}): boolean {
  return command.status !== "running" || Boolean(command.log?.trim());
}
