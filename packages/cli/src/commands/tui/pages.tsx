import { Box, Text } from "ink";
import React from "react";
import type { ReactElement } from "react";
import type { AgentConnectEntry, AgentConnectSnapshot } from "@neolix/protocol/agent-connect";
import type { ExternalSession, UsageReportEntry } from "@neolix/protocol/messages";
import type { GatewayUsageReportWire } from "@neolix/protocol/gateway";
import type {
  LibraryDiscoverView,
  LibraryRtkStatus,
  LibrarySnapshot,
} from "@neolix/protocol/library";
import type { TuiCheckinAccount, TuiGatewayConfig, TuiGroup, TuiProvider } from "./data.js";
import type { Theme } from "./ui.js";
import {
  PERIOD_NAMES,
  SESSION_RANGES,
  USAGE_PERIODS,
  ago,
  checkinVendorName,
  checkinWord,
  displayWidth,
  filterSessions,
  fmtCost,
  fmtTokens,
  formatDuration,
  groupTokens,
  pad,
  resetIn,
  seriesBars,
  sessionSpent,
  sessionStats,
  shortDate,
  spent,
  truncate,
  windowSlice,
  type SessionFilter,
  type UsagePeriod,
} from "./format.js";

const PAD = "  ";
const BLOCKS = { full: "█", empty: "░" };

/** A check-in's colour: good when credits came, bad when it failed. */
function checkinTone(outcome: string | undefined): "ok" | "bad" | "muted" {
  if (outcome === "failed") return "bad";
  if (outcome === "claimed" || outcome === "done") return "ok";
  return "muted";
}

function style(
  theme: Theme,
  color: keyof Pick<Theme, "accent" | "text" | "muted" | "faint" | "ok" | "bad">,
): string | undefined {
  return theme.color ? theme[color] : undefined;
}

function Empty({ text, theme }: { text: string; theme: Theme }): ReactElement {
  return <Text color={style(theme, "muted")}>{`${PAD}  ${text}`}</Text>;
}

function marker(selected: boolean, theme: Theme): ReactElement {
  return <Text color={style(theme, "accent")}>{selected ? "▸ " : "  "}</Text>;
}

function pathTilde(value: string | null): string {
  if (value === null || value === "") return "";
  const home = process.env.HOME;
  if (home !== undefined && home !== "" && value.startsWith(home)) {
    return `~${value.slice(home.length)}`;
  }
  return value;
}

// ---- agents ----------------------------------------------------------------

export interface AgentField {
  key: string;
  label: string;
  value: string;
  options?: string[];
}

export function agentFields(entry: AgentConnectEntry): AgentField[] {
  const fields: AgentField[] = [
    {
      key: "__model",
      label: "model",
      value: entry.connected ? (entry.model ?? "") : "",
    },
  ];
  for (const setting of entry.settings ?? []) {
    if (setting.key === "model") continue;
    fields.push({
      key: setting.key,
      label: setting.label,
      value: setting.value,
      ...(setting.options === undefined ? {} : { options: setting.options }),
    });
  }
  return fields;
}

export function arrangedAgents(snapshot: AgentConnectSnapshot): AgentConnectEntry[] {
  const hidden = new Set(snapshot.hidden ?? []);
  const rank = new Map((snapshot.order ?? []).map((id, index) => [id, index]));
  const at = (entry: AgentConnectEntry) => rank.get(entry.provider) ?? Number.MAX_SAFE_INTEGER;
  const visible = snapshot.entries
    .filter((entry) => !hidden.has(entry.provider))
    .sort((a, b) => at(a) - at(b));
  const hiddenEntries = snapshot.entries
    .filter((entry) => hidden.has(entry.provider))
    .sort((a, b) => at(a) - at(b));
  return [...visible, ...hiddenEntries];
}

export function AgentsPage({
  snapshot,
  row,
  column,
  width,
  height,
  theme,
}: {
  snapshot: AgentConnectSnapshot;
  row: number;
  column: number;
  width: number;
  height: number;
  theme: Theme;
}): ReactElement {
  const agents = arrangedAgents(snapshot);
  const nameWidth = Math.min(
    24,
    Math.max(8, ...agents.map((entry) => displayWidth(entry.name ?? entry.provider))),
  );
  const hidden = new Set(snapshot.hidden ?? []);
  const visible = Math.max(3, height - 7);
  const [start, end] = windowSlice(agents.length, row, visible);
  return (
    <Box flexDirection="column">
      {agents.slice(start, end).map((entry, offset) => {
        const index = start + offset;
        const selected = index === row;
        const fields = agentFields(entry);
        return (
          <Text key={entry.provider} wrap="truncate-end">
            {marker(selected, theme)}
            <Text
              bold={selected}
              color={
                hidden.has(entry.provider)
                  ? style(theme, "faint")
                  : style(theme, selected ? "accent" : "text")
              }
            >
              {pad(truncate(entry.name ?? entry.provider, nameWidth), nameWidth)}
            </Text>
            <Text>{"  "}</Text>
            {fields.map((field, fieldIndex) => {
              const picked = selected && fieldIndex === column;
              return (
                <Text key={field.key}>
                  {fieldIndex > 0 || field.label !== "model" ? (
                    <Text color={style(theme, "muted")}>{` ${field.label} `}</Text>
                  ) : null}
                  {picked ? (
                    <Text
                      color={style(theme, "accent")}
                      backgroundColor={theme.color ? theme.pill : undefined}
                    >
                      {` ${field.value === "" ? "—" : field.value} `}
                    </Text>
                  ) : (
                    <Text color={style(theme, field.value === "" ? "faint" : "text")}>
                      {` ${field.value === "" ? "—" : field.value} `}
                    </Text>
                  )}
                </Text>
              );
            })}
            {entry.drift !== undefined && entry.drift !== null ? (
              <Text color={style(theme, "muted")}>{` · ${entry.drift}`}</Text>
            ) : null}
            {entry.reason !== null && entry.reason !== undefined ? (
              <Text color={style(theme, "muted")}>{` · ${entry.reason.replaceAll("_", " ")}`}</Text>
            ) : null}
            {selected ? (
              <Text color={style(theme, "faint")}>
                {`  ${truncate(pathTilde(entry.configPath), Math.max(8, width - 40))}`}
              </Text>
            ) : null}
          </Text>
        );
      })}
    </Box>
  );
}

