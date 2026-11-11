import { describe, expect, it } from "vitest";

import {
  groupFaces,
  isValidFace,
  listSystemFonts,
  parseFcList,
  parseMacSystemProfiler,
  parseWindowsFontList,
  resetFontCacheForTests,
  type SystemFontFace,
} from "./fonts";

const FACE: SystemFontFace = {
  family: "Inter",
  name: "Regular",
  weight: 400,
  style: "normal",
  stretch: 100,
};

describe("fonts", () => {
  it("validates the way myna's Validate does", () => {
    expect(isValidFace(FACE)).toBe(true);
    expect(isValidFace({ ...FACE, family: "  " })).toBe(false);
    expect(isValidFace({ ...FACE, name: "a\u0000b" })).toBe(false);
    expect(isValidFace({ ...FACE, weight: 0 })).toBe(false);
    expect(isValidFace({ ...FACE, weight: 1001 })).toBe(false);
    expect(isValidFace({ ...FACE, style: "slanted" as never })).toBe(false);
    expect(isValidFace({ ...FACE, stretch: -1 })).toBe(false);
  });

  it("groups, de-duplicates and sorts families and their styles", () => {
    const families = groupFaces([
      { ...FACE, family: "Inter ", name: " Bold ", weight: 700 },
      FACE,
      { ...FACE, name: "Italic", style: "italic" },
      { ...FACE, family: "Arial" },
      { ...FACE, family: "Inter", name: "Bold", weight: 700 },
    ]);
    expect(families.map((family) => family.name)).toEqual(["Arial", "Inter"]);
    expect(families[1]?.styles.map((face) => face.name)).toEqual(["Regular", "Italic", "Bold"]);
  });

  it("reads fc-list's families, styles and slants", () => {
    const faces = parseFcList(
      [
        "DejaVu Sans,DejaVu Sans Book\tBook\t400\t0\t100",
        "DejaVu Sans\tOblique\t400\t110\t100",
        "Bad\tThin\t0\t0\t100",
      ].join("\n"),
    );
    expect(faces).toHaveLength(4);
    expect(faces[0]).toMatchObject({ family: "DejaVu Sans", style: "normal" });
    expect(faces[1]).toMatchObject({ family: "DejaVu Sans Book", name: "Book" });
    expect(faces[2]).toMatchObject({ style: "oblique" });
  });

  it("reads macOS's localized font JSON by family", () => {
    const faces = parseMacSystemProfiler(
      JSON.stringify({
        SPFontsDataType: [
          {
            typefaces: [
              {
                family: "JetBrainsMono Nerd Font",
                style: "常规体",
                fullname: "JetBrainsMono NF Regular",
              },
              { family: "Helvetica", style: "Bold Italic" },
            ],
          },
        ],
      }),
    );
    expect(faces).toEqual([
      {
        family: "JetBrainsMono Nerd Font",
        name: "常规体",
        weight: 400,
        style: "normal",
        stretch: 100,
      },
      { family: "Helvetica", name: "Bold Italic", weight: 700, style: "italic", stretch: 100 },
    ]);
  });

  it("survives a broken system_profiler document", () => {
    expect(parseMacSystemProfiler("not json")).toEqual([]);
  });

  it("reads a Windows family list", () => {
    expect(parseWindowsFontList("Arial\r\nConsolas\r\n\r\n")).toHaveLength(2);
  });

  it("uses the injected runner and caches a successful read", async () => {
    resetFontCacheForTests();
    let calls = 0;
    const run = async () => {
      calls += 1;
      return "Inter\tRegular\t400\t0\t100";
    };
    const first = await listSystemFonts({ platform: "linux", run });
    const second = await listSystemFonts({ platform: "linux", run });
    expect(calls).toBe(1);
    expect(second).toBe(first);
    expect(first[0]?.name).toBe("Inter");

    await listSystemFonts({ platform: "linux", run, refresh: true });
    expect(calls).toBe(2);
    resetFontCacheForTests();
  });
});
