import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { SessionOutboundMessage } from "@neolix/protocol/messages";
import { Button } from "@/components/ui/button";
import { FormTextInput } from "@/components/ui/form-field";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { PressHighlight } from "@/components/ui/press-highlight";
import { settingsStyles } from "@/styles/settings";
import type { Theme } from "@/styles/theme";
import { useProviderIcons, type ProviderIconComponent } from "@/components/provider-icons";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useFilePicker } from "@/hooks/use-file-picker";
import { confirmDialog } from "@/utils/confirm-dialog";
import { openExternalUrl } from "@/utils/open-external-url";
import { CodexAccountsSection } from "./codex-accounts-section";
import { PluginSubscriptionsCard } from "./plugin-subscriptions-card";

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner, (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
}));

/**
 * Subscriptions: a plan the user already pays for, signed in the way myna
 * does it (`internal/gui/assets/app.js:12129`, the `SUBS` list, and its
 * sign-in sheet). Neolix's built-in agents are the four whose sign-in the
 * daemon runs itself; myna's other built-ins are its community plugins'.
 */

type SignInState = Extract<
  SessionOutboundMessage,
  { type: "gateway.signin.start.response" }
>["payload"]["state"];

type ImportResult = Extract<
  SessionOutboundMessage,
  { type: "gateway.subscription.import.response" }
>["payload"]["results"][number];

/** A result with the key the list shows it under. */
interface ShownImportResult extends ImportResult {
  key: string;
}

/** One export file, read as text, as myna's import takes them. */
interface ImportFile {
  name: string;
  text: string;
}

/** myna's limit on one export (`app.js` runImport's file input: 4 MiB). */
const IMPORT_FILE_LIMIT = 4 * 1024 * 1024;

/** myna's `importStatus` (`app.js:13482`). */
const IMPORT_STATUS_KEYS = {
  added: "subImportAdded",
  updated: "subImportUpdated",
  exists: "subImportExists",
  failed: "subImportFailed",
} as const;

/** A result's account, or the file it was in when the file held none (`app.js:13496`). */
function importResultName(result: ImportResult, names: readonly string[]): string {
  if (result.user !== "") {
    return result.user;
  }
  const file = result.file;
  return file === undefined ? "" : (names[file - 1] ?? "");
}

interface Subscription {
  agent: "codex" | "chatgpt-api" | "copilot" | "gemini" | "antigravity" | "factory";
  name: string;
  icon: string;
  plansKey: string;
  hintKey?: string;
  /** Accounts the vendor may suspend: said before the first one is added. */
  risky?: boolean;
  riskKey?: string;
  /** The account may be on an enterprise's own GitHub host. */
  host?: boolean;
  /** Codex's own ChatGPT sign-in: a browser, or a code, and imported accounts. */
  codex?: boolean;
  /** Another tool's export can be brought in, as myna's `sub.importable`. */
  importable?: boolean;
  /** Added by an API key instead of a browser sign-in. */
  keyAgent?: boolean;
}

const SUBSCRIPTIONS: readonly Subscription[] = [
  {
    agent: "codex",
    name: "ChatGPT",
    icon: "codex",
    plansKey: "subPlansCodex",
    hintKey: "subHintCodex",
    codex: true,
  },
  {
    agent: "chatgpt-api",
    name: "ChatGPT API",
    icon: "codex",
    plansKey: "subPlansChatGPTApi",
    hintKey: "subHintChatGPTApi",
  },
  {
    agent: "copilot",
    name: "Copilot",
    icon: "copilot",
    plansKey: "subPlansCopilot",
    host: true,
  },
  {
    agent: "gemini",
    name: "Gemini CLI",
    icon: "gemini",
    plansKey: "subPlansGemini",
    hintKey: "subHintGemini",
  },
  {
    agent: "antigravity",
    name: "Antigravity",
    icon: "antigravity",
    plansKey: "subPlansAntigravity",
    risky: true,
    riskKey: "subRiskAntigravity",
    importable: true,
  },
  {
    agent: "factory",
    name: "Factory",
    icon: "factory-droid",
    plansKey: "subPlansFactory",
    hintKey: "subHintFactory",
    keyAgent: true,
  },
];

const foregroundColorMapping = (theme: { colors: { foreground: string } }) => ({
  color: theme.colors.foreground,
});

function SubscriptionIcon({ Icon }: { Icon: ProviderIconComponent }) {
  const Themed = useMemo(() => withUnistyles(Icon), [Icon]);
  return <Themed size={18} uniProps={foregroundColorMapping} />;
}

type Screen =
  | { kind: "list" }
  | { kind: "codex"; subscription: Subscription }
  | { kind: "risk"; subscription: Subscription }
  | { kind: "host"; subscription: Subscription }
  | { kind: "factory"; subscription: Subscription; busy: boolean; error?: string }
  | {
      kind: "factoryAdded";
      subscription: Subscription;
      user: string;
      region?: string;
      orgId?: string;
    }
  | { kind: "running"; subscription: Subscription; state: SignInState }
  | { kind: "failed"; subscription: Subscription; message: string; site?: string }
  | {
      kind: "import";
      subscription: Subscription;
      files: ImportFile[];
      text: string;
      error?: string;
    }
  | { kind: "importing"; subscription: Subscription }
  | {
      kind: "imported";
      subscription: Subscription;
      names: string[];
      results: ShownImportResult[];
    };

