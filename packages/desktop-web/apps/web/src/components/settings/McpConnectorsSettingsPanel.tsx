// FILE: McpConnectorsSettingsPanel.tsx
// Purpose: Settings › MCP › Servers: the one list of MCP servers (per-agent access, sign-in,
//   full editor), the catalog of services to connect, connect-by-URL, and the hub/market/
//   discover/backups tools. Library MCP entries are the single source; the catalog hides
//   presets whose URL is already a server.
// Layer: Settings UI components
// Exports: McpConnectorsSettingsPanel

import type { McpConnector } from "@synara/contracts";
import {
  defaultMcpConnectorName,
  MCP_CONNECTOR_CATEGORIES,
  MCP_CONNECTOR_PRESETS,
  type McpConnectorCategory,
  type McpConnectorPreset,
  type McpConnectorUrlReasonCode,
  normalizeMcpConnectorUrl,
} from "@synara/shared/mcpConnectors";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useDeferredValue,
  useId,
  useState,
} from "react";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { SearchInput } from "~/components/ui/search-input";
import { toastManager } from "~/components/ui/toast";
import { AddPlusIcon } from "~/lib/icons";
import { MCP_CONNECTORS_QUERY_KEY } from "~/lib/mcpConnectorsReactQuery";
import { NEOLIX_LIBRARY_QUERY_KEY, useNeolixLibrary } from "~/lib/neolixLibraryQuery";
import { t, useTranslation } from "~/i18n";

import { McpConnectorConnectDialog, type McpConnectorTarget } from "./McpConnectorConnectDialog";
import { McpConnectorGlyph } from "./McpConnectorGlyph";
import {
  McpConnectorProposalCard,
  mcpConnectorProposalsQueryOptions,
} from "./McpConnectorProposalCard";
import { SettingsEmptyState } from "./SettingsPanelPrimitives";
import {
  LibraryMcpAdvanced,
  LibraryMcpServerList,
  libraryMcpServerMatches,
} from "./LibraryMcpPanel";

const CATEGORY_LABELS: Record<McpConnectorCategory, string> = {
  popular: "settings:connectorPopular",
  developer: "settings:advanced_developerTools",
  productivity: "settings:connectorProductivity",
};

const PRESET_DESCRIPTION_KEYS: Readonly<Record<string, string>> = {
  supabase: "settings:connectorSupabaseDescription",
  vercel: "settings:connectorVercelDescription",
  workos: "settings:connectorWorkosDescription",
  convex: "settings:connectorConvexDescription",
  cloudflare: "settings:connectorCloudflareDescription",
  slack: "settings:connectorSlackDescription",
  linear: "settings:connectorLinearDescription",
  notion: "settings:connectorNotionDescription",
  sentry: "settings:connectorSentryDescription",
  stripe: "settings:connectorStripeDescription",
  neon: "settings:connectorNeonDescription",
  atlassian: "settings:connectorAtlassianDescription",
  todoist: "settings:connectorTodoistDescription",
  posthog: "settings:connectorPosthogDescription",
  netlify: "settings:connectorNetlifyDescription",
  railway: "settings:connectorRailwayDescription",
  prisma: "settings:connectorPrismaDescription",
  huggingface: "settings:connectorHuggingfaceDescription",
};

function presetDescription(preset: McpConnectorPreset | undefined, translate: typeof t): string {
  if (!preset) return "";
  const key = PRESET_DESCRIPTION_KEYS[preset.id];
  return key ? translate(key) : preset.description;
}

const URL_REASON_KEYS: Record<McpConnectorUrlReasonCode, string> = {
  required: "settings:connectorUrlRequired",
  "too-long": "settings:connectorUrlTooLong",
  invalid: "settings:connectorUrlInvalid",
  "https-required": "settings:connectorUrlHttps",
  credentials: "settings:connectorUrlCredentials",
  "public-host": "settings:connectorUrlPublicHost",
};