// ---- providers -------------------------------------------------------------

export function exposedModelCount(provider: TuiProvider): number {
  const models = provider.models;
  switch (provider.modelMode ?? "list") {
    case "none":
      return 0;
    case "picked":
      return models.filter((model) => model.picked === true).length;
    case "best": {
      const families = new Set(
        models.map((model) => model.id.replace(/[-_.]?\d+(?:[.-]\d+)*[a-z]*$/i, "") || model.id),
      );
      return families.size;
    }
    default:
      return models.length;
  }
}

function providerHost(provider: TuiProvider): string {
  try {
    return new URL(provider.baseUrl).host;
  } catch {
    return provider.baseUrl;
  }
}

function providerKey(provider: TuiProvider): string {
  if (provider.enabled === false) return "○ switched off";
  const account = provider.accounts?.[0];
  if (account?.label !== undefined && account.label !== "") return `● ${account.label}`;
  const key = provider.apiKey ?? account?.apiKey;
  if (key !== undefined && key !== "") {
    return `● ${key.length <= 8 ? "•".repeat(key.length) : `${key.slice(0, 4)}…${key.slice(-4)}`}`;
  }
  return "● no key needed";
}

export function ProvidersPage({
  config,
  balances,
  row,
  width,
  height,
  theme,
}: {
  config: TuiGatewayConfig;
  balances: Record<string, string>;
  row: number;
  width: number;
  height: number;
  theme: Theme;
}): ReactElement {
  const providers = config.providers;
  if (providers.length === 0) {
    return <Empty text="no providers yet · a adds one" theme={theme} />;
  }
  const nameWidth = Math.min(
    22,
    Math.max(8, ...providers.map((provider) => displayWidth(provider.label ?? provider.id))),
  );
  const idWidth = Math.min(18, Math.max(6, ...providers.map((provider) => provider.id.length)));
  const keyWidth = Math.min(
    28,
    Math.max(8, ...providers.map((provider) => displayWidth(providerKey(provider)))),
  );
  const visible = Math.max(3, height - 7);
  const [start, end] = windowSlice(providers.length, row, visible);
  return (
    <Box flexDirection="column">
      {providers.slice(start, end).map((provider, offset) => {
        const index = start + offset;
        const selected = index === row;
        const notes: string[] = [];
        if (balances[provider.id] !== undefined) notes.push(balances[provider.id]!);
        if (provider.family !== undefined) notes.push(`family ${provider.family}`);
        if (provider.exposeModels === false) notes.push("groups only");
        const fallback: string[] = Array.isArray(provider.fallback)
          ? provider.fallback.filter((value): value is string => typeof value === "string")
          : [];
        if (fallback.length > 0) notes.push(`fallback ${fallback.join(" → ")}`);
        const wireCount = provider.wires === undefined ? 0 : Object.keys(provider.wires).length;
        if (wireCount > 1) notes.push(`${wireCount} addresses`);
        const models = `${exposedModelCount(provider)} models`;
        return (
          <Text key={provider.id} wrap="truncate-end">
            {marker(selected, theme)}
            <Text bold={selected} color={style(theme, selected ? "accent" : "text")}>
              {pad(truncate(provider.label ?? provider.id, nameWidth), nameWidth)}
            </Text>
            <Text>{"  "}</Text>
            <Text color={style(theme, "faint")}>{pad(provider.id, idWidth)}</Text>
            <Text>{"  "}</Text>
            <Text
              color={style(theme, "muted")}
            >{`${pad(truncate(providerHost(provider), 18), 18)}  `}</Text>
            <Text
              color={
                providerKey(provider).startsWith("○") ? style(theme, "bad") : style(theme, "muted")
              }
            >
              {pad(providerKey(provider), keyWidth)}
            </Text>
            <Text>{"  "}</Text>
            <Text color={style(theme, "text")}>{pad(models, 10)}</Text>
            {notes.length > 0 ? (
              <Text
                color={style(theme, "muted")}
              >{`  ${truncate(notes.join(" · "), Math.max(8, width - 70))}`}</Text>
            ) : null}
          </Text>
        );
      })}
    </Box>
  );
}

// ---- routing ---------------------------------------------------------------

export const ROUTING_NAMES: Record<string, string> = {
  order: "in order",
  rotate: "rotate",
  "least-used": "least used",
  smart: "smart",
  pace: "weekly pace",
  free: "free first",
  fast: "speed first",
  cheap: "cheapest first",
  drain: "until used up",
};

export function groupRouting(group: TuiGroup): string {
  if (group.manual === true) return "manual";
  return ROUTING_NAMES[group.strategy ?? ""] ?? group.strategy ?? "smart";
}

