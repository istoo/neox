import { forwardRef, useCallback, useImperativeHandle, useMemo, useRef, useState } from "react";
import { WebView } from "react-native-webview";

const frameStyle = { flex: 1, backgroundColor: "white" };

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
 * A plugin's own HTML in an isolated frame. Scripts run inside the frame;
 * it has no app storage, no file access, and no navigation away from the
 * document the plugin handed over. `bridge` answers the page's messages
 * (`{ myna: 1, id, method, params }`, sent through `ReactNativeWebView`).
 */
export const HtmlFrame = forwardRef<HtmlFrameHandle, HtmlFrameProps>(function HtmlFrame(
  { html, testID, autoHeight = false, bridge },
  ref,
) {
  const webViewRef = useRef<WebView>(null);
  const bridgeRef = useRef(bridge);
  bridgeRef.current = bridge;
  const [height, setHeight] = useState<number | null>(null);

  const post = useCallback((message: Record<string, unknown>) => {
    webViewRef.current?.postMessage(JSON.stringify(message));
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      post(event) {
        post({ myna: 1, ...event });
      },
    }),
    [post],
  );

  const onMessage = useCallback(
    (event: { nativeEvent: { data: string } }) => {
      let data: unknown;
      try {
        data = JSON.parse(event.nativeEvent.data);
      } catch {
        return;
      }
      if (typeof data !== "object" || data === null) return;
      const message = data as { myna?: unknown; id?: unknown };
      if (message.myna !== 1) return;
      const body = data as { method?: unknown; params?: { height?: unknown } };
      if (autoHeight && body.method === "size") {
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
        if (id !== null) post({ myna: 1, id, error: errorMessage(error) });
        return;
      }
      if (id === null) {
        Promise.resolve(answerValue).catch(() => undefined);
        return;
      }
      Promise.resolve(answerValue).then(
        (result) => post({ myna: 1, id, result: result === undefined ? null : result }),
        (error: unknown) => post({ myna: 1, id, error: errorMessage(error) }),
      );
    },
    [autoHeight, post],
  );

  const source = useMemo(() => ({ html, baseUrl: "about:blank" }), [html]);
  const allowDocument = useCallback(
    (request: { url: string }) => request.url === "about:blank",
    [],
  );
  const style = useMemo(
    () => (autoHeight ? { height: height ?? 120, backgroundColor: "white" } : frameStyle),
    [autoHeight, height],
  );
  return (
    <WebView
      ref={webViewRef}
      testID={testID}
      style={style}
      source={source}
      originWhitelist={["about:blank"]}
      onShouldStartLoadWithRequest={allowDocument}
      onMessage={onMessage}
      javaScriptCanOpenWindowsAutomatically={false}
      setSupportMultipleWindows={false}
      domStorageEnabled={false}
      thirdPartyCookiesEnabled={false}
      cacheEnabled={false}
      incognito
      allowFileAccess={false}
      allowFileAccessFromFileURLs={false}
      allowUniversalAccessFromFileURLs={false}
    />
  );
});
