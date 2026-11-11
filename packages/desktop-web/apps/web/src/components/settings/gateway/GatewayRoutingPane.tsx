// FILE: GatewayRoutingPane.tsx
// Purpose: Routing groups and the gateway's live/past routing decisions.
// Layer: Settings panel pane

import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { neolixGatewayApi } from "~/lib/neolixGatewayApi";
import type {
  GatewayArchiveRecord,
  GatewayConfig,
  GatewayGroup,
  GatewayRouteHistoryRow,
  GatewayTraceRoute,
} from "~/lib/gatewayTypes";
import { useTranslation } from "~/i18n";

import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { SettingsSection } from "../SettingsPanelPrimitives";
import { listText, stringList } from "./gatewayHelpers";
import {
  GatewayEmpty,
  GatewayField,
  GatewayNumberField,
  GatewayPill,
  GatewayRow,
  GatewayTextarea,
  GatewayToggle,
} from "./GatewayPrimitives";
import { GatewayRulesEditor } from "./GatewayRulesEditor";

const STRATEGIES = [
  "order",
  "rotate",
  "least-used",
  "smart",
  "pace",
  "free",
  "fast",
  "cheap",
  "drain",
] as const;

export interface GatewayRoutingProps {
  config: GatewayConfig;
  edit: (mutate: (draft: GatewayConfig) => void) => void;
  apply: (mutate: (draft: GatewayConfig) => void) => Promise<void>;
}

function updateGroup(
  edit: GatewayRoutingProps["edit"],
  id: string,
  mutate: (group: GatewayGroup) => void,
) {
  edit((draft) => {
    const group = (draft.groups ?? []).find((candidate) => candidate.id === id);
    if (group) mutate(group);
  });
}

function weightsText(weights: Record<string, number> | undefined): string {
  return Object.entries(weights ?? {})
    .map(([member, weight]) => `${member}=${weight}`)
    .join(", ");
}

function parseWeights(value: string): Record<string, number> {
  const weights: Record<string, number> = {};
  for (const part of value.split(",")) {
    const [member, raw] = part.split("=").map((entry) => entry.trim());
    if (!member) continue;
    const weight = Number(raw);
    if (Number.isInteger(weight) && weight > 0) weights[member] = weight;
  }
  return weights;
}

