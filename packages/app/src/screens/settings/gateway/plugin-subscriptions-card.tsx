import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { SessionOutboundMessage } from "@neolix/protocol/messages";
import { Button } from "@/components/ui/button";
import { FormTextInput } from "@/components/ui/form-field";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { settingsStyles } from "@/styles/settings";
import { openExternalUrl } from "@/utils/open-external-url";

type Provider = Extract<
  SessionOutboundMessage,
  { type: "gateway.plugin.subscription.list.response" }
>["payload"]["providers"][number];

interface PendingSignIn {
  provider: Provider;
  token: string;
  url?: string;
  instructions?: string;
}

/**
 * Vendors running plugins sign in to: each method the plugin declares is a
 * button, and a device flow's page is followed until the plugin reports the
 * account signed in. The plugin keeps the sign-in itself; Neolix only starts
 * it and polls.
 */
export function PluginSubscriptionsCard({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const supported = useHostFeature(serverId, "gatewayPluginSubscriptions");
  const client = useHostRuntimeClient(serverId);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [pending, setPending] = useState<PendingSignIn | null>(null);
  const [form, setForm] = useState<{ provider: Provider; method: number } | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [signedIn, setSignedIn] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!supported || client === null) {
      return;
    }
    let cancelled = false;
    void client
      .getGatewayPluginSubscriptions()
      .then((payload) => {
        if (!cancelled) setProviders(payload.providers);
        return undefined;
      })
      .catch(() => {
        // An older daemon, or a read that failed: the card stays hidden.
      });
    return () => {
      cancelled = true;
    };
  }, [client, supported]);

  const pendingToken = pending?.token ?? "";
  const pendingProvider = pending?.provider;
  useEffect(() => {
    if (client === null || pendingToken === "" || pendingProvider === undefined) {
      return;
    }
    let stopped = false;
    const timer = setInterval(() => {
      void (async () => {
        try {
          const poll = await client.pollGatewayPluginSubscriptionSignIn({
            pluginId: pendingProvider.pluginId,
            providerId: pendingProvider.id,
            token: pendingToken,
          });
          if (stopped || poll.status !== "signed_in") return;
          setPending(null);
          setSignedIn(pendingProvider.id);
        } catch (cause) {
          if (stopped) return;
          setPending(null);
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      })();
    }, 1_000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [client, pendingProvider, pendingToken]);

  const signIn = useCallback(
    (provider: Provider, method: number, inputs: Record<string, string>) => {
      if (client === null || busy) return;
      setBusy(true);
      setError(null);
      setSignedIn(null);
      setForm(null);
      void client
        .signInGatewayPluginSubscription({
          pluginId: provider.pluginId,
          providerId: provider.id,
          method,
          accountId: provider.id,
          inputs,
        })
        .then((answer) => {
          if (answer.status !== "pending") {
            setSignedIn(provider.id);
            return;
          }
          if (answer.token === undefined) {
            setError(t("settings.gatewayPages.providers.subFailed"));
            return;
          }
          setPending({
            provider,
            token: answer.token,
            ...(answer.url === undefined ? {} : { url: answer.url }),
            ...(answer.instructions === undefined ? {} : { instructions: answer.instructions }),
          });
          return;
        })
        .catch((cause: unknown) => {
          setError(cause instanceof Error ? cause.message : String(cause));
        })
        .finally(() => setBusy(false));
    },
    [busy, client, t],
  );

  const start = useCallback(
    (provider: Provider, method: number) => {
      const prompts = provider.methods[method]?.prompts ?? [];
      if (prompts.length > 0) {
        setValues({});
        setForm({ provider, method });
        return;
      }
      signIn(provider, method, {});
    },
    [signIn],
  );

  const setValue = useCallback((key: string, value: string) => {
    setValues((current) => ({ ...current, [key]: value }));
  }, []);

  const submitForm = useCallback(() => {
    if (form !== null) signIn(form.provider, form.method, values);
  }, [form, signIn, values]);

  const cancelForm = useCallback(() => {
    setForm(null);
    setValues({});
  }, []);

  const open = useCallback(() => {
    if (pending?.url !== undefined) void openExternalUrl(pending.url);
  }, [pending]);

  if (!supported || providers.length === 0) {
    return null;
  }

  return (
    <View style={[settingsStyles.card, styles.card]}>
      {providers.map((provider) => (
        <View key={`${provider.pluginId}/${provider.id}`} style={styles.row}>
          <View style={styles.main}>
            <Text style={styles.user} numberOfLines={1}>
              {provider.label}
            </Text>
            <Text style={styles.hint} numberOfLines={1}>
              {`${provider.pluginId}/${provider.id} · ${provider.protocol}`}
            </Text>
          </View>
          <View style={styles.methods}>
            {provider.methods.map((method, index) => (
              <MethodButton
                key={`${method.type}/${method.label}`}
                provider={provider}
                method={method}
                index={index}
                busy={busy}
                onStart={start}
              />
            ))}
          </View>
        </View>
      ))}
      {form === null ? null : (
        <View style={styles.pending}>
          {(form.provider.methods[form.method]?.prompts ?? []).map((prompt) => (
            <PromptInput
              key={prompt.key}
              prompt={prompt}
              value={values[prompt.key] ?? ""}
              onChange={setValue}
            />
          ))}
          <View style={styles.methods}>
            <Button size="sm" disabled={busy} onPress={submitForm}>
              {form.provider.methods[form.method]?.label}
            </Button>
            <Button variant="ghost" size="sm" onPress={cancelForm}>
              {t("settings.gatewayPages.providers.subCancel")}
            </Button>
          </View>
        </View>
      )}
      {pending === null ? null : (
        <View style={styles.pending}>
          <Text style={styles.hint}>
            {t("settings.gatewayPages.providers.subWaiting", { name: pending.provider.label })}
          </Text>
          {pending.instructions === undefined ? null : (
            <Text style={styles.hint}>{pending.instructions}</Text>
          )}
          {pending.url === undefined ? null : (
            <Button variant="ghost" size="sm" onPress={open}>
              {t("settings.gatewayPages.providers.subOpen")}
            </Button>
          )}
        </View>
      )}
      {signedIn === null ? null : (
        <Text style={styles.hint}>
          {t("settings.gatewayPages.providers.subDone", { user: signedIn })}
        </Text>
      )}
      {error === null ? null : <Text style={styles.error}>{error}</Text>}
    </View>
  );
}

function PromptInput({
  prompt,
  value,
  onChange,
}: {
  prompt: NonNullable<Provider["methods"][number]["prompts"]>[number];
  value: string;
  onChange: (key: string, value: string) => void;
}) {
  const change = useCallback((text: string) => onChange(prompt.key, text), [onChange, prompt.key]);
  return (
    <FormTextInput
      size="sm"
      initialValue={value}
      onChangeText={change}
      placeholder={prompt.placeholder ?? prompt.message}
      accessibilityLabel={prompt.message}
    />
  );
}

function MethodButton({
  provider,
  method,
  index,
  busy,
  onStart,
}: {
  provider: Provider;
  method: Provider["methods"][number];
  index: number;
  busy: boolean;
  onStart: (provider: Provider, method: number) => void;
}) {
  const press = useCallback(() => onStart(provider, index), [index, onStart, provider]);
  return (
    <Button variant="ghost" size="sm" disabled={busy} onPress={press}>
      {method.label}
    </Button>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: {
    gap: theme.spacing[3],
    padding: theme.spacing[4],
  },
  row: {
    alignItems: "center",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[3],
    justifyContent: "space-between",
  },
  main: { flex: 1, gap: theme.spacing[1], minWidth: 140 },
  user: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
  hint: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  methods: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[2] },
  pending: { gap: theme.spacing[2] },
  error: { color: theme.colors.statusDanger, fontSize: theme.fontSize.sm },
}));
