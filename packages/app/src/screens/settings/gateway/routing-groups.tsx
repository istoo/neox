/* eslint-disable react-perf/jsx-no-new-function-as-prop, react-perf/jsx-no-new-object-as-prop, react-perf/jsx-no-new-array-as-prop, react/no-array-index-key -- routing group rows: a handful of closures in a settings form, none in a hot list; an editable rule has no id but its index. */
import { useCallback, useMemo, useRef, useState, type Ref } from "react";
import { Text, View, type PressableProps } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { ArrowDown, ArrowUp, Copy, GripVertical, Share2 } from "lucide-react-native";
import type { GatewayConfigWire, GatewayGroupWire } from "@neolix/protocol/gateway";
import { DraggableList } from "@/components/draggable-list";
import type { DraggableListDragHandleProps } from "@/components/draggable-list.types";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/contexts/toast-context";
import { copyToClipboard } from "@/utils/copy-to-clipboard";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Switch } from "@/components/ui/switch";
import { settingsStyles } from "@/styles/settings";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { useActiveHostBuiltinFeatures } from "@/plugins/builtin-features";
import { pluginDisplayName, usePluginList } from "@/plugins/plugin-list";
import { useSettingsHostServerId } from "@/screens/settings/app/shared";
import { syncGroupOrder } from "./routing-group-identity";
import { reconcileRowKeys, type RowKeySlot } from "./row-identity";
import { sharedGroupText } from "./routing-group-share";
import {
  buildRoutingTemplates,
  groupFromTemplate,
  uniqueGroupId,
  type RoutingTemplate,
  type RoutingTemplateKind,
} from "./routing-templates";

const STRATEGIES = [
  "order",
  "rotate",
  "least-used",
  "smart",
  "pace",
  "free",
  "fast",
  "cheap",
  "drain",
] as const;
const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const ThemedGripVertical = withUnistyles(GripVertical);
const ThemedArrowUp = withUnistyles(ArrowUp);
const ThemedArrowDown = withUnistyles(ArrowDown);
const ThemedCopy = withUnistyles(Copy);
const ThemedShare = withUnistyles(Share2);

const moveUpIcon = <ThemedArrowUp size={ICON_SIZE.sm} uniProps={mutedColorMapping} />;
const moveDownIcon = <ThemedArrowDown size={ICON_SIZE.sm} uniProps={mutedColorMapping} />;
const duplicateIcon = <ThemedCopy size={ICON_SIZE.sm} uniProps={mutedColorMapping} />;
const shareIcon = <ThemedShare size={ICON_SIZE.sm} uniProps={mutedColorMapping} />;

function useGroupRowKeys(groups: readonly GatewayGroupWire[]): string[] {
  const previous = useRef<RowKeySlot[]>([]);
  const seed = useRef(0);
  return useMemo(() => {
    const keys = reconcileRowKeys(
      previous.current,
      groups,
      () => `routing-group-${seed.current++}`,
    );
    previous.current = groups.map((group, index) => ({
      id: group.id,
      key: keys[index] ?? group.id,
    }));
    return keys;
  }, [groups]);
}

/** myna's Slug, and the id rule the config keeps: lowercase, anything else one "-". */
function groupIdFrom(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug === "") {
    return "group";
  }
  return /^[a-z]/.test(slug) ? slug : `g-${slug}`;
}

export function newRoutingGroup(config: GatewayConfigWire): GatewayGroupWire {
  const first = firstChatMember(config);
  return {
    id: uniqueGroupId(config, `g${(config.groups?.length ?? 0) + 1}`),
    members: first === null ? [] : [first],
    strategy: "order",
  };
}

/** The config's first chat model, so a new group is valid as soon as it is added. */
function firstChatMember(config: GatewayConfigWire): string | null {
  for (const provider of config.providers ?? []) {
    if (provider.enabled === false) {
      continue;
    }
    for (const model of provider.models) {
      if (model.kind === undefined || model.kind === "chat") {
        return `${provider.id}/${model.id}`;
      }
    }
  }
  return null;
}

interface GatewayRoutingGroupsProps {
  config: GatewayConfigWire;
  edit: (mutate: (next: GatewayConfigWire) => void) => void;
}