const AFFINITY_NAMES: Record<string, string> = {
  auto: "stays auto",
  session: "stays the session",
  turn: "stays a turn",
  off: "never stays",
  strict: "stays strictly",
};

export function affinityName(value: string | undefined): string {
  return value === undefined ? "stays auto" : (AFFINITY_NAMES[value] ?? value);
}

export function GroupsPage({
  config,
  row,
  width,
  height,
  theme,
}: {
  config: TuiGatewayConfig;
  row: number;
  width: number;
  height: number;
  theme: Theme;
}): ReactElement {
  const visibleGroups = config.groups;
  const removed = config.hiddenGroups ?? [];
  if (visibleGroups.length === 0 && removed.length === 0) {
    return <Empty text="no routing groups yet · n makes one" theme={theme} />;
  }
  const nameWidth = Math.min(
    22,
    Math.max(8, ...visibleGroups.map((group) => displayWidth(group.label ?? group.id))),
  );
  const idWidth = Math.min(
    20,
    Math.max(6, ...visibleGroups.map((group) => `group/${group.id}`.length)),
  );
  const rows = visibleGroups.length + removed.length + (removed.length > 0 ? 1 : 0);
  const visible = Math.max(3, height - 7);
  const [start, end] = windowSlice(rows, row, visible);
  const lines: ReactElement[] = [];
  for (let index = start; index < end; index += 1) {
    if (index === visibleGroups.length) {
      lines.push(
        <Text
          key="removed-head"
          color={style(theme, "faint")}
        >{`\n${PAD}  removed · found by Neox, taken away: u brings one back`}</Text>,
      );
    }
    const groupIndex = index < visibleGroups.length ? index : -1;
    if (groupIndex >= 0) {
      const group = visibleGroups[groupIndex]!;
      const selected = index === row;
      const notes = [
        `${group.members.length} model${group.members.length === 1 ? "" : "s"}`,
        groupRouting(group),
      ];
      if (group.affinity !== undefined) notes.push(affinityName(group.affinity));
      if ((group.rules ?? []).length > 0) notes.push(`${(group.rules ?? []).length} rules`);
      if (group.family !== undefined) notes.push(`family ${group.family}`);
      if (group.auto === true) notes.push("found");
      const members = group.members.join(" → ");
      lines.push(
        <Text key={group.id} wrap="truncate-end">
          {marker(selected, theme)}
          <Text bold={selected} color={style(theme, selected ? "accent" : "text")}>
            {pad(truncate(group.label ?? group.id, nameWidth), nameWidth)}
          </Text>
          <Text>{"  "}</Text>
          <Text color={style(theme, "faint")}>{pad(`group/${group.id}`, idWidth)}</Text>
          <Text>{"  "}</Text>
          <Text color={style(theme, "text")}>
            {truncate(notes.join(" · "), Math.max(12, width - 56))}
          </Text>
          <Text color={style(theme, "muted")}>{`  ${truncate(members, 40)}`}</Text>
        </Text>,
      );
    } else {
      const offset = index - visibleGroups.length - 1;
      const id = removed[offset];
      if (id === undefined) continue;
      const selected = index === row;
      lines.push(
        <Text key={`removed-${id}`} wrap="truncate-end">
          {marker(selected, theme)}
          <Text color={style(theme, "faint")}>{pad(id, nameWidth)}</Text>
          <Text color={style(theme, "faint")}>{`  group/${id}`}</Text>
        </Text>,
      );
    }
  }
  return <Box flexDirection="column">{lines}</Box>;
}

// ---- usage -----------------------------------------------------------------

function meter(usedPercent: number, left: boolean, theme: Theme): ReactElement {
  const used = Math.max(0, Math.min(100, Math.round(usedPercent)));
  const share = left ? 100 - used : used;
  let on = Math.round((share * 8) / 100);
  if (share > 0) on = Math.max(1, on);
  const color = used >= 90 ? "bad" : "accent";
  return (
    <Text>
      <Text color={style(theme, color)}>{BLOCKS.full.repeat(on)}</Text>
      <Text color={style(theme, "faint")}>{BLOCKS.empty.repeat(8 - on)}</Text>
    </Text>
  );
}

function reportTitle(report: UsageReportEntry): string {
  const account = report.account.label;
  return account === undefined || account === ""
    ? report.sourceLabel
    : `${report.sourceLabel} · ${account}`;
}

