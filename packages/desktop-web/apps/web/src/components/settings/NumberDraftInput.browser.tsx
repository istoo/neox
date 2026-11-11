import { page, userEvent } from "vitest/browser";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { NumberDraftInput } from "./NumberDraftInput";

const clamp = (value: number) => Math.min(4000, Math.max(600, Math.round(value)));

function Harness({ allowEmpty = false }: { allowEmpty?: boolean }) {
  const [value, setValue] = useState<number | null>(allowEmpty ? null : 900);
  return (
    <>
      <NumberDraftInput
        aria-label="width"
        value={value}
        normalize={clamp}
        allowEmpty={allowEmpty}
        onCommit={setValue}
      />
      <output data-testid="committed">{value === null ? "none" : String(value)}</output>
    </>
  );
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("NumberDraftInput", () => {
  it("lets a value be typed digit by digit and commits it on blur", async () => {
    await render(<Harness />);
    const input = page.getByLabelText("width");
    await userEvent.clear(input);
    await userEvent.type(input, "700");
    // Nothing is clamped while typing: "7" is not snapped to the minimum.
    await expect.element(input).toHaveValue(700);
    await expect.element(page.getByTestId("committed")).toHaveTextContent("900");
    await userEvent.tab();
    await expect.element(page.getByTestId("committed")).toHaveTextContent("700");
  });

  it("clamps on Enter and restores the value when the field is left empty", async () => {
    await render(<Harness />);
    const input = page.getByLabelText("width");
    await userEvent.clear(input);
    await userEvent.type(input, "99999{Enter}");
    await expect.element(page.getByTestId("committed")).toHaveTextContent("4000");
    await expect.element(input).toHaveValue(4000);
    await userEvent.clear(input);
    await userEvent.tab();
    await expect.element(input).toHaveValue(4000);
  });

  it("commits null for an emptied optional field and Escape abandons an edit", async () => {
    await render(<Harness allowEmpty />);
    const input = page.getByLabelText("width");
    await userEvent.type(input, "800{Enter}");
    await expect.element(page.getByTestId("committed")).toHaveTextContent("800");
    await userEvent.type(input, "5{Escape}");
    await expect.element(input).toHaveValue(800);
    await userEvent.clear(input);
    await userEvent.tab();
    await expect.element(page.getByTestId("committed")).toHaveTextContent("none");
  });
});
