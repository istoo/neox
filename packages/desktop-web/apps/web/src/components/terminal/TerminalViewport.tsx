// FILE: TerminalViewport.tsx
// Purpose: Shared interactive terminal viewport for chat and provider authentication.
// Layer: Chat terminal workspace UI
// Depends on: xterm addons, native terminal APIs, and terminal workspace state from ChatView.

import "@xterm/xterm/css/xterm.css";
import { SearchAddon } from "@xterm/addon-search";
import { TriangleAlertIcon } from "~/lib/icons";
import { type ThreadId } from "@synara/contracts";
import { type TerminalActivityState, type TerminalCliKind } from "@synara/shared/terminalThreads";
import { Terminal } from "@xterm/xterm";
import {
  type DragEvent as ReactDragEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { type TerminalContextSelection } from "~/lib/terminalContext";
import { readNativeApi } from "~/nativeApi";
import { cn } from "~/lib/utils";
import { readExecutionContext } from "~/lib/hosts/executionContext";
import { hasDroppedPathReferenceTypes } from "~/lib/composerDropPaths";
import type { TerminalProfileLaunch } from "~/lib/terminalProfiles";
import {
  absolutePathForDroppedFile,
  clipboardImageFiles,
  droppedFilePaths,
  hasClipboardText,
  namedClipboardImage,
  prepareDroppedPathsForTerminal,
  uploadTerminalFile,
} from "~/lib/terminalFileDrop";
import { toastManager } from "~/components/ui/toast";
import {
  resolveTerminalSelectionActionPosition,
  resolveTerminalSelectionContextMenuItems,
  shouldHandleTerminalSelectionMouseUp,
  terminalSelectionActionDelayForClickCount,
} from "./terminalSelectionActions";
import { buildTerminalRuntimeKey, terminalRuntimeRegistry } from "./terminalRuntimeRegistry";
import type {
  TerminalRuntimeConfig,
  TerminalRuntimeStatus,
  TerminalRuntimeViewState,
  TerminalSessionExit,
} from "./terminalRuntimeTypes";
import { matchesFixedShortcut } from "~/fixedShortcuts";
import { hasOpenDismissibleOverlay } from "~/lib/editableEventTarget";
import { TerminalSearch } from "../TerminalSearch";
import { TerminalScrollToBottom } from "../TerminalScrollToBottom";
import { useTerminalFocusHeartbeat } from "~/hooks/useTerminalFocusHeartbeat";
import { useTranslation } from "~/i18n";

function serializeRuntimeEnv(runtimeEnv: Record<string, string> | undefined): string {
  if (!runtimeEnv) return "";
  const entries = Object.entries(runtimeEnv);
  if (entries.length === 0) return "";
  entries.sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify(entries);
}

function runtimeEnvFromSerialized(
  serializedRuntimeEnv: string,
): Record<string, string> | undefined {
  if (!serializedRuntimeEnv) return undefined;
  const entries = JSON.parse(serializedRuntimeEnv) as Array<[string, string]>;
  return Object.fromEntries(entries);
}

function getTerminalSelectionRect(mountElement: HTMLElement): DOMRect | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return null;
  }

  const range = selection.getRangeAt(0);
  const commonAncestor = range.commonAncestorContainer;
  const selectionRoot =
    commonAncestor instanceof Element ? commonAncestor : commonAncestor.parentElement;
  if (!(selectionRoot instanceof Element) || !mountElement.contains(selectionRoot)) {
    return null;
  }

  const rects = Array.from(range.getClientRects()).filter(
    (rect) => rect.width > 0 || rect.height > 0,
  );
  if (rects.length > 0) {
    return rects[rects.length - 1] ?? null;
  }

  const boundingRect = range.getBoundingClientRect();
  return boundingRect.width > 0 || boundingRect.height > 0 ? boundingRect : null;
}

/** Native files, plus the path-only payloads editors attach when dragging a folder. */
function hasTerminalDropPayload(types: readonly string[]): boolean {
  return types.includes("Files") || hasDroppedPathReferenceTypes(types);
}

