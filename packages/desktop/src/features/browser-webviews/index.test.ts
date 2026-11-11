import { describe, expect, test } from "vitest";
import { NEOLIX_BROWSER_PROFILE_PARTITION } from "../browser-profile.js";
import {
  getNeolixBrowserIdForWebContents,
  getNeolixBrowserWorkspaceId,
  isNeolixBrowserWebviewAttach,
  prepareNeolixBrowserWebContents,
  registerAttachedNeolixBrowser,
  unregisterNeolixBrowser,
  unregisterNeolixBrowserFromHost,
} from "./index.js";

class FakeRenderer {
  public constructor(public readonly id: number) {}

  public isDestroyed(): boolean {
    return false;
  }
}

class FakeBrowserGuest {
  private destroyedListener: (() => void) | null = null;
  private destroyed = false;

  public constructor(
    public readonly id: number,
    public readonly hostWebContents: FakeRenderer,
    public readonly session: object,
  ) {}

  public isDestroyed(): boolean {
    return this.destroyed;
  }

  public once(event: "destroyed", listener: () => void): void {
    expect(event).toBe("destroyed");
    this.destroyedListener = listener;
  }

  public destroy(): void {
    this.destroyed = true;
    this.destroyedListener?.();
  }
}

describe("browser webview attachment", () => {
  test("accepts only allowed URLs on the shared profile partition", () => {
    expect(
      isNeolixBrowserWebviewAttach({
        src: "https://example.com",
        partition: NEOLIX_BROWSER_PROFILE_PARTITION,
      }),
    ).toBe(true);
    expect(
      isNeolixBrowserWebviewAttach({
        src: "https://example.com",
        partition: "persist:neolix-browser-tab-a",
      }),
    ).toBe(false);
    expect(
      isNeolixBrowserWebviewAttach({ src: "https://example.com", partition: "persist:foreign" }),
    ).toBe(false);
  });

  test("binds explicit browser identity to the renderer that hosts the guest", () => {
    const profileSession = {};
    const renderer = new FakeRenderer(1);
    const guest = new FakeBrowserGuest(101, renderer, profileSession);

    const registered = registerAttachedNeolixBrowser({
      browserId: "browser-a",
      workspaceId: "workspace-a",
      webContentsId: guest.id,
      sender: renderer,
      profileSession,
      findWebContents: () => guest,
    });

    expect(registered).toBe(true);
    expect(getNeolixBrowserIdForWebContents(guest)).toBe("browser-a");
    expect(getNeolixBrowserWorkspaceId("browser-a")).toBe("workspace-a");
    unregisterNeolixBrowser("browser-a");
  });

  test("rejects a guest hosted by another renderer", () => {
    const profileSession = {};
    const owner = new FakeRenderer(1);
    const claimant = new FakeRenderer(2);
    const guest = new FakeBrowserGuest(201, owner, profileSession);

    const registered = registerAttachedNeolixBrowser({
      browserId: "browser-rejected-owner",
      workspaceId: "workspace-a",
      webContentsId: guest.id,
      sender: claimant,
      profileSession,
      findWebContents: () => guest,
    });

    expect(registered).toBe(false);
    expect(getNeolixBrowserIdForWebContents(guest)).toBeNull();
  });

  test("rejects a guest outside the shared profile", () => {
    const profileSession = {};
    const renderer = new FakeRenderer(1);
    const guest = new FakeBrowserGuest(301, renderer, {});

    const registered = registerAttachedNeolixBrowser({
      browserId: "browser-rejected-profile",
      workspaceId: "workspace-a",
      webContentsId: guest.id,
      sender: renderer,
      profileSession,
      findWebContents: () => guest,
    });

    expect(registered).toBe(false);
    expect(getNeolixBrowserIdForWebContents(guest)).toBeNull();
  });

  test("concurrent windows cannot swap browser identities", () => {
    const profileSession = {};
    const firstRenderer = new FakeRenderer(1);
    const secondRenderer = new FakeRenderer(2);
    const firstGuest = new FakeBrowserGuest(401, firstRenderer, profileSession);
    const secondGuest = new FakeBrowserGuest(402, secondRenderer, profileSession);
    const guests = new Map([
      [firstGuest.id, firstGuest],
      [secondGuest.id, secondGuest],
    ]);

    registerAttachedNeolixBrowser({
      browserId: "browser-second",
      workspaceId: "workspace-second",
      webContentsId: secondGuest.id,
      sender: secondRenderer,
      profileSession,
      findWebContents: (id) => guests.get(id) ?? null,
    });
    registerAttachedNeolixBrowser({
      browserId: "browser-first",
      workspaceId: "workspace-first",
      webContentsId: firstGuest.id,
      sender: firstRenderer,
      profileSession,
      findWebContents: (id) => guests.get(id) ?? null,
    });

    expect(getNeolixBrowserIdForWebContents(firstGuest)).toBe("browser-first");
    expect(getNeolixBrowserIdForWebContents(secondGuest)).toBe("browser-second");
    unregisterNeolixBrowser("browser-first");
    unregisterNeolixBrowser("browser-second");
  });

  test("unregisters the same browser only from its requesting host", () => {
    const profileSession = {};
    const firstRenderer = new FakeRenderer(11);
    const secondRenderer = new FakeRenderer(22);
    const firstGuest = new FakeBrowserGuest(501, firstRenderer, profileSession);
    const secondGuest = new FakeBrowserGuest(502, secondRenderer, profileSession);

    for (const [renderer, guest] of [
      [firstRenderer, firstGuest],
      [secondRenderer, secondGuest],
    ] as const) {
      registerAttachedNeolixBrowser({
        browserId: "browser-shared-hosts",
        workspaceId: "workspace-shared",
        webContentsId: guest.id,
        sender: renderer,
        profileSession,
        findWebContents: () => guest,
      });
    }

    unregisterNeolixBrowserFromHost(firstRenderer.id, "browser-shared-hosts");

    expect(getNeolixBrowserIdForWebContents(firstGuest)).toBeNull();
    expect(getNeolixBrowserIdForWebContents(secondGuest)).toBe("browser-shared-hosts");
    expect(getNeolixBrowserWorkspaceId("browser-shared-hosts")).toBe("workspace-shared");
    unregisterNeolixBrowser("browser-shared-hosts");
  });

  test("removes registration when the guest is destroyed", () => {
    const profileSession = {};
    const renderer = new FakeRenderer(31);
    const guest = new FakeBrowserGuest(601, renderer, profileSession);
    prepareNeolixBrowserWebContents(guest);
    registerAttachedNeolixBrowser({
      browserId: "browser-cleanup",
      workspaceId: "workspace-cleanup",
      webContentsId: guest.id,
      sender: renderer,
      profileSession,
      findWebContents: () => guest,
    });

    expect(getNeolixBrowserIdForWebContents(guest)).toBe("browser-cleanup");

    guest.destroy();

    expect(getNeolixBrowserIdForWebContents(guest)).toBeNull();
  });
});
