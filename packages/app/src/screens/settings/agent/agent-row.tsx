import { useCallback, useMemo, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Image, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { AgentConnectEntry, AgentConnectModel } from "@neolix/protocol/agent-connect";
import {
  ArrowDown,
  ArrowUp,
  ChevronRight,
  Eye,
  EyeOff,
  ExternalLink,
  MoreHorizontal,
  Terminal,
  Trash2,
} from "lucide-react-native";
import {
  useProviderIcon,
  type ProviderIconComponent,
  type ProviderIconProps,
} from "@/components/provider-icons";
import { SvgXml } from "react-native-svg";
import { EXTERNAL_AGENT_ICONS } from "./external-agent-icons";
import { EXTERNAL_AGENT_IMAGES } from "./external-agent-images";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DropdownTrigger } from "@/components/ui/dropdown-trigger";
import { PressHighlight } from "@/components/ui/press-highlight";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { useIsCompactFormFactor } from "@/constants/layout";
import { settingsStyles } from "@/styles/settings";
import type { Theme } from "@/styles/theme";

const ICON_SIZE = 20;
const ACTION_ICON_SIZE = 16;

const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const foregroundIconMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const dangerIconMapping = (theme: Theme) => ({ color: theme.colors.statusDanger });

const ThemedChevronRight = withUnistyles(ChevronRight);
const ThemedExternalLink = withUnistyles(ExternalLink);
const ThemedMoreHorizontal = withUnistyles(MoreHorizontal);
const ThemedTrash = withUnistyles(Trash2);
const ThemedArrowUp = withUnistyles(ArrowUp);
const ThemedArrowDown = withUnistyles(ArrowDown);
const ThemedEye = withUnistyles(Eye);
const ThemedEyeOff = withUnistyles(EyeOff);
const ThemedTerminal = withUnistyles(Terminal);

function noopSelect(): void {
  // The "no models" row is a statement, not an action.
}

interface ModelMenuItemProps {
  entry: AgentConnectModel;
  selected: boolean;
  onSelectModel: (provider: string, model: string) => void;
  provider: string;
}

function ModelMenuItem({ entry, selected, onSelectModel, provider }: ModelMenuItemProps) {
  const select = useCallback(() => {
    onSelectModel(provider, entry.id);
  }, [entry.id, onSelectModel, provider]);
  return (
    <DropdownMenuItem selected={selected} onSelect={select}>
      {entry.label ?? entry.id}
    </DropdownMenuItem>
  );
}

export interface AgentRowProps {
  serverId: string;
  provider: string;
  label: string;
  providerEnabled: boolean;
  /** The host cannot find this agent's CLI (myna's "CLI not found" row). */
  providerMissing?: boolean;
  /** An agent Neolix wires to the gateway but does not run as its own provider. */
  external?: boolean;
  /** myna's icon slug, for an external agent. */
  iconSlug?: string;
  connect: AgentConnectEntry | null;
  models: AgentConnectModel[];
  saving: boolean;
  canRemove: boolean;
  isFirst: boolean;
  manage: boolean;
  hiddenRow: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onOpenDetails: (provider: string) => void;
  onSetConnected: (provider: string, connected: boolean, model: string | null) => void;
  onSelectModel: (provider: string, model: string) => void;
  /** The gateway entries this agent's own list leaves out. */
  onSetModels: (provider: string, hidden: string[]) => void;
  /** One of the agent's own fields (myna's `<agent> <field>`); "" is its default. */
  onSetField: (provider: string, field: string, value: string) => void;
  /** Restarts a running copy still on the list it started with. */
  onRestartStale: (provider: string, kind: "app" | "ide" | "daemon" | "cli") => void;
  onToggleEnabled: (provider: string, enabled: boolean) => void;
  onRemove: (provider: string, label: string) => void;
  onReapply: (provider: string) => void;
  onMove: (provider: string, direction: -1 | 1) => void;
  onHideToggle: (provider: string, hide: boolean) => void;
  onCopyLaunch: (provider: string, command: string, label: string) => void;
  onToggleShellFunction: (provider: string, enabled: boolean) => void;
  onOpenImportLink: (provider: string, link: string, label: string) => void;
}

type StatusTone = "on" | "off" | "bad";