function reportLines(
  report: UsageReportEntry,
  left: boolean,
  now: Date,
  theme: Theme,
): ReactElement[] {
  const title = reportTitle(report);
  const out: ReactElement[] = [];
  if (report.report.status === "error") {
    out.push(
      <Text key={`${report.id}-error`}>
        <Text color={style(theme, "text")}>{title}</Text>
        <Text color={style(theme, "bad")}>{`  ${truncate(report.report.error, 80)}`}</Text>
      </Text>,
    );
    return out;
  }
  if (report.report.status === "unavailable") {
    out.push(
      <Text key={`${report.id}-unavailable`}>
        <Text color={style(theme, "text")}>{title}</Text>
        <Text color={style(theme, "muted")}>{`  unavailable`}</Text>
      </Text>,
    );
    return out;
  }
  const windows = report.report.windows;
  const parts: ReactElement[] = [
    <Text key={`${report.id}-name`} color={style(theme, "text")}>
      {title}
    </Text>,
  ];
  if (report.report.planLabel !== undefined) {
    parts.push(
      <Text
        key={`${report.id}-plan`}
        color={style(theme, "muted")}
      >{` · ${report.report.planLabel}`}</Text>,
    );
  }
  for (const window of windows) {
    const percent = left ? window.remainingPct : window.usedPct;
    const label = window.shortLabel ?? window.label;
    parts.push(
      <Text key={`${report.id}-${window.id}`}>
        <Text>{"   "}</Text>
        <Text color={style(theme, "muted")}>{`${label} `}</Text>
        {percent === null || percent === undefined ? (
          <Text color={style(theme, "muted")}>no usage</Text>
        ) : (
          <Text>
            {meter(percent, left, theme)}
            <Text
              color={style(theme, "text")}
            >{` ${Math.round(percent)}% ${left ? "left" : "used"}`}</Text>
            {window.resetsAt === null || window.resetsAt === undefined ? null : (
              <Text color={style(theme, "faint")}>{` ↻ ${resetIn(window.resetsAt, now)}`}</Text>
            )}
          </Text>
        )}
      </Text>,
    );
  }
  for (const balance of report.report.balances ?? []) {
    const value = left ? balance.remaining : balance.used;
    parts.push(
      <Text key={`${report.id}-balance-${balance.id}`}>
        <Text>{"   "}</Text>
        <Text color={style(theme, "muted")}>{`${balance.label} `}</Text>
        <Text color={style(theme, "text")}>
          {value === null || value === undefined ? "—" : `${value} ${balance.unit}`}
        </Text>
      </Text>,
    );
  }
  out.push(<Text key={report.id}>{parts}</Text>);
  return out;
}

function usageAgentName(
  report: GatewayUsageReportWire,
  client: string,
  agents: AgentConnectSnapshot | null,
): string {
  const entry = agents?.entries.find(
    (candidate) => candidate.provider === client || candidate.name === client,
  );
  return entry?.name ?? report.byClient.find((group) => group.id === client)?.name ?? client;
}

export function UsagePage({
  report,
  reports,
  reportsError,
  reportsLoading,
  agents,
  period,
  left,
  width,
  height,
  theme,
  checkin = [],
}: {
  report: GatewayUsageReportWire | null;
  reports: UsageReportEntry[];
  reportsError: string | null;
  reportsLoading: boolean;
  agents: AgentConnectSnapshot | null;
  period: UsagePeriod;
  left: boolean;
  width: number;
  height: number;
  theme: Theme;
  checkin?: TuiCheckinAccount[];
}): ReactElement {
  const now = new Date();
  const totalTokens = report === null ? 0 : report.totals.inputTokens + report.totals.outputTokens;
  const lines: ReactElement[] = [];
  const tabs = USAGE_PERIODS.map((item) => (
    <Text key={item}>
      {item === period ? (
        <Text
          color={style(theme, "text")}
          backgroundColor={theme.color ? theme.pill : undefined}
        >{` ${PERIOD_NAMES[item]} `}</Text>
      ) : (
        <Text color={style(theme, "muted")}>{` ${PERIOD_NAMES[item]} `}</Text>
      )}
      <Text> </Text>
    </Text>
  ));
  lines.push(
    <Text key="tabs" wrap="truncate-end">
      {tabs}
    </Text>,
  );
  lines.push(<Text key="gap1"> </Text>);
  if (checkin.length > 0) {
    lines.push(
      <Text key="checkin-head" color={style(theme, "faint")}>
        {`${PAD}  check-ins · c asks now`}
      </Text>,
    );
    for (const account of checkin.slice(0, 4)) {
      const word = checkinWord(account.outcome, account.credit, account.streak, account.msg);
      const tone = checkinTone(account.outcome);
      lines.push(
        <Text key={`checkin-${account.key}`}>
          <Text color={style(theme, "muted")}>
            {`${PAD}  ${truncate(account.user, 24)} · ${checkinVendorName(account.by)}`}
          </Text>
          <Text color={style(theme, tone)}>{`  ${word}`}</Text>
          <Text color={style(theme, "faint")}>
            {`${account.again ? " ?" : ""}${account.on ? "" : " · off"}`}
          </Text>
        </Text>,
      );
    }
    if (checkin.length > 4) {
      lines.push(
        <Text key="checkin-more" color={style(theme, "faint")}>
          {`${PAD}  +${checkin.length - 4} more`}
        </Text>,
      );
    }
    lines.push(<Text key="gap-checkin"> </Text>);
  }
  if (reportsError !== null) {
    lines.push(
      <Text
        key="reports-error"
        color={style(theme, "bad")}
      >{`${PAD}  accounts: ${truncate(reportsError, Math.max(30, width - 12))}`}</Text>,
    );
  } else if (reportsLoading && reports.length === 0) {
    lines.push(
      <Text key="accounts-loading" color={style(theme, "muted")}>
        {`${PAD}  accounts · asking the vendors what is left…`}
      </Text>,
    );
  } else if (reports.length > 0) {
    lines.push(
      <Text key="accounts-head" color={style(theme, "faint")}>
        {`${PAD}  accounts · % is how much is ${left ? "left" : "used"}`}
      </Text>,
    );
    for (const entry of reports) {
      for (const line of reportLines(entry, left, now, theme)) {
        lines.push(
          <Text key={`line-${entry.id}-${String(lines.length)}`}>
            {`${PAD}  `}
            {line}
          </Text>,
        );
      }
    }
    lines.push(<Text key="gap2"> </Text>);
  }
  if (report === null || report.totals.calls === 0) {
    lines.push(
      <Text key="no-calls" color={style(theme, "muted")}>
        {`${PAD}  no calls in this time · route an agent through Neox and its usage shows up here`}
      </Text>,
    );
    return <Box flexDirection="column">{lines}</Box>;
  }
  lines.push(
    <Text key="totals">
      <Text bold color={style(theme, "text")}>{`${fmtTokens(totalTokens)} tokens`}</Text>
      <Text color={style(theme, "muted")}>{` · ${report.totals.calls} calls · `}</Text>
      <Text color={style(theme, "ok")}>{fmtCost(report.totals.costUsd)}</Text>
      {report.totals.unpricedCalls > 0 ? (
        <Text color={style(theme, "muted")}>{` (${report.totals.unpricedCalls} unpriced)`}</Text>
      ) : null}
      {report.totals.failed > 0 ? (
        <Text color={style(theme, "bad")}>{` · ${report.totals.failed} errors`}</Text>
      ) : null}
    </Text>,
  );
  lines.push(
    <Text key="tokens" color={style(theme, "muted")}>
      {`${PAD}  in ${fmtTokens(report.totals.inputTokens)}  out ${fmtTokens(report.totals.outputTokens)}  cache read ${fmtTokens(report.totals.cacheReadTokens)}  cache write ${fmtTokens(report.totals.cacheWriteTokens)}  reasoning ${fmtTokens(report.totals.reasoningTokens)}`}
    </Text>,
  );
  const bars = seriesBars(report.series);
  if (bars !== "") {
    lines.push(<Text key="bars" color={style(theme, "accent")}>{`${PAD}  ${bars}`}</Text>);
  }
  lines.push(<Text key="gap3"> </Text>);
  const room = Math.max(2, Math.floor((height - 14) / 2));
  const table = (
    head: string,
    groups: GatewayUsageReportWire["byModel"],
    name: (group: GatewayUsageReportWire["byModel"][number]) => string,
  ) => {
    if (groups.length === 0) return;
    lines.push(<Text key={`head-${head}`} color={style(theme, "faint")}>{`${PAD}  ${head}`}</Text>);
    const widthOf = Math.min(
      28,
      Math.max(8, ...groups.slice(0, room).map((group) => displayWidth(name(group)))),
    );
    for (const group of groups.slice(0, room)) {
      const share = `${Math.round((100 * groupTokens(group)) / Math.max(1, totalTokens))}%`;
      lines.push(
        <Text key={`${head}-${group.id}`}>
          <Text>{"  "}</Text>
          <Text color={style(theme, "text")}>{pad(truncate(name(group), widthOf), widthOf)}</Text>
          <Text color={style(theme, "muted")}>{`  ${pad(share, 4)}  `}</Text>
          <Text color={style(theme, "text")}>{pad(fmtTokens(groupTokens(group)), 7)}</Text>
          <Text color={style(theme, "muted")}>{`  ${pad(`${group.calls} calls`, 10)}`}</Text>
          <Text color={style(theme, "ok")}>{fmtCost(group.costUsd)}</Text>
        </Text>,
      );
    }
    lines.push(<Text key={`gap-${head}`}> </Text>);
  };
  table("agents", report.byClient, (group) => usageAgentName(report, group.id, agents));
  table("models", report.byModel, (group) => group.id);
  return <Box flexDirection="column">{lines}</Box>;
}

