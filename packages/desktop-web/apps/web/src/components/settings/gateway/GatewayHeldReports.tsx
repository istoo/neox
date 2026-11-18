// FILE: GatewayHeldReports.tsx
// Purpose: The reports Neox writes when a request waits too long for an account,
//          and the report belonging to one past call. Read-only text from the
//          daemon's held folder, with the folder's reveal action.
// Layer: Settings UI components

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { useTranslation } from "~/i18n";
import { neolixGatewayApi } from "~/lib/neolixGatewayApi";

import { Button } from "../../ui/button";

function heldListQueryKey() {
  return ["neolix-gateway", "held", "list"] as const;
}

function heldTextQueryKey(name: string) {
  return ["neolix-gateway", "held", "text", name] as const;
}

/** One report's text, or null once it is gone. */
function HeldReportText({ name }: { name: string }) {
  const { t } = useTranslation();
  const query = useQuery({
    queryKey: heldTextQueryKey(name),
    queryFn: () => neolixGatewayApi.heldRead(name),
    staleTime: 30_000,
  });
  if (query.isLoading) {
    return <div className="text-ui-sm text-muted-foreground">{t("gateway:history_reading")}</div>;
  }
  if (query.error) {
    return <div className="text-ui-sm text-destructive">{String(query.error)}</div>;
  }
  if (query.data?.text == null) {
    return <div className="text-ui-sm text-muted-foreground">{t("gateway:history_heldGone")}</div>;
  }
  return (
    <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded bg-foreground/5 p-2 text-ui-xs">
      {query.data.text}
    </pre>
  );
}

/**
 * The last few held reports, newest first, each opened as text. Hidden when the
 * daemon kept none.
 */
export function GatewayHeldReports() {
  const { t } = useTranslation();
  const query = useQuery({
    queryKey: heldListQueryKey(),
    queryFn: neolixGatewayApi.heldList,
    staleTime: 10_000,
  });
  const [openName, setOpenName] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const names = query.data?.names ?? [];

  if (names.length === 0) {
    return null;
  }

  const reveal = (name?: string) => {
    void neolixGatewayApi.heldReveal(name).then((result) => {
      setFailure(result.ok ? null : (result.error ?? t("gateway:history_revealFailed")));
    });
  };

  return (
    <div className="space-y-1.5 border-t border-[color:var(--color-border)] px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="text-ui font-medium text-foreground">{t("gateway:history_heldTitle")}</div>
        <Button size="xs" variant="ghost" onClick={() => reveal()}>
          {t("gateway:history_openHeldFolder")}
        </Button>
      </div>
      <div className="text-ui-xs text-muted-foreground">{t("gateway:history_heldHint")}</div>
      {failure === null ? null : <div className="text-ui-sm text-destructive">{failure}</div>}
      {names.map((name) => (
        <div key={name} className="space-y-1">
          <Button
            size="xs"
            variant="ghost"
            aria-expanded={openName === name}
            onClick={() => setOpenName((current) => (current === name ? null : name))}
          >
            {name}
          </Button>
          {openName === name ? <HeldReportText name={name} /> : null}
        </div>
      ))}
    </div>
  );
}

/** The held report of one past call, with Copy and the folder's reveal action. */
export function GatewayHeldRouteReport({ name }: { name: string }) {
  const { t } = useTranslation();
  const query = useQuery({
    queryKey: heldTextQueryKey(name),
    queryFn: () => neolixGatewayApi.heldRead(name),
    staleTime: 30_000,
  });
  const [failure, setFailure] = useState<string | null>(null);
  const text = query.data?.text ?? null;
  const reveal = () => {
    void neolixGatewayApi.heldReveal(name).then((result) => {
      setFailure(result.ok ? null : (result.error ?? t("gateway:history_revealFailed")));
    });
  };
  return (
    <div className="mt-2 space-y-1 rounded-md bg-foreground/5 p-2">
      <div className="flex flex-wrap items-center justify-between gap-1">
        <div className="text-ui-xs font-medium text-foreground">
          {t("gateway:history_heldTitle")}
        </div>
        <div className="flex items-center gap-1">
          <Button size="xs" variant="ghost" onClick={reveal}>
            {t("gateway:history_openHeldFolder")}
          </Button>
          <Button
            size="xs"
            variant="ghost"
            disabled={text === null}
            onClick={() => {
              if (text !== null) void navigator.clipboard?.writeText(text);
            }}
          >
            {t("gateway:history_copyReport")}
          </Button>
        </div>
      </div>
      {failure === null ? null : <div className="text-ui-sm text-destructive">{failure}</div>}
      <HeldReportText name={name} />
    </div>
  );
}
