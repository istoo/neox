// FILE: LibraryMcpPanel.tsx
// Purpose: The Library MCP parts of Settings › MCP › Servers: the server list with per-agent
//   access and the server editor (stdio/http/sse, args/env/headers, disabled tools, startup,
//   OAuth, health, sign-in/sign-out), plus the hub switch, market, discover and backups.
// Layer: Settings UI components

import type {
  LibraryMcpHealth,
  LibraryMcpServer,
  LibraryMcpSignInState,
  LibraryMcpSignInStatus,
  LibraryMutationResult,
  LibraryTransport,
} from "@synara/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Switch } from "~/components/ui/switch";
import { Textarea } from "~/components/ui/textarea";
import { toastManager } from "~/components/ui/toast";
import { cn } from "~/lib/utils";
import {
  applyLibraryMutation,
  NEOLIX_LIBRARY_QUERY_KEY,
  useNeolixLibrary,
} from "~/lib/neolixLibraryQuery";
import { neolixLibraryApi } from "~/lib/neolixLibraryClient";
import { MCP_CONNECTORS_QUERY_KEY } from "~/lib/mcpConnectorsReactQuery";
import { localizeLibraryError } from "~/lib/errorLocalization";
import { ensureNativeApi } from "~/nativeApi";
import { useTranslation } from "~/i18n";
import { LibraryBackupsDialog } from "./LibraryBackupsDialog";
import { LibraryDiscoverDialog } from "./LibraryDiscoverDialog";
import { LibraryMcpMarketDialog } from "./LibraryMcpMarketDialog";
import {
  LibraryAgentChips,
  LibraryEditorDialog,
  LibraryErrorState,
  LibraryField,
} from "./LibraryShared";
import { SettingsRow, SettingsSection } from "./SettingsPanelPrimitives";

const TRANSPORTS: LibraryTransport[] = ["stdio", "http", "sse"];

/**
 * The market needs a daemon that answers `library.market.servers` with
 * `{ servers, error }` (session.ts handleLibraryMarket, fixed 2026-11-09). An
 * older daemon sends the whole search outcome under `servers`, which protocol
 * validation rejects, and the dialog shows the request's error.
 */
const MARKET_UI_ENABLED = true;

function pairsText(pairs: Record<string, string> | undefined, separator: string): string {
  return Object.entries(pairs ?? {})
    .map(([key, value]) => `${key}${separator}${value}`)
    .join("\n");
}

/** Parses "KEY=value" or "Name: value" lines. Values stay as typed, as the
 *  old Library editor did: the daemon hands them back for editing. */
