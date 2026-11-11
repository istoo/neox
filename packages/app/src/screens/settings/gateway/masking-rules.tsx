/* eslint-disable react-perf/jsx-no-new-function-as-prop, react-perf/jsx-no-new-object-as-prop, react-perf/jsx-no-jsx-as-prop, react/no-array-index-key -- settings form rows: a handful of closures and option arrays, none in a hot list; an editable rule has no id but its index. */
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { GatewayConfigWire, GatewayMaskingActionWire } from "@neolix/protocol/gateway";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Switch } from "@/components/ui/switch";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { useToast } from "@/contexts/toast-context";
import { settingsStyles } from "@/styles/settings";
import { toErrorMessage } from "@/utils/error-messages";
import { MASK_KINDS, kindColorIndex, splitValues } from "./masking-shared";

interface MaskingRulesProps {
  config: GatewayConfigWire;
  edit: (mutate: (next: GatewayConfigWire) => void) => void;
  apply: (mutate: (next: GatewayConfigWire) => void) => Promise<void>;
  /** myna hides the alert preference on the page a gateway-only host serves. */
  hideAlert: boolean;
}

const ACTIONS: readonly GatewayMaskingActionWire[] = ["mask", "warn", "block"];

/** Personal kinds with their own switch, on unless turned off. */
const PERSONAL_KIND_SWITCHES = [
  "ssn",
  "passport",
  "iban",
  "birthday",
  "mac",
  "serial",
  "ip",
] as const;

function kindLabelKey(kind: string): string {
  return `settings.gatewayPages.masking.kind.${kind}`;
}

