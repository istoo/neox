import "../../index.css";

import { page } from "vitest/browser";
import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { ThreadErrorBanner } from "./ThreadErrorBanner";
import { TurnHeaderLine } from "./TurnHeaderLine";
import { summarizeTurnFailureReason } from "./MessagesTimeline.logic";

const RAW = [
  "invalid_request_error: prompt is too long: 250000 tokens > 200000 maximum",
  "request id: req_123",
  "model: claude-sonnet",
  "endpoint: /v1/messages",
].join("\n");

describe("provider failure summary", () => {
  it("shows a localized cause in the turn header and keeps the provider's words in details", async () => {
    const reason = summarizeTurnFailureReason({ message: RAW });
    expect(reason).toBe("the conversation is too long for this model — start a new chat");

    await render(
      <div>
        <TurnHeaderLine
          kind="settled"
          fontSize={12}
          header={{
            elapsed: "3s",
            endedAt: "2026-01-01T00:00:04Z",
            outcome: "interrupted",
            reason,
            resumedBy: null,
          }}
        />
        <ThreadErrorBanner error={RAW} />
      </div>,
    );

    await expect.element(page.getByText(/the conversation is too long/)).toBeVisible();
    const header = document.querySelector('[data-turn-header="interrupted"]');
    expect(header?.textContent).toContain("the conversation is too long");
    expect(header?.textContent).not.toContain("prompt is too long");

    await page.getByRole("button", { name: "Show details" }).click();
    const detailsId = page
      .getByRole("button", { name: "Hide details" })
      .element()
      .getAttribute("aria-controls");
    expect(document.getElementById(detailsId!)?.textContent).toBe(RAW);
  });
});
