// FILE: LibraryMcpMarketDialog.tsx
// Purpose: Settings → Library → MCP → Market. Searches Neox's server
//   registry and installs a picked server with its required inputs.
// Layer: Settings UI components

import type { LibraryMarketServer, LibrarySnapshot } from "@synara/contracts";
import { useEffect, useEffectEvent, useState } from "react";

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
import { toastManager } from "~/components/ui/toast";
import { neolixLibraryApi } from "~/lib/neolixLibraryClient";
import { localizeLibraryError } from "~/lib/errorLocalization";
import { useTranslation } from "~/i18n";
import { LibraryAgentChips, LibraryField } from "./LibraryShared";

function orNull(value: string | null | undefined): string | null {
  return value ?? null;
}

export function LibraryMcpMarketDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  library: LibrarySnapshot;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [servers, setServers] = useState<LibraryMarketServer[] | null>(null);
  const [registryError, setRegistryError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<LibraryMarketServer | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [agents, setAgents] = useState<string[]>([]);

  const search = async (text: string) => {
    setBusy(true);
    setError(null);
    try {
      const result = await neolixLibraryApi.searchMarket({ query: text });
      setServers([...result.servers]);
      setRegistryError(orNull(result.error));
    } catch (failure) {
      setError(localizeLibraryError(failure, t));
    }
    setBusy(false);
  };

  const runSearch = useEffectEvent(search);
  useEffect(() => {
    if (!props.open) return;
    setPicked(null);
    setValues({});
    setError(null);
    void runSearch("");
  }, [props.open]);

  const pick = (server: LibraryMarketServer) => {
    setPicked(server);
    setValues({});
    setAgents(server.optIn ? [] : props.library.agents.map((agent) => agent.id));
    setError(null);
  };

  const install = async () => {
    if (!picked) return;
    const missing = picked.inputs.some(
      (input) => input.required === true && (values[input.key] ?? "").trim() === "",
    );
    if (missing) {
      setError(t("settings:library_mcp_marketRequired"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await neolixLibraryApi.installMarketServer({
        id: picked.id,
        values,
        agents,
      });
      props.onChanged();
      toastManager.add({ type: "success", title: t("settings:library_saved") });
      props.onOpenChange(false);
    } catch (failure) {
      setError(localizeLibraryError(failure, t));
    }
    setBusy(false);
  };

  const installedName = (server: LibraryMarketServer) =>
    server.have ?? props.library.mcp.find((entry) => entry.name === server.name)?.name;

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {picked
              ? t("settings:library_mcp_installTitle", { name: picked.title })
              : t("settings:library_mcp_market")}
          </DialogTitle>
          <DialogDescription>{picked?.description}</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {picked ? (
            <div className="space-y-3">
              {picked.inputs.map((input) => (
                <LibraryField key={input.key} label={input.label} hint={input.description}>
                  <Input
                    aria-label={input.label}
                    type={input.secret ? "password" : "text"}
                    autoComplete="off"
                    placeholder={input.placeholder ?? (input.secret ? "•••" : "")}
                    value={values[input.key] ?? ""}
                    onChange={(event) =>
                      setValues((current) => ({
                        ...current,
                        [input.key]: event.target.value,
                      }))
                    }
                  />
                </LibraryField>
              ))}
              <LibraryField label={t("settings:library_agents")}>
                <LibraryAgentChips
                  agents={props.library.agents}
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
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Input
                  aria-label={t("settings:library_mcp_marketPlaceholder")}
                  placeholder={t("settings:library_mcp_marketPlaceholder")}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void search(query);
                  }}
                />
                <Button variant="outline" disabled={busy} onClick={() => void search(query)}>
                  {busy
                    ? t("settings:library_mcp_marketLoading")
                    : t("settings:library_mcp_marketSearch")}
                </Button>
              </div>
              {registryError ? (
                <p className="text-ui-sm text-destructive">
                  {t("settings:library_mcp_marketRegistryError", { error: registryError })}
                </p>
              ) : null}
              {servers === null ? null : servers.length === 0 ? (
                <p className="text-ui-sm text-muted-foreground">
                  {t("settings:library_mcp_marketEmpty")}
                </p>
              ) : (
                <div className="max-h-80 overflow-y-auto">
                  {servers.map((server) => {
                    const have = installedName(server);
                    return (
                      <div
                        key={`${server.id}:${server.name}`}
                        className="flex items-center gap-3 border-b border-border/40 px-1 py-2 last:border-b-0"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-ui font-medium text-foreground">
                            {server.title}
                          </p>
                          <p className="truncate text-ui-sm text-muted-foreground">
                            {server.publisher ? `${server.publisher} · ` : ""}
                            {server.description}
                          </p>
                        </div>
                        {have ? (
                          <span className="shrink-0 text-ui-sm text-muted-foreground">
                            {t("settings:library_mcp_marketHave", { name: have })}
                          </span>
                        ) : (
                          <Button size="sm" variant="outline" onClick={() => pick(server)}>
                            {t("settings:library_mcp_marketAdd")}
                          </Button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
          {error ? <p className="text-ui-sm text-destructive">{error}</p> : null}
        </DialogPanel>
        <DialogFooter>
          {picked ? (
            <>
              <Button variant="outline" onClick={() => setPicked(null)}>
                {t("common:form_cancel")}
              </Button>
              <Button disabled={busy} onClick={() => void install()}>
                {t("settings:library_mcp_marketAdd")}
              </Button>
            </>
          ) : (
            <Button variant="outline" onClick={() => props.onOpenChange(false)}>
              {t("common:form_cancel")}
            </Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
