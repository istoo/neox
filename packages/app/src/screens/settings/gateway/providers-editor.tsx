/* eslint-disable react/no-array-index-key -- header rows are positional; a header's name is edited in place, so keying by it would remount the field on every keystroke. */
import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { ChevronRight, Trash2, X } from "lucide-react-native";
import type { GatewayPriceWire, GatewayProviderWire } from "@neolix/protocol/gateway";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { ExternalLink } from "@/components/ui/external-link";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { PressHighlight } from "@/components/ui/press-highlight";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { StatusBadge } from "@/components/ui/status-badge";
import { Switch } from "@/components/ui/switch";
import type { Theme } from "@/styles/theme";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { ProviderPluginPanels } from "@/plugins/provider-panels";
import { confirmDialog } from "@/utils/confirm-dialog";
import type { GatewayProviderPreset } from "./providers-presets";
import { AccountsEditor } from "./providers-accounts-editor";
import { ClaudeModeRow } from "./claude-mode-row";
import { ModelsEditor, type ModelTestResult } from "./providers-models-editor";
import { useModelPriceCatalog } from "./providers-model-prices";
import { RateWindowsEditor } from "./providers-rate-windows";
import {
  buildProvider,
  hasVideoModels,
  openProviderDraft,
  presetDraft,
  validateProviderDraft,
  type GatewayBalanceMethod,
  type GatewayModelMode,
  type GatewayProtocol,
  type GatewayVideoApi,
  type ModelPriceDraft,
  type ModelPriceDrafts,
  modelPriceUpdates,
  type ProviderDraft,
  type ProviderDraftErrors,
  type ProviderHeaderDraft,
  type VertexDraft,
} from "./providers-helpers";

const ThemedChevron = withUnistyles(ChevronRight);

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

const PROTOCOL_LABELS: Record<GatewayProtocol, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  "openai-responses": "Responses",
  gemini: "Gemini",
};

const PROTOCOL_OPTIONS: { value: GatewayProtocol; label: string }[] = [
  { value: "anthropic", label: "Anthropic" },
  { value: "openai", label: "OpenAI" },
  { value: "openai-responses", label: "Responses" },
  { value: "gemini", label: "Gemini" },
];

const MODEL_MODE_OPTIONS: { value: GatewayModelMode; labelKey: string }[] = [
  { value: "list", labelKey: "modelModeList" },
  { value: "picked", labelKey: "modelModePicked" },
  { value: "best", labelKey: "modelModeBest" },
  { value: "none", labelKey: "modelModeNone" },
];

const MODEL_MODE_HINTS: Record<GatewayModelMode, string> = {
  list: "modelModeHintList",
  picked: "modelModeHintPicked",
  best: "modelModeHintBest",
  none: "modelModeHintNone",
};

const BALANCE_METHOD_OPTIONS: { value: GatewayBalanceMethod; label: string }[] = [
  { value: "GET", label: "GET" },
  { value: "POST", label: "POST" },
];

const VIDEO_API_OPTIONS: { value: string; label: string }[] = [
  { value: "auto", label: "Auto" },
  { value: "openai", label: "OpenAI" },
  { value: "ark", label: "Ark" },
  { value: "minimax", label: "MiniMax" },
  { value: "grok", label: "Grok" },
];

type TextField =
  | "id"
  | "label"
  | "baseUrl"
  | "apiKey"
  | "icon"
  | "extraBody"
  | "balanceUrl"
  | "balancePath"
  | "balanceToken"
  | "family"
  | "workspace";

interface ProtocolDetection {
  protocol: GatewayProtocol;
  base: string;
  ok: boolean;
  status: number;
  error: string | null;
}

interface DetectionChipProps {
  detection: ProtocolDetection;
  onPick: (protocol: GatewayProtocol, base: string) => void;
}

function DetectionChip({ detection, onPick }: DetectionChipProps) {
  const { t } = useTranslation();
  const handlePress = useCallback(
    () => onPick(detection.protocol, detection.base),
    [detection.base, detection.protocol, onPick],
  );
  return (
    <PressHighlight
      style={detection.ok ? undefined : styles.detectChipFailed}
      onPress={handlePress}
      disabled={!detection.ok}
      accessibilityRole="button"
      accessibilityLabel={t("settings.gatewayPages.providers.detected", {
        protocol: PROTOCOL_LABELS[detection.protocol],
      })}
    >
      <StatusBadge
        label={PROTOCOL_LABELS[detection.protocol]}
        variant={detection.ok ? "success" : "muted"}
        size="xs"
      />
    </PressHighlight>
  );
}
type NumberField = "maxAccounts" | "queueWaitMs" | "priceRate";

interface ProviderEditorProps {
  serverId: string;
  /** The gateway's hand-set prices, by `provider/model`. */
  pricing: Record<string, GatewayPriceWire>;
  /** The gateway's model equivalences, by `provider/model`. */
  modelSameAs: Record<string, string>;
  providers: readonly GatewayProviderWire[];
  /** The provider being edited, the one a duplicate starts from, or null for a blank one. */
  provider: GatewayProviderWire | null;
  /** The saved provider's id, or null when saving creates one. */
  originalId: string | null;
  /** Set when this editor starts from a copy, so the title says so. */
  copyOfName: string | null;
  /** The vendor picked in the add sheet, when this is a new provider. */
  preset: GatewayProviderPreset | null;
  /** The gateway's automatic sign-in switch for Codex, shown on Codex's page. */
  codexAutoSwitchSignIn: boolean;
  /** The same for Claude Code, shown on Claude's page. */
  claudeAutoSwitchSignIn: boolean;
  onClose: () => void;
  onSave: (
    provider: GatewayProviderWire,
    originalId: string | null,
    prices: Record<string, GatewayPriceWire | null>,
    sameAs: Record<string, string>,
    autoSwitch: { codex?: boolean; claude?: boolean },
  ) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
  onDuplicate: (id: string) => void;
}

interface DraftTextRowProps {
  field: TextField;
  label: string;
  value: string;
  placeholder?: string;
  hint?: string;
  error?: string;
  secure?: boolean;
  url?: boolean;
  multiline?: boolean;
  multilineLines?: number;
  onText: (field: TextField, value: string) => void;
  testID?: string;
}

