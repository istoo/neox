import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { ChevronRight, X } from "lucide-react-native";
import type { GatewayPriceWire, GatewayProviderWire } from "@neolix/protocol/gateway";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { PressHighlight } from "@/components/ui/press-highlight";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Switch } from "@/components/ui/switch";
import type { Theme } from "@/styles/theme";
import type {
  GatewayModelKind,
  GatewayModelMode,
  ModelPriceDraft,
  ModelPriceDrafts,
} from "./providers-helpers";
import { ModelPriceFields } from "./providers-model-prices";

type GatewayModelWire = GatewayProviderWire["models"][number];

const ThemedChevron = withUnistyles(ChevronRight);
const ThemedX = withUnistyles(X);

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export interface ModelTestResult {
  ok: boolean;
  message: string;
}

export interface ModelsEditorProps {
  models: GatewayModelWire[];
  /** The provider's model mode; `picked` shows each model's pick switch. */
  mode: GatewayModelMode;
  /** Model id → the price the user set by hand. */
  prices: ModelPriceDrafts;
  onPriceChange: (modelId: string, price: ModelPriceDraft) => void;
  /** Model id → the model id it is the same as. */
  sameAs: Record<string, string>;
  onSameAsChange: (modelId: string, same: string) => void;
  /** The catalog's prices, shown as placeholders and compared on save. */
  catalog: Record<string, GatewayPriceWire | null>;
  canPrice: boolean;
  onChange: (models: GatewayModelWire[]) => void;
  fetched: string[] | null;
  fetching: boolean;
  fetchError: string | null;
  canProbe: boolean;
  onFetch: () => void;
  onTest: (modelId: string) => void;
  testingModel: string | null;
  testResults: Record<string, ModelTestResult>;
}

const KIND_OPTIONS = ["chat", "image", "video"] as const;

/** A model's answer for images: not set, accepted, or refused. */
type ImageChoice = "unknown" | "yes" | "no";

const EMPTY_PRICE: ModelPriceDraft = {
  input: "",
  output: "",
  cacheRead: "",
  cacheWrite: "",
  cacheWrite1h: "",
  tierAbove: "",
  tierInput: "",
  tierOutput: "",
};

const KIND_LABEL_KEYS = {
  chat: "settings.gatewayPages.providers.kindChat",
  image: "settings.gatewayPages.providers.kindImage",
  video: "settings.gatewayPages.providers.kindVideo",
} as const;

interface ModelDetailsRowProps {
  model: GatewayModelWire;
  index: number;
  onUpdate: (index: number, mutate: (model: GatewayModelWire) => void) => void;
  onRemove: (modelId: string) => void;
  onTest: (modelId: string) => void;
  canProbe: boolean;
  testing: boolean;
  result: ModelTestResult | undefined;
  pickedMode: boolean;
  price: ModelPriceDraft | undefined;
  priceCatalog: GatewayPriceWire | null;
  canPrice: boolean;
  onPriceChange: (modelId: string, price: ModelPriceDraft) => void;
  same: string;
  onSameAsChange: (modelId: string, same: string) => void;
}