// ---- sessions --------------------------------------------------------------

function sessionBar(
  range: number,
  filter: SessionFilter,
  stats: boolean,
  theme: Theme,
): ReactElement {
  return (
    <Text>
      {SESSION_RANGES.map((item, index) => (
        <Text key={item.name}>
          {index === range ? (
            <Text
              color={style(theme, "text")}
              backgroundColor={theme.color ? theme.pill : undefined}
            >
              {` ${item.name} `}
            </Text>
          ) : (
            <Text color={style(theme, "muted")}>{` ${item.name} `}</Text>
          )}
          <Text> </Text>
        </Text>
      ))}
      <Text>{"   "}</Text>
      <Text color={filter.model === "" ? style(theme, "muted") : style(theme, "accent")}>
        {filter.model === "" ? "all models" : filter.model}
      </Text>
      <Text color={style(theme, "faint")}>{" · "}</Text>
      <Text color={filter.folder === "" ? style(theme, "muted") : style(theme, "accent")}>
        {filter.folder === "" ? "all folders" : pathTilde(filter.folder)}
      </Text>
      <Text>{"   "}</Text>
      <Text color={style(theme, stats ? "faint" : "accent")}>sessions</Text>
      <Text color={style(theme, "faint")}>{" · "}</Text>
      <Text color={style(theme, stats ? "accent" : "faint")}>stats</Text>
    </Text>
  );
}

function sessionCostLabel(session: ExternalSession): string {
  if (session.cost > 0) return fmtCost(session.cost);
  if (sessionSpent(session) > 0) return "no price";
  return "—";
}