function TerminalRuntimeStatusOverlay({ status }: { status: TerminalRuntimeStatus }) {
  const { t } = useTranslation();

  if (status !== "error") return null;

  return (
    <div
      className={cn(
        "pointer-events-none absolute left-1 top-1 z-10 inline-flex h-6 max-w-[calc(100%-0.5rem)] items-center gap-1.5 rounded border px-2 text-ui-sm leading-none shadow-sm",
        // Dense fill: the pill floats over terminal text, and a blur cannot hide it on a
        // translucent window.
        "border-destructive/30 bg-[color-mix(in_srgb,var(--destructive)_10%,var(--popover))] text-destructive",
      )}
    >
      <TriangleAlertIcon className="size-3" />
      <span className="truncate">{t("chat:providerUsage_error")}</span>
    </div>
  );
}

interface TerminalViewportProps {
  threadId: ThreadId;
  terminalId: string;
  terminalLabel: string;
  terminalCliKind?: TerminalCliKind | null;
  cwd: string;
  runtimeEnv?: Record<string, string>;
  providerAuthInstanceId?: string;
  terminalProfile?: TerminalProfileLaunch;
  onRuntimeStatusChange?: (status: TerminalRuntimeStatus) => void;
  onSessionExited: (exit: TerminalSessionExit) => void;
  onTerminalMetadataChange: (
    terminalId: string,
    metadata: { cliKind: TerminalCliKind | null; label: string },
  ) => void;
  onTerminalActivityChange: (
    terminalId: string,
    activity: { hasRunningSubprocess: boolean; agentState: TerminalActivityState | null },
  ) => void;
  onAddTerminalContext?: ((selection: TerminalContextSelection) => void) | undefined;
  focusRequestId: number;
  autoFocus: boolean;
  isVisible: boolean;
}

