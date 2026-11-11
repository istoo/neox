// FILE: AgentProfilesSettingsPanel.tsx
// Purpose: Settings › Agent profiles. Lists the host's named launch bundles and lets the
//          user create, rename, edit notes, and delete them. Applying a profile happens in
//          the composer's model picker; this panel never links a chat to a profile.
// Layer: Settings UI components
// Exports: AgentProfilesSettingsPanel

import {
  DEFAULT_SERVER_SETTINGS_VIEW,
  PROVIDER_DISPLAY_NAMES,
  type ProviderKind,
} from "@synara/contracts";
import { deriveProviderInstances } from "@synara/shared/providerInstances";
import { getModelOptions } from "@synara/shared/model";
import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useId, useMemo, useState } from "react";

import { getCustomModelsForProvider, useAppSettings } from "~/appSettings";
import { useComposerDraftStore } from "~/composerDraftStore";
import {
  AGENT_PROFILE_RUNTIME_MODES,
  agentProfileModel,
  agentProfileProvider,
  generateAgentProfileId,
  isAgentProfileRuntimeMode,
} from "~/lib/agentProfiles";
import { runtimeModePresentation } from "~/lib/runtimeMode";
import { AddPlusIcon, BookmarkIcon } from "~/lib/icons";
import { serverSettingsQueryOptions } from "~/lib/serverReactQuery";
import type { NeolixAgentProfileWire } from "~/lib/neolixHostApi";
import { formatProviderModelOptionName } from "~/providerModelOptions";
import { useTranslation } from "~/i18n";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  dialogFieldLabelClassName,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { SelectItem } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { useHostConfig } from "./hostSettingsModel";
import { SettingsSelectControl } from "./SettingControls";
import {
  SettingsCard,
  SettingsEmptyState,
  SettingsListRow,
  SettingsSectionShell,
} from "./SettingsPanelPrimitives";

const DEFAULT_MODEL_VALUE = "__default__";
const UNSET_MODE_VALUE = "__unset__";

type EditorValue = {
  readonly name: string;
  readonly provider: ProviderKind;
  readonly model: string;
  readonly modeId: string;
  readonly notes: string;
};

type EditorTarget =
  | { readonly mode: "create" }
  | { readonly mode: "edit"; readonly profile: NeolixAgentProfileWire };

function profileProviderLabel(profile: NeolixAgentProfileWire): string {
  const provider = agentProfileProvider(profile);
  return provider ? PROVIDER_DISPLAY_NAMES[provider] : profile.provider;
}

function profileModelLabel(profile: NeolixAgentProfileWire, fallback: string): string {
  const provider = agentProfileProvider(profile);
  const model = agentProfileModel(profile);
  if (!provider || !model) return fallback;
  return formatProviderModelOptionName({ provider, slug: model });
}

function profileModeLabel(profile: NeolixAgentProfileWire, fallback: string): string {
  const provider = agentProfileProvider(profile);
  if (!provider || !isAgentProfileRuntimeMode(profile.modeId)) return fallback;
  return runtimeModePresentation(profile.modeId, provider).label;
}