export interface SubscriptionsSectionProps {
  serverId: string | null;
  /** Called when the user is done; the host sheet closes. */
  onClose: () => void;
}

function SubscriptionRow({
  subscription,
  serverId,
  onPick,
}: {
  subscription: Subscription;
  serverId: string | null;
  onPick: (subscription: Subscription) => void;
}) {
  const { t } = useTranslation();
  const icons = useProviderIcons(serverId);
  const handlePress = useCallback(() => onPick(subscription), [onPick, subscription]);
  return (
    <PressHighlight
      style={styles.row}
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityLabel={subscription.name}
      testID={`gateway-subscription-${subscription.agent}`}
    >
      <SubscriptionIcon Icon={icons(subscription.icon)} />
      <View style={styles.rowContent}>
        <View style={styles.nameRow}>
          <Text style={styles.name}>{subscription.name}</Text>
          <Text style={styles.note}>
            {t(`settings.gatewayPages.providers.${subscription.plansKey}`)}
          </Text>
        </View>
        {subscription.hintKey === undefined ? null : (
          <Text style={styles.sub}>
            {t(`settings.gatewayPages.providers.${subscription.hintKey}`)}
          </Text>
        )}
      </View>
      <Text style={styles.signIn}>{t("settings.gatewayPages.providers.subscribe")}</Text>
    </PressHighlight>
  );
}

type SubscriptionAccountRow = Extract<
  SessionOutboundMessage,
  { type: "gateway.subscription.list.response" }
>["payload"]["accounts"][number];

/**
 * The Antigravity accounts Neolix keeps, with myna's import row last
 * (`app.js:13355`): another tool's export brings accounts in from its file.
 */
function AntigravityAccounts({
  serverId,
  onImport,
}: {
  serverId: string | null;
  onImport: () => void;
}) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId ?? "");
  const listed = useHostFeature(serverId, "gatewaySubscriptionAccounts");
  const [accounts, setAccounts] = useState<readonly SubscriptionAccountRow[] | null>(null);
  useEffect(() => {
    if (client === null || !listed) {
      setAccounts([]);
      return;
    }
    let stopped = false;
    void client
      .listGatewaySubscriptionAccounts({ agent: "antigravity" })
      .then((payload) => {
        if (!stopped) {
          setAccounts(payload.accounts);
        }
        return undefined;
      })
      .catch(() => {
        if (!stopped) {
          setAccounts([]);
        }
      });
    return () => {
      stopped = true;
    };
  }, [client, listed]);
  const handlePress = useCallback(() => onImport(), [onImport]);
  return (
    <View style={styles.accountList}>
      {(accounts ?? []).map((account) => (
        <View key={account.id} style={styles.accountRow}>
          <Text style={styles.name}>
            {account.alias === undefined || account.alias === ""
              ? account.user
              : `${account.alias} · ${account.user}`}
          </Text>
          {account.project === undefined ? null : (
            <Text style={styles.sub}>
              {t("settings.gatewayPages.providers.subAccountProject", {
                project: account.project,
              })}
            </Text>
          )}
          {account.lapsed === null ? null : <Text style={styles.error}>{account.lapsed}</Text>}
        </View>
      ))}
      <PressHighlight
        style={styles.accountRow}
        onPress={handlePress}
        accessibilityRole="button"
        accessibilityLabel={t("settings.gatewayPages.providers.subImportRow")}
        testID="gateway-subscription-import-row"
      >
        <Text style={styles.signIn}>{t("settings.gatewayPages.providers.subImportRow")}</Text>
      </PressHighlight>
    </View>
  );
}

/**
 * The accounts a subscription already keeps, as myna's `renderAccounts`
 * lists them: the first is the one the gateway serves, another can be made
 * first (Use) or forgotten (Remove). Removal only forgets Neolix's copy; the
 * vendor account itself is untouched.
 */
