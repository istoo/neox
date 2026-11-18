// FILE: PluginLibrary.tsx
// Purpose: Neox plugin management — installed plugins, the registry market, and the host's
//          built-in plugins. Replaces the fork's provider-plugin browser, which mirrored Codex's
//          own marketplace and had no relation to the daemon's plugin host.
// Layer: Route-level screen
// Exports: PluginLibrary

import type { NeolixPlugin, NeolixPluginListing, NeolixPluginMarketHit } from "@synara/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState, type ReactNode } from "react";

import { useProviderStatusesForLocalConfig } from "~/hooks/useProviderStatusesForLocalConfig";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";

import {
  AddPlusIcon,
  CheckIcon,
  CircleAlertIcon,
  DownloadIcon,
  ListChecksIcon,
  PageTextIcon,
  PluginIcon,
  RefreshCwIcon,
  SearchIcon,
  SettingsIcon,
  Trash2,
  XIcon,
} from "~/lib/icons";
import { cn } from "~/lib/utils";
import { useTranslation } from "~/i18n";
import { patchHostConfig } from "~/lib/neolixHostApi";
import { ensureNativeApi } from "~/nativeApi";
import { invalidatePluginCatalog } from "~/plugins/catalog";
import { PluginSlotPanels } from "~/plugins/PluginSlotPanels";
import { PluginLogsDialog } from "./PluginLogsDialog";
import { PluginSettingsDialog } from "./PluginSettingsDialog";
import { BuiltinFeatureSwitches } from "./settings/BuiltinFeatureSwitches";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { Button } from "./ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "./ui/input-group";
import { Skeleton } from "./ui/skeleton";
import { Switch } from "./ui/switch";
import { toastManager } from "./ui/toast";
import { CHAT_BACKGROUND_CLASS_NAME } from "./chat/composerPickerStyles";
import { RouteInsetSurface } from "./RouteInsetSurface";
import { RouteSurfaceHeader } from "./RouteSurface";
import { PluginsUnsupportedError, useInstalledPluginsQuery } from "./customize/pluginQueries";

type PluginTab = "installed" | "discover" | "builtin";

const BUILTIN_NAMES: Record<string, string> = {
  "antigravity-provider": "Antigravity",
  "claude-usage-source": "Claude",
  "codex-usage-source": "Codex",
  "copilot-usage-source": "GitHub Copilot",
  "cursor-usage-source": "Cursor",
  "grok-usage-source": "Grok",
  "hoplite-provider": "Hoplite",
  "kimi-usage-source": "Kimi",
  "minimax-usage-source": "MiniMax",
  "muse-provider": "Muse Code",
  "opencode-go-usage-source": "OpenCode Go",
  "worktree-include": "Worktree include",
  "zai-usage-source": "Z.AI",
};

const STATUS_LABEL_KEYS: Record<NeolixPlugin["status"], string> = {
  running: "settings:plugins_statusRunning",
  disabled: "settings:plugins_statusDisabled",
  failed: "settings:plugins_statusFailed",
};