function DraftTextRow({
  field,
  label,
  value,
  placeholder,
  hint,
  error,
  secure,
  url,
  multiline,
  multilineLines,
  onText,
  testID,
}: DraftTextRowProps) {
  const handleChange = useCallback((text: string) => onText(field, text), [field, onText]);
  return (
    <Field label={label} hint={hint} error={error} testID={testID}>
      <FormTextInput
        initialValue={value}
        onChangeText={handleChange}
        placeholder={placeholder}
        secureTextEntry={secure}
        multiline={multiline}
        numberOfLines={multilineLines}
        style={multiline ? styles.multilineInput : undefined}
        keyboardType={url ? "url" : "default"}
        autoCapitalize="none"
        autoCorrect={false}
        accessibilityLabel={label}
      />
    </Field>
  );
}

interface DraftNumberRowProps {
  field: NumberField;
  label: string;
  value: string;
  hint?: string;
  onNumber: (field: NumberField, value: string) => void;
}

function DraftNumberRow({ field, label, value, hint, onNumber }: DraftNumberRowProps) {
  const handleChange = useCallback((text: string) => onNumber(field, text), [field, onNumber]);
  return (
    <View style={styles.numberCell}>
      <Field label={label} hint={hint}>
        <FormTextInput
          initialValue={value}
          onChangeText={handleChange}
          keyboardType="numeric"
          accessibilityLabel={label}
        />
      </Field>
    </View>
  );
}

interface HeaderRowProps {
  header: ProviderHeaderDraft;
  index: number;
  onUpdate: (index: number, next: ProviderHeaderDraft) => void;
  onRemove: (index: number) => void;
}

function HeaderRow({ header, index, onUpdate, onRemove }: HeaderRowProps) {
  const { t } = useTranslation();
  const handleName = useCallback(
    (text: string) => onUpdate(index, { name: text, value: header.value }),
    [header.value, index, onUpdate],
  );
  const handleValue = useCallback(
    (text: string) => onUpdate(index, { name: header.name, value: text }),
    [header.name, index, onUpdate],
  );
  const handleRemove = useCallback(() => onRemove(index), [index, onRemove]);
  return (
    <View style={styles.headerRow}>
      <View style={styles.headerField}>
        <FormTextInput
          initialValue={header.name}
          onChangeText={handleName}
          placeholder={t("settings.gatewayPages.providers.headerName")}
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel={t("settings.gatewayPages.providers.headerName")}
        />
      </View>
      <View style={styles.headerValueField}>
        <FormTextInput
          initialValue={header.value}
          onChangeText={handleValue}
          placeholder={t("settings.gatewayPages.providers.headerValue")}
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel={t("settings.gatewayPages.providers.headerValue")}
        />
      </View>
      <Button
        variant="ghost"
        size="sm"
        leftIcon={X}
        onPress={handleRemove}
        accessibilityLabel={t("settings.gatewayPages.providers.removeHeader")}
      />
    </View>
  );
}

interface HeadersEditorProps {
  headers: ProviderHeaderDraft[];
  onChange: (headers: ProviderHeaderDraft[]) => void;
}

function HeadersEditor({ headers, onChange }: HeadersEditorProps) {
  const { t } = useTranslation();
  const handleUpdate = useCallback(
    (index: number, next: ProviderHeaderDraft) => {
      onChange(headers.map((header, position) => (position === index ? next : header)));
    },
    [headers, onChange],
  );
  const handleRemove = useCallback(
    (index: number) => onChange(headers.filter((_, position) => position !== index)),
    [headers, onChange],
  );
  const handleAdd = useCallback(
    () => onChange([...headers, { name: "", value: "" }]),
    [headers, onChange],
  );
  return (
    <Field
      label={t("settings.gatewayPages.providers.headers")}
      hint={t("settings.gatewayPages.providers.headersHint")}
    >
      <View style={styles.headersList}>
        {headers.map((header, index) => (
          <HeaderRow
            key={index}
            header={header}
            index={index}
            onUpdate={handleUpdate}
            onRemove={handleRemove}
          />
        ))}
        <View style={styles.addHeaderRow}>
          <Button variant="ghost" size="sm" onPress={handleAdd}>
            {t("settings.gatewayPages.providers.addHeader")}
          </Button>
        </View>
      </View>
    </Field>
  );
}

type ProviderErrorTexts = ReturnType<typeof draftErrorTexts>;

interface AddressFieldsProps {
  draft: ProviderDraft;
  errorTexts: ProviderErrorTexts;
  canProbe: boolean;
  client: ReturnType<typeof useHostRuntimeClient> | null;
  detecting: boolean;
  detections: readonly ProtocolDetection[] | null;
  detectError: string | null;
  onDetect: () => void;
  onPickDetection: (protocol: GatewayProtocol, base: string) => void;
  onText: (field: TextField, value: string) => void;
  onVertexText: (field: keyof VertexDraft, value: string) => void;
}

/**
 * Where the provider is: its base URL, or Vertex AI's project, location and
 * credentials in its place. A Vertex provider has no address to probe, so the
 * protocol detection stays out of it.
 */
function AddressFields({
  draft,
  errorTexts,
  canProbe,
  client,
  detecting,
  detections,
  detectError,
  onDetect,
  onPickDetection,
  onText,
  onVertexText,
}: AddressFieldsProps) {
  const { t } = useTranslation();
  return (
    <>
      {draft.vertex === null ? (
        <DraftTextRow
          field="baseUrl"
          label={t("settings.gatewayPages.providers.baseUrl")}
          value={draft.baseUrl}
          placeholder={t("settings.gatewayPages.providers.baseUrlPlaceholder")}
          error={errorTexts.baseUrl}
          url
          onText={onText}
          testID="gateway-provider-base-url"
        />
      ) : (
        <VertexFields draft={draft.vertex} errorTexts={errorTexts} onText={onVertexText} />
      )}
      {canProbe && client !== null && draft.vertex === null ? (
        <View style={styles.detectRow}>
          <Button variant="outline" size="sm" onPress={onDetect} loading={detecting}>
            {detecting
              ? t("settings.gatewayPages.providers.detecting")
              : t("settings.gatewayPages.providers.detectProtocols")}
          </Button>
          {detections?.map((detection) => (
            <DetectionChip
              key={detection.protocol}
              detection={detection}
              onPick={onPickDetection}
            />
          ))}
        </View>
      ) : null}
      {detectError === null ? null : <Text style={styles.error}>{detectError}</Text>}
    </>
  );
}

/** Whether the provider's own key is asked for: no accounts yet, and not Vertex's. */
function showsKeyField(draft: ProviderDraft): boolean {
  return draft.accounts.length === 0 && draft.vertex === null;
}

interface VertexFieldsProps {
  draft: VertexDraft;
  errorTexts: { vertexProject: string | undefined; vertexLocation: string | undefined };
  onText: (field: keyof VertexDraft, value: string) => void;
}