function SavedAccounts({ serverId, agent }: { serverId: string | null; agent: string }) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId ?? "");
  const listed = useHostFeature(serverId, "gatewaySubscriptionAccounts");
  const [accounts, setAccounts] = useState<readonly SubscriptionAccountRow[] | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (client === null || !listed) {
      return;
    }
    let stopped = false;
    void client
      .listGatewaySubscriptionAccounts({ agent })
      .then((payload) => {
        if (!stopped) {
          setAccounts(payload.accounts);
        }
        return undefined;
      })
      .catch(() => {
        if (!stopped) {
          setAccounts([]);
        }
      });
    return () => {
      stopped = true;
    };
  }, [client, listed, agent, version]);

  const reload = useCallback(() => setVersion((value) => value + 1), []);

  const activateAccount = useCallback(
    async (user: string) => {
      if (client === null) {
        return;
      }
      setBusy(user);
      setError(null);
      try {
        const result = await client.switchGatewaySubscriptionAccount({ agent, user });
        if (!result.ok) {
          setError(result.error ?? t("settings.gatewayPages.providers.subAccountsSwitchFailed"));
          return;
        }
        reload();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setBusy("");
      }
    },
    [agent, client, reload, t],
  );

  const removeAccount = useCallback(
    async (user: string) => {
      if (client === null) {
        return;
      }
      const confirmed = await confirmDialog({
        title: t("settings.gatewayPages.providers.subAccountsRemoveTitle"),
        message: t("settings.gatewayPages.providers.subAccountsRemoveMessage", { name: user }),
        confirmLabel: t("settings.gatewayPages.providers.subAccountsRemove"),
        cancelLabel: t("common.actions.cancel"),
        destructive: true,
      });
      if (!confirmed) {
        return;
      }
      setBusy(user);
      setError(null);
      try {
        const result = await client.removeGatewaySubscriptionAccount({ agent, user });
        if (!result.ok) {
          setError(t("settings.gatewayPages.providers.subAccountsRemoveFailed"));
          return;
        }
        reload();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setBusy("");
      }
    },
    [agent, client, reload, t],
  );

  const rowActions = useMemo(
    () =>
      (accounts ?? []).map((account) => ({
        use: () => {
          void activateAccount(account.user);
        },
        remove: () => {
          void removeAccount(account.user);
        },
      })),
    [accounts, activateAccount, removeAccount],
  );

  if (accounts === null || accounts.length === 0) {
    return null;
  }
  return (
    <View style={styles.accountList}>
      {accounts.map((account, index) => (
        <View key={account.id} style={styles.accountRow}>
          <Text style={styles.name}>
            {account.alias === undefined || account.alias === ""
              ? account.user
              : `${account.alias} · ${account.user}`}
          </Text>
          {account.plan === null ? null : <Text style={styles.sub}>{account.plan}</Text>}
          {account.region === undefined ? null : (
            <Text style={styles.sub}>
              {t("settings.gatewayPages.providers.subFactoryRegion", { region: account.region })}
            </Text>
          )}
          {account.orgId === undefined ? null : (
            <Text style={styles.sub}>
              {t("settings.gatewayPages.providers.subFactoryOrg", { org: account.orgId })}
            </Text>
          )}
          {account.lapsed === null ? null : <Text style={styles.error}>{account.lapsed}</Text>}
          {index === 0 ? (
            <Text style={styles.sub}>{t("settings.gatewayPages.providers.subAccountsInUse")}</Text>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy !== ""}
              onPress={rowActions[index]?.use}
              testID={`gateway-subscription-use-${agent}-${account.id}`}
            >
              {t("settings.gatewayPages.providers.subAccountsUse")}
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            disabled={busy !== ""}
            onPress={rowActions[index]?.remove}
            testID={`gateway-subscription-remove-${agent}-${account.id}`}
          >
            {t("settings.gatewayPages.providers.subAccountsRemove")}
          </Button>
        </View>
      ))}
      {error === null ? null : <Text style={styles.error}>{error}</Text>}
    </View>
  );
}

/** The subscriptions themselves, each with the accounts it already keeps. */
function SubscriptionList({
  serverId,
  onPick,
}: {
  serverId: string | null;
  onPick: (subscription: Subscription) => void;
}) {
  return (
    <>
      {SUBSCRIPTIONS.map((subscription, index) => (
        <View key={subscription.agent} style={index > 0 ? styles.rowBorder : undefined}>
          <SubscriptionRow subscription={subscription} serverId={serverId} onPick={onPick} />
          {subscription.agent === "codex" ? null : (
            <SavedAccounts serverId={serverId} agent={subscription.agent} />
          )}
        </View>
      ))}
    </>
  );
}

type FactoryScreen = Extract<Screen, { kind: "factory" } | { kind: "factoryAdded" }>;

