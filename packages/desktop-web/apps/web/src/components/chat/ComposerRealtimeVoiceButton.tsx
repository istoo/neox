// FILE: ComposerRealtimeVoiceButton.tsx
// Purpose: Mic control that enters or leaves Neox realtime voice mode.
// Layer: Chat composer presentation
// Depends on: shared button styling, the composer icon set, and i18n.

import { useTranslation } from "~/i18n";
import { Loader2Icon, RealtimeVoiceIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { COMPOSER_ACTION_CIRCLE_CLASS_NAME } from "./composerPickerStyles";

export function ComposerRealtimeVoiceButton(props: {
  active: boolean;
  starting: boolean;
  disabled?: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const label = props.active ? t("chat:realtimeVoiceStop") : t("chat:realtimeVoiceStart");
  return (
    <Button
      type="button"
      size="icon-sm"
      variant={props.active ? "prominent" : "circle"}
      className={cn(COMPOSER_ACTION_CIRCLE_CLASS_NAME, props.active && "animate-pulse")}
      disabled={props.disabled || props.starting}
      aria-label={label}
      title={label}
      aria-pressed={props.active}
      onClick={props.onToggle}
    >
      {props.starting ? (
        <Loader2Icon aria-hidden="true" className="size-3.5 animate-spin" />
      ) : (
        <RealtimeVoiceIcon aria-hidden="true" className="size-3.5" />
      )}
    </Button>
  );
}
