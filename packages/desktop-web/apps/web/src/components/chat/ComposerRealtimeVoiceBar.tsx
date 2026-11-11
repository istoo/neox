// FILE: ComposerRealtimeVoiceBar.tsx
// Purpose: Inline status and controls while Neox realtime voice owns the microphone.
// Layer: Chat composer presentation
// Depends on: composer button styling, the composer icon set, and i18n.

import { useTranslation } from "~/i18n";
import { DeviceRecordStopIcon, MicIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import type { RealtimeVoicePhase } from "../../lib/realtimeVoice";

const METER_BARS = [0.45, 0.75, 1, 0.65, 0.35];

function statusKey(phase: RealtimeVoicePhase): string {
  if (phase === "starting" || phase === "stopping") return "chat:realtimeVoiceConnecting";
  if (phase === "waiting") return "chat:realtimeVoiceWaiting";
  if (phase === "speaking") return "chat:realtimeVoiceSpeaking";
  return "chat:realtimeVoiceListening";
}

export function ComposerRealtimeVoiceBar(props: {
  phase: RealtimeVoicePhase;
  muted: boolean;
  volume: number;
  isUserSpeaking: boolean;
  onToggleMute: () => void;
  onStop: () => void;
}) {
  const { t } = useTranslation();
  const level = props.muted ? 0 : Math.max(props.volume, props.isUserSpeaking ? 0.35 : 0);
  const muteLabel = props.muted ? t("chat:realtimeVoiceUnmute") : t("chat:realtimeVoiceMute");
  return (
    <div
      data-realtime-voice-bar=""
      className="flex items-center gap-2 px-3 py-2 text-ui"
      role="status"
      aria-live="polite"
    >
      <div className="flex h-4 items-end gap-0.5" aria-hidden="true">
        {METER_BARS.map((weight) => (
          <span
            key={weight}
            className={cn(
              "w-0.5 rounded-full transition-all duration-100",
              props.muted ? "bg-muted-foreground/30" : "bg-primary",
            )}
            style={{ height: `${Math.max(2, Math.round(level * weight * 16))}px` }}
          />
        ))}
      </div>
      <span className="min-w-0 flex-1 truncate text-muted-foreground">
        {t(statusKey(props.phase))}
      </span>
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        className={cn(
          "rounded-full",
          props.muted && "bg-destructive/15 text-destructive hover:bg-destructive/20",
        )}
        aria-label={muteLabel}
        title={muteLabel}
        aria-pressed={props.muted}
        onClick={props.onToggleMute}
      >
        <MicIcon aria-hidden="true" className="size-3.5" />
      </Button>
      <Button
        type="button"
        size="icon-sm"
        variant="prominent"
        className="rounded-full"
        aria-label={t("chat:realtimeVoiceStop")}
        title={t("chat:realtimeVoiceStop")}
        onClick={props.onStop}
      >
        <DeviceRecordStopIcon aria-hidden="true" className="size-3.5" />
      </Button>
    </div>
  );
}
