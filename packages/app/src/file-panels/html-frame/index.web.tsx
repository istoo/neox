import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";

const frameStyle = { flex: 1, minHeight: 0, border: "none", backgroundColor: "white" } as const;
const autoHeightStyle = {
  width: "100%",
  border: "none",
  backgroundColor: "white",
} as const;

interface HtmlFrameProps {
  html: string;
  testID?: string;
  /** Sizes the frame to the height the page reports, for an embedded panel. */
  autoHeight?: boolean;
  bridge?(message: unknown): unknown | Promise<unknown>;
}

export interface HtmlFrameHandle {
  post(event: { event: string; data?: unknown }): void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A plugin's own HTML in an isolated frame. Scripts run, but the frame's
 * origin is opaque: it reaches neither the app's storage nor its DOM, and
 * it cannot navigate the app. `bridge` answers the page's messages in the
 * myna page protocol (`{ myna: 1, id, method, params }`).
 */
export const HtmlFrame = forwardRef<HtmlFrameHandle, HtmlFrameProps>(function HtmlFrame(
  { html, testID, autoHeight = false, bridge },
  ref,
) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const bridgeRef = useRef(bridge);
  bridgeRef.current = bridge;
  const autoHeightRef = useRef(autoHeight);
  autoHeightRef.current = autoHeight;
  const [height, setHeight] = useState<number | null>(null);

  useImperativeHandle(
    ref,
    () => ({
      post(event) {
        frameRef.current?.contentWindow?.postMessage({ myna: 1, ...event }, "*");
      },
    }),
    [],
  );

  useEffect(() => {
    function answer(frame: HTMLIFrameElement, id: number, outcome: Record<string, unknown>) {
      frame.contentWindow?.postMessage({ myna: 1, id, ...outcome }, "*");
    }
    function onMessage(event: MessageEvent) {
      const frame = frameRef.current;
      if (!frame || event.source !== frame.contentWindow) return;
      const data: unknown = event.data;
      if (typeof data !== "object" || data === null) return;
      const message = data as { myna?: unknown; id?: unknown };
      if (message.myna !== 1) return;
      const body = data as { method?: unknown; params?: { height?: unknown } };
      if (autoHeightRef.current && body.method === "size") {
        const next = body.params?.height;
        if (typeof next === "number" && Number.isFinite(next)) {
          setHeight(Math.max(40, Math.ceil(next)));
        }
      }
      const id = typeof message.id === "number" ? message.id : null;
      let answerValue: unknown;
      try {
        answerValue = bridgeRef.current?.(data);
      } catch (error) {
        if (id !== null) answer(frame, id, { error: errorMessage(error) });
        return;
      }
      if (id === null) {
        Promise.resolve(answerValue).catch(() => undefined);
        return;
      }
      Promise.resolve(answerValue).then(
        (result) => answer(frame, id, { result: result === undefined ? null : result }),
        (error: unknown) => answer(frame, id, { error: errorMessage(error) }),
      );
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const style = useMemo(
    () => (autoHeight ? { ...autoHeightStyle, height: height ?? 120 } : frameStyle),
    [autoHeight, height],
  );

  return (
    <iframe
      ref={frameRef}
      title="Plugin page"
      data-testid={testID}
      srcDoc={html}
      sandbox="allow-scripts allow-forms allow-modals allow-popups"
      referrerPolicy="no-referrer"
      style={style}
    />
  );
});