const STATUS_TONE: Record<NeolixPlugin["status"], string> = {
  running: "text-success",
  disabled: "text-muted-foreground",
  failed: "text-destructive",
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// The daemon has no default registry, so browsing fails with a transport error string.
// Show the product-level guidance instead of that raw error.
function isMarketRegistryUnconfigured(error: unknown): boolean {
  return errorMessage(error).toLowerCase().includes("plugin registry is not configured");
}

function pluginName(plugin: Pick<NeolixPlugin, "id" | "name">): string {
  return plugin.name?.trim() || plugin.id;
}

function nameToHue(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
  return Math.abs(h) % 360;
}

function formatCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function translationAt(listing: NeolixPluginListing) {
  return (
    listing.translations?.["zh-CN"] ?? listing.translations?.zh ?? listing.translations?.["zh-Hans"]
  );
}

function listingName(listing: NeolixPluginListing): string {
  return translationAt(listing)?.name?.trim() || listing.name;
}

function listingDescription(listing: NeolixPluginListing): string {
  return translationAt(listing)?.description?.trim() || listing.description;
}

function installSource(listing: NeolixPluginListing): string {
  const artifact = listing.artifact;
  if (artifact.kind === "npm") return `npm:${artifact.package}`;
  const path = artifact.pluginPath?.trim();
  return path && path !== "." ? `git:${artifact.remote}:${path}` : `git:${artifact.remote}`;
}

/** Market listings map to an installed plugin by pinned npm/git identity or by id. */
function installedForListing(
  installed: ReadonlyArray<NeolixPlugin>,
  listing: NeolixPluginListing,
): NeolixPlugin | undefined {
  return installed.find((plugin) => {
    if (plugin.id === listing.id) return true;
    const identity = plugin.installation?.identity;
    if (!identity) return false;
    if (identity.kind === "npm" && listing.artifact.kind === "npm") {
      return identity.packageName === listing.artifact.package;
    }
    if (identity.kind === "git" && listing.artifact.kind === "git") {
      return identity.remote === listing.artifact.remote;
    }
    return false;
  });
}

/** One provider's sign-in state, the same shape the native plugin list shows. */
function providerSignInState(
  providers: readonly string[] | undefined,
  statuses: ReadonlyMap<string, { readonly status: string }>,
): { signedIn: boolean; notSignedIn: boolean } {
  if (!providers?.length) return { signedIn: false, notSignedIn: false };
  const states = providers.map((provider) => statuses.get(provider));
  if (states.some((state) => state === undefined)) return { signedIn: false, notSignedIn: false };
  const signedIn = states.some((state) => state?.status === "ready");
  return { signedIn, notSignedIn: !signedIn };
}

function MetaChip({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex shrink-0 items-center rounded-full bg-[var(--sidebar-accent)] px-1.5 text-ui-xs text-muted-foreground">
      {children}
    </span>
  );
}

/** How the daemon names the README it should read for a listing or installed plugin. */
function readmeSourceFor(
  listing: NeolixPluginListing | null,
  plugin: NeolixPlugin | undefined,
):
  | { kind: "registry"; id: string }
  | { kind: "npm"; package: string }
  | { kind: "github"; remote: string; ref?: string }
  | null {
  if (listing) {
    if (listing.artifact.kind === "npm") {
      return { kind: "npm", package: listing.artifact.package };
    }
    return { kind: "registry", id: listing.id };
  }
  const identity = plugin?.installation?.identity;
  if (identity && identity.kind !== "directory" && identity.registry) {
    return { kind: "registry", id: identity.registry.id };
  }
  if (identity?.kind === "npm") return { kind: "npm", package: identity.packageName };
  if (identity?.kind === "git") {
    return {
      kind: "github",
      remote: identity.remote,
      ...(plugin?.ref ? { ref: plugin.ref } : {}),
    };
  }
  if (plugin?.remote) {
    return {
      kind: "github",
      remote: plugin.remote,
      ...(plugin.ref ? { ref: plugin.ref } : {}),
    };
  }
  return null;
}

function PluginGlyph({ name, icon }: { name: string; icon?: string | undefined }) {
  const hue = nameToHue(name);
  if (icon) {
    return (
      <span className="inline-flex size-11 shrink-0 items-center justify-center rounded-[14px] border border-border/60 bg-background">
        <img src={icon} alt="" className="size-7 object-contain" loading="lazy" />
      </span>
    );
  }
  return (
    <span
      className="inline-flex size-11 shrink-0 items-center justify-center rounded-[14px]"
      style={{
        background: `linear-gradient(145deg, hsl(${hue} 55% 30%), hsl(${hue} 45% 18%))`,
        boxShadow: `0 0 0 0.5px hsl(${hue} 40% 30% / 0.35)`,
      }}
    >
      <PluginIcon className="size-5 text-white/80" />
    </span>
  );
}

function TabButton({
  label,
  active,
  count,
  onClick,
}: {
  label: string;
  active: boolean;
  count?: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-ui font-medium transition-colors",
        active
          ? "border-border bg-[var(--sidebar-accent)] text-foreground"
          : "border-transparent text-muted-foreground hover:bg-[var(--sidebar-accent)] hover:text-foreground",
      )}
      aria-pressed={active}
      onClick={onClick}
    >
      {label}
      {count !== undefined ? (
        <span className="rounded-full bg-[var(--sidebar-accent)] px-1.5 text-ui-sm tabular-nums">
          {count}
        </span>
      ) : null}
    </button>
  );
}

function EmptyPanel({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex min-h-40 items-center justify-center rounded-xl border border-dashed border-border/60 bg-background/40 px-5 py-6 text-center">
      <div className="max-w-sm space-y-1">
        <p className="text-ui-lg leading-snug font-medium text-foreground">{title}</p>
        <p className="text-ui leading-snug text-muted-foreground">{description}</p>
      </div>
    </div>
  );
}

function InlineWarning({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-xl border border-amber-500/20 bg-amber-500/6 px-3 py-2.5 text-ui leading-snug text-muted-foreground">
      <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
      <div>{children}</div>
    </div>
  );
}

function StatusPill({ plugin }: { plugin: NeolixPlugin }) {
  const { t } = useTranslation();
  return (
    <span className={cn("text-ui-sm", STATUS_TONE[plugin.status])}>
      {t(STATUS_LABEL_KEYS[plugin.status])}
    </span>
  );
}

/** The daemon-wide switch that lets every configured plugin run on this computer. */
function GlobalPluginSwitch({
  enabled,
  pending,
  error,
  onEnable,
  onDisable,
}: {
  enabled: boolean;
  pending: boolean;
  error: string | null;
  onEnable: () => void;
  onDisable: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-start gap-3 rounded-xl border border-border/60 bg-background/40 px-3 py-3">
      <div className="min-w-0 flex-1">
        <p className="text-ui-lg leading-snug font-semibold text-foreground">
          {t("settings:plugins_globalTitle")}
        </p>
        <p className="mt-0.5 text-ui leading-snug text-muted-foreground">
          {t("settings:plugins_globalHint")}
        </p>
        {error ? <p className="mt-1 text-ui-sm text-destructive">{error}</p> : null}
      </div>
      <Switch
        checked={enabled}
        disabled={pending}
        aria-label={t("settings:plugins_globalTitle")}
        onCheckedChange={(checked) => {
          if (checked) onEnable();
          else onDisable();
        }}
      />
    </div>
  );
}

