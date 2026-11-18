// FILE: AdvancedSettingsPanel.browser.tsx
// Purpose: Browser characterization for advanced-settings ownership and disclosure behavior.
// Layer: Browser UI test

import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "vitest-browser-react";

const harness = vi.hoisted(() => ({
  config: {
    keybindingsConfigPath: "/tmp/keybindings.json",
    availableEditors: [],
  },
  auth: { authenticated: true, role: "client" },
  hostStatus: null as null | {
    listen: string | null;
    publicUrl?: string | null;
    home?: string | null;
  },
  notices: "Neox third-party notices\n========================",
  threadShells: [] as unknown[],
  allThreadsMessageless: false,
  projects: [{ id: "project-1" }],
  threadsHydrated: true,
  syncServerReadModel: vi.fn(),
}));

const native = vi.hoisted(() => ({
  confirm: vi.fn(
    async (
      _message: string,
      _options?: { confirmLabel?: string; destructive?: boolean },
    ): Promise<boolean> => true,
  ),
}));

const hostApi = vi.hoisted(() => ({
  getHostStatus: vi.fn(),
  getThirdPartyNotices: vi.fn(async () => ({ notices: harness.notices })),
}));

vi.mock("~/nativeApi", () => {
  const api = () => ({
    dialogs: { confirm: native.confirm },
    shell: {
      openExternal: async (url: string) => {
        window.open(url, "_blank", "noopener,noreferrer");
      },
    },
  });
  return {
    readNativeApi: api,
    ensureNativeApi: api,
  };
});

vi.mock("~/lib/neolixHostApi", () => ({
  getHostConfig: vi.fn(),
  getHostStatus: hostApi.getHostStatus,
  patchHostConfig: vi.fn(),
  getThirdPartyNotices: hostApi.getThirdPartyNotices,
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey: readonly string[] }) => {
    if (options.queryKey[0] === "config") return { data: harness.config };
    if (options.queryKey[0] === "neolix-host-status") return { data: harness.hostStatus };
    return { data: harness.auth };
  },
  // The About section now hosts the command-line row, whose hook module uses these.
  useMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useQueryClient: () => ({ setQueryData: vi.fn(), invalidateQueries: vi.fn() }),
}));

vi.mock("~/lib/serverReactQuery", () => ({
  serverConfigQueryOptions: () => ({ queryKey: ["config"] }),
  serverAuthSessionQueryOptions: () => ({ queryKey: ["auth"] }),
}));

vi.mock("~/storeSelectors", () => ({
  createThreadShellsSelector: () => () => harness.threadShells,
  createAllThreadsMessagelessSelector: () => () => harness.allThreadsMessageless,
}));

vi.mock("~/store", () => ({
  useStore: (selector: (store: Record<string, unknown>) => unknown) =>
    selector({
      projects: harness.projects,
      threadsHydrated: harness.threadsHydrated,
      syncServerReadModel: harness.syncServerReadModel,
    }),
}));

import { AdvancedSettingsPanel } from "./AdvancedSettingsPanel";

function clickRowButton(id: string): void {
  const button = document.querySelector(`#${id} button`);
  if (!(button instanceof HTMLButtonElement)) throw new Error(`No button in #${id}`);
  button.click();
}

