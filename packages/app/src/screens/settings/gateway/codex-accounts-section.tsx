import { ArrowDown, ArrowUp, Trash2 } from "lucide-react-native";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { SessionOutboundMessage } from "@neolix/protocol/messages";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { SettingsAction, SettingsCard, SettingsRow } from "@/components/settings";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { SettingsTextArea } from "@/components/settings-textarea";
import { Button } from "@/components/ui/button";
import { FormTextInput } from "@/components/ui/form-field";
import { Switch } from "@/components/ui/switch";
import { useHostRuntimeClient } from "@/runtime/host-runtime";

type CodexAccountsPayload = Extract<
  SessionOutboundMessage,
  { type: "gateway.codex.accounts.response" }
>["payload"];
type CodexAccount = CodexAccountsPayload["owned"][number];
type SignInState = Extract<
  SessionOutboundMessage,
  { type: "gateway.signin.start.response" }
>["payload"]["state"];

/** What the page keeps of a sign-in under way: its id and what to show. */
interface SignInView {
  id: string;
  url: string;
  code: string;
  paste: boolean;
}

/**
 * ChatGPT accounts under the subscription (myna's account rows,
 * `app.js:13076-13340`): the user's order is the routing order
 * (`provider/account_order.go:5-8`), a switched-off account is kept but not
 * routed (`login/off`), and a removed one is forgotten.
 */
