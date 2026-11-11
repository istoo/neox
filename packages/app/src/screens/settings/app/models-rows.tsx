/* eslint-disable react-perf/jsx-no-new-function-as-prop -- settings form rows: a handful of closures, none of them in a hot list. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { SettingsRow } from "@/components/settings";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { DropdownTrigger } from "@/components/ui/dropdown-trigger";
import {
  EditingTextInput as TextInput,
  type EditingTextInputHandle,
} from "@/components/ui/text-input";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { useToast } from "@/contexts/toast-context";
import { useGatewayConfig } from "@/hooks/use-gateway-config";
import { toErrorMessage } from "@/utils/error-messages";
import type { GatewayConfigWire } from "@neolix/protocol/gateway";
import {
  disabledHits,
  disabledModelChoices,
  modelDisabled,
  type DisabledModelChoice,
} from "./disabled-models";
import { McpAddressRow } from "./mcp-address-row";
import { LibraryWayLink } from "./library-way-link";
import { useSettingsHostServerId } from "./shared";

type ReplyModel = NonNullable<GatewayConfigWire["replyModel"]>;
type LoopGuard = "on" | "off";
type RefusalChoice = "never" | "1" | "2" | "3" | "all";
type VisionEffort = NonNullable<NonNullable<GatewayConfigWire["vision"]>["effort"]>;
type VisionChoice = "auto" | "off" | "custom";

const REFUSAL_CHOICES: readonly RefusalChoice[] = ["never", "1", "2", "3", "all"];
const CLASSIFY_TIMEOUTS = [8, 15, 30, 60] as const;
const VISION_EFFORTS: readonly VisionEffort[] = ["low", "medium", "high", "xhigh", "max"];

function withoutKey<K extends keyof GatewayConfigWire>(
  config: GatewayConfigWire,
  key: K,
): GatewayConfigWire {
  const { [key]: _removed, ...rest } = config;
  return rest as GatewayConfigWire;
}

/**
 * myna's Models › Replies: a reply's model name, the loop guard, refusal
 * retries, the classifier's timeout, and the two Claude-only behaviours.
 */
