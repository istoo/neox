import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { SettingsRow, SettingsSwitch } from "@/components/settings";
import { Button } from "@/components/ui/button";
import {
  EditingTextInput as TextInput,
  type EditingTextInputHandle,
} from "@/components/ui/text-input";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { useGatewayConfig } from "@/hooks/use-gateway-config";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import type { GatewayConfigWire } from "@neolix/protocol/gateway";
import { useSettingsHostServerId } from "./shared";
import { useGatewayMode } from "./gateway-mode";
import { StringListEditor } from "./list-rows";

type ModelNamesMode = NonNullable<GatewayConfigWire["modelNames"]>;

const MODEL_NAME_MODES: readonly ModelNamesMode[] = ["off", "own", "on"];

/** Drops the key so the daemon's default applies, rather than saving an empty URL. */
function withoutProxy(config: GatewayConfigWire): GatewayConfigWire {
  const { proxy: _proxy, ...rest } = config;
  return rest;
}

function withoutModelNames(config: GatewayConfigWire): GatewayConfigWire {
  const { modelNames: _modelNames, ...rest } = config;
  return rest;
}

/** myna's "Provider in model names", stored in the host's gateway config. */
export function ModelNamesRow() {
  const { t } = useTranslation();
  const serverId = useSettingsHostServerId();
  const { config, save } = useGatewayConfig(serverId);
  const gatewayMode = useGatewayMode();
  const value = config?.modelNames ?? "on";

  const options = MODEL_NAME_MODES.map((mode) => ({
    value: mode,
    label: t(`settings.pages.models.nameMode.${mode}`),
    disabled: config === null,
  })) as SegmentedControlOption<ModelNamesMode>[];

  const change = useCallback(
    (mode: ModelNamesMode) => {
      if (config === null) {
        return;
      }
      const next = mode === "on" ? withoutModelNames(config) : { ...config, modelNames: mode };
      void save(next);
    },
    [config, save],
  );

  // Gateway mode leaves out what is written into this computer's agents' files.
  if (gatewayMode.enabled) {
    return null;
  }

  return (
    <SettingsRow
      label={t("settings.pages.models.nameMode.label")}
      hint={
        config === null
          ? t("settings.pages.actions.noHost")
          : t("settings.pages.models.nameMode.hint")
      }
    >
      <SegmentedControl value={value} onValueChange={change} options={options} />
    </SettingsRow>
  );
}

/** The gateway's upstream proxy, for providers and accounts that name none. */
type ProxyMode = "auto" | "off" | "custom";

/**
 * myna's proxy row (settings › Network › Proxy): Auto follows *_PROXY and
 * the system's proxy, Off goes direct, Custom is one address — http://,
 * https://, socks5://, or host:port. The line under the row says which
 * proxy is in force and what chose it, so a machine whose proxy comes from
 * the system reads as such rather than looking unset.
 */
