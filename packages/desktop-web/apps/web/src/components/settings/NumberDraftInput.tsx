// FILE: NumberDraftInput.tsx
// Purpose: A numeric settings input that edits a local draft and commits on blur or Enter.
// Layer: Settings UI component
// Why: committing on every keystroke clamps partial input ("7" of "700" becomes the minimum,
//      then "60" + "0" overshoots to the maximum) and makes the field impossible to clear.

import { useState, type ComponentProps } from "react";

import { Input } from "../ui/input";

type InputProps = Omit<ComponentProps<typeof Input>, "value" | "onChange" | "type">;

export function NumberDraftInput({
  value,
  normalize,
  onCommit,
  allowEmpty,
  onBlur,
  onKeyDown,
  ...props
}: InputProps & {
  /** The committed value; null shows an empty field (only with `allowEmpty`). */
  readonly value: number | null;
  /** Clamps and rounds a parsed number into the setting's range; null rejects it. */
  readonly normalize: (value: number) => number | null;
  readonly onCommit: (value: number | null) => void;
  /** An empty field commits null (e.g. "use the preset"); otherwise it restores the value. */
  readonly allowEmpty?: boolean;
}) {
  const shown = value === null ? "" : String(value);
  // null while not editing, so outside changes (reset buttons, other windows) show through.
  const [draft, setDraft] = useState<string | null>(null);

  const commit = () => {
    if (draft === null) return;
    const text = draft.trim();
    setDraft(null);
    if (text.length === 0) {
      if (allowEmpty && value !== null) onCommit(null);
      return;
    }
    const parsed = Number(text);
    if (!Number.isFinite(parsed)) return;
    const next = normalize(parsed);
    if (next !== null && next !== value) onCommit(next);
  };

  return (
    <Input
      {...props}
      type="number"
      value={draft ?? shown}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={(event) => {
        commit();
        onBlur?.(event);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          // Commit and keep focus; the field then shows the normalized value.
          commit();
        } else if (event.key === "Escape" && draft !== null) {
          // Escape abandons the edit; a second Escape reaches the dialog/page handlers.
          event.preventDefault();
          event.stopPropagation();
          setDraft(null);
        }
        onKeyDown?.(event);
      }}
    />
  );
}