function ModelDetailsRow({
  model,
  index,
  onUpdate,
  onRemove,
  onTest,
  canProbe,
  testing,
  result,
  pickedMode,
  price,
  priceCatalog,
  canPrice,
  onPriceChange,
  same,
  onSameAsChange,
}: ModelDetailsRowProps) {
  const { t } = useTranslation();
  const handleKind = useCallback(
    (kind: GatewayModelKind) => {
      onUpdate(index, (next) => {
        next.kind = kind === "chat" ? undefined : kind;
      });
    },
    [index, onUpdate],
  );
  const handleContext = useCallback(
    (text: string) => {
      onUpdate(index, (next) => {
        next.contextWindow = positiveInteger(text);
      });
    },
    [index, onUpdate],
  );
  const handleOutput = useCallback(
    (text: string) => {
      onUpdate(index, (next) => {
        next.maxOutputTokens = positiveInteger(text);
      });
    },
    [index, onUpdate],
  );
  const handleRemove = useCallback(() => onRemove(model.id), [model.id, onRemove]);
  const handleTest = useCallback(() => onTest(model.id), [model.id, onTest]);
  const handlePrice = useCallback(
    (next: ModelPriceDraft) => onPriceChange(model.id, next),
    [model.id, onPriceChange],
  );
  const handleSameAs = useCallback(
    (text: string) => onSameAsChange(model.id, text),
    [model.id, onSameAsChange],
  );
  const handleImages = useCallback(
    (value: ImageChoice) => {
      onUpdate(index, (next) => {
        if (value === "unknown") {
          next.images = undefined;
        } else {
          next.images = value === "yes";
        }
      });
    },
    [index, onUpdate],
  );
  const handlePicked = useCallback(
    (picked: boolean) => {
      onUpdate(index, (next) => {
        next.picked = picked ? true : undefined;
      });
    },
    [index, onUpdate],
  );
  const kindOptions = KIND_OPTIONS.map((kind) => ({
    value: kind,
    label: t(KIND_LABEL_KEYS[kind]),
  }));
  const imageOptions: { value: ImageChoice; label: string }[] = [
    { value: "unknown", label: t("settings.gatewayPages.providers.imagesUnknown") },
    { value: "yes", label: t("settings.gatewayPages.providers.imagesYes") },
    { value: "no", label: t("settings.gatewayPages.providers.imagesNo") },
  ];
  const images = imageChoiceOf(model.images);

  return (
    <View style={styles.detailRow}>
      <View style={styles.detailHead}>
        <Text style={styles.detailName} numberOfLines={1}>
          {model.id}
        </Text>
        <Button
          variant="ghost"
          size="sm"
          leftIcon={X}
          onPress={handleRemove}
          accessibilityLabel={t("settings.gatewayPages.providers.removeModel", { model: model.id })}
        />
      </View>
      {pickedMode ? (
        <View style={styles.detailPickRow}>
          <Text style={styles.detailPickLabel}>
            {t("settings.gatewayPages.providers.modelPicked")}
          </Text>
          <Switch
            value={model.picked === true}
            onValueChange={handlePicked}
            accessibilityLabel={t("settings.gatewayPages.providers.modelPicked")}
          />
        </View>
      ) : null}
      <SegmentedControl
        options={kindOptions}
        value={model.kind ?? "chat"}
        onValueChange={handleKind}
        size="sm"
      />
      <View style={styles.detailNumbers}>
        <View style={styles.detailNumberCell}>
          <Field label={t("settings.gatewayPages.providers.contextWindow")}>
            <FormTextInput
              initialValue={model.contextWindow === undefined ? "" : String(model.contextWindow)}
              onChangeText={handleContext}
              keyboardType="numeric"
              accessibilityLabel={t("settings.gatewayPages.providers.contextWindow")}
            />
          </Field>
        </View>
        <View style={styles.detailNumberCell}>
          <Field label={t("settings.gatewayPages.providers.maxOutputTokens")}>
            <FormTextInput
              initialValue={
                model.maxOutputTokens === undefined ? "" : String(model.maxOutputTokens)
              }
              onChangeText={handleOutput}
              keyboardType="numeric"
              accessibilityLabel={t("settings.gatewayPages.providers.maxOutputTokens")}
            />
          </Field>
        </View>
      </View>
      <Field
        label={t("settings.gatewayPages.providers.sameAs")}
        hint={t("settings.gatewayPages.providers.sameAsHint")}
      >
        <FormTextInput
          initialValue={same}
          onChangeText={handleSameAs}
          placeholder={model.id}
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel={t("settings.gatewayPages.providers.sameAs")}
        />
      </Field>
      <Field label={t("settings.gatewayPages.providers.images")}>
        <SegmentedControl
          options={imageOptions}
          value={images}
          onValueChange={handleImages}
          size="sm"
        />
      </Field>
      {canPrice ? (
        <ModelPriceFields
          draft={price ?? EMPTY_PRICE}
          catalog={priceCatalog}
          onChange={handlePrice}
        />
      ) : null}
      {canProbe ? (
        <View style={styles.testRow}>
          <Button variant="outline" size="sm" onPress={handleTest} loading={testing}>
            {testing
              ? t("settings.gatewayPages.providers.testing")
              : t("settings.gatewayPages.providers.testModel")}
          </Button>
          {result === undefined ? null : (
            <Text style={result.ok ? styles.testOk : styles.testFailed} numberOfLines={2}>
              {result.message}
            </Text>
          )}
        </View>
      ) : null}
    </View>
  );
}

