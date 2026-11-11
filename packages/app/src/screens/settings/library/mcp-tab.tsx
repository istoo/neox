import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type {
  LibraryMarketServer,
  LibraryMcpHealth,
  LibraryMcpServer,
  LibraryMcpSignInState,
  LibraryMcpSignInStatus,
  LibrarySnapshot,
  LibrarySyncResult,
  LibraryTransport,
} from "@neolix/protocol/library";
import type { DaemonClient } from "@neolix/client/internal/daemon-client";
import { SettingsCard } from "@/components/settings";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { PressHighlight } from "@/components/ui/press-highlight";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Switch } from "@/components/ui/switch";
import { settingsStyles } from "@/styles/settings";
import { confirmDialog } from "@/utils/confirm-dialog";
import { openExternalUrl } from "@/utils/open-external-url";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Search } from "lucide-react-native";
import { AgentChips, LibraryEmpty, LibraryIntro, LibraryRowHeader, ServerIcon } from "./library-ui";
import { LibraryEditorSheet } from "./library-editor";
import type { LibraryTabProps } from "./types";
import { useHostFeature } from "@/runtime/host-features";
import { useSettingsSubviewStore } from "@/stores/settings-subview-store";

const TRANSPORTS: LibraryTransport[] = ["stdio", "http", "sse"];

function parsePairs(
  text: string,
  separator: "=" | ":",
  invalidPair: (line: string) => string = (line) => `"${line}": write a key and a value`,
): Record<string, string> {
  const pairs: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const at = trimmed.indexOf(separator);
    if (at <= 0) {
      throw new Error(invalidPair(trimmed));
    }
    pairs[trimmed.slice(0, at).trim()] = trimmed.slice(at + 1).trim();
  }
  return pairs;
}

function pairsText(pairs: Record<string, string> | undefined, separator: string): string {
  return Object.entries(pairs ?? {})
    .map(([key, value]) => `${key}${separator}${value}`)
    .join("\n");
}

function serverLine(server: LibraryMcpServer): string {
  if (server.transport === "stdio") {
    return [server.command, ...(server.args ?? [])].join(" ");
  }
  return server.url ?? "";
}

function signInTag(
  status: LibraryMcpSignInStatus | undefined,
  dead: string,
  signedIn: string,
): { text: string; ok: boolean } | null {
  if (status === undefined) {
    return null;
  }
  if (status.dead) {
    return { text: dead, ok: false };
  }
  if (status.signedIn) {
    return { text: signedIn, ok: true };
  }
  return null;
}

function ServerRow({
  server,
  agents,
  disabled,
  onOpen,
  onToggleAgent,
}: {
  server: LibraryMcpServer;
  agents: { id: string; name: string }[];
  disabled: boolean;
  onOpen: (server: LibraryMcpServer) => void;
  onToggleAgent: (server: LibraryMcpServer, agent: string) => void;
}) {
  const { t } = useTranslation();
  const tag = signInTag(
    server.signIn,
    t("settings.usePages.library.mcp.signInDead"),
    t("settings.usePages.library.mcp.signedIn"),
  );
  const open = useCallback(() => onOpen(server), [onOpen, server]);
  const toggle = useCallback(
    (agent: string) => onToggleAgent(server, agent),
    [onToggleAgent, server],
  );
  return (
    <View style={settingsStyles.row}>
      <View style={[settingsStyles.rowContent, styles.rowBody]}>
        <PressHighlight onPress={disabled ? undefined : open} style={styles.rowText}>
          <View style={styles.nameRow}>
            <ServerIcon icon={server.icon} size={16} />
            <Text style={settingsStyles.rowTitle}>{server.name}</Text>
            {tag ? <Text style={tag.ok ? styles.badgeOk : styles.badgeBad}>{tag.text}</Text> : null}
          </View>
          <Text style={styles.mono} numberOfLines={1}>
            {serverLine(server)}
          </Text>
        </PressHighlight>
        <AgentChips
          agents={agents}
          selected={server.agents}
          disabled={disabled}
          onToggle={toggle}
        />
      </View>
    </View>
  );
}

interface ServerDraft {
  oldName: string | null;
  name: string;
  transport: LibraryTransport;
  command: string;
  argsText: string;
  envText: string;
  url: string;
  headersText: string;
  agents: string[];
  note: string;
  toolsText: string;
  startupText: string;
  oauthClientId: string;
  oauthClientSecret: string;
  oauthCallbackPort: string;
  local: boolean;
  routerDirect: boolean;
  jsonMode: boolean;
  jsonText: string;
}

function extrasFromDraft(input: ServerDraft): Partial<LibraryMcpServer> {
  const tools = input.toolsText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const startup = Number.parseInt(input.startupText.trim(), 10);
  const port = Number.parseInt(input.oauthCallbackPort.trim(), 10);
  const clientId = input.oauthClientId.trim();
  return {
    ...(input.note.trim() ? { note: input.note.trim() } : {}),
    ...(tools.length > 0 ? { disabledTools: tools } : {}),
    ...(Number.isInteger(startup) && startup >= 0 ? { startupTimeout: startup } : {}),
    ...(clientId
      ? {
          oauth: {
            clientId,
            ...(input.oauthClientSecret.trim()
              ? { clientSecret: input.oauthClientSecret.trim() }
              : {}),
            ...(Number.isInteger(port) && port > 0 ? { callbackPort: port } : {}),
          },
        }
      : {}),
    ...(input.local ? { local: true } : {}),
    ...(input.routerDirect ? { router: "direct" as const } : {}),
  };
}