export function GatewayRoutingGroups({ config, edit }: GatewayRoutingGroupsProps) {
  const { t } = useTranslation();
  const toast = useToast();
  const groups = useMemo(() => config.groups ?? [], [config.groups]);
  const strategies = useMemo(
    () =>
      STRATEGIES.map((strategy) => ({
        value: strategy as string,
        label: t(`settings.gatewayPages.routing.strategy.${strategy}`),
      })),
    [t],
  );
  const serverId = useSettingsHostServerId();
  const plugins = usePluginList(serverId ?? "");
  const strategyOptions = useMemo(() => {
    const contributed = (plugins.data ?? []).flatMap((plugin) =>
      (plugin.strategies ?? []).map((strategy) => ({
        value: strategy,
        label: `${pluginDisplayName(plugin)} · ${strategy.slice(plugin.id.length + 1)}`,
      })),
    );
    return contributed.length === 0 ? strategies : [...strategies, ...contributed];
  }, [plugins.data, strategies]);
  const templates = useMemo(() => buildRoutingTemplates(config), [config]);
  // myna's skippable providers (internal/gui/groups.go:439-453): the ones
  // ready to serve, plus any left out whose provider is gone, so it can be
  // let back in.
  const skippable = useMemo(() => {
    const skip = (config.autoGroupSkip ?? []).map((id) => id.trim()).filter((id) => id !== "");
    const skipped = new Set(skip.map((id) => id.toLowerCase()));
    const known = new Set<string>();
    const rows: { id: string; label: string }[] = [];
    for (const provider of config.providers ?? []) {
      known.add(provider.id.toLowerCase());
      const ready =
        provider.enabled !== false && provider.exposeModels !== false && provider.models.length > 0;
      if (ready || skipped.has(provider.id.toLowerCase())) {
        rows.push({ id: provider.id, label: provider.label ?? provider.id });
      }
    }
    for (const id of skip) {
      if (!known.has(id.toLowerCase())) {
        rows.push({ id, label: id });
      }
    }
    return rows;
  }, [config.autoGroupSkip, config.providers]);
  const groupKeys = useGroupRowKeys(groups);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const addGroup = useCallback(() => {
    edit((next) => {
      next.groups = [...(next.groups ?? []), newRoutingGroup(next)];
    });
  }, [edit]);
  const addTemplate = useCallback(
    (template: RoutingTemplate) => {
      edit((next) => {
        next.groups = [
          ...(next.groups ?? []),
          groupFromTemplate(next, template, t(templateNameKey(template.kind))),
        ];
      });
      setTemplatesOpen(false);
    },
    [edit, t],
  );
  const toggleTemplates = useCallback(() => setTemplatesOpen((value) => !value), []);
  // myna's moveGroup (magpie/internal/gui/assets/plugins/routing/client.js:6244):
  // the listed groups in their new order, then the hidden ones, which keep
  // the places after them. The draft's own array moves too, so the row stays
  // where it was dropped before the save returns.
  const moveGroups = useCallback(
    (next: GatewayGroupWire[]) => {
      edit((draft) => {
        const byId = new Map((draft.groups ?? []).map((group) => [group.id, group]));
        const ordered = next.flatMap((group) => {
          const target = byId.get(group.id);
          return target === undefined ? [] : [target];
        });
        const listed = new Set(ordered.map((group) => group.id));
        draft.groups = [
          ...ordered,
          ...(draft.groups ?? []).filter((group) => !listed.has(group.id)),
        ];
        draft.groupOrder = [...ordered.map((group) => group.id), ...(draft.hiddenGroups ?? [])];
      });
    },
    [edit],
  );
  const moveGroupBy = useCallback(
    (index: number, delta: -1 | 1) => {
      const to = index + delta;
      if (index < 0 || index >= groups.length || to < 0 || to >= groups.length) {
        return;
      }
      const next = [...groups];
      const [moved] = next.splice(index, 1);
      if (moved !== undefined) {
        next.splice(to, 0, moved);
      }
      moveGroups(next);
    },
    [groups, moveGroups],
  );
  // myna's CopyGroup (magpie/internal/provider/group_copy.go:17): a copy that
  // shares nothing with its source, listed right after it, its name free.
  const duplicateGroup = useCallback(
    (index: number) => {
      edit((next) => {
        const list = [...(next.groups ?? [])];
        const source = list[index];
        if (source === undefined) {
          return;
        }
        const name = t("settings.gatewayPages.routing.copyName", {
          name: source.label ?? source.id,
        });
        const copy = JSON.parse(JSON.stringify(source)) as GatewayGroupWire;
        delete copy.auto;
        copy.id = uniqueGroupId(next, groupIdFrom(name));
        copy.label = name;
        list.splice(index + 1, 0, copy);
        next.groups = list;
        next.groupOrder = [...list.map((group) => group.id), ...(next.hiddenGroups ?? [])];
      });
    },
    [edit, t],
  );
  // myna's ShareGroup (magpie/internal/provider/group_share.go:34): the group
  // as text for another myna, with what this machine knows left behind.
  const copyGroup = useCallback(
    (group: GatewayGroupWire) => {
      void copyToClipboard(sharedGroupText(group))
        .then(() => toast.copied(t("settings.gatewayPages.routing.groupCopied")))
        .catch((cause: unknown) => {
          toast.error(cause instanceof Error ? cause.message : String(cause));
        });
    },
    [t, toast],
  );

  return (
    <View testID="gateway-routing-groups">
      <View style={styles.head}>
        <Text style={styles.title}>{t("settings.gatewayPages.routing.groupsTitle")}</Text>
        <View style={styles.headActions}>
          {templates.length === 0 ? null : (
            <Button variant="ghost" size="sm" onPress={toggleTemplates}>
              {t("settings.gatewayPages.routing.templates")}
            </Button>
          )}
          <Button variant="ghost" size="sm" onPress={addGroup}>
            {t("settings.gatewayPages.routing.addGroup")}
          </Button>
        </View>
      </View>
      {templatesOpen && templates.length > 0 ? (
        <TemplateRow templates={templates} onPick={addTemplate} />
      ) : null}
      <View style={settingsStyles.card}>
        <SwitchLine
          title={t("settings.gatewayPages.routing.foundGroups")}
          hint={t("settings.gatewayPages.routing.foundGroupsHint")}
          value={config.autoGroups !== false}
          onChange={(on) => edit((next) => (next.autoGroups = on))}
        />
        {config.autoGroups !== false && skippable.length > 0 ? (
          <View style={styles.skipBlock} testID="gateway-routing-group-skip">
            <Text style={styles.skipTitle}>{t("settings.gatewayPages.routing.skipTitle")}</Text>
            <Text style={styles.skipHint}>{t("settings.gatewayPages.routing.skipHint")}</Text>
            {skippable.map((provider) => (
              <SwitchLine
                key={provider.id}
                title={provider.label}
                value={(config.autoGroupSkip ?? []).some(
                  (id) => id.trim().toLowerCase() === provider.id.toLowerCase(),
                )}
                onChange={(on) =>
                  edit((next) => {
                    const ids = (next.autoGroupSkip ?? [])
                      .map((id) => id.trim())
                      .filter((id) => id !== "" && id.toLowerCase() !== provider.id.toLowerCase());
                    next.autoGroupSkip = on ? [...ids, provider.id] : ids;
                  })
                }
              />
            ))}
          </View>
        ) : null}
      </View>
      {groups.length === 0 ? (
        <View style={settingsStyles.card}>
          <Text style={styles.empty}>{t("settings.gatewayPages.routing.groupsEmpty")}</Text>
        </View>
      ) : (
        <DraggableList
          testID="gateway-routing-group-list"
          data={groups}
          keyExtractor={(_group, index) => groupKeys[index] ?? `routing-group-${index}`}
          renderItem={({ item: group, index, dragHandleProps }) => (
            <GroupCard
              group={group}
              strategies={strategyOptions}
              dragHandleProps={dragHandleProps}
              isFirst={index === 0}
              isLast={index === groups.length - 1}
              onMoveUp={() => moveGroupBy(index, -1)}
              onMoveDown={() => moveGroupBy(index, 1)}
              onDuplicate={() => duplicateGroup(index)}
              onCopy={() => copyGroup(group)}
              onChange={(mutate) =>
                edit((next) => {
                  const target = next.groups?.[index];
                  if (target !== undefined) {
                    const previousId = target.id;
                    mutate(target);
                    if (target.id !== previousId) {
                      syncGroupOrder(next, previousId, target.id);
                    }
                    // Changing a group the gateway found makes it the user's:
                    // the write keeps it, and the next read stops deriving it.
                    delete target.auto;
                  }
                })
              }
              onRemove={() =>
                edit((next) => {
                  if (group.auto === true) {
                    // Hiding a found group keeps its id, so turning find on
                    // again doesn't bring it back unasked.
                    next.hiddenGroups = [...(next.hiddenGroups ?? []), group.id];
                    return;
                  }
                  next.groups = (next.groups ?? []).filter((_, position) => position !== index);
                })
              }
            />
          )}
          onDragEnd={moveGroups}
          scrollEnabled={false}
          useDragHandle
        />
      )}
      <Text style={styles.hint}>{t("settings.gatewayPages.routing.groupsHint")}</Text>
    </View>
  );
}

