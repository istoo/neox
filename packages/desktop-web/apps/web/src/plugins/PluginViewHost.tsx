// FILE: PluginViewHost.tsx
// Purpose: Hosts a plugin's custom web view in a sandboxed iframe. The frame has no same-origin
//          access and no host cookies or tokens; everything it can do is a postMessage request the
//          host validates against the manifest view permissions.
// Layer: Web plugin host
// Exports: PluginViewHost, PluginNativeOnlyNotice

import type { NeolixPlugin, NeolixPluginWebView } from "@synara/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useTheme } from "~/hooks/useTheme";
import { cn } from "~/lib/utils";
import { Spinner } from "~/components/ui/spinner";
import { useTranslation } from "~/i18n";

import { invokePluginRpc } from "./contributions";
import { openPluginView } from "./viewStore";
import {
  canResizePluginView,
  createPluginViewSession,
  isAllowedPluginRequest,
  isTrustedPluginMessage,
  parsePluginFrameMessage,
  requestTimeoutError,
  type PluginHostContext,
  type PluginRequestMessage,
} from "./protocol";

const REQUEST_TIMEOUT_MS = 15_000;
const VIEW_LOAD_TIMEOUT_MS = 10_000;
const MIN_HEIGHT = 160;
const MAX_HEIGHT = 4_000;
const DEFAULT_HEIGHT = 480;

/** The bridge serves plugin assets; dev puts the web app on another port than the bridge. */
function pluginWebOrigin(): string {
  const wsUrl = import.meta.env.VITE_WS_URL as string | undefined;
  if (wsUrl) {
    try {
      const url = new URL(wsUrl);
      url.protocol = url.protocol === "wss:" ? "https:" : "http:";
      return url.origin;
    } catch {
      // Fall through to the app origin.
    }
  }
  return typeof window === "undefined" ? "" : window.location.origin;
}