function serverFromDraft(
  input: ServerDraft,
  invalidPair?: (line: string) => string,
): LibraryMcpServer {
  if (input.jsonMode) {
    const parsed = JSON.parse(input.jsonText) as LibraryMcpServer;
    return {
      ...parsed,
      agents:
        Array.isArray(parsed.agents) && parsed.agents.length > 0 ? parsed.agents : input.agents,
    };
  }
  return {
    name: input.name.trim(),
    transport: input.transport,
    agents: input.agents,
    ...(input.transport === "stdio"
      ? {
          command: input.command.trim(),
          args: input.argsText
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.length > 0),
          env: parsePairs(input.envText, "=", invalidPair),
        }
      : {
          url: input.url.trim(),
          headers: parsePairs(input.headersText, ":", invalidPair),
        }),
    ...extrasFromDraft(input),
  };
}

function oauthKey(server: LibraryMcpServer): string {
  const oauth = server.oauth;
  if (server.transport !== "http" || oauth === undefined) {
    return "";
  }
  return JSON.stringify([oauth.clientId, oauth.clientSecret ?? "", oauth.callbackPort ?? 0]);
}

/** Whether the form would save something the saved server doesn't already
 * have. Myna asks this to choose "Save and sign in" over "Sign in"
 * (library/client.js `ready.saves`); agents, note and tools don't count. */
function savesAsWritten(server: LibraryMcpServer | null, input: ServerDraft): boolean {
  if (server === null) {
    return true;
  }
  let written: LibraryMcpServer;
  try {
    written = serverFromDraft(input);
  } catch {
    return false;
  }
  return (
    written.name !== server.name ||
    written.transport !== server.transport ||
    (written.url ?? "") !== (server.url ?? "") ||
    oauthKey(written) !== oauthKey(server)
  );
}

export function McpTab({
  serverId,
  library,
  client,
  onLibrary,
  onSaved,
  onError,
  disabled,
}: LibraryTabProps) {
  const { t } = useTranslation();
  const canSignIn = useHostFeature(serverId, "libraryMcpSignin");
  const [editing, setEditing] = useState<{ server: LibraryMcpServer | null } | null>(null);
  const [marketOpen, setMarketOpen] = useState(false);
  const [marketServer, setMarketServer] = useState<string | null>(null);
  const pendingMarket = useSettingsSubviewStore((state) => state.libraryServer);
  const setPendingMarket = useSettingsSubviewStore((state) => state.setLibraryServer);

  // Another page's link (Settings › Models' libWay) asks for one market
  // server's sheet: opened here, then the request is spent.
  useEffect(() => {
    if (pendingMarket === null) {
      return;
    }
    setMarketServer(pendingMarket);
    setMarketOpen(true);
    setPendingMarket(null);
  }, [pendingMarket, setPendingMarket]);

  const agents = useMemo(
    () => library.agents.map((agent) => ({ id: agent.id, name: agent.name })),
    [library.agents],
  );

  const toggleAgent = useCallback(
    (server: LibraryMcpServer, agent: string) => {
      const next = server.agents.includes(agent)
        ? server.agents.filter((entry) => entry !== agent)
        : [...server.agents, agent];
      void (async () => {
        try {
          const result = await client.setLibraryMcpAgents(server.name, next);
          onLibrary(result.library);
          onSaved(result.result);
        } catch (error) {
          onError(error);
        }
      })();
    },
    [client, onError, onLibrary, onSaved],
  );

  // Saves without closing the sheet: "Save and sign in" needs the saved
  // server to still be in front of the user while the browser opens
  // (myna internal/gui/tests/mcp-oauth-app.test.cjs:120).
  const persist = useCallback(
    async (input: ServerDraft): Promise<string> => {
      const server = serverFromDraft(input, (line) =>
        t("settings.usePages.library.mcp.invalidPair", { line }),
      );
      const result = await client.saveLibraryMcpServer(
        server,
        input.oldName ? { oldName: input.oldName } : {},
      );
      onLibrary(result.library);
      onSaved(result.result);
      return server.name;
    },
    [client, onLibrary, onSaved, t],
  );

  const save = useCallback(
    async (input: ServerDraft) => {
      await persist(input);
      setEditing(null);
    },
    [persist],
  );

  const remove = useCallback(
    async (name: string) => {
      const confirmed = await confirmDialog({
        title: t("settings.usePages.library.common.remove"),
        message: t("settings.usePages.library.mcp.removeConfirm", { name }),
        confirmLabel: t("settings.usePages.library.common.remove"),
        cancelLabel: t("settings.usePages.library.common.cancel"),
        destructive: true,
      });
      if (!confirmed) {
        return;
      }
      try {
        const result = await client.removeLibraryMcpServer(name);
        onLibrary(result.library);
        onSaved(result.result);
        setEditing(null);
      } catch (error) {
        onError(error);
      }
    },
    [client, onError, onLibrary, onSaved, t],
  );

  const checkHealth = useCallback(
    (name: string): Promise<LibraryMcpHealth> =>
      client.checkLibraryMcpServer(name).then((r) => r.health),
    [client],
  );

  const setHub = useCallback(
    (on: boolean) => {
      void (async () => {
        try {
          const result = await client.setLibraryMcpHub(on);
          onLibrary(result.library);
          onSaved(result.result);
        } catch (error) {
          onError(error);
        }
      })();
    },
    [client, onError, onLibrary, onSaved],
  );

  const openMarket = useCallback(() => setMarketOpen(true), []);
  const closeMarket = useCallback(() => {
    setMarketOpen(false);
    setMarketServer(null);
  }, []);
  const openNewServer = useCallback(() => setEditing({ server: null }), []);
  const openServer = useCallback((server: LibraryMcpServer) => setEditing({ server }), []);
  const closeEditor = useCallback(() => setEditing(null), []);

  return (
    <View>
      <LibraryIntro>{t("settings.usePages.library.mcp.intro")}</LibraryIntro>
      <SettingsCard>
        <View style={settingsStyles.row}>
          <View style={styles.grow}>
            <Text style={settingsStyles.rowTitle}>{t("settings.usePages.library.mcp.hub")}</Text>
            <Text style={settingsStyles.rowHint}>{t("settings.usePages.library.mcp.hubHint")}</Text>
          </View>
          <Switch
            value={library.mcpHub === true}
            onValueChange={setHub}
            disabled={disabled}
            accessibilityLabel={t("settings.usePages.library.mcp.hub")}
          />
        </View>
      </SettingsCard>
      <LibraryRowHeader label={t("settings.usePages.library.tabs.mcp")} />
      {library.mcp.length === 0 ? (
        <SettingsCard>
          <LibraryEmpty
            title={t("settings.usePages.library.mcp.emptyTitle")}
            text={t("settings.usePages.library.mcp.emptyText")}
            actionLabel={t("settings.usePages.library.mcp.add")}
            onAction={openNewServer}
          />
        </SettingsCard>
      ) : (
        <SettingsCard>
          {library.mcp.map((server) => (
            <ServerRow
              key={server.name}
              server={server}
              agents={agents}
              disabled={disabled}
              onOpen={openServer}
              onToggleAgent={toggleAgent}
            />
          ))}
        </SettingsCard>
      )}
      {library.mcp.length > 0 ? (
        <View style={styles.footer}>
          <Button variant="outline" onPress={openNewServer} disabled={disabled}>
            {t("settings.usePages.library.mcp.add")}
          </Button>
          <Button variant="outline" leftIcon={Search} onPress={openMarket} disabled={disabled}>
            {t("settings.usePages.library.mcp.market")}
          </Button>
        </View>
      ) : null}

      <MarketSheet
        visible={marketOpen}
        initialServer={marketServer}
        library={library}
        client={client}
        onClose={closeMarket}
        onLibrary={onLibrary}
        onSaved={onSaved}
        onError={onError}
      />

      {editing ? (
        <ServerEditor
          key={editing.server?.name ?? "new"}
          server={editing.server}
          agents={agents}
          onClose={closeEditor}
          onSave={save}
          onSaveForSignIn={persist}
          onRemove={remove}
          checkHealth={checkHealth}
          client={client}
          onLibrary={onLibrary}
          onError={onError}
          canSignIn={canSignIn}
        />
      ) : null}
    </View>
  );
}