describe("AdvancedSettingsPanel", () => {
  afterEach(() => {
    cleanup();
    harness.hostStatus = null;
    native.confirm.mockReset();
    native.confirm.mockResolvedValue(true);
    delete (window as unknown as { neolixDesktop?: unknown }).neolixDesktop;
  });

  // Release history moved to the Help menu; this panel no longer links to it.
  it("owns recovery eligibility and shared disclosure motion", async () => {
    await render(
      <AdvancedSettingsPanel
        active
        onOpenReleaseHistory={vi.fn()}
        onReplayFeatureTour={vi.fn()}
        resetEpoch={0}
      />,
    );

    const repairButton = page.getByRole("button", { name: "Repair state" });
    expect((repairButton.element() as HTMLButtonElement).disabled).toBe(false);
    expect(document.body.textContent).toContain("Authenticated as client.");

    const disclosureButton = page.getByRole("button", { name: "What this does" });
    expect(disclosureButton.element().getAttribute("aria-expanded")).toBe("false");
    const disclosureShell = disclosureButton.element().parentElement?.querySelector("div[inert]");
    expect(disclosureShell?.className).toContain("duration-220");
    await disclosureButton.click();
    await vi.waitFor(() =>
      expect(disclosureButton.element().getAttribute("aria-expanded")).toBe("true"),
    );
  });

  it("opens the public repository from the About section", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    await render(
      <AdvancedSettingsPanel
        active
        onOpenReleaseHistory={vi.fn()}
        onReplayFeatureTour={vi.fn()}
        resetEpoch={0}
      />,
    );

    await expect.element(page.getByText("github.com/istoo/neox")).toBeVisible();
    clickRowButton("setting-website");
    await vi.waitFor(() =>
      expect(open).toHaveBeenCalledWith(
        "https://github.com/istoo/neox",
        "_blank",
        "noopener,noreferrer",
      ),
    );
    open.mockRestore();
  });

  it("opens the generated third-party license list", async () => {
    await render(
      <AdvancedSettingsPanel
        active
        onOpenReleaseHistory={vi.fn()}
        onReplayFeatureTour={vi.fn()}
        resetEpoch={0}
      />,
    );

    clickRowButton("setting-third-party-licenses");

    await expect.element(page.getByText("Neox third-party notices")).toBeVisible();
    (document.querySelector("[data-slot='dialog-footer'] button") as HTMLButtonElement).click();
    await vi.waitFor(() =>
      expect(document.body.textContent).not.toContain("Neox third-party notices"),
    );
  });

  it("opens the public repository's Discussions and Issues pages", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    await render(
      <AdvancedSettingsPanel
        active
        onOpenReleaseHistory={vi.fn()}
        onReplayFeatureTour={vi.fn()}
        resetEpoch={0}
      />,
    );

    await page.getByRole("button", { name: "Discussions" }).click();
    await page.getByRole("button", { name: "Report an issue" }).click();

    expect(open).toHaveBeenCalledWith(
      "https://github.com/istoo/neox/discussions",
      "_blank",
      "noopener,noreferrer",
    );
    expect(open).toHaveBeenCalledWith(
      "https://github.com/istoo/neox/issues/new/choose",
      "_blank",
      "noopener,noreferrer",
    );
    open.mockRestore();
  });

  it("shows the public address and status-line command another computer uses", async () => {
    harness.hostStatus = { listen: "127.0.0.1:6768", publicUrl: "https://neox.example.com/" };
    await render(
      <AdvancedSettingsPanel
        active
        onOpenReleaseHistory={vi.fn()}
        onReplayFeatureTour={vi.fn()}
        resetEpoch={0}
      />,
    );

    await expect.element(page.getByRole("heading", { name: "Public address" })).toBeVisible();
    await expect
      .element(page.getByRole("heading", { name: "Status line on another computer" }))
      .toBeVisible();
    await vi.waitFor(() => {
      expect(document.querySelector("#setting-public-address")?.textContent).toContain(
        "https://neox.example.com",
      );
      expect(document.querySelector("#setting-statusline-remote")?.textContent).toContain(
        "curl -fsS -m 1 -H 'Authorization: Bearer <gateway key>' --data-binary @- https://neox.example.com/v1/myna/statusline || true",
      );
    });
  });

  it("confirms an uninstall and names the data folder it deletes", async () => {
    harness.hostStatus = { listen: "127.0.0.1:6768", home: "/home/me/.neox" };
    const invoke = vi.fn(async (command: string) =>
      command === "get_cli_install_status" ? { installed: false } : { scheduled: true },
    );
    (window as unknown as { neolixDesktop?: unknown }).neolixDesktop = { invoke };

    await render(
      <AdvancedSettingsPanel
        active
        onOpenReleaseHistory={vi.fn()}
        onReplayFeatureTour={vi.fn()}
        resetEpoch={0}
      />,
    );

    await page.getByRole("button", { name: "Uninstall Neox" }).click();

    await vi.waitFor(() => expect(native.confirm).toHaveBeenCalled());
    expect(native.confirm.mock.calls[0]?.[0]).toContain("/home/me/.neox");
    expect(native.confirm.mock.calls[0]?.[1]).toMatchObject({
      confirmLabel: "Uninstall Neox",
      destructive: true,
    });
    await vi.waitFor(() =>
      expect(invoke.mock.calls.some(([command]) => command === "desktop_uninstall")).toBe(true),
    );
  });

  it("does not uninstall when the confirmation is declined", async () => {
    harness.hostStatus = { listen: "127.0.0.1:6768", home: "/home/me/.neox" };
    native.confirm.mockResolvedValue(false);
    const invoke = vi.fn(async (command: string) =>
      command === "get_cli_install_status" ? { installed: false } : { scheduled: true },
    );
    (window as unknown as { neolixDesktop?: unknown }).neolixDesktop = { invoke };

    await render(
      <AdvancedSettingsPanel
        active
        onOpenReleaseHistory={vi.fn()}
        onReplayFeatureTour={vi.fn()}
        resetEpoch={0}
      />,
    );

    await page.getByRole("button", { name: "Uninstall Neox" }).click();
    await vi.waitFor(() => expect(native.confirm).toHaveBeenCalled());
    expect(invoke.mock.calls.some(([command]) => command === "desktop_uninstall")).toBe(false);
  });
});