function InstalledRow({
  plugin,
  providerStatuses,
  pending,
  onEnable,
  onDisable,
  onReload,
  onRemove,
  onLogs,
  onSettings,
}: {
  plugin: NeolixPlugin;
  providerStatuses: ReadonlyMap<string, { readonly status: string }>;
  pending: boolean;
  onEnable: () => void;
  onDisable: () => void;
  onReload: () => void;
  onRemove: () => void;
  onLogs: () => void;
  onSettings: () => void;
}) {
  const { t } = useTranslation();
  const signIn = providerSignInState(plugin.providers, providerStatuses);
  return (
    <div className="flex items-center gap-3 rounded-xl px-3 py-3 transition-colors hover:bg-[var(--sidebar-accent)]">
      <PluginGlyph name={pluginName(plugin)} icon={plugin.icon} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <p className="truncate text-ui-lg leading-snug font-semibold text-foreground">
            {pluginName(plugin)}
          </p>
          <StatusPill plugin={plugin} />
          {signIn.signedIn ? (
            <span className="shrink-0 text-ui-xs text-success">
              {t("settings:plugins_marketSignedIn")}
            </span>
          ) : null}
          {signIn.notSignedIn ? (
            <span className="shrink-0 text-ui-xs text-amber-500">
              {t("settings:plugins_marketNotSignedIn")}
            </span>
          ) : null}
          {plugin.providers && plugin.providers.length > 0 ? (
            <MetaChip>
              {t("settings:plugins_marketServes", { value0: plugin.providers.join(", ") })}
            </MetaChip>
          ) : null}
          {plugin.status === "running" && (plugin.web?.views?.length ?? 0) === 0 ? (
            <span className="text-ui-xs text-muted-foreground">
              {t("settings:plugins_mobileOnlyNotice")}
            </span>
          ) : null}
        </div>
        <p className="mt-0.5 truncate text-ui text-muted-foreground">
          {plugin.description?.trim() || plugin.id}
        </p>
        <p className="mt-0.5 truncate text-ui-sm text-muted-foreground/60" title={plugin.path}>
          {plugin.source === "directory"
            ? t("settings:plugins_sourceDirectory")
            : plugin.source === "git"
              ? "Git"
              : t("settings:plugins_sourceLocal")}{" "}
          · {plugin.path}
          {plugin.commit ? ` · ${plugin.commit.slice(0, 7)}` : ""}
        </p>
        {plugin.error ? (
          <p className="mt-0.5 truncate text-ui-sm text-destructive">{plugin.error}</p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {(plugin.settingsScreens?.length ?? 0) > 0 || (plugin.settings?.length ?? 0) > 0 ? (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onSettings}
            title={t("settings:plugins_settingsAction")}
            aria-label={t("settings:plugins_settingsAction")}
          >
            <SettingsIcon />
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onLogs}
          title={t("settings:plugins_logsAction")}
          aria-label={t("settings:plugins_logsAction")}
        >
          <PageTextIcon />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onReload}
          disabled={pending}
          title={t("settings:plugins_reloadTitle")}
        >
          <RefreshCwIcon />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onRemove}
          disabled={pending}
          title={t("settings:plugins_removeTitle")}
          className="text-muted-foreground hover:text-destructive"
        >
          <Trash2 />
        </Button>
        <Switch
          checked={plugin.enabled}
          disabled={pending}
          aria-label={
            plugin.enabled ? t("settings:plugins_disableAria") : t("settings:plugins_enableAria")
          }
          onCheckedChange={(checked) => {
            if (checked) onEnable();
            else onDisable();
          }}
        />
      </div>
    </div>
  );
}

function MarketRow({
  listing,
  installed,
  weeklyDownloads,
  providerStatuses,
  pending,
  onInstall,
  onSelect,
}: {
  listing: NeolixPluginListing;
  installed?: NeolixPlugin | undefined;
  weeklyDownloads?: number | undefined;
  providerStatuses: ReadonlyMap<string, { readonly status: string }>;
  pending: boolean;
  onInstall: () => void;
  onSelect: () => void;
}) {
  const { t } = useTranslation();
  const signIn = providerSignInState(installed?.providers, providerStatuses);
  return (
    <div
      role="button"
      tabIndex={0}
      className="flex cursor-pointer items-center gap-3 rounded-xl px-3 py-3 transition-colors hover:bg-[var(--sidebar-accent)]"
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
    >
      <PluginGlyph name={listingName(listing)} icon={listing.icon} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <p className="truncate text-ui-lg leading-snug font-semibold text-foreground">
            {listingName(listing)}
          </p>
          <span className="shrink-0 text-ui-sm text-muted-foreground/60">
            {listing.artifact.kind === "npm"
              ? `v${listing.artifact.version}`
              : listing.artifact.commit.slice(0, 7)}
          </span>
          {signIn.signedIn ? (
            <span className="shrink-0 text-ui-xs text-success">
              {t("settings:plugins_marketSignedIn")}
            </span>
          ) : null}
          {signIn.notSignedIn ? (
            <span className="shrink-0 text-ui-xs text-amber-500">
              {t("settings:plugins_marketNotSignedIn")}
            </span>
          ) : null}
          {listing.replaces && listing.replaces.length > 0 ? (
            <MetaChip>{t("settings:plugins_marketReplaces")}</MetaChip>
          ) : null}
          {installed?.providers && installed.providers.length > 0 ? (
            <MetaChip>
              {t("settings:plugins_marketServes", { value0: installed.providers.join(", ") })}
            </MetaChip>
          ) : null}
        </div>
        <p className="mt-0.5 line-clamp-2 text-ui text-muted-foreground">
          {listingDescription(listing)}
        </p>
        <p className="mt-0.5 truncate text-ui-sm text-muted-foreground/60">
          {listing.author.name?.trim() || listing.author.github}
          {listing.categories.length > 0 ? ` · ${listing.categories.join(" / ")}` : ""}
          {weeklyDownloads !== undefined
            ? ` · ${t("settings:plugins_weeklyDownloads", {
                value: formatCount(weeklyDownloads),
              })}`
            : ""}
        </p>
      </div>
      <div className="shrink-0" onClick={(event) => event.stopPropagation()}>
        {installed ? (
          <span className="inline-flex items-center gap-1 text-ui-sm text-muted-foreground">
            <CheckIcon className="size-3.5" />
            {t("settings:plugins_installed")}
          </span>
        ) : (
          <Button variant="secondary" size="sm" onClick={onInstall} disabled={pending}>
            <DownloadIcon />
            {t("settings:plugins_install")}
          </Button>
        )}
      </div>
    </div>
  );
}

