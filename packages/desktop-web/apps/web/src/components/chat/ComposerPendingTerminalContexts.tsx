import { t } from "~/i18n";
import {
  type TerminalContextDraft,
  formatTerminalContextLabel,
  isTerminalContextExpired,
} from "~/lib/terminalContext";
import { TerminalContextInlineChip } from "./TerminalContextInlineChip";

interface ComposerPendingTerminalContextChipProps {
  context: TerminalContextDraft;
}

export function ComposerPendingTerminalContextChip({
  context,
}: ComposerPendingTerminalContextChipProps) {
  const label = formatTerminalContextLabel(context);
  const expired = isTerminalContextExpired(context);
  const tooltipText = expired ? t("chat:terminalContextExpired", { label }) : context.text;

  return <TerminalContextInlineChip label={label} tooltipText={tooltipText} expired={expired} />;
}