export function GatewayRoutingPane({ config, edit, apply }: GatewayRoutingProps) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [newId, setNewId] = useState("");
  const [traceOpen, setTraceOpen] = useState(false);
  const [stepsFor, setStepsFor] = useState<number | null>(null);
  const [historyDay, setHistoryDay] = useState<string | undefined>(undefined);
  const [archive, setArchive] = useState<GatewayArchiveRecord | null>(null);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [archiveTab, setArchiveTab] = useState<"request" | "response" | "upstream">("request");
  const [openHistoryId, setOpenHistoryId] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);

  // The stored order wins for groups that name it; hidden ones are left out.
  // Found groups the user hid stay out of `groups` but keep their id.
  const groups = useMemo(() => {
    const hiddenIds = new Set(config.hiddenGroups ?? []);
    const storedOrder = config.groupOrder ?? [];
    const rank = new Map(storedOrder.map((id, at) => [id, at]));
    return (config.groups ?? [])
      .filter((group) => !hiddenIds.has(group.id))
      .map((group, at) => ({ group, at, rank: rank.get(group.id) ?? storedOrder.length }))
      .toSorted((left, right) => left.rank - right.rank || left.at - right.at)
      .map((entry) => entry.group);
  }, [config.groups, config.hiddenGroups, config.groupOrder]);
  const needle = filter.trim().toLowerCase();
  const visible = needle
    ? groups.filter(
        (group) =>
          group.id.toLowerCase().includes(needle) ||
          (group.label ?? "").toLowerCase().includes(needle) ||
          group.members.some((member) => member.toLowerCase().includes(needle)),
      )
    : groups;

  const trace = useQuery({
    queryKey: ["neolix-gateway", "trace"],
    queryFn: neolixGatewayApi.getTrace,
    enabled: traceOpen,
    refetchInterval: traceOpen ? 5_000 : false,
  });
  const history = useQuery({
    queryKey: ["neolix-gateway", "history", historyDay ?? ""],
    queryFn: () => neolixGatewayApi.getRoutingHistory(historyDay),
  });

  const addGroup = () => {
    const id = (newId.trim() || `group-${groups.length + 1}`).replace(/[^A-Za-z0-9._-]/gu, "-");
    if (groups.some((group) => group.id === id)) {
      return;
    }
    edit((draft) => {
      draft.groups = [
        ...(draft.groups ?? []),
        { id, members: [], strategy: "order" } as GatewayGroup,
      ];
      draft.groupOrder = [id, ...(draft.groupOrder ?? [])];
    });
    setNewId("");
    setEditing(id);
  };

  // Moving a group writes both the draft order and `groupOrder`, which is what
  // the daemon ranks by; hidden groups keep their places after the listed ones.
  const reorderGroups = (fromId: string, toId: string) => {
    if (fromId === toId) return;
    const ids = groups.map((group) => group.id);
    const from = ids.indexOf(fromId);
    const to = ids.indexOf(toId);
    if (from < 0 || to < 0) return;
    ids.splice(to, 0, ...ids.splice(from, 1));
    edit((draft) => {
      const byId = new Map((draft.groups ?? []).map((group) => [group.id, group]));
      const ordered = ids.flatMap((id) => {
        const group = byId.get(id);
        return group === undefined ? [] : [group];
      });
      const listed = new Set(ordered.map((group) => group.id));
      draft.groups = [...ordered, ...(draft.groups ?? []).filter((group) => !listed.has(group.id))];
      draft.groupOrder = [...ids, ...(draft.hiddenGroups ?? [])];
    });
  };

  const moveGroupBy = (id: string, delta: -1 | 1) => {
    const ids = groups.map((group) => group.id);
    const at = ids.indexOf(id);
    const to = at + delta;
    if (at < 0 || to < 0 || to >= ids.length) return;
    const target = ids[to];
    if (target === undefined) return;
    reorderGroups(id, target);
  };

  const removeGroup = (group: GatewayGroup) => {
    edit((draft) => {
      if (group.auto === true) {
        // Hiding a found group keeps its id, so turning find on again does not
        // bring it back unasked.
        draft.hiddenGroups = [...(draft.hiddenGroups ?? []), group.id];
        draft.groupOrder = (draft.groupOrder ?? []).filter((id) => id !== group.id);
        return;
      }
      draft.groups = (draft.groups ?? []).filter((entry) => entry.id !== group.id);
      draft.groupOrder = (draft.groupOrder ?? []).filter((id) => id !== group.id);
    });
    setEditing(null);
  };

  // Providers the daemon's found groups may draw from: ready ones, plus any
  // skipped id whose provider is gone, so it can be let back in.
  const skippable = useMemo(() => {
    const skip = (config.autoGroupSkip ?? []).map((id) => id.trim()).filter((id) => id !== "");
    const skipped = new Set(skip.map((id) => id.toLowerCase()));
    const known = new Set<string>();
    const rows: Array<{ id: string; label: string }> = [];
    for (const provider of config.providers ?? []) {
      known.add(provider.id.toLowerCase());
      const ready =
        provider.enabled !== false && provider.exposeModels !== false && provider.models.length > 0;
      if (ready || skipped.has(provider.id.toLowerCase())) {
        rows.push({ id: provider.id, label: provider.label ?? provider.id });
      }
    }
    for (const id of skip) {
      if (!known.has(id.toLowerCase())) rows.push({ id, label: id });
    }
    return rows;
  }, [config.autoGroupSkip, config.providers]);

  const openArchive = async (row: GatewayRouteHistoryRow) => {
    if (openHistoryId === row.id) {
      setOpenHistoryId(null);
      setArchive(null);
      return;
    }
    const [date, id] = (row.archive ?? "").split("/");
    setArchiveError(null);
    setArchiveTab("request");
    setOpenHistoryId(row.id);
    setArchive(null);
    if (date === undefined || id === undefined || date === "" || id === "") {
      setArchiveError(t("gateway:archive_not_kept"));
      return;
    }
    try {
      setArchive(await neolixGatewayApi.getArchive({ date, id }));
    } catch (error) {
      setArchive(null);
      setArchiveError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <SettingsSection title="gateway:routing_groups">
        <div className="flex flex-wrap items-center gap-2 px-3 py-2">
          <Input
            value={filter}
            onChange={(event) => setFilter(event.currentTarget.value)}
            placeholder={t("gateway:search_groups")}
            size="sm"
            variant="soft"
            className="min-w-40 flex-1"
          />
          <Input
            value={newId}
            onChange={(event) => setNewId(event.currentTarget.value)}
            placeholder={t("gateway:new_group_id")}
            size="sm"
            variant="soft"
            className="w-40"
          />
          <Button size="sm" variant="outline" onClick={addGroup}>
            {t("gateway:add_group")}
          </Button>
        </div>
        <GatewayRow
          title={t("gateway:auto_groups")}
          description={t("gateway:auto_groups_hint")}
          trailing={
            <GatewayToggle
              checked={config.autoGroups !== false}
              label={t("gateway:auto_groups")}
              onChange={(checked) =>
                void apply((draft) => {
                  draft.autoGroups = checked;
                })
              }
            />
          }
        />
        {config.autoGroups !== false && skippable.length > 0 ? (
          <div className="px-3 py-2">
            <div className="text-ui-sm text-muted-foreground">{t("gateway:auto_group_skip")}</div>
            <div className="mt-0.5 text-ui-xs text-muted-foreground">
              {t("gateway:auto_group_skip_hint")}
            </div>
            <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1">
              {skippable.map((provider) => {
                const skipped = (config.autoGroupSkip ?? []).some(
                  (id) => id.trim().toLowerCase() === provider.id.toLowerCase(),
                );
                return (
                  <label key={provider.id} className="flex items-center gap-2 text-ui-sm">
                    <GatewayToggle
                      checked={skipped}
                      label={provider.label}
                      onChange={(checked) => {
                        edit((draft) => {
                          const ids = (draft.autoGroupSkip ?? [])
                            .map((id) => id.trim())
                            .filter(
                              (id) => id !== "" && id.toLowerCase() !== provider.id.toLowerCase(),
                            );
                          draft.autoGroupSkip = checked ? [...ids, provider.id] : ids;
                        });
                      }}
                    />
                    {provider.label}
                  </label>
                );
              })}
            </div>
          </div>
        ) : null}
        {groups.length === 0 ? (
          <div className="px-3 py-2">
            <GatewayEmpty>{t("gateway:no_groups")}</GatewayEmpty>
          </div>
        ) : (
          visible.map((group) => {
            const enabled = group.disabled !== true;
            const groupIndex = groups.findIndex((entry) => entry.id === group.id);
            return (
              <div
                key={group.id}
                draggable
                onDragStart={() => setDragId(group.id)}
                onDragEnd={() => setDragId(null)}
                onDragOver={(event) => event.preventDefault()}
                onDrop={() => {
                  if (dragId !== null) reorderGroups(dragId, group.id);
                  setDragId(null);
                }}
                className={`px-3 py-2.5 ${dragId === group.id ? "opacity-50" : ""}`}
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span
                        className={
                          enabled ? "text-ui font-medium" : "text-ui font-medium opacity-60"
                        }
                      >
                        {group.label ?? group.id}
                      </span>
                      <GatewayPill>{group.strategy ?? "order"}</GatewayPill>
                      <GatewayPill>
                        {t("gateway:member_count", { count: group.members.length })}
                      </GatewayPill>
                      {group.auto ? <GatewayPill tone="muted">auto</GatewayPill> : null}
                    </div>
                    <div className="mt-0.5 truncate text-ui-xs text-muted-foreground">
                      {group.members.join(" → ") || t("gateway:no_members")}
                    </div>
                    {group.members.length === 0 ? (
                      <div className="mt-0.5 text-ui-xs text-destructive">
                        {t("gateway:error_group_members", { id: group.id })}
                      </div>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-1">
                    <GatewayToggle
                      checked={enabled}
                      label={group.id}
                      onChange={(checked) =>
                        void apply((draft) => {
                          const target = draft.groups?.find((entry) => entry.id === group.id);
                          if (target) target.disabled = !checked;
                        })
                      }
                    />
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={groupIndex <= 0}
                      aria-label={t("gateway:move_up")}
                      onClick={() => moveGroupBy(group.id, -1)}
                    >
                      ↑
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={groupIndex < 0 || groupIndex >= groups.length - 1}
                      aria-label={t("gateway:move_down")}
                      onClick={() => moveGroupBy(group.id, 1)}
                    >
                      ↓
                    </Button>
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => setEditing(editing === group.id ? null : group.id)}
                    >
                      {editing === group.id ? t("gateway:close") : t("gateway:edit")}
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => {
                        if (
                          !window.confirm(t("gateway:remove_group_confirm", { name: group.id }))
                        ) {
                          return;
                        }
                        removeGroup(group);
                      }}
                    >
                      {t("gateway:remove")}
                    </Button>
                  </div>
                </div>
                {editing === group.id ? <GroupEditor group={group} edit={edit} /> : null}
              </div>
            );
          })
        )}
      </SettingsSection>

      <SettingsSection title="gateway:live">
        <div className="flex items-center justify-end px-3 py-2">
          <Button size="xs" variant="ghost" onClick={() => setTraceOpen((open) => !open)}>
            {traceOpen ? t("gateway:hide") : t("gateway:show")}
          </Button>
        </div>
        {!traceOpen ? (
          <div className="px-3 py-2">
            <GatewayEmpty>{t("gateway:live_hint")}</GatewayEmpty>
          </div>
        ) : trace.isLoading ? (
          <div className="px-3 py-2 text-ui-sm text-muted-foreground">{t("gateway:loading")}</div>
        ) : trace.error ? (
          <div className="px-3 py-2">
            <GatewayEmpty tone="error">{String(trace.error)}</GatewayEmpty>
          </div>
        ) : (trace.data?.routes.length ?? 0) === 0 ? (
          <div className="px-3 py-2">
            <GatewayEmpty>{t("gateway:no_routes")}</GatewayEmpty>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-px bg-[color:var(--color-border)] sm:grid-cols-4">
              <div className="bg-[var(--color-background-elevated-primary-opaque)] px-3 py-2">
                <div className="text-ui-xs text-muted-foreground">{t("gateway:requests")}</div>
                <div className="text-ui font-medium">{trace.data?.stats.requests ?? 0}</div>
              </div>
              <div className="bg-[var(--color-background-elevated-primary-opaque)] px-3 py-2">
                <div className="text-ui-xs text-muted-foreground">{t("gateway:active")}</div>
                <div className="text-ui font-medium">{trace.data?.stats.active ?? 0}</div>
              </div>
              <div className="bg-[var(--color-background-elevated-primary-opaque)] px-3 py-2">
                <div className="text-ui-xs text-muted-foreground">{t("gateway:rerouted")}</div>
                <div className="text-ui font-medium">{trace.data?.stats.rerouted ?? 0}</div>
              </div>
              <div className="bg-[var(--color-background-elevated-primary-opaque)] px-3 py-2">
                <div className="text-ui-xs text-muted-foreground">{t("gateway:errors")}</div>
                <div className="text-ui font-medium">{trace.data?.stats.errors ?? 0}</div>
              </div>
            </div>
            {(trace.data?.routes ?? [])
              .toReversed()
              .slice(0, 20)
              .map((route) => (
                <GatewayRow
                  key={route.id}
                  title={`${route.model}${route.group ? ` · ${route.group}` : ""} → ${route.provider ?? "—"}`}
                  description={`${route.agent || t("gateway:unknown_agent")} · ${route.strategy} · ${
                    route.millis === null ? "…" : `${route.millis}ms`
                  }`}
                  trailing={
                    <div className="flex flex-wrap gap-1">
                      {route.tries.map((attempt) => (
                        <GatewayPill
                          key={`${route.id}-${attempt.provider}-${attempt.account ?? ""}-${attempt.model}`}
                          tone={
                            attempt.error === null || attempt.error === undefined ? "ok" : "error"
                          }
                        >
                          {attempt.provider}
                          {attempt.account ? `/${attempt.account}` : ""} {attempt.status ?? "…"}
                        </GatewayPill>
                      ))}
                      <GatewayPill tone={route.error ? "error" : "muted"}>
                        {route.done ? t("gateway:done") : t("gateway:running")}
                      </GatewayPill>
                      <Button
                        size="xs"
                        variant="ghost"
                        aria-expanded={stepsFor === route.id}
                        onClick={() => setStepsFor(stepsFor === route.id ? null : route.id)}
                      >
                        {stepsFor === route.id ? t("gateway:hide") : t("gateway:steps")}
                      </Button>
                    </div>
                  }
                >
                  {stepsFor === route.id ? <RouteSteps route={route} /> : null}
                </GatewayRow>
              ))}
          </>
        )}
      </SettingsSection>

      <SettingsSection title="gateway:history_title">
        <div className="flex items-center justify-end gap-1 px-3 py-2">
          <select
            value={history.data?.day ?? ""}
            onChange={(event) => setHistoryDay(event.currentTarget.value || undefined)}
            className="h-7 rounded-md border border-[color:var(--color-border)] bg-background px-2 text-ui-xs"
          >
            {(history.data?.days ?? []).map((day) => (
              <option key={day} value={day}>
                {day}
              </option>
            ))}
          </select>
          <Button size="xs" variant="ghost" onClick={() => void history.refetch()}>
            {t("gateway:refresh")}
          </Button>
        </div>
        {history.isLoading ? (
          <div className="px-3 py-2 text-ui-sm text-muted-foreground">{t("gateway:loading")}</div>
        ) : history.error ? (
          <div className="px-3 py-2">
            <GatewayEmpty tone="error">{String(history.error)}</GatewayEmpty>
          </div>
        ) : (history.data?.routes.length ?? 0) === 0 ? (
          <div className="px-3 py-2">
            <GatewayEmpty>{t("gateway:no_history")}</GatewayEmpty>
          </div>
        ) : (
          (history.data?.routes ?? []).slice(0, 100).map((row) => (
            <div key={row.id}>
              <GatewayRow
                title={`${row.asked ?? row.model ?? "?"}${row.served ? ` → ${row.served}` : ""}`}
                description={`${row.time} · ${row.client ?? ""} ${row.status ?? ""} · ${
                  row.millis === null || row.millis === undefined ? "…" : `${row.millis}ms`
                }${row.archive ? ` · ${t("gateway:history_archived")}` : ""}`}
                trailing={
                  <div className="flex items-center gap-1">
                    {row.tries?.map((attempt) => (
                      <GatewayPill
                        key={`${row.id}-${attempt.provider ?? ""}-${attempt.status ?? ""}-${attempt.model ?? ""}`}
                        tone={attempt.error ? "error" : "muted"}
                      >
                        {attempt.provider ?? "?"} {attempt.status ?? "…"}
                      </GatewayPill>
                    ))}
                    <Button
                      size="xs"
                      variant="ghost"
                      aria-expanded={openHistoryId === row.id}
                      onClick={() => void openArchive(row)}
                    >
                      {openHistoryId === row.id ? t("gateway:hide") : t("gateway:open")}
                    </Button>
                  </div>
                }
              />
              {openHistoryId === row.id ? (
                <div className="px-3 pb-3">
                  {archiveError !== null ? (
                    <div className="text-ui-sm text-destructive">{archiveError}</div>
                  ) : archive === null ? (
                    <div className="text-ui-sm text-muted-foreground">{t("gateway:loading")}</div>
                  ) : (
                    <ArchiveDetail record={archive} tab={archiveTab} onTab={setArchiveTab} />
                  )}
                </div>
              ) : null}
            </div>
          ))
        )}
      </SettingsSection>
    </div>
  );
}