function BuiltinRow({ id }: { id: string }) {
  const { t } = useTranslation();
  const name = BUILTIN_NAMES[id] ?? id;
  return (
    <div className="flex items-center gap-3 rounded-xl px-3 py-3">
      <span className="inline-flex size-11 shrink-0 items-center justify-center rounded-[14px] border border-border/60 bg-background">
        <ListChecksIcon className="size-5 text-muted-foreground/70" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-ui-lg leading-snug font-semibold text-foreground">{name}</p>
        <p className="mt-0.5 truncate text-ui text-muted-foreground/60">{id}</p>
      </div>
      <span className="shrink-0 text-ui-sm text-muted-foreground/60">
        {t("settings:plugins_builtinBadge")}
      </span>
    </div>
  );
}

/** Market detail: what the plugin installs, who publishes it, and its README. */
function PluginDetailDialog({
  detail,
  pending,
  onOpenChange,
  onInstall,
}: {
  detail: { listing: NeolixPluginListing; installed?: NeolixPlugin } | null;
  pending: boolean;
  onOpenChange: (open: boolean) => void;
  onInstall: (listing: NeolixPluginListing) => void;
}) {
  const { t } = useTranslation();
  const source = detail ? readmeSourceFor(detail.listing, detail.installed) : null;
  const readmeQuery = useQuery({
    queryKey: ["neolix", "plugins", "readme", source],
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!api.neolix || !source) throw new Error(t("settings:plugins_unsupportedError"));
      return (await api.neolix.plugins.readme({ source })).markdown;
    },
    enabled: detail !== null && source !== null,
    retry: false,
    staleTime: 5 * 60_000,
  });
  return (
    <Dialog open={detail !== null} onOpenChange={onOpenChange}>
      {detail ? (
        <DialogPopup className="max-h-[85vh] max-w-2xl overflow-hidden">
          <DialogHeader>
            <DialogTitle>{listingName(detail.listing)}</DialogTitle>
            <DialogDescription>{listingDescription(detail.listing)}</DialogDescription>
          </DialogHeader>
          <DialogPanel className="min-h-0 space-y-4 overflow-y-auto">
            <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1.5 text-ui-sm">
              <dt className="text-muted-foreground">{t("settings:plugins_detailAuthor")}</dt>
              <dd className="break-all text-foreground">
                {detail.listing.author.name?.trim() || detail.listing.author.github}
              </dd>
              <dt className="text-muted-foreground">{t("settings:plugins_detailVersion")}</dt>
              <dd className="text-foreground">
                {detail.listing.artifact.kind === "npm"
                  ? detail.listing.artifact.version
                  : detail.listing.artifact.commit.slice(0, 7)}
              </dd>
              <dt className="text-muted-foreground">{t("settings:plugins_detailSource")}</dt>
              <dd className="break-all text-foreground">{installSource(detail.listing)}</dd>
              {detail.listing.license ? (
                <>
                  <dt className="text-muted-foreground">{t("settings:plugins_detailLicense")}</dt>
                  <dd className="text-foreground">{detail.listing.license}</dd>
                </>
              ) : null}
              <dt className="text-muted-foreground">{t("settings:plugins_detailRepository")}</dt>
              <dd>
                <a
                  className="break-all text-foreground underline underline-offset-2"
                  href={detail.listing.repository.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  {detail.listing.repository.url}
                </a>
              </dd>
            </dl>
            {detail.listing.replaces && detail.listing.replaces.length > 0 ? (
              <p className="text-ui-sm text-muted-foreground">
                {t("settings:plugins_marketReplaces")}: {detail.listing.replaces.join(", ")}
              </p>
            ) : null}
            {detail.installed?.providers && detail.installed.providers.length > 0 ? (
              <p className="text-ui-sm text-muted-foreground">
                {t("settings:plugins_marketServes", {
                  value0: detail.installed.providers.join(", "),
                })}
              </p>
            ) : null}
            <div className="rounded-xl border border-border bg-background/40 p-3">
              <p className="mb-2 text-ui-sm font-medium text-foreground">
                {t("settings:plugins_detailReadme")}
              </p>
              {readmeQuery.isLoading ? (
                <Skeleton className="h-24 w-full rounded-lg" />
              ) : readmeQuery.isError ? (
                <p className="text-ui-sm text-muted-foreground">
                  {t("settings:plugins_detailReadmeUnavailable")}
                </p>
              ) : (
                <pre className="max-h-[40vh] overflow-y-auto font-mono text-ui-xs whitespace-pre-wrap text-foreground">
                  {readmeQuery.data}
                </pre>
              )}
            </div>
          </DialogPanel>
          <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {t("common:form_close")}
            </Button>
            {detail.installed ? (
              <span className="inline-flex items-center gap-1 text-ui-sm text-muted-foreground">
                <CheckIcon className="size-3.5" />
                {t("settings:plugins_installed")}
              </span>
            ) : (
              <Button
                variant="secondary"
                disabled={pending}
                onClick={() => onInstall(detail.listing)}
              >
                <DownloadIcon />
                {t("settings:plugins_install")}
              </Button>
            )}
          </div>
        </DialogPopup>
      ) : null}
    </Dialog>
  );
}