function parsePairs(
  text: string,
  separator: "=" | ":",
  invalidPair: (line: string) => string,
): Record<string, string> {
  const pairs: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const at = line.indexOf(separator);
    if (at <= 0) throw new Error(invalidPair(line));
    pairs[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return pairs;
}

function linesOf(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function serverLine(server: LibraryMcpServer): string {
  if (server.transport === "stdio") {
    return [server.command, ...(server.args ?? [])].filter(Boolean).join(" ");
  }
  return server.url ?? "";
}

interface Draft {
  name: string;
  transport: LibraryTransport;
  command: string;
  argsText: string;
  envText: string;
  url: string;
  headersText: string;
  note: string;
  toolsText: string;
  startupText: string;
  oauthClientId: string;
  oauthClientSecret: string;
  oauthCallbackPort: string;
  local: boolean;
  routerDirect: boolean;
}

function draftFrom(server: LibraryMcpServer | null): Draft {
  return {
    name: server?.name ?? "",
    transport: server?.transport ?? "stdio",
    command: server?.command ?? "",
    argsText: (server?.args ?? []).join("\n"),
    envText: pairsText(server?.env, "="),
    url: server?.url ?? "",
    headersText: pairsText(server?.headers, ":"),
    note: server?.note ?? "",
    toolsText: (server?.disabledTools ?? []).join("\n"),
    startupText: server?.startupTimeout ? String(server.startupTimeout) : "",
    oauthClientId: server?.oauth?.clientId ?? "",
    oauthClientSecret: server?.oauth?.clientSecret ?? "",
    oauthCallbackPort: server?.oauth?.callbackPort ? String(server.oauth.callbackPort) : "",
    local: server?.local === true,
    routerDirect: server?.router === "direct",
  };
}

function serverFromDraft(
  draft: Draft,
  agents: string[],
  invalidPair: (line: string) => string,
): LibraryMcpServer {
  const tools = linesOf(draft.toolsText);
  const startup = Number.parseInt(draft.startupText.trim(), 10);
  const port = Number.parseInt(draft.oauthCallbackPort.trim(), 10);
  const clientId = draft.oauthClientId.trim();
  return {
    name: draft.name.trim(),
    transport: draft.transport,
    agents,
    ...(draft.transport === "stdio"
      ? {
          command: draft.command.trim(),
          args: linesOf(draft.argsText),
          env: parsePairs(draft.envText, "=", invalidPair),
        }
      : {
          url: draft.url.trim(),
          headers: parsePairs(draft.headersText, ":", invalidPair),
        }),
    ...(draft.note.trim() ? { note: draft.note.trim() } : {}),
    ...(tools.length > 0 ? { disabledTools: tools } : {}),
    ...(Number.isInteger(startup) && startup >= 0 ? { startupTimeout: startup } : {}),
    ...(clientId
      ? {
          oauth: {
            clientId,
            ...(draft.oauthClientSecret.trim()
              ? { clientSecret: draft.oauthClientSecret.trim() }
              : {}),
            ...(Number.isInteger(port) && port > 0 ? { callbackPort: port } : {}),
          },
        }
      : {}),
    ...(draft.local ? { local: true } : {}),
    ...(draft.routerDirect ? { router: "direct" as const } : {}),
  };
}

function oauthKey(server: LibraryMcpServer): string {
  const oauth = server.oauth;
  if (server.transport !== "http" || oauth === undefined) return "";
  return JSON.stringify([oauth.clientId, oauth.clientSecret ?? "", oauth.callbackPort ?? 0]);
}

function signInTag(
  status: LibraryMcpSignInStatus | undefined,
  labels: { dead: string; signedIn: string },
): { text: string; ok: boolean } | null {
  if (status === undefined) return null;
  if (status.dead) return { text: labels.dead, ok: false };
  if (status.signedIn) return { text: labels.signedIn, ok: true };
  return null;
}

function TransportChips(props: {
  value: LibraryTransport;
  onChange: (value: LibraryTransport) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap gap-1.5">
      {TRANSPORTS.map((transport) => (
        <button
          key={transport}
          type="button"
          aria-pressed={transport === props.value}
          onClick={() => props.onChange(transport)}
          className={cn(
            "rounded-full border px-2.5 py-1 text-ui-sm",
            transport === props.value
              ? "border-primary/40 bg-primary/10 text-foreground"
              : "border-border bg-secondary text-muted-foreground hover:text-foreground",
          )}
        >
          {t(`settings:library_mcp_${transport}`)}
        </button>
      ))}
    </div>
  );
}

function ModeChips(props: { json: boolean; onChange: (json: boolean) => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap gap-1.5">
      {[false, true].map((json) => (
        <button
          key={String(json)}
          type="button"
          aria-pressed={json === props.json}
          onClick={() => props.onChange(json)}
          className={cn(
            "rounded-full border px-2.5 py-1 text-ui-sm",
            json === props.json
              ? "border-primary/40 bg-primary/10 text-foreground"
              : "border-border bg-secondary text-muted-foreground hover:text-foreground",
          )}
        >
          {json ? t("settings:library_mcp_json") : t("settings:library_mcp_form")}
        </button>
      ))}
    </div>
  );
}

/** Neox's sign-in to a remote server. Mirrors the old Library editor: wait
 *  in the browser, cancel, then sign out once it sticks. */
function SignInControl(props: {
  server: LibraryMcpServer;
  canSignIn: boolean;
  saveFirst?: (() => Promise<string | null>) | undefined;
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  const { t } = useTranslation();
  const [signing, setSigning] = useState<LibraryMcpSignInState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  const currentId = useRef<string | null>(null);
  // Cancel can land while signInMcpServer is still answering; the reply must
  // not put the UI back into the waiting state it just left.
  const cancelled = useRef(false);

  useEffect(
    () => () => {
      alive.current = false;
      const id = currentId.current;
      if (id !== null) void neolixLibraryApi.cancelMcpSignIn({ id }).catch(() => undefined);
    },
    [],
  );

  const finish = useCallback(
    async (state: LibraryMcpSignInState) => {
      setSigning(null);
      currentId.current = null;
      if (state.state === "done") {
        props.onChanged();
        return;
      }
      if (state.state === "failed") setError(state.error ?? "");
    },
    [props],
  );

  const follow = useCallback(
    async (id: string) => {
      // `while (true)` rather than `for (;;)`: React Compiler cannot lower the empty for.
      while (true) {
        await new Promise((resolve) => setTimeout(resolve, 800));
        if (!alive.current || cancelled.current) return;
        let state: LibraryMcpSignInState | undefined;
        try {
          state = (await neolixLibraryApi.mcpSignInStatus({ id })).state;
        } catch {
          continue;
        }
        if (!alive.current) return;
        if (state === undefined || state.state === "waiting") continue;
        await finish(state);
        return;
      }
    },
    [finish],
  );

  const start = useCallback(
    async (name: string) => {
      setError(null);
      cancelled.current = false;
      setSigning({ id: "", server: name, state: "waiting" });
      // Only the request sits in try: React Compiler cannot lower conditionals inside it.
      let state: LibraryMcpSignInState;
      try {
        state = (await neolixLibraryApi.signInMcpServer({ name })).state;
      } catch (failure) {
        if (!alive.current) return;
        setSigning(null);
        currentId.current = null;
        props.onError(localizeLibraryError(failure, t));
        return;
      }
      if (!alive.current) return;
      if (cancelled.current) {
        void neolixLibraryApi.cancelMcpSignIn({ id: state.id }).catch(() => undefined);
        return;
      }
      setSigning(state);
      currentId.current = state.id;
      if (state.url) {
        await ensureNativeApi()
          .shell.openExternal(state.url)
          .catch(() => undefined);
      }
      if (state.state === "done" || state.state === "failed") {
        await finish(state);
        return;
      }
      await follow(state.id);
    },
    [finish, follow, props, t],
  );

  const signIn = useCallback(() => {
    void (async () => {
      setError(null);
      cancelled.current = false;
      setSigning({ id: "", server: props.server.name, state: "waiting" });
      let target = props.server.name;
      if (props.saveFirst) {
        // Only the call sits in try: React Compiler cannot lower conditionals inside it.
        let saved: string | null;
        try {
          saved = await props.saveFirst();
        } catch (failure) {
          if (!alive.current) return;
          setSigning(null);
          props.onError(localizeLibraryError(failure, t));
          return;
        }
        if (!alive.current || cancelled.current) return;
        if (saved === null) {
          setSigning(null);
          return;
        }
        target = saved;
      }
      await start(target);
    })();
  }, [props, start, t]);

  const cancel = useCallback(() => {
    const id = signing?.id;
    cancelled.current = true;
    setSigning(null);
    currentId.current = null;
    if (id) void neolixLibraryApi.cancelMcpSignIn({ id }).catch(() => undefined);
  }, [signing?.id]);

  const signOut = useCallback(() => {
    void (async () => {
      const confirmed = await ensureNativeApi().dialogs.confirm(
        t("settings:library_mcp_signOutConfirm", { name: props.server.name }),
        { confirmLabel: t("settings:library_mcp_signOut") },
      );
      if (!confirmed) return;
      try {
        await neolixLibraryApi.signOutMcpServer({ name: props.server.name });
        props.onChanged();
      } catch (failure) {
        props.onError(localizeLibraryError(failure, t));
      }
    })();
  }, [props, t]);

  if (!props.canSignIn) return null;

  const status = props.server.signIn;
  let body: ReactNode;
  if (signing !== null) {
    body = (
      <>
        <p className="text-ui-sm text-muted-foreground">
          {signing.id === ""
            ? t("settings:library_mcp_signInStarting")
            : t("settings:library_mcp_signInWaiting")}
        </p>
        <Button size="sm" variant="outline" onClick={cancel}>
          {t("settings:library_mcp_cancelSignIn")}
        </Button>
      </>
    );
  } else if (status?.signedIn && !status.dead) {
    body = (
      <>
        <p className="text-ui-sm text-success">{t("settings:library_mcp_signedIn")}</p>
        <p className="text-ui-sm text-muted-foreground">{t("settings:library_mcp_signedInHint")}</p>
        <Button size="sm" variant="outline" onClick={signOut}>
          {t("settings:library_mcp_signOut")}
        </Button>
      </>
    );
  } else {
    body = (
      <>
        {status?.dead ? (
          <p className="text-ui-sm text-destructive">{t("settings:library_mcp_signInExpired")}</p>
        ) : null}
        <Button size="sm" variant="outline" onClick={signIn}>
          {props.saveFirst
            ? t("settings:library_mcp_saveAndSignIn")
            : status?.dead
              ? t("settings:library_mcp_signInAgain")
              : t("settings:library_mcp_signIn")}
        </Button>
      </>
    );
  }
  return (
    <div className="space-y-2 border-t border-border/40 pt-3">
      {body}
      {error ? <p className="text-ui-sm text-destructive">{error}</p> : null}
    </div>
  );
}

function ServerEditor(props: {
  server: LibraryMcpServer | null;
  agents: ReadonlyArray<{ id: string; name: string }>;
  onClose: () => void;
  onSave: (server: LibraryMcpServer, oldName: string | null) => Promise<boolean>;
  onRemove: (name: string) => Promise<void>;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const initial = draftFrom(props.server);
  const [draft, setDraft] = useState<Draft>(initial);
  const [agents, setAgents] = useState<string[]>([...(props.server?.agents ?? [])]);
  const [jsonMode, setJsonMode] = useState(false);
  const [jsonText, setJsonText] = useState(JSON.stringify(props.server ?? { agents: [] }, null, 2));
  const [error, setError] = useState<string | null>(null);
  const [health, setHealth] = useState<LibraryMcpHealth | null>(null);
  const [testing, setTesting] = useState(false);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const invalidPair = useCallback(
    (line: string) => t("settings:library_mcp_invalidPair", { line }),
    [t],
  );

  const draftServer = useCallback((): LibraryMcpServer => {
    if (jsonMode) {
      let parsed: LibraryMcpServer;
      try {
        parsed = JSON.parse(jsonText) as LibraryMcpServer;
      } catch {
        // Every caller (save, sign-in, test) shows this message; never the engine's English.
        throw new Error(t("settings:library_mcp_invalidJson"));
      }
      return {
        ...parsed,
        agents: Array.isArray(parsed.agents) && parsed.agents.length > 0 ? parsed.agents : agents,
      };
    }
    return serverFromDraft(draft, agents, invalidPair);
  }, [agents, draft, invalidPair, jsonMode, jsonText, t]);

  const writtenServer = (() => {
    try {
      return draftServer();
    } catch {
      return null;
    }
  })();
  const saves =
    props.server === null ||
    writtenServer === null ||
    writtenServer.name !== props.server.name ||
    writtenServer.transport !== props.server.transport ||
    (writtenServer.url ?? "") !== (props.server.url ?? "") ||
    oauthKey(writtenServer) !== oauthKey(props.server);

  const saveForSignIn = useCallback(async (): Promise<string | null> => {
    // Conditionals stay outside try: React Compiler cannot lower them inside it.
    let server: LibraryMcpServer;
    let saved: boolean;
    const previousName = props.server ? props.server.name : null;
    try {
      server = draftServer();
    } catch (failure) {
      setError(localizeLibraryError(failure, t));
      return null;
    }
    if (server.name.trim() === "") return null;
    try {
      saved = await props.onSave(server, previousName);
    } catch (failure) {
      setError(localizeLibraryError(failure, t));
      return null;
    }
    return saved ? server.name : null;
  }, [draftServer, props, t]);

  const save = () => {
    const previousName = props.server ? props.server.name : null;
    void (async () => {
      let saved = false;
      try {
        saved = await props.onSave(draftServer(), previousName);
      } catch (failure) {
        setError(localizeLibraryError(failure, t));
      }
      if (saved) props.onClose();
    })();
  };

  const test = () => {
    const name = props.server?.name;
    if (!name) return;
    setTesting(true);
    void (async () => {
      // No `finally`: React Compiler cannot lower it and would skip the editor.
      try {
        const result = await neolixLibraryApi.checkMcpServer({ name });
        setHealth(result.health);
      } catch (failure) {
        setHealth({
          ok: false,
          tools: [],
          ms: 0,
          error: localizeLibraryError(failure, t),
        });
      }
      setTesting(false);
    })();
  };

  const saveDisabled = !jsonMode && draft.name.trim().length === 0;

  return (
    <LibraryEditorDialog
      open
      title={
        props.server ? t("settings:library_mcp_editTitle") : t("settings:library_mcp_newTitle")
      }
      saveDisabled={saveDisabled}
      removeLabel={props.server ? t("settings:library_remove") : undefined}
      onRemove={
        props.server
          ? () => {
              void props.onRemove(props.server!.name);
            }
          : undefined
      }
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
      onSave={save}
    >
      <LibraryField label={t("settings:library_mcp_mode")}>
        <ModeChips json={jsonMode} onChange={setJsonMode} />
      </LibraryField>
      {jsonMode ? (
        <LibraryField
          label={t("settings:library_mcp_json")}
          hint={t("settings:library_mcp_jsonHint")}
        >
          <Textarea
            aria-label={t("settings:library_mcp_json")}
            className="min-h-56 font-mono text-ui-sm"
            value={jsonText}
            onChange={(event) => setJsonText(event.target.value)}
          />
        </LibraryField>
      ) : (
        <>
          <LibraryField label={t("settings:library_mcp_name")}>
            <Input
              aria-label={t("settings:library_mcp_name")}
              value={draft.name}
              onChange={(event) => set("name", event.target.value)}
            />
          </LibraryField>
          <LibraryField label={t("settings:library_mcp_transport")}>
            <TransportChips value={draft.transport} onChange={(value) => set("transport", value)} />
          </LibraryField>
          {draft.transport === "stdio" ? (
            <>
              <LibraryField label={t("settings:library_mcp_command")}>
                <Input
                  aria-label={t("settings:library_mcp_command")}
                  value={draft.command}
                  onChange={(event) => set("command", event.target.value)}
                />
              </LibraryField>
              <LibraryField label={t("settings:library_mcp_args")}>
                <Textarea
                  aria-label={t("settings:library_mcp_args")}
                  className="min-h-20 font-mono text-ui-sm"
                  value={draft.argsText}
                  onChange={(event) => set("argsText", event.target.value)}
                />
              </LibraryField>
              <LibraryField label={t("settings:library_mcp_env")}>
                <Textarea
                  aria-label={t("settings:library_mcp_env")}
                  className="min-h-20 font-mono text-ui-sm"
                  value={draft.envText}
                  onChange={(event) => set("envText", event.target.value)}
                />
              </LibraryField>
            </>
          ) : (
            <>
              <LibraryField label={t("settings:library_mcp_url")}>
                <Input
                  aria-label={t("settings:library_mcp_url")}
                  value={draft.url}
                  onChange={(event) => set("url", event.target.value)}
                />
              </LibraryField>
              <LibraryField label={t("settings:library_mcp_headers")}>
                <Textarea
                  aria-label={t("settings:library_mcp_headers")}
                  className="min-h-20 font-mono text-ui-sm"
                  value={draft.headersText}
                  onChange={(event) => set("headersText", event.target.value)}
                />
              </LibraryField>
            </>
          )}
          <LibraryField label={t("settings:library_mcp_note")}>
            <Input
              aria-label={t("settings:library_mcp_note")}
              value={draft.note}
              onChange={(event) => set("note", event.target.value)}
            />
          </LibraryField>
          <LibraryField label={t("settings:library_mcp_disabledTools")}>
            <Textarea
              aria-label={t("settings:library_mcp_disabledTools")}
              className="min-h-20 font-mono text-ui-sm"
              value={draft.toolsText}
              onChange={(event) => set("toolsText", event.target.value)}
            />
          </LibraryField>
          <LibraryField label={t("settings:library_mcp_startupTimeout")}>
            <Input
              aria-label={t("settings:library_mcp_startupTimeout")}
              inputMode="numeric"
              value={draft.startupText}
              onChange={(event) => set("startupText", event.target.value)}
            />
          </LibraryField>
          <LibraryField
            label={t("settings:library_mcp_oauth")}
            hint={t("settings:library_mcp_oauthHint")}
          >
            <div className="space-y-2">
              <Input
                aria-label={t("settings:library_mcp_oauthClientId")}
                placeholder={t("settings:library_mcp_oauthClientId")}
                value={draft.oauthClientId}
                onChange={(event) => set("oauthClientId", event.target.value)}
              />
              <Input
                aria-label={t("settings:library_mcp_oauthClientSecret")}
                type="password"
                autoComplete="off"
                placeholder={t("settings:library_mcp_oauthClientSecret")}
                value={draft.oauthClientSecret}
                onChange={(event) => set("oauthClientSecret", event.target.value)}
              />
              <Input
                aria-label={t("settings:library_mcp_oauthCallbackPort")}
                inputMode="numeric"
                placeholder={t("settings:library_mcp_oauthCallbackPort")}
                value={draft.oauthCallbackPort}
                onChange={(event) => set("oauthCallbackPort", event.target.value)}
              />
            </div>
          </LibraryField>
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-ui-sm font-medium text-foreground">
                {t("settings:library_mcp_local")}
              </p>
            </div>
            <Switch
              checked={draft.local}
              aria-label={t("settings:library_mcp_local")}
              onCheckedChange={(checked) => set("local", Boolean(checked))}
            />
          </div>
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-ui-sm font-medium text-foreground">
                {t("settings:library_mcp_routerDirect")}
              </p>
              <p className="text-ui-sm text-muted-foreground">
                {t("settings:library_mcp_routerDirectHint")}
              </p>
            </div>
            <Switch
              checked={draft.routerDirect}
              aria-label={t("settings:library_mcp_routerDirect")}
              onCheckedChange={(checked) => set("routerDirect", Boolean(checked))}
            />
          </div>
        </>
      )}
      <LibraryField
        label={t("settings:library_agents")}
        hint={t("settings:library_mcp_agentsHint")}
      >
        <LibraryAgentChips
          agents={props.agents}
          selected={agents}
          onToggle={(agent) =>
            setAgents((current) =>
              current.includes(agent)
                ? current.filter((entry) => entry !== agent)
                : [...current, agent],
            )
          }
        />
      </LibraryField>
      {props.server ? (
        <div className="space-y-2">
          <Button size="sm" variant="outline" disabled={testing} onClick={test}>
            {testing ? t("settings:library_mcp_testing") : t("settings:library_mcp_test")}
          </Button>
          {health ? (
            <p className={cn("text-ui-sm", health.ok ? "text-success" : "text-destructive")}>
              {health.ok
                ? t("settings:library_mcp_healthOk", {
                    count: health.tools.length,
                    ms: health.ms,
                  })
                : t("settings:library_mcp_healthBad", { error: health.error ?? "" })}
            </p>
          ) : null}
          {health?.tools.length ? (
            <p className="font-mono text-ui-sm text-muted-foreground">{health.tools.join(", ")}</p>
          ) : null}
        </div>
      ) : null}
      <SignInControl
        server={
          props.server ?? {
            name: draft.name.trim(),
            transport: draft.transport,
            agents,
          }
        }
        canSignIn={!jsonMode && draft.transport !== "stdio" && draft.name.trim().length > 0}
        saveFirst={saves ? saveForSignIn : undefined}
        onChanged={props.onChanged}
        onError={setError}
      />
      {error ? <p className="text-ui-sm text-destructive">{error}</p> : null}
    </LibraryEditorDialog>
  );
}

function useLibraryMcpWrites() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const apply = useCallback(
    async (run: () => Promise<LibraryMutationResult>) => {
      try {
        const result = await run();
        applyLibraryMutation(queryClient, result);
        // The composer reads MCP servers through the connectors query; keep it in step.
        void queryClient.invalidateQueries({ queryKey: MCP_CONNECTORS_QUERY_KEY });
        return true;
      } catch (error) {
        toastManager.add({
          type: "error",
          title: t("settings:library_saveFailed"),
          description: localizeLibraryError(error, t),
        });
        return false;
      }
    },
    [queryClient, t],
  );

  const reload = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: NEOLIX_LIBRARY_QUERY_KEY });
  }, [queryClient]);

  return { apply, reload };
}