function GroupEditor({ group, edit }: { group: GatewayGroup; edit: GatewayRoutingProps["edit"] }) {
  const { t } = useTranslation();
  const update = (mutate: (draft: GatewayGroup) => void) => updateGroup(edit, group.id, mutate);
  return (
    <div className="mt-3 space-y-3 rounded-lg border border-[color:var(--color-border)] p-3">
      <div className="grid gap-2 sm:grid-cols-2">
        <GatewayField
          label={t("gateway:label")}
          value={group.label ?? ""}
          onChange={(value) =>
            update((draft) => {
              draft.label = value || undefined;
            })
          }
        />
        <label className="flex flex-col gap-1">
          <span className="text-ui-sm text-muted-foreground">{t("gateway:strategy")}</span>
          <select
            value={group.strategy ?? "order"}
            onChange={(event) => {
              const value = event.currentTarget.value;
              update((draft) => {
                draft.strategy = value;
              });
            }}
            className="h-7 rounded-md border border-[color:var(--color-border)] bg-background px-2 text-ui-sm"
          >
            {STRATEGIES.map((strategy) => (
              <option key={strategy} value={strategy}>
                {strategy}
              </option>
            ))}
          </select>
        </label>
        <GatewayNumberField
          label={t("gateway:context_window")}
          value={group.context}
          onChange={(value) =>
            update((draft) => {
              draft.context = value;
            })
          }
        />
        <GatewayField
          label={t("gateway:pick_first")}
          value={group.pick ?? ""}
          onChange={(value) =>
            update((draft) => {
              draft.pick = value || undefined;
            })
          }
        />
        <GatewayField
          label={t("gateway:classifier")}
          value={typeof group.classifier === "string" ? group.classifier : ""}
          onChange={(value) =>
            update((draft) => {
              draft.classifier = value || undefined;
            })
          }
        />
      </div>
      <GatewayTextarea
        label={t("gateway:members")}
        value={listText(group.members)}
        onChange={(value) =>
          update((draft) => {
            draft.members = stringList(value);
          })
        }
        placeholder="provider/model, group/other"
        rows={3}
        hint={t("gateway:members_hint")}
      />
      {group.members.length === 0 ? (
        <div className="text-ui-xs text-destructive">
          {t("gateway:error_group_members", { id: group.id })}
        </div>
      ) : null}
      <div className="grid gap-2 sm:grid-cols-2">
        <GatewayTextarea
          label={t("gateway:weights")}
          value={weightsText(group.weights)}
          onChange={(value) =>
            update((draft) => {
              draft.weights = parseWeights(value);
            })
          }
          placeholder="provider/model=3, provider/other=1"
          rows={2}
        />
        <GatewayTextarea
          label={t("gateway:match")}
          value={listText(group.match)}
          onChange={(value) =>
            update((draft) => {
              draft.match = stringList(value);
            })
          }
          rows={2}
        />
        <GatewayTextarea
          label={t("gateway:off_members")}
          value={listText(group.off)}
          onChange={(value) =>
            update((draft) => {
              draft.off = stringList(value);
            })
          }
          rows={2}
        />
        <GatewayTextarea
          label={t("gateway:levels")}
          value={listText(group.levels)}
          onChange={(value) =>
            update((draft) => {
              draft.levels = stringList(value);
            })
          }
          rows={2}
        />
      </div>
      <div className="flex flex-wrap gap-3">
        <label className="flex items-center gap-2 text-ui-sm">
          <GatewayToggle
            checked={group.weighted === true}
            label={t("gateway:weighted")}
            onChange={(checked) =>
              update((draft) => {
                draft.weighted = checked;
              })
            }
          />
          {t("gateway:weighted")}
        </label>
        <div className="w-full">
          <GatewayRulesEditor group={group} onChange={update} />
        </div>
      </div>
    </div>
  );
}