interface StatusView {
  text: string;
  tone: StatusTone;
}

/** The dot-and-words line under an agent's name, as the gateway wiring stands. */
export function agentStatus(
  entry: AgentConnectEntry | null,
  label: string,
  providerEnabled: boolean,
  t: TFunction,
  providerMissing = false,
): StatusView {
  if (!providerEnabled) {
    return { text: t("settings.usePages.agent.disabled"), tone: "off" };
  }
  if (providerMissing) {
    return { text: t("settings.usePages.agent.cliMissing"), tone: "off" };
  }
  if (entry === null) {
    return { text: t("settings.usePages.agent.reasonUnknown"), tone: "off" };
  }
  if (entry.drift === "unwired") {
    return { text: t("settings.usePages.agent.driftUnwired", { name: label }), tone: "bad" };
  }
  if (entry.drift === "stale") {
    return { text: t("settings.usePages.agent.driftStale", { name: label }), tone: "bad" };
  }
  if (entry.reason === "unsupported") {
    return { text: t("settings.usePages.agent.reasonUnsupported"), tone: "off" };
  }
  // A connected agent stays connected even while the gateway is down; the
  // switch must still be able to take it back out.
  if (entry.connected) {
    if (entry.provider === "claude") {
      return { text: t("settings.usePages.agent.connectedClaude"), tone: "on" };
    }
    return {
      text: t("settings.usePages.agent.connected", { count: entry.modelCount, name: label }),
      tone: "on",
    };
  }
  if (entry.reason === "gateway_unavailable") {
    return { text: t("settings.usePages.agent.reasonGatewayUnavailable"), tone: "bad" };
  }
  if (entry.reason === "no_gateway_models") {
    return { text: t("settings.usePages.agent.reasonNoModels"), tone: "bad" };
  }
  return {
    text: t("settings.usePages.agent.disconnected", { name: label }),
    tone: "off",
  };
}

export function AgentRow(props: AgentRowProps) {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const ProviderIcon = useProviderIcon(props.provider, props.serverId);
  const ThemedProviderIcon = useMemo(() => withUnistyles(ProviderIcon), [ProviderIcon]);
  const iconXml = props.iconSlug ? EXTERNAL_AGENT_ICONS[props.iconSlug] : undefined;
  const iconImage = props.iconSlug ? EXTERNAL_AGENT_IMAGES[props.iconSlug] : undefined;
  const status = agentStatus(
    props.connect,
    props.label,
    props.providerEnabled,
    t,
    props.providerMissing === true,
  );
  const rowStyle = useMemo(
    () => [settingsStyles.row, !props.isFirst && settingsStyles.rowBorder, styles.row],
    [props.isFirst],
  );

  return (
    <View style={rowStyle}>
      <View style={styles.identity}>
        <AgentIcon image={iconImage} xml={iconXml} ProviderIcon={ThemedProviderIcon} />
        <View style={styles.textColumn}>
          <View style={styles.nameRow}>
            <Text style={settingsStyles.rowTitle} numberOfLines={1}>
              {props.label}
            </Text>
            {props.connect?.cliVersion === undefined ? null : (
              <Text style={styles.cliVersion}>{props.connect.cliVersion}</Text>
            )}
          </View>
          <View style={styles.statusRow}>
            <StatusDot tone={status.tone} />
            <Text style={styles.statusText} numberOfLines={isCompact ? 1 : 2}>
              {status.text}
            </Text>
          </View>
          {props.connect?.models === undefined ? null : (
            <AgentModelsLine
              provider={props.provider}
              name={props.label}
              shown={props.connect.models.shown}
              listed={props.connect.models.listed}
              hidden={props.connect.models.hidden}
              models={props.models}
              onSetModels={props.onSetModels}
            />
          )}
          {props.connect?.settings === undefined || props.connect.settings.length === 0 ? null : (
            <AgentSettingsLine
              provider={props.provider}
              name={props.label}
              settings={props.connect.settings}
              models={props.models}
              onSetField={props.onSetField}
            />
          )}
          {(props.connect?.staleCopies ?? []).map((copy) => (
            <StaleCopyRow
              key={copy.kind}
              provider={props.provider}
              kind={copy.kind}
              onRestart={props.onRestartStale}
            />
          ))}
        </View>
      </View>
      {props.manage ? <ManageControls {...props} /> : <NormalControls {...props} />}
    </View>
  );
}