/** Whether a server matches the MCP page's search box. */
export function libraryMcpServerMatches(server: LibraryMcpServer, query: string): boolean {
  if (query.length === 0) return true;
  return [server.name, serverLine(server)].some((field) => field.toLowerCase().includes(query));
}

/**
 * Settings › MCP › Servers: the one list of MCP servers. Each row shows which agents get the
 * server and its sign-in state; clicking opens the full editor. `adding` opens the editor for
 * a new server (the page toolbar owns the button).
 */
export function LibraryMcpServerList(props: {
  query: string;
  adding: boolean;
  onAddingChange: (adding: boolean) => void;
}) {
  const { t } = useTranslation();
  const libraryQuery = useNeolixLibrary();
  const { apply, reload } = useLibraryMcpWrites();
  const [editing, setEditing] = useState<LibraryMcpServer | null>(null);

  const library = libraryQuery.data?.library;
  if (libraryQuery.isLoading) {
    return <p className="text-ui text-muted-foreground">{t("settings:library_loading")}</p>;
  }
  if (libraryQuery.isError || !library) {
    return (
      <LibraryErrorState error={libraryQuery.error} fallback={t("settings:library_loadFailed")} />
    );
  }

  const toggleAgent = (server: LibraryMcpServer, agent: string) => {
    const next = server.agents.includes(agent)
      ? server.agents.filter((entry) => entry !== agent)
      : [...server.agents, agent];
    void apply(() => neolixLibraryApi.setMcpAgents({ name: server.name, agents: next }));
  };

  const saveServer = async (server: LibraryMcpServer, oldName: string | null) => {
    const saved = await apply(() =>
      neolixLibraryApi.saveMcpServer({ server, ...(oldName ? { oldName } : {}) }),
    );
    if (saved) toastManager.add({ type: "success", title: t("settings:library_saved") });
    return saved;
  };

  const removeServer = async (name: string) => {
    const confirmed = await ensureNativeApi().dialogs.confirm(
      t("settings:library_removeConfirm", { name }),
      { confirmLabel: t("common:delete"), destructive: true },
    );
    if (!confirmed) return;
    if (await apply(() => neolixLibraryApi.removeMcpServer({ name }))) {
      setEditing(null);
    }
  };

  const closeEditor = () => {
    setEditing(null);
    props.onAddingChange(false);
  };

  const labels = {
    dead: t("settings:library_mcp_signInExpired"),
    signedIn: t("settings:library_mcp_signedIn"),
  };
  const servers = library.mcp.filter((server) => libraryMcpServerMatches(server, props.query));
  const editorServer = props.adding ? null : editing;
  const editorOpen = props.adding || editing !== null;

  return (
    <>
      {servers.length > 0 ? (
        <SettingsSection title="settings:library_mcp_servers">
          {servers.map((server) => {
            const tag = signInTag(server.signIn, labels);
            return (
              <SettingsRow
                key={server.name}
                title={server.name}
                description={serverLine(server)}
                status={
                  tag ? (
                    <span
                      className={cn("text-ui-sm", tag.ok ? "text-success" : "text-destructive")}
                    >
                      {tag.text}
                    </span>
                  ) : null
                }
                onClick={() => setEditing(server)}
              >
                <LibraryAgentChips
                  agents={library.agents}
                  selected={server.agents}
                  onToggle={(agent) => toggleAgent(server, agent)}
                />
              </SettingsRow>
            );
          })}
        </SettingsSection>
      ) : null}
      {editorOpen ? (
        <ServerEditor
          key={editorServer?.name ?? "new"}
          server={editorServer}
          agents={library.agents}
          onClose={closeEditor}
          onSave={saveServer}
          onRemove={removeServer}
          onChanged={reload}
        />
      ) : null}
    </>
  );
}

