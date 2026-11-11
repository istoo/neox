import { afterEach, describe, expect, it } from "vitest";

import { setLanguagePreference } from "~/i18n";
import { installDiffsLocalization } from "./diffsLocalization";

describe("installDiffsLocalization", () => {
  afterEach(() => {
    setLanguagePreference("en");
    globalThis.__synaraDiffsHunkSeparatorLabels = undefined;
  });

  it("gives @pierre/diffs hunk separators in the current language", () => {
    installDiffsLocalization();
    const labels = globalThis.__synaraDiffsHunkSeparatorLabels;
    expect(labels?.collapsedLines(1)).toBe("1 unmodified line");
    expect(labels?.collapsedLines(53)).toBe("53 unmodified lines");

    setLanguagePreference("zh-CN");
    expect(labels?.collapsedLines(53)).toBe("53 行未修改");
    expect(labels?.moreContext).toBe("可能还有更多未修改的上下文");
  });
});
