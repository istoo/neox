/// <reference types="vite/client" />

import type { NativeApi, DesktopBridge } from "@synara/contracts";

interface ImportMetaEnv {
  readonly APP_VERSION: string;
  readonly VITE_FEEDBACK_ENDPOINT?: string;
  readonly VITE_PROFILES_PUBLIC_ORIGIN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare global {
  interface Window {
    nativeApi?: NativeApi;
    desktopBridge?: DesktopBridge;
    /** The Neox Electron preload's native surface, used by the tray panel. */
    neolixDesktop?: {
      platform?: string;
      /** Runs a desktop command exposed by the shell's `neolix:invoke` channel. */
      invoke?: <T = unknown>(command: string, args?: Record<string, unknown>) => Promise<T>;
      /** The project folder a launch or second-instance open asked this window to show. */
      getPendingOpenProject?: () => Promise<string | null>;
      agentNavigation?: {
        ready?: () => Promise<{ serverId: string; agentId: string } | null>;
      };
      window?: {
        openNew?: (options?: { pendingOpenProjectPath?: string | null }) => Promise<void>;
        getCurrentWindow?: () => {
          setBadgeCount?: (count?: number) => Promise<void>;
        };
      };
      panel?: {
        hide?: () => Promise<void>;
        openMain?: () => Promise<void>;
        openAgent?: (target: { serverId: string; agentId: string }) => Promise<void>;
        openThread?: (threadId: string) => Promise<void>;
      };
      events?: {
        on?: (event: string, handler: (payload: unknown) => void) => Promise<() => void>;
      };
    };
  }
}