/** A live route's decision chain: what it asked, the seats, each try, the end. */
function RouteSteps({ route }: { route: GatewayTraceRoute }) {
  const { t } = useTranslation();
  const served = route.routedModel !== route.model ? ` → ${route.routedModel}` : "";
  return (
    <div className="rounded-md border border-[color:var(--color-border)] px-2.5 py-2">
      <ol className="space-y-1 text-ui-xs">
        <li>
          {t("gateway:step_asked", {
            agent: route.agent || t("gateway:unknown_agent"),
            model: route.model + served,
          })}
        </li>
        {route.group !== null ? (
          <li>{t("gateway:step_group", { group: route.group, strategy: route.strategy })}</li>
        ) : null}
        {route.masked ? <li>{t("gateway:step_masked")}</li> : null}
        {route.seats.length > 0 ? (
          <li>
            {t("gateway:step_seats", {
              seats: route.seats
                .map((seat) =>
                  seat.account === null
                    ? seat.providerLabel
                    : `${seat.providerLabel}/${seat.account}`,
                )
                .join(" → "),
            })}
          </li>
        ) : null}
        {route.tries.map((attempt) => (
          <li
            key={`${route.id}-${attempt.provider}-${attempt.model}-${attempt.status ?? ""}`}
            className={attempt.status !== null && attempt.status >= 400 ? "text-destructive" : ""}
          >
            {t("gateway:step_try", {
              seat: `${attempt.provider}/${attempt.model}`,
              status: attempt.status ?? "…",
              ms: attempt.millis === null ? "…" : Math.round(attempt.millis),
            })}
            {attempt.error ? ` · ${attempt.error}` : ""}
          </li>
        ))}
        <li>
          {route.done
            ? route.error !== null
              ? t("gateway:step_failed", { error: route.error })
              : t("gateway:step_done", { status: route.status ?? "" })
            : t("gateway:step_running")}
        </li>
      </ol>
      {route.prompt !== null ? (
        <div className="mt-1 text-ui-xs text-muted-foreground">
          {t("gateway:step_prompt", {
            tokens: route.prompt.tokens,
            window: route.prompt.window ?? "—",
          })}
        </div>
      ) : null}
    </div>
  );
}