/**
 * Google Vertex AI's own fields, in place of the key (`app.js:9583-9588`):
 * the project its requests are made and billed in, the location whose
 * host serves it, the credentials file, and a service account to go as.
 */
function VertexFields({ draft, errorTexts, onText }: VertexFieldsProps) {
  const { t } = useTranslation();
  const setProject = useCallback((value: string) => onText("project", value), [onText]);
  const setLocation = useCallback((value: string) => onText("location", value), [onText]);
  const setCredentials = useCallback((value: string) => onText("credentials", value), [onText]);
  const setImpersonate = useCallback((value: string) => onText("impersonate", value), [onText]);
  return (
    <>
      <Field
        label={t("settings.gatewayPages.providers.vertexProject")}
        error={errorTexts.vertexProject}
        hint={t("settings.gatewayPages.providers.vertexProjectHint")}
      >
        <FormTextInput
          size="sm"
          initialValue={draft.project}
          onChangeText={setProject}
          placeholder={t("settings.gatewayPages.providers.vertexProjectPlaceholder")}
          accessibilityLabel={t("settings.gatewayPages.providers.vertexProject")}
          autoCapitalize="none"
          autoCorrect={false}
          testID="gateway-provider-vertex-project"
        />
      </Field>
      <Field
        label={t("settings.gatewayPages.providers.vertexLocation")}
        error={errorTexts.vertexLocation}
        hint={t("settings.gatewayPages.providers.vertexLocationHint")}
      >
        <FormTextInput
          size="sm"
          initialValue={draft.location}
          onChangeText={setLocation}
          placeholder={t("settings.gatewayPages.providers.vertexLocationPlaceholder")}
          accessibilityLabel={t("settings.gatewayPages.providers.vertexLocation")}
          autoCapitalize="none"
          autoCorrect={false}
          testID="gateway-provider-vertex-location"
        />
      </Field>
      <Field
        label={t("settings.gatewayPages.providers.vertexCredentials")}
        hint={t("settings.gatewayPages.providers.vertexCredentialsHint")}
      >
        <FormTextInput
          size="sm"
          initialValue={draft.credentials}
          onChangeText={setCredentials}
          placeholder={t("settings.gatewayPages.providers.vertexCredentialsPlaceholder")}
          accessibilityLabel={t("settings.gatewayPages.providers.vertexCredentials")}
          autoCapitalize="none"
          autoCorrect={false}
          testID="gateway-provider-vertex-credentials"
        />
      </Field>
      <Field
        label={t("settings.gatewayPages.providers.vertexImpersonate")}
        hint={t("settings.gatewayPages.providers.vertexImpersonateHint")}
      >
        <FormTextInput
          size="sm"
          initialValue={draft.impersonate}
          onChangeText={setImpersonate}
          placeholder={t("settings.gatewayPages.providers.vertexImpersonatePlaceholder")}
          accessibilityLabel={t("settings.gatewayPages.providers.vertexImpersonate")}
          autoCapitalize="none"
          autoCorrect={false}
          testID="gateway-provider-vertex-impersonate"
        />
      </Field>
    </>
  );
}

function vertexProjectError(
  error: ProviderDraftErrors["vertexProject"],
  t: Translate,
): string | undefined {
  if (error === undefined) {
    return undefined;
  }
  return error === "missing"
    ? t("settings.gatewayPages.providers.vertexProjectMissing")
    : t("settings.gatewayPages.providers.vertexProjectInvalid");
}

function draftErrorTexts(errors: ProviderDraftErrors, t: Translate) {
  return {
    id: idErrorMessage(errors.id, t),
    baseUrl: baseUrlErrorMessage(errors.baseUrl, t),
    extraBody:
      errors.extraBody === undefined
        ? undefined
        : t("settings.gatewayPages.providers.extraBodyInvalid"),
    balanceUrl:
      errors.balanceUrl === undefined
        ? undefined
        : t("settings.gatewayPages.providers.balanceUrlInvalid"),
    vertexProject: vertexProjectError(errors.vertexProject, t),
    vertexLocation:
      errors.vertexLocation === undefined
        ? undefined
        : t("settings.gatewayPages.providers.vertexLocationInvalid"),
  };
}

type ProviderClient = ReturnType<typeof useHostRuntimeClient>;

interface BalanceCheckRowProps {
  client: ProviderClient;
  balanceUrl: string;
  balancePath: string;
  balanceToken: string;
  method: GatewayBalanceMethod;
  baseUrl: string;
  accounts: ProviderDraft["accounts"];
  apiKey: string;
  headers: ProviderHeaderDraft[];
}

function hasDraftErrors(errors: ProviderDraftErrors): boolean {
  return (
    errors.id !== undefined ||
    errors.baseUrl !== undefined ||
    errors.vertexProject !== undefined ||
    errors.vertexLocation !== undefined ||
    errors.extraBody !== undefined ||
    errors.balanceUrl !== undefined ||
    errors.rateWindows !== undefined ||
    errors.prices !== undefined
  );
}

/** Asks the provider's balance endpoint and shows what it says, when it is asked. */
function BalanceCheckRow({
  client,
  balanceUrl,
  balancePath,
  balanceToken,
  method,
  baseUrl,
  accounts,
  apiKey,
  headers,
}: BalanceCheckRowProps) {
  const { t } = useTranslation();
  const [result, setResult] = useState<{ amount: string | null; error?: string } | null>(null);
  const [checking, setChecking] = useState(false);
  const bases = useMemo(() => {
    const all = [baseUrl.trim(), ...accounts.map((account) => account.baseUrl?.trim() ?? "")];
    return all.filter((entry) => entry.length > 0);
  }, [accounts, baseUrl]);
  const target = useMemo(() => {
    const sent: Record<string, string> = {};
    for (const header of headers) {
      if (header.name.trim().length > 0) {
        sent[header.name.trim()] = header.value;
      }
    }
    return {
      balanceUrl: balanceUrl.trim(),
      ...(balancePath.trim().length === 0 ? {} : { balancePath: balancePath.trim() }),
      ...(apiKey.trim().length === 0 ? {} : { apiKey: apiKey.trim() }),
      ...(bases.length === 0 ? {} : { baseUrls: bases }),
      ...(Object.keys(sent).length === 0 ? {} : { headers: sent }),
      ...(method === "GET" ? {} : { method }),
      ...(balanceToken.trim().length === 0 ? {} : { token: balanceToken.trim() }),
    };
  }, [apiKey, balancePath, balanceToken, balanceUrl, bases, headers, method]);
  const handleCheck = useCallback(() => {
    if (client === null) {
      return;
    }
    setChecking(true);
    setResult(null);
    void client
      .getGatewayProviderBalance(target)
      .then((answer) => {
        setResult({
          amount: answer.amount,
          ...(answer.error === undefined ? {} : { error: answer.error }),
        });
        return undefined;
      })
      .catch((cause: unknown) => {
        setResult({
          amount: null,
          error: cause instanceof Error ? cause.message : String(cause),
        });
      })
      .finally(() => setChecking(false));
  }, [client, target]);

  if (client === null) {
    return null;
  }
  return (
    <View style={styles.balanceRow}>
      <Button variant="outline" size="sm" onPress={handleCheck} loading={checking}>
        {checking
          ? t("settings.gatewayPages.providers.checkingBalance")
          : t("settings.gatewayPages.providers.checkBalance")}
      </Button>
      {result === null || result.amount === null ? null : (
        <Text style={styles.balanceValue}>
          {t("settings.gatewayPages.providers.balanceResult", { amount: result.amount })}
        </Text>
      )}
      {result === null || result.error === undefined ? null : (
        <Text style={styles.balanceError}>{result.error}</Text>
      )}
    </View>
  );
}