/** Per-kind Mask/Warn/Block, the allow list, and the user's own patterns. */
export function MaskingRulesCard({ config, edit, apply, hideAlert }: MaskingRulesProps) {
  const { t } = useTranslation();
  const toast = useToast();
  // Every switch on this card saves through here, so a failed write says so
  // instead of silently leaving the switch showing a value the host refused.
  const applyReporting = useCallback(
    async (mutate: (next: GatewayConfigWire) => void) => {
      try {
        await apply(mutate);
      } catch (cause) {
        toast.error(toErrorMessage(cause));
      }
    },
    [apply, toast],
  );
  const actions = config.masking?.actions ?? {};
  const rules = config.masking?.rules ?? [];
  const categories = config.masking?.categories ?? [];
  const [showAll, setShowAll] = useState(false);
  const builtIn = showAll
    ? [...MASK_KINDS]
    : MASK_KINDS.filter((kind) => categories.length === 0 || categories.includes(kind));
  const custom = rules.map((rule) => rule.kind.trim()).filter((kind) => kind.length > 0);
  const kinds = [...new Set([...builtIn, ...custom, ...Object.keys(actions)])];
  const hidden = MASK_KINDS.filter((kind) => !kinds.includes(kind));
  const setAction = (kind: string, action: GatewayMaskingActionWire) => {
    void applyReporting((next) => {
      const current = { ...next.masking?.actions };
      if (action === "mask") {
        delete current[kind];
      } else {
        current[kind] = action;
      }
      next.masking = {
        ...next.masking,
        enabled: next.masking?.enabled ?? true,
        allow: next.masking?.allow ?? [],
        actions: current,
      };
    });
  };
  return (
    <SettingsSection
      title={t("settings.gatewayPages.masking.rulesTitle")}
      info={t("settings.gatewayPages.masking.rulesHint")}
      testID="gateway-masking-rules"
    >
      <View style={settingsStyles.card}>
        <View style={styles.actionRow}>
          <View style={styles.actionMain}>
            <Text style={styles.actionKind}>{t("settings.gatewayPages.masking.shapeTitle")}</Text>
            <Text style={styles.actionHint}>{t("settings.gatewayPages.masking.shapeHint")}</Text>
          </View>
          <Switch
            value={config.masking?.shape === true}
            onValueChange={(value) => {
              void applyReporting((next) => {
                next.masking = {
                  ...next.masking,
                  enabled: next.masking?.enabled ?? true,
                  allow: next.masking?.allow ?? [],
                  shape: value,
                };
              });
            }}
          />
        </View>
        <MaskingAlertRow config={config} apply={applyReporting} hidden={hideAlert} />
        <CategoryRow
          title={t("settings.gatewayPages.masking.personalTitle")}
          hint={t("settings.gatewayPages.masking.personalHint")}
          value={config.masking?.personal === true}
          onChange={(value) =>
            void applyReporting((next) => {
              // Mask secrets is its own switch: turning personal data on does
              // not turn it on too (myna's redact and redactPersonal).
              next.masking = {
                ...next.masking,
                enabled: next.masking?.enabled ?? false,
                allow: next.masking?.allow ?? [],
                personal: value,
              };
            })
          }
        />
        <WordsRow config={config} apply={applyReporting} />
        <CategoryRow
          title={t("settings.gatewayPages.masking.wordsAnyCaseTitle")}
          hint={t("settings.gatewayPages.masking.wordsAnyCaseHint")}
          value={config.masking?.wordsAnyCase === true}
          onChange={(value) =>
            void applyReporting((next) => {
              next.masking = {
                ...next.masking,
                enabled: next.masking?.enabled ?? true,
                allow: next.masking?.allow ?? [],
                wordsAnyCase: value,
              };
            })
          }
        />
        <CategoryRow
          title={t("settings.gatewayPages.masking.wordsWholeTitle")}
          hint={t("settings.gatewayPages.masking.wordsWholeHint")}
          value={config.masking?.wordsWhole === true}
          onChange={(value) =>
            void applyReporting((next) => {
              next.masking = {
                ...next.masking,
                enabled: next.masking?.enabled ?? true,
                allow: next.masking?.allow ?? [],
                wordsWhole: value,
              };
            })
          }
        />
        <PersonalKindRows
          config={config}
          apply={applyReporting}
          on={config.masking?.personal === true}
        />
        <RouteRow config={config} apply={applyReporting} />
        {kinds.length === 0 ? (
          <Text style={styles.empty}>{t("settings.gatewayPages.masking.noKinds")}</Text>
        ) : (
          kinds.map((kind) => {
            const action = (actions[kind] ?? "mask") as GatewayMaskingActionWire;
            return (
              <View key={kind} style={[styles.actionRow, settingsStyles.rowBorder]}>
                <View style={styles.actionMain}>
                  <View style={styles.actionName}>
                    <KindDot kind={kind} ranking={[]} />
                    <Text style={styles.actionKind}>
                      {t(kindLabelKey(kind), { defaultValue: kind })}
                    </Text>
                  </View>
                  <Text style={styles.actionHint}>
                    {t(`settings.gatewayPages.masking.actionHint.${action}`)}
                  </Text>
                </View>
                <SegmentedControl
                  options={ACTIONS.map((value) => ({
                    value,
                    label: t(`settings.gatewayPages.masking.action.${value}`),
                  }))}
                  value={action}
                  onValueChange={(value) => setAction(kind, value)}
                />
              </View>
            );
          })
        )}
        {hidden.length > 0 || showAll ? (
          <View style={[styles.moreRow, settingsStyles.rowBorder]}>
            <Button variant="ghost" size="sm" onPress={() => setShowAll((current) => !current)}>
              {t(
                showAll
                  ? "settings.gatewayPages.masking.showFewer"
                  : "settings.gatewayPages.masking.showAllKinds",
                { n: hidden.length },
              )}
            </Button>
          </View>
        ) : null}
      </View>

      <View style={styles.cardGap} />

      <View style={settingsStyles.card}>
        <AllowRow config={config} apply={applyReporting} />
      </View>

      <View style={styles.cardGap} />

      <View style={settingsStyles.card}>
        <View style={styles.rulesHead}>
          <Text style={settingsStyles.rowTitle}>
            {t("settings.gatewayPages.masking.customRulesTitle")}
          </Text>
          <Text style={settingsStyles.rowHint}>
            {t("settings.gatewayPages.masking.customRulesHint")}
          </Text>
        </View>
        {rules.map((rule, index) => (
          <View
            key={`${rule.kind}:${rule.pattern}:${index}`}
            style={[styles.ruleRow, settingsStyles.rowBorder]}
          >
            <View style={styles.ruleFields}>
              <Field label={t("settings.gatewayPages.masking.ruleKind")}>
                <FormTextInput
                  initialValue={rule.kind}
                  resetKey={`${index}-${rule.kind}`}
                  autoCapitalize="characters"
                  autoCorrect={false}
                  onChangeText={(value) =>
                    edit((next) => {
                      const entry = next.masking?.rules?.[index];
                      if (entry !== undefined) {
                        entry.kind = value;
                        next.masking = {
                          ...next.masking,
                          enabled: next.masking?.enabled ?? true,
                          allow: next.masking?.allow ?? [],
                        };
                      }
                    })
                  }
                />
              </Field>
              <SegmentedControl
                options={[
                  { value: "regex", label: t("settings.gatewayPages.masking.ruleRegex") },
                  { value: "prefix", label: t("settings.gatewayPages.masking.rulePrefix") },
                ]}
                value={rule.prefix !== undefined && rule.prefix !== "" ? "prefix" : "regex"}
                onValueChange={(mode) =>
                  edit((next) => {
                    const entry = next.masking?.rules?.[index];
                    if (entry === undefined) {
                      return;
                    }
                    const value =
                      entry.prefix !== undefined && entry.prefix !== ""
                        ? entry.prefix
                        : entry.pattern;
                    if (mode === "prefix") {
                      entry.prefix = value;
                      entry.pattern = "";
                    } else {
                      entry.pattern = entry.prefix ?? entry.pattern;
                      entry.prefix = undefined;
                    }
                    next.masking = {
                      ...next.masking,
                      enabled: next.masking?.enabled ?? true,
                      allow: next.masking?.allow ?? [],
                    };
                  })
                }
              />
              <Field
                label={t(
                  rule.prefix !== undefined && rule.prefix !== ""
                    ? "settings.gatewayPages.masking.rulePrefix"
                    : "settings.gatewayPages.masking.rulePattern",
                )}
                hint={t(
                  rule.prefix !== undefined && rule.prefix !== ""
                    ? "settings.gatewayPages.masking.rulePrefixHint"
                    : "settings.gatewayPages.masking.rulePatternHint",
                )}
              >
                <FormTextInput
                  initialValue={
                    rule.prefix !== undefined && rule.prefix !== "" ? rule.prefix : rule.pattern
                  }
                  resetKey={`${index}-${rule.prefix ?? ""}-${rule.pattern}`}
                  autoCapitalize="none"
                  autoCorrect={false}
                  onChangeText={(value) =>
                    edit((next) => {
                      const entry = next.masking?.rules?.[index];
                      if (entry === undefined) {
                        return;
                      }
                      if (entry.prefix !== undefined && entry.prefix !== "") {
                        entry.prefix = value;
                      } else {
                        entry.pattern = value;
                      }
                      next.masking = {
                        ...next.masking,
                        enabled: next.masking?.enabled ?? true,
                        allow: next.masking?.allow ?? [],
                      };
                    })
                  }
                />
              </Field>
              <Field label={t("settings.gatewayPages.masking.ruleFlags")}>
                <FormTextInput
                  initialValue={rule.flags ?? ""}
                  resetKey={`${index}-${rule.flags ?? ""}`}
                  autoCapitalize="none"
                  autoCorrect={false}
                  onChangeText={(value) =>
                    edit((next) => {
                      const entry = next.masking?.rules?.[index];
                      if (entry !== undefined) {
                        entry.flags = value.length === 0 ? undefined : value;
                        next.masking = {
                          ...next.masking,
                          enabled: next.masking?.enabled ?? true,
                          allow: next.masking?.allow ?? [],
                        };
                      }
                    })
                  }
                />
              </Field>
            </View>
            <View style={styles.ruleActions}>
              <Button
                variant="ghost"
                size="sm"
                onPress={() =>
                  edit((next) => {
                    next.masking = {
                      ...next.masking,
                      enabled: next.masking?.enabled ?? true,
                      allow: next.masking?.allow ?? [],
                      rules: (next.masking?.rules ?? []).filter((_, at) => at !== index),
                    };
                  })
                }
              >
                {t("settings.gatewayPages.masking.remove")}
              </Button>
            </View>
          </View>
        ))}
        <View style={styles.moreRow}>
          <Button
            variant="ghost"
            size="sm"
            onPress={() =>
              edit((next) => {
                next.masking = {
                  ...next.masking,
                  enabled: next.masking?.enabled ?? true,
                  allow: next.masking?.allow ?? [],
                  rules: [...(next.masking?.rules ?? []), { kind: "CUSTOM", pattern: "" }],
                };
              })
            }
          >
            {t("settings.gatewayPages.masking.addRule")}
          </Button>
        </View>
      </View>
    </SettingsSection>
  );
}

