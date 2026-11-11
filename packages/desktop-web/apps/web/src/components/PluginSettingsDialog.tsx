// FILE: PluginSettingsDialog.tsx
// Purpose: Renders a plugin's settings form in the web settings shell. Values live in the
//          daemon's plugin settings store (`settings.<id>.read/write/reset`); the bridge
//          forwards them, so the form and the plugin see one copy of the data. Two sources
//          describe the form: manifest `settingsScreens` (declared fields) and the daemon's
//          `plugin.list` settings descriptors (draft-07 JSON Schema from `server.registerSettings`).
// Layer: Dialog component

import type {
  NeolixPlugin,
  NeolixPluginSettingsField,
  NeolixPluginSettingsScreen,
} from "@synara/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";

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
import { Switch } from "~/components/ui/switch";
import { Textarea } from "~/components/ui/textarea";
import { useTranslation } from "~/i18n";
import { ensureNativeApi } from "~/nativeApi";

interface JsonSchemaObject {
  type?: string;
  title?: string;
  description?: string;
  enum?: unknown[];
  properties?: Record<string, JsonSchemaObject>;
  items?: JsonSchemaObject;
  format?: string;
}

type SettingsForm =
  | {
      kind: "fields";
      key: string;
      title: string;
      settingsId: string;
      fields: readonly NeolixPluginSettingsField[];
    }
  | {
      kind: "schema";
      key: string;
      title: string;
      settingsId: string;
      schema: JsonSchemaObject | null;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function initialValue(field: NeolixPluginSettingsField, values: Record<string, unknown>) {
  if (Object.hasOwn(values, field.key)) return values[field.key];
  return field.default;
}

function textValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : String(value);
}

function jsonText(value: unknown): string {
  if (value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "";
  }
}

function asSchemaObject(value: unknown): JsonSchemaObject | null {
  return isRecord(value) ? (value as JsonSchemaObject) : null;
}

function schemaProperties(schema: JsonSchemaObject | null): Array<[string, JsonSchemaObject]> {
  if (!schema?.properties) return [];
  return Object.entries(schema.properties).filter((entry): entry is [string, JsonSchemaObject] =>
    isRecord(entry[1]),
  );
}

function stringOptions(schema: JsonSchemaObject): string[] | null {
  if (!Array.isArray(schema.enum)) return null;
  return schema.enum.every((value) => typeof value === "string") ? (schema.enum as string[]) : null;
}

function formSources(plugin: NeolixPlugin | null): SettingsForm[] {
  if (!plugin) return [];
  const screens = (plugin.settingsScreens ?? []).map(
    (screen: NeolixPluginSettingsScreen): SettingsForm => ({
      kind: "fields",
      key: `screen:${screen.id}`,
      title: screen.title,
      settingsId: screen.settingsId,
      fields: screen.fields,
    }),
  );
  // COMPAT(pluginSettingsSchema): added in v0.15.1, remove after 2027-05-09 once daemon floor
  // sends `settings`; old daemons and manifest-only plugins still render `settingsScreens`.
  const settings = (plugin.settings ?? []).map(
    (setting): SettingsForm => ({
      kind: "schema",
      key: `setting:${setting.id}`,
      title: setting.title?.trim() || setting.id,
      settingsId: setting.id,
      schema: asSchemaObject(setting.schema),
    }),
  );
  return [...settings, ...screens];
}