function templateNameKey(kind: RoutingTemplateKind): string {
  if (kind === "steady") {
    return "settings.gatewayPages.routing.templateSteadyName";
  }
  return kind === "thrifty"
    ? "settings.gatewayPages.routing.templateThriftyName"
    : "settings.gatewayPages.routing.templateSmartName";
}

function templateHintKey(kind: RoutingTemplateKind): string {
  if (kind === "steady") {
    return "settings.gatewayPages.routing.templateSteadyHint";
  }
  return kind === "thrifty"
    ? "settings.gatewayPages.routing.templateThriftyHint"
    : "settings.gatewayPages.routing.templateSmartHint";
}

function TemplateRow({
  templates,
  onPick,
}: {
  templates: RoutingTemplate[];
  onPick: (template: RoutingTemplate) => void;
}) {
  const { t } = useTranslation();
  return (
    <View style={settingsStyles.card} testID="gateway-routing-templates">
      <Text style={styles.templateTitle}>{t("settings.gatewayPages.routing.templateHint")}</Text>
      {templates.map((template) => (
        <View key={template.kind} style={styles.templateRow}>
          <View style={styles.templateText}>
            <Text style={styles.templateName}>{t(templateNameKey(template.kind))}</Text>
            <Text style={styles.templateMembers} numberOfLines={2}>
              {template.members.join(" → ")}
            </Text>
            <Text style={styles.templateWhy}>{t(templateHintKey(template.kind))}</Text>
          </View>
          <Button variant="secondary" size="sm" onPress={() => onPick(template)}>
            {t("settings.gatewayPages.routing.templateUse")}
          </Button>
        </View>
      ))}
    </View>
  );
}

