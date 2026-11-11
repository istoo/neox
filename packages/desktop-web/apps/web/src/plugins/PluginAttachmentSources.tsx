// FILE: PluginAttachmentSources.tsx
// Purpose: Renders manifest attachment sources as composer buttons. Each opens a picker backed by
//          the plugin's declared search RPC and adds the picked resource as a real file attachment,
//          so it travels the same upload/send path as dropped files.
// Layer: Web plugin host
// Exports: PluginAttachmentSources

import type { NeolixPluginAttachmentSource } from "@synara/contracts";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { Dialog, DialogHeader, DialogPopup, DialogTitle } from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Spinner } from "~/components/ui/spinner";
import { useTranslation } from "~/i18n";

import { useRunningPlugins } from "./catalog";
import { buildPluginContributionIndex, invokePluginRpc } from "./contributions";
import { PluginGlyph } from "./PluginGlyph";

/** Typing pauses this long before the plugin's search RPC runs. */
const SEARCH_DEBOUNCE_MS = 200;

interface AttachmentItem {
  readonly id: string;
  readonly identifier?: string;
  readonly title: string;
  readonly subtitle?: string;
  readonly text: string;
  readonly resourceType?: string;
  readonly url?: string;
}

function readItems(output: unknown): AttachmentItem[] {
  if (typeof output !== "object" || output === null) return [];
  const items = (output as { items?: unknown }).items;
  if (!Array.isArray(items)) return [];
  const result: AttachmentItem[] = [];
  for (const item of items) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    if (typeof record.id !== "string" || typeof record.title !== "string") continue;
    // `insertText` is the old picker field; keep reading it so existing plugins still attach.
    const text =
      typeof record.text === "string"
        ? record.text
        : typeof record.insertText === "string"
          ? record.insertText
          : record.title;
    result.push({
      id: record.id,
      ...(typeof record.identifier === "string" ? { identifier: record.identifier } : {}),
      title: record.title,
      ...(typeof record.subtitle === "string" ? { subtitle: record.subtitle } : {}),
      text,
      ...(typeof record.resourceType === "string" ? { resourceType: record.resourceType } : {}),
      ...(typeof record.url === "string" ? { url: record.url } : {}),
    });
  }
  return result;
}