interface ProviderToggleRowProps {
  label: string;
  hint: string;
  value: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
}

/** One optional provider switch, with its explanation under it. */
function ProviderToggleRow({
  label,
  hint,
  value,
  disabled = false,
  onChange,
}: ProviderToggleRowProps) {
  return (
    <>
      <View style={styles.inlineRow}>
        <Text style={styles.inlineLabel}>{label}</Text>
        <Switch
          value={value && !disabled}
          onValueChange={onChange}
          disabled={disabled}
          accessibilityLabel={label}
        />
      </View>
      <Text style={styles.hint}>{hint}</Text>
    </>
  );
}

interface CompactionRowProps {
  value: boolean;
  canCarry: boolean;
  onChange: (value: boolean) => void;
}

/** Codex's native compaction, which only a Responses API provider can carry. */
function CompactionRow({ value, canCarry, onChange }: CompactionRowProps) {
  const { t } = useTranslation();
  return (
    <>
      <View style={styles.inlineRow}>
        <Text style={styles.inlineLabel}>
          {t("settings.gatewayPages.providers.nativeCompaction")}
        </Text>
        <Switch
          value={value && canCarry}
          onValueChange={onChange}
          disabled={!canCarry}
          accessibilityLabel={t("settings.gatewayPages.providers.nativeCompaction")}
        />
      </View>
      <Text style={styles.hint}>
        {canCarry
          ? t("settings.gatewayPages.providers.nativeCompactionHint")
          : t("settings.gatewayPages.providers.nativeCompactionUnsupported")}
      </Text>
    </>
  );
}