/** Factory's key form and the account `whoami` named after it was kept. */
function FactoryPanel({
  screen,
  factoryKey,
  onChangeKey,
  onCancel,
  onAdd,
  onAddAnother,
  onDone,
}: {
  screen: FactoryScreen;
  factoryKey: string;
  onChangeKey: (value: string) => void;
  onCancel: () => void;
  onAdd: () => void;
  onAddAnother: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  if (screen.kind === "factoryAdded") {
    return (
      <>
        <Text style={styles.sub}>{screen.user}</Text>
        {screen.orgId === undefined ? null : (
          <Text style={styles.sub}>
            {t("settings.gatewayPages.providers.subFactoryOrg", { org: screen.orgId })}
          </Text>
        )}
        {screen.region === undefined ? null : (
          <Text style={styles.sub}>
            {t("settings.gatewayPages.providers.subFactoryRegion", { region: screen.region })}
          </Text>
        )}
        <View style={styles.acts}>
          <Button size="sm" onPress={onDone}>
            {t("settings.gatewayPages.providers.subFactoryDone")}
          </Button>
          <Button variant="ghost" size="sm" onPress={onAddAnother}>
            {t("settings.gatewayPages.providers.subFactoryMore")}
          </Button>
        </View>
      </>
    );
  }
  return (
    <>
      <Text style={styles.sub}>{t("settings.gatewayPages.providers.subFactoryIntro")}</Text>
      <FormTextInput
        size="sm"
        initialValue={factoryKey}
        onChangeText={onChangeKey}
        placeholder={t("settings.gatewayPages.providers.subFactoryPlaceholder")}
        accessibilityLabel={t("settings.gatewayPages.providers.subFactoryKeyLabel")}
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry
        testID="gateway-subscription-factory-key"
      />
      {screen.error === undefined ? null : <Text style={styles.error}>{screen.error}</Text>}
      <View style={styles.acts}>
        <Button variant="ghost" size="sm" onPress={onCancel}>
          {t("settings.gatewayPages.providers.subCancel")}
        </Button>
        <Button size="sm" disabled={screen.busy || factoryKey.trim() === ""} onPress={onAdd}>
          {t("settings.gatewayPages.providers.subFactoryAdd")}
        </Button>
      </View>
    </>
  );
}

/** The warning before an account the vendor may suspend, and the way past it. */
function RiskPanel({
  subscription,
  serverId,
  onCancel,
  onImport,
  onSignIn,
}: {
  subscription: Subscription;
  serverId: string | null;
  onCancel: () => void;
  onImport: () => void;
  onSignIn: () => void;
}) {
  const { t } = useTranslation();
  const importable = subscription.importable === true;
  return (
    <>
      <Text style={styles.sub}>
        {t(`settings.gatewayPages.providers.${subscription.riskKey ?? "subRiskTitle"}`, {
          name: subscription.name,
        })}
      </Text>
      {importable ? <AntigravityAccounts serverId={serverId} onImport={onImport} /> : null}
      <View style={styles.acts}>
        <Button variant="ghost" size="sm" onPress={onCancel}>
          {t("settings.gatewayPages.providers.subCancel")}
        </Button>
        {importable ? (
          <Button variant="ghost" size="sm" onPress={onImport}>
            {t("settings.gatewayPages.providers.subImportInstead")}
          </Button>
        ) : null}
        <Button size="sm" onPress={onSignIn}>
          {t("settings.gatewayPages.providers.subSignInAnyway")}
        </Button>
      </View>
    </>
  );
}

export function SubscriptionsSection({ serverId, onClose }: SubscriptionsSectionProps) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId ?? "");
  const canSignIn = useHostFeature(serverId, "gatewaySignin");
  const [screen, setScreen] = useState<Screen>({ kind: "list" });
  const [host, setHost] = useState("");
  const [factoryKey, setFactoryKey] = useState("");
  const [callback, setCallback] = useState("");
  const [callbackError, setCallbackError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const screenRef = useRef(screen);
  screenRef.current = screen;

  const start = useCallback(
    async (subscription: Subscription, site?: string) => {
      setCallback("");
      setCallbackError(null);
      setScreen({
        kind: "running",
        subscription,
        state: { id: "", agent: subscription.agent, state: "waiting" },
      });
      if (client === null) {
        setScreen({
          kind: "failed",
          subscription,
          message: t("settings.gatewayPages.providers.subFailed"),
          ...(site === undefined ? {} : { site }),
        });
        return;
      }
      try {
        const result = await client.startGatewaySignIn({
          agent: subscription.agent,
          ...(site === undefined || site === "" ? {} : { site }),
        });
        setScreen({ kind: "running", subscription, state: result.state });
      } catch (error) {
        setScreen({
          kind: "failed",
          subscription,
          message: error instanceof Error ? error.message : String(error),
          ...(site === undefined ? {} : { site }),
        });
      }
    },
    [client, t],
  );

  const pick = useCallback(
    (subscription: Subscription) => {
      setHost("");
      if (subscription.codex === true) {
        setScreen({ kind: "codex", subscription });
        return;
      }
      if (subscription.risky === true) {
        setScreen({ kind: "risk", subscription });
        return;
      }
      if (subscription.host === true) {
        setScreen({ kind: "host", subscription });
        return;
      }
      if (subscription.keyAgent === true) {
        setFactoryKey("");
        setScreen({ kind: "factory", subscription, busy: false });
        return;
      }
      void start(subscription);
    },
    [start],
  );

  const startCodexBrowser = useCallback(() => {
    const current = screenRef.current;
    if (current.kind === "codex") {
      void start(current.subscription);
    }
  }, [start]);
  const startCodexDevice = useCallback(() => {
    const current = screenRef.current;
    if (current.kind === "codex") {
      void start(current.subscription, "device");
    }
  }, [start]);
  const backToList = useCallback(() => setScreen({ kind: "list" }), []);

  // A waiting sign-in is followed until it is over, as myna's window does.
  const running = screen.kind === "running" ? screen : null;
  const runningId = running?.state.id ?? "";
  const runningState = running?.state.state;
  useEffect(() => {
    if (client === null || runningId === "" || runningState !== "waiting") {
      return;
    }
    let stopped = false;
    const timer = setInterval(() => {
      void (async () => {
        try {
          const result = await client.getGatewaySignIn(runningId);
          if (stopped) {
            return;
          }
          const current = screenRef.current;
          if (current.kind !== "running" || current.state.id !== runningId) {
            return;
          }
          setScreen({ kind: "running", subscription: current.subscription, state: result.state });
        } catch {
          // a poll that failed leaves the sign-in as it was
        }
      })();
    }, 800);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [client, runningId, runningState]);

  const cancel = useCallback(() => {
    const current = screenRef.current;
    if (current.kind === "running" && current.state.id !== "" && client !== null) {
      void client.cancelGatewaySignIn(current.state.id).catch(() => undefined);
    }
    setScreen({ kind: "list" });
  }, [client]);

  const finish = useCallback(async () => {
    const current = screenRef.current;
    if (current.kind !== "running" || client === null) {
      return;
    }
    setBusy(true);
    setCallbackError(null);
    try {
      const result = await client.callbackGatewaySignIn(current.state.id, callback.trim());
      if (!result.ok) {
        setCallbackError(result.error ?? t("settings.gatewayPages.providers.subFailed"));
      }
    } catch (error) {
      setCallbackError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [callback, client, t]);

  const signInAnyway = useCallback(() => {
    const current = screenRef.current;
    if (current.kind === "risk") {
      void start(current.subscription);
    }
  }, [start]);

  const signInOnGithub = useCallback(() => {
    const current = screenRef.current;
    if (current.kind === "host") {
      void start(current.subscription, "github.com");
    }
  }, [start]);

  const signInOnGhe = useCallback(() => {
    const current = screenRef.current;
    if (current.kind === "host") {
      void start(current.subscription, host.trim());
    }
  }, [host, start]);

  const addFactory = useCallback(async () => {
    const current = screenRef.current;
    if (current.kind !== "factory" || client === null) {
      return;
    }
    const key = factoryKey.trim();
    if (key === "") {
      return;
    }
    setScreen({ ...current, busy: true, error: undefined });
    try {
      const result = await client.addGatewaySubscriptionAccount({ agent: "factory", key });
      if (!result.ok) {
        setScreen({
          ...current,
          busy: false,
          error: result.error ?? t("settings.gatewayPages.providers.subFactoryFailed"),
        });
        return;
      }
      const account = result.account;
      setScreen({
        kind: "factoryAdded",
        subscription: current.subscription,
        user: account?.user ?? "",
        ...(account?.region === undefined || account.region === ""
          ? {}
          : { region: account.region }),
        ...(account?.orgId === undefined || account.orgId === "" ? {} : { orgId: account.orgId }),
      });
    } catch (error) {
      setScreen({
        ...current,
        busy: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, [client, factoryKey, t]);

  const addFactoryNow = useCallback(() => {
    void addFactory();
  }, [addFactory]);

  const addAnotherFactory = useCallback(() => {
    const current = screenRef.current;
    if (current.kind === "factoryAdded") {
      setFactoryKey("");
      setScreen({ kind: "factory", subscription: current.subscription, busy: false });
    }
  }, []);

  const { pickFiles } = useFilePicker();

  const openImport = useCallback((subscription: Subscription) => {
    setScreen({ kind: "import", subscription, files: [], text: "" });
  }, []);

  const importInstead = useCallback(() => {
    const current = screenRef.current;
    if (current.kind === "risk") {
      openImport(current.subscription);
    }
  }, [openImport]);

  const chooseImportFiles = useCallback(async () => {
    const current = screenRef.current;
    if (current.kind !== "import") {
      return;
    }
    let picked: Awaited<ReturnType<typeof pickFiles>>;
    try {
      picked = await pickFiles();
    } catch (error) {
      setScreen({
        ...current,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (picked === null) {
      return;
    }
    const files: ImportFile[] = [];
    let tooBig: string | null = null;
    for (const file of picked) {
      const bytes = await file.readBytes();
      if (bytes.byteLength > IMPORT_FILE_LIMIT) {
        tooBig = t("settings.gatewayPages.providers.subImportTooBig", { name: file.fileName });
        continue;
      }
      files.push({ name: file.fileName, text: new TextDecoder().decode(bytes) });
    }
    const latest = screenRef.current;
    if (latest.kind !== "import") {
      return;
    }
    setScreen({
      ...latest,
      files,
      ...(tooBig === null ? {} : { error: tooBig }),
    });
  }, [pickFiles, t]);

  const changeImportText = useCallback((value: string) => {
    const current = screenRef.current;
    if (current.kind === "import") {
      setScreen({ ...current, text: value });
    }
  }, []);

  const runImport = useCallback(async () => {
    const current = screenRef.current;
    if (current.kind !== "import" || client === null) {
      return;
    }
    const files = current.files.map((file) => file.text);
    const names = current.files.map((file) => file.name);
    if (current.text.trim() !== "") {
      files.push(current.text);
      names.push(t("settings.gatewayPages.providers.subImportPasted"));
    }
    if (files.length === 0) {
      return;
    }
    setScreen({ kind: "importing", subscription: current.subscription });
    try {
      const payload = await client.importGatewaySubscriptionAccounts({
        agent: current.subscription.agent,
        files,
      });
      if (payload.results.length === 0 && payload.error !== undefined) {
        setScreen({
          kind: "import",
          subscription: current.subscription,
          files: current.files,
          text: current.text,
          error: payload.error,
        });
        return;
      }
      const shown: ShownImportResult[] = [];
      for (const [index, result] of payload.results.entries()) {
        shown.push({ ...result, key: `${index}-${result.user}-${result.file ?? ""}` });
      }
      setScreen({
        kind: "imported",
        subscription: current.subscription,
        names,
        results: shown,
      });
    } catch (error) {
      setScreen({
        kind: "import",
        subscription: current.subscription,
        files: current.files,
        text: current.text,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, [client, t]);

  const runImportNow = useCallback(() => {
    void runImport();
  }, [runImport]);

  const importMore = useCallback(() => {
    const current = screenRef.current;
    if (current.kind === "imported") {
      setScreen({ kind: "import", subscription: current.subscription, files: [], text: "" });
    }
  }, []);

  const tryAgain = useCallback(() => {
    const current = screenRef.current;
    if (current.kind === "failed") {
      void start(current.subscription, current.site);
    }
  }, [start]);

  const finishCurrent = useCallback(() => {
    void finish();
  }, [finish]);

  if (!canSignIn) {
    return null;
  }

  const title = ((): string => {
    switch (screen.kind) {
      case "list":
        return "";
      case "codex":
        return screen.subscription.name;
      case "risk":
        return t("settings.gatewayPages.providers.subRiskTitle", {
          name: screen.subscription.name,
        });
      case "host":
        return t("settings.gatewayPages.providers.subCopilotHost");
      case "factory":
        return t("settings.gatewayPages.providers.subFactoryTitle");
      case "factoryAdded":
        return t("settings.gatewayPages.providers.subFactoryAdded");
      case "failed":
        return t("settings.gatewayPages.providers.subFailed");
      case "import":
      case "importing":
        return t("settings.gatewayPages.providers.subImportTitle", {
          name: screen.subscription.name,
        });
      case "imported":
        return t("settings.gatewayPages.providers.subImportFinished");
      case "running":
        if (screen.state.state === "done") {
          return screen.state.again === true
            ? t("settings.gatewayPages.providers.subDoneAgain", { user: screen.state.user ?? "" })
            : t("settings.gatewayPages.providers.subDone", { user: screen.state.user ?? "" });
        }
        return t("settings.gatewayPages.providers.subWaiting", { name: screen.subscription.name });
    }
  })();

  return (
    <View style={styles.section}>
      <View style={styles.sectionHead}>
        <Text style={styles.sectionTitle}>
          {t("settings.gatewayPages.providers.subscriptions")}
        </Text>
        <Text style={styles.sectionHint}>
          {t("settings.gatewayPages.providers.subscriptionsHint")}
        </Text>
      </View>
      <View style={settingsStyles.card}>
        {screen.kind === "list" ? (
          <View style={styles.listStack}>
            <SubscriptionList serverId={serverId} onPick={pick} />
            <PluginSubscriptionsCard serverId={serverId ?? ""} />
          </View>
        ) : (
          <View style={styles.panel}>
            <Text style={styles.title}>{title}</Text>
            {screen.kind === "codex" ? (
              <>
                <Text style={styles.sub}>
                  {t("settings.gatewayPages.providers.codexSignInHint")}
                </Text>
                <View style={styles.acts}>
                  <Button size="sm" onPress={startCodexBrowser}>
                    {t("settings.gatewayPages.providers.codexSignIn")}
                  </Button>
                  <Button variant="ghost" size="sm" onPress={startCodexDevice}>
                    {t("settings.gatewayPages.providers.codexUseDevice")}
                  </Button>
                  <Button variant="ghost" size="sm" onPress={backToList}>
                    {t("settings.gatewayPages.providers.subCancel")}
                  </Button>
                </View>
                <CodexAccountsSection serverId={serverId ?? ""} embedded />
              </>
            ) : null}
            {screen.kind === "risk" ? (
              <RiskPanel
                subscription={screen.subscription}
                serverId={serverId}
                onCancel={cancel}
                onImport={importInstead}
                onSignIn={signInAnyway}
              />
            ) : null}
            {screen.kind === "host" ? (
              <>
                <Text style={styles.sub}>
                  {t("settings.gatewayPages.providers.subCopilotHostHint")}
                </Text>
                <FormTextInput
                  size="sm"
                  initialValue={host}
                  onChangeText={setHost}
                  placeholder={t("settings.gatewayPages.providers.subCopilotHostPlaceholder")}
                  accessibilityLabel={t("settings.gatewayPages.providers.subCopilotHost")}
                  autoCapitalize="none"
                  autoCorrect={false}
                  testID="gateway-subscription-ghe-host"
                />
                <View style={styles.acts}>
                  <Button variant="ghost" size="sm" onPress={cancel}>
                    {t("settings.gatewayPages.providers.subCancel")}
                  </Button>
                  <Button variant="ghost" size="sm" onPress={signInOnGithub}>
                    {t("settings.gatewayPages.providers.subCopilotGithub")}
                  </Button>
                  <Button size="sm" disabled={host.trim() === ""} onPress={signInOnGhe}>
                    {t("settings.gatewayPages.providers.subCopilotGhe")}
                  </Button>
                </View>
              </>
            ) : null}
            {screen.kind === "factory" || screen.kind === "factoryAdded" ? (
              <FactoryPanel
                screen={screen}
                factoryKey={factoryKey}
                onChangeKey={setFactoryKey}
                onCancel={cancel}
                onAdd={addFactoryNow}
                onAddAnother={addAnotherFactory}
                onDone={onClose}
              />
            ) : null}
            {screen.kind === "import" ? (
              <ImportForm
                subscription={screen.subscription}
                files={screen.files}
                text={screen.text}
                error={screen.error}
                onChoose={chooseImportFiles}
                onChangeText={changeImportText}
                onCancel={cancel}
                onRun={runImportNow}
              />
            ) : null}
            {screen.kind === "importing" ? <ImportChecking /> : null}
            {screen.kind === "imported" ? (
              <ImportResults
                names={screen.names}
                results={screen.results}
                onDone={onClose}
                onMore={importMore}
              />
            ) : null}
            {screen.kind === "failed" ? (
              <>
                <Text style={styles.error}>{screen.message}</Text>
                <View style={styles.acts}>
                  <Button variant="ghost" size="sm" onPress={cancel}>
                    {t("settings.gatewayPages.providers.subCancel")}
                  </Button>
                  <Button size="sm" onPress={tryAgain}>
                    {t("settings.gatewayPages.providers.subTryAgain")}
                  </Button>
                </View>
              </>
            ) : null}
            {screen.kind === "running" ? (
              <RunningSignIn
                subscription={screen.subscription}
                state={screen.state}
                callback={callback}
                callbackError={callbackError}
                busy={busy}
                onCallback={setCallback}
                onFinish={finishCurrent}
                onCancel={cancel}
                onDone={onClose}
              />
            ) : null}
          </View>
        )}
      </View>
    </View>
  );
}

interface RunningSignInProps {
  subscription: Subscription;
  state: SignInState;
  callback: string;
  callbackError: string | null;
  busy: boolean;
  onCallback: (value: string) => void;
  onFinish: () => void;
  onCancel: () => void;
  onDone: () => void;
}

function RunningSignIn({
  subscription,
  state,
  callback,
  callbackError,
  busy,
  onCallback,
  onFinish,
  onCancel,
  onDone,
}: RunningSignInProps) {
  const { t } = useTranslation();
  const url = state.url ?? "";
  const openUrl = useCallback(() => {
    void openExternalUrl(url);
  }, [url]);
  if (state.state === "done") {
    return (
      <View style={styles.acts}>
        <Button size="sm" onPress={onDone}>
          {t("settings.gatewayPages.providers.subFinish")}
        </Button>
      </View>
    );
  }
  if (state.state === "failed" || state.state === "canceled") {
    return (
      <>
        <Text style={styles.error}>
          {state.error ?? t("settings.gatewayPages.providers.subFailed")}
        </Text>
        <View style={styles.acts}>
          <Button variant="ghost" size="sm" onPress={onCancel}>
            {t("settings.gatewayPages.providers.subCancel")}
          </Button>
        </View>
      </>
    );
  }
  return (
    <>
      <View style={styles.waitLine}>
        <ThemedLoadingSpinner size="small" />
        <Text style={styles.sub}>
          {state.state === "waiting"
            ? t("settings.gatewayPages.providers.subWaiting", { name: subscription.name })
            : t("settings.gatewayPages.providers.subStarting")}
        </Text>
      </View>
      {state.code === undefined ? null : <Text style={styles.code}>{state.code}</Text>}
      {state.code === undefined ? null : (
        <Text style={styles.sub}>{t("settings.gatewayPages.providers.subDevice")}</Text>
      )}
      {url === "" ? null : (
        <View style={styles.acts}>
          <Button variant="ghost" size="sm" onPress={openUrl}>
            {t("settings.gatewayPages.providers.subOpen")}
          </Button>
          <Button variant="ghost" size="sm" onPress={onCancel}>
            {t("settings.gatewayPages.providers.subCancel")}
          </Button>
        </View>
      )}
      {state.pasteCallback !== true ? null : (
        <>
          <Text style={styles.sub}>{t("settings.gatewayPages.providers.subPasteHint")}</Text>
          <FormTextInput
            size="sm"
            initialValue={callback}
            onChangeText={onCallback}
            placeholder={t("settings.gatewayPages.providers.subCallbackPlaceholder")}
            accessibilityLabel={t("settings.gatewayPages.providers.subCallbackPlaceholder")}
            autoCapitalize="none"
            autoCorrect={false}
            testID="gateway-subscription-callback"
          />
          {callbackError === null ? null : <Text style={styles.error}>{callbackError}</Text>}
          <View style={styles.acts}>
            <Button size="sm" disabled={busy || callback.trim() === ""} onPress={onFinish}>
              {t("settings.gatewayPages.providers.subFinish")}
            </Button>
            <Button variant="ghost" size="sm" onPress={onCancel}>
              {t("settings.gatewayPages.providers.subCancel")}
            </Button>
          </View>
        </>
      )}
    </>
  );
}

interface ImportFormProps {
  subscription: Subscription;
  files: readonly ImportFile[];
  text: string;
  error: string | undefined;
  onChoose: () => void;
  onChangeText: (value: string) => void;
  onCancel: () => void;
  onRun: () => void;
}

/** Another tool's export, chosen from files or pasted (`app.js:13510-13560`). */
function ImportForm({
  subscription,
  files,
  text,
  error,
  onChoose,
  onChangeText,
  onCancel,
  onRun,
}: ImportFormProps) {
  const { t } = useTranslation();
  return (
    <>
      <Text style={styles.sub}>{t("settings.gatewayPages.providers.subImportIntro")}</Text>
      {subscription.riskKey === undefined ? null : (
        <Text style={styles.sub}>
          {t(`settings.gatewayPages.providers.${subscription.riskKey}`, {
            name: subscription.name,
          })}
        </Text>
      )}
      <View style={styles.acts}>
        <Button variant="ghost" size="sm" onPress={onChoose}>
          {t("settings.gatewayPages.providers.subImportChoose")}
        </Button>
        <Text style={styles.sub}>{files.map((file) => file.name).join(", ")}</Text>
      </View>
      <FormTextInput
        size="sm"
        style={styles.importText}
        initialValue={text}
        onChangeText={onChangeText}
        placeholder={t("settings.gatewayPages.providers.subImportPastePlaceholder")}
        accessibilityLabel={t("settings.gatewayPages.providers.subImportPastePlaceholder")}
        multiline
        numberOfLines={3}
        autoCapitalize="none"
        autoCorrect={false}
        testID="gateway-subscription-import-text"
      />
      {error === undefined ? null : <Text style={styles.error}>{error}</Text>}
      <View style={styles.acts}>
        <Button variant="ghost" size="sm" onPress={onCancel}>
          {t("settings.gatewayPages.providers.subCancel")}
        </Button>
        <Button size="sm" disabled={files.length === 0 && text.trim() === ""} onPress={onRun}>
          {t("settings.gatewayPages.providers.subImportAction")}
        </Button>
      </View>
    </>
  );
}

/** The wait while every account is checked with Google (`app.js:13490-13495`). */
function ImportChecking() {
  const { t } = useTranslation();
  return (
    <>
      <View style={styles.waitLine}>
        <ThemedLoadingSpinner size="small" />
        <Text style={styles.sub}>{t("settings.gatewayPages.providers.subImportChecking")}</Text>
      </View>
      <Text style={styles.sub}>{t("settings.gatewayPages.providers.subImportChecks")}</Text>
    </>
  );
}

interface ImportResultsProps {
  names: readonly string[];
  results: readonly ShownImportResult[];
  onDone: () => void;
  onMore: () => void;
}

/** One line per account brought in, or per file that held none (`app.js:13496-13507`). */
function ImportResults({ names, results, onDone, onMore }: ImportResultsProps) {
  const { t } = useTranslation();
  const added = results.filter(
    (result) => result.status === "added" || result.status === "updated",
  ).length;
  const failed = results.filter((result) => result.status === "failed").length;
  return (
    <>
      <Text style={styles.sub}>
        {t("settings.gatewayPages.providers.subImportCount", { n: added, m: failed })}
      </Text>
      <View style={styles.results}>
        {results.map((result) => (
          <View key={result.key} style={styles.resultRow}>
            <Text style={styles.name}>{importResultName(result, names)}</Text>
            <Text style={result.status === "failed" ? styles.error : styles.resultStatus}>
              {t(`settings.gatewayPages.providers.${IMPORT_STATUS_KEYS[result.status]}`)}
            </Text>
            {result.error === undefined ? null : <Text style={styles.error}>{result.error}</Text>}
          </View>
        ))}
      </View>
      <View style={styles.acts}>
        <Button size="sm" onPress={onDone}>
          {t("settings.gatewayPages.providers.subImportDone")}
        </Button>
        <Button variant="ghost" size="sm" onPress={onMore}>
          {t("settings.gatewayPages.providers.subImportMore")}
        </Button>
      </View>
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  section: {
    gap: theme.spacing[2],
  },
  listStack: {
    gap: theme.spacing[3],
  },
  sectionHead: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: theme.spacing[2],
  },
  sectionTitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  sectionHint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  rowBorder: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
  },
  rowContent: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[0.5],
  },
  nameRow: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: theme.spacing[2],
  },
  name: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    flexShrink: 1,
  },
  note: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    flexShrink: 1,
  },
  sub: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  signIn: {
    color: theme.colors.accent,
    fontSize: theme.fontSize.sm,
  },
  panel: {
    gap: theme.spacing[2],
    padding: theme.spacing[4],
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  error: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.sm,
  },
  importText: {
    minHeight: 72,
    textAlignVertical: "top",
  },
  results: {
    gap: theme.spacing[1],
  },
  resultRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "baseline",
    gap: theme.spacing[2],
  },
  resultStatus: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  accountList: {
    gap: theme.spacing[1],
  },
  accountRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "baseline",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[1],
  },
  acts: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  waitLine: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  code: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.lg,
    letterSpacing: 2,
  },
}));
