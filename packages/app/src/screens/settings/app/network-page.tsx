/* eslint-disable react-perf/jsx-no-new-function-as-prop -- a handful of settings rows open host pages; none of them is in a hot list, so memoising each closure buys nothing. */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { SettingsCard, SettingsRow, SettingsSection, SettingsSwitch } from "@/components/settings";
import { Button } from "@/components/ui/button";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import {
  EditingTextInput as TextInput,
  type EditingTextInputHandle,
} from "@/components/ui/text-input";
import { useGatewayConfig } from "@/hooks/use-gateway-config";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import * as Clipboard from "expo-clipboard";
import { StyleSheet } from "react-native-unistyles";
import type { DaemonNetwork, DaemonWebPage } from "@neolix/protocol/messages";
import {
  buildModelsRoute,
  buildSettingsHostSectionRoute,
  type HostSectionSlug,
  type ModelsView,
} from "@/utils/host-routes";
import {
  SettingsLinkRow,
  useDaemonStatus,
  useSettingsHostServerId,
  useSettingsNavigate,
} from "./shared";
import { BareModelIdsRow, BusyLoadRow, GatewayProxyRow } from "./gateway-option-rows";
import { StringListEditor } from "./list-rows";
import { parseGatewayListen } from "@/screens/settings/gateway/overview-data";

/**
 * Settings › Network and sharing. Proxy, the gateway's port, model-id and
 * load rows, allowed addresses and web origins are edited here; the
 * gateway's keys and deeper settings stay on the host's pages.
 */
export function NetworkPage() {
  const { t } = useTranslation();
  const navigate = useSettingsNavigate();
  const serverId = useSettingsHostServerId();
  const open = useCallback(
    (section: HostSectionSlug) => {
      if (serverId === null) {
        return;
      }
      navigate(buildSettingsHostSectionRoute(serverId, section));
    },
    [navigate, serverId],
  );
  const openModels = useCallback(
    (view: ModelsView) => {
      if (serverId === null) {
        return;
      }
      navigate(buildModelsRoute({ serverId, view }));
    },
    [navigate, serverId],
  );

  return (
    <>
      <SettingsSection title={t("settings.pages.network.proxySection")}>
        <SettingsCard>
          <GatewayProxyRow />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title={t("settings.pages.network.githubSection")}>
        <SettingsCard>
          <GithubTokenRow />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title={t("settings.pages.network.localNetworkSection")}>
        <SettingsCard>
          <LocalShareRow />
          <ContainerRow />
          <AllowedAddressesRow />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title={t("settings.pages.network.webPagesSection")}>
        <SettingsCard>
          <CorsOriginsRow />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title={t("settings.pages.network.browserAccessSection")}>
        <SettingsCard>
          <BrowserAccessRows />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title={t("settings.pages.network.gatewaySection")}>
        <SettingsCard>
          <GatewayAddressRow />
          <SettingsLinkRow
            label={t("settings.pages.network.gateway")}
            hint={t("settings.pages.network.gatewayHint")}
            actionLabel={t("settings.pages.actions.open")}
            onPress={() => openModels("overview")}
            disabled={serverId === null}
          />
          <SettingsLinkRow
            label={t("settings.pages.network.keys")}
            hint={t("settings.pages.network.keysHint")}
            actionLabel={t("settings.pages.actions.open")}
            onPress={() => openModels("keys")}
            disabled={serverId === null}
          />
          <SettingsLinkRow
            label={t("settings.pages.network.advanced")}
            hint={t("settings.pages.network.advancedHint")}
            actionLabel={t("settings.pages.actions.open")}
            onPress={() => openModels("advanced")}
            disabled={serverId === null}
          />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title={t("settings.pages.network.modelListSection")}>
        <SettingsCard>
          <BareModelIdsRow />
          <BusyLoadRow />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title={t("settings.pages.network.devicesSection")}>
        <SettingsCard>
          <SettingsLinkRow
            label={t("settings.pages.network.connections")}
            hint={t("settings.pages.network.connectionsHint")}
            actionLabel={t("settings.pages.actions.open")}
            onPress={() => open("connections")}
            disabled={serverId === null}
          />
          <SettingsLinkRow
            label={t("settings.pages.network.pairDevice")}
            hint={t("settings.pages.network.pairDeviceHint")}
            actionLabel={t("settings.pages.actions.open")}
            onPress={() => open("pair-device")}
            disabled={serverId === null}
          />
        </SettingsCard>
      </SettingsSection>
    </>
  );
}

