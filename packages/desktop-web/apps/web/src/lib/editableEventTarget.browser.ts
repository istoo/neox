// FILE: editableEventTarget.browser.ts
// Purpose: Browser regressions for hasOpenDismissibleOverlay (which visible overlays block
//          terminal focus and global shortcuts).
// Layer: Web UI utility tests

import { afterEach, expect, it } from "vitest";

import { hasOpenDismissibleOverlay } from "./editableEventTarget";

afterEach(() => {
  document.body.innerHTML = "";
});

it("treats a visible dialog outside the surface as an open overlay", () => {
  document.body.innerHTML = "<div id='surface'>terminal</div><div role='dialog'>commit</div>";
  expect(hasOpenDismissibleOverlay(document.querySelector("#surface"))).toBe(true);
});

it("ignores a dialog that contains the surface", () => {
  document.body.innerHTML = "<div role='dialog'><div id='surface'>terminal</div></div>";
  expect(hasOpenDismissibleOverlay(document.querySelector("#surface"))).toBe(false);
});

it("ignores toasts, which render role=dialog but never own the keyboard", () => {
  document.body.innerHTML = [
    "<div id='surface'>terminal</div>",
    "<div data-slot='toast-viewport'><div role='dialog'>已提交 abc123</div></div>",
    "<div data-slot='toast-viewport-anchored'><div role='dialog'>copied</div></div>",
  ].join("");
  expect(hasOpenDismissibleOverlay(document.querySelector("#surface"))).toBe(false);
  expect(hasOpenDismissibleOverlay()).toBe(false);
});