function SectionHeader({ title }: { title: string }) {
  return <h2 className="px-3 pt-2 pb-1 text-[15px] font-semibold text-foreground">{title}</h2>;
}

// ── Main component ─────────────────────────────────────────────────────────

export function PluginLibrary(props?: {
  readonly cwd?: string | null;
  readonly embedded?: boolean;
}) {
  const embedded = props?.embedded ?? false;
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const [selectedTab, setSelectedTab] = useState<PluginTab>("installed");
  const [settingsPlugin, setSettingsPlugin] = useState<NeolixPlugin | null>(null);
  const [logsPlugin, setLogsPlugin] = useState<NeolixPlugin | null>(null);
  const [installSourceInput, setInstallSourceInput] = useState("");
  const [marketSearch, setMarketSearch] = useState("");
  const [marketQuery, setMarketQuery] = useState("");
  const [searchMirror, setSearchMirror] = useState(false);
  const [detail, setDetail] = useState<{
    listing: NeolixPluginListing;
    installed?: NeolixPlugin;
  } | null>(null);
  const localProviderStatuses = useProviderStatusesForLocalConfig();
  const providerStatuses = useMemo(() => {
    const map = new Map<string, { readonly status: string }>();
    for (const status of localProviderStatuses) {
      const driver = status.driver ?? status.provider;
      map.set(driver, status);
    }
    return map;
  }, [localProviderStatuses]);
  const selectListing = (listing: NeolixPluginListing) => {
    const installed = installedForListing(pluginsQuery.data?.plugins ?? [], listing);
    setDetail(installed ? { listing, installed } : { listing });
  };

  const pluginsQuery = useInstalledPluginsQuery();

  const builtinQuery = useQuery({
    queryKey: ["neolix", "plugins", "builtin"],
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!api.neolix) throw new PluginsUnsupportedError(t("settings:plugins_unsupportedError"));
      return api.neolix.plugins.builtin();
    },
    retry: false,
    staleTime: 60_000,
  });

  const marketListingsQuery = useQuery({
    queryKey: ["neolix", "plugins", "market"],
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!api.neolix) throw new PluginsUnsupportedError(t("settings:plugins_unsupportedError"));
      return api.neolix.plugins.market();
    },
    enabled: selectedTab === "discover",
    retry: false,
    staleTime: 60_000,
  });

  const marketSearchQuery = useQuery({
    queryKey: ["neolix", "plugins", "market-search", marketQuery, searchMirror],
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!api.neolix) throw new PluginsUnsupportedError(t("settings:plugins_unsupportedError"));
      return api.neolix.plugins.searchMarket({
        query: marketQuery,
        ...(searchMirror ? { mirror: true } : {}),
      });
    },
    enabled: selectedTab === "discover" && marketQuery.trim().length > 0,
    retry: false,
    staleTime: 30_000,
  });

  const refreshPlugins = () => {
    invalidatePluginCatalog();
    return queryClient.invalidateQueries({ queryKey: ["neolix", "plugins"] });
  };

  const installMutation = useMutation({
    mutationFn: async (source: string) => {
      const api = ensureNativeApi();
      if (!api.neolix) throw new PluginsUnsupportedError(t("settings:plugins_unsupportedError"));
      return api.neolix.plugins.install({ source });
    },
    onSuccess: async () => {
      setInstallSourceInput("");
      await refreshPlugins();
    },
  });

  const manageMutation = useMutation({
    mutationFn: async (input: {
      action: "enable" | "disable" | "reload" | "remove";
      pluginId: string;
    }) => {
      const api = ensureNativeApi();
      if (!api.neolix) throw new PluginsUnsupportedError(t("settings:plugins_unsupportedError"));
      const { action, pluginId } = input;
      if (action === "enable") return api.neolix.plugins.enable({ pluginId });
      if (action === "disable") return api.neolix.plugins.disable({ pluginId });
      if (action === "reload") return api.neolix.plugins.reload({ pluginId });
      return api.neolix.plugins.remove({ pluginId });
    },
    onSuccess: refreshPlugins,
  });

  // Enabling asks first: plugins are trusted, unsandboxed code. Disabling needs no confirmation.
  const [confirmGlobalEnable, setConfirmGlobalEnable] = useState(false);
  const globalToggleMutation = useMutation({
    mutationFn: (enabled: boolean) => patchHostConfig({ pluginsEnabled: enabled }),
    onSuccess: async (_saved, enabled) => {
      toastManager.add({
        type: "success",
        title: enabled ? t("settings:plugins_globalEnabled") : t("settings:plugins_globalDisabled"),
      });
      await refreshPlugins();
    },
    onError: (error) => {
      toastManager.add({
        type: "error",
        title: t("settings:couldNotSaveHostSettings"),
        description: errorMessage(error),
      });
    },
  });

  const plugins = pluginsQuery.data?.plugins ?? [];
  const pluginsGloballyDisabled = pluginsQuery.data?.pluginsEnabled === false;
  const pluginsGloballyEnabled = pluginsQuery.data?.pluginsEnabled === true;
  const globalToggleError = globalToggleMutation.isError
    ? errorMessage(globalToggleMutation.error)
    : null;
  const globalPluginsNotice = pluginsGloballyDisabled ? (
    <InlineWarning>{t("settings:plugins_globallyDisabled")}</InlineWarning>
  ) : null;
  const builtinIds = builtinQuery.data?.plugins ?? [];
  const filteredPlugins = plugins;

  const installedSections = [
    { key: "installed", title: t("settings:plugins_installedSection"), plugins: filteredPlugins },
  ];

  const listings = marketListingsQuery.data?.plugins ?? [];
  const filteredBuiltinIds = builtinIds;
  const searchHits = marketSearchQuery.data?.hits ?? [];

  const pending = installMutation.isPending || manageMutation.isPending;
  const unsupported = pluginsQuery.isError && pluginsQuery.error instanceof PluginsUnsupportedError;

  const tabs = (
    <div className="flex flex-wrap items-center gap-2">
      <TabButton
        label={t("settings:plugins_tabInstalled")}
        active={selectedTab === "installed"}
        count={filteredPlugins.length}
        onClick={() => setSelectedTab("installed")}
      />
      <TabButton
        label={t("settings:plugins_tabMarket")}
        active={selectedTab === "discover"}
        onClick={() => setSelectedTab("discover")}
      />
      <TabButton
        label={t("settings:plugins_tabBuiltin")}
        active={selectedTab === "builtin"}
        count={filteredBuiltinIds.length}
        onClick={() => setSelectedTab("builtin")}
      />
    </div>
  );

  const body = (
    <div className={embedded ? undefined : "min-h-0 flex-1 overflow-y-auto"}>
      {selectedTab === "installed" ? (
        <div className={cn("flex flex-col gap-2 pb-8", !embedded && "mx-auto max-w-2xl px-6")}>
          {pluginsQuery.isSuccess ? (
            <GlobalPluginSwitch
              enabled={pluginsGloballyEnabled}
              pending={globalToggleMutation.isPending}
              error={globalToggleError}
              onEnable={() => setConfirmGlobalEnable(true)}
              onDisable={() => {
                globalToggleMutation.reset();
                globalToggleMutation.mutate(false);
              }}
            />
          ) : null}
          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const source = installSourceInput.trim();
              if (source.length === 0) return;
              installMutation.mutate(source);
            }}
          >
            <InputGroup className="flex-1 rounded-xl bg-background/70 shadow-xs">
              <InputGroupAddon>
                <InputGroupText>
                  <AddPlusIcon className="size-4 text-muted-foreground/60" />
                </InputGroupText>
              </InputGroupAddon>
              <InputGroupInput
                value={installSourceInput}
                onChange={(event) => setInstallSourceInput(event.target.value)}
                placeholder={t("settings:plugins_installPlaceholder")}
                className="text-ui leading-snug"
                disabled={installMutation.isPending}
              />
            </InputGroup>
            <Button
              type="submit"
              variant="secondary"
              disabled={installSourceInput.trim().length === 0 || installMutation.isPending}
            >
              {installMutation.isPending
                ? t("settings:plugins_installing")
                : t("settings:plugins_install")}
            </Button>
          </form>

          {installMutation.isError ? (
            <InlineWarning>{errorMessage(installMutation.error)}</InlineWarning>
          ) : null}

          {unsupported ? (
            <EmptyPanel
              title={t("settings:plugins_unsupportedTitle")}
              description={t("settings:plugins_unsupportedDescription")}
            />
          ) : pluginsQuery.isLoading ? (
            <div className="space-y-1">
              {["1", "2", "3"].map((key) => (
                <Skeleton key={key} className="h-[68px] w-full rounded-xl" />
              ))}
            </div>
          ) : pluginsQuery.isError ? (
            <InlineWarning>{errorMessage(pluginsQuery.error)}</InlineWarning>
          ) : plugins.length === 0 ? (
            <EmptyPanel
              title={t("settings:plugins_emptyInstalledTitle")}
              description={t("settings:plugins_emptyInstalledDescription")}
            />
          ) : (
            installedSections.map((section) => (
              <div key={section.key} className="space-y-0.5">
                <SectionHeader title={section.title} />
                {section.plugins.map((plugin) => (
                  <InstalledRow
                    key={plugin.id}
                    plugin={plugin}
                    providerStatuses={providerStatuses}
                    pending={pending}
                    onEnable={() =>
                      manageMutation.mutate({ action: "enable", pluginId: plugin.id })
                    }
                    onDisable={() =>
                      manageMutation.mutate({ action: "disable", pluginId: plugin.id })
                    }
                    onReload={() =>
                      manageMutation.mutate({ action: "reload", pluginId: plugin.id })
                    }
                    onRemove={() => {
                      void ensureNativeApi()
                        .dialogs.confirm(
                          t("settings:plugins_removeConfirm", { name: pluginName(plugin) }),
                          { confirmLabel: t("common:confirm_remove"), destructive: true },
                        )
                        .then((confirmed) => {
                          if (confirmed) {
                            manageMutation.mutate({ action: "remove", pluginId: plugin.id });
                          }
                        });
                    }}
                    onSettings={() => setSettingsPlugin(plugin)}
                    onLogs={() => setLogsPlugin(plugin)}
                  />
                ))}
              </div>
            ))
          )}
          {manageMutation.isError ? (
            <InlineWarning>{errorMessage(manageMutation.error)}</InlineWarning>
          ) : null}
        </div>
      ) : null}

      {selectedTab === "discover" ? (
        <div className={cn("pb-10", !embedded && "px-3 sm:px-5")}>
          <div className={cn("flex flex-col gap-2 pb-4", !embedded && "mx-auto max-w-2xl px-3")}>
            <form
              className="flex items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                setMarketQuery(marketSearch.trim());
              }}
            >
              <InputGroup className="flex-1 rounded-xl bg-background/70 shadow-xs">
                <InputGroupAddon>
                  <InputGroupText>
                    <SearchIcon className="size-4 text-muted-foreground/60" />
                  </InputGroupText>
                </InputGroupAddon>
                <InputGroupInput
                  value={marketSearch}
                  onChange={(event) => setMarketSearch(event.target.value)}
                  placeholder={t("settings:plugins_searchPlaceholder")}
                  className="text-ui leading-snug"
                />
              </InputGroup>
              <Button type="submit" variant="secondary">
                {t("settings:plugins_search")}
              </Button>
              {marketQuery.length > 0 ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  title={t("settings:plugins_clearSearch")}
                  onClick={() => {
                    setMarketSearch("");
                    setMarketQuery("");
                  }}
                >
                  <XIcon />
                </Button>
              ) : null}
            </form>
            <label className="flex items-center gap-2 text-ui text-muted-foreground">
              <input
                type="checkbox"
                checked={searchMirror}
                onChange={(event) => setSearchMirror(event.target.checked)}
                disabled={marketQuery.length === 0}
              />
              {t("settings:plugins_useMirror")}
            </label>
          </div>

          {marketQuery.length > 0 ? (
            <div className={cn("space-y-0.5", !embedded && "mx-auto max-w-2xl px-3")}>
              {marketSearchQuery.isLoading ? (
                <div className="space-y-1">
                  {["1", "2", "3"].map((key) => (
                    <Skeleton key={key} className="h-[64px] w-full rounded-xl" />
                  ))}
                </div>
              ) : marketSearchQuery.isError ? (
                isMarketRegistryUnconfigured(marketSearchQuery.error) ? (
                  <EmptyPanel
                    title={t("settings:plugins_marketUnconfiguredTitle")}
                    description={t("settings:plugins_marketUnconfiguredDescription")}
                  />
                ) : (
                  <InlineWarning>{errorMessage(marketSearchQuery.error)}</InlineWarning>
                )
              ) : searchHits.length === 0 ? (
                <EmptyPanel
                  title={t("settings:plugins_noMatchesTitle")}
                  description={t("settings:plugins_noMatchesDescription")}
                />
              ) : (
                searchHits.map((hit: NeolixPluginMarketHit) => {
                  const installed = plugins.find((plugin) => plugin.id === hit.package);
                  return (
                    <div
                      key={hit.package}
                      className="flex items-center gap-3 rounded-xl px-3 py-3 hover:bg-[var(--sidebar-accent)]"
                    >
                      <span className="inline-flex size-11 shrink-0 items-center justify-center rounded-[14px] border border-border/60 bg-background">
                        <PluginIcon className="size-5 text-muted-foreground/70" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-ui-lg font-semibold text-foreground">
                          {hit.name}
                        </p>
                        <p className="mt-0.5 truncate text-ui text-muted-foreground">
                          {hit.description ?? hit.package}
                        </p>
                        <p className="mt-0.5 truncate text-ui-sm text-muted-foreground/60">
                          {hit.package}
                          {hit.version ? ` · v${hit.version}` : ""}
                          {hit.weeklyDownloads !== undefined
                            ? ` · ${t("settings:plugins_weeklyDownloads", {
                                value: formatCount(hit.weeklyDownloads),
                              })}`
                            : ""}
                        </p>
                      </div>
                      {installed ? (
                        <span className="text-ui-sm text-muted-foreground">
                          {t("settings:plugins_installed")}
                        </span>
                      ) : (
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={pending}
                          onClick={() => installMutation.mutate(`npm:${hit.package}`)}
                        >
                          <DownloadIcon />
                          {t("settings:plugins_install")}
                        </Button>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          ) : (
            <div className={cn(!embedded && "mx-auto max-w-2xl")}>
              {marketListingsQuery.isLoading ? (
                <div className="space-y-1">
                  {["1", "2", "3", "4", "5", "6"].map((key) => (
                    <Skeleton key={key} className="h-[68px] w-full rounded-xl" />
                  ))}
                </div>
              ) : marketListingsQuery.isError ? (
                isMarketRegistryUnconfigured(marketListingsQuery.error) ? (
                  <EmptyPanel
                    title={t("settings:plugins_marketUnconfiguredTitle")}
                    description={t("settings:plugins_marketUnconfiguredDescription")}
                  />
                ) : (
                  <InlineWarning>{errorMessage(marketListingsQuery.error)}</InlineWarning>
                )
              ) : listings.length === 0 ? (
                <EmptyPanel
                  title={t("settings:plugins_marketEmptyTitle")}
                  description={t("settings:plugins_marketEmptyDescription")}
                />
              ) : (
                <div className="space-y-0.5">
                  <SectionHeader
                    title={
                      marketListingsQuery.data?.registry.name ?? t("settings:plugins_marketTitle")
                    }
                  />
                  {listings.map((listing) => (
                    <MarketRow
                      key={listing.id}
                      listing={listing}
                      installed={installedForListing(plugins, listing)}
                      weeklyDownloads={marketListingsQuery.data?.weeklyDownloads?.[listing.id]}
                      providerStatuses={providerStatuses}
                      pending={pending}
                      onInstall={() => installMutation.mutate(installSource(listing))}
                      onSelect={() => selectListing(listing)}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
          {installMutation.isError ? (
            <div className={cn("pt-3", !embedded && "mx-auto max-w-2xl px-3")}>
              <InlineWarning>{errorMessage(installMutation.error)}</InlineWarning>
            </div>
          ) : null}
        </div>
      ) : null}

      {selectedTab === "builtin" ? (
        <div className={cn("pb-10", !embedded && "px-3 sm:px-5")}>
          <div className={cn(!embedded && "mx-auto max-w-2xl")}>
            <BuiltinFeatureSwitches />
            <div className="mt-4">
              {builtinQuery.isLoading ? (
                <div className="space-y-1">
                  {["1", "2", "3"].map((key) => (
                    <Skeleton key={key} className="h-[64px] w-full rounded-xl" />
                  ))}
                </div>
              ) : builtinQuery.isError ? (
                <InlineWarning>{errorMessage(builtinQuery.error)}</InlineWarning>
              ) : builtinIds.length === 0 ? (
                <EmptyPanel
                  title={t("settings:plugins_builtinEmptyTitle")}
                  description={t("settings:plugins_builtinEmptyDescription")}
                />
              ) : (
                <div className="space-y-0.5">
                  <SectionHeader title={t("settings:plugins_builtinSection")} />
                  {builtinIds.map((id) => (
                    <BuiltinRow key={id} id={id} />
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      ) : null}
      {/* myna's Settings > Plugins slot: panels a plugin puts on this page. */}
      <PluginSlotPanels
        slot="settings"
        className={cn("pb-8", !embedded && "mx-auto max-w-2xl px-6")}
      />
    </div>
  );

  const dialogs = (
    <>
      <PluginSettingsDialog
        open={settingsPlugin !== null}
        plugin={settingsPlugin}
        onOpenChange={(open) => {
          if (!open) setSettingsPlugin(null);
        }}
      />
      <PluginLogsDialog
        open={logsPlugin !== null}
        plugin={logsPlugin}
        onOpenChange={(open) => {
          if (!open) setLogsPlugin(null);
        }}
      />
      <PluginDetailDialog
        detail={detail}
        pending={pending}
        onOpenChange={(open) => {
          if (!open) setDetail(null);
        }}
        onInstall={(listing) => installMutation.mutate(installSource(listing))}
      />
      <AlertDialog
        open={confirmGlobalEnable}
        onOpenChange={(open) => {
          if (!open) setConfirmGlobalEnable(false);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("settings:plugins_globalConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("settings:plugins_globalConfirmMessage")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" size="sm" />}>
              {t("common:form_cancel")}
            </AlertDialogClose>
            <Button
              size="sm"
              disabled={globalToggleMutation.isPending}
              onClick={() => {
                setConfirmGlobalEnable(false);
                globalToggleMutation.reset();
                globalToggleMutation.mutate(true);
              }}
            >
              {t("settings:plugins_globalConfirmAction")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );

  return embedded ? (
    <div className="flex flex-col">
      {globalPluginsNotice ? <div className="pb-2">{globalPluginsNotice}</div> : null}
      <div className="flex flex-wrap items-center gap-3 pb-2">{tabs}</div>
      {body}
      {dialogs}
    </div>
  ) : (
    // The same route shell as the other pages: the header strip, then the inset card.
    <RouteInsetSurface>
      <div
        className={cn(
          "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
          CHAT_BACKGROUND_CLASS_NAME,
        )}
      >
        <RouteSurfaceHeader>{tabs}</RouteSurfaceHeader>
        {globalPluginsNotice ? (
          <div className={cn("pb-2", !embedded && "mx-auto w-full max-w-2xl px-6")}>
            {globalPluginsNotice}
          </div>
        ) : null}
        {body}
        {dialogs}
      </div>
    </RouteInsetSurface>
  );
}