export default function TerminalViewport({
  threadId,
  terminalId,
  terminalLabel,
  terminalCliKind: terminalCliKindProp,
  cwd,
  runtimeEnv,
  providerAuthInstanceId,
  terminalProfile,
  onRuntimeStatusChange,
  onSessionExited,
  onTerminalMetadataChange,
  onTerminalActivityChange,
  onAddTerminalContext,
  focusRequestId,
  autoFocus,
  isVisible,
}: TerminalViewportProps) {
  const terminalCliKind = terminalCliKindProp ?? null;
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const onAddTerminalContextRef = useRef(onAddTerminalContext);
  const terminalLabelRef = useRef(terminalLabel);
  const selectionPointerRef = useRef<{ x: number; y: number } | null>(null);
  const selectionGestureActiveRef = useRef(false);
  const selectionActionRequestIdRef = useRef(0);
  const selectionActionOpenRef = useRef(false);
  const selectionActionTimerRef = useRef<number | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const dragDepthRef = useRef(0);
  const { t } = useTranslation();
  const [terminalInstance, setTerminalInstance] = useState<Terminal | null>(null);
  const [searchAddonInstance, setSearchAddonInstance] = useState<SearchAddon | null>(null);
  const [runtimeStatus, setRuntimeStatus] = useState<TerminalRuntimeStatus>("connecting");
  const runtimeStatusMountedRef = useRef(false);
  const trimmedCwd = useMemo(() => cwd.trim(), [cwd]);
  const runtimeCwdReady = trimmedCwd.length > 0;
  const runtimeKey = useMemo(
    () => buildTerminalRuntimeKey(threadId, terminalId),
    [terminalId, threadId],
  );
  const runtimeEnvSerialized = useMemo(() => serializeRuntimeEnv(runtimeEnv), [runtimeEnv]);
  const runtimeEnvPayload = useMemo(
    () => runtimeEnvFromSerialized(runtimeEnvSerialized),
    [runtimeEnvSerialized],
  );
  const runtimeConfig = useMemo<TerminalRuntimeConfig>(
    () => ({
      runtimeKey,
      threadId,
      terminalId,
      terminalLabel,
      terminalCliKind,
      cwd,
      ...(providerAuthInstanceId ? { providerAuthInstanceId } : {}),
      ...(terminalProfile ? { terminalProfile } : {}),
      ...(runtimeEnvPayload ? { runtimeEnv: runtimeEnvPayload } : {}),
      callbacks: {
        onSessionExited,
        onTerminalMetadataChange,
        onTerminalActivityChange,
        onTerminalRuntimeStatusChange: (changedTerminalId, status) => {
          if (changedTerminalId === terminalId && runtimeStatusMountedRef.current) {
            setRuntimeStatus(status);
            onRuntimeStatusChange?.(status);
          }
        },
      },
    }),
    [
      cwd,
      onSessionExited,
      onRuntimeStatusChange,
      providerAuthInstanceId,
      onTerminalActivityChange,
      onTerminalMetadataChange,
      runtimeEnvPayload,
      runtimeKey,
      terminalCliKind,
      terminalId,
      terminalLabel,
      terminalProfile,
      threadId,
    ],
  );
  const runtimeViewState = useMemo<TerminalRuntimeViewState>(
    () => ({ autoFocus, isVisible }),
    [autoFocus, isVisible],
  );
  const runtimeConfigRef = useRef(runtimeConfig);
  const runtimeViewStateRef = useRef(runtimeViewState);

  useLayoutEffect(() => {
    onAddTerminalContextRef.current = onAddTerminalContext;
  }, [onAddTerminalContext]);

  useEffect(() => {
    runtimeStatusMountedRef.current = true;
    return () => {
      runtimeStatusMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    runtimeConfigRef.current = runtimeConfig;
  }, [runtimeConfig]);

  useEffect(() => {
    runtimeViewStateRef.current = runtimeViewState;
  }, [runtimeViewState]);

  useEffect(() => {
    terminalLabelRef.current = terminalLabel;
  }, [terminalLabel]);

  useEffect(() => {
    const mount = containerRef.current;
    if (!mount || !runtimeCwdReady) {
      terminalRef.current = null;
      setTerminalInstance(null);
      setSearchAddonInstance(null);
      setRuntimeStatus("connecting");
      return;
    }
    const attachedRuntime = terminalRuntimeRegistry.attach(
      runtimeConfigRef.current,
      runtimeViewStateRef.current,
      mount,
    );

    terminalRef.current = attachedRuntime.terminal;
    setTerminalInstance(attachedRuntime.terminal);
    setSearchAddonInstance(attachedRuntime.searchAddon);
    runtimeConfigRef.current.callbacks.onTerminalRuntimeStatusChange?.(
      runtimeConfigRef.current.terminalId,
      attachedRuntime.runtimeStatus,
    );

    return () => {
      if (selectionActionTimerRef.current !== null) {
        window.clearTimeout(selectionActionTimerRef.current);
        selectionActionTimerRef.current = null;
      }
      selectionActionOpenRef.current = false;
      terminalRuntimeRegistry.detach(runtimeKey);
      terminalRef.current = null;
      setTerminalInstance(null);
      setSearchAddonInstance(null);
    };
  }, [runtimeCwdReady, runtimeKey]);

  useTerminalFocusHeartbeat({ containerRef, threadId, terminalId, isVisible });

  useEffect(() => {
    if (!runtimeCwdReady) return;
    terminalRuntimeRegistry.syncConfig(runtimeKey, runtimeConfig);
  }, [runtimeConfig, runtimeCwdReady, runtimeKey]);

  useEffect(() => {
    if (!runtimeCwdReady) return;
    terminalRuntimeRegistry.setViewState(runtimeKey, runtimeViewState);
  }, [runtimeCwdReady, runtimeKey, runtimeViewState]);

  useEffect(() => {
    if (
      !autoFocus ||
      !isVisible ||
      !runtimeCwdReady ||
      !document.hasFocus() ||
      hasOpenDismissibleOverlay(containerRef.current)
    ) {
      return;
    }
    terminalRuntimeRegistry.focus(runtimeKey);
  }, [autoFocus, focusRequestId, isVisible, runtimeCwdReady, runtimeKey]);

  useEffect(() => {
    const mount = containerRef.current;
    if (!mount) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        matchesFixedShortcut(event, "terminal.search", navigator.platform, {
          terminalFocus: true,
        })
      ) {
        event.preventDefault();
        event.stopPropagation();
        setSearchOpen(true);
      }
    };

    mount.addEventListener("keydown", handleKeyDown, true);
    return () => {
      mount.removeEventListener("keydown", handleKeyDown, true);
    };
  }, []);

  const clearSelectionAction = useCallback(() => {
    selectionActionRequestIdRef.current += 1;
    if (selectionActionTimerRef.current !== null) {
      window.clearTimeout(selectionActionTimerRef.current);
      selectionActionTimerRef.current = null;
    }
  }, []);

  const readSelectionAction = useCallback((): {
    position: { x: number; y: number };
    selection: TerminalContextSelection;
  } | null => {
    const activeTerminal = terminalRef.current;
    const mountElement = containerRef.current;
    if (!activeTerminal || !mountElement || !activeTerminal.hasSelection()) {
      return null;
    }
    const selectionText = activeTerminal.getSelection();
    const selectionPosition = activeTerminal.getSelectionPosition();
    const normalizedText = selectionText.replace(/\r\n/g, "\n").replace(/^\n+|\n+$/g, "");
    if (!selectionPosition || normalizedText.length === 0) {
      return null;
    }
    const lineStart = selectionPosition.start.y + 1;
    const lineCount = normalizedText.split("\n").length;
    const lineEnd = Math.max(lineStart, lineStart + lineCount - 1);
    const bounds = mountElement.getBoundingClientRect();
    const selectionRect = getTerminalSelectionRect(mountElement);
    const position = resolveTerminalSelectionActionPosition({
      bounds,
      selectionRect:
        selectionRect === null
          ? null
          : { right: selectionRect.right, bottom: selectionRect.bottom },
      pointer: selectionPointerRef.current,
    });
    return {
      position,
      selection: {
        terminalId,
        terminalLabel: terminalLabelRef.current,
        lineStart,
        lineEnd,
        text: normalizedText,
      },
    };
  }, [terminalId]);

  const showSelectionAction = useCallback(() => {
    if (selectionActionOpenRef.current) {
      return;
    }
    const contextMenuItems = resolveTerminalSelectionContextMenuItems(
      onAddTerminalContextRef.current !== undefined,
    );
    if (contextMenuItems.length === 0) {
      clearSelectionAction();
      return;
    }
    const nextAction = readSelectionAction();
    if (!nextAction) {
      clearSelectionAction();
      return;
    }
    const api = readNativeApi();
    if (!api) return;
    const requestId = ++selectionActionRequestIdRef.current;
    selectionActionOpenRef.current = true;
    // Promise chain instead of async/try-finally: React Compiler does not yet
    // support try/finally, and it would skip optimizing this whole component.
    void api.contextMenu
      .show(contextMenuItems, nextAction.position)
      .then((clicked) => {
        if (requestId !== selectionActionRequestIdRef.current || clicked !== "add-to-chat") {
          return;
        }
        const addTerminalContext = onAddTerminalContextRef.current;
        if (!addTerminalContext) {
          return;
        }
        addTerminalContext(nextAction.selection);
        terminalRef.current?.clearSelection();
        terminalRuntimeRegistry.focus(runtimeKey);
      })
      .finally(() => {
        selectionActionOpenRef.current = false;
      });
  }, [clearSelectionAction, readSelectionAction, runtimeKey]);

  useEffect(() => {
    const terminal = terminalInstance;
    const mount = containerRef.current;
    if (!terminal || !mount) return;

    const selectionDisposable = terminal.onSelectionChange(() => {
      if (terminal.hasSelection()) {
        return;
      }
      clearSelectionAction();
    });

    const handleMouseUp = (event: MouseEvent) => {
      const shouldHandle = shouldHandleTerminalSelectionMouseUp(
        selectionGestureActiveRef.current,
        event.button,
      );
      selectionGestureActiveRef.current = false;
      if (!shouldHandle) {
        return;
      }
      selectionPointerRef.current = { x: event.clientX, y: event.clientY };
      const delay = terminalSelectionActionDelayForClickCount(event.detail);
      selectionActionTimerRef.current = window.setTimeout(() => {
        selectionActionTimerRef.current = null;
        window.requestAnimationFrame(() => {
          void showSelectionAction();
        });
      }, delay);
    };

    const handlePointerDown = (event: PointerEvent) => {
      clearSelectionAction();
      selectionGestureActiveRef.current = event.button === 0;
    };

    window.addEventListener("mouseup", handleMouseUp);
    mount.addEventListener("pointerdown", handlePointerDown);
    return () => {
      selectionDisposable.dispose();
      window.removeEventListener("mouseup", handleMouseUp);
      mount.removeEventListener("pointerdown", handlePointerDown);
      clearSelectionAction();
      selectionGestureActiveRef.current = false;
    };
  }, [clearSelectionAction, showSelectionAction, terminalInstance]);

  const pasteTerminalText = useCallback(
    (text: string) => {
      const api = readNativeApi();
      if (!api) return;
      void api.terminal
        .write({ threadId, terminalId, data: `${text} ` })
        .catch((error: unknown) => {
          toastManager.add({
            type: "error",
            title: t("workspace:terminalPasteFailed"),
            description: error instanceof Error ? error.message : String(error),
          });
        });
      terminalRef.current?.focus();
    },
    [t, terminalId, threadId],
  );

  const insertFilesIntoTerminal = useCallback(
    async (files: readonly File[]) => {
      const remoteHost = Boolean(readExecutionContext()?.remote);
      const paths: string[] = [];
      for (const file of files) {
        // A local path only names a file the host can read; a remote workspace
        // needs the bytes uploaded to that host.
        const localPath = remoteHost ? null : absolutePathForDroppedFile(file);
        if (localPath) {
          paths.push(localPath);
          continue;
        }
        try {
          paths.push(await uploadTerminalFile(file));
        } catch (error) {
          toastManager.add({
            type: "error",
            title: t("workspace:terminalFileUploadFailed"),
            description: error instanceof Error ? error.message : String(error),
          });
        }
      }
      if (paths.length > 0) {
        pasteTerminalText(prepareDroppedPathsForTerminal(paths));
      }
    },
    [pasteTerminalText, t],
  );

  useEffect(() => {
    const mount = containerRef.current;
    if (!mount) return;
    const handlePaste = (event: ClipboardEvent) => {
      const data = event.clipboardData;
      if (!data || hasClipboardText(data)) return;
      const images = clipboardImageFiles(data);
      if (images.length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      void insertFilesIntoTerminal(images.map(namedClipboardImage));
    };
    mount.addEventListener("paste", handlePaste, true);
    return () => {
      mount.removeEventListener("paste", handlePaste, true);
    };
  }, [insertFilesIntoTerminal]);

  const handleDragEnter = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!hasTerminalDropPayload(event.dataTransfer.types)) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    setIsDragOver(true);
  };

  const handleDragOver = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!hasTerminalDropPayload(event.dataTransfer.types)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };

  const handleDragLeave = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!hasTerminalDropPayload(event.dataTransfer.types)) return;
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setIsDragOver(false);
  };

  const handleDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    dragDepthRef.current = 0;
    setIsDragOver(false);
    const dropped = droppedFilePaths(event.dataTransfer);
    if (dropped.files.length === 0 && dropped.referencedPaths.length === 0) return;
    event.preventDefault();
    if (dropped.files.length === 0) {
      pasteTerminalText(prepareDroppedPathsForTerminal(dropped.referencedPaths));
      return;
    }
    void insertFilesIntoTerminal(dropped.files);
  };

  return (
    <div className="h-full min-h-0 w-full app-content-surface p-3">
      <div
        className={cn(
          "relative h-full min-h-0 w-full overflow-hidden rounded-sm",
          isDragOver && "ring-2 ring-[var(--color-accent)] ring-inset",
        )}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        data-terminal-drop-target
      >
        <TerminalSearch
          searchAddon={searchAddonInstance}
          isOpen={searchOpen}
          onClose={() => {
            setSearchOpen(false);
            terminalRuntimeRegistry.focus(runtimeKey);
          }}
        />
        <TerminalRuntimeStatusOverlay status={runtimeStatus} />
        <TerminalScrollToBottom terminal={terminalInstance} />
        <div ref={containerRef} className="h-full w-full" />
      </div>
    </div>
  );
}
