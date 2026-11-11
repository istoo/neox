import "../index.css";

import type { DesktopUpdateState } from "@synara/contracts";
import { page, userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const settings = vi.hoisted(() => ({
  codexHomePath: "",
  railUsageProviders: ["codex", "claudeAgent"],
  railUsageWindow: "both",
}));
vi.mock("~/appSettings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/appSettings")>()),
  useAppSettings: () => ({ settings }),
}));

import { getAppTypographyScale } from "~/lib/appTypography";
import { DesktopUpdateRailButton } from "./DesktopUpdateRailButton";

const initial: DesktopUpdateState = {
  enabled: true,
  status: "downloading",
  currentVersion: "0.9.2",
  hostArch: "arm64",
  appArch: "arm64",
  runningUnderArm64Translation: false,
  availableVersion: "0.9.3",
  downloadedVersion: null,
  downloadPercent: 100,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
  installFailureCount: 0,
  flavor: "production",
  releaseUrl: null,
};

const previousFont = document.documentElement.style.getPropertyValue("--app-font-size-ui-2xs");
afterEach(() => {
  if (previousFont)
    document.documentElement.style.setProperty("--app-font-size-ui-2xs", previousFont);
  else document.documentElement.style.removeProperty("--app-font-size-ui-2xs");
});

describe("desktop update rail control", () => {
  it.each(["production", "beta"] as const)(
    "fits every percentage at supported UI sizes (%s)",
    async (flavor) => {
      const control = (percent: number) => (
        <div style={{ display: "flex" }}>
          <DesktopUpdateRailButton
            state={{ ...initial, flavor, downloadPercent: percent }}
            installing={false}
            onClick={vi.fn()}
          />
        </div>
      );
      const screen = await render(control(100));
      try {
        for (const font of [11, 13, 18]) {
          document.documentElement.style.setProperty(
            "--app-font-size-ui-2xs",
            `${getAppTypographyScale(font).ui2XsPx}px`,
          );
          for (const percent of [0, 99, 100]) {
            await screen.rerender(control(percent));
            const button = page
              .getByRole("button", { name: `Preparing update (${percent}%)`, exact: true })
              .element();
            const label = button.querySelector("span span")!;
            const disc = label.parentElement!.getBoundingClientRect();
            const range = document.createRange();
            range.selectNodeContents(label);
            const text = range.getBoundingClientRect();
            console.info("percentage bounds", {
              flavor,
              font,
              percent,
              textWidth: text.width,
              discWidth: disc.width,
            });
            expect(text.left).toBeGreaterThanOrEqual(disc.left - 0.5);
            expect(text.right).toBeLessThanOrEqual(disc.right + 0.5);
            const box = button.getBoundingClientRect();
            expect(disc.left).toBeGreaterThanOrEqual(box.left - 0.5);
            expect(disc.right).toBeLessThanOrEqual(box.right + 0.5);
            expect(getComputedStyle(label).fontSize).toBe(
              `${getAppTypographyScale(font).ui2XsPx}px`,
            );
            await expect
              .element(
                page.getByRole("button", { name: `Preparing update (${percent}%)`, exact: true }),
              )
              .toBeDisabled();
          }
        }
      } finally {
        await screen.unmount();
      }
    },
  );

  it("keeps the restart latch disabled and releases the control for a retry", async () => {
    const onClick = vi.fn();
    const ready = { ...initial, status: "downloaded" as const, downloadedVersion: "0.9.3" };
    const screen = await render(
      <DesktopUpdateRailButton state={ready} installing={false} onClick={onClick} />,
    );
    try {
      await page
        .getByRole("button", {
          name: "Update 0.9.3 is ready. Click to restart and install.",
          exact: true,
        })
        .click();
      expect(onClick).toHaveBeenCalledOnce();
      await screen.rerender(<DesktopUpdateRailButton state={ready} installing onClick={onClick} />);
      await expect
        .element(page.getByRole("button", { name: "Applying update...", exact: true }))
        .toBeDisabled();
      await screen.rerender(
        <DesktopUpdateRailButton
          state={{ ...ready, errorContext: "install" }}
          installing={false}
          onClick={onClick}
        />,
      );
      const retry = page.getByRole("button", {
        name: "Could not install update 0.9.3. Click to retry.",
        exact: true,
      });
      await expect.element(retry).toBeEnabled();
      retry.element().focus();
      await userEvent.keyboard("{Enter}");
      expect(onClick).toHaveBeenCalledTimes(2);
      await screen.rerender(
        <DesktopUpdateRailButton
          state={{ ...initial, status: "available" }}
          installing={false}
          onClick={onClick}
        />,
      );
      await expect
        .element(page.getByRole("button", { name: "Preparing update 0.9.3", exact: true }))
        .toBeDisabled();
      await screen.rerender(
        <DesktopUpdateRailButton
          state={{ ...initial, status: "available", errorContext: "download" }}
          installing={false}
          onClick={onClick}
        />,
      );
      const downloadRetry = page.getByRole("button", {
        name: "Could not prepare update 0.9.3. Click to retry.",
        exact: true,
      });
      await downloadRetry.click();
      expect(onClick).toHaveBeenCalledTimes(3);
      await screen.rerender(
        <DesktopUpdateRailButton
          state={{ ...initial, downloadPercent: null }}
          installing={false}
          onClick={onClick}
        />,
      );
      const preparing = page.getByRole("button", { name: "Preparing update", exact: true });
      await expect.element(preparing).toBeDisabled();
      expect(preparing.element().querySelector("svg")).not.toBeNull();
    } finally {
      await screen.unmount();
    }
  });
});
