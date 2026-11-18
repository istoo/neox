/**
 * Pure helpers for pointing the desktop window at the daemon that serves the
 * web UI. The window can only load TCP addresses; a daemon on a unix socket or
 * Windows pipe is reported as a startup failure instead of a blank window.
 */

export type DesktopWebStartupLocale = "en" | "zh-CN";

/**
 * The language the startup pages speak: the Settings language when one is picked, otherwise
 * the system locale. Only the two shipped copies exist here; anything else reads as English.
 */
export function resolveDesktopWebStartupLocale(
  preference: string | undefined,
  systemLocale: string,
): DesktopWebStartupLocale {
  const chosen = preference?.trim().toLowerCase().replace(/_/g, "-");
  const source = chosen && chosen !== "system" ? chosen : systemLocale;
  return source.trim().toLowerCase().replace(/_/g, "-").split("-")[0] === "zh" ? "zh-CN" : "en";
}

const STARTUP_COPY: Record<
  DesktopWebStartupLocale,
  {
    readonly startingTitle: string;
    readonly waiting: string;
    readonly errorTitle: string;
    readonly errorBody: string;
    readonly unknownError: string;
    readonly retry: string;
    readonly retryHelp: string;
    readonly logs: string;
  }
> = {
  en: {
    startingTitle: "Neox is starting",
    waiting: "Waiting for the local server…",
    errorTitle: "Neox could not start",
    errorBody:
      "The desktop app could not reach the local server that serves its interface, so there is nothing to show yet.",
    unknownError: "Unknown error.",
    retry: "Retry",
    retryHelp: "If Retry keeps failing, quit Neox and start it again.",
    logs: "Logs:",
  },
  "zh-CN": {
    startingTitle: "Neox 正在启动",
    waiting: "正在等待本地服务…",
    errorTitle: "Neox 无法启动",
    errorBody: "桌面应用无法连接到提供界面的本地服务，因此暂时没有可显示的内容。",
    unknownError: "未知错误。",
    retry: "重试",
    retryHelp: "如果重试持续失败，请退出 Neox 后重新启动。",
    logs: "日志：",
  },
};

export const DESKTOP_WEB_READY_TIMEOUT_MS = 30_000;
export const DESKTOP_WEB_READY_INTERVAL_MS = 250;
const DESKTOP_WEB_PROBE_TIMEOUT_MS = 2_000;

/**
 * The error page's Retry link points at this origin; the main process cancels
 * the navigation and starts the daemon/web probe again.
 */
export const DESKTOP_WEB_STARTUP_RETRY_URL = "https://desktop-web-retry.invalid/retry";

export interface DesktopWebProbeResponse {
  readonly status: number;
  readonly body?: { cancel(): Promise<void> } | null;
}

export type DesktopWebProbeFetch = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<DesktopWebProbeResponse>;

/** A TCP listen address as a URL the window can load, or null for sockets. */
export function resolveDesktopWebBaseUrl(listen: string): string | null {
  const text = listen.trim();
  if (text.length === 0 || text.includes("/")) {
    return null;
  }

  let host: string;
  let port: number;
  const bracketed = /^\[([^\]]+)\]:(\d+)$/u.exec(text);
  if (bracketed !== null) {
    host = bracketed[1] ?? "";
    port = Number(bracketed[2]);
  } else {
    const colon = text.lastIndexOf(":");
    if (colon <= 0) {
      return null;
    }
    host = text.slice(0, colon);
    port = Number(text.slice(colon + 1));
    // More than one colon means an unbracketed IPv6 address, which is ambiguous.
    if (host.includes(":")) {
      return null;
    }
  }

  if (host.length === 0 || !Number.isInteger(port) || port <= 0 || port > 65_535) {
    return null;
  }

  // Wildcard binds are reachable on loopback, which is what the window loads.
  if (host === "0.0.0.0" || host === "::") {
    host = "127.0.0.1";
  }

  return `http://${host.includes(":") ? `[${host}]` : host}:${port}/`;
}

