import { useEffect, useState } from "react";
import { getIsElectron } from "@/constants/platform";
import { invokeDesktopCommand } from "@/desktop/electron/invoke";

/**
 * myna's `/api/fonts` (magpie/internal/fonts/fonts.go:56 List): the families
 * installed on this computer, for the appearance page's picker. Only the
 * desktop app can ask; other clients keep the free-form field.
 */
export function useSystemFontFamilies(): readonly string[] {
  const [families, setFamilies] = useState<readonly string[]>([]);

  useEffect(() => {
    if (!getIsElectron()) {
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const raw = await invokeDesktopCommand<unknown>("desktop_list_system_fonts");
        if (cancelled || !Array.isArray(raw)) {
          return;
        }
        const names = raw
          .map((entry) =>
            typeof entry === "object" && entry !== null && "name" in entry
              ? (entry as { name?: unknown }).name
              : null,
          )
          .filter((name): name is string => typeof name === "string" && name.trim() !== "");
        setFamilies(names);
      } catch {
        // An older desktop build has no font list; the field stays free-form.
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  return families;
}
