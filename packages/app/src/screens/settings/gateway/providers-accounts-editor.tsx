/* eslint-disable react/no-array-index-key -- these rows are positional; an account's id is edited in place, so keying by it would remount the card and drop focus on every keystroke. */
import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { ChevronRight, Trash2 } from "lucide-react-native";
import type { GatewayAccountWire } from "@neolix/protocol/gateway";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { PressHighlight } from "@/components/ui/press-highlight";
import { Switch } from "@/components/ui/switch";
import { useActiveHostBuiltinFeatures } from "@/plugins/builtin-features";
import type { Theme } from "@/styles/theme";

const ThemedChevron = withUnistyles(ChevronRight);

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

type AccountTextField = "id" | "label" | "apiKey" | "baseUrl" | "configDir" | "proxy" | "usageUrl";
type AccountNumberField =
  | "priority"
  | "weight"
  | "maxConcurrency"
  | "maxRpm"
  | "monthlyUsd"
  | "usageIntervalMs";

export interface AccountsEditorProps {
  accounts: GatewayAccountWire[];
  onChange: (accounts: GatewayAccountWire[]) => void;
}

function nextAccountId(accounts: readonly GatewayAccountWire[]): string {
  const taken = new Set(accounts.map((account) => account.id));
  let index = accounts.length + 1;
  while (taken.has(`account-${index}`)) {
    index += 1;
  }
  return `account-${index}`;
}

function textOf(value: number | undefined): string {
  return value === undefined ? "" : String(value);
}

function parseNumber(text: string): number | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function keyboardTypeFor(field: AccountTextField, numeric: boolean): "numeric" | "url" | "default" {
  if (numeric) {
    return "numeric";
  }
  if (field === "baseUrl" || field === "usageUrl" || field === "proxy") {
    return "url";
  }
  return "default";
}

interface AccountTextFieldProps {
  field: AccountTextField;
  label: string;
  value: string | undefined;
  hint?: string;
  secure?: boolean;
  numeric?: boolean;
  onText: (field: AccountTextField, text: string) => void;
}

function AccountTextField({
  field,
  label,
  value,
  hint,
  secure,
  numeric,
  onText,
}: AccountTextFieldProps) {
  const { t } = useTranslation();
  const handleChange = useCallback((text: string) => onText(field, text), [field, onText]);
  return (
    <Field label={label} hint={hint}>
      <FormTextInput
        initialValue={value ?? ""}
        onChangeText={handleChange}
        placeholder={secure ? t("settings.gatewayPages.providers.apiKeyPlaceholder") : undefined}
        secureTextEntry={secure}
        keyboardType={keyboardTypeFor(field, numeric === true)}
        autoCapitalize="none"
        autoCorrect={false}
        accessibilityLabel={label}
      />
    </Field>
  );
}

interface AccountNumberFieldProps {
  field: AccountNumberField;
  label: string;
  value: number | undefined;
  onNumber: (field: AccountNumberField, text: string) => void;
}

function AccountNumberField({ field, label, value, onNumber }: AccountNumberFieldProps) {
  const handleChange = useCallback((text: string) => onNumber(field, text), [field, onNumber]);
  return (
    <View style={styles.numberCell}>
      <Field label={label}>
        <FormTextInput
          initialValue={textOf(value)}
          onChangeText={handleChange}
          keyboardType="numeric"
          accessibilityLabel={label}
        />
      </Field>
    </View>
  );
}

interface AccountQuotaFieldProps {
  field: "tokens5h" | "tokens7d";
  label: string;
  value: number | undefined;
  onQuota: (field: "tokens5h" | "tokens7d", text: string) => void;
}

function AccountQuotaField({ field, label, value, onQuota }: AccountQuotaFieldProps) {
  const handleChange = useCallback((text: string) => onQuota(field, text), [field, onQuota]);
  return (
    <View style={styles.numberCell}>
      <Field label={label}>
        <FormTextInput
          initialValue={textOf(value)}
          onChangeText={handleChange}
          keyboardType="numeric"
          accessibilityLabel={label}
        />
      </Field>
    </View>
  );
}

interface AccountCardProps {
  account: GatewayAccountWire;
  index: number;
  onUpdate: (index: number, mutate: (account: GatewayAccountWire) => void) => void;
  onRemove: (index: number) => void;
}