interface GroupCardProps {
  group: GatewayGroupWire;
  strategies: { value: string; label: string }[];
  dragHandleProps?: DraggableListDragHandleProps;
  isFirst: boolean;
  isLast: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDuplicate: () => void;
  onCopy: () => void;
  onChange: (mutate: (group: GatewayGroupWire) => void) => void;
  onRemove: () => void;
}

function GroupCard({
  group,
  strategies,
  dragHandleProps,
  isFirst,
  isLast,
  onMoveUp,
  onMoveDown,
  onDuplicate,
  onCopy,
  onChange,
  onRemove,
}: GroupCardProps) {
  const { t } = useTranslation();
  const found = group.auto === true;
  return (
    <View style={[settingsStyles.card, styles.card]} testID={`gateway-routing-group-${group.id}`}>
      <View style={styles.cardHead}>
        <DropdownMenu>
          <DropdownMenuTrigger
            accessibilityRole="button"
            accessibilityLabel={t("settings.gatewayPages.routing.arrangeGroup", {
              group: group.id,
            })}
            accessibilityHint={t("settings.gatewayPages.routing.arrangeGroupHint")}
            ref={dragHandleProps?.setActivatorNodeRef as unknown as Ref<View>}
            style={styles.dragHandle}
            testID={`gateway-routing-group-handle-${group.id}`}
            {...(dragHandleProps?.attributes as PressableProps | undefined)}
            {...(dragHandleProps?.listeners as PressableProps | undefined)}
          >
            <ThemedGripVertical size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" width={200}>
            <DropdownMenuItem leading={moveUpIcon} disabled={isFirst} onSelect={onMoveUp}>
              {t("settings.gatewayPages.routing.moveUp")}
            </DropdownMenuItem>
            <DropdownMenuItem leading={moveDownIcon} disabled={isLast} onSelect={onMoveDown}>
              {t("settings.gatewayPages.routing.moveDown")}
            </DropdownMenuItem>
            <DropdownMenuItem leading={duplicateIcon} onSelect={onDuplicate}>
              {t("settings.gatewayPages.routing.duplicateGroup")}
            </DropdownMenuItem>
            <DropdownMenuItem leading={shareIcon} onSelect={onCopy}>
              {t("settings.gatewayPages.routing.copyGroupShare")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Text style={styles.cardTitle} numberOfLines={1}>
          group/{group.id}
        </Text>
        <View style={styles.headActions}>
          {found ? (
            <Text style={styles.found}>{t("settings.gatewayPages.routing.foundGroup")}</Text>
          ) : null}
          <Button variant="ghost" size="sm" onPress={onRemove}>
            {found
              ? t("settings.gatewayPages.routing.hideGroup")
              : t("settings.gatewayPages.routing.removeGroup")}
          </Button>
        </View>
      </View>
      {found ? (
        <Text style={styles.foundHint}>{t("settings.gatewayPages.routing.foundGroupHint")}</Text>
      ) : null}
      <View style={styles.cardBody}>
        <GroupBasics group={group} strategies={strategies} onChange={onChange} />
        <GroupMembers group={group} onChange={onChange} />
        <GroupRules group={group} onChange={onChange} />
      </View>
    </View>
  );
}

function GroupBasics({
  group,
  strategies,
  onChange,
}: {
  group: GatewayGroupWire;
  strategies: { value: string; label: string }[];
  onChange: (mutate: (group: GatewayGroupWire) => void) => void;
}) {
  const { t } = useTranslation();
  const { isEnabled } = useActiveHostBuiltinFeatures();
  const rotationOn = isEnabled("rotation");
  return (
    <>
      <Field label={t("settings.gatewayPages.routing.groupId")}>
        <FormTextInput
          initialValue={group.id}
          onChangeText={(value) => onChange((next) => (next.id = value))}
          autoCapitalize="none"
          autoCorrect={false}
        />
      </Field>
      <Field label={t("settings.gatewayPages.routing.groupLabel")}>
        <FormTextInput
          initialValue={group.label ?? ""}
          placeholder={group.id}
          onChangeText={(value) =>
            onChange((next) => (next.label = value.length > 0 ? value : undefined))
          }
        />
      </Field>
      {rotationOn ? (
        <>
          <Field label={t("settings.gatewayPages.routing.groupStrategy")}>
            <SegmentedControl
              options={strategies}
              value={group.strategy ?? "order"}
              onValueChange={(value) => onChange((next) => (next.strategy = value))}
            />
            <Text style={styles.hint}>
              {t(`settings.gatewayPages.routing.strategy.${group.strategy ?? "order"}Hint`)}
            </Text>
          </Field>
          <SwitchLine
            title={t("settings.gatewayPages.routing.weighted")}
            hint={t("settings.gatewayPages.routing.weightedHint")}
            value={group.weighted === true}
            onChange={(value) => onChange((next) => (next.weighted = value ? true : undefined))}
          />
        </>
      ) : null}
      <SwitchLine
        title={t("settings.gatewayPages.routing.disabled")}
        hint={t("settings.gatewayPages.routing.disabledHint")}
        value={group.disabled === true}
        onChange={(value) => onChange((next) => (next.disabled = value ? true : undefined))}
      />
      <View style={styles.conditionRow}>
        <View style={styles.conditionGrow}>
          <Field
            label={t("settings.gatewayPages.routing.context")}
            hint={t("settings.gatewayPages.routing.contextHint")}
          >
            <FormTextInput
              initialValue={group.context === undefined ? "" : String(group.context)}
              keyboardType="number-pad"
              placeholder="0"
              onChangeText={(value) =>
                onChange((next) => {
                  const parsed = Number.parseInt(value, 10);
                  next.context = Number.isFinite(parsed) ? parsed : undefined;
                })
              }
            />
          </Field>
        </View>
        <View style={styles.conditionGrow}>
          <CommaListField
            label={t("settings.gatewayPages.routing.levels")}
            hint={t("settings.gatewayPages.routing.levelsHint")}
            placeholder="low, high"
            value={group.levels ?? []}
            onChange={(levels) =>
              onChange((next) => (next.levels = levels.length > 0 ? levels : undefined))
            }
          />
        </View>
      </View>
      <Field
        label={t("settings.gatewayPages.routing.classifier")}
        hint={t("settings.gatewayPages.routing.classifierHint")}
      >
        <FormTextInput
          initialValue={group.classifier ?? ""}
          placeholder="provider/model"
          autoCapitalize="none"
          autoCorrect={false}
          onChangeText={(value) =>
            onChange((next) => (next.classifier = value.length > 0 ? value : undefined))
          }
        />
      </Field>
    </>
  );
}

function GroupMembers({
  group,
  onChange,
}: {
  group: GatewayGroupWire;
  onChange: (mutate: (group: GatewayGroupWire) => void) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <CommaListField
        label={t("settings.gatewayPages.routing.groupMembers")}
        hint={t("settings.gatewayPages.routing.groupMembersHint")}
        placeholder="provider/model, group/other"
        value={group.members}
        onChange={(members) => onChange((next) => (next.members = members))}
      />
      <View style={styles.memberList}>
        {group.members.map((member) => (
          <MemberLine key={member} group={group} member={member} onChange={onChange} />
        ))}
      </View>
      <CommaListField
        label={t("settings.gatewayPages.routing.accounts")}
        hint={t("settings.gatewayPages.routing.accountsHint")}
        placeholder="provider/account"
        value={group.accounts ?? []}
        onChange={(accounts) =>
          onChange((next) => (next.accounts = accounts.length > 0 ? accounts : undefined))
        }
      />
      <CommaListField
        label={t("settings.gatewayPages.routing.match")}
        hint={t("settings.gatewayPages.routing.matchHint")}
        placeholder="openai/*, re:^claude-"
        value={group.match ?? []}
        onChange={(match) =>
          onChange((next) => (next.match = match.length > 0 ? match : undefined))
        }
      />
      <CommaListField
        label={t("settings.gatewayPages.routing.off")}
        hint={t("settings.gatewayPages.routing.offHint")}
        placeholder="provider/model"
        value={group.off ?? []}
        onChange={(off) => onChange((next) => (next.off = off.length > 0 ? off : undefined))}
      />
      <Field
        label={t("settings.gatewayPages.routing.pick")}
        hint={t("settings.gatewayPages.routing.pickHint")}
      >
        <FormTextInput
          initialValue={group.pick ?? ""}
          placeholder="provider/model"
          autoCapitalize="none"
          autoCorrect={false}
          onChangeText={(value) =>
            onChange((next) => (next.pick = value.length > 0 ? value : undefined))
          }
        />
      </Field>
    </>
  );
}

function MemberLine({
  group,
  member,
  onChange,
}: {
  group: GatewayGroupWire;
  member: string;
  onChange: (mutate: (group: GatewayGroupWire) => void) => void;
}) {
  const { t } = useTranslation();
  const fast = (group.fast ?? []).includes(member);
  const toggleFast = useCallback(
    (value: boolean) => {
      onChange((next) => {
        const list = new Set(next.fast ?? []);
        if (value) {
          list.add(member);
        } else {
          list.delete(member);
        }
        next.fast = list.size > 0 ? [...list] : undefined;
      });
    },
    [member, onChange],
  );
  return (
    <View style={styles.memberRow}>
      <Text style={styles.memberName} numberOfLines={1}>
        {member}
      </Text>
      {group.weighted === true ? (
        <WeightField
          weight={group.weights?.[member] ?? 1}
          onChange={(weight) =>
            onChange((next) => {
              next.weights = { ...next.weights, [member]: weight };
            })
          }
        />
      ) : null}
      <View style={styles.memberFast}>
        <Text style={styles.memberFastLabel}>{t("settings.gatewayPages.routing.fast")}</Text>
        <Switch value={fast} onValueChange={toggleFast} />
      </View>
    </View>
  );
}

function WeightField({ weight, onChange }: { weight: number; onChange: (weight: number) => void }) {
  const { t } = useTranslation();
  return (
    <View style={styles.weight}>
      <Text style={styles.memberFastLabel}>{t("settings.gatewayPages.routing.weight")}</Text>
      <FormTextInput
        initialValue={String(weight)}
        keyboardType="number-pad"
        onChangeText={(value) => {
          const parsed = Number.parseInt(value, 10);
          if (Number.isFinite(parsed) && parsed > 0) {
            onChange(Math.min(parsed, 9999));
          }
        }}
        style={styles.weightInput}
      />
    </View>
  );
}

function GroupRules({
  group,
  onChange,
}: {
  group: GatewayGroupWire;
  onChange: (mutate: (group: GatewayGroupWire) => void) => void;
}) {
  const { t } = useTranslation();
  const rules = group.rules ?? [];
  const addRule = useCallback(() => {
    onChange((next) => {
      next.rules = [...(next.rules ?? []), { use: group.members[0] ?? "" }];
    });
  }, [group.members, onChange]);
  return (
    <View style={styles.rules}>
      <View style={styles.rulesHead}>
        <Text style={styles.rulesTitle}>{t("settings.gatewayPages.routing.rules")}</Text>
        <Button variant="ghost" size="sm" disabled={group.members.length === 0} onPress={addRule}>
          {t("settings.gatewayPages.routing.addRule")}
        </Button>
      </View>
      <Text style={styles.rulesHint}>{t("settings.gatewayPages.routing.rulesHint")}</Text>
      {rules.map((rule, index) => (
        <RuleEditor
          key={`${group.id}-rule-${index}`}
          rule={rule}
          onChange={(mutate) =>
            onChange((next) => {
              const target = next.rules?.[index];
              if (target !== undefined) {
                mutate(target);
              }
            })
          }
          onRemove={() =>
            onChange((next) => {
              next.rules = (next.rules ?? []).filter((_, position) => position !== index);
            })
          }
        />
      ))}
    </View>
  );
}

function RuleEditor({
  rule,
  onChange,
  onRemove,
}: {
  rule: NonNullable<GatewayGroupWire["rules"]>[number];
  onChange: (mutate: (rule: NonNullable<GatewayGroupWire["rules"]>[number]) => void) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const setField = useCallback(
    (mutate: (rule: NonNullable<GatewayGroupWire["rules"]>[number]) => void) => {
      onChange(mutate);
    },
    [onChange],
  );
  const time = rule.time;
  return (
    <View style={styles.rule}>
      <View style={styles.ruleHead}>
        <Text style={styles.ruleTitle}>{t("settings.gatewayPages.routing.ruleTitle")}</Text>
        <Button variant="ghost" size="sm" onPress={onRemove}>
          {t("settings.gatewayPages.routing.removeRule")}
        </Button>
      </View>
      <Field
        label={t("settings.gatewayPages.routing.ruleUse")}
        hint={t("settings.gatewayPages.routing.ruleUseHint")}
      >
        <FormTextInput
          initialValue={rule.use}
          placeholder="provider/model"
          autoCapitalize="none"
          autoCorrect={false}
          onChangeText={(value) => setField((next) => (next.use = value))}
        />
      </Field>
      <CommaListField
        label={t("settings.gatewayPages.routing.ruleMore")}
        hint={t("settings.gatewayPages.routing.ruleMoreHint")}
        placeholder="provider/model"
        value={rule.more ?? []}
        onChange={(more) => setField((next) => (next.more = more.length > 0 ? more : undefined))}
      />
      <Field
        label={t("settings.gatewayPages.routing.ruleUseEffort")}
        hint={t("settings.gatewayPages.routing.ruleUseEffortHint")}
      >
        <FormTextInput
          initialValue={rule.useEffort ?? ""}
          placeholder="high"
          autoCapitalize="none"
          autoCorrect={false}
          onChangeText={(value) =>
            setField((next) => {
              next.useEffort = EFFORTS.find((effort) => effort === value);
            })
          }
        />
      </Field>
      <View style={styles.conditionRow}>
        <View style={styles.conditionGrow}>
          <Field label={t("settings.gatewayPages.routing.ruleTokens")}>
            <FormTextInput
              initialValue={rule.tokens === undefined ? "" : String(rule.tokens)}
              keyboardType="number-pad"
              onChangeText={(value) =>
                setField((next) => {
                  const parsed = Number.parseInt(value, 10);
                  next.tokens = Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
                })
              }
            />
          </Field>
        </View>
        <View style={styles.conditionGrow}>
          <Field
            label={t("settings.gatewayPages.routing.ruleEffort")}
            hint={t("settings.gatewayPages.routing.ruleEffortHint")}
          >
            <FormTextInput
              initialValue={rule.effort ?? ""}
              placeholder="on"
              autoCapitalize="none"
              autoCorrect={false}
              onChangeText={(value) =>
                setField((next) => (next.effort = value.length > 0 ? value : undefined))
              }
            />
          </Field>
        </View>
      </View>
      <CommaListField
        label={t("settings.gatewayPages.routing.ruleAgents")}
        hint={t("settings.gatewayPages.routing.ruleAgentsHint")}
        placeholder="Claude Code"
        value={rule.agents ?? []}
        onChange={(agents) =>
          setField((next) => (next.agents = agents.length > 0 ? agents : undefined))
        }
      />
      <View style={styles.conditionRow}>
        <View style={styles.conditionGrow}>
          <Field label={t("settings.gatewayPages.routing.ruleTimeFrom")}>
            <FormTextInput
              initialValue={time?.from ?? ""}
              placeholder="22:00"
              autoCapitalize="none"
              autoCorrect={false}
              onChangeText={(value) => setField((next) => setWindow(next, { from: value }))}
            />
          </Field>
        </View>
        <View style={styles.conditionGrow}>
          <Field label={t("settings.gatewayPages.routing.ruleTimeTo")}>
            <FormTextInput
              initialValue={time?.to ?? ""}
              placeholder="08:00"
              autoCapitalize="none"
              autoCorrect={false}
              onChangeText={(value) => setField((next) => setWindow(next, { to: value }))}
            />
          </Field>
        </View>
        <View style={styles.conditionGrow}>
          <Field
            label={t("settings.gatewayPages.routing.ruleDays")}
            hint={t("settings.gatewayPages.routing.ruleDaysHint")}
          >
            <FormTextInput
              initialValue={(time?.days ?? []).join(", ")}
              placeholder="mon, tue"
              autoCapitalize="none"
              autoCorrect={false}
              onChangeText={(value) =>
                setField((next) => setWindow(next, { days: splitList(value) }))
              }
            />
          </Field>
        </View>
      </View>
      <Field
        label={t("settings.gatewayPages.routing.ruleZone")}
        hint={t("settings.gatewayPages.routing.ruleZoneHint")}
      >
        <FormTextInput
          initialValue={time?.zone ?? ""}
          placeholder="Asia/Shanghai"
          autoCapitalize="none"
          autoCorrect={false}
          onChangeText={(value) => setField((next) => setWindow(next, { zone: value }))}
        />
      </Field>
      <SwitchLine
        title={t("settings.gatewayPages.routing.ruleImages")}
        value={rule.images === true}
        onChange={(value) => setField((next) => (next.images = value ? true : undefined))}
      />
      <SwitchLine
        title={t("settings.gatewayPages.routing.rulePause")}
        hint={t("settings.gatewayPages.routing.rulePauseHint")}
        value={rule.pause === true}
        onChange={(value) => setField((next) => (next.pause = value ? true : undefined))}
      />
      <Field
        label={t("settings.gatewayPages.routing.ruleIntent")}
        hint={t("settings.gatewayPages.routing.ruleIntentHint")}
      >
        <FormTextInput
          initialValue={rule.intent ?? ""}
          placeholder={t("settings.gatewayPages.routing.ruleIntentPlaceholder")}
          autoCapitalize="none"
          autoCorrect={false}
          onChangeText={(value) =>
            setField((next) => (next.intent = value.length > 0 ? value : undefined))
          }
        />
      </Field>
      <CommaListField
        label={t("settings.gatewayPages.routing.ruleFolders")}
        hint={t("settings.gatewayPages.routing.ruleFoldersHint")}
        placeholder="/Users/me/src/*"
        value={rule.folders ?? []}
        onChange={(folders) =>
          setField((next) => (next.folders = folders.length > 0 ? folders : undefined))
        }
      />
      <CommaListField
        label={t("settings.gatewayPages.routing.ruleExceptFolders")}
        hint={t("settings.gatewayPages.routing.ruleExceptFoldersHint")}
        placeholder="/Users/me/src/vendor"
        value={rule.exceptFolders ?? []}
        onChange={(exceptFolders) =>
          setField(
            (next) => (next.exceptFolders = exceptFolders.length > 0 ? exceptFolders : undefined),
          )
        }
      />
      <SwitchLine
        title={t("settings.gatewayPages.routing.ruleCompact")}
        hint={t("settings.gatewayPages.routing.ruleCompactHint")}
        value={rule.compact === true}
        onChange={(value) => setField((next) => (next.compact = value ? true : undefined))}
      />
    </View>
  );
}

type RuleTime = NonNullable<NonNullable<GatewayGroupWire["rules"]>[number]["time"]>;

function setWindow(
  rule: NonNullable<GatewayGroupWire["rules"]>[number],
  patch: Partial<RuleTime>,
): void {
  const from = patch.from ?? rule.time?.from ?? "";
  const to = patch.to ?? rule.time?.to ?? "";
  const days = patch.days ?? rule.time?.days ?? [];
  const zone = patch.zone ?? rule.time?.zone ?? "";
  if (from.length === 0 && to.length === 0) {
    rule.time = undefined;
    return;
  }
  rule.time = {
    from,
    to,
    ...(days.length === 0 ? {} : { days }),
    ...(zone.length === 0 ? {} : { zone }),
  };
}

function CommaListField({
  label,
  hint,
  placeholder,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  placeholder?: string;
  value: string[];
  onChange: (items: string[]) => void;
}) {
  const [text, setText] = useState(() => value.join(", "));
  const commit = useCallback(() => onChange(splitList(text)), [onChange, text]);
  return (
    <Field label={label} hint={hint}>
      <FormTextInput
        initialValue={text}
        onChangeText={setText}
        onBlur={commit}
        placeholder={placeholder}
        autoCapitalize="none"
        autoCorrect={false}
      />
    </Field>
  );
}

function SwitchLine({
  title,
  hint,
  value,
  onChange,
}: {
  title: string;
  hint?: string;
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <View style={styles.switchLine}>
      <View style={styles.switchText}>
        <Text style={styles.switchTitle}>{title}</Text>
        {hint === undefined ? null : <Text style={styles.switchHint}>{hint}</Text>}
      </View>
      <Switch value={value} onValueChange={onChange} accessibilityLabel={title} />
    </View>
  );
}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

const styles = StyleSheet.create((theme) => ({
  head: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: theme.spacing[3],
    marginLeft: theme.spacing[1],
  },
  headActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  title: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
  card: {
    marginBottom: theme.spacing[3],
  },
  cardHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  cardTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    flexShrink: 1,
    flexGrow: 1,
  },
  dragHandle: {
    padding: theme.spacing[1],
    marginLeft: -theme.spacing[1],
    marginRight: theme.spacing[1],
    borderRadius: theme.borderRadius.sm,
  },
  found: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  foundHint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[2],
  },
  cardBody: {
    padding: theme.spacing[4],
    gap: theme.spacing[3],
  },
  hint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    marginLeft: theme.spacing[1],
  },
  empty: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    padding: theme.spacing[4],
  },
  templateTitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[3],
  },
  templateRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
  },
  templateText: {
    flex: 1,
    minWidth: 0,
  },
  templateName: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  templateMembers: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    marginTop: 2,
  },
  templateWhy: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.sm,
    marginTop: 2,
  },
  memberList: {
    gap: theme.spacing[2],
  },
  memberRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[1],
  },
  memberName: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontFamily: theme.fontFamily.mono,
  },
  memberFast: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  memberFastLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  weight: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  weightInput: {
    width: 64,
  },
  rules: {
    gap: theme.spacing[2],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    paddingTop: theme.spacing[3],
  },
  rulesHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  rulesTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  rulesHint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  rule: {
    gap: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[3],
    backgroundColor: theme.colors.surface2,
  },
  ruleHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  ruleTitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  conditionRow: {
    flexDirection: "row",
    gap: theme.spacing[2],
  },
  conditionGrow: {
    flex: 1,
    minWidth: 0,
  },
  skipBlock: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    padding: theme.spacing[4],
    gap: theme.spacing[2],
  },
  skipTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  skipHint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  switchLine: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
  },
  switchText: {
    flex: 1,
    minWidth: 0,
  },
  switchTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  switchHint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    marginTop: 2,
  },
}));