export function GatewayProxyRow() {
  const { t } = useTranslation();
  const serverId = useSettingsHostServerId();
  const { config, save, status } = useGatewayConfig(serverId);
  const [draft, setDraft] = useState(() => splitProxy(config?.proxy ?? ""));
  // Custom picked but not saved yet: the editor is open while the saved
  // value is still Auto or Off, as myna keeps its proxyCustom flag.
  const [custom, setCustom] = useState(false);
  const lastCustom = useRef(
    config?.proxy !== undefined && isCustomProxy(config.proxy) ? config.proxy : "",
  );
  const [error, setError] = useState<string | null>(null);
  const setAddress = useCallback((address: string) => {
    setDraft((current) => ({ ...current, address }));
  }, []);
  const setUsername = useCallback((username: string) => {
    setDraft((current) => ({ ...current, username }));
  }, []);
  const setPassword = useCallback((password: string) => {
    setDraft((current) => ({ ...current, password }));
  }, []);
  const input = useRef<EditingTextInputHandle>(null);
  const saved = config?.proxy ?? "";
  const mode: ProxyMode = custom ? "custom" : proxyModeOf(saved);

  useEffect(() => {
    const value = config?.proxy;
    if (value !== undefined && isCustomProxy(value)) {
      lastCustom.current = value;
      setCustom(false);
    }
    setDraft(splitProxy(value ?? ""));
  }, [config?.proxy]);

  const persist = useCallback(
    (value: string | undefined) => {
      if (config === null) {
        return;
      }
      setError(null);
      void save(value === undefined ? withoutProxy(config) : { ...config, proxy: value }).catch(
        (cause: unknown) => {
          setError(cause instanceof Error ? cause.message : String(cause));
        },
      );
    },
    [config, save],
  );

  const pick = useCallback(
    (next: ProxyMode) => {
      if (next === "auto") {
        persist(undefined);
        return;
      }
      if (next === "off") {
        persist("direct");
        return;
      }
      // Custom: the editor below takes over; nothing is saved until Save.
      // Picking it again after Off or Auto brings back the last address.
      setCustom(true);
      setDraft(splitProxy(saved === "" || saved === "direct" ? lastCustom.current : saved));
      setError(null);
    },
    [persist, saved],
  );

  const commit = useCallback(() => {
    const address = input.current?.getText().trim() ?? draft.address.trim();
    if (address === "") {
      return;
    }
    if (!isProxyAddress(address)) {
      setError(t("settings.pages.network.proxyInvalid"));
      return;
    }
    persist(joinProxy(address, draft.username, draft.password));
  }, [draft, persist, t]);

  const modes: SegmentedControlOption<ProxyMode>[] = [
    { value: "auto", label: t("settings.pages.network.proxyModeAuto") },
    { value: "off", label: t("settings.pages.network.proxyModeOff") },
    { value: "custom", label: t("settings.pages.network.proxyModeCustom") },
  ];
  const hint =
    config === null
      ? t("settings.pages.actions.noHost")
      : (sourceHint(t, status?.proxySource, status?.proxy) ??
        t("settings.pages.network.proxyHint"));

  return (
    <SettingsRow label={t("settings.pages.network.proxy")} hint={hint} error={error ?? undefined}>
      <View style={styles.proxyColumn}>
        <SegmentedControl options={modes} value={mode} onValueChange={pick} />
        {mode === "custom" ? (
          <View style={styles.proxyEditor}>
            <TextInput
              ref={input}
              key={`address-${saved}`}
              initialValue={draft.address}
              onChangeText={setAddress}
              onSubmitEditing={commit}
              placeholder="http://127.0.0.1:7890"
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              editable={config !== null}
              style={styles.input}
              accessibilityLabel={t("settings.pages.network.proxy")}
            />
            <TextInput
              key={`user-${saved}`}
              initialValue={draft.username}
              onChangeText={setUsername}
              onSubmitEditing={commit}
              placeholder={t("settings.pages.network.proxyUsername")}
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              editable={config !== null}
              style={styles.input}
              accessibilityLabel={t("settings.pages.network.proxyUsername")}
            />
            <TextInput
              key={`pass-${saved}`}
              initialValue={draft.password}
              onChangeText={setPassword}
              onSubmitEditing={commit}
              placeholder={t("settings.pages.network.proxyPassword")}
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              secureTextEntry
              editable={config !== null}
              style={styles.input}
              accessibilityLabel={t("settings.pages.network.proxyPassword")}
            />
            <Button variant="ghost" size="sm" onPress={commit}>
              {t("settings.pages.network.save")}
            </Button>
          </View>
        ) : null}
      </View>
    </SettingsRow>
  );
}

function isCustomProxy(value: string | undefined): boolean {
  return value !== undefined && value !== "" && value !== "direct";
}

function proxyModeOf(saved: string): ProxyMode {
  if (saved === "") {
    return "auto";
  }
  return saved === "direct" ? "off" : "custom";
}

/** The line under the row: which proxy is in force, and what chose it. */
function sourceHint(
  t: TFunction,
  source: "settings" | "environment" | "system" | "off" | "none" | undefined,
  proxy: string | undefined,
): string | null {
  if (source === undefined) {
    return null;
  }
  const address = proxy ?? "";
  switch (source) {
    case "settings":
      return t("settings.pages.network.proxySourceSettings", { proxy: address });
    case "environment":
      return t("settings.pages.network.proxySourceEnvironment", { proxy: address });
    case "system":
      return t("settings.pages.network.proxySourceSystem", { proxy: address });
    case "off":
      return t("settings.pages.network.proxySourceOff");
    case "none":
      return t("settings.pages.network.proxySourceNone");
  }
}

interface ProxyDraft {
  address: string;
  username: string;
  password: string;
}

