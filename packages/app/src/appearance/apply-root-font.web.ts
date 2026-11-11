// Apply the interface (UI) font app-wide on web.
//
// react-native-web stamps a hardcoded default font onto every text element, so a
// plain `body { font-family }` never cascades in — the element already has its own
// font. Instead we inject ONE rule that points all text at a CSS variable and set
// that variable live. The selector is high-specificity (1,2,0) so it deterministically
// beats both RN-web's base font and Unistyles' generated classes (0,1,0) — no reliance
// on stylesheet order. Code/diff/terminal surfaces carry `data-pmono` (and have their
// subtree excluded via `:not([data-pmono] *)`) so they keep their monospace font. The
// wordmark carries `data-pdisplay` and keeps the display face the same way.
//
// The bundled faces match Synara's: JetBrains Mono for code, Cal Sans for the wordmark (both
// OFL-1.1). They load here because this module is web-only; native keeps platform fonts.
// fontsource's own CSS can't be imported: Metro doesn't rewrite its relative `url(./files/…)`,
// so the browser fetches the HTML fallback and rejects it. We import the woff2 files as
// assets (metro.config.cjs adds the extension) and declare the faces ourselves. Only the
// latin and latin-ext subsets ship; other scripts fall through to the next font in the stack.
import { Asset } from "expo-asset";
import calSansLatin from "@fontsource/cal-sans/files/cal-sans-latin-400-normal.woff2";
import calSansLatinExt from "@fontsource/cal-sans/files/cal-sans-latin-ext-400-normal.woff2";
import jetBrainsMonoLatin from "@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2";
import jetBrainsMonoLatinExt from "@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-ext-wght-normal.woff2";

const LATIN =
  "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD";
const LATIN_EXT =
  "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF";

const FONT_FACES: { family: string; weight: string; asset: number; range: string }[] = [
  { family: "JetBrains Mono Variable", weight: "100 800", asset: jetBrainsMonoLatin, range: LATIN },
  {
    family: "JetBrains Mono Variable",
    weight: "100 800",
    asset: jetBrainsMonoLatinExt,
    range: LATIN_EXT,
  },
  { family: "Cal Sans", weight: "400", asset: calSansLatin, range: LATIN },
  { family: "Cal Sans", weight: "400", asset: calSansLatinExt, range: LATIN_EXT },
];

function fontFaceRules(): string {
  return FONT_FACES.map(
    (face) =>
      `@font-face{font-family:"${face.family}";font-style:normal;font-display:swap;font-weight:${face.weight};src:url("${Asset.fromModule(face.asset).uri}") format("woff2");unicode-range:${face.range};}`,
  ).join("");
}

const STYLE_ID = "neolix-ui-font";
const RULE =
  ":is(#root, #overlay-root) *:not([data-pmono]):not([data-pmono] *):not([data-pdisplay]){font-family:var(--neolix-ui-font);}";

export function applyRootUiFont(uiFontStack: string): void {
  if (typeof document === "undefined") return;
  // Strip anything that could break out of the CSS value; commas/quotes/spaces in a
  // font stack are fine.
  const value = uiFontStack
    .replace(/[<>{}();]/g, "")
    .replace(/[\r\n]/g, " ")
    .trim();
  if (value.length === 0) return;

  document.documentElement.style.setProperty("--neolix-ui-font", value);

  // The rule itself is static (references the variable); inject it once.
  let style = document.getElementById(STYLE_ID);
  if (!style) {
    style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = fontFaceRules() + RULE;
    document.head.appendChild(style);
  }
}
