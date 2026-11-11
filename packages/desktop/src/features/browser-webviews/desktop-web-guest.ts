import {
  ClipboardItem,
  clipboard,
  ipcMain,
  webContents as allWebContents,
  type WebContents,
} from "electron";

import { getNeolixBrowserWebviewRegistry } from "./index.js";

interface GuestCommandInput {
  webContentsId: number;
  command: string;
  url?: string;
}

interface GuestEventPayload {
  webContentsId: number;
  type: "loading" | "navigate" | "title" | "favicon" | "error" | "destroyed";
  isLoading?: boolean;
  url?: string;
  title?: string;
  faviconUrl?: string | null;
  canGoBack?: boolean;
  canGoForward?: boolean;
  message?: string;
}

const ALLOWED_NAVIGATION_PROTOCOLS = new Set(["http:", "https:", "about:"]);
const forwardedWebContentsIds = new Set<number>();

/** True when this guest was registered by the host window that is asking. */
function readRegisteredGuest(
  rawWebContentsId: unknown,
  hostWebContentsId: number,
): WebContents | null {
  if (
    typeof rawWebContentsId !== "number" ||
    !Number.isInteger(rawWebContentsId) ||
    rawWebContentsId <= 0
  ) {
    return null;
  }
  const registration =
    getNeolixBrowserWebviewRegistry().getRegistrationForWebContents(rawWebContentsId);
  if (!registration || registration.hostWebContentsId !== hostWebContentsId) {
    return null;
  }
  const contents = allWebContents.fromId(rawWebContentsId);
  if (!contents || contents.isDestroyed()) {
    return null;
  }
  return contents;
}

function isAllowedNavigationUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return ALLOWED_NAVIGATION_PROTOCOLS.has(url.protocol);
  } catch {
    return false;
  }
}

/**
 * Forward guest page events to the renderer-owned browser state. The web UI
 * creates the `<webview>` itself; this only supplies the navigation metadata a
 * main-process browser manager would normally publish.
 */
export function forwardBrowserGuestEvents(contents: WebContents, host: WebContents): void {
  if (forwardedWebContentsIds.has(contents.id)) {
    return;
  }
  forwardedWebContentsIds.add(contents.id);

  const send = (payload: Omit<GuestEventPayload, "webContentsId">): void => {
    if (host.isDestroyed() || contents.isDestroyed()) {
      return;
    }
    host.send("neolix:event:browser-guest", { webContentsId: contents.id, ...payload });
  };

  contents.on("did-start-loading", () => send({ type: "loading", isLoading: true }));
  contents.on("did-stop-loading", () => send({ type: "loading", isLoading: false }));
  contents.on("did-navigate", (_event, url) => {
    send({
      type: "navigate",
      url,
      canGoBack: contents.canGoBack(),
      canGoForward: contents.canGoForward(),
    });
  });
  contents.on("did-navigate-in-page", (_event, url, isMainFrame) => {
    if (!isMainFrame) return;
    send({
      type: "navigate",
      url,
      canGoBack: contents.canGoBack(),
      canGoForward: contents.canGoForward(),
    });
  });
  contents.on("page-title-updated", (_event, title) => send({ type: "title", title }));
  contents.on("page-favicon-updated", (_event, favicons) => {
    send({ type: "favicon", faviconUrl: favicons[0] ?? null });
  });
  contents.on("did-fail-load", (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
    // -3 is ERR_ABORTED, which a normal navigation replacement causes.
    if (!isMainFrame || errorCode === -3) return;
    send({
      type: "error",
      url: validatedUrl,
      message: `${errorDescription} (${errorCode})`,
    });
  });
  contents.once("destroyed", () => {
    forwardedWebContentsIds.delete(contents.id);
    // `send` skips a destroyed guest, so the final event bypasses that guard.
    if (!host.isDestroyed()) {
      host.send("neolix:event:browser-guest", {
        webContentsId: contents.id,
        type: "destroyed",
      } satisfies GuestEventPayload);
    }
  });
}

async function runGuestCommand(contents: WebContents, input: GuestCommandInput): Promise<unknown> {
  switch (input.command) {
    case "navigate": {
      if (typeof input.url !== "string" || !isAllowedNavigationUrl(input.url)) {
        throw new Error("Unsupported browser URL");
      }
      await contents.loadURL(input.url);
      return null;
    }
    case "reload":
      contents.reload();
      return null;
    case "goBack":
      if (contents.canGoBack()) contents.goBack();
      return null;
    case "goForward":
      if (contents.canGoForward()) contents.goForward();
      return null;
    case "stop":
      contents.stop();
      return null;
    case "openDevTools":
      contents.openDevTools({ mode: "detach" });
      return null;
    case "focus":
      contents.focus();
      return null;
    case "capturePage": {
      const image = await contents.capturePage();
      const png = image.toPNG();
      return {
        dataUrl: image.toDataURL(),
        png: new Uint8Array(png),
      };
    }
    case "copyLink": {
      if (typeof input.url !== "string") {
        throw new Error("Missing browser URL");
      }
      clipboard.writeText(input.url);
      return null;
    }
    case "copyScreenshot": {
      const image = await contents.capturePage();
      if (image.isEmpty()) {
        throw new Error("The browser page is not available for a screenshot");
      }
      const png = image.toPNG();
      const bytes = new Uint8Array(png.byteLength);
      bytes.set(png);
      await clipboard.write([
        new ClipboardItem({ "image/png": new Blob([bytes], { type: "image/png" }) }),
      ]);
      return null;
    }
    default:
      throw new Error(`Unknown browser guest command: ${input.command}`);
  }
}

export function registerDesktopWebBrowserGuestIpc(): void {
  ipcMain.handle("neolix:browser:guest-command", async (event, rawInput: unknown) => {
    if (typeof rawInput !== "object" || rawInput === null || Array.isArray(rawInput)) {
      throw new Error("Invalid browser guest command");
    }
    const input = rawInput as GuestCommandInput;
    const contents = readRegisteredGuest(input.webContentsId, event.sender.id);
    if (!contents) {
      throw new Error("Browser guest is not registered to this window");
    }
    return runGuestCommand(contents, input);
  });
}
