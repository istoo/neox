import { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { Buffer } from "buffer";
import { SettingsRow, SettingsSwitch } from "@/components/settings";
import {
  EditingTextInput as TextInput,
  type EditingTextInputHandle,
} from "@/components/ui/text-input";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { useGatewayConfig } from "@/hooks/use-gateway-config";
import type { GatewayConfigWire } from "@neolix/protocol/gateway";
import { useSettingsHostServerId } from "./shared";

const LANGFUSE_PATH = "/api/public/otel";
type CollectorKind = "otlp" | "langfuse";
/** myna's three Trace content choices: metadata, cut at 256 KiB, or whole. */
type BodyMode = "metadata" | "limited" | "full";

const BODY_MODE_HINT: Record<BodyMode, string> = {
  metadata: "settings.pages.observability.otelBodiesMetadataHint",
  limited: "settings.pages.observability.otelBodiesLimitedHint",
  full: "settings.pages.observability.otelBodiesFullHint",
};

interface OtelConfig {
  enabled?: boolean;
  endpoint?: string;
  headers?: Record<string, string>;
  metrics?: boolean;
  sessions?: boolean;
  bodies?: boolean;
  bodiesWhole?: boolean;
}

function bodyModeOf(otel: OtelConfig): BodyMode {
  if (otel.bodies !== true) {
    return "metadata";
  }
  return otel.bodiesWhole === true ? "full" : "limited";
}

function otelOf(config: GatewayConfigWire): OtelConfig {
  return (config.otel ?? {}) as OtelConfig;
}

/** Splits a saved Langfuse endpoint back into the fields its form edits. */
function langfuseOf(
  otel: OtelConfig,
): { host: string; publicKey: string; secretKey: string } | null {
  const endpoint = (otel.endpoint ?? "").replace(/\/+$/, "");
  if (!endpoint.endsWith(LANGFUSE_PATH)) {
    return null;
  }
  const host = endpoint.slice(0, -LANGFUSE_PATH.length);
  const auth = Object.entries(otel.headers ?? {}).find(
    ([key]) => key.toLowerCase() === "authorization",
  )?.[1];
  const match = /^Basic\s+(\S+)$/i.exec((auth ?? "").trim());
  if (!match) {
    return { host, publicKey: "", secretKey: "" };
  }
  const decoded = Buffer.from(match[1]!, "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  return separator < 0
    ? { host, publicKey: "", secretKey: "" }
    : {
        host,
        publicKey: decoded.slice(0, separator),
        secretKey: decoded.slice(separator + 1),
      };
}

function httpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    return value.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function headersText(headers: Record<string, string> | undefined): string {
  return Object.entries(headers ?? {})
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join(",");
}

/** myna's OpenTelemetry export, stored in the host's gateway config. */
export function OtelRows() {
  const { t } = useTranslation();
  const serverId = useSettingsHostServerId();
  const { config, save } = useGatewayConfig(serverId);
  if (config === null) {
    return (
      <SettingsRow
        label={t("settings.pages.observability.otelSection")}
        hint={t("settings.pages.actions.noHost")}
      />
    );
  }
  return <OtelEditor config={config} save={save} />;
}

function OtelEditor({
  config,
  save,
}: {
  config: GatewayConfigWire;
  save: (next: GatewayConfigWire) => Promise<GatewayConfigWire | undefined>;
}) {
  const { t } = useTranslation();
  const otel = otelOf(config);
  const savedLangfuse = langfuseOf(otel);
  const [kind, setKind] = useState<CollectorKind>(savedLangfuse ? "langfuse" : "otlp");
  const [endpoint, setEndpoint] = useState(otel.endpoint ?? "");
  const [headers, setHeaders] = useState(headersText(otel.headers));
  const [host, setHost] = useState(savedLangfuse?.host ?? "");
  const [publicKey, setPublicKey] = useState(savedLangfuse?.publicKey ?? "");
  const [secretKey, setSecretKey] = useState(savedLangfuse?.secretKey ?? "");
  const [error, setError] = useState<string | null>(null);
  const endpointInput = useRef<EditingTextInputHandle>(null);
  const headersInput = useRef<EditingTextInputHandle>(null);
  const hostInput = useRef<EditingTextInputHandle>(null);
  const publicKeyInput = useRef<EditingTextInputHandle>(null);
  const secretKeyInput = useRef<EditingTextInputHandle>(null);

  const write = useCallback(
    (next: OtelConfig) => {
      void save({ ...config, otel: { ...otelOf(config), ...next } }).catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      });
    },
    [config, save],
  );

  const toggle = useCallback((enabled: boolean) => write({ enabled }), [write]);

  const toggleMetrics = useCallback((metrics: boolean) => write({ metrics }), [write]);

  const bodyMode = bodyModeOf(otel);
  const bodyOptions = useMemo<SegmentedControlOption<BodyMode>[]>(
    () => [
      { value: "metadata", label: t("settings.pages.observability.otelBodiesMetadata") },
      { value: "limited", label: t("settings.pages.observability.otelBodiesLimited") },
      { value: "full", label: t("settings.pages.observability.otelBodiesFull") },
    ],
    [t],
  );
  const setBodyMode = useCallback(
    (mode: BodyMode) => write({ bodies: mode !== "metadata", bodiesWhole: mode === "full" }),
    [write],
  );
  const bodyHint = t(BODY_MODE_HINT[bodyMode]);

  const toggleSessions = useCallback((sessions: boolean) => write({ sessions }), [write]);

  const commitEndpoint = useCallback(() => {
    const value = (endpointInput.current?.getText() ?? endpoint).trim();
    if (value === "") {
      setError(null);
      write({ endpoint: undefined });
      return;
    }
    const parsed = httpUrl(value);
    if (parsed === null) {
      setError(t("settings.pages.observability.otelEndpointInvalid"));
      return;
    }
    setError(null);
    write({ endpoint: parsed });
  }, [endpoint, t, write]);

  const commitHeaders = useCallback(() => {
    const value = headersInput.current?.getText() ?? headers;
    const parsed: Record<string, string> = {};
    try {
      for (const part of value.split(",").filter((entry) => entry.trim().length > 0)) {
        const separator = part.indexOf("=");
        if (separator < 1) {
          throw new Error(t("settings.pages.observability.otelHeadersInvalid"));
        }
        parsed[part.slice(0, separator).trim()] = decodeURIComponent(
          part.slice(separator + 1).trim(),
        );
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return;
    }
    setError(null);
    write({ headers: parsed });
  }, [headers, t, write]);

  const commitLangfuse = useCallback(() => {
    const base = (hostInput.current?.getText() ?? host).trim().replace(/\/+$/, "");
    const pk = publicKeyInput.current?.getText().trim() ?? publicKey.trim();
    const sk = secretKeyInput.current?.getText().trim() ?? secretKey.trim();
    const bareHost = base.endsWith(LANGFUSE_PATH) ? base.slice(0, -LANGFUSE_PATH.length) : base;
    const parsed = bareHost === "" ? null : httpUrl(bareHost);
    if (parsed === null || pk === "" || sk === "") {
      setError(t("settings.pages.observability.otelLangfuseInvalid"));
      return;
    }
    setError(null);
    write({
      endpoint: `${parsed}${LANGFUSE_PATH}`,
      headers: {
        authorization: `Basic ${Buffer.from(`${pk}:${sk}`, "utf8").toString("base64")}`,
      },
    });
  }, [host, publicKey, secretKey, t, write]);

  const kindOptions: SegmentedControlOption<CollectorKind>[] = [
    { value: "otlp", label: "OTLP" },
    { value: "langfuse", label: "Langfuse" },
  ];

  return (
    <>
      <SettingsSwitch
        label={t("settings.pages.observability.otelEnabled")}
        hint={t("settings.pages.observability.otelEnabledHint")}
        value={otel.enabled === true}
        onValueChange={toggle}
      />
      <SettingsSwitch
        label={t("settings.pages.observability.otelMetrics")}
        hint={t("settings.pages.observability.otelMetricsHint")}
        value={otel.metrics === true}
        onValueChange={toggleMetrics}
      />
      <SettingsSwitch
        label={t("settings.pages.observability.otelSessions")}
        hint={t("settings.pages.observability.otelSessionsHint")}
        value={otel.sessions === true}
        onValueChange={toggleSessions}
      />
      <SettingsRow label={t("settings.pages.observability.otelBodies")} hint={bodyHint}>
        <SegmentedControl options={bodyOptions} value={bodyMode} onValueChange={setBodyMode} />
      </SettingsRow>
      <SettingsRow
        label={t("settings.pages.observability.otelKind")}
        hint={t("settings.pages.observability.otelKindHint")}
      >
        <SegmentedControl options={kindOptions} value={kind} onValueChange={setKind} />
      </SettingsRow>
      {kind === "langfuse" ? (
        <>
          <SettingsRow
            label={t("settings.pages.observability.otelHost")}
            hint={t("settings.pages.observability.otelHostHint")}
          >
            <TextInput
              ref={hostInput}
              initialValue={host}
              onChangeText={setHost}
              onBlur={commitLangfuse}
              onSubmitEditing={commitLangfuse}
              placeholder="https://cloud.langfuse.com"
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              style={styles.input}
              accessibilityLabel={t("settings.pages.observability.otelHost")}
            />
          </SettingsRow>
          <SettingsRow
            label={t("settings.pages.observability.otelPublicKey")}
            hint={t("settings.pages.observability.otelKeysHint")}
          >
            <TextInput
              ref={publicKeyInput}
              initialValue={publicKey}
              onChangeText={setPublicKey}
              onBlur={commitLangfuse}
              onSubmitEditing={commitLangfuse}
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              style={styles.input}
              accessibilityLabel={t("settings.pages.observability.otelPublicKey")}
            />
          </SettingsRow>
          <SettingsRow label={t("settings.pages.observability.otelSecretKey")}>
            <TextInput
              ref={secretKeyInput}
              initialValue={secretKey}
              onChangeText={setSecretKey}
              onBlur={commitLangfuse}
              onSubmitEditing={commitLangfuse}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              style={styles.input}
              accessibilityLabel={t("settings.pages.observability.otelSecretKey")}
            />
          </SettingsRow>
        </>
      ) : (
        <>
          <SettingsRow
            label={t("settings.pages.observability.otelEndpoint")}
            hint={t("settings.pages.observability.otelEndpointHint")}
          >
            <TextInput
              ref={endpointInput}
              initialValue={endpoint}
              onChangeText={setEndpoint}
              onBlur={commitEndpoint}
              onSubmitEditing={commitEndpoint}
              placeholder="http://localhost:4318"
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              style={styles.input}
              accessibilityLabel={t("settings.pages.observability.otelEndpoint")}
            />
          </SettingsRow>
          <SettingsRow
            label={t("settings.pages.observability.otelHeaders")}
            hint={t("settings.pages.observability.otelHeadersHint")}
          >
            <TextInput
              ref={headersInput}
              initialValue={headers}
              onChangeText={setHeaders}
              onBlur={commitHeaders}
              onSubmitEditing={commitHeaders}
              placeholder="Authorization=Bearer%20token"
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              style={styles.input}
              accessibilityLabel={t("settings.pages.observability.otelHeaders")}
            />
          </SettingsRow>
        </>
      )}
      {error !== null ? (
        <SettingsRow label={t("settings.pages.observability.otelError")} error={error} />
      ) : null}
    </>
  );
}

const styles = StyleSheet.create(() => ({
  input: { minWidth: 240 },
}));