function MarketRow({
  server,
  onPick,
}: {
  server: LibraryMarketServer;
  onPick: (server: LibraryMarketServer) => void;
}) {
  const { t } = useTranslation();
  const pick = useCallback(() => onPick(server), [onPick, server]);
  return (
    <View style={settingsStyles.row}>
      <View style={styles.grow}>
        <View style={styles.nameRow}>
          <ServerIcon icon={server.icon} size={16} />
          <Text style={settingsStyles.rowTitle}>{server.title}</Text>
        </View>
        <Text style={settingsStyles.rowHint}>
          {server.publisher ? `${server.publisher} · ` : ""}
          {server.description}
        </Text>
      </View>
      {server.have ? (
        <Text style={styles.have}>
          {t("settings.usePages.library.mcp.marketHave", { name: server.have })}
        </Text>
      ) : (
        <Button variant="outline" onPress={pick}>
          {t("settings.usePages.library.mcp.marketAdd")}
        </Button>
      )}
    </View>
  );
}

function MarketInputField({
  input,
  onValue,
}: {
  input: LibraryMarketServer["inputs"][number];
  onValue: (key: string, value: string) => void;
}) {
  const change = useCallback((value: string) => onValue(input.key, value), [input.key, onValue]);
  return (
    <Field label={input.label} hint={input.description}>
      <FormTextInput
        initialValue=""
        onChangeText={change}
        placeholder={input.placeholder ?? (input.secret ? "•••" : "")}
        autoCapitalize="none"
        autoCorrect={false}
      />
    </Field>
  );
}

