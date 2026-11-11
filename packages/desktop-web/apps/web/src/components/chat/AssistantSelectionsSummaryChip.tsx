// FILE: AssistantSelectionsSummaryChip.tsx
// Purpose: Renders the compact assistant-selection count chip used in composer and user bubbles.
// Layer: Chat attachment presentation

import { MessageCircleIcon } from "~/lib/icons";
import { type ChatAssistantSelectionAttachment } from "../../types";
import { AttachmentSummaryChip } from "./AttachmentSummaryChip";
import { t } from "~/i18n";

interface AssistantSelectionsSummaryChipProps {
  selections: ReadonlyArray<ChatAssistantSelectionAttachment>;
  onRemove?: (() => void) | undefined;
}

function selectionCountLabel(count: number): string {
  return t("chat:assistantSelectionCount", { count });
}

export function AssistantSelectionsSummaryChip(props: AssistantSelectionsSummaryChipProps) {
  if (props.selections.length === 0) {
    return null;
  }

  return (
    <AttachmentSummaryChip
      icon={MessageCircleIcon}
      label={selectionCountLabel(props.selections.length)}
      removeLabel={t("chat:removeSelections")}
      onRemove={props.onRemove}
      tooltip={props.selections.map((selection) => (
        <p key={selection.id} className="text-ui leading-relaxed">
          {selection.text}
        </p>
      ))}
    />
  );
}