function AccountCard({ account, index, onUpdate, onRemove }: AccountCardProps) {
  const { t } = useTranslation();
  const { isEnabled } = useActiveHostBuiltinFeatures();
  const rotationOn = isEnabled("rotation");
  const budgetOn = isEnabled("budget");
  const [expanded, setExpanded] = useState(false);
  const handleToggleExpanded = useCallback(() => setExpanded((open) => !open), []);
  const accessibilityState = useMemo(() => ({ expanded }), [expanded]);
  const handleRemove = useCallback(() => onRemove(index), [index, onRemove]);
  const handleEnabled = useCallback(
    (value: boolean) => onUpdate(index, (next) => void (next.enabled = value)),
    [index, onUpdate],
  );
  const setText = useCallback(
    (field: AccountTextField, text: string) => {
      onUpdate(index, (next) => {
        if (field === "id") {
          next.id = text;
        } else {
          next[field] = text.length > 0 ? text : undefined;
        }
      });
    },
    [index, onUpdate],
  );
  const setNumber = useCallback(
    (field: AccountNumberField, text: string) => {
      onUpdate(index, (next) => {
        next[field] = parseNumber(text);
      });
    },
    [index, onUpdate],
  );
  const handleModels = useCallback(
    (text: string) => {
      onUpdate(index, (next) => {
        const models = text
          .split(",")
          .map((model) => model.trim())
          .filter(Boolean);
        next.models = models.length > 0 ? models : undefined;
      });
    },
    [index, onUpdate],
  );
  const handleClaudeCode = useCallback(
    (value: boolean) =>
      onUpdate(index, (next) => {
        next.agent = value ? "claude-code" : undefined;
      }),
    [index, onUpdate],
  );
  const handleWarmup = useCallback(
    (value: boolean) => onUpdate(index, (next) => void (next.warmup = value)),
    [index, onUpdate],
  );
  const setQuotaValue = useCallback(
    (field: "tokens5h" | "tokens7d", text: string) => setQuota(onUpdate, index, field, text),
    [index, onUpdate],
  );
  const label = t("settings.gatewayPages.providers.accountEnabled");

  return (
    <View style={styles.accountCard}>
      <PressHighlight
        style={styles.accountHead}
        onPress={handleToggleExpanded}
        accessibilityRole="button"
        accessibilityState={accessibilityState}
        accessibilityLabel={account.label ?? account.id}
      >
        <View style={expanded ? styles.chevronOpen : undefined}>
          <ThemedChevron size={12} uniProps={mutedColorMapping} />
        </View>
        <Text style={styles.accountName} numberOfLines={1}>
          {account.label ?? account.id}
        </Text>
        <View style={styles.accountHeadTrailing}>
          <Switch
            value={account.enabled !== false}
            onValueChange={handleEnabled}
            accessibilityLabel={label}
          />
        </View>
      </PressHighlight>

      <View style={styles.agentRow}>
        <Text style={styles.agentLabel}>
          {t("settings.gatewayPages.providers.claudeCodeAccount")}
        </Text>
        <Switch
          value={account.agent === "claude-code"}
          onValueChange={handleClaudeCode}
          accessibilityLabel={t("settings.gatewayPages.providers.claudeCodeAccount")}
        />
      </View>

      {account.agent === "claude-code" ? (
        <AccountTextField
          field="configDir"
          label={t("settings.gatewayPages.providers.configDir")}
          value={account.configDir}
          hint={t("settings.gatewayPages.providers.claudeCodeAccountHint")}
          onText={setText}
        />
      ) : (
        <AccountTextField
          field="apiKey"
          label={t("settings.gatewayPages.providers.apiKey")}
          value={account.apiKey}
          secure
          onText={setText}
        />
      )}

      {expanded ? (
        <View style={styles.accountDetails}>
          <AccountTextField
            field="id"
            label={t("settings.gatewayPages.providers.accountId")}
            value={account.id}
            onText={setText}
          />
          <AccountTextField
            field="label"
            label={t("settings.gatewayPages.providers.accountLabel")}
            value={account.label}
            onText={setText}
          />
          <AccountTextField
            field="baseUrl"
            label={t("settings.gatewayPages.providers.accountBaseUrl")}
            value={account.baseUrl}
            hint={t("settings.gatewayPages.providers.baseUrlPlaceholder")}
            onText={setText}
          />
          <View style={styles.numberGrid}>
            {rotationOn ? (
              <>
                <AccountNumberField
                  field="priority"
                  label={t("settings.gatewayPages.providers.priority")}
                  value={account.priority}
                  onNumber={setNumber}
                />
                <AccountNumberField
                  field="weight"
                  label={t("settings.gatewayPages.providers.weight")}
                  value={account.weight}
                  onNumber={setNumber}
                />
              </>
            ) : null}
            <AccountNumberField
              field="maxConcurrency"
              label={t("settings.gatewayPages.providers.maxConcurrency")}
              value={account.maxConcurrency}
              onNumber={setNumber}
            />
            <AccountNumberField
              field="maxRpm"
              label={t("settings.gatewayPages.providers.maxRpm")}
              value={account.maxRpm}
              onNumber={setNumber}
            />
            {budgetOn ? (
              <AccountNumberField
                field="monthlyUsd"
                label={t("settings.gatewayPages.providers.accountMonthlyUsd")}
                value={account.monthlyUsd}
                onNumber={setNumber}
              />
            ) : null}
            <AccountQuotaField
              field="tokens5h"
              label={t("settings.gatewayPages.providers.quota5h")}
              value={account.quota?.tokens5h}
              onQuota={setQuotaValue}
            />
            <AccountQuotaField
              field="tokens7d"
              label={t("settings.gatewayPages.providers.quota7d")}
              value={account.quota?.tokens7d}
              onQuota={setQuotaValue}
            />
          </View>
          <Field
            label={t("settings.gatewayPages.providers.accountModels")}
            hint={t("settings.gatewayPages.providers.accountModelsHint")}
          >
            <FormTextInput
              initialValue={(account.models ?? []).join(", ")}
              onChangeText={handleModels}
              autoCapitalize="none"
              autoCorrect={false}
              accessibilityLabel={t("settings.gatewayPages.providers.accountModels")}
            />
          </Field>
          <AccountTextField
            field="usageUrl"
            label={t("settings.gatewayPages.providers.usageUrl")}
            value={account.usageUrl}
            hint={t("settings.gatewayPages.providers.usageUrlHint")}
            onText={setText}
          />
          <AccountTextField
            field="proxy"
            label={t("settings.gatewayPages.providers.proxy")}
            value={account.proxy}
            onText={setText}
          />
          <View style={styles.inlineRow}>
            <Text style={styles.inlineLabel}>{t("settings.gatewayPages.providers.warmup")}</Text>
            <Switch
              value={account.warmup === true}
              onValueChange={handleWarmup}
              accessibilityLabel={t("settings.gatewayPages.providers.warmup")}
            />
          </View>
          <Text style={styles.hint}>{t("settings.gatewayPages.providers.warmupHint")}</Text>
          <View style={styles.removeRow}>
            <Button
              variant="ghost"
              size="sm"
              leftIcon={Trash2}
              onPress={handleRemove}
              textStyle={styles.dangerText}
            >
              {t("settings.gatewayPages.providers.removeAccount")}
            </Button>
          </View>
        </View>
      ) : null}
    </View>
  );
}