function ModelToggleRow({
  model,
  shown,
  onToggle,
}: {
  model: AgentConnectModel;
  shown: boolean;
  onToggle: (id: string, shown: boolean) => void;
}) {
  const change = useCallback(
    (on: boolean) => {
      onToggle(model.id, on);
    },
    [model.id, onToggle],
  );
  return (
    <View style={styles.modelsRow}>
      <Text style={styles.modelsLabel} numberOfLines={1}>
        {model.label ?? model.id}
      </Text>
      <Switch value={shown} onValueChange={change} accessibilityLabel={model.label ?? model.id} />
    </View>
  );
}

function StaleCopyRow({
  provider,
  kind,
  onRestart,
}: {
  provider: string;
  kind: "app" | "ide" | "daemon" | "cli";
  onRestart: (provider: string, kind: "app" | "ide" | "daemon" | "cli") => void;
}) {
  const { t } = useTranslation();
  const restart = useCallback(() => {
    onRestart(provider, kind);
  }, [kind, onRestart, provider]);
  return (
    <View style={styles.staleRow}>
      <Text style={styles.staleText} numberOfLines={2}>
        {t("settings.usePages.agent.staleCopy", { kind })}
      </Text>
      <PressHighlight
        onPress={restart}
        accessibilityRole="button"
        accessibilityLabel={t("settings.usePages.agent.staleRestartNamed", { kind })}
        style={styles.textButton}
      >
        <Text style={styles.reapplyText}>{t("settings.usePages.agent.staleRestart")}</Text>
      </PressHighlight>
    </View>
  );
}

interface AgentModelsLineProps {
  provider: string;
  name: string;
  shown: number;
  listed: number;
  hidden: string[];
  models: AgentConnectModel[];
  onSetModels: (provider: string, hidden: string[]) => void;
}

/** The line under an agent's name counting the models its own list shows. */
function AgentModelsLine({
  provider,
  name,
  shown,
  listed,
  hidden,
  models,
  onSetModels,
}: AgentModelsLineProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string[]>(hidden);
  const handleOpen = useCallback(() => {
    setDraft(hidden);
    setOpen(true);
  }, [hidden]);
  const handleClose = useCallback(() => setOpen(false), []);
  const header = useMemo<SheetHeader>(
    () => ({ title: t("settings.usePages.agent.modelsTitle", { name }) }),
    [name, t],
  );
  const toggle = useCallback((id: string, on: boolean) => {
    setDraft((previous) => {
      if (on) return previous.filter((entry) => entry !== id);
      return previous.includes(id) ? previous : [...previous, id];
    });
  }, []);
  const save = useCallback(() => {
    onSetModels(provider, draft);
    setOpen(false);
  }, [draft, onSetModels, provider]);
  return (
    <>
      <PressHighlight
        onPress={handleOpen}
        accessibilityRole="button"
        accessibilityLabel={t("settings.usePages.agent.modelsEdit", { name })}
        style={styles.modelsLine}
      >
        <Text style={styles.modelsText}>
          {shown >= listed
            ? t("settings.usePages.agent.modelsAll", { count: listed })
            : t("settings.usePages.agent.modelsShowing", { shown, listed })}
        </Text>
        <ThemedChevronRight size={12} uniProps={mutedIconMapping} />
      </PressHighlight>
      <AdaptiveModalSheet
        header={header}
        visible={open}
        onClose={handleClose}
        testID="agent-models-sheet"
      >
        <View style={styles.modelsSheet}>
          {models.map((model) => (
            <ModelToggleRow
              key={model.id}
              model={model}
              shown={!draft.includes(model.id)}
              onToggle={toggle}
            />
          ))}
          <View style={styles.modelsActions}>
            <Button size="sm" variant="ghost" onPress={handleClose}>
              {t("settings.usePages.agent.profileCancel")}
            </Button>
            <Button size="sm" onPress={save}>
              {t("settings.usePages.agent.profileSave")}
            </Button>
          </View>
        </View>
      </AdaptiveModalSheet>
    </>
  );
}

interface AgentIconProps {
  image: number | undefined;
  xml: string | undefined;
  ProviderIcon: ReturnType<typeof withUnistyles<ProviderIconComponent, ProviderIconProps>>;
}