/** Normalizes `NEOLIX_DESKTOP_WEB_URL`, the vite dev server override. */
export function normalizeDesktopWebDevUrl(value: string): string | null {
  const text = value.trim();
  if (text.length === 0) {
    return null;
  }
  try {
    const url = new URL(text);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

export type DesktopWebProbe = "ready" | "starting" | "failed";

/**
 * The daemon serves 503 until its web module is loaded; anything else that is
 * not 200 means the address is answering, but not with the app.
 */
export function classifyDesktopWebProbe(status: number): DesktopWebProbe {
  if (status === 200) {
    return "ready";
  }
  if (status === 503) {
    return "starting";
  }
  return "failed";
}

export type DesktopWebReadyResult =
  | { readonly ok: true; readonly baseUrl: string }
  | { readonly ok: false; readonly reason: string };

export interface WaitForDesktopWebReadyInput {
  readonly baseUrl: string;
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
  readonly fetchImpl?: DesktopWebProbeFetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Polls `GET <base>` until it returns 200, reporting why it never did. */
export async function waitForDesktopWebReady(
  input: WaitForDesktopWebReadyInput,
): Promise<DesktopWebReadyResult> {
  const timeoutMs = input.timeoutMs ?? DESKTOP_WEB_READY_TIMEOUT_MS;
  const intervalMs = input.intervalMs ?? DESKTOP_WEB_READY_INTERVAL_MS;
  const fetchImpl: DesktopWebProbeFetch =
    input.fetchImpl ?? ((url, init) => fetch(url, { signal: init?.signal }));
  const sleep =
    input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = input.now ?? Date.now;
  const deadline = now() + timeoutMs;
  let lastStatus: number | null = null;
  let lastError: string | null = null;

  input.log?.(`waiting for the web interface at ${input.baseUrl}`);
  for (;;) {
    try {
      const response = await fetchImpl(input.baseUrl, {
        signal: AbortSignal.timeout(Math.min(DESKTOP_WEB_PROBE_TIMEOUT_MS, timeoutMs)),
      });
      if (response.body) {
        await response.body.cancel().catch(() => undefined);
      }
      const probe = classifyDesktopWebProbe(response.status);
      if (probe === "ready") {
        return { ok: true, baseUrl: input.baseUrl };
      }
      if (probe === "failed") {
        return {
          ok: false,
          reason: `The local server at ${input.baseUrl} answered with HTTP ${response.status}.`,
        };
      }
      lastStatus = response.status;
      lastError = null;
    } catch (error) {
      lastError = describeError(error);
    }

    if (now() >= deadline) {
      break;
    }
    await sleep(intervalMs);
  }

  if (lastStatus !== null) {
    return {
      ok: false,
      reason: `The web interface at ${input.baseUrl} was still starting after ${timeoutMs / 1_000}s.`,
    };
  }
  return {
    ok: false,
    reason: `The local server at ${input.baseUrl} did not answer within ${timeoutMs / 1_000}s${
      lastError === null ? "." : `: ${lastError}`
    }`,
  };
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/gu,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ??
      character,
  );
}

export interface DesktopWebStartupErrorPageInput {
  readonly reason: string;
  readonly logPath: string;
  /** Defaults to English; the main process passes the resolved app language. */
  readonly locale?: DesktopWebStartupLocale;
}

/**
 * The page `createWindow` loads while the daemon probe runs. It keeps the window
 * visible during startup instead of leaving an invisible process for up to 30s.
 */
export function buildDesktopWebStartingHtml(
  options: { readonly locale?: DesktopWebStartupLocale } = {},
): string {
  const copy = STARTUP_COPY[options.locale ?? "en"];
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>${copy.startingTitle}</title><style>
:root{color-scheme:light dark;--bg:#fff;--fg:#111;--muted:#666;--line:#ddd}
@media (prefers-color-scheme:dark){:root{--bg:#000;--fg:#fff;--muted:#999;--line:#333}}
html,body{margin:0;height:100%;background:var(--bg);color:var(--fg)}
body{font:13px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px}
h1{font-size:18px;margin:0;font-weight:500}.muted{color:var(--muted)}
.spinner{width:22px;height:22px;border:2px solid var(--line);border-top-color:var(--fg);border-radius:50%;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.spinner{animation:none}}
</style></head><body>
<span class="spinner" aria-hidden="true"></span>
<h1>${copy.startingTitle}</h1>
<p class="muted">${copy.waiting}</p>
</body></html>`;
}

/** A self-contained data URL, so the waiting page renders without the daemon. */
export function buildDesktopWebStartingUrl(
  options: { readonly locale?: DesktopWebStartupLocale } = {},
): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(buildDesktopWebStartingHtml(options))}`;
}

/** The page `createWindow` loads when the daemon never became reachable. */
export function buildDesktopWebStartupErrorHtml(input: DesktopWebStartupErrorPageInput): string {
  const copy = STARTUP_COPY[input.locale ?? "en"];
  const reason = input.reason.trim().length > 0 ? input.reason.trim() : copy.unknownError;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>${copy.errorTitle}</title><style>
:root{color-scheme:light dark;--bg:#fff;--fg:#111;--muted:#666;--line:#ddd;--code:#f4f4f4}
@media (prefers-color-scheme:dark){:root{--bg:#000;--fg:#fff;--muted:#999;--line:#333;--code:#111}}
html,body{margin:0;height:100%;background:var(--bg);color:var(--fg)}
body{font:13px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif;padding:28px;box-sizing:border-box;display:flex;flex-direction:column;gap:14px}
h1{font-size:18px;margin:0}p{margin:0}.muted{color:var(--muted)}
.actions{display:flex;gap:8px;flex-wrap:wrap}
.button{color:var(--fg);text-decoration:none;border:1px solid var(--line);border-radius:6px;padding:6px 12px}
.button.primary{background:var(--fg);color:var(--bg);border-color:var(--fg)}
code{background:var(--code);border:1px solid var(--line);border-radius:4px;padding:1px 4px;font:11px/1.4 ui-monospace,Menlo,Consolas,monospace;word-break:break-word}
</style></head><body>
<h1>${copy.errorTitle}</h1>
<p>${copy.errorBody}</p>
<p>${escapeHtml(reason)}</p>
<div class="actions"><a class="button primary" href="${DESKTOP_WEB_STARTUP_RETRY_URL}">${copy.retry}</a></div>
<p class="muted">${copy.retryHelp}</p>
<p class="muted">${copy.logs} <code>${escapeHtml(input.logPath)}</code></p>
</body></html>`;
}

/** A self-contained data URL, so the page renders without the daemon. */
export function buildDesktopWebStartupErrorUrl(input: DesktopWebStartupErrorPageInput): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(buildDesktopWebStartupErrorHtml(input))}`;
}
