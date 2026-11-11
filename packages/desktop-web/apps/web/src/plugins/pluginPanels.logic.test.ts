import type { NeolixPluginFilePanel } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import type { PluginFilePanelEntry } from "./contributions";
import {
  filePanelMatchesPath,
  filePanelSelectorKeys,
  filePanelSettingsRows,
  parsePluginPanelKey,
  pluginPanelKey,
  resolveFilePanelEntry,
} from "./pluginPanels.logic";

function entry(
  pluginId: string,
  panelId: string,
  files: NeolixPluginFilePanel["files"],
): PluginFilePanelEntry {
  return {
    pluginId,
    pluginName: pluginId,
    contribution: { id: panelId, title: panelId, files, view: "main" },
  };
}

describe("plugin panel keys", () => {
  it("round-trips plugin panel ids", () => {
    expect(parsePluginPanelKey(pluginPanelKey("pdf-panel", "pdf"))).toEqual({
      pluginId: "pdf-panel",
      panelId: "pdf",
    });
    expect(parsePluginPanelKey("builtin")).toBeNull();
    expect(parsePluginPanelKey("plugin:")).toBeNull();
  });
});

describe("file panel matching", () => {
  const pdf = entry("pdf-panel", "pdf", { extensions: ["PDF"] });
  const readme = entry("notes", "readme", { extensions: [], filenames: ["README.md"] });

  it("matches by extension case-insensitively and by exact filename", () => {
    expect(filePanelMatchesPath(pdf.contribution, "docs/manual.PDF")).toBe(true);
    expect(filePanelMatchesPath(pdf.contribution, "docs/manual.md")).toBe(false);
    expect(filePanelMatchesPath(readme.contribution, "README.md")).toBe(true);
    expect(filePanelMatchesPath(readme.contribution, "readme.md")).toBe(false);
  });

  it("lists both extension and filename selector keys", () => {
    expect(filePanelSelectorKeys(pdf.contribution)).toEqual(["ext:pdf"]);
    expect(filePanelSelectorKeys(readme.contribution)).toEqual(["name:README.md"]);
  });

  it("prefers a filename association over an extension association", () => {
    const panels = [pdf, readme];
    expect(
      resolveFilePanelEntry({
        path: "README.md",
        panels,
        associations: { "ext:md": pluginPanelKey("pdf-panel", "pdf") },
      })?.contribution.id,
    ).toBe("readme");
  });

  it("honors an explicit built-in association, otherwise takes the first claim", () => {
    const panels = [pdf];
    expect(
      resolveFilePanelEntry({
        path: "docs/manual.pdf",
        panels,
        associations: { "ext:pdf": "builtin" },
      }),
    ).toBeNull();
    expect(
      resolveFilePanelEntry({ path: "docs/manual.pdf", panels, associations: {} })?.pluginId,
    ).toBe("pdf-panel");
  });

  it("builds one settings row per claimed selector with its candidates", () => {
    const rows = filePanelSettingsRows([
      pdf,
      entry("other", "pdf-too", { extensions: ["pdf", "ps"] }),
    ]);
    expect(rows.map((row) => row.selectorKey)).toEqual(["ext:pdf", "ext:ps"]);
    expect(rows[0]?.candidates.map((candidate) => candidate.pluginId)).toEqual([
      "pdf-panel",
      "other",
    ]);
  });
});
