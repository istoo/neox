// The diff gutter's "+" opens the line comment box; submitting it reaches the
// composer draft as a file comment and renders the composer's comment chip.

import "../index.css";

import { parsePatchFiles } from "@pierre/diffs";
import { ThreadId } from "@synara/contracts";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { useComposerDraftStore } from "../composerDraftStore";
import { addChatFileComment } from "../lib/chatReferences";
import { FileCommentsSummaryChip } from "./chat/FileCommentsSummaryChip";
import { DiffPanelFileList } from "./DiffPanelFileList";

const THREAD_ID = ThreadId.makeUnsafe("diff-comment-thread");

const PATCH = [
  "diff --git a/src/app.ts b/src/app.ts",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,4 +1,4 @@ function f()",
  " aaa",
  " bbb",
  "-ccc",
  "+ccc2",
  " ddd",
  "",
].join("\n");

const FILE_DIFF = parsePatchFiles(PATCH)[0]!.files[0]!;

function ComposerComments() {
  const comments = useComposerDraftStore(
    (state) => state.draftsByThreadId[THREAD_ID]?.fileComments,
  );
  return <FileCommentsSummaryChip comments={comments ?? []} />;
}

function Harness() {
  return (
    <div>
      <div style={{ display: "flex", width: 900, height: 520, overflow: "hidden" }}>
        <DiffPanelFileList
          renderableFiles={[FILE_DIFF]}
          resolvedTheme="dark"
          diffRenderMode="stacked"
          diffWordWrap={false}
          workspaceRoot="/repo/project"
          collapsedFiles={new Set()}
          onToggleFileCollapsed={() => {}}
          chatActions={{
            onReferenceInChat: () => {},
            onAskWhyChanged: () => {},
            onCommentLine: (comment) => addChatFileComment(THREAD_ID, comment),
          }}
        />
      </div>
      <div data-testid="composer-comments">
        <ComposerComments />
      </div>
    </div>
  );
}

function createHost(): HTMLDivElement {
  const host = document.createElement("div");
  host.style.cssText = "display:flex;width:900px;height:560px;";
  document.body.append(host);
  return host;
}

function pointer(element: Element, type: string, rect: DOMRect, pointerId = 1): void {
  element.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      composed: true,
      cancelable: true,
      pointerId,
      pointerType: "mouse",
      isPrimary: true,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    }),
  );
}

async function waitFor<T>(read: () => T | null | undefined, what: string): Promise<NonNullable<T>> {
  const deadline = performance.now() + 8_000;
  while (performance.now() < deadline) {
    const value = read();
    if (value !== null && value !== undefined) return value as NonNullable<T>;
    await new Promise<void>((resolve) => setTimeout(resolve, 16));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

beforeEach(() => {
  useComposerDraftStore.setState({ draftsByThreadId: {} });
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("diff line comments", () => {
  it("turns a gutter comment into a composer chip", async () => {
    const host = createHost();
    const screen = await render(<Harness />, { container: host });
    try {
      const container = await waitFor(
        () => host.querySelector("diffs-container"),
        "the diff surface",
      );
      const shadow = await waitFor(() => container.shadowRoot ?? undefined, "the diff shadow root");
      const number = await waitFor(
        () => shadow.querySelector<HTMLElement>("[data-column-number]"),
        "a line number",
      );
      const row = await waitFor(
        () =>
          number.closest<HTMLElement>("[data-line]") ??
          shadow.querySelector<HTMLElement>("[data-line]"),
        "a diff row",
      );

      pointer(number, "pointermove", number.getBoundingClientRect());
      const gutter = await waitFor(
        () => shadow.querySelector<HTMLElement>("[data-gutter-utility-slot] button"),
        "the gutter comment button",
      );

      pointer(gutter, "pointerdown", gutter.getBoundingClientRect());
      pointer(row, "pointerup", row.getBoundingClientRect());

      const input = page.getByPlaceholder("Request change");
      await expect.element(input).toBeVisible();
      await input.fill("Please rename this value.");
      expect(document.body.textContent).toContain("Local comment");
      expect(document.body.textContent).toContain("Comment on line");

      await page.getByRole("button", { name: "Comment", exact: true }).click();

      await expect
        .poll(
          () => useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.fileComments.length,
        )
        .toBe(1);
      const comment =
        useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]!.fileComments[0]!;
      expect(comment).toMatchObject({
        path: "src/app.ts",
        text: "Please rename this value.",
      });
      expect(comment.startLine).toBeGreaterThan(0);
      expect(comment.endLine).toBe(comment.startLine);
      expect(comment.hunkContext).toContain("@@ -1,3 +1,3 @@ function f()");
      expect(comment.hunkContext).toContain("-ccc");
      expect(comment.hunkContext).toContain("+ccc2");

      await expect
        .poll(() => document.querySelector("[data-testid='composer-comments']")?.textContent ?? "")
        .toContain("1 comment");
    } finally {
      await screen.unmount();
      host.remove();
    }
  });
});
