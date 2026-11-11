// FILE: LibraryDiscoverDialog.tsx
// Purpose: Settings → Library → MCP → Discover. Imports MCP servers and skills
//   already configured in the agents, plus anything a myna install has.
// Layer: Settings UI components

import type { LibraryFoundMcpServer, LibraryFoundSkill, LibrarySnapshot } from "@synara/contracts";
import { useEffect, useMemo, useState } from "react";

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
import { Switch } from "~/components/ui/switch";
import { toastManager } from "~/components/ui/toast";
import { neolixLibraryApi } from "~/lib/neolixLibraryClient";
import { localizeLibraryError } from "~/lib/errorLocalization";
import { useTranslation } from "~/i18n";

function serverLine(server: LibraryFoundMcpServer): string {
  const where =
    server.transport === "stdio"
      ? [server.command, ...(server.args ?? [])].filter(Boolean).join(" ")
      : (server.url ?? "");
  const secrets = [
    ...Object.keys(server.env ?? {}).map((key) => `env ${key}`),
    ...Object.keys(server.headers ?? {}).map((key) => `header ${key}`),
  ];
  return `${server.transport} · ${where}${secrets.length > 0 ? ` · ${secrets.join(", ")}` : ""}`;
}

function PickerRow(props: {
  title: string;
  hint: string;
  selected: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="flex items-start gap-3 border-b border-border/40 px-1 py-2 last:border-b-0">
      <div className="min-w-0 flex-1">
        <p className="truncate text-ui font-medium text-foreground">{props.title}</p>
        <p className="truncate text-ui-sm text-muted-foreground">{props.hint}</p>
      </div>
      <Switch checked={props.selected} aria-label={props.title} onCheckedChange={props.onToggle} />
    </div>
  );
}

function toggleIn(current: ReadonlySet<string>, name: string): Set<string> {
  const next = new Set(current);
  if (next.has(name)) next.delete(name);
  else next.add(name);
  return next;
}

