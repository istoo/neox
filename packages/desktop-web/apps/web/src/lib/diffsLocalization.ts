// Localizes the copy that @pierre/diffs renders itself. The package hard-codes its hunk
// separator text ("N unmodified lines"); patches/@pierre%2Fdiffs@1.3.5.patch makes it read
// these labels, resolved at render time so a language switch applies to the next render.
// Exports: installDiffsLocalization

import { t } from "~/i18n";

interface DiffsHunkSeparatorLabels {
  collapsedLines: (lines: number) => string;
  readonly moreContext: string;
}

declare global {
  var __synaraDiffsHunkSeparatorLabels: DiffsHunkSeparatorLabels | undefined;
}

export function installDiffsLocalization(): void {
  globalThis.__synaraDiffsHunkSeparatorLabels = {
    collapsedLines: (lines) => t("git:diffCollapsedLines", { count: lines }),
    get moreContext() {
      return t("git:diffMoreContext");
    },
  };
}