export function ReplyRows() {
  const { t } = useTranslation();
  const toast = useToast();
  const serverId = useSettingsHostServerId();
  const { config, save } = useGatewayConfig(serverId);
  const saveWithToast = useCallback(
    (next: GatewayConfigWire) => {
      void save(next).catch((cause: unknown) => {
        toast.error(toErrorMessage(cause));
      });
    },
    [save, toast],
  );
  const replyModel = config?.replyModel ?? "asked";
  const loopGuard: LoopGuard = config?.noLoopGuard === true ? "off" : "on";
  const refusal: RefusalChoice = refusalChoiceOf(config?.refusalRetries);

  const replyModelOptions = useMemo<SegmentedControlOption<ReplyModel>[]>(
    () => [
      { value: "asked", label: t("settings.pages.models.replyModel.asked") },
      { value: "member", label: t("settings.pages.models.replyModel.member") },
      { value: "vendor", label: t("settings.pages.models.replyModel.vendor") },
    ],
    [t],
  );
  const classify = config?.classifyTimeout ?? 8;
  const classifyOptions = useMemo<SegmentedControlOption<string>[]>(() => {
    const values = CLASSIFY_TIMEOUTS.map(String);
    const extra = values.includes(String(classify)) ? values : [...values, String(classify)];
    return extra.map((value) => ({
      value,
      label: t("settings.pages.models.seconds", { n: Number(value) }),
    }));
  }, [classify, t]);
  const loop = useMemo<SegmentedControlOption<LoopGuard>[]>(
    () => [
      { value: "on", label: t("settings.pages.models.on") },
      { value: "off", label: t("settings.pages.models.off") },
    ],
    [t],
  );
  const changeClassify = useCallback(
    (value: string) => {
      if (config !== null) {
        saveWithToast({ ...config, classifyTimeout: Number(value) });
      }
    },
    [config, saveWithToast],
  );
  const lean = config?.claudeLeanPrompt === true ? "on" : "off";
  const changeLean = useCallback(
    (value: LoopGuard) => {
      if (config !== null) {
        saveWithToast({ ...config, claudeLeanPrompt: value === "on" });
      }
    },
    [config, saveWithToast],
  );
  const interactive = config?.claudePrintMode === true ? "off" : "on";
  const changeInteractive = useCallback(
    (value: LoopGuard) => {
      if (config !== null) {
        saveWithToast({ ...config, claudePrintMode: value === "off" });
      }
    },
    [config, saveWithToast],
  );
  const refusalOptions = useMemo<SegmentedControlOption<RefusalChoice>[]>(() => {
    const choices = REFUSAL_CHOICES.includes(refusal)
      ? [...REFUSAL_CHOICES]
      : [...REFUSAL_CHOICES, refusal];
    return choices.map((value) => ({
      value,
      label: refusalLabel(value, t),
    }));
  }, [refusal, t]);

  const changeReplyModel = useCallback(
    (mode: ReplyModel) => {
      if (config !== null) {
        saveWithToast({ ...config, replyModel: mode });
      }
    },
    [config, saveWithToast],
  );
  const changeLoopGuard = useCallback(
    (value: LoopGuard) => {
      if (config !== null) {
        saveWithToast(
          value === "on" ? withoutKey(config, "noLoopGuard") : { ...config, noLoopGuard: true },
        );
      }
    },
    [config, saveWithToast],
  );
  const changeRefusal = useCallback(
    (value: RefusalChoice) => {
      if (config === null) {
        return;
      }
      saveWithToast(
        value === "all"
          ? withoutKey(config, "refusalRetries")
          : { ...config, refusalRetries: value === "never" ? 0 : Number(value) },
      );
    },
    [config, saveWithToast],
  );

  return (
    <>
      <SettingsRow
        label={t("settings.pages.models.replyModel.label")}
        hint={
          config === null
            ? t("settings.pages.actions.noHost")
            : t("settings.pages.models.replyModel.hint")
        }
      >
        <SegmentedControl
          options={replyModelOptions}
          value={replyModel}
          onValueChange={changeReplyModel}
        />
      </SettingsRow>
      <SettingsRow
        label={t("settings.pages.models.loopGuard")}
        hint={t("settings.pages.models.loopGuardHint")}
      >
        <SegmentedControl options={loop} value={loopGuard} onValueChange={changeLoopGuard} />
      </SettingsRow>
      <SettingsRow
        label={t("settings.pages.models.refusalRetries")}
        hint={t("settings.pages.models.refusalRetriesHint")}
      >
        <SegmentedControl options={refusalOptions} value={refusal} onValueChange={changeRefusal} />
      </SettingsRow>
      <SettingsRow
        label={t("settings.pages.models.classifyTimeout")}
        hint={t("settings.pages.models.classifyTimeoutHint")}
      >
        <SegmentedControl
          options={classifyOptions}
          value={String(classify)}
          onValueChange={changeClassify}
        />
      </SettingsRow>
      <SettingsRow
        label={t("settings.pages.models.claudeLean")}
        hint={t("settings.pages.models.claudeLeanHint")}
      >
        <SegmentedControl options={loop} value={lean} onValueChange={changeLean} />
      </SettingsRow>
      <SettingsRow
        label={t("settings.pages.models.claudeMode")}
        hint={t("settings.pages.models.claudeModeHint")}
      >
        <SegmentedControl options={loop} value={interactive} onValueChange={changeInteractive} />
      </SettingsRow>
    </>
  );
}