export function PluginSettingsDialog(props: {
  readonly open: boolean;
  readonly plugin: NeolixPlugin | null;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const forms = useMemo(() => formSources(props.plugin), [props.plugin]);
  const firstFormKey = forms[0]?.key ?? "";
  const [formKey, setFormKey] = useState<string>(firstFormKey);
  const form = forms.find((entry) => entry.key === formKey) ?? forms[0];
  const [draft, setDraft] = useState<Record<string, unknown> | null>(null);
  const [jsonDrafts, setJsonDrafts] = useState<Record<string, string>>({});
  const [wholeJsonDraft, setWholeJsonDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pluginId = props.plugin?.id ?? "";
  const settingsId = form?.settingsId ?? "";
  const enabled = props.open && pluginId.length > 0 && settingsId.length > 0;

  useEffect(() => {
    setFormKey(firstFormKey);
    setDraft(null);
    setJsonDrafts({});
    setWholeJsonDraft(null);
    setError(null);
  }, [firstFormKey, props.plugin?.id]);

  const queryKey = ["neolix", "plugin-settings", pluginId, settingsId] as const;
  const readQuery = useQuery({
    queryKey,
    enabled,
    retry: false,
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!api.neolix) throw new Error(t("settings:plugins_unsupportedError"));
      return api.neolix.plugins.settingsRead({ pluginId, settingsId });
    },
  });

  const revision = readQuery.data?.revision ?? "";

  useEffect(() => {
    if (!form || readQuery.data?.status !== "ready" || !isRecord(readQuery.data.values)) {
      setDraft(null);
      setWholeJsonDraft(null);
      return;
    }
    const values = readQuery.data.values;
    if (form.kind === "fields") {
      const next: Record<string, unknown> = {};
      const nextJson: Record<string, string> = {};
      for (const field of form.fields) {
        next[field.key] = initialValue(field, values);
        if (field.type === "json") nextJson[field.key] = jsonText(values[field.key]);
      }
      setDraft(next);
      setJsonDrafts(nextJson);
      setWholeJsonDraft(null);
      return;
    }

    if (schemaProperties(form.schema).length === 0) {
      setDraft({});
      setJsonDrafts({});
      setWholeJsonDraft(jsonText(values));
      return;
    }
    const nextJson: Record<string, string> = {};
    for (const [key, property] of schemaProperties(form.schema)) {
      if (property.type === "object" || property.type === "array") {
        nextJson[key] = jsonText(values[key]);
      }
    }
    setDraft({ ...values });
    setJsonDrafts(nextJson);
    setWholeJsonDraft(null);
  }, [form, readQuery.data]);

  const writeMutation = useMutation({
    mutationFn: async (nextValues: unknown) => {
      const api = ensureNativeApi();
      if (!api.neolix) throw new Error(t("settings:plugins_unsupportedError"));
      return api.neolix.plugins.settingsWrite({
        pluginId,
        settingsId,
        revision,
        values: nextValues as never,
      });
    },
    onSuccess: (result) => {
      if (result.status === "saved") {
        setError(null);
        void queryClient.invalidateQueries({ queryKey });
      } else {
        setError(result.error);
        // A conflict means this revision is stale; reload so the next save can succeed.
        if (result.status === "conflict") {
          void queryClient.invalidateQueries({ queryKey });
        }
      }
    },
    onError: (cause) => setError(errorMessage(cause)),
  });

  const resetMutation = useMutation({
    mutationFn: async () => {
      const api = ensureNativeApi();
      if (!api.neolix) throw new Error(t("settings:plugins_unsupportedError"));
      return api.neolix.plugins.settingsReset({ pluginId, settingsId, revision });
    },
    onSuccess: (result) => {
      if (result.status !== "saved") setError(result.error);
      else {
        setError(null);
        void queryClient.invalidateQueries({ queryKey });
      }
    },
    onError: (cause) => setError(errorMessage(cause)),
  });

  const save = () => {
    if (!form) return;
    if (form.kind === "fields") {
      if (!draft) return;
      const next: Record<string, unknown> = {};
      for (const field of form.fields) {
        if (field.type === "json") {
          const text = jsonDrafts[field.key] ?? "";
          if (text.trim().length === 0) {
            next[field.key] = null;
            continue;
          }
          try {
            next[field.key] = JSON.parse(text) as unknown;
          } catch {
            setError(t("settings:plugins_settingsInvalidJson", { value0: field.label }));
            return;
          }
          continue;
        }
        next[field.key] = draft[field.key];
      }
      writeMutation.mutate(next);
      return;
    }

    const properties = schemaProperties(form.schema);
    if (properties.length === 0) {
      if (wholeJsonDraft === null) return;
      try {
        writeMutation.mutate(JSON.parse(wholeJsonDraft) as unknown);
      } catch {
        setError(t("settings:plugins_settingsInvalidJson", { value0: form.title }));
      }
      return;
    }

    if (!draft) return;
    const next: Record<string, unknown> = { ...draft };
    for (const [key, property] of properties) {
      if (property.type !== "object" && property.type !== "array") continue;
      const text = jsonDrafts[key] ?? "";
      if (text.trim().length === 0) {
        next[key] = null;
        continue;
      }
      try {
        next[key] = JSON.parse(text) as unknown;
      } catch {
        setError(
          t("settings:plugins_settingsInvalidJson", {
            value0: property.title ?? key,
          }),
        );
        return;
      }
    }
    writeMutation.mutate(next);
  };

  const updateField = (field: NeolixPluginSettingsField, value: unknown) => {
    setDraft((current) => (current ? { ...current, [field.key]: value } : current));
  };

  const updateValue = (key: string, value: unknown) => {
    setDraft((current) => (current ? { ...current, [key]: value } : current));
  };

  const renderField = (field: NeolixPluginSettingsField) => {
    const value = draft?.[field.key];
    const label = (
      <span className="block text-ui-sm font-medium text-foreground">{field.label}</span>
    );
    if (field.type === "boolean") {
      return (
        <label key={field.key} className="flex items-center justify-between gap-3 py-1">
          <span>
            {label}
            {field.description ? (
              <span className="mt-0.5 block text-ui-sm text-muted-foreground">
                {field.description}
              </span>
            ) : null}
          </span>
          <Switch
            checked={value === true}
            aria-label={field.label}
            onCheckedChange={(checked) => updateField(field, Boolean(checked))}
          />
        </label>
      );
    }
    return (
      <label key={field.key} className="block">
        {label}
        {field.description ? (
          <span className="mt-0.5 block text-ui-sm text-muted-foreground">{field.description}</span>
        ) : null}
        {field.type === "json" ? (
          <Textarea
            aria-label={field.label}
            className="mt-1 font-mono text-ui-sm"
            rows={6}
            value={jsonDrafts[field.key] ?? ""}
            onChange={(event) =>
              setJsonDrafts((current) => ({ ...current, [field.key]: event.target.value }))
            }
          />
        ) : field.type === "select" ? (
          <select
            aria-label={field.label}
            className="mt-1 min-h-9 w-full rounded-md border border-[color:var(--color-border)] bg-[var(--color-background-control-opaque)] px-2.5 text-ui"
            value={textValue(value)}
            onChange={(event) => updateField(field, event.target.value)}
          >
            {(field.options ?? []).map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        ) : (
          <Input
            aria-label={field.label}
            className="mt-1"
            type={field.type === "number" ? "number" : "text"}
            placeholder={field.placeholder}
            value={textValue(value)}
            onChange={(event) =>
              updateField(
                field,
                field.type === "number"
                  ? event.target.value === ""
                    ? null
                    : Number(event.target.value)
                  : event.target.value,
              )
            }
          />
        )}
      </label>
    );
  };

  const renderSchemaField = (key: string, property: JsonSchemaObject) => {
    const value = draft?.[key];
    const labelText = property.title?.trim() || key;
    const options = stringOptions(property);
    const description = property.description ? (
      <span className="mt-0.5 block text-ui-sm text-muted-foreground">{property.description}</span>
    ) : null;
    if (property.type === "boolean") {
      return (
        <label key={key} className="flex items-center justify-between gap-3 py-1">
          <span>
            <span className="block text-ui-sm font-medium text-foreground">{labelText}</span>
            {description}
          </span>
          <Switch
            checked={value === true}
            aria-label={labelText}
            onCheckedChange={(checked) => updateValue(key, Boolean(checked))}
          />
        </label>
      );
    }
    if (options) {
      const current = textValue(value);
      const known = options.includes(current);
      return (
        <label key={key} className="block">
          <span className="block text-ui-sm font-medium text-foreground">{labelText}</span>
          {description}
          <select
            aria-label={labelText}
            className="mt-1 min-h-9 w-full rounded-md border border-[color:var(--color-border)] bg-[var(--color-background-control-opaque)] px-2.5 text-ui"
            value={current}
            onChange={(event) => updateValue(key, event.target.value)}
          >
            {known ? null : <option value={current}>{current}</option>}
            {options.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
      );
    }
    const jsonLike = property.type === "object" || property.type === "array";
    if (jsonLike) {
      return (
        <label key={key} className="block">
          <span className="block text-ui-sm font-medium text-foreground">{labelText}</span>
          {description}
          <Textarea
            aria-label={labelText}
            className="mt-1 font-mono text-ui-sm"
            rows={5}
            value={jsonDrafts[key] ?? ""}
            onChange={(event) =>
              setJsonDrafts((current) => ({ ...current, [key]: event.target.value }))
            }
          />
        </label>
      );
    }
    return (
      <label key={key} className="block">
        <span className="block text-ui-sm font-medium text-foreground">{labelText}</span>
        {description}
        <Input
          aria-label={labelText}
          className="mt-1"
          type={property.type === "number" || property.type === "integer" ? "number" : "text"}
          value={textValue(value)}
          onChange={(event) => {
            if (property.type === "number" || property.type === "integer") {
              updateValue(key, event.target.value === "" ? null : Number(event.target.value));
            } else {
              updateValue(key, event.target.value);
            }
          }}
        />
      </label>
    );
  };

  const saving = writeMutation.isPending || resetMutation.isPending;
  const schemaFields = form?.kind === "schema" ? schemaProperties(form.schema) : [];
  const canRender =
    form !== undefined &&
    (form.kind === "fields"
      ? draft !== null
      : schemaFields.length > 0
        ? draft !== null
        : wholeJsonDraft !== null);

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {t("settings:plugins_settingsTitle", {
              value0: props.plugin?.name?.trim() || props.plugin?.id || "",
            })}
          </DialogTitle>
          <DialogDescription>{t("settings:plugins_settingsDescription")}</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {forms.length > 1 ? (
            <div className="mb-3 flex flex-wrap gap-1">
              {forms.map((entry) => (
                <Button
                  key={entry.key}
                  type="button"
                  size="xs"
                  variant={entry.key === form?.key ? "secondary" : "ghost"}
                  onClick={() => setFormKey(entry.key)}
                >
                  {entry.title}
                </Button>
              ))}
            </div>
          ) : null}
          {readQuery.isLoading ? (
            <p className="text-ui text-muted-foreground">{t("settings:plugins_settingsLoading")}</p>
          ) : readQuery.isError ? (
            <p className="text-ui text-destructive">{errorMessage(readQuery.error)}</p>
          ) : readQuery.data?.status === "invalid" ? (
            <p className="text-ui text-destructive">{readQuery.data.error}</p>
          ) : canRender && form ? (
            form.kind === "fields" ? (
              <div className="space-y-3">{form.fields.map(renderField)}</div>
            ) : schemaFields.length > 0 ? (
              <div className="space-y-3">
                {schemaFields.map(([key, property]) => renderSchemaField(key, property))}
              </div>
            ) : (
              <label className="block">
                <span className="block text-ui-sm font-medium text-foreground">{form.title}</span>
                <Textarea
                  aria-label={form.title}
                  className="mt-1 font-mono text-ui-sm"
                  rows={8}
                  value={wholeJsonDraft ?? ""}
                  onChange={(event) => setWholeJsonDraft(event.target.value)}
                />
              </label>
            )
          ) : (
            <p className="text-ui text-muted-foreground">
              {t("settings:plugins_settingsUnavailable")}
            </p>
          )}
          {error ? <p className="mt-3 text-ui text-destructive">{error}</p> : null}
        </DialogPanel>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            disabled={saving || revision.length === 0}
            onClick={() => resetMutation.mutate()}
          >
            {t("settings:plugins_settingsReset")}
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={saving || revision.length === 0 || !canRender}
            onClick={save}
          >
            {saving ? t("settings:plugins_settingsSaving") : t("settings:plugins_settingsSave")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