/** The addresses other computers reach the daemon at, while sharing is on. */
function lanAddresses(network: DaemonNetwork | null): string[] {
  if (network === null || !network.lan) {
    return [];
  }
  if (network.lanUrls !== undefined && network.lanUrls.length > 0) {
    return network.lanUrls;
  }
  return [network.listen ?? `:${network.port ?? ""}`];
}

/**
 * myna's "Share on local network": the daemon answers other computers on
 * this network, bound at the next start. lanKey is kept for older configs
 * and has no control of its own.
 */
function LocalShareRow() {
  const { t } = useTranslation();
  const serverId = useSettingsHostServerId();
  const client = useHostRuntimeClient(serverId ?? "");
  const [network, setNetwork] = useState<DaemonNetwork | null>(null);
  const [restart, setRestart] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (client === null) {
      return;
    }
    let cancelled = false;
    void client
      .getDaemonConfig()
      .then((answer) => {
        if (!cancelled) {
          setNetwork(answer.config.network ?? null);
        }
        return undefined;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [client]);

  const toggle = useCallback(
    (lan: boolean) => {
      if (client === null) {
        return;
      }
      setError(null);
      void (async () => {
        try {
          const answer = await client.patchDaemonConfig({ network: { lan } });
          setNetwork(answer.config.network ?? null);
          setRestart(true);
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      })();
    },
    [client],
  );

  let status: ReactNode = null;
  if (restart) {
    status = (
      <SettingsRow label={t("settings.pages.network.lanRestart")} error={error ?? undefined} />
    );
  } else if (error !== null) {
    status = <SettingsRow label={t("settings.pages.network.shareLan")} error={error} />;
  }

  const addresses = lanAddresses(network);

  return (
    <>
      <SettingsSwitch
        label={t("settings.pages.network.shareLan")}
        hint={t("settings.pages.network.shareLanHint")}
        value={network?.lan === true}
        disabled={client === null}
        onValueChange={toggle}
      />
      {addresses.map((url) => (
        <SettingsRow
          key={url}
          label={t("settings.pages.network.lanListen")}
          hint={t("settings.pages.network.lanListenHint")}
        >
          <Text style={styles.listenText}>{url}</Text>
        </SettingsRow>
      ))}
      {status}
    </>
  );
}

/**
 * myna's "Gateway address": the gateway is on the daemon's port, so this edits
 * that port (1024–65535). The daemon rebinds at the next start, as myna moves
 * connected agents with it.
 */
function GatewayAddressRow() {
  const { t } = useTranslation();
  const serverId = useSettingsHostServerId();
  const client = useHostRuntimeClient(serverId ?? "");
  const status = useDaemonStatus(serverId);
  const parsed = parseGatewayListen(status?.listen ?? null);
  const currentUrl = parsed.thisComputerUrl ?? parsed.networkUrl ?? parsed.listen ?? "";
  const input = useRef<EditingTextInputHandle>(null);
  const [restart, setRestart] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apply = useCallback(() => {
    if (client === null) {
      return;
    }
    const port = Number((input.current?.getText() ?? "").trim());
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      setError(t("settings.pages.network.gatewayPortInvalid"));
      return;
    }
    setError(null);
    void client
      .patchDaemonConfig({ network: { port } })
      .then(() => {
        setRestart(true);
        return undefined;
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      });
  }, [client, t]);

  return (
    <>
      <SettingsRow
        label={t("settings.pages.network.gatewayAddress")}
        hint={t("settings.pages.network.gatewayAddressHint", { url: currentUrl })}
        error={error ?? undefined}
        testID="settings-gateway-address"
      >
        <TextInput
          key={String(parsed.port)}
          ref={input}
          initialValue={parsed.port === null ? "" : String(parsed.port)}
          keyboardType="number-pad"
          style={styles.portInput}
          accessibilityLabel={t("settings.pages.network.gatewayAddress")}
        />
        <Button variant="outline" size="sm" onPress={apply} disabled={client === null}>
          {t("settings.pages.network.apply")}
        </Button>
      </SettingsRow>
      {restart ? <SettingsRow label={t("settings.pages.network.lanRestart")} /> : null}
    </>
  );
}

/** myna's "In a container": the gateway is one container among others on the host. */
function ContainerRow() {
  const { t } = useTranslation();
  const serverId = useSettingsHostServerId();
  const status = useDaemonStatus(serverId);
  if (status?.container !== true) {
    return null;
  }
  const parsed = parseGatewayListen(status.listen ?? null);
  const url = parsed.thisComputerUrl ?? parsed.networkUrl ?? parsed.listen ?? "";
  return (
    <SettingsRow
      label={t("settings.pages.network.inContainer")}
      hint={t("settings.pages.network.inContainerHint", { url })}
    />
  );
}

/** myna's allowList: addresses that may reach the gateway at all, whatever key they carry. */
function AllowedAddressesRow() {
  const { t } = useTranslation();
  const serverId = useSettingsHostServerId();
  const { config, save } = useGatewayConfig(serverId);
  const change = useCallback(
    (allowIPs: string[]) => {
      if (config !== null) {
        void save({ ...config, allowIPs });
      }
    },
    [config, save],
  );
  if (config === null) {
    return (
      <SettingsRow
        label={t("settings.pages.network.allowIPs")}
        hint={t("settings.pages.actions.noHost")}
      />
    );
  }
  return (
    <StringListEditor
      label={t("settings.pages.network.allowIPs")}
      hint={t("settings.pages.network.allowIPsHint")}
      addLabel={t("settings.pages.network.add")}
      removeLabel={t("settings.pages.network.remove")}
      placeholder={t("settings.pages.network.allowIPsPlaceholder")}
      values={config.allowIPs ?? []}
      validate={isIpOrCidr}
      invalidMessage={t("settings.pages.network.allowIPsInvalid")}
      onChange={change}
    />
  );
}

/** myna's corsList: browser origins allowed to call the gateway with a key. */
function CorsOriginsRow() {
  const { t } = useTranslation();
  const serverId = useSettingsHostServerId();
  const { config, save } = useGatewayConfig(serverId);
  const change = useCallback(
    (corsOrigins: string[]) => {
      if (config !== null) {
        void save({ ...config, corsOrigins });
      }
    },
    [config, save],
  );
  if (config === null) {
    return (
      <SettingsRow
        label={t("settings.pages.network.corsOrigins")}
        hint={t("settings.pages.actions.noHost")}
      />
    );
  }
  return (
    <StringListEditor
      label={t("settings.pages.network.corsOrigins")}
      hint={t("settings.pages.network.corsOriginsHint")}
      addLabel={t("settings.pages.network.add")}
      removeLabel={t("settings.pages.network.remove")}
      placeholder={t("settings.pages.network.corsOriginsPlaceholder")}
      values={config.corsOrigins ?? []}
      validate={isHttpOrigin}
      invalidMessage={t("settings.pages.network.corsOriginsInvalid")}
      onChange={change}
    />
  );
}

/**
 * myna's Browser access (apppage.go): the app serves its own page to a
 * browser while it runs, off, on this computer alone, or on the local
 * network. The link carries the key; a browser without it gets nothing.
 */
function BrowserAccessRows() {
  const { t } = useTranslation();
  const serverId = useSettingsHostServerId();
  const client = useHostRuntimeClient(serverId ?? "");
  const [page, setPage] = useState<DaemonWebPage | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const portInput = useRef<EditingTextInputHandle>(null);

  const load = useCallback(() => {
    if (client === null) {
      return;
    }
    void (async () => {
      try {
        const next = await client.getWebPage();
        setPage(next);
        setUnavailable(false);
      } catch {
        setUnavailable(true);
      }
    })();
  }, [client]);

  useEffect(() => {
    load();
  }, [load]);

  const update = useCallback(
    (patch: { mode?: DaemonWebPage["mode"]; port?: number; newKey?: boolean }) => {
      if (client === null) {
        return;
      }
      setError(null);
      void client
        .setWebPage(patch)
        .then((answer) => {
          if (answer.page !== null) {
            setPage(answer.page);
          }
          if (answer.error !== undefined) {
            setError(answer.error);
          }
          return undefined;
        })
        .catch((cause: unknown) =>
          setError(cause instanceof Error ? cause.message : String(cause)),
        );
    },
    [client],
  );

  const copy = useCallback((link: string) => {
    void Clipboard.setStringAsync(link)
      .then(() => {
        setCopied(link);
        setTimeout(() => setCopied(null), 1_500);
        return undefined;
      })
      .catch(() => undefined);
  }, []);

  const applyPort = useCallback(() => {
    const value = (portInput.current?.getText() ?? "").trim();
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      setError(t("settings.pages.network.pagePortInvalid"));
      return;
    }
    update({ port });
  }, [t, update]);

  if (client === null) {
    return (
      <SettingsRow
        label={t("settings.pages.network.browserAccess")}
        hint={t("settings.pages.actions.noHost")}
      />
    );
  }
  if (unavailable) {
    return (
      <SettingsRow
        label={t("settings.pages.network.browserAccess")}
        hint={t("settings.pages.network.pageUnavailable")}
      />
    );
  }
  if (page === null) {
    return (
      <SettingsRow
        label={t("settings.pages.network.browserAccess")}
        hint={t("settings.pages.network.pageStarting")}
      />
    );
  }

  const modeOptions: SegmentedControlOption<DaemonWebPage["mode"]>[] = [
    { value: "off", label: t("settings.pages.network.pageOff") },
    { value: "local", label: t("settings.pages.network.pageLocal") },
    { value: "lan", label: t("settings.pages.network.pageLan") },
  ];
  const links = pageLinks(page);
  const status = pageStatus(page, error, t);

  return (
    <>
      <SettingsRow
        label={t("settings.pages.network.openInBrowser")}
        hint={t("settings.pages.network.openInBrowserHint", { port: page.port })}
      >
        <SegmentedControl
          options={modeOptions}
          value={page.mode}
          onValueChange={(mode) => update({ mode })}
        />
      </SettingsRow>
      {page.mode === "off" ? null : (
        <>
          <SettingsRow label={t("settings.pages.network.pageLink")} hint={status}>
            <View style={styles.pageLinks}>
              {links.map((link) => (
                <View key={link} style={styles.pageLink}>
                  <Text style={styles.pageLinkText} numberOfLines={1}>
                    {link.replace(/\?k=.*/, "?k=…")}
                  </Text>
                  <Button variant="ghost" size="sm" onPress={() => copy(link)}>
                    {copied === link
                      ? t("settings.pages.network.pageCopied")
                      : t("settings.pages.network.pageCopy")}
                  </Button>
                </View>
              ))}
            </View>
            <Button variant="outline" size="sm" onPress={() => update({ newKey: true })}>
              {t("settings.pages.network.pageNewKey")}
            </Button>
            {error === null ? null : (
              <Button variant="ghost" size="sm" onPress={load}>
                {t("settings.pages.network.pageRetry")}
              </Button>
            )}
          </SettingsRow>
          <SettingsRow label={t("settings.pages.network.pagePort")}>
            <TextInput
              key={String(page.port)}
              ref={portInput}
              initialValue={String(page.port)}
              onSubmitEditing={applyPort}
              keyboardType="number-pad"
              style={styles.portInput}
              accessibilityLabel={t("settings.pages.network.pagePort")}
            />
            <Button variant="outline" size="sm" onPress={applyPort}>
              {t("settings.pages.network.save")}
            </Button>
          </SettingsRow>
          {page.mode === "lan" ? (
            <SettingsRow
              label={t("settings.pages.network.pageUnencrypted")}
              hint={t("settings.pages.network.pageUnencryptedHint")}
            />
          ) : null}
        </>
      )}
    </>
  );
}