function imageChoiceOf(images: boolean | undefined): ImageChoice {
  if (images === undefined) {
    return "unknown";
  }
  return images ? "yes" : "no";
}

function positiveInteger(text: string): number | undefined {
  const parsed = Number.parseInt(text, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function ModelsEditor({
  models,
  mode,
  prices,
  onPriceChange,
  sameAs,
  onSameAsChange,
  catalog,
  canPrice,
  onChange,
  fetched,
  fetching,
  fetchError,
  canProbe,
  onFetch,
  onTest,
  testingModel,
  testResults,
}: ModelsEditorProps) {
  const { t } = useTranslation();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const handleToggleDetails = useCallback(() => setDetailsOpen((open) => !open), []);
  const accessibilityState = useMemo(() => ({ expanded: detailsOpen }), [detailsOpen]);

  const handleUpdate = useCallback(
    (index: number, mutate: (model: GatewayModelWire) => void) => {
      const next = models.map((model) => Object.assign({}, model));
      const target = next[index];
      if (target === undefined) {
        return;
      }
      mutate(target);
      onChange(next);
    },
    [models, onChange],
  );
  const handleRemove = useCallback(
    (modelId: string) => {
      onChange(models.filter((model) => model.id !== modelId));
    },
    [models, onChange],
  );
  const addModel = useCallback(
    (id: string) => {
      const trimmed = id.trim();
      if (trimmed.length === 0 || models.some((model) => model.id === trimmed)) {
        return null;
      }
      onChange([...models, { id: trimmed }]);
      return trimmed;
    },
    [models, onChange],
  );
  const handleTypedChange = useCallback((text: string) => setTyped(text), []);
  const handleAdd = useCallback(() => {
    if (addModel(typed) !== null) {
      setTyped("");
    }
  }, [addModel, typed]);
  const handleAddTyped = addModel;

  const unusedFetched = (fetched ?? []).filter((id) => !models.some((model) => model.id === id));

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <Text style={styles.sectionLabel}>{t("settings.gatewayPages.providers.models")}</Text>
        {canProbe ? (
          <Button variant="ghost" size="sm" onPress={onFetch} loading={fetching}>
            {fetching
              ? t("settings.gatewayPages.providers.fetchingModels")
              : t("settings.gatewayPages.providers.fetchModels")}
          </Button>
        ) : null}
      </View>

      {models.length === 0 ? (
        <Text style={styles.hint}>{t("settings.gatewayPages.providers.modelsEmpty")}</Text>
      ) : (
        <View style={styles.chips}>
          {models.map((model) => (
            <ModelChip key={model.id} model={model} onRemove={handleRemove} />
          ))}
        </View>
      )}

      {fetchError === null ? null : (
        <Text style={styles.error}>
          {t("settings.gatewayPages.providers.fetchFailed", { error: fetchError })}
        </Text>
      )}

      {unusedFetched.length > 0 ? (
        <View style={styles.chips}>
          {unusedFetched.map((id) => (
            <FetchedModelChip key={id} id={id} onAdd={handleAddTyped} />
          ))}
        </View>
      ) : null}

      <View style={styles.addRow}>
        <View style={styles.addField}>
          <FormTextInput
            initialValue=""
            onChangeText={handleTypedChange}
            placeholder={t("settings.gatewayPages.providers.modelPlaceholder")}
            autoCapitalize="none"
            autoCorrect={false}
            accessibilityLabel={t("settings.gatewayPages.providers.modelPlaceholder")}
            onSubmitEditing={handleAdd}
          />
        </View>
        <Button variant="secondary" size="sm" onPress={handleAdd}>
          {t("settings.gatewayPages.providers.addModel")}
        </Button>
      </View>

      {models.length === 0 ? null : (
        <PressHighlight
          style={styles.detailsToggle}
          onPress={handleToggleDetails}
          accessibilityRole="button"
          accessibilityState={accessibilityState}
        >
          <View style={detailsOpen ? styles.chevronOpen : undefined}>
            <ThemedChevron size={12} uniProps={mutedColorMapping} />
          </View>
          <Text style={styles.detailsLabel}>
            {t("settings.gatewayPages.providers.modelDetails")}
          </Text>
        </PressHighlight>
      )}

      {detailsOpen
        ? models.map((model, index) => (
            <ModelDetailsRow
              key={model.id}
              model={model}
              index={index}
              onUpdate={handleUpdate}
              onRemove={handleRemove}
              onTest={onTest}
              canProbe={canProbe}
              testing={testingModel === model.id}
              result={testResults[model.id]}
              pickedMode={mode === "picked"}
              price={prices[model.id]}
              priceCatalog={catalog[model.id] ?? null}
              canPrice={canPrice}
              onPriceChange={onPriceChange}
              same={sameAs[model.id] ?? ""}
              onSameAsChange={onSameAsChange}
            />
          ))
        : null}
    </View>
  );
}

interface ModelChipProps {
  model: GatewayModelWire;
  onRemove: (modelId: string) => void;
}

function ModelChip({ model, onRemove }: ModelChipProps) {
  const { t } = useTranslation();
  const handleRemove = useCallback(() => onRemove(model.id), [model.id, onRemove]);
  return (
    <View style={styles.chip}>
      <Text style={styles.chipText} numberOfLines={1}>
        {model.id}
      </Text>
      <PressHighlight
        style={styles.chipRemove}
        onPress={handleRemove}
        accessibilityRole="button"
        accessibilityLabel={t("settings.gatewayPages.providers.removeModel", { model: model.id })}
      >
        <ThemedX size={12} uniProps={mutedColorMapping} />
      </PressHighlight>
    </View>
  );
}

interface FetchedModelChipProps {
  id: string;
  onAdd: (id: string) => void;
}

function FetchedModelChip({ id, onAdd }: FetchedModelChipProps) {
  const handlePress = useCallback(() => onAdd(id), [id, onAdd]);
  return (
    <PressHighlight style={styles.fetchedChip} onPress={handlePress} accessibilityRole="button">
      <Text style={styles.fetchedChipText} numberOfLines={1}>
        {`+ ${id}`}
      </Text>
    </PressHighlight>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    gap: theme.spacing[3],
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  sectionLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  hint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  error: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.sm,
  },
  chips: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingLeft: theme.spacing[2],
    borderRadius: theme.borderRadius.base,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
    maxWidth: "100%",
  },
  chipText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    flexShrink: 1,
  },
  chipRemove: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
  },
  fetchedChip: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.base,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderStyle: "dashed",
  },
  fetchedChipText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  addRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  addField: {
    flex: 1,
    minWidth: 0,
  },
  detailsToggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    alignSelf: "flex-start",
  },
  detailsLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  chevronOpen: {
    transform: [{ rotate: "90deg" }],
  },
  detailRow: {
    gap: theme.spacing[2],
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface2,
  },
  detailHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  detailName: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    flexShrink: 1,
  },
  detailNumbers: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[3],
  },
  detailNumberCell: {
    flexGrow: 1,
    flexBasis: 140,
    minWidth: 0,
  },
  detailPickRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  detailPickLabel: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  testRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  testOk: {
    color: theme.colors.statusSuccess,
    fontSize: theme.fontSize.sm,
    flexShrink: 1,
  },
  testFailed: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.sm,
    flexShrink: 1,
  },
}));