/** Settings › MCP › Servers, below the catalog: the hub switch, market, discover and backups. */
export function LibraryMcpAdvanced() {
  const { t } = useTranslation();
  const libraryQuery = useNeolixLibrary();
  const { apply, reload } = useLibraryMcpWrites();
  const [marketOpen, setMarketOpen] = useState(false);
  const [discoverOpen, setDiscoverOpen] = useState(false);
  const [backupsOpen, setBackupsOpen] = useState(false);

  const library = libraryQuery.data?.library;
  if (!library) return null;

  return (
    <SettingsSection title="settings:mcp_advanced">
      <SettingsRow
        title={t("settings:library_mcp_hub")}
        description={t("settings:library_mcp_hubHint")}
        control={
          <Switch
            checked={library.mcpHub === true}
            aria-label={t("settings:library_mcp_hub")}
            onCheckedChange={(checked) =>
              void apply(() => neolixLibraryApi.setMcpHub({ on: Boolean(checked) }))
            }
          />
        }
      />
      <SettingsRow
        title={t("settings:mcp_moreSources")}
        description={t("settings:mcp_moreSourcesHint")}
        control={
          <div className="flex flex-wrap justify-end gap-2">
            {MARKET_UI_ENABLED ? (
              <Button size="sm" variant="outline" onClick={() => setMarketOpen(true)}>
                {t("settings:library_mcp_market")}
              </Button>
            ) : null}
            <Button size="sm" variant="outline" onClick={() => setDiscoverOpen(true)}>
              {t("settings:library_mcp_discover")}
            </Button>
            <Button size="sm" variant="outline" onClick={() => setBackupsOpen(true)}>
              {t("settings:library_mcp_backups")}
            </Button>
          </div>
        }
      />

      {MARKET_UI_ENABLED ? (
        <LibraryMcpMarketDialog
          open={marketOpen}
          onOpenChange={setMarketOpen}
          library={library}
          onChanged={reload}
        />
      ) : null}
      <LibraryDiscoverDialog
        open={discoverOpen}
        onOpenChange={setDiscoverOpen}
        library={library}
        onChanged={reload}
      />
      <LibraryBackupsDialog
        open={backupsOpen}
        onOpenChange={setBackupsOpen}
        library={library}
        onChanged={reload}
      />
    </SettingsSection>
  );
}