function pageLinks(page: DaemonWebPage): string[] {
  const links = page.mode === "lan" ? [page.link, ...page.network] : [page.link];
  return links.filter((link): link is string => link !== null && link.length > 0);
}

function pageStatus(page: DaemonWebPage, error: string | null, t: TFunction): string {
  const failure = error ?? page.error;
  if (failure !== null && failure.startsWith("port ")) {
    return t("settings.pages.network.pagePortTaken", { port: page.port });
  }
  if (failure !== null) {
    return failure;
  }
  return page.serving
    ? t("settings.pages.network.pageServed")
    : t("settings.pages.network.pageStarting");
}

/**
 * myna's GitHub list: the token the Library's GitHub API requests carry. It
 * lives in the host's secrets.json (owner-only) and is never sent back; the
 * row only says whether one is set.
 */
function GithubTokenRow() {
  const { t } = useTranslation();
  const serverId = useSettingsHostServerId();
  const supported = useHostFeature(serverId, "libraryGithubToken");
  const client = useHostRuntimeClient(serverId ?? "");
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [rejected, setRejected] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const input = useRef<EditingTextInputHandle>(null);

  useEffect(() => {
    if (client === null || !supported) {
      return;
    }
    let cancelled = false;
    void client
      .getLibraryGithubToken()
      .then((answer) => {
        if (!cancelled) {
          setConfigured(answer.configured);
          setRejected(answer.rejected === true);
        }
        return undefined;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [client, supported]);

  const save = useCallback(() => {
    if (client === null) {
      return;
    }
    const token = (input.current?.getText() ?? draft).trim();
    setError(null);
    void client
      .setLibraryGithubToken(token)
      .then((answer) => {
        setConfigured(answer.configured);
        setRejected(false);
        input.current?.replaceText("");
        setDraft("");
        return undefined;
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      });
  }, [client, draft]);

  const clear = useCallback(() => {
    if (client === null) {
      return;
    }
    setError(null);
    void client
      .setLibraryGithubToken("")
      .then((answer) => {
        setConfigured(answer.configured);
        setRejected(false);
        return undefined;
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      });
  }, [client]);

  const hint = githubTokenHint(supported, configured, rejected, t);

  return (
    <SettingsRow
      label={t("settings.pages.network.githubToken")}
      hint={`${hint} · ${t("settings.pages.network.githubTokenHint")}`}
      error={error ?? undefined}
    >
      <TextInput
        ref={input}
        initialValue=""
        onChangeText={setDraft}
        onSubmitEditing={save}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        editable={supported && client !== null}
        style={styles.tokenInput}
        accessibilityLabel={t("settings.pages.network.githubToken")}
      />
      <Button
        variant="outline"
        size="sm"
        onPress={save}
        disabled={!supported || client === null || draft.trim().length === 0}
      >
        {t("settings.pages.network.save")}
      </Button>
      {configured === true ? (
        <Button variant="ghost" size="sm" onPress={clear} disabled={client === null}>
          {t("settings.pages.network.clear")}
        </Button>
      ) : null}
    </SettingsRow>
  );
}

function isIpOrCidr(value: string): boolean {
  const [address = "", bits] = value.split("/");
  const ipv6 = address.includes(":");
  if (bits !== undefined) {
    if (!/^\d{1,3}$/.test(bits) || Number(bits) > (ipv6 ? 128 : 32)) {
      return false;
    }
  }
  if (ipv6) {
    return true;
  }
  const parts = address.split(".");
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function githubTokenHint(
  supported: boolean,
  configured: boolean | null,
  rejected: boolean,
  t: TFunction,
): string {
  if (!supported) {
    return t("settings.pages.network.githubTokenUnsupported");
  }
  if (rejected) {
    return t("settings.pages.network.githubTokenRejected");
  }
  return configured === true
    ? t("settings.pages.network.githubTokenConfigured")
    : t("settings.pages.network.githubTokenNotConfigured");
}

const styles = StyleSheet.create((theme) => ({
  tokenInput: { minWidth: 220 },
  portInput: { minWidth: 96 },
  pageLinks: { gap: theme.spacing[1] },
  pageLink: { flexDirection: "row", alignItems: "center", gap: theme.spacing[1] },
  pageLinkText: { flexShrink: 1, color: theme.colors.foregroundMuted },
  listenText: { color: theme.colors.foregroundMuted },
}));

function isHttpOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.origin === value.replace(/\/+$/, "")
    );
  } catch {
    return false;
  }
}
