// The Loading animations accessibility switch: skeletons sweep only while the
// setting is on, and stay still once it is turned off.

import "../../index.css";

import { beforeEach, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { APP_SETTINGS_STORAGE_KEY } from "../../appSettingsStorage";
import { Skeleton } from "./skeleton";

beforeEach(() => {
  localStorage.clear();
});

function skeletonElement(): HTMLElement {
  const element = document.querySelector<HTMLElement>('[data-slot="skeleton"]');
  if (!element) throw new Error("Expected a skeleton");
  return element;
}

it("sweeps while the loading animation is on by default", async () => {
  const screen = await render(<Skeleton className="h-4 w-40" data-testid="skeleton" />);
  try {
    await expect.element(screen.getByTestId("skeleton")).toBeVisible();
    expect(skeletonElement().className).toContain("animate-skeleton");
  } finally {
    await screen.unmount();
  }
});

it("stays still when the loading animation is turned off", async () => {
  localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({ loadingAnimation: false }));
  const screen = await render(<Skeleton className="h-4 w-40" data-testid="skeleton" />);
  try {
    await expect.element(screen.getByTestId("skeleton")).toBeVisible();
    expect(skeletonElement().className).not.toContain("animate-skeleton");
  } finally {
    await screen.unmount();
  }
});