/** myna's #maskPrefs: hidden on the page a gateway-only host serves. */
function MaskingAlertRow({
  config,
  apply,
  hidden,
}: {
  config: GatewayConfigWire;
  apply: (mutate: (next: GatewayConfigWire) => void) => Promise<void>;
  hidden: boolean;
}) {
  const { t } = useTranslation();
  if (hidden) {
    return null;
  }
  return (
    <View style={[styles.actionRow, settingsStyles.rowBorder]}>
      <View style={styles.actionMain}>
        <Text style={styles.actionKind}>{t("settings.gatewayPages.masking.alertRowTitle")}</Text>
        <Text style={styles.actionHint}>{t("settings.gatewayPages.masking.alertRowHint")}</Text>
      </View>
      <Switch
        value={config.masking?.alert === true}
        onValueChange={(value) => {
          void apply((next) => {
            next.masking = {
              ...next.masking,
              enabled: next.masking?.enabled ?? true,
              allow: next.masking?.allow ?? [],
              alert: value,
            };
          });
        }}
      />
    </View>
  );
}

/** The kinds under Mask personal data, shown only while it is on (myna). */
function PersonalKindRows({
  config,
  apply,
  on,
}: {
  config: GatewayConfigWire;
  apply: MaskingRulesProps["apply"];
  on: boolean;
}) {
  const { t } = useTranslation();
  if (!on) {
    return null;
  }
  const switches = config.masking?.categorySwitches;
  const setSwitch = (key: string, value: boolean) => {
    void apply((next) => {
      next.masking = {
        ...next.masking,
        enabled: next.masking?.enabled ?? false,
        allow: next.masking?.allow ?? [],
        categorySwitches: { ...next.masking?.categorySwitches, [key]: value },
      };
    });
  };
  return (
    <>
      {PERSONAL_KIND_SWITCHES.map((kind) => (
        <CategoryRow
          key={kind}
          title={t(kindLabelKey(kind.toUpperCase()), { defaultValue: kind.toUpperCase() })}
          hint={t("settings.gatewayPages.masking.kindSwitchHint")}
          value={switches?.[kind] !== false}
          onChange={(value) => setSwitch(kind, value)}
        />
      ))}
      <CategoryRow
        title={t("settings.gatewayPages.masking.categoryUserhostTitle")}
        hint={t("settings.gatewayPages.masking.categoryUserhostHint")}
        value={switches?.userhost === true}
        onChange={(value) => setSwitch("userhost", value)}
      />
      <CategoryRow
        title={t("settings.gatewayPages.masking.categoryBucketTitle")}
        hint={t("settings.gatewayPages.masking.categoryBucketHint")}
        value={switches?.bucket === true}
        onChange={(value) => setSwitch("bucket", value)}
      />
    </>
  );
}