function pluginViewUrl(pluginId: string, entry: string, session: string): string {
  const path = entry
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${pluginWebOrigin()}/plugin-web/${pluginId}/${path}?neolixSession=${encodeURIComponent(session)}`;
}

function readThemeVariables(): Record<string, string> {
  if (typeof window === "undefined") return {};
  const styles = window.getComputedStyle(document.documentElement);
  const variables: Record<string, string> = {};
  for (const property of Array.from(styles)) {
    if (property.startsWith("--color-")) variables[property] = styles.getPropertyValue(property);
  }
  return variables;
}

/** A notice for plugins that only ship native UI. */
export function PluginNativeOnlyNotice({ className }: { className?: string | undefined }) {
  const { t } = useTranslation();
  return (
    <div
      className={cn(
        "flex min-h-24 items-center justify-center rounded-xl border border-border/60 bg-muted/30 px-4 py-6 text-center text-ui-sm text-muted-foreground",
        className,
      )}
    >
      {t("settings:plugins_mobileOnlyNotice")}
    </div>
  );
}

interface PluginViewHostProps {
  readonly plugin: NeolixPlugin;
  readonly viewId: string;
  readonly params?: Readonly<Record<string, string>> | undefined;
  /** Timeline item payload when this view renders one. */
  readonly data?: unknown;
  readonly className?: string | undefined;
  readonly minHeight?: number;
  /** Fill the parent's height instead of the intrinsic (resizable) panel height. */
  readonly fill?: boolean;
}

export function PluginViewHost({
  plugin,
  viewId,
  params,
  data,
  className,
  minHeight: minHeightProp,
  fill,
}: PluginViewHostProps) {
  const minHeight = minHeightProp ?? DEFAULT_HEIGHT;
  const view: NeolixPluginWebView | undefined = plugin.web?.views.find(
    (candidate) => candidate.id === viewId,
  );
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<"mobileOnly" | "loadFailed" | null>(null);
  const { t } = useTranslation();
  const [height, setHeight] = useState(minHeight);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const session = useMemo(() => createPluginViewSession(), []);
  const src = useMemo(
    () => (view ? pluginViewUrl(plugin.id, view.entry, session) : null),
    [plugin.id, session, view],
  );
  const readyRef = useRef(false);
  const { resolvedTheme } = useTheme();
  const pluginRef = useRef(plugin);
  const viewRef = useRef(view);
  const paramsRef = useRef(params ?? {});
  const dataRef = useRef(data);
  useEffect(() => {
    pluginRef.current = plugin;
    viewRef.current = view;
    paramsRef.current = params ?? {};
    dataRef.current = data;
  });

  useEffect(() => {
    readyRef.current = false;
    setReady(false);
    setError(null);
    if (!src) {
      setError("mobileOnly");
      return;
    }
    const timer = setTimeout(() => {
      if (!readyRef.current) setError("loadFailed");
    }, VIEW_LOAD_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [src]);

  const buildContext = useCallback((): PluginHostContext => {
    const currentView = viewRef.current;
    return {
      theme: resolvedTheme,
      locale: typeof navigator === "undefined" ? "zh-CN" : navigator.language,
      params: paramsRef.current,
      pluginId: pluginRef.current.id,
      viewId,
      permissions: currentView?.permissions ?? [],
      ...(dataRef.current === undefined ? {} : { data: dataRef.current }),
    };
  }, [resolvedTheme, viewId]);

  // Host-to-frame messages. `ready` and the iframe `load` event both re-send the context, so a
  // plugin that registers its listener late still receives it.
  const postContext = useCallback(() => {
    const target = iframeRef.current?.contentWindow;
    if (!target) return;
    target.postMessage({ __neolix: true, session, type: "init", context: buildContext() }, "*");
    target.postMessage(
      {
        __neolix: true,
        session,
        type: "theme",
        theme: resolvedTheme,
        variables: readThemeVariables(),
      },
      "*",
    );
  }, [buildContext, resolvedTheme, session]);

  useEffect(() => {
    if (src) postContext();
  }, [postContext, src]);

  const respond = useCallback(
    (id: string, ok: boolean, result?: unknown, responseError?: string) => {
      iframeRef.current?.contentWindow?.postMessage(
        {
          __neolix: true,
          session,
          type: "response",
          id,
          ok,
          ...(ok ? { result } : { error: responseError ?? "Plugin request failed" }),
        },
        "*",
      );
    },
    [session],
  );

  const handleRequest = useCallback(
    async (message: PluginRequestMessage) => {
      const currentView = viewRef.current;
      if (!currentView) return;
      const availableViewIds = new Set(
        pluginRef.current.web?.views.map((candidate) => candidate.id) ?? [],
      );
      if (!isAllowedPluginRequest(currentView, message, availableViewIds)) {
        respond(
          message.id,
          false,
          undefined,
          `Plugin view is not permitted to call ${message.method}`,
        );
        return;
      }
      if (message.method === "context.get") {
        respond(message.id, true, buildContext());
        return;
      }
      if (message.method === "navigate.openView") {
        const requestParams = message.params as { view?: unknown; params?: unknown };
        const nextParams = readStringRecord(requestParams.params);
        openPluginView({
          pluginId: pluginRef.current.id,
          viewId: String(requestParams.view),
          ...(nextParams ? { params: nextParams } : {}),
        });
        respond(message.id, true, {});
        return;
      }
      const requestParams = message.params as { method?: unknown; params?: unknown };
      try {
        const output = await invokePluginRpc(
          pluginRef.current.id,
          String(requestParams.method),
          requestParams.params,
        );
        respond(message.id, true, output);
      } catch (cause) {
        respond(
          message.id,
          false,
          undefined,
          cause instanceof Error ? cause.message : String(cause),
        );
      }
    },
    [buildContext, respond],
  );

  const handleRequestRef = useRef(handleRequest);
  useEffect(() => {
    handleRequestRef.current = handleRequest;
  }, [handleRequest]);

  useEffect(() => {
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const onMessage = (event: MessageEvent) => {
      const frame = iframeRef.current;
      if (!frame) return;
      if (!isTrustedPluginMessage(event, frame.contentWindow, session)) return;
      const message = parsePluginFrameMessage(event.data);
      if (!message) return;
      if (message.type === "ready") {
        readyRef.current = true;
        setReady(true);
        setError(null);
        postContext();
        return;
      }
      if (message.type === "resize") {
        if (!viewRef.current || !canResizePluginView(viewRef.current)) return;
        setHeight(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.round(message.height))));
        return;
      }
      timers.set(
        message.id,
        setTimeout(() => {
          timers.delete(message.id);
          respond(
            message.id,
            false,
            undefined,
            requestTimeoutError(message.method, REQUEST_TIMEOUT_MS),
          );
        }, REQUEST_TIMEOUT_MS),
      );
      void handleRequestRef.current(message).finally(() => {
        const timer = timers.get(message.id);
        if (timer) {
          clearTimeout(timer);
          timers.delete(message.id);
        }
      });
    };
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, [postContext, respond, session]);

  if (!view || !src) {
    return <PluginNativeOnlyNotice className={className} />;
  }

  return (
    <div
      className={cn(
        "relative w-full overflow-hidden rounded-xl border border-border/60 bg-background",
        fill && "h-full rounded-none border-0",
        className,
      )}
      style={fill ? undefined : { height }}
    >
      <iframe
        ref={iframeRef}
        title={`${plugin.name ?? plugin.id} · ${view.title}`}
        // `allow-scripts` only: no `allow-same-origin`, so the frame has an opaque origin, cannot
        // read host storage, cookies, or the bridge response body.
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        src={src}
        onLoad={postContext}
        className="h-full w-full border-0 bg-background"
      />
      {ready ? null : (
        <div className="absolute inset-0 flex items-center justify-center bg-background/85 px-4 text-center text-ui-sm text-muted-foreground">
          {error === "mobileOnly" ? (
            t("common:pluginViewMobileOnly")
          ) : error === "loadFailed" ? (
            t("common:pluginViewLoadFailed")
          ) : (
            <Spinner />
          )}
        </div>
      )}
    </div>
  );
}

function readStringRecord(value: unknown): Record<string, string> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") result[key] = entry;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}