/** Neolix's own icon, else myna's SVG, else myna's bitmap, as the agent has one. */
interface AgentSettingsLineProps {
  provider: string;
  name: string;
  settings: NonNullable<AgentConnectEntry["settings"]>;
  models: AgentConnectModel[];
  onSetField: (provider: string, field: string, value: string) => void;
}

/**
 * The agent's own fields, as myna's agent settings sheet: each reads as it
 * stands, the menu offers what it takes, and Default puts it back.
 */
function AgentSettingsLine({
  provider,
  name,
  settings,
  models,
  onSetField,
}: AgentSettingsLineProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const handleOpen = useCallback(() => setOpen(true), []);
  const handleClose = useCallback(() => setOpen(false), []);
  const title = t("settings.gatewayPages.providers.codexPrefs");
  const header = useMemo<SheetHeader>(() => ({ title }), [title]);
  return (
    <>
      <PressHighlight
        onPress={handleOpen}
        accessibilityRole="button"
        accessibilityLabel={title}
        style={styles.modelsLine}
      >
        <Text style={styles.modelsText}>{title}</Text>
        <ThemedChevronRight size={12} uniProps={mutedIconMapping} />
      </PressHighlight>
      <AdaptiveModalSheet
        header={header}
        visible={open}
        onClose={handleClose}
        testID="agent-settings-sheet"
      >
        <View style={styles.modelsSheet}>
          {settings.map((setting) => (
            <FieldSettingRow
              key={setting.key}
              provider={provider}
              name={name}
              setting={setting}
              models={models}
              onSetField={onSetField}
            />
          ))}
        </View>
      </AdaptiveModalSheet>
    </>
  );
}

interface FieldSettingRowProps {
  provider: string;
  name: string;
  setting: NonNullable<AgentConnectEntry["settings"]>[number];
  models: AgentConnectModel[];
  onSetField: (provider: string, field: string, value: string) => void;
}