function sessionRows(
  sessions: readonly ExternalSession[],
  names: Record<string, string>,
  selected: number,
  width: number,
  height: number,
  now: Date,
  theme: Theme,
): ReactElement[] {
  const lines: ReactElement[] = [];
  const visible = Math.max(3, height - 11);
  const [start, end] = windowSlice(sessions.length, selected, visible - 1);
  if (start > 0) {
    lines.push(
      <Text key="more-up" color={style(theme, "faint")}>{`${PAD}  ↑ ${start} more`}</Text>,
    );
  }
  const whenWidth = Math.max(
    8,
    ...sessions.slice(start, end).map((session) => ago(session.last, now).length),
  );
  const whoWidth = Math.min(
    16,
    Math.max(
      6,
      ...sessions
        .slice(start, end)
        .map((session) => (names[session.agent] ?? session.agent).length),
    ),
  );
  const whereWidth = Math.min(
    24,
    Math.max(6, ...sessions.slice(start, end).map((session) => pathBase(session.cwd).length)),
  );
  for (let index = start; index < end; index += 1) {
    const session = sessions[index]!;
    const chosen = index === selected;
    const cost = sessionCostLabel(session);
    const title =
      session.title.trim() === "" ? "(untitled)" : session.title.replaceAll(/\s+/g, " ");
    lines.push(
      <Text key={`${session.agent}-${session.id}`} wrap="truncate-end">
        {marker(chosen, theme)}
        <Text color={style(theme, "muted")}>{pad(ago(session.last, now), whenWidth)}</Text>
        <Text>{"  "}</Text>
        <Text color={style(theme, chosen ? "accent" : "text")} bold={chosen}>
          {pad(truncate(names[session.agent] ?? session.agent, whoWidth), whoWidth)}
        </Text>
        <Text>{"  "}</Text>
        <Text color={style(theme, "text")}>
          {pad(truncate(pathBase(session.cwd), whereWidth), whereWidth)}
        </Text>
        <Text>{"  "}</Text>
        <Text color={style(theme, "text")}>{pad(fmtTokens(sessionSpent(session)), 7)}</Text>
        <Text>{"  "}</Text>
        <Text color={style(theme, session.cost > 0 ? "ok" : "faint")}>{cost.padEnd(9)}</Text>
        <Text color={style(theme, "muted")}>{truncate(title, Math.max(8, width - 64))}</Text>
      </Text>,
    );
  }
  const rest = sessions.length - end;
  if (rest > 0) {
    lines.push(
      <Text key="more-down" color={style(theme, "faint")}>{`${PAD}  ↓ ${rest} more`}</Text>,
    );
  }
  if (selected < sessions.length && sessions[selected]!.resume !== "") {
    lines.push(
      <Text
        key="resume"
        color={style(theme, "faint")}
      >{`${PAD}  ${truncate(`↵ runs ${sessions[selected]!.resume}`, Math.max(20, width - 4))}`}</Text>,
    );
  }
  return lines;
}

function pathBase(value: string): string {
  if (value === "") return "—";
  const parts = value.split(/[\\/]/).filter((part) => part !== "");
  return parts.at(-1) ?? value;
}

function statsChart(
  days: { date: string; value: number }[],
  width: number,
): { lines: string[]; peak: number } {
  if (days.length < 2) return { lines: [], peak: 0 };
  const label = 10;
  const cols = Math.max(8, width - label);
  let step = 1;
  while (Math.ceil(days.length / step) > cols) step += 1;
  if (step > 1 && step < 7 && Math.ceil(days.length / 7) <= cols) step = 7;
  const buckets: { date: string; value: number }[] = [];
  for (let index = 0; index < days.length; index += step) {
    let value = 0;
    for (const day of days.slice(index, index + step)) value += day.value;
    buckets.push({ date: days[index]!.date, value });
  }
  const peak = Math.max(...buckets.map((bucket) => bucket.value), 0);
  if (peak <= 0) return { lines: [], peak: 0 };
  const height = 6;
  const fill = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
  const gap = buckets.length * 2 <= cols ? " " : "";
  const lines: string[] = [];
  for (let row = 0; row < height; row += 1) {
    const level = height - 1 - row;
    let line = "";
    for (const bucket of buckets) {
      if (line !== "") line += gap;
      let eighths = Math.trunc((bucket.value * height * 8) / peak);
      if (bucket.value > 0) eighths = Math.max(1, eighths);
      line += fill[Math.max(0, Math.min(8, eighths - level * 8))]!;
    }
    lines.push(line);
  }
  const first = shortDate(buckets[0]!.date);
  const last = shortDate(buckets.at(-1)!.date);
  const span = buckets.length + (buckets.length - 1) * gap.length;
  const under =
    span - first.length - last.length > 0
      ? `${first}${" ".repeat(span - first.length - last.length)}${last}`
      : first;
  return { lines: [...lines, under], peak };
}

