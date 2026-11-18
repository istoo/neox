import "../../../index.css";

import { page } from "vitest/browser";
import { beforeEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { JsonTreeView } from "./JsonTreeView";
import { JSON_LAZY_CHILD_THRESHOLD, resetJsonFolds } from "./jsonTree.logic";

beforeEach(() => {
  resetJsonFolds();
});

function wideObject(count: number): Record<string, number> {
  return Object.fromEntries(Array.from({ length: count }, (_, index) => [`k${index}`, index]));
}

describe("JsonTreeView", () => {
  it("draws a small body open and folds it from an accessible control", async () => {
    await render(
      <JsonTreeView
        value={{ model: "claude", messages: [{ role: "user", content: "hi" }] }}
        stateKey="call-1|request"
      />,
    );

    await expect.element(page.getByText(/"model":/)).toBeVisible();
    await expect.element(page.getByText("claude")).toBeVisible();
    await expect.element(page.getByText("hi")).toBeVisible();

    const collapse = page.getByRole("button", { name: "Collapse the JSON body" });
    expect(collapse.element().getAttribute("aria-expanded")).toBe("true");
    await collapse.click();

    const expand = page.getByRole("button", { name: "Expand the JSON body" });
    expect(expand.element().getAttribute("aria-expanded")).toBe("false");
    expect(page.getByText(/"model":/).query()).toBeNull();
  });

  it("keeps large containers folded until asked for, then pages their children", async () => {
    const count = JSON_LAZY_CHILD_THRESHOLD + 120;
    await render(<JsonTreeView value={wideObject(count)} stateKey="call-1|request" />);

    expect(page.getByText(/"k0":/).query()).toBeNull();
    await page.getByRole("button", { name: "Expand the JSON body" }).click();

    await expect.element(page.getByText(/"k0":/)).toBeVisible();
    expect(page.getByText(/"k100":/).query()).toBeNull();

    await page.getByRole("button", { name: /Show \d+ more/ }).click();
    await expect.element(page.getByText(/"k149":/)).toBeVisible();
  });

  it("offers a copy control for every value and key", async () => {
    await render(<JsonTreeView value={{ model: "claude" }} stateKey="call-1|request" />);

    await expect.element(page.getByRole("button", { name: "Copy model value" })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Copy model key" })).toBeVisible();
  });
});