function ProfileEditorDialog(props: {
  open: boolean;
  target: EditorTarget;
  providers: ReadonlyArray<{ readonly provider: ProviderKind; readonly label: string }>;
  modelsFor: (
    provider: ProviderKind,
  ) => ReadonlyArray<{ readonly value: string; readonly label: string }>;
  onOpenChange: (open: boolean) => void;
  onSave: (value: EditorValue) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const formId = useId();
  const editing = props.target.mode === "edit" ? props.target.profile : null;
  const [name, setName] = useState(editing?.name ?? "");
  const [provider, setProvider] = useState<ProviderKind>(
    (() => {
      const resolved = editing ? agentProfileProvider(editing) : null;
      return resolved ?? props.providers[0]?.provider ?? "claudeAgent";
    })(),
  );
  const [model, setModel] = useState(editing ? agentProfileModel(editing) : "");
  const [modeId, setModeId] = useState(
    editing && isAgentProfileRuntimeMode(editing.modeId) ? editing.modeId : "",
  );
  const [notes, setNotes] = useState(editing?.notes ?? "");
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const [wasOpen, setWasOpen] = useState(props.open);
  if (wasOpen !== props.open) {
    setWasOpen(props.open);
    if (props.open) {
      const nextProvider = editing ? agentProfileProvider(editing) : null;
      setName(editing?.name ?? "");
      setProvider(nextProvider ?? props.providers[0]?.provider ?? "claudeAgent");
      setModel(editing && nextProvider ? agentProfileModel(editing) : "");
      setModeId(editing && isAgentProfileRuntimeMode(editing.modeId) ? editing.modeId : "");
      setNotes(editing?.notes ?? "");
      setSubmitAttempted(false);
      setSubmitting(false);
    }
  }

  const modelOptions = props.modelsFor(provider);
  const nameError = submitAttempted && name.trim().length === 0;
  const selectedModeLabel = isAgentProfileRuntimeMode(modeId)
    ? runtimeModePresentation(modeId, provider).label
    : t("settings:agentProfiles_modeDefault");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitAttempted(true);
    if (name.trim().length === 0) return;
    setSubmitting(true);
    const saved = await props.onSave({
      name: name.trim(),
      provider,
      model,
      modeId,
      notes: notes.trim(),
    });
    setSubmitting(false);
    if (saved) props.onOpenChange(false);
  };

  return (
    <Dialog open={props.open} onOpenChange={(next) => !submitting && props.onOpenChange(next)}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {editing
              ? t("settings:agentProfiles_editTitle")
              : t("settings:agentProfiles_createTitle")}
          </DialogTitle>
          <DialogDescription>{t("settings:agentProfiles_editorDescription")}</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form id={formId} className="space-y-3" onSubmit={submit} noValidate>
            <label className="block space-y-1">
              <span className={dialogFieldLabelClassName}>
                {t("settings:agentProfiles_nameLabel")}
              </span>
              <Input
                size="sm"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={t("settings:agentProfiles_namePlaceholder")}
                spellCheck={false}
                autoFocus
                aria-invalid={nameError}
              />
              {nameError ? (
                <span className="block text-ui-sm text-destructive">
                  {t("settings:agentProfiles_nameRequired")}
                </span>
              ) : null}
            </label>
            <div className="space-y-1">
              <span className={dialogFieldLabelClassName}>
                {t("settings:agentProfiles_providerLabel")}
              </span>
              <SettingsSelectControl
                value={provider}
                onValueChange={(next) => {
                  setProvider(next as ProviderKind);
                  setModel("");
                }}
                ariaLabel={t("settings:agentProfiles_providerLabel")}
                triggerClassName="w-full"
                valueContent={PROVIDER_DISPLAY_NAMES[provider]}
              >
                {props.providers.map((option) => (
                  <SelectItem hideIndicator key={option.provider} value={option.provider}>
                    {option.label}
                  </SelectItem>
                ))}
              </SettingsSelectControl>
            </div>
            <div className="space-y-1">
              <span className={dialogFieldLabelClassName}>
                {t("settings:agentProfiles_modelLabel")}
              </span>
              <SettingsSelectControl
                value={model === "" ? DEFAULT_MODEL_VALUE : model}
                onValueChange={(next) => setModel(next === DEFAULT_MODEL_VALUE ? "" : next)}
                ariaLabel={t("settings:agentProfiles_modelLabel")}
                triggerClassName="w-full"
                valueContent={
                  model === ""
                    ? t("settings:agentProfiles_modelDefault")
                    : (modelOptions.find((option) => option.value === model)?.label ?? model)
                }
              >
                <SelectItem hideIndicator value={DEFAULT_MODEL_VALUE}>
                  {t("settings:agentProfiles_modelDefault")}
                </SelectItem>
                {modelOptions.map((option) => (
                  <SelectItem hideIndicator key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SettingsSelectControl>
            </div>
            <div className="space-y-1">
              <span className={dialogFieldLabelClassName}>
                {t("settings:agentProfiles_modeLabel")}
              </span>
              <SettingsSelectControl
                value={modeId === "" ? UNSET_MODE_VALUE : modeId}
                onValueChange={(next) => setModeId(next === UNSET_MODE_VALUE ? "" : next)}
                ariaLabel={t("settings:agentProfiles_modeLabel")}
                triggerClassName="w-full"
                valueContent={selectedModeLabel}
              >
                <SelectItem hideIndicator value={UNSET_MODE_VALUE}>
                  {t("settings:agentProfiles_modeDefault")}
                </SelectItem>
                {AGENT_PROFILE_RUNTIME_MODES.map((mode) => (
                  <SelectItem hideIndicator key={mode} value={mode}>
                    {runtimeModePresentation(mode, provider).label}
                  </SelectItem>
                ))}
              </SettingsSelectControl>
            </div>
            <label className="block space-y-1">
              <span className={dialogFieldLabelClassName}>
                {t("settings:agentProfiles_notesLabel")}
              </span>
              <Textarea
                size="sm"
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                placeholder={t("settings:agentProfiles_notesPlaceholder")}
              />
              <span className="block text-ui-sm text-muted-foreground">
                {t("settings:agentProfiles_notesHint")}
              </span>
            </label>
          </form>
        </DialogPanel>
        <DialogFooter>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={submitting}
            onClick={() => props.onOpenChange(false)}
          >
            {t("settings:agentProfiles_cancel")}
          </Button>
          <Button type="submit" form={formId} size="sm" disabled={submitting}>
            {t("settings:agentProfiles_save")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function AgentProfilesSettingsPanel({ active }: { active: boolean }) {
  const { t } = useTranslation();
  const { settings } = useAppSettings();
  const { config, isLoading, error, patch, saving } = useHostConfig(active);
  const settingsQuery = useQuery({ ...serverSettingsQueryOptions(), enabled: active });
  const [editor, setEditor] = useState<EditorTarget | null>(null);
  const [pendingDelete, setPendingDelete] = useState<NeolixAgentProfileWire | null>(null);

  const profiles = config?.agentProfiles ?? [];
  const stickyActiveProvider = useComposerDraftStore((state) => state.stickyActiveProvider);
  const providerOptions = useMemo(() => {
    const instances = deriveProviderInstances(settingsQuery.data ?? DEFAULT_SERVER_SETTINGS_VIEW);
    const seen = new Set<ProviderKind>();
    const options: Array<{ provider: ProviderKind; label: string }> = [];
    for (const instance of instances) {
      if (!instance.enabled || seen.has(instance.driver)) continue;
      seen.add(instance.driver);
      options.push({ provider: instance.driver, label: PROVIDER_DISPLAY_NAMES[instance.driver] });
    }
    // A new profile starts on the provider new chats use, which the editor takes as the first.
    const preferred = instances.find(
      (instance) => instance.instanceId === stickyActiveProvider,
    )?.driver;
    const index = options.findIndex((option) => option.provider === preferred);
    if (index > 0) options.unshift(...options.splice(index, 1));
    return options;
  }, [settingsQuery.data, stickyActiveProvider]);

  const modelsFor = (provider: ProviderKind) => {
    const seen = new Set<string>();
    const options: Array<{ value: string; label: string }> = [];
    for (const option of getModelOptions(provider)) {
      if (seen.has(option.slug)) continue;
      seen.add(option.slug);
      options.push({ value: option.slug, label: option.name });
    }
    for (const slug of getCustomModelsForProvider(settings, provider)) {
      if (seen.has(slug)) continue;
      seen.add(slug);
      options.push({ value: slug, label: formatProviderModelOptionName({ provider, slug }) });
    }
    return options;
  };

  const saveProfile = async (value: EditorValue): Promise<boolean> => {
    const editProfile = editor?.mode === "edit" ? editor.profile : null;
    const optionalFields = {
      ...(value.model.trim() ? { model: value.model.trim() } : {}),
      ...(value.modeId && isAgentProfileRuntimeMode(value.modeId) ? { modeId: value.modeId } : {}),
      ...(value.notes ? { notes: value.notes } : {}),
    };
    const next = editProfile
      ? profiles.map((profile) =>
          profile.id === editProfile.id
            ? {
                ...(profile.provider === value.provider
                  ? {
                      ...(profile.providerOptions
                        ? { providerOptions: profile.providerOptions }
                        : {}),
                      ...(profile.featureValues ? { featureValues: profile.featureValues } : {}),
                      ...(profile.thinkingOptionId
                        ? { thinkingOptionId: profile.thinkingOptionId }
                        : {}),
                    }
                  : {}),
                ...(profile.icon ? { icon: profile.icon } : {}),
                ...(profile.color ? { color: profile.color } : {}),
                id: profile.id,
                name: value.name,
                provider: value.provider,
                ...optionalFields,
              }
            : profile,
        )
      : [
          ...profiles,
          {
            id: generateAgentProfileId(),
            name: value.name,
            provider: value.provider,
            ...optionalFields,
          },
        ];
    const saved = await patch({ agentProfiles: next });
    return saved;
  };

  const deleteProfile = async () => {
    if (!pendingDelete) return;
    const saved = await patch({
      agentProfiles: profiles.filter((profile) => profile.id !== pendingDelete.id),
    });
    if (saved) setPendingDelete(null);
  };

  return (
    <div className="flex flex-col gap-7">
      <SettingsSectionShell
        title="settings:agentProfiles_sectionTitle"
        action={
          <Button
            size="xs"
            variant="outline"
            disabled={providerOptions.length === 0}
            onClick={() => setEditor({ mode: "create" })}
          >
            <AddPlusIcon />
            {t("settings:agentProfiles_create")}
          </Button>
        }
      >
        {isLoading ? (
          <SettingsEmptyState layout="status">
            {t("settings:agentProfiles_sectionTitle")}
          </SettingsEmptyState>
        ) : error ? (
          <SettingsEmptyState layout="status" tone="destructive">
            {error}
          </SettingsEmptyState>
        ) : profiles.length === 0 ? (
          <SettingsEmptyState>{t("settings:agentProfiles_empty")}</SettingsEmptyState>
        ) : (
          <SettingsCard>
            {profiles.map((profile) => {
              const summary = [
                profileProviderLabel(profile),
                profileModelLabel(profile, t("settings:agentProfiles_modelDefault")),
                profileModeLabel(profile, t("settings:agentProfiles_modeDefault")),
              ].join(" · ");
              return (
                <SettingsListRow
                  key={profile.id}
                  title={profile.name}
                  leading={<BookmarkIcon className="size-4" />}
                  description={
                    <span className="flex flex-col gap-0.5">
                      <span>{summary}</span>
                      {profile.notes ? <span>{profile.notes}</span> : null}
                    </span>
                  }
                  actions={
                    <>
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={() => setEditor({ mode: "edit", profile })}
                      >
                        {t("settings:agentProfiles_edit")}
                      </Button>
                      <Button
                        size="xs"
                        variant="ghost"
                        className="text-destructive hover:text-destructive"
                        onClick={() => setPendingDelete(profile)}
                      >
                        {t("settings:agentProfiles_delete")}
                      </Button>
                    </>
                  }
                />
              );
            })}
          </SettingsCard>
        )}
        <p className="mt-2 text-ui-sm leading-snug text-muted-foreground">
          {t("settings:agentProfiles_sectionDescription")}
        </p>
      </SettingsSectionShell>

      <ProfileEditorDialog
        open={editor !== null}
        target={editor ?? { mode: "create" }}
        providers={providerOptions}
        modelsFor={modelsFor}
        onOpenChange={(open) => {
          if (!open) setEditor(null);
        }}
        onSave={saveProfile}
      />

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open && !saving) setPendingDelete(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("settings:agentProfiles_deleteTitle", { name: pendingDelete?.name ?? "" })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("settings:agentProfiles_deleteDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose disabled={saving} render={<Button variant="outline" size="sm" />}>
              {t("settings:agentProfiles_cancel")}
            </AlertDialogClose>
            <Button
              variant="destructive"
              size="sm"
              disabled={saving}
              onClick={() => void deleteProfile()}
            >
              {t("settings:agentProfiles_delete")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}