function statRows(
  sessions: readonly ExternalSession[],
  filter: SessionFilter,
  byCost: boolean,
  width: number,
  height: number,
  now: Date,
  theme: Theme,
): ReactElement[] {
  const stats = sessionStats(sessions, filter, now);
  const lines: ReactElement[] = [];
  const total = spent(stats.tokens);
  if (total === 0 && stats.tokens.cacheRead === 0) {
    lines.push(
      <Text key="none" color={style(theme, "muted")}>
        {`${PAD}  ${filter.model !== "" || filter.folder !== "" ? "no session matches · x clears the filters" : "nothing in this range"}`}
      </Text>,
    );
    return lines;
  }
  const hit =
    stats.tokens.cacheRead > 0 && total + stats.tokens.cacheRead + stats.tokens.cacheWrite > 0
      ? ` (${Math.round((100 * stats.tokens.cacheRead) / (total + stats.tokens.cacheRead + stats.tokens.cacheWrite))}% hit)`
      : "";
  lines.push(
    <Text key="total">
      <Text bold color={style(theme, "text")}>{`${fmtTokens(total)} tokens`}</Text>
      <Text color={style(theme, "muted")}>{" · "}</Text>
      <Text color={style(theme, stats.cost > 0 ? "ok" : "faint")}>
        {stats.cost > 0 ? fmtCost(stats.cost) : "no price"}
      </Text>
      <Text
        color={style(theme, "muted")}
      >{` · cache read ${fmtTokens(stats.tokens.cacheRead)}${hit} · active ${
        stats.activeSeconds === null ? "not kept by model" : formatDuration(stats.activeSeconds)
      }${stats.activeSeconds === null ? "" : ` on ${stats.daysUsed} days`}`}</Text>
    </Text>,
  );
  lines.push(
    <Text key="tokens" color={style(theme, "muted")}>
      {`${PAD}  in ${fmtTokens(stats.tokens.input)}  out ${fmtTokens(stats.tokens.output)}  cache write ${fmtTokens(stats.tokens.cacheWrite)}`}
    </Text>,
  );
  const chart = statsChart(
    stats.days.map((day) => ({
      date: day.date,
      value: byCost ? day.cost : spent(day.tokens),
    })),
    width - 4,
  );
  if (chart.lines.length > 0) {
    lines.push(<Text key="chart-gap"> </Text>);
    chart.lines.forEach((line, index) => {
      lines.push(
        <Text
          key={line}
          color={style(theme, index === chart.lines.length - 1 ? "faint" : "accent")}
        >
          {`${PAD}  ${line}`}
        </Text>,
      );
    });
  }
  const room = Math.max(2, Math.floor((height - 18 - chart.lines.length) / 2));
  const table = (head: string, shares: typeof stats.models, name: (value: string) => string) => {
    if (shares.length === 0) return;
    lines.push(
      <Text key={`shares-${head}`} color={style(theme, "faint")}>{`${PAD}  ${head}`}</Text>,
    );
    const shareWidth = Math.min(
      32,
      Math.max(8, ...shares.slice(0, room).map((share) => displayWidth(name(share.name)))),
    );
    const totalSpent = Math.max(
      1,
      shares.reduce((sum, share) => sum + spent(share.tokens), 0),
    );
    for (const share of shares.slice(0, room)) {
      lines.push(
        <Text key={`${head}-${share.name}`}>
          <Text>{"  "}</Text>
          <Text color={style(theme, "text")}>
            {pad(truncate(name(share.name), shareWidth), shareWidth)}
          </Text>
          <Text
            color={style(theme, "muted")}
          >{`  ${pad(`${Math.round((100 * spent(share.tokens)) / totalSpent)}%`, 4)}  `}</Text>
          <Text color={style(theme, "text")}>{pad(fmtTokens(spent(share.tokens)), 7)}</Text>
          <Text
            color={style(theme, share.cost > 0 ? "ok" : "faint")}
          >{`  ${share.cost > 0 ? fmtCost(share.cost) : "no price"}`}</Text>
        </Text>,
      );
    }
    lines.push(<Text key={`shares-gap-${head}`}> </Text>);
  };
  if (filter.model === "") table("models", stats.models, (value) => value);
  if (filter.folder === "")
    table("folders", stats.folders, (value) => (value === "" ? "(no folder)" : pathTilde(value)));
  return lines;
}

export function SessionsPage({
  sessions,
  statsSessions,
  names,
  range,
  filter,
  stats,
  byCost,
  selected,
  width,
  height,
  now,
  theme,
}: {
  sessions: readonly ExternalSession[];
  /** The same sessions with per-day activity, when the stats view has it. */
  statsSessions?: readonly ExternalSession[];
  names: Record<string, string>;
  range: number;
  filter: SessionFilter;
  stats: boolean;
  byCost: boolean;
  selected: number;
  width: number;
  height: number;
  now: Date;
  theme: Theme;
}): ReactElement {
  const shown = filterSessions(sessions, filter, now);
  return (
    <Box flexDirection="column">
      <Text>
        {`${PAD}  `}
        {sessionBar(range, filter, stats, theme)}
      </Text>
      <Text> </Text>
      {stats
        ? statRows(statsSessions ?? sessions, filter, byCost, width, height, now, theme)
        : sessionRows(shown, names, selected, width, height, now, theme)}
    </Box>
  );
}

// ---- library ---------------------------------------------------------------

export interface LibraryRow {
  kind: string;
  name: string;
  about: string;
  on: string[];
  bad: number;
  /** A server the agent's app puts there itself: it can't be brought in. */
  own?: boolean;
}

/** The rows for what agents have that the library doesn't, as myna lists them. */
const NO_DISCOVERY: LibraryDiscoverView = { servers: [], skills: [] };

export function foundLibraryRows(
  discover: LibraryDiscoverView,
  nameOf: (id: string) => string = (id) => id,
): LibraryRow[] {
  return [
    ...discover.servers.map((server) => ({
      kind: "found-mcp",
      name: server.name,
      about: "",
      on: server.agents.map(nameOf),
      bad: 0,
      ...(server.own === true ? { own: true } : {}),
    })),
    ...discover.skills.map((skill) => ({
      kind: "found-skill",
      name: skill.name,
      about: skill.description,
      on: skill.agents.map(nameOf),
      bad: 0,
    })),
  ];
}

/** The `importLibraryDiscovered` selection a found row names. */
export function importSelectionOf(row: LibraryRow): { servers: string[]; skills: string[] } | null {
  if (row.kind === "found-mcp") return { servers: [row.name], skills: [] };
  if (row.kind === "found-skill") return { servers: [], skills: [row.name] };
  return null;
}

function linesAbout(lines: number): string {
  if (lines === 0) return "none yet";
  return `${lines} line${lines === 1 ? "" : "s"}`;
}

