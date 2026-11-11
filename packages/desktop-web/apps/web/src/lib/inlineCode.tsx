import { Fragment, type ReactNode } from "react";

/**
 * Renders `backticked` spans of copy as `<code>`, so translated strings can name files,
 * commands, and flags without showing raw backticks. Text with fewer than one pair is
 * returned unchanged; an unmatched trailing backtick stays literal.
 */
export function renderInlineCode(text: string): ReactNode {
  const parts = text.split("`");
  if (parts.length < 3) return text;
  return parts.map((part, index) =>
    index % 2 === 1 && index < parts.length - 1 ? (
      <code key={index}>{part}</code>
    ) : (
      <Fragment key={index}>{part}</Fragment>
    ),
  );
}