export function LibraryDiscoverDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  library: LibrarySnapshot;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const [found, setFound] = useState<{
    servers: LibraryFoundMcpServer[];
    skills: LibraryFoundSkill[];
  } | null>(null);
  const [myna, setMyna] = useState<{
    dir: string;
    available: boolean;
    servers: LibraryFoundMcpServer[];
    skills: LibraryFoundSkill[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [agentServers, setAgentServers] = useState<Set<string>>(new Set());
  const [agentSkills, setAgentSkills] = useState<Set<string>>(new Set());
  const [mynaServers, setMynaServers] = useState<Set<string>>(new Set());
  const [mynaSkills, setMynaSkills] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!props.open) return;
    setFound(null);
    setMyna(null);
    setError(null);
    setAgentServers(new Set());
    setAgentSkills(new Set());
    setMynaServers(new Set());
    setMynaSkills(new Set());
    void (async () => {
      try {
        const [discover, mynaView] = await Promise.all([
          neolixLibraryApi.getDiscover(),
          neolixLibraryApi.getMynaLibrary(),
        ]);
        setFound({
          servers: [...discover.discover.servers],
          skills: [...discover.discover.skills],
        });
        setMyna({
          dir: mynaView.myna.dir,
          available: mynaView.myna.available,
          servers: [...mynaView.myna.servers],
          skills: [...mynaView.myna.skills],
        });
      } catch (failure) {
        setError(localizeLibraryError(failure, t));
      }
    })();
  }, [props.open, t]);

  const names = useMemo(() => {
    const map = new Map(props.library.agents.map((agent) => [agent.id, agent.name]));
    return (ids: ReadonlyArray<string>) => ids.map((id) => map.get(id) ?? id).join(", ");
  }, [props.library.agents]);

  const hasSelection =
    agentServers.size > 0 || agentSkills.size > 0 || mynaServers.size > 0 || mynaSkills.size > 0;

  const runImport = async () => {
    setBusy(true);
    setError(null);
    const importsAgents = agentServers.size > 0 || agentSkills.size > 0;
    const importsMyna = mynaServers.size > 0 || mynaSkills.size > 0;
    try {
      let count = 0;
      if (importsAgents) {
        const result = await neolixLibraryApi.importDiscovered({
          servers: [...agentServers],
          skills: [...agentSkills],
        });
        count += result.result.changed.length;
      }
      if (importsMyna) {
        const result = await neolixLibraryApi.importMynaLibrary({
          servers: [...mynaServers],
          skills: [...mynaSkills],
        });
        count += result.result.changed.length;
      }
      props.onChanged();
      toastManager.add({
        type: "success",
        title: t("settings:library_mcp_imported", { count }),
      });
      props.onOpenChange(false);
    } catch (failure) {
      setError(localizeLibraryError(failure, t));
    }
    setBusy(false);
  };

  const agentHint = (server: LibraryFoundMcpServer) => {
    const other = names(server.otherAgents);
    const line = serverLine(server);
    return other
      ? `${line} · ${t("settings:library_mcp_discoverOtherAgents", { agents: other })}`
      : `${line} · ${names(server.agents)}`;
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("settings:library_mcp_discoverTitle")}</DialogTitle>
          <DialogDescription>{t("settings:library_mcp_discoverIntro")}</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {found === null || myna === null ? (
            error ? null : (
              <p className="text-ui-sm text-muted-foreground">{t("settings:library_loading")}</p>
            )
          ) : (
            <div className="space-y-4">
              <section className="space-y-1">
                <h3 className="text-ui-sm font-medium text-foreground">
                  {t("settings:library_mcp_discoverServers")}
                </h3>
                {found.servers.length > 0 ? (
                  found.servers.map((server) => (
                    <PickerRow
                      key={server.name}
                      title={server.name}
                      hint={agentHint(server)}
                      selected={agentServers.has(server.name)}
                      onToggle={() => setAgentServers((current) => toggleIn(current, server.name))}
                    />
                  ))
                ) : (
                  <p className="text-ui-sm text-muted-foreground">
                    {t("settings:library_mcp_discoverEmpty")}
                  </p>
                )}
                <p className="text-ui-sm text-muted-foreground">
                  {t("settings:library_mcp_discoverSecretNote")}
                </p>
              </section>
              <section className="space-y-1">
                <h3 className="text-ui-sm font-medium text-foreground">
                  {t("settings:library_mcp_discoverSkills")}
                </h3>
                {found.skills.length > 0 ? (
                  found.skills.map((skill) => (
                    <PickerRow
                      key={skill.name}
                      title={skill.name}
                      hint={`${skill.description || skill.path} · ${names(skill.agents)}`}
                      selected={agentSkills.has(skill.name)}
                      onToggle={() => setAgentSkills((current) => toggleIn(current, skill.name))}
                    />
                  ))
                ) : (
                  <p className="text-ui-sm text-muted-foreground">
                    {t("settings:library_mcp_discoverEmpty")}
                  </p>
                )}
              </section>
              <section className="space-y-1">
                <h3 className="text-ui-sm font-medium text-foreground">
                  {t("settings:library_mcp_discoverMyna")}
                </h3>
                {myna.available ? (
                  <div className="space-y-1">
                    <p className="truncate text-ui-sm text-muted-foreground">{myna.dir}</p>
                    {myna.servers.map((server) => (
                      <PickerRow
                        key={`myna-server:${server.name}`}
                        title={server.name}
                        hint={agentHint(server)}
                        selected={mynaServers.has(server.name)}
                        onToggle={() => setMynaServers((current) => toggleIn(current, server.name))}
                      />
                    ))}
                    {myna.skills.map((skill) => (
                      <PickerRow
                        key={`myna-skill:${skill.name}`}
                        title={skill.name}
                        hint={`${skill.description || skill.path} · ${names(skill.agents)}`}
                        selected={mynaSkills.has(skill.name)}
                        onToggle={() => setMynaSkills((current) => toggleIn(current, skill.name))}
                      />
                    ))}
                  </div>
                ) : (
                  <p className="text-ui-sm text-muted-foreground">
                    {t("settings:library_mcp_discoverMynaMissing")}
                  </p>
                )}
              </section>
            </div>
          )}
          {error ? <p className="text-ui-sm text-destructive">{error}</p> : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={() => props.onOpenChange(false)}>
            {t("common:form_cancel")}
          </Button>
          <Button disabled={busy || !hasSelection} onClick={() => void runImport()}>
            {busy ? t("settings:library_mcp_importing") : t("settings:library_mcp_import")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