export function libraryRows(
  library: LibrarySnapshot,
  rtk: LibraryRtkStatus,
  discover?: LibraryDiscoverView | null,
): LibraryRow[] {
  const names = new Map(library.agents.map((agent) => [agent.id, agent.name]));
  const nameOf = (id: string) => names.get(id) ?? id;
  const rows: LibraryRow[] = [];
  const instructionAgents = library.instructions.agents
    .filter((agent) => agent.on)
    .map((agent) => nameOf(agent.agent));
  const lines =
    library.instructions.shared.trimEnd() === ""
      ? 0
      : library.instructions.shared.trimEnd().split("\n").length;
  rows.push({
    kind: "instructions",
    name: "shared instructions",
    about: linesAbout(lines),
    on: instructionAgents,
    bad: library.instructions.agents.filter((agent) => agent.edited).length,
  });
  for (const server of library.mcp) {
    const what =
      server.url !== undefined && server.url !== ""
        ? server.url
        : [server.command ?? "", ...(server.args ?? [])].join(" ").trim();
    rows.push({
      kind: "mcp",
      name: server.name,
      about: server.local === true ? `not synced · ${what}` : what,
      on: server.agents.map(nameOf),
      bad: 0,
    });
  }
  for (const skill of library.skills) {
    let about = skill.description;
    let bad = 0;
    if (skill.gone === true) {
      about = `removed from ${skill.source?.repo ?? "its source"} · d takes it out`;
      bad = 1;
    } else if (skill.offHere === true) {
      about = "off on this computer";
    }
    rows.push({ kind: "skill", name: skill.name, about, on: skill.agents.map(nameOf), bad });
  }
  rows.push(...foundLibraryRows(discover ?? NO_DISCOVERY, nameOf));
  for (const hook of library.hooks) {
    rows.push({
      kind: "hook",
      name: hook.name,
      about: `${hook.event}${hook.matcher === undefined ? "" : ` ${hook.matcher}`}`,
      on: hook.agents.map(nameOf),
      bad: 0,
    });
  }
  for (const subagent of library.subagents) {
    rows.push({
      kind: "subagent",
      name: subagent.name,
      about: subagent.description,
      on: subagent.agents.map(nameOf),
      bad: 0,
    });
  }
  rows.push({
    kind: "rtk",
    name: "RTK",
    about: rtk.installed ? (rtk.version ?? "installed") : `not installed · ${rtk.url}`,
    on: rtk.agents.filter((agent) => agent.on).map((agent) => nameOf(agent.id)),
    bad: 0,
  });
  return rows;
}

const LIBRARY_HEADS: Record<string, string> = {
  instructions: "instructions · what every agent reads before a conversation",
  mcp: "mcp servers · a adds one",
  skill: "skills · a adds some, u fetches one again",
  "found-mcp": "mcp servers in your agents, not in the library",
  "found-skill": "skills in your agents, not in the library",
  hook: "hooks · written into the agents ticked",
  subagent: "subagents · written into the agents ticked",
  rtk: "rtk · its hook in each agent, by RTK's own installer",
};

export function LibraryPage({
  library,
  rtk,
  discover,
  row,
  width,
  height,
  theme,
}: {
  library: LibrarySnapshot;
  rtk: LibraryRtkStatus;
  discover?: LibraryDiscoverView | null;
  row: number;
  width: number;
  height: number;
  theme: Theme;
}): ReactElement {
  const rows = libraryRows(library, rtk, discover);
  const nameWidth = Math.min(32, Math.max(10, ...rows.map((item) => displayWidth(item.name))));
  const visible = Math.max(4, height - 6);
  const [start, end] = windowSlice(rows.length, row, visible);
  const lines: ReactElement[] = [];
  let last = "";
  let drawn = 0;
  for (let index = start; index < end && drawn < visible; index += 1) {
    const item = rows[index]!;
    if (item.kind !== last) {
      if (last !== "" || start > 0) {
        lines.push(<Text key={`gap-${item.kind}`}> </Text>);
        drawn += 1;
      }
      lines.push(
        <Text
          key={`head-${item.kind}`}
          color={style(theme, "faint")}
        >{`${PAD}  ${LIBRARY_HEADS[item.kind] ?? item.kind}`}</Text>,
      );
      drawn += 1;
      last = item.kind;
    }
    const chosen = index === row;
    let agents = item.kind.startsWith("found-") ? "" : "no agent";
    if (item.on.length > 0) agents = truncate(item.on.join(", "), 36);
    const agentsText =
      item.own === true
        ? `${agents === "" ? "" : `${agents} · `}put there by the app itself`
        : agents;
    lines.push(
      <Text key={`${item.kind}-${item.name}`} wrap="truncate-end">
        {marker(chosen, theme)}
        <Text bold={chosen} color={style(theme, chosen ? "accent" : "text")}>
          {pad(truncate(item.name, nameWidth), nameWidth)}
        </Text>
        <Text>{"  "}</Text>
        <Text color={style(theme, item.on.length === 0 ? "faint" : "muted")}>{agentsText}</Text>
        {item.bad > 0 ? <Text color={style(theme, "bad")}>{`  ! ${item.bad}`}</Text> : null}
        {item.about === "" ? null : (
          <Text
            color={style(theme, "faint")}
          >{`  ${truncate(item.about, Math.max(8, width - 70))}`}</Text>
        )}
      </Text>,
    );
    drawn += 1;
  }
  lines.push(
    <Text
      key="dir"
      color={style(theme, "faint")}
    >{`\n${PAD}  kept in ${pathTilde(library.dir)}`}</Text>,
  );
  return <Box flexDirection="column">{lines}</Box>;
}