/** A proxy address split into its address and login, as myna's row does. */
function splitProxy(value: string): ProxyDraft {
  const text = value.trim();
  if (text === "" || text === "direct") {
    return { address: "", username: "", password: "" };
  }
  const match = /^([a-z][\w+.-]*:\/\/)?([^/?#]*)(.*)$/i.exec(text);
  const scheme = match?.[1] ?? "";
  const authority = match?.[2] ?? "";
  const rest = match?.[3] ?? "";
  const at = authority.lastIndexOf("@");
  const login = at < 0 ? "" : authority.slice(0, at);
  const host = at < 0 ? authority : authority.slice(at + 1);
  const colon = login.indexOf(":");
  const username = colon < 0 ? login : login.slice(0, colon);
  const password = colon < 0 ? "" : login.slice(colon + 1);
  const decode = (part: string): string => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  };
  return {
    address: scheme + host + rest,
    username: decode(username),
    password: decode(password),
  };
}

/** The address and login joined back into the one URL the config keeps. */
function joinProxy(address: string, username: string, password: string): string {
  const text = address.trim();
  if (text === "" || (username === "" && password === "")) {
    return text;
  }
  const match = /^([a-z][\w+.-]*:\/\/)?(.*)$/i.exec(text);
  const scheme = match?.[1] ?? "";
  const rest = match?.[2] ?? text;
  const login =
    password === ""
      ? encodeURIComponent(username)
      : `${encodeURIComponent(username)}:${encodeURIComponent(password)}`;
  return `${scheme}${login}@${rest}`;
}

function isProxyAddress(value: string): boolean {
  try {
    const url = new URL(value.includes("://") ? value : `http://${value}`);
    return ["http:", "https:", "socks5:", "socks5h:"].includes(url.protocol);
  } catch {
    return false;
  }
}

type WarmupMode = NonNullable<GatewayConfigWire["codexWarmup"]>;

/** myna's warm-head block: when a subscription's windows are warmed as they reset. */
export function WarmupRows() {
  const { t } = useTranslation();
  const serverId = useSettingsHostServerId();
  const { config, save } = useGatewayConfig(serverId);
  const options = useMemo<SegmentedControlOption<WarmupMode>[]>(
    () => [
      { value: "off", label: t("settings.pages.quota.warmupOff") },
      { value: "week", label: t("settings.pages.quota.warmupWeek") },
      { value: "all", label: t("settings.pages.quota.warmupAll") },
    ],
    [t],
  );
  const change = useCallback(
    (key: "codexWarmup" | "claudeWarmup", mode: WarmupMode) => {
      if (config !== null) {
        void save({ ...config, [key]: mode });
      }
    },
    [config, save],
  );
  const changeCodex = useCallback((mode: WarmupMode) => change("codexWarmup", mode), [change]);
  const changeClaude = useCallback((mode: WarmupMode) => change("claudeWarmup", mode), [change]);

  return (
    <>
      <SettingsRow
        label={t("settings.pages.quota.codexWarmup")}
        hint={
          config === null
            ? t("settings.pages.actions.noHost")
            : t("settings.pages.quota.warmupHint")
        }
      >
        <SegmentedControl
          options={options}
          value={config?.codexWarmup ?? "off"}
          onValueChange={changeCodex}
        />
      </SettingsRow>
      <SettingsRow label={t("settings.pages.quota.claudeWarmup")}>
        <SegmentedControl
          options={options}
          value={config?.claudeWarmup ?? "off"}
          onValueChange={changeClaude}
        />
      </SettingsRow>
      {config?.codexWarmup === "all" ? (
        <WarmAtRow agent="codex" ats={config.codexWarmAts ?? []} />
      ) : null}
      {config?.claudeWarmup === "all" ? (
        <WarmAtRow agent="claude" ats={config.claudeWarmAts ?? []} />
      ) : null}
      <AccountWarmRows />
    </>
  );
}

type WarmupAgent = "codex" | "claude";

function isClockTime(value: string): boolean {
  return /^([01]?\d|2[0-3]):[0-5]\d$/.test(value.trim());
}

/**
 * myna's daily warm-up times: a 5-hour window is started at each of these
 * times of day, so the windows line up with the schedule.
 */
function WarmAtRow({ agent, ats }: { agent: WarmupAgent; ats: readonly string[] }) {
  const { t } = useTranslation();
  const serverId = useSettingsHostServerId();
  const client = useHostRuntimeClient(serverId ?? "");
  const supported = useHostFeature(serverId, "gatewayQuotas");
  const change = useCallback(
    (values: string[]) => {
      if (client === null) {
        return;
      }
      void client.setGatewayWarmAt(agent, values).catch(() => undefined);
    },
    [agent, client],
  );
  if (!supported) {
    return null;
  }
  const label =
    agent === "codex"
      ? t("settings.pages.quota.warmAtCodex")
      : t("settings.pages.quota.warmAtClaude");
  return (
    <StringListEditor
      label={label}
      hint={t("settings.pages.quota.warmAtHint")}
      addLabel={t("settings.pages.quota.warmAtAdd")}
      removeLabel={t("settings.pages.network.remove")}
      placeholder="06:00"
      values={ats}
      validate={isClockTime}
      invalidMessage={t("settings.pages.quota.warmAtInvalid")}
      onChange={change}
    />
  );
}

type AccountWarmMode = "same" | "own" | "off";

/** myna's per-account warm-at: follow the agent's times, its own, or none. */
function AccountWarmRows() {
  const { t } = useTranslation();
  const serverId = useSettingsHostServerId();
  const { config } = useGatewayConfig(serverId);
  const supported = useHostFeature(serverId, "gatewayQuotas");
  if (config === null || !supported) {
    return null;
  }
  const accounts = (config.providers ?? []).flatMap((provider) =>
    (provider.accounts ?? []).flatMap((account) => {
      const agent = warmAgentOf(account.agent);
      if (agent === null) {
        return [];
      }
      return [
        {
          key: `${provider.id}/${account.id}`,
          providerId: provider.id,
          accountId: account.id,
          name: account.label ?? account.id,
          at: account.warmAt ?? "",
          agentAts: agent === "codex" ? (config.codexWarmAts ?? []) : (config.claudeWarmAts ?? []),
        },
      ];
    }),
  );
  // myna shows these with two accounts or more, or while one has its own time.
  const shown = accounts.filter(
    (account) => accounts.length >= 2 || (account.at !== "" && account.at !== "off"),
  );
  if (shown.length === 0) {
    return null;
  }
  return (
    <>
      {shown.map((account) => (
        <AccountWarmRow {...account} key={account.key} />
      ))}
      <SettingsRow
        label={t("settings.pages.quota.accountWarmHint")}
        hint={t("settings.pages.quota.accountWarmHintDetail")}
      />
    </>
  );
}

function warmAgentOf(agent: string | undefined): WarmupAgent | null {
  if (agent === "claude-code") {
    return "claude";
  }
  return agent === "chatgpt-api" ? "codex" : null;
}

function AccountWarmRow({
  providerId,
  accountId,
  name,
  at,
  agentAts,
}: {
  providerId: string;
  accountId: string;
  name: string;
  at: string;
  agentAts: readonly string[];
}) {
  const { t } = useTranslation();
  const serverId = useSettingsHostServerId();
  const client = useHostRuntimeClient(serverId ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const input = useRef<EditingTextInputHandle>(null);
  const mode: AccountWarmMode = warmModeOf(at);

  const save = useCallback(
    async (next: string) => {
      if (client === null) {
        return;
      }
      setError(null);
      try {
        const answer = await client.setGatewayAccountWarmAt({
          provider: providerId,
          account: accountId,
          at: next,
        });
        if (answer.error !== undefined) {
          setError(answer.error);
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [accountId, client, providerId],
  );

  const changeMode = useCallback(
    (next: AccountWarmMode) => {
      void save(aimedWarmAt(next, at, agentAts));
    },
    [agentAts, at, save],
  );

  const commit = useCallback(() => {
    const value = (input.current?.getText() ?? "").trim();
    if (!isClockTime(value)) {
      setError(t("settings.pages.quota.warmAtInvalid"));
      return;
    }
    void save(value);
  }, [save, t]);

  const warm = useCallback(() => {
    if (client === null) {
      return;
    }
    setBusy(true);
    setSaid(null);
    setError(null);
    void (async () => {
      try {
        const answer = await client.warmGatewayAccount({
          provider: providerId,
          account: accountId,
        });
        setSaid(answer.error ?? t("settings.pages.quota.warmNowDone"));
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    })();
  }, [accountId, client, providerId, t]);

  const modeOptions: SegmentedControlOption<AccountWarmMode>[] = [
    { value: "same", label: t("settings.pages.quota.accountSame") },
    { value: "own", label: t("settings.pages.quota.accountOwn") },
    { value: "off", label: t("settings.pages.models.off") },
  ];
  const hint = said ?? accountWarmHint(mode, agentAts, t);

  return (
    <SettingsRow label={name} hint={hint} error={error ?? undefined}>
      {mode === "own" ? (
        <TextInput
          key={at}
          ref={input}
          initialValue={at}
          onSubmitEditing={commit}
          placeholder="06:00"
          style={styles.timeInput}
          accessibilityLabel={t("settings.pages.quota.warmAtTime")}
        />
      ) : null}
      <SegmentedControl options={modeOptions} value={mode} onValueChange={changeMode} />
      <Button variant="outline" size="sm" onPress={warm} disabled={busy || client === null}>
        {busy ? t("settings.pages.quota.warmNowBusy") : t("settings.pages.quota.warmNow")}
      </Button>
    </SettingsRow>
  );
}

function warmModeOf(at: string): AccountWarmMode {
  if (at === "") {
    return "same";
  }
  return at === "off" ? "off" : "own";
}

function aimedWarmAt(mode: AccountWarmMode, at: string, agentAts: readonly string[]): string {
  if (mode === "same") {
    return "";
  }
  if (mode === "off") {
    return "off";
  }
  return at !== "" && at !== "off" ? at : (agentAts[0] ?? "06:00");
}

function accountWarmHint(mode: AccountWarmMode, agentAts: readonly string[], t: TFunction): string {
  if (mode === "own") {
    return t("settings.pages.quota.accountOwnHint");
  }
  if (mode === "off") {
    return t("settings.pages.quota.accountOffHint");
  }
  return agentAts.length > 0
    ? t("settings.pages.quota.accountSameHint", { ats: agentAts.join(", ") })
    : t("settings.pages.quota.accountSameOffHint");
}

const DEFAULT_TURN_DONE_SECONDS = 120;

/**
 * myna's TurnDoneAlert: a gateway-served turn that ran this long is reported
 * when its last reply ends. Timed in the gateway, which is the only place that
 * sees turns, and stored in the host's gateway config.
 */
export function TurnDoneAlertRow() {
  const { t } = useTranslation();
  const serverId = useSettingsHostServerId();
  const { config, save } = useGatewayConfig(serverId);
  const gatewayMode = useGatewayMode();
  const seconds = config?.turnDoneSeconds ?? 0;
  const [draft, setDraft] = useState("");
  const input = useRef<EditingTextInputHandle>(null);

  useEffect(() => {
    setDraft(String(seconds > 0 ? seconds : DEFAULT_TURN_DONE_SECONDS));
  }, [seconds]);

  const toggle = useCallback(
    (on: boolean) => {
      if (config === null) {
        return;
      }
      void save({ ...config, turnDoneSeconds: on ? DEFAULT_TURN_DONE_SECONDS : 0 });
    },
    [config, save],
  );

  const commit = useCallback(() => {
    if (config === null) {
      return;
    }
    const parsed = Number.parseInt(input.current?.getText() ?? draft, 10);
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > 3600) {
      input.current?.replaceText(String(seconds));
      return;
    }
    if (parsed !== seconds) {
      void save({ ...config, turnDoneSeconds: parsed });
    }
  }, [config, draft, save, seconds]);

  // myna's #turnDoneRow: an alert this computer's desktop would show.
  if (gatewayMode.enabled) {
    return null;
  }

  return (
    <>
      <SettingsSwitch
        label={t("settings.pages.quota.turnDoneAlert")}
        hint={
          config === null
            ? t("settings.pages.actions.noHost")
            : t("settings.pages.quota.turnDoneHint")
        }
        value={seconds > 0}
        onValueChange={toggle}
        disabled={config === null}
      />
      {seconds > 0 ? (
        <SettingsRow label={t("settings.pages.quota.turnDoneSeconds")}>
          <TextInput
            ref={input}
            initialValue={draft}
            onChangeText={setDraft}
            onBlur={commit}
            onSubmitEditing={commit}
            keyboardType="number-pad"
            inputMode="numeric"
            selectTextOnFocus
            style={styles.input}
            accessibilityLabel={t("settings.pages.quota.turnDoneSeconds")}
          />
        </SettingsRow>
      ) : null}
    </>
  );
}

const BUSY_STEPS = [50, 70, 80, 90] as const;

/**
 * myna's Network › Model ids without the provider: `/v1/models` lists each
 * model by its own id as well, for clients that ask one without its
 * provider. Off by default.
 */
export function BareModelIdsRow() {
  const { t } = useTranslation();
  const serverId = useSettingsHostServerId();
  const { config, save } = useGatewayConfig(serverId);
  const value = config?.bareModelIDs === true ? "on" : "off";
  const options = useMemo<SegmentedControlOption<string>[]>(
    () => [
      { value: "off", label: t("settings.pages.network.off") },
      { value: "on", label: t("settings.pages.network.on") },
    ],
    [t],
  );
  const change = useCallback(
    (next: string) => {
      if (config === null) {
        return;
      }
      const { bareModelIDs: _old, ...rest } = config;
      void save(next === "on" ? { ...rest, bareModelIDs: true } : rest);
    },
    [config, save],
  );
  return (
    <SettingsRow
      label={t("settings.pages.network.bareIds")}
      hint={
        config === null
          ? t("settings.pages.actions.noHost")
          : t("settings.pages.network.bareIdsHint")
      }
    >
      <SegmentedControl options={options} value={value} onValueChange={change} />
    </SettingsRow>
  );
}

/**
 * myna's Network › Busy models last: a model whose provider reports it
 * busier than this goes behind the others a request could go to. Custom
 * opens a field for any other number from 1 to 9999.
 */
export function BusyLoadRow() {
  const { t } = useTranslation();
  const serverId = useSettingsHostServerId();
  const { config, save } = useGatewayConfig(serverId);
  const at = config?.busyLoad ?? 0;
  const [custom, setCustom] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  const options = useMemo<SegmentedControlOption<string>[]>(() => {
    const values = [0, ...BUSY_STEPS];
    if (at > 0 && !values.includes(at)) {
      values.push(at);
      values.sort((left, right) => left - right);
    }
    return [
      ...values.map((value) => ({
        value: String(value),
        label:
          value === 0
            ? t("settings.pages.network.busyLoadOff")
            : t("settings.pages.network.busyLoadOver", { n: value }),
      })),
      { value: "custom", label: t("settings.pages.network.busyLoadCustom") },
    ];
  }, [at, t]);

  const put = useCallback(
    (value: number) => {
      if (config === null) {
        return;
      }
      const { busyLoad: _old, ...rest } = config;
      void save(value === 0 ? rest : { ...rest, busyLoad: value });
    },
    [config, save],
  );
  const change = useCallback(
    (value: string) => {
      setError(null);
      if (value === "custom") {
        setDraft(
          at > 0 && !BUSY_STEPS.includes(at as (typeof BUSY_STEPS)[number]) ? String(at) : "",
        );
        setCustom(true);
        return;
      }
      setCustom(false);
      put(Number(value));
    },
    [at, put],
  );
  const applyCustom = useCallback(() => {
    const text = draft.trim();
    const value = Number(text);
    if (!/^\d+$/.test(text) || value < 1 || value > 9999) {
      setError(t("settings.pages.network.busyLoadInvalid"));
      return;
    }
    setError(null);
    setCustom(false);
    put(value);
  }, [draft, put, t]);
  const cancelCustom = useCallback(() => {
    setCustom(false);
    setError(null);
  }, []);

  return (
    <>
      <SettingsRow
        label={t("settings.pages.network.busyLoad")}
        hint={
          config === null
            ? t("settings.pages.actions.noHost")
            : (error ?? t("settings.pages.network.busyLoadHint"))
        }
      >
        <SegmentedControl
          options={options}
          value={custom ? "custom" : String(at)}
          onValueChange={change}
        />
      </SettingsRow>
      {custom ? (
        <SettingsRow label={t("settings.pages.network.busyLoadAt")}>
          <View style={styles.busyRow}>
            <TextInput
              initialValue={draft}
              onChangeText={setDraft}
              onSubmitEditing={applyCustom}
              keyboardType="number-pad"
              inputMode="numeric"
              placeholder="150"
              selectTextOnFocus
              style={styles.timeInput}
              accessibilityLabel={t("settings.pages.network.busyLoad")}
            />
            <Button variant="default" size="sm" onPress={applyCustom}>
              {t("settings.pages.network.busyLoadApply")}
            </Button>
            <Button variant="ghost" size="sm" onPress={cancelCustom}>
              {t("settings.pages.network.busyLoadCancel")}
            </Button>
          </View>
        </SettingsRow>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create(() => ({
  input: { minWidth: 220 },
  timeInput: { minWidth: 84 },
  proxyColumn: { gap: 8, alignItems: "flex-end" },
  proxyEditor: { gap: 8, alignItems: "flex-end" },
  busyRow: { flexDirection: "row", alignItems: "center", gap: 8 },
}));
