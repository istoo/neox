// FILE: terminalRuntimeTypes.ts
// Purpose: Shared types and stable identity helpers for persistent terminal runtimes.
// Layer: Terminal runtime infrastructure

import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebglAddon } from "@xterm/addon-webgl";
import { type TerminalActivityState, type TerminalCliKind } from "@synara/shared/terminalThreads";
import type { TerminalCharacterWidths } from "@synara/contracts";
import { Terminal, type IDisposable } from "@xterm/xterm";
import type { TerminalLinkMatch } from "../../terminal-links";
import type { TerminalProfileLaunch } from "../../lib/terminalProfiles";

/** How a terminal's process ended; `exitCode` is null when the host did not report one. */
export interface TerminalSessionExit {
  readonly exitCode: number | null;
}

/**
 * A failed process keeps its terminal open so the output and exit code stay readable; the user
 * closes it. A clean or unreported exit closes it, matching VS Code's default.
 */
export function shouldKeepExitedTerminal(exit: TerminalSessionExit): boolean {
  return exit.exitCode !== null && exit.exitCode !== 0;
}

export interface TerminalRuntimeCallbacks {
  onSessionExited: (exit: TerminalSessionExit) => void;
  onTerminalMetadataChange: (
    terminalId: string,
    metadata: { cliKind: TerminalCliKind | null; label: string },
  ) => void;
  onTerminalActivityChange: (
    terminalId: string,
    activity: { hasRunningSubprocess: boolean; agentState: TerminalActivityState | null },
  ) => void;
  onTerminalRuntimeStatusChange?: (terminalId: string, status: TerminalRuntimeStatus) => void;
}

export function buildTerminalRuntimeKey(threadId: string, terminalId: string): string {
  return `${threadId}::${terminalId}`;
}

export interface TerminalRuntimeConfig {
  runtimeKey: string;
  threadId: string;
  terminalId: string;
  terminalLabel: string;
  terminalCliKind?: TerminalCliKind | null;
  cwd: string;
  runtimeEnv?: Record<string, string>;
  providerAuthInstanceId?: string;
  /** Runs this profile's command when the daemon terminal is first created. */
  terminalProfile?: TerminalProfileLaunch;
  callbacks: TerminalRuntimeCallbacks;
}

export interface TerminalRuntimeViewState {
  autoFocus: boolean;
  isVisible: boolean;
}

export interface TerminalPendingWrite {
  data: string;
  byteLength: number;
  queuedAt: number;
}

export type TerminalRuntimeStatus = "connecting" | "replaying" | "ready" | "exited" | "error";

export interface TerminalRuntimeEntry {
  runtimeKey: string;
  threadId: string;
  terminalId: string;
  terminalLabel: string;
  terminalCliKind: TerminalCliKind | null;
  cwd: string;
  runtimeEnv?: Record<string, string>;
  providerAuthInstanceId?: string;
  terminalProfile?: TerminalProfileLaunch;
  callbacks: TerminalRuntimeCallbacks;
  wrapper: HTMLDivElement;
  container: HTMLDivElement | null;
  terminal: Terminal;
  /** Width table the parser currently uses; follows the daemon's snapshots. */
  characterWidths: TerminalCharacterWidths;
  fitAddon: FitAddon;
  searchAddon: SearchAddon;
  webglAddon: WebglAddon | null;
  titleInputBuffer: string;
  hasHandledExit: boolean;
  runtimeStatus: TerminalRuntimeStatus;
  opened: boolean;
  disposed: boolean;
  resizeObserver: ResizeObserver | null;
  resizeDispatchTimer: number | null;
  visualResizeFrame: number | null;
  visualResizeTimer: number | null;
  lastVisualResizeAt: number;
  lastSentResize: { cols: number; rows: number } | null;
  pendingResize: { cols: number; rows: number } | null;
  writeRafHandle: number | null;
  writeFlushTimeout: number | null;
  pendingWrites: TerminalPendingWrite[];
  pendingWriteLength: number;
  pendingWriteBytes: number;
  linkMatchCache: Map<string, TerminalLinkMatch[]>;
  outputEventVersion: number;
  snapshotReconcileRequestId: number;
  webglLoadFrame: number | null;
  themeRefreshFrame: number;
  themeObserver: MutationObserver | null;
  visibilityCleanup: (() => void) | null;
  terminalDisposables: IDisposable[];
  attachDisposables: Array<() => void>;
  persistentDisposables: Array<() => void>;
  querySuppressionDispose: (() => void) | null;
  viewState: TerminalRuntimeViewState;
  unsubscribeTerminalEvents: (() => void) | null;
}
