import { describe, expect, it } from "vitest";

import { t } from "~/i18n";
import { speechModelDisplayLabel } from "./speechModelLabel";

describe("speechModelDisplayLabel", () => {
  it("translates the language and keeps the model name", () => {
    const zh = ((key: string, options?: Record<string, unknown>) =>
      key === "settings:speechModelWithLanguage"
        ? `${String(options?.model)}（${String(options?.language)}）`
        : (({ "settings:speechLanguage_chineseEnglish": "中英双语" } as Record<string, string>)[
            key
          ] ?? key)) as unknown as typeof t;
    expect(speechModelDisplayLabel("Kokoro (Chinese and English)", zh)).toBe("Kokoro（中英双语）");
    expect(speechModelDisplayLabel("Piper Alba (British English)")).toBe(
      "Piper Alba (British English)",
    );
  });

  it("leaves labels without a known language untouched", () => {
    expect(speechModelDisplayLabel("Whisper Base")).toBe("Whisper Base");
    expect(speechModelDisplayLabel("Parakeet (Klingon)")).toBe("Parakeet (Klingon)");
  });
});
