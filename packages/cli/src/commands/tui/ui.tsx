import { Box, Text } from "ink";
import React from "react";
import type { ReactElement } from "react";
import { PAGE_NAMES, matchOptions, pad, truncate, windowSlice, type OptionItem } from "./format.js";

/** Colours as Neolix's app uses them, in the 16 colours every terminal has. */
export interface Theme {
  color: boolean;
  accent: string;
  text: string;
  muted: string;
  faint: string;
  ok: string;
  bad: string;
  pill: string;
}

export function makeTheme(color: boolean): Theme {
  return {
    color,
    accent: "blue",
    text: "white",
    muted: "gray",
    faint: "gray",
    ok: "green",
    bad: "red",
    pill: "blue",
  };
}

export interface Hint {
  key: string;
  label: string;
}

export function headerLines(page: number, crumbs: readonly string[], theme: Theme): ReactElement {
  const title = (
    <Text color={theme.color ? theme.accent : undefined} bold>
      ◉ Neox
    </Text>
  );
  if (crumbs.length === 0) {
    return (
      <Text wrap="truncate-end">
        {title}
        <Text> </Text>
        {PAGE_NAMES.map((name, index) => (
          <Text key={name}>
            {index === page ? (
              <Text
                color={theme.color ? theme.text : undefined}
                backgroundColor={theme.color ? theme.pill : undefined}
              >
                {` ${index + 1} ${name} `}
              </Text>
            ) : (
              <Text color={theme.color ? theme.muted : undefined}>{` ${index + 1} ${name} `}</Text>
            )}
            <Text> </Text>
          </Text>
        ))}
      </Text>
    );
  }
  return (
    <Text wrap="truncate-end">
      {title}
      {crumbs.map((crumb) => (
        <Text key={crumb}>
          <Text color={theme.color ? theme.muted : undefined}> › </Text>
          <Text color={theme.color ? theme.text : undefined}>{crumb}</Text>
        </Text>
      ))}
    </Text>
  );
}

export function Hints({ hints, theme }: { hints: readonly Hint[]; theme: Theme }): ReactElement {
  return (
    <Text wrap="truncate-end">
      {hints.map((hint, index) => (
        <Text key={`${hint.key}-${hint.label}`}>
          {index > 0 ? <Text color={theme.color ? theme.faint : undefined}>{"  ·  "}</Text> : null}
          <Text color={theme.color ? theme.text : undefined}>{hint.key}</Text>
          <Text color={theme.color ? theme.muted : undefined}>{` ${hint.label}`}</Text>
        </Text>
      ))}
    </Text>
  );
}

export function Status({
  flash,
  busy,
  target,
  theme,
}: {
  flash: { text: string; ok: boolean } | null;
  busy: boolean;
  target: string;
  theme: Theme;
}): ReactElement {
  if (flash !== null) {
    let tone: string | undefined;
    if (theme.color) tone = flash.ok ? theme.ok : theme.bad;
    return (
      <Text wrap="truncate-end">
        <Text color={tone}>{flash.ok ? "✓ " : "✗ "}</Text>
        <Text color={theme.color ? theme.text : undefined}>{flash.text}</Text>
      </Text>
    );
  }
  if (busy) {
    return <Text color={theme.color ? theme.muted : undefined}>… reading {target}</Text>;
  }
  return <Text color={theme.color ? theme.muted : undefined}>{""}</Text>;
}

export interface PickerState {
  title: string[];
  query: string;
  items: OptionItem[];
  cursor: number;
  custom: boolean;
  empty: string;
  kind: "select" | "toggle" | "profiles" | "models";
}

export function newPicker(input: {
  title: string[];
  items: OptionItem[];
  empty?: string;
  custom?: boolean;
  kind?: PickerState["kind"];
}): PickerState {
  return {
    title: input.title,
    query: "",
    items: input.items,
    cursor: 0,
    custom: input.custom ?? false,
    empty: input.empty ?? "no items",
    kind: input.kind ?? "select",
  };
}

function pickerEmptyText(picker: PickerState, typed: string): string {
  if (picker.custom && typed !== "") return `↵ use ${typed} as a custom value`;
  if (picker.items.length === 0) return picker.empty;
  return "no match";
}

export function Picker({
  picker,
  theme,
  rows,
  width,
}: {
  picker: PickerState;
  theme: Theme;
  rows: number;
  width: number;
}): ReactElement {
  const match = matchOptions(picker.items, picker.query);
  const [start, end] = windowSlice(match.length, picker.cursor, Math.max(1, rows));
  const valueWidth = Math.max(
    8,
    Math.min(32, ...match.slice(0, 40).map((index) => (picker.items[index]?.value ?? "").length)),
  );
  const typed = picker.query.trim();
  return (
    <Box flexDirection="column">
      <Text wrap="truncate-end">
        <Text color={theme.color ? theme.accent : undefined}>❯ </Text>
        <Text color={theme.color ? theme.text : undefined}>{picker.query}</Text>
        <Text color={theme.color ? theme.faint : undefined}>
          {picker.query === "" ? "type to filter" : ""}
        </Text>
      </Text>
      <Text> </Text>
      {match.length === 0 ? (
        <Text color={theme.color ? theme.muted : undefined}>{pickerEmptyText(picker, typed)}</Text>
      ) : (
        match.slice(start, end).map((itemIndex, offset) => {
          const item = picker.items[itemIndex]!;
          const selected = start + offset === picker.cursor;
          let markerColor: string | undefined;
          let valueColor: string | undefined;
          if (theme.color) {
            markerColor = selected ? theme.accent : undefined;
            valueColor = selected ? theme.accent : theme.text;
          }
          return (
            <Text key={item.value} wrap="truncate-end">
              <Text color={markerColor}>{selected ? "▸ " : "  "}</Text>
              <Text bold={selected} color={valueColor}>
                {pad(truncate(item.value, valueWidth), valueWidth)}
              </Text>
              {item.note === undefined || item.note === "" ? null : (
                <Text color={theme.color ? theme.muted : undefined}>{`  ${item.note}`}</Text>
              )}
            </Text>
          );
        })
      )}
      {match.length > end || start > 0 ? (
        <Text color={theme.color ? theme.faint : undefined}>
          {`  ${start + 1}–${end} of ${match.length}`}
        </Text>
      ) : null}
      <Text color={theme.color ? theme.faint : undefined} wrap="truncate-end">
        {width > 0 ? "" : ""}
      </Text>
    </Box>
  );
}

export interface AskState {
  title: string[];
  hint: string;
  value: string;
  secret: boolean;
  empty: boolean;
  submit: (value: string) => void;
}

export function Ask({ ask, theme }: { ask: AskState; theme: Theme }): ReactElement {
  const shown = ask.secret ? "•".repeat(Array.from(ask.value).length) : ask.value;
  return (
    <Box flexDirection="column">
      <Text wrap="truncate-end">
        <Text color={theme.color ? theme.accent : undefined}>❯ </Text>
        <Text color={theme.color ? theme.text : undefined}>{shown}</Text>
      </Text>
      <Text> </Text>
      {ask.hint === ""
        ? null
        : ask.hint.split("\n").map((line) => (
            <Text key={line} color={theme.color ? theme.muted : undefined}>
              {`  ${line}`}
            </Text>
          ))}
    </Box>
  );
}