/** One field's row: its name, the value it reads as, and its picker. */
function FieldSettingRow({ provider, name, setting, models, onSetField }: FieldSettingRowProps) {
  const { t } = useTranslation();
  const label = useCallback(
    (value: string) => models.find((entry) => entry.id === value)?.label ?? value,
    [models],
  );
  const chooseDefault = useCallback(
    () => onSetField(provider, setting.key, ""),
    [onSetField, provider, setting.key],
  );
  const chooseOption = useCallback(
    (value: string) => onSetField(provider, setting.key, value),
    [onSetField, provider, setting.key],
  );
  return (
    <View style={styles.modelsRow}>
      <Text style={styles.modelsLabel}>{setting.label}</Text>
      <DropdownMenu>
        <DropdownTrigger size="sm" accessibilityLabel={`${name} · ${setting.label}`}>
          {setting.value === "" ? t("settings.usePages.agent.agentDefault") : label(setting.value)}
        </DropdownTrigger>
        <DropdownMenuContent side="bottom" align="end" minWidth={240} maxWidth={360}>
          <DropdownMenuItem selected={setting.value === ""} onSelect={chooseDefault}>
            {t("settings.usePages.agent.agentDefault")}
          </DropdownMenuItem>
          {(setting.options ?? []).map((option) => (
            <FieldOption
              key={option}
              option={option}
              label={label(option)}
              selected={option === setting.value}
              onChoose={chooseOption}
            />
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </View>
  );
}

interface FieldOptionProps {
  option: string;
  label: string;
  selected: boolean;
  onChoose: (value: string) => void;
}

function FieldOption({ option, label, selected, onChoose }: FieldOptionProps) {
  const choose = useCallback(() => onChoose(option), [onChoose, option]);
  return (
    <DropdownMenuItem selected={selected} onSelect={choose}>
      {label}
    </DropdownMenuItem>
  );
}

function AgentIcon({ image, xml, ProviderIcon }: AgentIconProps) {
  if (image !== undefined) return <Image source={image} style={styles.iconImage} />;
  if (xml === undefined) {
    return <ProviderIcon size={ICON_SIZE} uniProps={foregroundIconMapping} />;
  }
  return <SvgXml xml={xml} width={ICON_SIZE} height={ICON_SIZE} />;
}

function ManageControls({
  provider,
  label,
  hiddenRow,
  canMoveUp,
  canMoveDown,
  onMove,
  onHideToggle,
}: AgentRowProps) {
  const { t } = useTranslation();
  const moveUp = useCallback(() => {
    onMove(provider, -1);
  }, [onMove, provider]);
  const moveDown = useCallback(() => {
    onMove(provider, 1);
  }, [onMove, provider]);
  const hide = useCallback(() => {
    onHideToggle(provider, !hiddenRow);
  }, [hiddenRow, onHideToggle, provider]);

  return (
    <View style={styles.controls}>
      <PressHighlight
        onPress={moveUp}
        disabled={!canMoveUp}
        accessibilityRole="button"
        accessibilityLabel={t("settings.usePages.agent.moveUp", { name: label })}
        style={styles.iconButton}
      >
        <ThemedArrowUp size={ACTION_ICON_SIZE} uniProps={mutedIconMapping} />
      </PressHighlight>
      <PressHighlight
        onPress={moveDown}
        disabled={!canMoveDown}
        accessibilityRole="button"
        accessibilityLabel={t("settings.usePages.agent.moveDown", { name: label })}
        style={styles.iconButton}
      >
        <ThemedArrowDown size={ACTION_ICON_SIZE} uniProps={mutedIconMapping} />
      </PressHighlight>
      <PressHighlight
        onPress={hide}
        accessibilityRole="button"
        accessibilityLabel={
          hiddenRow
            ? t("settings.usePages.agent.showAgent", { name: label })
            : t("settings.usePages.agent.hideAgent", { name: label })
        }
        style={styles.iconButton}
      >
        {hiddenRow ? (
          <ThemedEye size={ACTION_ICON_SIZE} uniProps={mutedIconMapping} />
        ) : (
          <ThemedEyeOff size={ACTION_ICON_SIZE} uniProps={mutedIconMapping} />
        )}
      </PressHighlight>
    </View>
  );
}

interface ModelPickerProps {
  provider: string;
  label: string;
  disabled: boolean;
  model: string | null;
  modelLabel: string;
  models: AgentConnectModel[];
  fields: NonNullable<AgentConnectEntry["fields"]>;
  fieldModelLabel: (value: string | null) => string;
  onSelectModel: (provider: string, model: string) => void;
}

/** The row's model menu, or one menu per field for an agent that sets them one by one. */
function ModelPicker({
  provider,
  label,
  disabled,
  model,
  modelLabel,
  models,
  fields,
  fieldModelLabel,
  onSelectModel,
}: ModelPickerProps) {
  const { t } = useTranslation();
  if (fields.length > 0) {
    return (
      <View style={styles.fields}>
        {fields.map((field) => (
          <DropdownMenu key={field.id}>
            <DropdownTrigger
              size="sm"
              disabled={disabled}
              accessibilityLabel={t("settings.usePages.agent.chooseModel", {
                name: `${label} · ${field.label}`,
              })}
            >
              {`${field.label}: ${fieldModelLabel(field.model)}`}
            </DropdownTrigger>
            <DropdownMenuContent side="bottom" align="end" minWidth={240} maxWidth={360}>
              {models.map((entry) => (
                <ModelMenuItem
                  key={entry.id}
                  entry={entry}
                  selected={entry.id === field.model}
                  provider={`${provider}#${field.id}`}
                  onSelectModel={onSelectModel}
                />
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ))}
      </View>
    );
  }
  return (
    <DropdownMenu>
      <DropdownTrigger
        size="sm"
        disabled={disabled}
        accessibilityLabel={t("settings.usePages.agent.chooseModel", { name: label })}
      >
        {modelLabel}
      </DropdownTrigger>
      <DropdownMenuContent side="bottom" align="end" minWidth={240} maxWidth={360}>
        {models.length === 0 ? (
          <DropdownMenuItem disabled onSelect={noopSelect}>
            {t("settings.usePages.agent.noModels")}
          </DropdownMenuItem>
        ) : (
          models.map((entry) => (
            <ModelMenuItem
              key={entry.id}
              entry={entry}
              selected={entry.id === model}
              provider={provider}
              onSelectModel={onSelectModel}
            />
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Whether the row's model menu and switch are out of reach. */
function connectBlocked(
  connect: AgentConnectEntry | null,
  providerEnabled: boolean,
  models: AgentConnectModel[],
  providerMissing: boolean,
  saving: boolean,
): boolean {
  if (!providerEnabled || connect === null || models.length === 0) return true;
  if (connect.reason !== null && !connect.connected) return true;
  if (providerMissing && !connect.connected) return true;
  return saving;
}

/** Whether the agent still points at the gateway through something out of date. */
function canReapplyEntry(connect: AgentConnectEntry | null): boolean {
  return connect?.drift === "unwired" || connect?.drift === "stale";
}

function NormalControls({
  provider,
  label,
  providerEnabled,
  providerMissing,
  external,
  connect,
  models,
  saving,
  canRemove,
  onOpenDetails,
  onSetConnected,
  onSelectModel,
  onToggleEnabled,
  onRemove,
  onReapply,
  onCopyLaunch,
  onToggleShellFunction,
  onOpenImportLink,
}: AgentRowProps) {
  const { t } = useTranslation();
  const model = connect?.model ?? null;
  const launchCommand = connect?.launchCommand ?? null;
  const modelLabel = useMemo(() => {
    if (model === null) return t("settings.usePages.agent.agentDefault");
    return models.find((entry) => entry.id === model)?.label ?? model;
  }, [model, models, t]);
  // An agent's own fields (Aside's four roles) are picked one by one, in
  // the agent's one row.
  const fields = connect?.fields ?? [];
  const fieldModelLabel = useCallback(
    (value: string | null) => {
      if (value === null) return t("settings.usePages.agent.agentDefault");
      return models.find((entry) => entry.id === value)?.label ?? value;
    },
    [models, t],
  );
  const connectDisabled = connectBlocked(
    connect,
    providerEnabled,
    models,
    providerMissing === true,
    saving,
  );
  const canReapply = canReapplyEntry(connect);

  const openDetails = useCallback(() => {
    onOpenDetails(provider);
  }, [onOpenDetails, provider]);
  const toggleConnected = useCallback(
    (next: boolean) => {
      // Off then on again starts on the gateway's first model rather than a
      // value left in the agent's own config, which the gateway may not serve.
      const keepModel = connect?.connected === true ? model : null;
      onSetConnected(provider, next, keepModel);
    },
    [connect, model, onSetConnected, provider],
  );
  const reapply = useCallback(() => {
    onReapply(provider);
  }, [onReapply, provider]);
  const copyLaunch = useCallback(() => {
    if (launchCommand !== null) onCopyLaunch(provider, launchCommand, label);
  }, [label, launchCommand, onCopyLaunch, provider]);
  const shellInstalled = connect?.shellInstalled;
  const importLink = connect?.importLink ?? null;
  const openImportLink = useCallback(() => {
    if (importLink !== null) onOpenImportLink(provider, importLink, label);
  }, [importLink, label, onOpenImportLink, provider]);

  return (
    <View style={styles.controls}>
      <RowQuickActions
        provider={provider}
        label={label}
        canReapply={canReapply}
        launchCommand={launchCommand}
        importLink={importLink}
        shellInstalled={shellInstalled}
        onReapply={reapply}
        onCopyLaunch={copyLaunch}
        onOpenImportLink={openImportLink}
        onToggleShellFunction={onToggleShellFunction}
      />
      <ProviderManagement
        external={external === true}
        provider={provider}
        label={label}
        providerEnabled={providerEnabled}
        canRemove={canRemove}
        saving={saving}
        onOpenDetails={openDetails}
        onToggleEnabled={onToggleEnabled}
        onRemove={onRemove}
      />
      <ModelPicker
        provider={provider}
        label={label}
        disabled={connectDisabled}
        model={model}
        modelLabel={modelLabel}
        models={models}
        fields={fields}
        fieldModelLabel={fieldModelLabel}
        onSelectModel={onSelectModel}
      />
      <ProviderActionsMenu
        provider={provider}
        label={label}
        enabled={providerEnabled}
        canRemove={canRemove}
        saving={saving}
        onToggleEnabled={onToggleEnabled}
        onRemove={onRemove}
      />
      <Switch
        value={connect?.connected === true}
        onValueChange={toggleConnected}
        disabled={connectDisabled}
        accessibilityLabel={t("settings.usePages.agent.connectSwitch", { name: label })}
      />
    </View>
  );
}

interface RowQuickActionsProps {
  provider: string;
  label: string;
  canReapply: boolean;
  launchCommand: string | null;
  importLink: string | null;
  shellInstalled: boolean | undefined;
  onReapply: () => void;
  onCopyLaunch: () => void;
  onOpenImportLink: () => void;
  onToggleShellFunction: (provider: string, enabled: boolean) => void;
}

/** The row's one-off actions: reapply, copy the launch line, the agent's own link. */
function RowQuickActions({
  provider,
  label,
  canReapply,
  launchCommand,
  importLink,
  shellInstalled,
  onReapply,
  onCopyLaunch,
  onOpenImportLink,
  onToggleShellFunction,
}: RowQuickActionsProps) {
  const { t } = useTranslation();
  return (
    <>
      {canReapply ? (
        <PressHighlight
          onPress={onReapply}
          accessibilityRole="button"
          accessibilityLabel={t("settings.usePages.agent.reapplyFor", { name: label })}
          style={styles.textButton}
        >
          <Text style={styles.reapplyText}>{t("settings.usePages.agent.reapply")}</Text>
        </PressHighlight>
      ) : null}
      {launchCommand === null ? null : (
        <PressHighlight
          onPress={onCopyLaunch}
          accessibilityRole="button"
          accessibilityLabel={t("settings.usePages.agent.copyLaunch", { name: label })}
          style={styles.textButton}
        >
          <ThemedTerminal size={14} uniProps={mutedIconMapping} />
          <Text style={styles.detailsText}>{t("settings.usePages.agent.copyLaunchShort")}</Text>
        </PressHighlight>
      )}
      {importLink === null ? null : (
        <PressHighlight
          onPress={onOpenImportLink}
          accessibilityRole="button"
          accessibilityLabel={t("settings.usePages.agent.addViaLink", { name: label })}
          style={styles.textButton}
        >
          <ThemedExternalLink size={14} uniProps={mutedIconMapping} />
          <Text style={styles.detailsText}>
            {t("settings.usePages.agent.addViaLink", { name: label })}
          </Text>
        </PressHighlight>
      )}
      {shellInstalled === undefined ? null : (
        <ShellFunctionButton
          provider={provider}
          label={label}
          installed={shellInstalled}
          onToggle={onToggleShellFunction}
        />
      )}
    </>
  );
}

interface ShellFunctionButtonProps {
  provider: string;
  label: string;
  installed: boolean;
  onToggle: (provider: string, enabled: boolean) => void;
}

/** The separate, confirmed action that adds or takes out Neolix's shell function. */
function ShellFunctionButton({ provider, label, installed, onToggle }: ShellFunctionButtonProps) {
  const { t } = useTranslation();
  const toggle = useCallback(() => {
    onToggle(provider, !installed);
  }, [installed, onToggle, provider]);
  return (
    <PressHighlight
      onPress={toggle}
      accessibilityRole="button"
      accessibilityLabel={
        installed
          ? t("settings.usePages.agent.removeShellFunctionFor", { name: label })
          : t("settings.usePages.agent.addShellFunctionFor", { name: label })
      }
      style={styles.textButton}
    >
      <ThemedTerminal size={14} uniProps={mutedIconMapping} />
      <Text style={styles.detailsText}>
        {installed
          ? t("settings.usePages.agent.removeShellFunction")
          : t("settings.usePages.agent.addShellFunction")}
      </Text>
    </PressHighlight>
  );
}

interface ProviderManagementProps {
  external: boolean;
  provider: string;
  label: string;
  providerEnabled: boolean;
  canRemove: boolean;
  saving: boolean;
  onOpenDetails: () => void;
  onToggleEnabled: (provider: string, enabled: boolean) => void;
  onRemove: (provider: string, label: string) => void;
}

/** Details and the enable/remove menu, which only a Neolix provider has. */
function ProviderManagement({
  external,
  provider,
  label,
  providerEnabled,
  canRemove,
  saving,
  onOpenDetails,
  onToggleEnabled,
  onRemove,
}: ProviderManagementProps) {
  const { t } = useTranslation();
  if (external) return null;
  return (
    <>
      <PressHighlight
        onPress={onOpenDetails}
        accessibilityRole="button"
        accessibilityLabel={t("settings.usePages.agent.detailsFor", { name: label })}
        style={styles.detailsButton}
      >
        <Text style={styles.detailsText}>{t("settings.usePages.agent.details")}</Text>
        <ThemedChevronRight size={14} uniProps={mutedIconMapping} />
      </PressHighlight>
      <ProviderActionsMenu
        provider={provider}
        label={label}
        enabled={providerEnabled}
        canRemove={canRemove}
        saving={saving}
        onToggleEnabled={onToggleEnabled}
        onRemove={onRemove}
      />
    </>
  );
}

function StatusDot({ tone }: { tone: StatusTone }) {
  if (tone === "on") return <View style={styles.dotOn} />;
  if (tone === "bad") return <View style={styles.dotBad} />;
  return <View style={styles.dotOff} />;
}

interface ProviderActionsMenuProps {
  provider: string;
  label: string;
  enabled: boolean;
  canRemove: boolean;
  saving: boolean;
  onToggleEnabled: (provider: string, enabled: boolean) => void;
  onRemove: (provider: string, label: string) => void;
}

function ProviderActionsMenu({
  provider,
  label,
  enabled,
  canRemove,
  saving,
  onToggleEnabled,
  onRemove,
}: ProviderActionsMenuProps) {
  const { t } = useTranslation();
  const toggle = useCallback(() => {
    onToggleEnabled(provider, !enabled);
  }, [enabled, onToggleEnabled, provider]);
  const remove = useCallback(() => {
    onRemove(provider, label);
  }, [label, onRemove, provider]);
  const triggerStyle = useCallback(
    ({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [
      styles.menuButton,
      (hovered || pressed) && styles.menuButtonHovered,
    ],
    [],
  );
  const trashLeading = useMemo(() => <ThemedTrash size={16} uniProps={dangerIconMapping} />, []);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={saving}
        hitSlop={8}
        style={triggerStyle}
        accessibilityRole="button"
        accessibilityLabel={t("settings.usePages.agent.actionsFor", { name: label })}
      >
        <ThemedMoreHorizontal size={16} uniProps={mutedIconMapping} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" width={220}>
        <DropdownMenuItem onSelect={toggle} status={saving ? "pending" : "idle"}>
          {enabled
            ? t("settings.usePages.agent.disableProvider")
            : t("settings.usePages.agent.enableProvider")}
        </DropdownMenuItem>
        {canRemove ? (
          <DropdownMenuItem
            destructive
            leading={trashLeading}
            onSelect={remove}
            status={saving ? "pending" : "idle"}
          >
            {t("settings.usePages.agent.removeProvider")}
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const styles = StyleSheet.create((theme) => ({
  iconImage: {
    width: ICON_SIZE,
    height: ICON_SIZE,
    borderRadius: 4,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: theme.spacing[3],
  },
  identity: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    flex: 1,
    minWidth: 200,
  },
  textColumn: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[1],
  },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
  },
  nameRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
  },
  cliVersion: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  staleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
  },
  staleText: {
    color: theme.colors.statusWarning,
    fontSize: theme.fontSize.sm,
    flexShrink: 1,
  },
  modelsLine: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[0.5],
  },
  modelsText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  modelsSheet: {
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[4],
  },
  modelsRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  modelsLabel: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    flex: 1,
    minWidth: 0,
  },
  modelsActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
    paddingTop: theme.spacing[3],
  },
  dotOn: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: theme.colors.statusSuccess,
  },
  dotOff: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: theme.colors.foregroundMuted,
  },
  dotBad: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: theme.colors.statusDanger,
  },
  statusText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    flexShrink: 1,
  },
  controls: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  fields: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[1],
  },
  detailsButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[0.5],
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
  },
  detailsText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  textButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
  },
  reapplyText: {
    color: theme.colors.primary,
    fontSize: theme.fontSize.sm,
  },
  iconButton: {
    width: 28,
    height: 28,
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
    justifyContent: "center",
  },
  menuButton: {
    width: 28,
    height: 28,
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
    justifyContent: "center",
  },
  menuButtonHovered: {
    backgroundColor: theme.colors.surface2,
  },
}));