function WordsRow({
  config,
  apply,
}: {
  config: GatewayConfigWire;
  apply: (mutate: (next: GatewayConfigWire) => void) => Promise<void>;
}) {
  const { t } = useTranslation();
  const saved = (config.masking?.words ?? []).join(", ");
  const [text, setText] = useState(saved);
  useEffect(() => {
    setText(saved);
  }, [saved]);
  const save = () => {
    if (text === saved) {
      return;
    }
    void apply((next) => {
      next.masking = {
        ...next.masking,
        enabled: next.masking?.enabled ?? true,
        allow: next.masking?.allow ?? [],
        words: splitValues(text),
      };
    });
  };
  return (
    <View style={styles.allowRow}>
      <View style={styles.allowMain}>
        <Text style={settingsStyles.rowTitle}>{t("settings.gatewayPages.masking.wordsTitle")}</Text>
        <Text style={settingsStyles.rowHint}>{t("settings.gatewayPages.masking.wordsHint")}</Text>
      </View>
      <FormTextInput
        initialValue={saved}
        resetKey={saved}
        placeholder={t("settings.gatewayPages.masking.wordsTitle")}
        autoCapitalize="none"
        autoCorrect={false}
        onChangeText={setText}
        onBlur={save}
      />
    </View>
  );
}