/** myna's Models › Images: the model that describes images, and how hard it thinks. */
export function VisionRows() {
  const { t } = useTranslation();
  const toast = useToast();
  const serverId = useSettingsHostServerId();
  const { config, save } = useGatewayConfig(serverId);
  const saveWithToast = useCallback(
    (next: GatewayConfigWire) => {
      void save(next).catch((cause: unknown) => {
        toast.error(toErrorMessage(cause));
      });
    },
    [save, toast],
  );
  const savedModel = config?.vision?.model ?? "";
  const [draft, setDraft] = useState(savedModel);
  const input = useRef<EditingTextInputHandle>(null);

  useEffect(() => {
    setDraft(savedModel);
  }, [savedModel]);

  const commit = useCallback(() => {
    if (config === null) {
      return;
    }
    const value = (input.current?.getText() ?? draft).trim();
    if (value === savedModel) {
      return;
    }
    const vision = config.vision ?? {};
    saveWithToast(
      value === ""
        ? { ...config, vision: withoutVisionModel(vision) }
        : { ...config, vision: { ...vision, model: value } },
    );
  }, [config, draft, saveWithToast, savedModel]);

  const choose = useCallback(
    (choice: VisionChoice) => {
      if (config === null || choice === "custom") {
        return;
      }
      const vision = config.vision ?? {};
      saveWithToast({
        ...config,
        vision: choice === "auto" ? withoutVisionModel(vision) : { ...vision, model: "off" },
      });
    },
    [config, saveWithToast],
  );

  const selected: VisionChoice = visionChoiceOf(savedModel);
  const choiceOptions = useMemo<SegmentedControlOption<VisionChoice>[]>(() => {
    const options: SegmentedControlOption<VisionChoice>[] = [
      { value: "auto", label: t("settings.pages.models.visionAuto") },
      { value: "off", label: t("settings.pages.models.visionOff") },
    ];
    if (selected === "custom") {
      options.push({ value: "custom", label: savedModel });
    }
    return options;
  }, [savedModel, selected, t]);
  const effortOptions = useMemo<SegmentedControlOption<VisionEffort>[]>(
    () => VISION_EFFORTS.map((value) => ({ value, label: value })),
    [],
  );
  const changeEffort = useCallback(
    (effort: VisionEffort) => {
      if (config !== null) {
        saveWithToast({ ...config, vision: { ...config.vision, effort } });
      }
    },
    [config, saveWithToast],
  );

  return (
    <>
      <SettingsRow
        label={t("settings.pages.models.vision")}
        hint={
          config === null
            ? t("settings.pages.actions.noHost")
            : t("settings.pages.models.visionHint")
        }
      >
        <SegmentedControl options={choiceOptions} value={selected} onValueChange={choose} />
      </SettingsRow>
      <SettingsRow
        label={t("settings.pages.models.visionModel")}
        hint={t("settings.pages.models.visionModelHint")}
      >
        <TextInput
          ref={input}
          initialValue={draft}
          onChangeText={setDraft}
          onBlur={commit}
          onSubmitEditing={commit}
          placeholder={t("settings.pages.models.visionModelPlaceholder")}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          style={styles.input}
          accessibilityLabel={t("settings.pages.models.visionModel")}
        />
      </SettingsRow>
      <SettingsRow label={t("settings.pages.models.visionEffort")}>
        <SegmentedControl
          options={effortOptions}
          value={config?.vision?.effort ?? "low"}
          onValueChange={changeEffort}
        />
      </SettingsRow>
      <McpAddressRow
        path="/mcp/myna/vision"
        label={t("settings.pages.models.visionMcpServer")}
        hint={t("settings.pages.models.visionMcpHint")}
      />
      <LibraryWayLink server="vision" hidden={selected === "off"} />
    </>
  );
}

interface ImageChoice {
  id: string;
  label: string;
}

function imageChoicesOf(config: GatewayConfigWire | null): ImageChoice[] {
  const out: ImageChoice[] = [];
  for (const provider of config?.providers ?? []) {
    if (provider.enabled === false) {
      continue;
    }
    for (const model of provider.models) {
      if (model.kind === "image" && !modelDisabled(config, provider.id, model.id)) {
        out.push({
          id: `${provider.id}/${model.id}`,
          label: `${model.label ?? model.id} · ${provider.label ?? provider.id}`,
        });
      }
    }
  }
  return out;
}

function imageGenLabel(t: TFunction, saved: string, choices: readonly ImageChoice[]): string {
  if (saved === "off") {
    return t("settings.pages.models.imageGenOff");
  }
  if (saved === "") {
    return t("settings.pages.models.imageGenAuto");
  }
  return (
    choices.find((entry) => entry.id === saved)?.label ??
    `${saved} · ${t("settings.pages.models.imageGenMissing")}`
  );
}

