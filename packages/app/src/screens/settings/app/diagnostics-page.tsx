import { useCallback, useState } from "react";
import { Buffer } from "buffer";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { SettingsCard, SettingsRow, SettingsSection } from "@/components/settings";
import { useVoiceAudioEngineOptional } from "@/contexts/voice-context";
import { useAppDiagnosticStore } from "@/diagnostics/store";
import { THINKING_TONE_NATIVE_PCM_BASE64 } from "@/utils/thinking-tone.native-pcm";

/** Settings › Diagnostics: the app diagnostic and the audio playback test. */
export function DiagnosticsPage() {
  const { t } = useTranslation();
  const openAppDiagnostic = useAppDiagnosticStore((state) => state.open);
  const voiceAudioEngine = useVoiceAudioEngineOptional();
  const [isPlaybackTestRunning, setIsPlaybackTestRunning] = useState(false);
  const [playbackTestResult, setPlaybackTestResult] = useState<string | null>(null);

  const handlePlaybackTest = useCallback(async () => {
    if (!voiceAudioEngine || isPlaybackTestRunning) {
      return;
    }
    setIsPlaybackTestRunning(true);
    setPlaybackTestResult(null);
    try {
      const bytes = Buffer.from(THINKING_TONE_NATIVE_PCM_BASE64, "base64");
      await voiceAudioEngine.initialize();
      voiceAudioEngine.stop();
      await voiceAudioEngine.play({
        type: "audio/pcm;rate=16000;bits=16",
        size: bytes.byteLength,
        async arrayBuffer() {
          return Uint8Array.from(bytes).buffer;
        },
      });
      setPlaybackTestResult(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setPlaybackTestResult(t("settings.diagnostics.playbackFailed", { message }));
    } finally {
      setIsPlaybackTestRunning(false);
    }
  }, [isPlaybackTestRunning, t, voiceAudioEngine]);

  return (
    <SettingsSection title={t("settings.diagnostics.title")}>
      <SettingsCard>
        <SettingsRow
          label={t("settings.diagnostics.app.rowTitle")}
          hint={t("settings.diagnostics.app.rowHint")}
          testID="app-diagnostic-row"
        >
          <Button variant="secondary" onPress={openAppDiagnostic}>
            {t("settings.diagnostics.app.run")}
          </Button>
        </SettingsRow>
        <SettingsRow
          label={t("settings.diagnostics.testAudio")}
          hint={playbackTestResult ?? undefined}
        >
          <Button
            variant="secondary"
            onPress={handlePlaybackTest}
            disabled={!voiceAudioEngine || isPlaybackTestRunning}
          >
            {isPlaybackTestRunning
              ? t("settings.diagnostics.playing")
              : t("settings.diagnostics.playTest")}
          </Button>
        </SettingsRow>
      </SettingsCard>
    </SettingsSection>
  );
}