type ArchiveTab = "request" | "response" | "upstream";

function prettyBody(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

function isEventStream(headers: Record<string, string[]>): boolean {
  return Object.entries(headers).some(
    ([name, values]) =>
      name.toLowerCase() === "content-type" &&
      values.some((value) => value.toLowerCase().includes("text/event-stream")),
  );
}

function HeaderTable({ headers }: { headers: Record<string, string[]> }) {
  const entries = Object.entries(headers);
  if (entries.length === 0) return null;
  return (
    <div className="mb-1.5 space-y-0.5 text-ui-xs text-muted-foreground">
      {entries.map(([name, values]) => (
        <div key={name} className="break-all">
          <span className="font-mono text-foreground">{name}</span>: {values.join(", ")}
        </div>
      ))}
    </div>
  );
}

function ArchivePartView({
  part,
  emptyLabel,
}: {
  part: GatewayArchiveRecord["request"];
  emptyLabel: string;
}) {
  const events = isEventStream(part.headers) ? part.body.split(/\r?\n\r?\n/u).filter(Boolean) : [];
  return (
    <div>
      <div className="mb-1 text-ui-xs text-muted-foreground">
        {[part.method, part.path, part.status === undefined ? "" : String(part.status)]
          .filter(Boolean)
          .join(" · ")}
        {part.truncated === true ? ` · ${emptyLabel}` : ""}
      </div>
      <HeaderTable headers={part.headers} />
      {events.length > 0 ? (
        <div className="space-y-1">
          {events.map((event) => (
            // A stream's events have no id but their order.
            // oxlint-disable-next-line react/no-array-index-key
            <pre
              key={event}
              className="max-h-48 overflow-auto rounded bg-foreground/5 p-2 text-ui-xs"
            >
              {event}
            </pre>
          ))}
        </div>
      ) : (
        <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded bg-foreground/5 p-2 text-ui-xs">
          {part.body === "" ? emptyLabel : prettyBody(part.body)}
        </pre>
      )}
    </div>
  );
}

/** One archived call: request, response, and each upstream attempt. */
function ArchiveDetail({
  record,
  tab,
  onTab,
}: {
  record: GatewayArchiveRecord;
  tab: ArchiveTab;
  onTab: (tab: ArchiveTab) => void;
}) {
  const { t } = useTranslation();
  const tabs: ArchiveTab[] = ["request", "response", "upstream"];
  return (
    <div className="rounded-md border border-[color:var(--color-border)] p-2">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-1">
        <div className="flex flex-wrap gap-1">
          {tabs.map((entry) => (
            <button
              key={entry}
              type="button"
              aria-pressed={tab === entry}
              onClick={() => onTab(entry)}
              className={`rounded border px-2 py-0.5 text-ui-xs ${
                tab === entry
                  ? "border-foreground/25 bg-foreground/8 text-foreground"
                  : "border-[color:var(--color-border)] text-muted-foreground"
              }`}
            >
              {t(`gateway:archive_tab_${entry}`)}
            </button>
          ))}
        </div>
        <Button
          size="xs"
          variant="ghost"
          onClick={() =>
            void navigator.clipboard?.writeText(
              tab === "request"
                ? record.request.body
                : tab === "response"
                  ? record.response.body
                  : JSON.stringify(record.upstream ?? [], null, 2),
            )
          }
        >
          {t("gateway:archive_copy")}
        </Button>
      </div>
      {tab === "request" ? (
        <ArchivePartView part={record.request} emptyLabel={t("gateway:archive_empty")} />
      ) : tab === "response" ? (
        <ArchivePartView part={record.response} emptyLabel={t("gateway:archive_empty")} />
      ) : (record.upstream ?? []).length === 0 ? (
        <div className="text-ui-xs text-muted-foreground">{t("gateway:archive_no_upstream")}</div>
      ) : (
        (record.upstream ?? []).map((attempt, index) => (
          // Each upstream attempt has no id but its order.
          // oxlint-disable-next-line react/no-array-index-key
          <details
            key={`${attempt.method}-${attempt.url}-${attempt.status}`}
            className="border-t border-[color:var(--color-border)] py-1.5"
            open={index === 0}
          >
            <summary className="cursor-pointer text-ui-xs">
              {attempt.method} {attempt.url} · {attempt.status} · {Math.round(attempt.millis)}ms
              {attempt.error ? ` · ${attempt.error}` : ""}
            </summary>
            <div className="mt-1 space-y-1">
              <div className="text-ui-xs text-muted-foreground">{t("gateway:archive_request")}</div>
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-foreground/5 p-2 text-ui-xs">
                {JSON.stringify(attempt.request, null, 2)}
              </pre>
              <HeaderTable headers={attempt.response} />
            </div>
          </details>
        ))
      )}
    </div>
  );
}