function imageGenHint(t: TFunction, noHost: boolean, saved: string): string {
  if (noHost) {
    return t("settings.pages.actions.noHost");
  }
  return saved === "off"
    ? t("settings.pages.models.imageGenOffHint")
    : t("settings.pages.models.imageGenHint");
}

const IMAGE_TIMEOUTS = [5, 10, 15, 30, 60] as const;

/**
 * myna's Models › Images, the drawing half: the model the Image generation
 * tool draws with (Automatic, one model, or Off) and how long a provider is
 * given before the request is given up.
 */
export function ImageGenerationRows() {
  const { t } = useTranslation();
  const toast = useToast();
  const serverId = useSettingsHostServerId();
  const { config, save } = useGatewayConfig(serverId);
  const saveWithToast = useCallback(
    (next: GatewayConfigWire) => {
      void save(next).catch((cause: unknown) => {
        toast.error(toErrorMessage(cause));
      });
    },
    [save, toast],
  );
  const choices = useMemo(() => imageChoicesOf(config), [config]);
  const saved = config?.imageGen ?? "";
  const missing = saved !== "" && saved !== "off" && !choices.some((entry) => entry.id === saved);
  const label = imageGenLabel(t, saved, choices);

  const choose = useCallback(
    (value: string) => {
      if (config === null) {
        return;
      }
      const { imageGen: _old, ...rest } = config;
      saveWithToast(value === "" ? rest : { ...rest, imageGen: value });
    },
    [config, saveWithToast],
  );

  const timeout = config?.imageTimeout ?? 5;
  const timeoutOptions = useMemo<SegmentedControlOption<string>[]>(() => {
    const values = IMAGE_TIMEOUTS.map(String);
    const all = values.includes(String(timeout)) ? values : [...values, String(timeout)];
    return all.map((value) => ({
      value,
      label: t("settings.pages.models.imageTimeoutMinutes", { n: Number(value) }),
    }));
  }, [timeout, t]);
  const changeTimeout = useCallback(
    (value: string) => {
      if (config !== null) {
        saveWithToast({ ...config, imageTimeout: Number(value) });
      }
    },
    [config, saveWithToast],
  );

  return (
    <>
      <SettingsRow
        label={t("settings.pages.models.imageGen")}
        hint={imageGenHint(t, config === null, saved)}
      >
        <DropdownMenu>
          <DropdownTrigger disabled={config === null} accessibilityRole="button">
            {label}
          </DropdownTrigger>
          <DropdownMenuContent side="bottom" align="end" minWidth={240} maxWidth={360}>
            <DropdownMenuItem selected={saved === ""} onSelect={() => choose("")}>
              {t("settings.pages.models.imageGenAuto")}
            </DropdownMenuItem>
            <DropdownMenuItem selected={saved === "off"} onSelect={() => choose("off")}>
              {t("settings.pages.models.imageGenOff")}
            </DropdownMenuItem>
            {choices.map((choice) => (
              <DropdownMenuItem
                key={choice.id}
                selected={saved === choice.id}
                onSelect={() => choose(choice.id)}
              >
                {choice.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </SettingsRow>
      {missing ? (
        <View style={styles.missingRow}>
          <Text style={styles.missingText}>
            {t("settings.pages.models.imageGenGone", { model: saved })}
          </Text>
        </View>
      ) : null}
      <SettingsRow
        label={t("settings.pages.models.imageTimeout")}
        hint={t("settings.pages.models.imageTimeoutHint")}
      >
        <SegmentedControl
          options={timeoutOptions}
          value={String(timeout)}
          onValueChange={changeTimeout}
        />
      </SettingsRow>
      <McpAddressRow
        path="/mcp/myna/image"
        label={t("settings.pages.models.imageMcpServer")}
        hint={t("settings.pages.models.imageMcpHint")}
      />
      <LibraryWayLink server="image" hidden={saved === "off"} />
    </>
  );
}

/**
 * myna's Models › Disabled models: a model, or a pattern of one, is refused
 * on every route through the gateway and left out of its lists; each row
 * says what it matches now, or that nothing does yet.
 */
export function DisabledModelsRows() {
  const { t } = useTranslation();
  const toast = useToast();
  const serverId = useSettingsHostServerId();
  const { config, save } = useGatewayConfig(serverId);
  const saveWithToast = useCallback(
    (next: GatewayConfigWire) => {
      void save(next).catch((cause: unknown) => {
        toast.error(toErrorMessage(cause));
      });
    },
    [save, toast],
  );
  const patterns = useMemo(() => config?.disabledModels ?? [], [config]);
  const choices = useMemo(() => disabledModelChoices(config), [config]);
  const addable = useMemo(() => {
    const taken = new Set(patterns.map((pattern) => pattern.toLowerCase()));
    return choices.filter((choice) => !taken.has(choice.id.toLowerCase()));
  }, [choices, patterns]);

  const add = useCallback(
    (choice: DisabledModelChoice) => {
      if (
        config === null ||
        patterns.some((pattern) => pattern.toLowerCase() === choice.id.toLowerCase())
      ) {
        return;
      }
      saveWithToast({ ...config, disabledModels: [...patterns, choice.id] });
    },
    [config, patterns, saveWithToast],
  );
  const enable = useCallback(
    (pattern: string) => {
      if (config === null) {
        return;
      }
      const next = patterns.filter((entry) => entry !== pattern);
      const { disabledModels: _old, ...rest } = config;
      saveWithToast(next.length === 0 ? rest : { ...rest, disabledModels: next });
    },
    [config, patterns, saveWithToast],
  );

  return (
    <>
      <SettingsRow
        label={t("settings.pages.models.disabledAdd")}
        hint={t("settings.pages.models.disabledHint")}
      >
        <DropdownMenu>
          <DropdownTrigger
            disabled={config === null || addable.length === 0}
            accessibilityRole="button"
          >
            {t("settings.pages.models.disabledPick")}
          </DropdownTrigger>
          <DropdownMenuContent side="bottom" align="end" minWidth={240} maxWidth={360}>
            {addable.map((choice) => (
              <DropdownMenuItem key={choice.id} onSelect={() => add(choice)}>
                {`${choice.label} · ${choice.id}`}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </SettingsRow>
      {patterns.map((pattern) => {
        const hits = disabledHits(pattern, choices);
        return (
          <SettingsRow
            key={pattern}
            label={pattern}
            hint={
              hits.length === 0
                ? t("settings.pages.models.disabledMatchesNone")
                : t("settings.pages.models.disabledMatches", {
                    n: hits.length,
                    list: hits
                      .slice(0, 4)
                      .map((hit) => hit.id)
                      .join(", "),
                    more: hits.length > 4 ? "…" : "",
                  })
            }
          >
            <Button variant="ghost" size="sm" onPress={() => enable(pattern)}>
              {t("settings.pages.models.disabledEnable")}
            </Button>
          </SettingsRow>
        );
      })}
    </>
  );
}

function refusalLabel(value: RefusalChoice, t: TFunction): string {
  if (value === "never") {
    return t("settings.pages.models.refusalNever");
  }
  if (value === "all") {
    return t("settings.pages.models.refusalAll");
  }
  return value;
}

function visionChoiceOf(model: string): VisionChoice {
  if (model === "") {
    return "auto";
  }
  return model === "off" ? "off" : "custom";
}

function refusalChoiceOf(retries: number | undefined): RefusalChoice {
  if (retries === undefined) {
    return "all";
  }
  if (retries <= 0) {
    return "never";
  }
  return String(retries) as RefusalChoice;
}

function withoutVisionModel(
  vision: NonNullable<GatewayConfigWire["vision"]>,
): NonNullable<GatewayConfigWire["vision"]> {
  const { model: _model, ...rest } = vision;
  return rest;
}

const styles = StyleSheet.create((theme) => ({
  input: { minWidth: 220 },
  missingRow: { paddingHorizontal: 16, paddingBottom: 10 },
  missingText: { color: theme.colors.destructive, fontSize: theme.fontSize.sm },
}));