function RouteRow({
  config,
  apply,
}: {
  config: GatewayConfigWire;
  apply: (mutate: (next: GatewayConfigWire) => void) => Promise<void>;
}) {
  const { t } = useTranslation();
  const saved = config.masking?.routeTo ?? "";
  const [text, setText] = useState(saved);
  useEffect(() => {
    setText(saved);
  }, [saved]);
  const eligible = (config.providers ?? [])
    .filter((provider) => provider.unredacted === true && provider.enabled !== false)
    .flatMap((provider) => provider.models.map((model) => `${provider.id}/${model.id}`));
  const save = () => {
    const value = text.trim();
    if (value === saved) {
      return;
    }
    void apply((next) => {
      next.masking = {
        ...next.masking,
        enabled: next.masking?.enabled ?? true,
        allow: next.masking?.allow ?? [],
        routeTo: value === "" ? undefined : value,
      };
    });
  };
  return (
    <View style={styles.allowRow}>
      <View style={styles.allowMain}>
        <Text style={settingsStyles.rowTitle}>{t("settings.gatewayPages.masking.routeTitle")}</Text>
        <Text style={settingsStyles.rowHint}>
          {eligible.length === 0
            ? t("settings.gatewayPages.masking.routeUnavailable")
            : t("settings.gatewayPages.masking.routeHint")}
        </Text>
        {eligible.length === 0 ? null : (
          <Text style={styles.actionHint}>{eligible.join(" · ")}</Text>
        )}
      </View>
      <FormTextInput
        initialValue={saved}
        resetKey={saved}
        placeholder={t("settings.gatewayPages.masking.routePlaceholder")}
        autoCapitalize="none"
        autoCorrect={false}
        onChangeText={setText}
        onBlur={save}
      />
    </View>
  );
}

function CategoryRow({
  title,
  hint,
  value,
  onChange,
}: {
  title: string;
  hint: string;
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <View style={[styles.actionRow, settingsStyles.rowBorder]}>
      <View style={styles.actionMain}>
        <Text style={styles.actionKind}>{title}</Text>
        <Text style={styles.actionHint}>{hint}</Text>
      </View>
      <Switch value={value} onValueChange={onChange} />
    </View>
  );
}

function AllowRow({
  config,
  apply,
}: {
  config: GatewayConfigWire;
  apply: (mutate: (next: GatewayConfigWire) => void) => Promise<void>;
}) {
  const { t } = useTranslation();
  const saved = (config.masking?.allow ?? []).join(", ");
  const [text, setText] = useState(saved);
  useEffect(() => {
    setText(saved);
  }, [saved]);
  const save = () => {
    if (text === saved) {
      return;
    }
    const allow = splitValues(text);
    void apply((next) => {
      next.masking = {
        ...next.masking,
        enabled: next.masking?.enabled ?? true,
        allow,
      };
    });
  };
  return (
    <View style={styles.allowRow}>
      <View style={styles.allowMain}>
        <Text style={settingsStyles.rowTitle}>{t("settings.gatewayPages.masking.allowTitle")}</Text>
        <Text style={settingsStyles.rowHint}>{t("settings.gatewayPages.masking.allowHint")}</Text>
      </View>
      <FormTextInput
        initialValue={saved}
        resetKey={saved}
        placeholder={t("settings.gatewayPages.masking.allowPlaceholder")}
        autoCapitalize="none"
        autoCorrect={false}
        onChangeText={setText}
        onBlur={save}
      />
    </View>
  );
}

function KindDot({ kind, ranking }: { kind: string; ranking: readonly { name: string }[] }) {
  const dots = [
    styles.dot0,
    styles.dot1,
    styles.dot2,
    styles.dot3,
    styles.dot4,
    styles.dot5,
    styles.dot6,
  ];
  return <View style={[styles.dot, dots[kindColorIndex(kind, ranking)]]} />;
}

const styles = StyleSheet.create((theme) => ({
  empty: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[4],
  },
  actionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
  },
  actionMain: { flex: 1, gap: 2 },
  actionName: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  actionKind: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  actionHint: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  moreRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
  },
  cardGap: { height: theme.spacing[2] },
  rulesHead: {
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[3],
    paddingBottom: theme.spacing[2],
    gap: 2,
  },
  ruleRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
  },
  ruleFields: { flex: 1, gap: theme.spacing[2] },
  ruleActions: { paddingBottom: theme.spacing[1] },
  allowRow: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    gap: theme.spacing[2],
  },
  allowMain: { gap: 2 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  dot0: { backgroundColor: theme.colors.accent },
  dot1: { backgroundColor: theme.colors.terminal.blue },
  dot2: { backgroundColor: theme.colors.statusWarning },
  dot3: { backgroundColor: theme.colors.terminal.magenta },
  dot4: { backgroundColor: theme.colors.statusSuccess },
  dot5: { backgroundColor: theme.colors.terminal.cyan },
  dot6: { backgroundColor: theme.colors.statusDanger },
}));