function resourceFileName(item: AttachmentItem): string {
  const base =
    [item.identifier, item.title].filter((value) => !!value?.trim()).join(" ") || item.id;
  const safe = base
    .replaceAll(/[\\/:*?"<>|\u0000-\u001f]/g, "-")
    .replaceAll(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return `${safe || "plugin-resource"}.txt`;
}

function resourceFile(item: AttachmentItem): File {
  const content = [
    [item.identifier, item.title].filter((value) => !!value?.trim()).join(" "),
    item.subtitle,
    item.url,
    item.text,
  ]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("\n\n");
  return new File([content], resourceFileName(item), { type: "text/plain" });
}

async function searchPluginAttachmentSource(args: {
  entry: { pluginId: string; contribution: NeolixPluginAttachmentSource };
  nextQuery: string;
  searchSequence: { current: number };
  setLoading: (value: boolean) => void;
  setError: (value: string | null) => void;
  setItems: (value: readonly AttachmentItem[]) => void;
}): Promise<void> {
  const { entry, nextQuery, searchSequence, setLoading, setError, setItems } = args;
  const sequence = ++searchSequence.current;
  setLoading(true);
  setError(null);
  try {
    const output = await invokePluginRpc(entry.pluginId, entry.contribution.search.method, {
      ...(typeof entry.contribution.search.input === "object" &&
      entry.contribution.search.input !== null &&
      !Array.isArray(entry.contribution.search.input)
        ? (entry.contribution.search.input as Record<string, unknown>)
        : {}),
      query: nextQuery,
    });
    if (sequence !== searchSequence.current) return;
    setItems(readItems(output));
  } catch (cause) {
    if (sequence !== searchSequence.current) return;
    setItems([]);
    setError(cause instanceof Error ? cause.message : String(cause));
  } finally {
    if (sequence === searchSequence.current) setLoading(false);
  }
}

export function PluginAttachmentSources({ onAttach }: { readonly onAttach: (file: File) => void }) {
  const plugins = useRunningPlugins();
  const sources = useMemo(() => buildPluginContributionIndex(plugins).attachmentSources, [plugins]);
  const [picked, setPicked] = useState<{
    pluginId: string;
    contribution: NeolixPluginAttachmentSource;
  } | null>(null);
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<readonly AttachmentItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { t } = useTranslation();
  // Only the newest search may write results: an older, slower response must not
  // replace what the user typed since.
  const searchSequence = useRef(0);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelPendingSearch = () => {
    if (debounceTimer.current !== null) clearTimeout(debounceTimer.current);
    debounceTimer.current = null;
    searchSequence.current += 1;
  };
  useEffect(() => cancelPendingSearch, []);
  if (sources.length === 0) return null;

  const search = (
    entry: { pluginId: string; contribution: NeolixPluginAttachmentSource },
    nextQuery: string,
  ) =>
    searchPluginAttachmentSource({
      entry,
      nextQuery,
      searchSequence,
      setLoading,
      setError,
      setItems,
    });

  return (
    <>
      {sources.map((entry) => (
        <Button
          key={`${entry.pluginId}:${entry.contribution.id}`}
          type="button"
          variant="ghost"
          size="sm"
          className="shrink-0 whitespace-nowrap px-2 text-ui-sm font-normal"
          title={entry.contribution.title}
          aria-label={entry.contribution.title}
          onClick={() => {
            cancelPendingSearch();
            setPicked({ pluginId: entry.pluginId, contribution: entry.contribution });
            setQuery("");
            setItems([]);
            setError(null);
            void search(entry, "");
          }}
        >
          <PluginGlyph name={entry.contribution.icon} />
          <span className="sr-only sm:not-sr-only">{entry.contribution.title}</span>
        </Button>
      ))}
      <Dialog
        open={picked !== null}
        onOpenChange={(open) => {
          if (!open) {
            cancelPendingSearch();
            setPicked(null);
          }
        }}
      >
        <DialogPopup className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {picked?.contribution.title ?? t("chat:pluginAttachment_title")}
            </DialogTitle>
          </DialogHeader>
          <div className="flex min-h-0 flex-col gap-2 px-4 pb-4">
            <Input
              value={query}
              placeholder={t("chat:pluginAttachment_search")}
              onChange={(event) => {
                const next = event.currentTarget.value;
                setQuery(next);
                if (!picked) return;
                const entry = { pluginId: picked.pluginId, contribution: picked.contribution };
                if (debounceTimer.current !== null) clearTimeout(debounceTimer.current);
                debounceTimer.current = setTimeout(() => {
                  debounceTimer.current = null;
                  void search(entry, next);
                }, SEARCH_DEBOUNCE_MS);
              }}
            />
            {loading ? (
              <div className="flex justify-center py-4">
                <Spinner />
              </div>
            ) : error ? (
              <p className="py-4 text-ui-sm text-destructive">{error}</p>
            ) : items.length === 0 ? (
              <p className="py-4 text-ui-sm text-muted-foreground">
                {t("chat:pluginAttachment_empty")}
              </p>
            ) : (
              <ul className="max-h-72 overflow-auto">
                {items.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      className="flex w-full flex-col rounded-lg px-2.5 py-2 text-left hover:bg-zinc-500/8 dark:hover:bg-zinc-400/10"
                      onClick={() => {
                        if (!picked) return;
                        onAttach(resourceFile(item));
                        setPicked(null);
                      }}
                    >
                      <span className="truncate text-ui">{item.title}</span>
                      {item.subtitle ? (
                        <span className="truncate text-ui-meta text-muted-foreground">
                          {item.subtitle}
                        </span>
                      ) : null}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </DialogPopup>
      </Dialog>
    </>
  );
}