export function ProviderEditor({
  serverId,
  pricing,
  modelSameAs,
  providers,
  provider,
  originalId,
  copyOfName,
  preset,
  codexAutoSwitchSignIn,
  claudeAutoSwitchSignIn,
  onClose,
  onSave,
  onRemove,
  onDuplicate,
}: ProviderEditorProps) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const canProbe = useHostFeature(serverId, "gatewayProviderProbe");
  const [draft, setDraft] = useState<ProviderDraft>(() =>
    preset !== null && provider === null
      ? presetDraft(preset, providers)
      : openProviderDraft(provider, pricing, modelSameAs),
  );
  const [errors, setErrors] = useState<ProviderDraftErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [codexAutoSwitch, setCodexAutoSwitch] = useState(codexAutoSwitchSignIn);
  const [claudeAutoSwitch, setClaudeAutoSwitch] = useState(claudeAutoSwitchSignIn);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const advancedState = useMemo(() => ({ expanded: advancedOpen }), [advancedOpen]);
  const [fetched, setFetched] = useState<string[] | null>(null);
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [testingModel, setTestingModel] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, ModelTestResult>>({});
  const [detections, setDetections] = useState<readonly ProtocolDetection[] | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [detectError, setDetectError] = useState<string | null>(null);
  const canBalance = useHostFeature(serverId, "gatewayProviderBalance");
  const pluginProvider = useMemo(
    () => ({ id: draft.id, name: draft.label || draft.id }),
    [draft.id, draft.label],
  );

  const title = editorTitle(provider, copyOfName, preset, t);

  const setText = useCallback((field: TextField, value: string) => {
    setDraft((previous) => ({ ...previous, [field]: value }));
    if (field === "id" || field === "baseUrl" || field === "balanceUrl") {
      setErrors((previous) => ({ ...previous, [field]: undefined }));
    }
  }, []);
  const setWorkspaceText = useCallback((_field: TextField, value: string) => {
    setDraft((previous) => ({
      ...previous,
      workspace: value,
      // A decision address's {WorkspaceId} is filled in as it is typed
      // (myna's Workspace ID row); the template itself stays in `decide`.
      baseUrl: previous.decide.includes("{WorkspaceId}")
        ? previous.decide.replaceAll("{WorkspaceId}", value.trim())
        : previous.baseUrl,
    }));
  }, []);
  const setVertex = useCallback((field: keyof VertexDraft, value: string) => {
    setDraft((previous) =>
      previous.vertex === null
        ? previous
        : { ...previous, vertex: { ...previous.vertex, [field]: value } },
    );
    if (field === "project" || field === "location") {
      setErrors((previous) => ({
        ...previous,
        [field === "project" ? "vertexProject" : "vertexLocation"]: undefined,
      }));
    }
  }, []);
  const setNumberText = useCallback((field: NumberField, value: string) => {
    setDraft((previous) => ({ ...previous, [field]: value }));
  }, []);
  const setSink = useCallback(
    (value: boolean) => setDraft((previous) => ({ ...previous, sink: value })),
    [],
  );
  const setInsecureTls = useCallback(
    (value: boolean) => setDraft((previous) => ({ ...previous, insecureTls: value })),
    [],
  );
  const setExposeModels = useCallback(
    (value: boolean) => setDraft((previous) => ({ ...previous, exposeModels: value })),
    [],
  );
  const setSwitchOnly = useCallback(
    (value: boolean) => setDraft((previous) => ({ ...previous, switchOnly: value })),
    [],
  );
  const setRestartApp = useCallback(
    (value: boolean) => setDraft((previous) => ({ ...previous, restartApp: value })),
    [],
  );
  const setUnredacted = useCallback(
    (value: boolean) => setDraft((previous) => ({ ...previous, unredacted: value })),
    [],
  );
  const setBalanceMethod = useCallback(
    (value: GatewayBalanceMethod) =>
      setDraft((previous) => ({ ...previous, balanceMethod: value })),
    [],
  );
  const setModelMode = useCallback(
    (value: GatewayModelMode) => setDraft((previous) => ({ ...previous, modelMode: value })),
    [],
  );
  const setEnabled = useCallback(
    (value: boolean) => setDraft((previous) => ({ ...previous, enabled: value })),
    [],
  );
  const setProtocol = useCallback(
    (value: GatewayProtocol) => {
      setDraft((previous) => {
        const previousUrl = preset?.endpoints[previous.protocol];
        const nextUrl = preset?.endpoints[value];
        // A vendor that serves several protocols at different URLs moves the
        // base URL with the protocol, unless the user typed one of their own.
        const followsPreset =
          nextUrl !== undefined &&
          (previous.baseUrl.trim() === "" || previous.baseUrl === previousUrl);
        return {
          ...previous,
          protocol: value,
          baseUrl: followsPreset ? nextUrl : previous.baseUrl,
          nativeCompaction: value === "openai-responses" ? previous.nativeCompaction : false,
          // The daemon answers for the saved address; until then the switch
          // starts off, and a saved provider with no explicit value takes the
          // verdict the next read brings.
          searches: false,
          searchesUpstream: false,
        };
      });
    },
    [preset],
  );
  const setAccounts = useCallback(
    (accounts: ProviderDraft["accounts"]) => setDraft((previous) => ({ ...previous, accounts })),
    [],
  );
  const setHeaders = useCallback(
    (headers: ProviderHeaderDraft[]) => setDraft((previous) => ({ ...previous, headers })),
    [],
  );
  const setModels = useCallback(
    (models: ProviderDraft["models"]) => setDraft((previous) => ({ ...previous, models })),
    [],
  );
  const modelModeOptions = useMemo(
    () =>
      MODEL_MODE_OPTIONS.map((option) => ({
        value: option.value,
        label: t(`settings.gatewayPages.providers.${option.labelKey}`),
      })),
    [t],
  );
  const setVideoApi = useCallback(
    (value: string) =>
      setDraft((previous) => ({
        ...previous,
        videoApi: value === "auto" ? null : (value as GatewayVideoApi),
      })),
    [],
  );
  const toggleAdvanced = useCallback(() => setAdvancedOpen((open) => !open), []);
  const toggleRevealed = useCallback(() => setRevealed((value) => !value), []);
  const setCountFree = useCallback(
    (value: boolean) => setDraft((previous) => ({ ...previous, countFree: value })),
    [],
  );
  const setSearches = useCallback(
    (value: boolean) => setDraft((previous) => ({ ...previous, searches: value })),
    [],
  );
  const setNativeCompaction = useCallback(
    (value: boolean) => setDraft((previous) => ({ ...previous, nativeCompaction: value })),
    [],
  );
  const setRateWindows = useCallback(
    (windows: ProviderDraft["rateWindows"]) =>
      setDraft((previous) => ({ ...previous, rateWindows: windows })),
    [],
  );
  const setModelPrice = useCallback(
    (modelId: string, price: ModelPriceDraft) =>
      setDraft((previous) => {
        const prices: ModelPriceDrafts = { ...previous.prices, [modelId]: price };
        return { ...previous, prices };
      }),
    [],
  );
  const setModelSameAs = useCallback(
    (modelId: string, same: string) =>
      setDraft((previous) => ({
        ...previous,
        sameAs: { ...previous.sameAs, [modelId]: same },
      })),
    [],
  );

  const headerActions = useMemo(
    () => (
      <Switch
        value={draft.enabled}
        onValueChange={setEnabled}
        accessibilityLabel={t("settings.gatewayPages.providers.enabled")}
      />
    ),
    [draft.enabled, setEnabled, t],
  );
  const sheetHeader = useMemo(() => ({ title, actions: headerActions }), [title, headerActions]);

  const probeTarget = useMemo(() => {
    const account = draft.accounts.find((entry) => entry.enabled !== false);
    const apiKey =
      account?.apiKey !== undefined && account.apiKey.length > 0
        ? account.apiKey
        : draft.apiKey.trim();
    const headers: Record<string, string> = {};
    for (const header of draft.headers) {
      if (header.name.trim().length > 0) {
        headers[header.name.trim()] = header.value;
      }
    }
    for (const [name, value] of Object.entries(account?.headers ?? {})) {
      headers[name] = value;
    }
    return {
      protocol: draft.protocol,
      baseUrl: (account?.baseUrl ?? draft.baseUrl).trim(),
      ...(apiKey.length > 0 ? { apiKey } : {}),
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
      ...(draft.insecureTls ? { insecureTls: true } : {}),
      ...(draft.modelsUrl.trim().length > 0 ? { modelsUrl: draft.modelsUrl.trim() } : {}),
      // A saved provider's refreshed list takes its new models by rule, in
      // the daemon, and is saved there.
      ...(draft.id.trim().length > 0 ? { providerId: draft.id.trim() } : {}),
    };
  }, [
    draft.accounts,
    draft.apiKey,
    draft.baseUrl,
    draft.headers,
    draft.id,
    draft.insecureTls,
    draft.modelsUrl,
    draft.protocol,
  ]);

  const handleFetch = useCallback(() => {
    if (!client) {
      return;
    }
    setFetching(true);
    setFetchError(null);
    void client
      .getGatewayProviderModels(probeTarget)
      .then((result) => {
        setFetched(result.models);
        if (result.error !== null) {
          setFetchError(result.error);
        }
        return undefined;
      })
      .catch((cause: unknown) => {
        setFetchError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => setFetching(false));
  }, [client, probeTarget]);

  const handleTest = useCallback(
    (modelId: string) => {
      if (!client) {
        return;
      }
      setTestingModel(modelId);
      void client
        .testGatewayProviderModel(probeTarget, modelId)
        .then((result) => {
          setTestResults((previous) => ({
            ...previous,
            [modelId]: { ok: result.ok, message: testMessage(result, t) },
          }));
          return undefined;
        })
        .catch((cause: unknown) => {
          setTestResults((previous) => ({
            ...previous,
            [modelId]: {
              ok: false,
              message: t("settings.gatewayPages.providers.testNoAnswer", {
                error: cause instanceof Error ? cause.message : String(cause),
              }),
            },
          }));
        })
        .finally(() => setTestingModel(null));
    },
    [client, probeTarget, t],
  );

  const handleDetect = useCallback(() => {
    if (!client) {
      return;
    }
    setDetecting(true);
    setDetectError(null);
    setDetections(null);
    void client
      .detectGatewayProviderProtocols(probeTarget, draft.models[0]?.id)
      .then((result) => {
        setDetections(result.results);
        return undefined;
      })
      .catch((cause: unknown) => {
        setDetectError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => setDetecting(false));
  }, [client, draft.models, probeTarget]);

  const handlePickDetection = useCallback((protocol: GatewayProtocol, base: string) => {
    setDraft((previous) => ({ ...previous, protocol, baseUrl: base }));
  }, []);

  const canModelPrices = useHostFeature(serverId, "gatewayPricingCatalog");
  const catalogPrices = useModelPriceCatalog(serverId, draft.id, draft.models, canModelPrices);
  const handleSave = useCallback(() => {
    const validation = validateProviderDraft(draft, providers, originalId);
    setErrors(validation);
    if (validation.prices !== undefined) {
      setSubmitError(
        t("settings.gatewayPages.providers.priceInvalid", { model: validation.prices }),
      );
      return;
    }
    if (hasDraftErrors(validation)) {
      return;
    }
    const prices = canModelPrices ? modelPriceUpdates(draft, catalogPrices) : { prices: {} };
    if (prices.error !== undefined) {
      setSubmitError(
        t(
          prices.error === "tier"
            ? "settings.gatewayPages.providers.priceTierInvalid"
            : "settings.gatewayPages.providers.priceInvalid",
          { model: prices.model ?? "" },
        ),
      );
      return;
    }
    setPending(true);
    setSubmitError(null);
    const sameAs = Object.fromEntries(
      Object.entries(draft.sameAs).map(([modelId, value]) => [modelId, value.trim()]),
    );
    void onSave(buildProvider(draft), originalId, prices.prices, sameAs, {
      ...(draft.id === "codex" ? { codex: codexAutoSwitch } : {}),
      ...(draft.id === "claude" ? { claude: claudeAutoSwitch } : {}),
    })
      .catch((cause: unknown) => {
        setSubmitError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => setPending(false));
  }, [
    canModelPrices,
    catalogPrices,
    claudeAutoSwitch,
    codexAutoSwitch,
    draft,
    onSave,
    originalId,
    providers,
    t,
  ]);

  const handleRemove = useCallback(() => {
    if (originalId === null) {
      return;
    }
    void confirmDialog({
      title: t("settings.gatewayPages.providers.deleteTitle", { name: title }),
      message: t("settings.gatewayPages.providers.deleteMessage"),
      confirmLabel: t("settings.gatewayPages.providers.delete"),
      cancelLabel: t("settings.gatewayPages.providers.cancel"),
      destructive: true,
    }).then((confirmed) => {
      if (!confirmed) {
        return false;
      }
      setPending(true);
      setSubmitError(null);
      void onRemove(originalId)
        .catch((cause: unknown) => {
          setSubmitError(cause instanceof Error ? cause.message : String(cause));
        })
        .finally(() => setPending(false));
      return true;
    });
  }, [onRemove, originalId, t, title]);

  const errorTexts = draftErrorTexts(errors, t);
  const models = draft.models;
  const showVideoApi = hasVideoModels(models);
  const handleDuplicate = useCallback(() => {
    if (originalId !== null) {
      onDuplicate(originalId);
    }
  }, [onDuplicate, originalId]);
  const footer = useMemo(
    () => (
      <View style={styles.footer}>
        {originalId === null ? null : (
          <Button
            variant="ghost"
            size="sm"
            leftIcon={Trash2}
            onPress={handleRemove}
            textStyle={styles.dangerText}
            disabled={pending}
          >
            {t("settings.gatewayPages.providers.delete")}
          </Button>
        )}
        {originalId === null ? null : (
          <Button variant="ghost" size="sm" onPress={handleDuplicate} disabled={pending}>
            {t("settings.gatewayPages.providers.duplicate")}
          </Button>
        )}
        <View style={styles.footerGrow} />
        <Button variant="secondary" size="sm" onPress={onClose} disabled={pending}>
          {t("settings.gatewayPages.providers.cancel")}
        </Button>
        <Button variant="default" size="sm" onPress={handleSave} disabled={pending}>
          {pending
            ? t("settings.gatewayPages.providers.saving")
            : t("settings.gatewayPages.providers.save")}
        </Button>
      </View>
    ),
    [handleDuplicate, handleRemove, handleSave, onClose, originalId, pending, t],
  );

  return (
    <AdaptiveModalSheet
      visible
      header={sheetHeader}
      onClose={onClose}
      footer={footer}
      desktopMaxWidth={640}
      testID="gateway-provider-editor"
    >
      <View style={styles.body}>
        <DraftTextRow
          field="label"
          label={t("settings.gatewayPages.providers.name")}
          value={draft.label}
          placeholder={t("settings.gatewayPages.providers.namePlaceholder")}
          onText={setText}
          testID="gateway-provider-name"
        />
        <DraftTextRow
          field="id"
          label={t("settings.gatewayPages.providers.id")}
          value={draft.id}
          hint={t("settings.gatewayPages.providers.idHint", { id: draft.id || "…" })}
          error={errorTexts.id}
          onText={setText}
          testID="gateway-provider-id"
        />
        <Field label={t("settings.gatewayPages.providers.protocol")}>
          <SegmentedControl
            options={PROTOCOL_OPTIONS}
            value={draft.protocol}
            onValueChange={setProtocol}
            size="sm"
          />
        </Field>
        <DraftTextRow
          field="family"
          label={t("settings.gatewayPages.providers.family")}
          value={draft.family}
          hint={t("settings.gatewayPages.providers.familyHint")}
          onText={setText}
          testID="gateway-provider-family"
        />
        {draft.decide.includes("{WorkspaceId}") ? (
          <DraftTextRow
            field="workspace"
            label={t("settings.gatewayPages.providers.workspaceId")}
            value={draft.workspace}
            hint={t("settings.gatewayPages.providers.workspaceHint")}
            onText={setWorkspaceText}
            testID="gateway-provider-workspace"
          />
        ) : null}
        <AddressFields
          draft={draft}
          errorTexts={errorTexts}
          canProbe={canProbe}
          client={client}
          detecting={detecting}
          detections={detections}
          detectError={detectError}
          onDetect={handleDetect}
          onPickDetection={handlePickDetection}
          onText={setText}
          onVertexText={setVertex}
        />

        <View style={styles.inlineRow}>
          <Text style={styles.inlineLabel}>{t("settings.gatewayPages.providers.certificate")}</Text>
          <Switch
            value={draft.insecureTls}
            onValueChange={setInsecureTls}
            accessibilityLabel={t("settings.gatewayPages.providers.notCheckCertificate")}
          />
        </View>
        <Text style={styles.hint}>
          {t("settings.gatewayPages.providers.notCheckCertificate")} ·{" "}
          {t("settings.gatewayPages.providers.certificateHint")}
        </Text>

        {showsKeyField(draft) ? (
          <>
            <View style={styles.secretRow}>
              <View style={styles.secretField}>
                <DraftTextRow
                  field="apiKey"
                  label={t("settings.gatewayPages.providers.apiKey")}
                  value={draft.apiKey}
                  placeholder={t("settings.gatewayPages.providers.apiKeyPlaceholder")}
                  secure={!revealed}
                  onText={setText}
                  testID="gateway-provider-key"
                />
              </View>
              <Button variant="ghost" size="sm" onPress={toggleRevealed}>
                {revealed
                  ? t("settings.gatewayPages.providers.hideKey")
                  : t("settings.gatewayPages.providers.showKey")}
              </Button>
            </View>
            {preset?.keysUrl === undefined ? null : (
              <View style={styles.keysLink}>
                <ExternalLink
                  href={preset.keysUrl}
                  label={t("settings.gatewayPages.providers.getKey")}
                />
              </View>
            )}
          </>
        ) : null}

        <AccountsEditor accounts={draft.accounts} onChange={setAccounts} />
        <ProviderPluginPanels serverId={serverId} provider={pluginProvider} />
        <ClaudeModeRow
          serverId={serverId}
          visible={draft.accounts.some((account) => account.agent === "claude-code")}
        />

        <DraftTextRow
          field="balanceUrl"
          label={t("settings.gatewayPages.providers.balanceUrl")}
          value={draft.balanceUrl}
          hint={t("settings.gatewayPages.providers.balanceUrlHint")}
          error={errorTexts.balanceUrl}
          onText={setText}
          testID="gateway-provider-balance-url"
        />
        <DraftTextRow
          field="balancePath"
          label={t("settings.gatewayPages.providers.balancePath")}
          value={draft.balancePath}
          hint={t("settings.gatewayPages.providers.balancePathHint")}
          onText={setText}
          testID="gateway-provider-balance-path"
        />
        <Field
          label={t("settings.gatewayPages.providers.balanceMethod")}
          hint={t("settings.gatewayPages.providers.balanceMethodHint")}
        >
          <SegmentedControl
            options={BALANCE_METHOD_OPTIONS}
            value={draft.balanceMethod}
            onValueChange={setBalanceMethod}
            size="sm"
          />
        </Field>
        <DraftTextRow
          field="balanceToken"
          label={t("settings.gatewayPages.providers.balanceToken")}
          value={draft.balanceToken}
          hint={t("settings.gatewayPages.providers.balanceTokenHint")}
          secure
          onText={setText}
          testID="gateway-provider-balance-token"
        />
        {canBalance ? (
          <BalanceCheckRow
            client={client}
            balanceUrl={draft.balanceUrl}
            balancePath={draft.balancePath}
            balanceToken={draft.balanceToken}
            method={draft.balanceMethod}
            baseUrl={draft.baseUrl}
            accounts={draft.accounts}
            apiKey={draft.apiKey}
            headers={draft.headers}
          />
        ) : null}

        <DraftTextRow
          field="icon"
          label={t("settings.gatewayPages.providers.icon")}
          value={draft.icon}
          hint={t("settings.gatewayPages.providers.iconHint")}
          onText={setText}
          testID="gateway-provider-icon"
        />

        <Field
          label={t("settings.gatewayPages.providers.modelMode")}
          hint={t(`settings.gatewayPages.providers.${MODEL_MODE_HINTS[draft.modelMode]}`)}
        >
          <SegmentedControl
            options={modelModeOptions}
            value={draft.modelMode}
            onValueChange={setModelMode}
            size="sm"
          />
        </Field>

        <ModelsEditor
          models={models}
          mode={draft.modelMode}
          prices={draft.prices}
          onPriceChange={setModelPrice}
          sameAs={draft.sameAs}
          onSameAsChange={setModelSameAs}
          catalog={catalogPrices}
          canPrice={canModelPrices}
          onChange={setModels}
          fetched={fetched}
          fetching={fetching}
          fetchError={fetchError}
          canProbe={canProbe && client !== null}
          onFetch={handleFetch}
          onTest={handleTest}
          testingModel={testingModel}
          testResults={testResults}
        />

        {showVideoApi ? (
          <Field label={t("settings.gatewayPages.providers.videoApi")}>
            <SegmentedControl
              options={VIDEO_API_OPTIONS}
              value={draft.videoApi ?? "auto"}
              onValueChange={setVideoApi}
              size="sm"
            />
          </Field>
        ) : null}

        <PressHighlight
          style={styles.advancedToggle}
          onPress={toggleAdvanced}
          accessibilityRole="button"
          accessibilityState={advancedState}
          testID="gateway-provider-advanced"
        >
          <View style={advancedOpen ? styles.chevronOpen : undefined}>
            <ThemedChevron size={12} uniProps={mutedColorMapping} />
          </View>
          <Text style={styles.advancedLabel}>{t("settings.gatewayPages.providers.advanced")}</Text>
        </PressHighlight>

        {advancedOpen ? (
          <View style={styles.advancedBody}>
            <HeadersEditor headers={draft.headers} onChange={setHeaders} />
            <View style={styles.numberGrid}>
              <DraftNumberRow
                field="maxAccounts"
                label={t("settings.gatewayPages.providers.maxAccounts")}
                value={draft.maxAccounts}
                hint={t("settings.gatewayPages.providers.maxAccountsHint")}
                onNumber={setNumberText}
              />
              <DraftNumberRow
                field="queueWaitMs"
                label={t("settings.gatewayPages.providers.queueWaitMs")}
                value={draft.queueWaitMs}
                hint={t("settings.gatewayPages.providers.queueWaitMsHint")}
                onNumber={setNumberText}
              />
            </View>
            <View style={styles.numberGrid}>
              <DraftNumberRow
                field="priceRate"
                label={t("settings.gatewayPages.providers.priceRate")}
                value={draft.priceRate}
                hint={t("settings.gatewayPages.providers.priceRateHint")}
                onNumber={setNumberText}
              />
            </View>
            <ProviderToggleRow
              label={t("settings.gatewayPages.providers.countFree")}
              hint={t("settings.gatewayPages.providers.countFreeHint")}
              value={draft.countFree}
              onChange={setCountFree}
            />
            <RateWindowsEditor
              windows={draft.rateWindows}
              onChange={setRateWindows}
              error={
                errors.rateWindows === undefined
                  ? undefined
                  : t("settings.gatewayPages.providers.rateWindowsInvalid")
              }
            />
            <CompactionRow
              value={draft.nativeCompaction}
              canCarry={draft.protocol === "openai-responses"}
              onChange={setNativeCompaction}
            />
            <ProviderToggleRow
              label={t("settings.gatewayPages.providers.searches")}
              hint={t("settings.gatewayPages.providers.searchesHint")}
              value={draft.searches}
              onChange={setSearches}
            />
            <View style={styles.inlineRow}>
              <Text style={styles.inlineLabel}>
                {t("settings.gatewayPages.providers.exposeModels")}
              </Text>
              <Switch
                value={draft.exposeModels}
                onValueChange={setExposeModels}
                accessibilityLabel={t("settings.gatewayPages.providers.exposeModels")}
              />
            </View>
            <Text style={styles.hint}>{t("settings.gatewayPages.providers.exposeModelsHint")}</Text>
            <View style={styles.inlineRow}>
              <Text style={styles.inlineLabel}>
                {t("settings.gatewayPages.providers.unredacted")}
              </Text>
              <Switch
                value={draft.unredacted}
                onValueChange={setUnredacted}
                accessibilityLabel={t("settings.gatewayPages.providers.unredacted")}
              />
            </View>
            <Text style={styles.hint}>{t("settings.gatewayPages.providers.unredactedHint")}</Text>
            {draft.id === "codex" || draft.id === "claude" ? (
              <ProviderToggleRow
                label={t("settings.gatewayPages.providers.switchOnly")}
                hint={t("settings.gatewayPages.providers.switchOnlyHint")}
                value={draft.switchOnly}
                onChange={setSwitchOnly}
              />
            ) : null}
            {draft.id === "codex" ? (
              <ProviderToggleRow
                label={t("settings.gatewayPages.providers.codexAutoSwitchSignIn")}
                hint={t("settings.gatewayPages.providers.codexAutoSwitchSignInHint")}
                value={codexAutoSwitch}
                onChange={setCodexAutoSwitch}
              />
            ) : null}
            {draft.id === "codex" ? (
              <ProviderToggleRow
                label={t("settings.gatewayPages.providers.restartApp")}
                hint={t("settings.gatewayPages.providers.restartAppHint")}
                value={draft.restartApp}
                onChange={setRestartApp}
              />
            ) : null}
            {draft.id === "claude" ? (
              <ProviderToggleRow
                label={t("settings.gatewayPages.providers.claudeAutoSwitchSignIn")}
                hint={t("settings.gatewayPages.providers.claudeAutoSwitchSignInHint")}
                value={claudeAutoSwitch}
                onChange={setClaudeAutoSwitch}
              />
            ) : null}
            <DraftTextRow
              field="extraBody"
              label={t("settings.gatewayPages.providers.extraBody")}
              value={draft.extraBody}
              hint={t("settings.gatewayPages.providers.extraBodyHint")}
              error={errorTexts.extraBody}
              multiline
              multilineLines={6}
              onText={setText}
              testID="gateway-provider-extra-body"
            />
            <View style={styles.inlineRow}>
              <Text style={styles.inlineLabel}>{t("settings.gatewayPages.providers.sink")}</Text>
              <Switch
                value={draft.sink}
                onValueChange={setSink}
                accessibilityLabel={t("settings.gatewayPages.providers.sink")}
              />
            </View>
            <Text style={styles.hint}>{t("settings.gatewayPages.providers.sinkHint")}</Text>
          </View>
        ) : null}

        {submitError === null ? null : <Text style={styles.error}>{submitError}</Text>}
      </View>
    </AdaptiveModalSheet>
  );
}

type Translate = ReturnType<typeof useTranslation>["t"];

function editorTitle(
  provider: GatewayProviderWire | null,
  copyOfName: string | null,
  preset: GatewayProviderPreset | null,
  t: Translate,
): string {
  if (provider !== null) {
    return provider.label ?? provider.id;
  }
  if (copyOfName !== null) {
    return t("settings.gatewayPages.providers.copyOf", { name: copyOfName });
  }
  if (preset !== null) {
    return preset.name;
  }
  return t("settings.gatewayPages.providers.newProvider");
}

function idErrorMessage(error: ProviderDraftErrors["id"], t: Translate): string | undefined {
  if (error === undefined) {
    return undefined;
  }
  return error === "taken"
    ? t("settings.gatewayPages.providers.idTaken")
    : t("settings.gatewayPages.providers.idInvalid");
}

function baseUrlErrorMessage(
  error: ProviderDraftErrors["baseUrl"],
  t: Translate,
): string | undefined {
  if (error === undefined) {
    return undefined;
  }
  return error === "missing"
    ? t("settings.gatewayPages.providers.missingBaseUrl")
    : t("settings.gatewayPages.providers.invalidBaseUrl");
}

function testMessage(
  result: { ok: boolean; status: number; latencyMs: number; error: string | null },
  t: Translate,
): string {
  if (result.ok) {
    return t("settings.gatewayPages.providers.testOk", { ms: result.latencyMs });
  }
  if (result.status === 0) {
    return t("settings.gatewayPages.providers.testNoAnswer", { error: result.error ?? "" });
  }
  return t("settings.gatewayPages.providers.testFailed", {
    status: result.status,
    error: result.error ?? "",
  });
}

const styles = StyleSheet.create((theme) => ({
  body: {
    gap: theme.spacing[4],
    paddingBottom: theme.spacing[2],
  },
  secretRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: theme.spacing[2],
  },
  secretField: {
    flex: 1,
    minWidth: 0,
  },
  keysLink: {
    flexDirection: "row",
  },
  detectRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  detectChipFailed: {
    opacity: theme.opacity[50],
  },
  multilineInput: {
    minHeight: theme.spacing[20],
    textAlignVertical: "top",
  },
  numberGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[3],
  },
  numberCell: {
    flexGrow: 1,
    flexBasis: 160,
    minWidth: 0,
  },
  headersList: {
    gap: theme.spacing[2],
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  headerField: {
    flex: 1,
    minWidth: 0,
  },
  headerValueField: {
    flex: 2,
    minWidth: 0,
  },
  addHeaderRow: {
    alignItems: "flex-start",
  },
  inlineRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
  },
  inlineLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  advancedToggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    alignSelf: "flex-start",
  },
  advancedLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  advancedBody: {
    gap: theme.spacing[3],
  },
  chevronOpen: {
    transform: [{ rotate: "90deg" }],
  },
  hint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  error: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.sm,
  },
  balanceRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  balanceValue: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  balanceError: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.sm,
    flexShrink: 1,
  },
  dangerText: {
    color: theme.colors.statusDanger,
  },
  footer: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  footerGrow: {
    flex: 1,
  },
}));
