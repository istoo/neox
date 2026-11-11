import { describe, expect, it } from "vitest";
import { settingsPages } from "./settings-pages";

interface Tree {
  readonly [key: string]: string | Tree;
}

function flattenKeys(value: Tree, prefix = ""): string[] {
  return Object.entries(value).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return typeof child === "string" ? [path] : flattenKeys(child, path);
  });
}

function flattenStrings(value: Tree, prefix = ""): Record<string, string> {
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, child]) => {
      const path = prefix ? `${prefix}.${key}` : key;
      return typeof child === "string"
        ? [[path, child]]
        : Object.entries(flattenStrings(child, path));
    }),
  );
}

const interpolationPattern = /\{\{[^}]+\}\}/g;

function interpolations(value: string): string[] {
  return [...value.matchAll(interpolationPattern)].map((match) => match[0]).sort();
}

const locales = Object.keys(settingsPages) as (keyof typeof settingsPages)[];

describe("settings pages resources", () => {
  it("has all nine locales", () => {
    expect(locales.sort()).toEqual(
      ["ar", "en", "es", "fr", "ja", "ko", "pt-BR", "ru", "zh-CN"].sort(),
    );
  });

  it("keeps every locale's keys in sync with English", () => {
    const englishKeys = flattenKeys(settingsPages.en).sort();
    for (const locale of locales) {
      expect(flattenKeys(settingsPages[locale] as Tree).sort()).toEqual(englishKeys);
    }
  });

  it("keeps interpolation placeholders identical", () => {
    const english = flattenStrings(settingsPages.en);
    for (const locale of locales) {
      const strings = flattenStrings(settingsPages[locale] as Tree);
      for (const [key, value] of Object.entries(english)) {
        expect(interpolations(strings[key] ?? ""), `${locale}: ${key}`).toEqual(
          interpolations(value),
        );
      }
    }
  });
});