function MarketInstallForm({
  server,
  agents,
  onInstall,
  onBack,
}: {
  server: LibraryMarketServer;
  agents: { id: string; name: string }[];
  onInstall: (values: Record<string, string>, agents: string[]) => Promise<void>;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const [values, setValues] = useState<Record<string, string>>({});
  // myna's OptIn servers start with no agent picked; the rest with all.
  const [selected, setSelected] = useState<string[]>(() =>
    server.optIn ? [] : agents.map((agent) => agent.id),
  );
  const [busy, setBusy] = useState(false);
  const setValue = useCallback((key: string, value: string) => {
    setValues((current) => ({ ...current, [key]: value }));
  }, []);
  const toggleAgent = useCallback((agent: string) => {
    setSelected((current) =>
      current.includes(agent) ? current.filter((entry) => entry !== agent) : [...current, agent],
    );
  }, []);
  const install = useCallback(() => {
    setBusy(true);
    void (async () => {
      try {
        await onInstall(values, selected);
      } finally {
        setBusy(false);
      }
    })();
  }, [onInstall, selected, values]);
  return (
    <View style={styles.sheetBody}>
      <Text style={settingsStyles.rowTitle}>{server.title}</Text>
      <Text style={settingsStyles.rowHint}>{server.description}</Text>
      {server.inputs.map((input) => (
        <MarketInputField key={input.key} input={input} onValue={setValue} />
      ))}
      <Field label={t("settings.usePages.library.mcp.agents")}>
        <AgentChips agents={agents} selected={selected} onToggle={toggleAgent} />
      </Field>
      <View style={styles.installActions}>
        <Button variant="secondary" onPress={onBack} disabled={busy}>
          {t("settings.usePages.library.common.cancel")}
        </Button>
        <Button variant="default" onPress={install} disabled={busy}>
          {t("settings.usePages.library.mcp.marketAdd")}
        </Button>
      </View>
    </View>
  );
}

function MarketSheet({
  visible,
  initialServer,
  library,
  client,
  onClose,
  onLibrary,
  onSaved,
  onError,
}: {
  visible: boolean;
  /** A server another page asked for: its sheet opens over the list. */
  initialServer?: string | null;
  library: LibrarySnapshot;
  client: DaemonClient;
  onClose: () => void;
  onLibrary: (library: LibrarySnapshot) => void;
  onSaved: (result: LibrarySyncResult) => void;
  onError: (error: unknown) => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [servers, setServers] = useState<LibraryMarketServer[] | null>(null);
  const [registryError, setRegistryError] = useState<string | null>(null);
  const [picked, setPicked] = useState<LibraryMarketServer | null>(null);
  const [busy, setBusy] = useState(false);
  const header = useMemo<SheetHeader>(
    () => ({ title: t("settings.usePages.library.mcp.market") }),
    [t],
  );
  const agents = useMemo(
    () => library.agents.map((agent) => ({ id: agent.id, name: agent.name })),
    [library.agents],
  );
  const search = useCallback(() => {
    setBusy(true);
    void (async () => {
      try {
        const result = await client.searchLibraryMarket(query);
        setServers(result.servers);
        setRegistryError(result.error ?? null);
      } catch (error) {
        onError(error);
      } finally {
        setBusy(false);
      }
    })();
  }, [client, onError, query]);
  // A server sent from Settings › Models: found by its name and opened, so
  // the user picks the agents and confirms (myna's library "server" call).
  useEffect(() => {
    if (!visible || !initialServer) {
      return;
    }
    let cancelled = false;
    setBusy(true);
    void (async () => {
      try {
        const result = await client.searchLibraryMarket(initialServer);
        if (cancelled) {
          return;
        }
        setServers(result.servers);
        setRegistryError(result.error ?? null);
        setPicked(
          result.servers.find(
            (entry) => entry.name === initialServer || entry.id === initialServer,
          ) ?? null,
        );
      } catch (error) {
        if (!cancelled) {
          onError(error);
        }
      } finally {
        if (!cancelled) {
          setBusy(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, initialServer, onError, visible]);

  const install = useCallback(
    async (values: Record<string, string>, selected: string[]) => {
      if (!picked) {
        return;
      }
      try {
        const result = await client.installLibraryMarketServer(picked.id, values, selected);
        onLibrary(result.library);
        onSaved(result.result);
        onClose();
      } catch (error) {
        onError(error);
      }
    },
    [client, onClose, onError, onLibrary, onSaved, picked],
  );
  const back = useCallback(() => setPicked(null), []);
  const close = useCallback(() => {
    setPicked(null);
    setServers(null);
    onClose();
  }, [onClose]);

  let list: ReactNode = null;
  if (servers !== null) {
    list =
      servers.length === 0 ? (
        <Text style={styles.hint}>{t("settings.usePages.library.mcp.marketEmpty")}</Text>
      ) : (
        <View>
          {servers.map((server) => (
            <MarketRow key={`${server.id}:${server.name}`} server={server} onPick={setPicked} />
          ))}
        </View>
      );
  }

  let content: ReactNode;
  if (picked?.have) {
    // Already in the library: myna says so and offers no Add.
    content = (
      <View style={styles.sheetBody}>
        <Text style={settingsStyles.rowTitle}>{picked.title}</Text>
        <Text style={settingsStyles.rowHint}>
          {t("settings.usePages.library.mcp.marketHave", { name: picked.have })}
        </Text>
        <Button variant="secondary" onPress={close}>
          {t("settings.usePages.library.common.cancel")}
        </Button>
      </View>
    );
  } else if (picked) {
    content = (
      <MarketInstallForm
        key={picked.id}
        server={picked}
        agents={agents}
        onInstall={install}
        onBack={back}
      />
    );
  } else {
    content = (
      <View style={styles.sheetBody}>
        <Field label={t("settings.usePages.library.mcp.marketSearch")}>
          <FormTextInput
            initialValue=""
            onChangeText={setQuery}
            placeholder={t("settings.usePages.library.mcp.marketPlaceholder")}
            autoCapitalize="none"
            autoCorrect={false}
          />
        </Field>
        <Button variant="outline" onPress={search} disabled={busy}>
          {t("settings.usePages.library.mcp.marketSearch")}
        </Button>
        {registryError ? (
          <Text style={styles.hint}>
            {t("settings.usePages.library.mcp.marketRegistryError", { error: registryError })}
          </Text>
        ) : null}
        {list}
        <Button variant="secondary" onPress={close}>
          {t("settings.usePages.library.common.cancel")}
        </Button>
      </View>
    );
  }
  return (
    <AdaptiveModalSheet visible={visible} header={header} onClose={close}>
      {content}
    </AdaptiveModalSheet>
  );
}

function McpExtrasFields({
  note,
  setNote,
  toolsText,
  setToolsText,
  startupText,
  setStartupText,
  oauthClientId,
  setOauthClientId,
  oauthClientSecret,
  setOauthClientSecret,
  oauthCallbackPort,
  setOauthCallbackPort,
}: {
  note: string;
  setNote: (value: string) => void;
  toolsText: string;
  setToolsText: (value: string) => void;
  startupText: string;
  setStartupText: (value: string) => void;
  oauthClientId: string;
  setOauthClientId: (value: string) => void;
  oauthClientSecret: string;
  setOauthClientSecret: (value: string) => void;
  oauthCallbackPort: string;
  setOauthCallbackPort: (value: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <Field label={t("settings.usePages.library.mcp.note")}>
        <FormTextInput
          initialValue={note}
          onChangeText={setNote}
          placeholder={t("settings.usePages.library.mcp.notePlaceholder")}
          autoCorrect={false}
        />
      </Field>
      <Field
        label={t("settings.usePages.library.mcp.disabledTools")}
        hint={t("settings.usePages.library.mcp.disabledToolsHint")}
      >
        <FormTextInput
          initialValue={toolsText}
          onChangeText={setToolsText}
          multiline
          autoCapitalize="none"
          autoCorrect={false}
          style={styles.smallArea}
        />
      </Field>
      <Field label={t("settings.usePages.library.mcp.startupTimeout")}>
        <FormTextInput
          initialValue={startupText}
          onChangeText={setStartupText}
          placeholder="30"
          autoCorrect={false}
        />
      </Field>
      <Field label={t("settings.usePages.library.mcp.oauth")}>
        <View style={styles.oauthFields}>
          <FormTextInput
            initialValue={oauthClientId}
            onChangeText={setOauthClientId}
            placeholder={t("settings.usePages.library.mcp.oauthClientId")}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <FormTextInput
            initialValue={oauthClientSecret}
            onChangeText={setOauthClientSecret}
            placeholder={t("settings.usePages.library.mcp.oauthClientSecret")}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <FormTextInput
            initialValue={oauthCallbackPort}
            onChangeText={setOauthCallbackPort}
            placeholder={t("settings.usePages.library.mcp.oauthCallbackPort")}
            autoCorrect={false}
          />
        </View>
      </Field>
    </>
  );
}

function draftFields(server: LibraryMcpServer | null) {
  return {
    name: server?.name ?? "",
    transport: server?.transport ?? "stdio",
    command: server?.command ?? "",
    argsText: (server?.args ?? []).join("\n"),
    envText: pairsText(server?.env, "="),
    url: server?.url ?? "",
    headersText: pairsText(server?.headers, ":"),
    selected: server?.agents ?? [],
    jsonText: JSON.stringify(server ?? {}, null, 2),
  };
}

function draftExtras(server: LibraryMcpServer | null) {
  const startup = server?.startupTimeout;
  const port = server?.oauth?.callbackPort;
  return {
    note: server?.note ?? "",
    toolsText: (server?.disabledTools ?? []).join("\n"),
    startupText: startup ? String(startup) : "",
    oauthClientId: server?.oauth?.clientId ?? "",
    oauthClientSecret: server?.oauth?.clientSecret ?? "",
    oauthCallbackPort: port ? String(port) : "",
    local: server?.local === true,
    routerDirect: server?.router === "direct",
  };
}

function draftFrom(server: LibraryMcpServer | null) {
  return { ...draftFields(server), ...draftExtras(server) };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Neolix's OAuth sign-in to a remote MCP server: signed in once here, and
 * every agent given the server reaches it through Neolix (myna
 * internal/gui/assets/plugins/library/client.js:2507, signInBox).
 */
function McpSignInControl({
  client,
  onLibrary,
  onError,
  name,
  status: initialStatus,
  saveFirst,
}: {
  /** The server's name; for a new server, the name in the form. */
  name: string;
  status?: LibraryMcpSignInStatus;
  client: DaemonClient;
  onLibrary: (library: LibrarySnapshot) => void;
  onError: (error: unknown) => void;
  /** Saves the form and returns the saved name, for "Save and sign in". */
  saveFirst?: () => Promise<string | null>;
}) {
  const { t } = useTranslation();
  const [signing, setSigning] = useState<LibraryMcpSignInState | null>(null);
  const [status, setStatus] = useState(initialStatus);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  // The flow to end if the sheet closes while the browser is still open.
  const currentId = useRef<string | null>(null);

  useEffect(
    () => () => {
      alive.current = false;
      const id = currentId.current;
      if (id !== null) {
        void client.cancelLibraryMcpSignIn(id).catch(() => undefined);
      }
    },
    [client],
  );

  const follow = useCallback(
    async (id: string) => {
      for (;;) {
        await delay(800);
        if (!alive.current) {
          return;
        }
        let state: LibraryMcpSignInState | undefined;
        try {
          state = (await client.libraryMcpSignInStatus(id)).state;
        } catch {
          continue;
        }
        if (!alive.current) {
          return;
        }
        if (state === undefined || state.state === "waiting") {
          continue;
        }
        setSigning(null);
        currentId.current = null;
        if (state.state === "done") {
          setStatus({ signedIn: true });
          const library = await client.getLibrary().catch(() => null);
          if (library !== null && alive.current) {
            onLibrary(library.library);
          }
        } else if (state.state === "failed") {
          setError(state.error ?? "");
        }
        return;
      }
    },
    [client, onLibrary],
  );

  const start = useCallback(
    async (target: string) => {
      setError(null);
      setSigning({ id: "", server: target, state: "waiting" });
      try {
        const { state } = await client.signInLibraryMcpServer(target);
        if (!alive.current) {
          return;
        }
        setSigning(state);
        currentId.current = state.id;
        if (state.url !== undefined) {
          await openExternalUrl(state.url).catch(() => undefined);
        }
        if (state.state === "done") {
          setSigning(null);
          currentId.current = null;
          setStatus({ signedIn: true });
          const library = await client.getLibrary().catch(() => null);
          if (library !== null && alive.current) {
            onLibrary(library.library);
          }
          return;
        }
        if (state.state === "failed") {
          setSigning(null);
          currentId.current = null;
          setError(state.error ?? "");
          return;
        }
        await follow(state.id);
      } catch (failure) {
        if (alive.current) {
          setSigning(null);
          currentId.current = null;
          onError(failure);
        }
      }
    },
    [client, follow, onError, onLibrary],
  );

  const signIn = useCallback(() => {
    void (async () => {
      let target = name;
      if (saveFirst !== undefined) {
        setError(null);
        setSigning({ id: "", server: name, state: "waiting" });
        try {
          const saved = await saveFirst();
          if (!alive.current) {
            return;
          }
          if (saved === null) {
            setSigning(null);
            return;
          }
          target = saved;
        } catch (failure) {
          if (alive.current) {
            setSigning(null);
            onError(failure);
          }
          return;
        }
      }
      await start(target);
    })();
  }, [name, onError, saveFirst, start]);

  const cancel = useCallback(() => {
    const id = signing?.id;
    setSigning(null);
    currentId.current = null;
    if (id) {
      void client.cancelLibraryMcpSignIn(id).catch(() => undefined);
    }
  }, [client, signing?.id]);

  const signOut = useCallback(() => {
    void (async () => {
      try {
        const result = await client.signOutLibraryMcpServer(name);
        if (!alive.current) {
          return;
        }
        setStatus(undefined);
        onLibrary(result.library);
      } catch (failure) {
        if (alive.current) {
          onError(failure);
        }
      }
    })();
  }, [client, name, onError, onLibrary]);

  let signInLabel = t("settings.usePages.library.mcp.signIn");
  if (status?.dead) {
    signInLabel = t("settings.usePages.library.mcp.signInAgain");
  }
  if (saveFirst !== undefined) {
    signInLabel = t("settings.usePages.library.mcp.saveAndSignIn");
  }
  let body: ReactNode;
  if (signing !== null) {
    body = (
      <>
        <Text style={styles.signInNote}>
          {signing.id === ""
            ? t("settings.usePages.library.mcp.signInStarting")
            : t("settings.usePages.library.mcp.signInWaiting")}
        </Text>
        <Button variant="outline" onPress={cancel}>
          {t("settings.usePages.library.common.cancel")}
        </Button>
        {signing.url ? <Text style={styles.mono}>{signing.url}</Text> : null}
      </>
    );
  } else if (status?.signedIn && !status.dead) {
    body = (
      <>
        <Text style={styles.healthOk}>{t("settings.usePages.library.mcp.signedIn")}</Text>
        <Text style={styles.signInNote}>{t("settings.usePages.library.mcp.signedInHint")}</Text>
        <Button variant="outline" onPress={signOut}>
          {t("settings.usePages.library.mcp.signOut")}
        </Button>
      </>
    );
  } else {
    body = (
      <>
        {status?.dead ? (
          <Text style={styles.healthBad}>{t("settings.usePages.library.mcp.signInDead")}</Text>
        ) : null}
        <Button variant="outline" onPress={signIn}>
          {signInLabel}
        </Button>
      </>
    );
  }
  return (
    <View style={styles.signIn}>
      {body}
      {error ? <Text style={styles.healthBad}>{error}</Text> : null}
    </View>
  );
}

/** The sign-in line the editor shows: the saved server's state, or "Save
 * and sign in" while the server is still being added or has edits. */
function ServerSignIn({
  server,
  name,
  transport,
  canSignIn,
  client,
  onLibrary,
  onError,
  saves,
  saveForSignIn,
}: {
  server: LibraryMcpServer | null;
  name: string;
  transport: LibraryTransport;
  canSignIn?: boolean;
  client: DaemonClient;
  onLibrary: (library: LibrarySnapshot) => void;
  onError: (error: unknown) => void;
  saves: boolean;
  saveForSignIn: () => Promise<string | null>;
}) {
  if (canSignIn !== true || transport === "stdio" || (server === null && name.trim() === "")) {
    return null;
  }
  return (
    <McpSignInControl
      name={server?.name ?? name.trim()}
      {...(server?.signIn ? { status: server.signIn } : {})}
      client={client}
      onLibrary={onLibrary}
      onError={onError}
      {...(saves ? { saveFirst: saveForSignIn } : {})}
    />
  );
}

function ServerEditor({
  server,
  agents,
  onClose,
  onSave,
  onSaveForSignIn,
  onRemove,
  checkHealth,
  client,
  onLibrary,
  onError,
  canSignIn,
}: {
  server: LibraryMcpServer | null;
  agents: { id: string; name: string }[];
  onClose: () => void;
  onSave: (input: ServerDraft) => Promise<void>;
  /** Saves the form without closing the sheet, for "Save and sign in". */
  onSaveForSignIn: (input: ServerDraft) => Promise<string>;
  onRemove: (name: string) => Promise<void>;
  checkHealth: (name: string) => Promise<LibraryMcpHealth>;
  client: DaemonClient;
  onLibrary: (library: LibrarySnapshot) => void;
  onError: (error: unknown) => void;
  canSignIn?: boolean;
}) {
  const { t } = useTranslation();
  const initial = useMemo(() => draftFrom(server), [server]);
  const [name, setName] = useState(initial.name);
  const [transport, setTransport] = useState<LibraryTransport>(initial.transport);
  const [command, setCommand] = useState(initial.command);
  const [argsText, setArgsText] = useState(initial.argsText);
  const [envText, setEnvText] = useState(initial.envText);
  const [url, setUrl] = useState(initial.url);
  const [headersText, setHeadersText] = useState(initial.headersText);
  const [selected, setSelected] = useState<string[]>(initial.selected);
  const [note, setNote] = useState(initial.note);
  const [toolsText, setToolsText] = useState(initial.toolsText);
  const [startupText, setStartupText] = useState(initial.startupText);
  const [oauthClientId, setOauthClientId] = useState(initial.oauthClientId);
  const [oauthClientSecret, setOauthClientSecret] = useState(initial.oauthClientSecret);
  const [oauthCallbackPort, setOauthCallbackPort] = useState(initial.oauthCallbackPort);
  const [local, setLocal] = useState(initial.local);
  const [routerDirect, setRouterDirect] = useState(initial.routerDirect);
  const [jsonMode, setJsonMode] = useState(false);
  const [jsonText, setJsonText] = useState(initial.jsonText);
  const [health, setHealth] = useState<LibraryMcpHealth | null>(null);
  const [testing, setTesting] = useState(false);

  const modeOptions = useMemo(
    () => [
      { value: "form", label: t("settings.usePages.library.mcp.form") },
      { value: "json", label: t("settings.usePages.library.mcp.json") },
    ],
    [t],
  );
  const mode = jsonMode ? "json" : "form";
  const setMode = useCallback((value: string) => setJsonMode(value === "json"), []);

  const transportOptions = useMemo(
    () =>
      TRANSPORTS.map((value) => ({
        value,
        label: t(`settings.usePages.library.mcp.${value}`),
      })),
    [t],
  );

  const toggleAgent = useCallback((agent: string) => {
    setSelected((current) =>
      current.includes(agent) ? current.filter((entry) => entry !== agent) : [...current, agent],
    );
  }, []);

  const draftOf = useCallback(
    (): ServerDraft => ({
      oldName: server?.name ?? null,
      name,
      transport,
      command,
      argsText,
      envText,
      url,
      headersText,
      agents: selected,
      note,
      toolsText,
      startupText,
      oauthClientId,
      oauthClientSecret,
      oauthCallbackPort,
      local,
      routerDirect,
      jsonMode,
      jsonText,
    }),
    [
      argsText,
      command,
      envText,
      headersText,
      jsonMode,
      jsonText,
      local,
      name,
      note,
      oauthCallbackPort,
      oauthClientId,
      oauthClientSecret,
      routerDirect,
      selected,
      server?.name,
      startupText,
      toolsText,
      transport,
      url,
    ],
  );

  const save = useCallback(() => onSave(draftOf()), [draftOf, onSave]);

  // "Save and sign in": the server is saved first, then its sign-in starts
  // without the sheet closing; cancelling the sign-in keeps what was saved
  // (myna mcp-editor-cancel.test.cjs:9).
  const saveForSignIn = useCallback(async (): Promise<string | null> => {
    const draft = draftOf();
    if (serverFromDraft(draft).name.trim() === "") {
      return null;
    }
    await onSaveForSignIn(draft);
    return serverFromDraft(draft).name;
  }, [draftOf, onSaveForSignIn]);

  const saves = savesAsWritten(server, draftOf());

  const test = useCallback(() => {
    if (!server) {
      return;
    }
    setTesting(true);
    void (async () => {
      try {
        setHealth(await checkHealth(server.name));
      } finally {
        setTesting(false);
      }
    })();
  }, [checkHealth, server]);

  const removeCurrent = useCallback(() => {
    if (server) {
      void onRemove(server.name);
    }
  }, [onRemove, server]);

  return (
    <LibraryEditorSheet
      visible
      title={
        server
          ? t("settings.usePages.library.mcp.editorEdit")
          : t("settings.usePages.library.mcp.editorAdd")
      }
      onClose={onClose}
      onSave={save}
      removeLabel={server ? t("settings.usePages.library.common.remove") : undefined}
      onRemove={server ? removeCurrent : undefined}
      saveDisabled={!jsonMode && name.trim().length === 0}
    >
      <Field label={t("settings.usePages.library.mcp.editorMode")}>
        <SegmentedControl options={modeOptions} value={mode} onValueChange={setMode} />
      </Field>
      {jsonMode ? (
        <Field
          label={t("settings.usePages.library.mcp.json")}
          hint={t("settings.usePages.library.mcp.jsonHint")}
        >
          <FormTextInput
            initialValue={jsonText}
            onChangeText={setJsonText}
            multiline
            autoCapitalize="none"
            autoCorrect={false}
            style={styles.jsonArea}
          />
        </Field>
      ) : (
        <>
          <Field label={t("settings.usePages.library.mcp.name")}>
            <FormTextInput
              initialValue={name}
              onChangeText={setName}
              placeholder={t("settings.usePages.library.mcp.namePlaceholder")}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </Field>
          <Field label={t("settings.usePages.library.mcp.transport")}>
            <SegmentedControl
              options={transportOptions}
              value={transport}
              onValueChange={setTransport}
            />
          </Field>
          {transport === "stdio" ? (
            <>
              <Field label={t("settings.usePages.library.mcp.command")}>
                <FormTextInput
                  initialValue={command}
                  onChangeText={setCommand}
                  placeholder={t("settings.usePages.library.mcp.commandPlaceholder")}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
              </Field>
              <Field label={t("settings.usePages.library.mcp.args")}>
                <FormTextInput
                  initialValue={argsText}
                  onChangeText={setArgsText}
                  placeholder={t("settings.usePages.library.mcp.argsPlaceholder")}
                  multiline
                  autoCapitalize="none"
                  autoCorrect={false}
                  style={styles.smallArea}
                />
              </Field>
              <Field label={t("settings.usePages.library.mcp.env")}>
                <FormTextInput
                  initialValue={envText}
                  onChangeText={setEnvText}
                  placeholder={t("settings.usePages.library.mcp.envPlaceholder")}
                  multiline
                  autoCapitalize="none"
                  autoCorrect={false}
                  style={styles.smallArea}
                />
              </Field>
            </>
          ) : (
            <>
              <Field label={t("settings.usePages.library.mcp.url")}>
                <FormTextInput
                  initialValue={url}
                  onChangeText={setUrl}
                  placeholder={t("settings.usePages.library.mcp.urlPlaceholder")}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
              </Field>
              <Field label={t("settings.usePages.library.mcp.headers")}>
                <FormTextInput
                  initialValue={headersText}
                  onChangeText={setHeadersText}
                  placeholder={t("settings.usePages.library.mcp.headersPlaceholder")}
                  multiline
                  autoCapitalize="none"
                  autoCorrect={false}
                  style={styles.smallArea}
                />
              </Field>
            </>
          )}
          <McpExtrasFields
            note={note}
            setNote={setNote}
            toolsText={toolsText}
            setToolsText={setToolsText}
            startupText={startupText}
            setStartupText={setStartupText}
            oauthClientId={oauthClientId}
            setOauthClientId={setOauthClientId}
            oauthClientSecret={oauthClientSecret}
            setOauthClientSecret={setOauthClientSecret}
            oauthCallbackPort={oauthCallbackPort}
            setOauthCallbackPort={setOauthCallbackPort}
          />
          <View style={settingsStyles.row}>
            <View style={styles.grow}>
              <Text style={settingsStyles.rowTitle}>
                {t("settings.usePages.library.actions.local")}
              </Text>
              <Text style={settingsStyles.rowHint}>
                {t("settings.usePages.library.actions.localHint")}
              </Text>
            </View>
            <Switch
              value={local}
              onValueChange={setLocal}
              accessibilityLabel={t("settings.usePages.library.actions.local")}
            />
          </View>
          <View style={settingsStyles.row}>
            <View style={styles.grow}>
              <Text style={settingsStyles.rowTitle}>
                {t("settings.usePages.library.actions.direct")}
              </Text>
              <Text style={settingsStyles.rowHint}>
                {t("settings.usePages.library.actions.directHint")}
              </Text>
            </View>
            <Switch
              value={routerDirect}
              onValueChange={setRouterDirect}
              accessibilityLabel={t("settings.usePages.library.actions.direct")}
            />
          </View>
        </>
      )}
      <Field
        label={t("settings.usePages.library.mcp.agents")}
        hint={t("settings.usePages.library.mcp.agentsHint")}
      >
        <AgentChips agents={agents} selected={selected} onToggle={toggleAgent} />
      </Field>
      {server ? (
        <View style={styles.health}>
          <Button variant="outline" onPress={test} disabled={testing}>
            {testing
              ? t("settings.usePages.library.mcp.testing")
              : t("settings.usePages.library.mcp.test")}
          </Button>
          {health ? (
            <Text style={health.ok ? styles.healthOk : styles.healthBad}>
              {health.ok
                ? t("settings.usePages.library.mcp.healthOk", {
                    count: health.tools.length,
                    ms: health.ms,
                  })
                : t("settings.usePages.library.mcp.healthBad", {
                    error: health.error ?? "",
                  })}
            </Text>
          ) : null}
          {health?.tools.length ? <Text style={styles.mono}>{health.tools.join(", ")}</Text> : null}
        </View>
      ) : null}
      <ServerSignIn
        server={server}
        name={name}
        transport={transport}
        canSignIn={canSignIn}
        client={client}
        onLibrary={onLibrary}
        onError={onError}
        saves={saves}
        saveForSignIn={saveForSignIn}
      />
    </LibraryEditorSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  rowBody: {
    gap: theme.spacing[2],
  },
  rowText: {
    flex: 1,
  },
  mono: {
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
    marginTop: 2,
  },
  footer: {
    marginTop: theme.spacing[3],
    marginLeft: theme.spacing[1],
    alignItems: "flex-start",
  },
  smallArea: {
    minHeight: 88,
    textAlignVertical: "top",
  },
  jsonArea: {
    minHeight: 240,
    textAlignVertical: "top",
  },
  oauthFields: {
    gap: theme.spacing[2],
  },
  health: {
    gap: theme.spacing[2],
  },
  healthOk: {
    color: theme.colors.statusSuccess,
    fontSize: theme.fontSize.sm,
  },
  healthBad: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.sm,
  },
  signIn: {
    gap: theme.spacing[2],
    marginTop: theme.spacing[3],
    paddingTop: theme.spacing[3],
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border,
    alignItems: "flex-start",
  },
  signInNote: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  badgeOk: {
    color: theme.colors.statusSuccess,
    fontSize: theme.fontSize.sm,
  },
  badgeBad: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.sm,
  },
  grow: {
    flex: 1,
    gap: theme.spacing[0.5],
  },
  nameRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
  },
  have: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  installActions: {
    flexDirection: "row",
    gap: theme.spacing[2],
  },
  sheetBody: {
    gap: theme.spacing[3],
    paddingBottom: theme.spacing[2],
  },
  hint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