export function CodexAccountsSection({
  serverId,
  embedded = false,
}: {
  serverId: string;
  /** True inside the add-subscription sheet: no section heading of its own. */
  embedded?: boolean;
}) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const [payload, setPayload] = useState<CodexAccountsPayload | null>(null);
  const [signIn, setSignIn] = useState<SignInView | null>(null);
  const [pasted, setPasted] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const header = useMemo<SheetHeader>(
    () => ({ title: t("settings.gatewayPages.providers.codexImport") }),
    [t],
  );

  const refresh = useCallback(() => {
    if (client === null) {
      return;
    }
    void client
      .getGatewayCodexAccounts()
      .then((result) => {
        setPayload(result);
        return undefined;
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      });
  }, [client]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleStarted = useCallback(
    (state: SignInState) => {
      if (state.state === "failed" || state.id.length === 0) {
        setError(state.error ?? t("settings.gatewayPages.providers.signInStartFailed"));
        return;
      }
      setSignIn({
        id: state.id,
        url: state.url ?? "",
        code: state.code ?? "",
        paste: state.pasteCallback === true,
      });
    },
    [t],
  );

  const startSignIn = useCallback(
    (device: boolean) => {
      if (client === null) {
        return;
      }
      setError(null);
      setNotice(null);
      void client
        .startGatewaySignIn(device ? { agent: "codex", site: "device" } : { agent: "codex" })
        .then((result) => {
          handleStarted(result.state);
          return undefined;
        })
        .catch((cause: unknown) => {
          setError(cause instanceof Error ? cause.message : String(cause));
        });
    },
    [client, handleStarted],
  );
  const handleBrowserSignIn = useCallback(() => startSignIn(false), [startSignIn]);
  const handleDeviceSignIn = useCallback(() => startSignIn(true), [startSignIn]);

  const finishSignIn = useCallback(
    (state: SignInState) => {
      if (state.state === "done") {
        setSignIn(null);
        setPasted("");
        refresh();
        return;
      }
      if (state.state === "failed") {
        setError(state.error ?? t("settings.gatewayPages.providers.signInFailed"));
        setSignIn(null);
      }
    },
    [refresh, t],
  );

  const handleCheck = useCallback(() => {
    if (client === null || signIn === null) {
      return;
    }
    setError(null);
    void client
      .getGatewaySignIn(signIn.id)
      .then((result) => {
        finishSignIn(result.state);
        return undefined;
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      });
  }, [client, finishSignIn, signIn]);

  const handlePastedChange = useCallback((text: string) => setPasted(text), []);
  const handlePasteCallback = useCallback(() => {
    if (client === null || signIn === null) {
      return;
    }
    setError(null);
    void client
      .callbackGatewaySignIn(signIn.id, pasted)
      .then((result) => {
        if (!result.ok) {
          setError(result.error ?? t("settings.gatewayPages.providers.signInCallbackFailed"));
          return undefined;
        }
        return client.getGatewaySignIn(signIn.id).then((status) => {
          finishSignIn(status.state);
          return undefined;
        });
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      });
  }, [client, finishSignIn, pasted, signIn, t]);

  const handleCancel = useCallback(() => {
    if (client === null || signIn === null) {
      return;
    }
    void client.cancelGatewaySignIn(signIn.id).catch(() => undefined);
    setSignIn(null);
    setPasted("");
  }, [client, signIn]);

  const handleEnabled = useCallback(
    (id: string, enabled: boolean) => {
      if (client === null) {
        return;
      }
      void client
        .setGatewayCodexAccountEnabled(id, enabled)
        .then(refresh)
        .catch((cause: unknown) => {
          setError(cause instanceof Error ? cause.message : String(cause));
        });
    },
    [client, refresh],
  );

  const handleRemove = useCallback(
    (id: string) => {
      if (client === null) {
        return;
      }
      void client
        .removeGatewayCodexAccount(id)
        .then(refresh)
        .catch((cause: unknown) => {
          setError(cause instanceof Error ? cause.message : String(cause));
        });
    },
    [client, refresh],
  );

  const accounts = useMemo(() => payload?.owned ?? [], [payload]);

  const move = useCallback(
    (id: string, delta: -1 | 1) => {
      if (client === null) {
        return;
      }
      const order = accounts.map((account) => account.id);
      const from = order.indexOf(id);
      const to = from + delta;
      if (from < 0 || to < 0 || to >= order.length) {
        return;
      }
      order.splice(to, 0, ...order.splice(from, 1));
      void client
        .arrangeGatewayCodexAccounts(order)
        .then(refresh)
        .catch((cause: unknown) => {
          setError(cause instanceof Error ? cause.message : String(cause));
        });
    },
    [accounts, client, refresh],
  );

  const rowActions = useMemo(() => {
    const handlers = new Map<
      string,
      { up: () => void; down: () => void; off: (enabled: boolean) => void; remove: () => void }
    >();
    for (const account of accounts) {
      if (!handlers.has(account.id)) {
        handlers.set(account.id, {
          up: () => move(account.id, -1),
          down: () => move(account.id, 1),
          off: (enabled: boolean) => handleEnabled(account.id, enabled),
          remove: () => handleRemove(account.id),
        });
      }
    }
    return handlers;
  }, [accounts, handleEnabled, handleRemove, move]);

  const handleImportOpen = useCallback(() => {
    setNotice(null);
    setImportText("");
    setImportOpen(true);
  }, []);
  const handleImportClose = useCallback(() => setImportOpen(false), []);
  const handleImportText = useCallback((text: string) => setImportText(text), []);
  const handleImport = useCallback(() => {
    if (client === null) {
      return;
    }
    setError(null);
    void client
      .importGatewayCodexAccounts({ text: importText })
      .then((result) => {
        setImportOpen(false);
        setNotice(
          t("settings.gatewayPages.providers.codexImportDone", {
            added: result.added,
            updated: result.updated,
            failed: result.failed.length,
          }),
        );
        refresh();
        return undefined;
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      });
  }, [client, importText, refresh, t]);

  const handleImportFromCodex = useCallback(() => {
    if (client === null) {
      return;
    }
    setError(null);
    void client
      .importGatewayCodexAccounts({ fromCodex: true })
      .then((result) => {
        setImportOpen(false);
        setNotice(
          t("settings.gatewayPages.providers.codexImportDone", {
            added: result.added,
            updated: result.updated,
            failed: result.failed.length,
          }),
        );
        refresh();
        return undefined;
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      });
  }, [client, refresh, t]);

  const content = (
    <>
      <SettingsCard>
        {embedded ? null : (
          <SettingsAction
            label={t("settings.gatewayPages.providers.codexSignIn")}
            hint={t("settings.gatewayPages.providers.codexSignInHint")}
            actionLabel={t("settings.gatewayPages.providers.codexSignIn")}
            onPress={handleBrowserSignIn}
            testID="gateway-codex-signin"
          />
        )}
        <SettingsAction
          label={
            embedded
              ? t("settings.gatewayPages.providers.subImportInstead")
              : t("settings.gatewayPages.providers.codexImport")
          }
          hint={t("settings.gatewayPages.providers.codexImportHint")}
          actionLabel={
            embedded
              ? t("settings.gatewayPages.providers.subImportInstead")
              : t("settings.gatewayPages.providers.codexImport")
          }
          onPress={handleImportOpen}
          testID="gateway-codex-import"
        />
        {accounts.map((account) => (
          <CodexAccountRow
            key={account.id}
            account={account}
            first={account.id === accounts[0]?.id}
            last={account.id === accounts[accounts.length - 1]?.id}
            actions={rowActions.get(account.id)}
          />
        ))}
        {accounts.length === 0 && payload !== null ? (
          <Text style={styles.empty}>{t("settings.gatewayPages.providers.codexNoAccounts")}</Text>
        ) : null}
      </SettingsCard>

      {signIn === null ? null : (
        <SettingsCard>
          <View style={styles.signIn}>
            <Text style={styles.url}>{signIn.url}</Text>
            {signIn.code.length > 0 ? <Text style={styles.code}>{signIn.code}</Text> : null}
            {signIn.code.length > 0 ? (
              <Button
                variant="outline"
                size="sm"
                onPress={handleCheck}
                testID="gateway-codex-check"
              >
                {t("settings.gatewayPages.providers.codexCheck")}
              </Button>
            ) : (
              <>
                <Text style={styles.hint}>
                  {t("settings.gatewayPages.providers.codexPasteHint")}
                </Text>
                <FormTextInput
                  size="sm"
                  initialValue=""
                  onChangeText={handlePastedChange}
                  placeholder={t("settings.gatewayPages.providers.codexPastePlaceholder")}
                  accessibilityLabel={t("settings.gatewayPages.providers.codexPastePlaceholder")}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                <Button
                  variant="outline"
                  size="sm"
                  onPress={handlePasteCallback}
                  disabled={pasted.trim().length === 0}
                  testID="gateway-codex-finish"
                >
                  {t("settings.gatewayPages.providers.codexFinish")}
                </Button>
              </>
            )}
            <View style={styles.signInActions}>
              <Button variant="ghost" size="sm" onPress={handleCancel}>
                {t("settings.gatewayPages.providers.codexCancel")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onPress={signIn.code.length > 0 ? handleBrowserSignIn : handleDeviceSignIn}
              >
                {signIn.code.length > 0
                  ? t("settings.gatewayPages.providers.codexUseBrowser")
                  : t("settings.gatewayPages.providers.codexUseDevice")}
              </Button>
            </View>
          </View>
        </SettingsCard>
      )}

      {notice === null ? null : <Text style={styles.notice}>{notice}</Text>}
      {error === null ? null : (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      )}

      {importOpen ? (
        <AdaptiveModalSheet
          header={header}
          visible={importOpen}
          onClose={handleImportClose}
          testID="gateway-codex-import-sheet"
        >
          <Text style={styles.hint}>{t("settings.gatewayPages.providers.codexImportBody")}</Text>
          <SettingsTextArea
            accessibilityLabel={t("settings.gatewayPages.providers.codexImport")}
            value={importText}
            onChangeText={handleImportText}
            placeholder={t("settings.gatewayPages.providers.codexImportPlaceholder")}
          />
          <Button variant="ghost" size="sm" onPress={handleImportFromCodex}>
            {t("settings.gatewayPages.providers.codexImportOwn")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onPress={handleImport}
            disabled={importText.trim().length === 0}
          >
            {t("settings.gatewayPages.providers.codexImportAction")}
          </Button>
        </AdaptiveModalSheet>
      ) : null}
    </>
  );
  if (embedded) {
    return content;
  }
  return (
    <SettingsSection title={t("settings.gatewayPages.providers.codexAccounts")}>
      {content}
    </SettingsSection>
  );
}

interface RowActions {
  up: () => void;
  down: () => void;
  off: (enabled: boolean) => void;
  remove: () => void;
}

function CodexAccountRow({
  account,
  first,
  last,
  actions,
}: {
  account: CodexAccount;
  first: boolean;
  last: boolean;
  actions: RowActions | undefined;
}) {
  const { t } = useTranslation();
  const handleOff = useCallback((enabled: boolean) => actions?.off(enabled), [actions]);
  return (
    <SettingsRow
      label={account.label}
      hint={
        account.disabled === true
          ? t("settings.gatewayPages.providers.codexOffHint")
          : (account.plan ?? undefined)
      }
    >
      <View style={styles.rowTools}>
        <Switch
          value={account.disabled !== true}
          onValueChange={handleOff}
          accessibilityLabel={t("settings.gatewayPages.providers.codexEnabled")}
        />
        <Button
          variant="ghost"
          size="sm"
          leftIcon={ArrowUp}
          disabled={first}
          onPress={actions?.up}
          accessibilityLabel={t("settings.gatewayPages.providers.codexMoveUp")}
        />
        <Button
          variant="ghost"
          size="sm"
          leftIcon={ArrowDown}
          disabled={last}
          onPress={actions?.down}
          accessibilityLabel={t("settings.gatewayPages.providers.codexMoveDown")}
        />
        <Button
          variant="ghost"
          size="sm"
          leftIcon={Trash2}
          onPress={actions?.remove}
          accessibilityLabel={t("settings.gatewayPages.providers.codexRemove")}
        />
      </View>
    </SettingsRow>
  );
}

const styles = StyleSheet.create((theme) => ({
  empty: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
  },
  signIn: {
    gap: theme.spacing[2],
    padding: theme.spacing[4],
  },
  signInActions: {
    flexDirection: "row",
    gap: theme.spacing[2],
  },
  url: {
    color: theme.colors.accent,
    fontSize: theme.fontSize.sm,
  },
  code: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.lg,
    letterSpacing: 2,
  },
  hint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  notice: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    paddingHorizontal: theme.spacing[4],
  },
  error: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
    paddingHorizontal: theme.spacing[4],
  },
  rowTools: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
}));
