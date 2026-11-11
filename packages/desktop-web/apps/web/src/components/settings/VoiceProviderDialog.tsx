// FILE: VoiceProviderDialog.tsx
// Purpose: One speech site's provider and its fields (local model or OpenAI endpoint),
//          matching the old app's speech provider sheet. The daemon owns `features.*.stt/tts`
//          in config.json, so the dialog builds the patch and lets the host settings panel save it.
// Layer: Dialog component

import type { NeolixSpeechModel } from "@synara/contracts";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { speechModelDisplayLabel } from "~/lib/speechModelLabel";
import { useTranslation } from "~/i18n";

const OPENAI_MODELS: Record<"stt" | "tts", string[]> = {
  stt: ["whisper-1", "gpt-4o-transcribe", "gpt-4o-mini-transcribe"],
  tts: ["tts-1", "tts-1-hd", "gpt-4o-mini-tts"],
};

const OPENAI_VOICES = ["alloy", "ash", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer"];

const SPEECH_MODEL_STATUS_KEYS: Record<string, string> = {
  installed: "settings:host_modelStatus_installed",
  not_installed: "settings:host_modelStatus_not_installed",
  downloading: "settings:host_modelStatus_downloading",
  extracting: "settings:host_modelStatus_extracting",
  failed: "settings:host_modelStatus_failed",
};

export type VoiceSiteId = "dictation.stt" | "voiceMode.stt" | "voiceMode.tts";
export type VoiceSiteKind = "stt" | "tts";

export interface VoiceSiteSettings {
  provider?: string | undefined;
  model?: string | undefined;
  language?: string | undefined;
  hasApiKey?: boolean | undefined;
  baseUrl?: string | undefined;
  voice?: string | undefined;
}

export interface VoiceSitePatch {
  provider: "local" | "openai";
  language?: string | null | undefined;
  model?: string | null | undefined;
  apiKey?: string | undefined;
  baseUrl?: string | null | undefined;
  voice?: string | null | undefined;
}

function withSelected(options: string[], selected: string): string[] {
  return selected && !options.includes(selected) ? [...options, selected] : options;
}

export function VoiceProviderDialog(props: {
  readonly siteId: VoiceSiteId;
  readonly kind: VoiceSiteKind;
  readonly site: VoiceSiteSettings | undefined;
  readonly envOverrides: Readonly<Record<string, string>>;
  readonly models: ReadonlyArray<NeolixSpeechModel>;
  readonly saving: boolean;
  readonly title: string;
  readonly onClose: () => void;
  readonly onSave: (patch: VoiceSitePatch) => void;
}) {
  const { t } = useTranslation();
  const { siteId, kind, site, envOverrides, models, saving } = props;
  const initialProvider = site?.provider === "openai" ? "openai" : "local";
  const [provider, setProvider] = useState<"local" | "openai">(initialProvider);
  const [language, setLanguage] = useState(site?.language ?? "");
  const [localModel, setLocalModel] = useState(site?.model ?? "");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(site?.baseUrl ?? "");
  const [openAiModel, setOpenAiModel] = useState(
    site?.provider === "openai" ? (site.model ?? "") : "",
  );
  const [voice, setVoice] = useState(site?.voice ?? "alloy");

  const env = (field: string) => envOverrides[`features.${siteId}.${field}`];
  const providerEnv = env("provider");
  const languageEnv = env("language");
  const modelEnv = env("model");
  const baseUrlEnv = env("baseUrl");
  const voiceEnv = env("voice");
  const setBy = (name: string) => t("settings:voice_setBy", { name });

  const kindModels = models.filter((model) => model.kind === kind);
  const localOptions = withSelected(
    kindModels.map((model) => model.id),
    localModel,
  );
  const modelOptions = withSelected(OPENAI_MODELS[kind], openAiModel);
  const voiceOptions = withSelected(OPENAI_VOICES, voice);

  const save = () => {
    const patch: VoiceSitePatch = { provider };
    if (kind === "stt") {
      const next = language.trim();
      if (!languageEnv && next !== (site?.language ?? "")) patch.language = next || null;
    }
    if (provider === "local") {
      if (!modelEnv && localModel && localModel !== (site?.model ?? "")) {
        patch.model = localModel;
      }
    } else {
      if (apiKey.trim()) patch.apiKey = apiKey.trim();
      if (!baseUrlEnv && baseUrl.trim() !== (site?.baseUrl ?? "")) {
        patch.baseUrl = baseUrl.trim() || null;
      }
      if (!modelEnv && openAiModel.trim() !== (site?.model ?? "")) {
        patch.model = openAiModel.trim() || null;
      }
      if (kind === "tts" && !voiceEnv && voice.trim() !== (site?.voice ?? "")) {
        patch.voice = voice.trim() || null;
      }
    }
    props.onSave(patch);
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : props.onClose())}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{props.title}</DialogTitle>
          <DialogDescription>{t("settings:voice_providerDescription")}</DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-3">
          <label className="block">
            <span className="block text-ui-sm font-medium text-foreground">
              {t("settings:voice_provider")}
            </span>
            <select
              className="mt-1 min-h-9 w-full rounded-md border border-[color:var(--color-border)] bg-[var(--color-background-control-opaque)] px-2.5 text-ui"
              value={provider}
              disabled={providerEnv !== undefined}
              onChange={(event) => setProvider(event.currentTarget.value as "local" | "openai")}
            >
              <option value="local">{t("settings:voice_providerLocal")}</option>
              <option value="openai">{t("settings:voice_providerOpenAi")}</option>
            </select>
            {providerEnv ? (
              <span className="mt-0.5 block text-ui-xs text-muted-foreground">
                {setBy(providerEnv)}
              </span>
            ) : null}
          </label>

          {kind === "stt" ? (
            <label className="block">
              <span className="block text-ui-sm font-medium text-foreground">
                {t("settings:voice_language")}
              </span>
              <Input
                className="mt-1"
                value={language}
                disabled={languageEnv !== undefined}
                placeholder="auto"
                onChange={(event) => setLanguage(event.currentTarget.value)}
              />
              {languageEnv ? (
                <span className="mt-0.5 block text-ui-xs text-muted-foreground">
                  {setBy(languageEnv)}
                </span>
              ) : null}
            </label>
          ) : null}

          {provider === "local" ? (
            <label className="block">
              <span className="block text-ui-sm font-medium text-foreground">
                {t("settings:voice_localModel")}
              </span>
              <select
                className="mt-1 min-h-9 w-full rounded-md border border-[color:var(--color-border)] bg-[var(--color-background-control-opaque)] px-2.5 text-ui"
                value={localModel}
                disabled={modelEnv !== undefined}
                onChange={(event) => setLocalModel(event.currentTarget.value)}
              >
                <option value="">{t("settings:voice_default")}</option>
                {localOptions.map((id) => {
                  const model = kindModels.find((entry) => entry.id === id);
                  return (
                    <option key={id} value={id}>
                      {model ? speechModelDisplayLabel(model.label, t) : id}
                      {model
                        ? ` · ${t(SPEECH_MODEL_STATUS_KEYS[model.status] ?? model.status)}`
                        : ""}
                    </option>
                  );
                })}
              </select>
              {kindModels.length === 0 ? (
                <span className="mt-0.5 block text-ui-xs text-muted-foreground">
                  {t("settings:voice_noLocalModel")}
                </span>
              ) : null}
              {modelEnv ? (
                <span className="mt-0.5 block text-ui-xs text-muted-foreground">
                  {setBy(modelEnv)}
                </span>
              ) : null}
            </label>
          ) : (
            <>
              <label className="block">
                <span className="block text-ui-sm font-medium text-foreground">
                  {t("settings:voice_apiKey")}
                </span>
                <Input
                  className="mt-1"
                  type="password"
                  value={apiKey}
                  placeholder={
                    site?.hasApiKey
                      ? t("settings:voice_apiKeySaved")
                      : t("settings:voice_apiKeyPlaceholder")
                  }
                  onChange={(event) => setApiKey(event.currentTarget.value)}
                />
              </label>
              <label className="block">
                <span className="block text-ui-sm font-medium text-foreground">
                  {t("settings:voice_baseUrl")}
                </span>
                <Input
                  className="mt-1"
                  value={baseUrl}
                  placeholder="https://api.openai.com/v1"
                  disabled={baseUrlEnv !== undefined}
                  onChange={(event) => setBaseUrl(event.currentTarget.value)}
                />
                {baseUrlEnv ? (
                  <span className="mt-0.5 block text-ui-xs text-muted-foreground">
                    {setBy(baseUrlEnv)}
                  </span>
                ) : null}
              </label>
              <label className="block">
                <span className="block text-ui-sm font-medium text-foreground">
                  {t("settings:voice_model")}
                </span>
                <select
                  className="mt-1 min-h-9 w-full rounded-md border border-[color:var(--color-border)] bg-[var(--color-background-control-opaque)] px-2.5 text-ui"
                  value={openAiModel}
                  disabled={modelEnv !== undefined}
                  onChange={(event) => setOpenAiModel(event.currentTarget.value)}
                >
                  <option value="">{t("settings:voice_default")}</option>
                  {modelOptions.map((id) => (
                    <option key={id} value={id}>
                      {id}
                    </option>
                  ))}
                </select>
                {modelEnv ? (
                  <span className="mt-0.5 block text-ui-xs text-muted-foreground">
                    {setBy(modelEnv)}
                  </span>
                ) : null}
              </label>
              {kind === "tts" ? (
                <label className="block">
                  <span className="block text-ui-sm font-medium text-foreground">
                    {t("settings:voice_voice")}
                  </span>
                  <select
                    className="mt-1 min-h-9 w-full rounded-md border border-[color:var(--color-border)] bg-[var(--color-background-control-opaque)] px-2.5 text-ui"
                    value={voice}
                    disabled={voiceEnv !== undefined}
                    onChange={(event) => setVoice(event.currentTarget.value)}
                  >
                    {voiceOptions.map((id) => (
                      <option key={id} value={id}>
                        {id}
                      </option>
                    ))}
                  </select>
                  {voiceEnv ? (
                    <span className="mt-0.5 block text-ui-xs text-muted-foreground">
                      {setBy(voiceEnv)}
                    </span>
                  ) : null}
                </label>
              ) : null}
            </>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={props.onClose} disabled={saving}>
            {t("settings:voice_cancel")}
          </Button>
          <Button type="button" variant="secondary" onClick={save} disabled={saving}>
            {saving ? t("settings:voice_saving") : t("settings:voice_save")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