function presetTarget(preset: McpConnectorPreset): McpConnectorTarget {
  return {
    presetId: preset.id,
    name: preset.name,
    url: preset.url,
    docsUrl: preset.docsUrl,
    ...(preset.requiresOwnApp ? { requiresOwnApp: true } : {}),
    appSetupUrl: preset.appSetupUrl ?? null,
  };
}

function matchesSearch(query: string, ...fields: ReadonlyArray<string>): boolean {
  return query.length === 0 || fields.some((field) => field.toLowerCase().includes(query));
}

function ConnectorShelf(props: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-1">
      <h2 className="px-3 text-ui-lg font-medium text-foreground">{props.title}</h2>
      <div className="grid grid-cols-1 gap-x-2 sm:grid-cols-2">{props.children}</div>
    </section>
  );
}

const CONNECTOR_ROW_CLASS_NAME = "flex w-full min-w-0 items-center gap-3 rounded-xl px-3 py-2.5";

function ConnectorRowText(props: { title: string; description: ReactNode }) {
  return (
    <span className="min-w-0 flex-1">
      <span className="block truncate text-ui-lg font-medium leading-snug text-foreground">
        {props.title}
      </span>
      <span className="mt-0.5 block truncate text-ui text-muted-foreground">
        {props.description}
      </span>
    </span>
  );
}

function PresetRow(props: { preset: McpConnectorPreset; onSelect: () => void }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={props.onSelect}
      className={`${CONNECTOR_ROW_CLASS_NAME} group text-left transition-colors hover:bg-[var(--sidebar-accent)] focus-visible:outline-2 focus-visible:outline-ring`}
    >
      <McpConnectorGlyph name={props.preset.name} url={props.preset.url} />
      <ConnectorRowText
        title={props.preset.name}
        description={presetDescription(props.preset, t)}
      />
      <AddPlusIcon
        className="size-5 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground"
        aria-hidden="true"
      />
    </button>
  );
}

function AddCustomConnectorDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (url: string) => void;
}) {
  const { t } = useTranslation();

  const formId = useId();
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const normalized = normalizeMcpConnectorUrl(url);
    if (!normalized.ok) {
      // The shared validator permits loopback HTTP; the main HTTPS-only message does not.
      setError(
        normalized.reasonCode && normalized.reasonCode !== "https-required"
          ? t(URL_REASON_KEYS[normalized.reasonCode])
          : normalized.reason,
      );
      return;
    }
    setUrl("");
    setError(null);
    props.onSubmit(normalized.url);
  };

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) setError(null);
        props.onOpenChange(open);
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("settings:addCustomConnector")}</DialogTitle>
          <DialogDescription>{t("settings:customConnectorDescription")}</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form id={formId} className="space-y-1.5" onSubmit={submit} noValidate>
            <Input
              value={url}
              maxLength={2048}
              placeholder="https://mcp.example.com/mcp"
              aria-label={t("settings:mcpServerUrl")}
              aria-invalid={error ? true : undefined}
              autoFocus
              onChange={(event) => {
                setUrl(event.target.value);
                setError(null);
              }}
            />
            {error ? <p className="text-ui-sm text-destructive">{error}</p> : null}
          </form>
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => props.onOpenChange(false)}>
            {t("common:form_cancel")}
          </Button>
          <Button type="submit" form={formId} disabled={!url.trim()}>
            {t("git:continue")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function McpConnectorsSettingsPanel(props: { active: boolean }) {
  // The library query has no `enabled` switch; mount the page only while it is shown.
  return props.active ? <McpServersPage /> : null;
}

function McpServersPage() {
  const { t } = useTranslation();

  const queryClient = useQueryClient();
  const libraryQuery = useNeolixLibrary();
  const [target, setTarget] = useState<McpConnectorTarget | null>(null);
  const [addUrlOpen, setAddUrlOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);

  const proposalsQuery = useQuery(mcpConnectorProposalsQueryOptions());

  const onConnected = useCallback(
    (connector: McpConnector) => {
      setTarget(null);
      void queryClient.invalidateQueries({ queryKey: MCP_CONNECTORS_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: NEOLIX_LIBRARY_QUERY_KEY });
      toastManager.add({
        type: "success",
        title:
          connector.status === "unreachable"
            ? t("settings:connectorsSaved", { value0: connector.name })
            : t("settings:connectorConnected", { name: connector.name }),
        description:
          connector.status === "unreachable"
            ? t("settings:connectorsNotRunningHint")
            : t("settings:connectorToolsNewChats"),
      });
    },
    [queryClient, t],
  );

  const query = deferredSearch.trim().toLowerCase();
  const servers = libraryQuery.data?.library.mcp ?? [];
  const connectedUrls = new Set(servers.flatMap((server) => (server.url ? [server.url] : [])));
  const matchingServers = servers.filter((server) => libraryMcpServerMatches(server, query));
  const shelves = MCP_CONNECTOR_CATEGORIES.map((category) => ({
    category,
    presets: MCP_CONNECTOR_PRESETS.filter(
      (preset) =>
        preset.category === category &&
        !connectedUrls.has(preset.url) &&
        matchesSearch(query, preset.name, presetDescription(preset, t)),
    ),
  })).filter((shelf) => shelf.presets.length > 0);

  const addUrl = (url: string) => {
    setAddUrlOpen(false);
    const preset = MCP_CONNECTOR_PRESETS.find((entry) => entry.url === url);
    setTarget(
      preset
        ? presetTarget(preset)
        : { presetId: null, name: defaultMcpConnectorName(url), url, docsUrl: null },
    );
  };

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center gap-2">
        {/* The input is full width; this box lets the buttons share its row when there is room. */}
        <div className="min-w-56 flex-1">
          <SearchInput
            type="search"
            nativeInput
            shape="capsule"
            placeholder={t("settings:mcp_search")}
            aria-label={t("settings:mcp_search")}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && search.length > 0) {
                event.preventDefault();
                event.stopPropagation();
                setSearch("");
              }
            }}
          />
        </div>
        <Button shape="capsule" className="shrink-0" onClick={() => setAdding(true)}>
          <AddPlusIcon className="size-4" />
          {t("settings:library_mcp_add")}
        </Button>
        <Button
          shape="capsule"
          variant="outline"
          className="shrink-0"
          onClick={() => setAddUrlOpen(true)}
        >
          {t("settings:mcp_connectUrl")}
        </Button>
      </div>

      <LibraryMcpServerList query={query} adding={adding} onAddingChange={setAdding} />

      {shelves.map((shelf) => (
        <ConnectorShelf key={shelf.category} title={t(CATEGORY_LABELS[shelf.category])}>
          {shelf.presets.map((preset) => (
            <PresetRow
              key={preset.id}
              preset={preset}
              onSelect={() => setTarget(presetTarget(preset))}
            />
          ))}
        </ConnectorShelf>
      ))}

      {proposalsQuery.data
        ?.filter((proposal) => proposal.state === "pending")
        .map((proposal) => (
          <McpConnectorProposalCard key={proposal.proposalId} proposalId={proposal.proposalId} />
        ))}

      {query.length > 0 && matchingServers.length === 0 && shelves.length === 0 ? (
        <SettingsEmptyState>
          {t("settings:connectorsNoMatches", { query: deferredSearch.trim() })}
        </SettingsEmptyState>
      ) : null}

      <LibraryMcpAdvanced />

      <p className="px-3 text-ui-sm text-muted-foreground">
        {t("settings:connectorsAvailability")}
      </p>

      <AddCustomConnectorDialog open={addUrlOpen} onOpenChange={setAddUrlOpen} onSubmit={addUrl} />
      <McpConnectorConnectDialog
        target={target}
        onOpenChange={(open) => {
          if (!open) setTarget(null);
        }}
        onConnected={onConnected}
      />
    </div>
  );
}