function setQuota(
  onUpdate: AccountCardProps["onUpdate"],
  index: number,
  field: "tokens5h" | "tokens7d",
  text: string,
): void {
  onUpdate(index, (next) => {
    const quota = { ...next.quota };
    quota[field] = parseNumber(text);
    next.quota = quota.tokens5h === undefined && quota.tokens7d === undefined ? undefined : quota;
  });
}

export function AccountsEditor({ accounts, onChange }: AccountsEditorProps) {
  const { t } = useTranslation();
  const handleUpdate = useCallback(
    (index: number, mutate: (account: GatewayAccountWire) => void) => {
      const next = accounts.map((account) => Object.assign({}, account));
      const target = next[index];
      if (target === undefined) {
        return;
      }
      mutate(target);
      onChange(next);
    },
    [accounts, onChange],
  );
  const handleRemove = useCallback(
    (index: number) => {
      onChange(accounts.filter((_, position) => position !== index));
    },
    [accounts, onChange],
  );
  const handleAdd = useCallback(() => {
    onChange([...accounts, { id: nextAccountId(accounts), enabled: true }]);
  }, [accounts, onChange]);

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <Text style={styles.sectionLabel}>{t("settings.gatewayPages.providers.accounts")}</Text>
        <Button variant="ghost" size="sm" onPress={handleAdd}>
          {t("settings.gatewayPages.providers.addAccount")}
        </Button>
      </View>
      {accounts.map((account, index) => (
        <AccountCard
          key={index}
          account={account}
          index={index}
          onUpdate={handleUpdate}
          onRemove={handleRemove}
        />
      ))}
      <Text style={styles.hint}>{t("settings.gatewayPages.providers.accountsHint")}</Text>
    </View>
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
  accountCard: {
    gap: theme.spacing[3],
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface2,
  },
  accountHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  accountHeadTrailing: {
    marginLeft: "auto",
  },
  agentRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  agentLabel: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    flexShrink: 1,
  },
  accountName: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    flexShrink: 1,
  },
  chevronOpen: {
    transform: [{ rotate: "90deg" }],
  },
  accountDetails: {
    gap: theme.spacing[3],
  },
  numberGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[3],
  },
  numberCell: {
    flexGrow: 1,
    flexBasis: 150,
    minWidth: 0,
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
  removeRow: {
    alignItems: "flex-start",
  },
  dangerText: {
    color: theme.colors.statusDanger,
  },
  hint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
