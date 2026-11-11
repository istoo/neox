import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Box, Text, useApp, useInput, useStdout, type Key } from "ink";
import React, { useEffect, useRef, useState } from "react";
import type { DaemonClient } from "@neolix/client/internal/daemon-client";
import type { ExternalSession } from "@neolix/protocol/messages";
import type { GatewayGroupRuleWire } from "@neolix/protocol/gateway";
import type {
  LibraryMcpServer,
  LibrarySkillSource,
  LibrarySnapshot,
} from "@neolix/protocol/library";
import { GATEWAY_PROVIDER_PRESETS } from "@neolix/protocol/gateway-presets";
import {
  loadAgents,
  loadBalances,
  loadCheckins,
  loadGroups,
  loadLibrary,
  loadProviderAgents,
  loadProviders,
  loadSessions,
  loadUsageReports,
  loadUsageTotals,
  probeTarget,
  saveGatewayConfig,
  errorText,
  type AgentsData,
  type GroupsData,
  type LibraryData,
  type ProvidersData,
  type SessionsData,
  type TuiGatewayConfig,
  type TuiGroup,
  type TuiProvider,
  type TuiWire,
  type UsageData,
} from "./data.js";
import {
  SESSION_RANGES,
  USAGE_PERIODS,
  checkinWord,
  filterSessions,
  fmtTokens,
  matchOptions,
  pageForKey,
  pickerChoice,
  truncate,
  type SessionFilter,
  type UsagePeriod,
} from "./format.js";
import {
  AgentsPage,
  GroupsPage,
  LibraryPage,
  ProvidersPage,
  SessionsPage,
  UsagePage,
  affinityName,
  agentFields,
  arrangedAgents,
  groupRouting,
  importSelectionOf,
  libraryRows,
  type LibraryRow,
} from "./pages.js";
import {
  Ask,
  Hints,
  Picker,
  Status,
  headerLines,
  makeTheme,
  newPicker,
  type AskState,
  type Hint,
  type PickerState,
} from "./ui.js";
import { ruleLine, withParsedRule } from "./rules.js";
import { groupMemberOptions as buildGroupMemberOptions, movedGroupEntry } from "./groups.js";

const PAD = "  ";

/** The APIs a provider of the user's own is added as, as myna offers them. */
interface CustomApi {
  id: string;
  name: string;
  protocol: TuiProvider["protocol"];
  example: string;
}

const CUSTOM_APIS: readonly CustomApi[] = [
  {
    id: "custom-openai",
    name: "OpenAI compatible (Chat Completions)",
    protocol: "openai",
    example: "https://api.example.com/v1",
  },
  {
    id: "custom-responses",
    name: "OpenAI Responses",
    protocol: "openai-responses",
    example: "https://api.example.com/v1",
  },
  {
    id: "custom-anthropic",
    name: "Anthropic compatible (Messages)",
    protocol: "anthropic",
    example: "https://api.example.com",
  },
  {
    id: "custom-gemini",
    name: "Gemini compatible",
    protocol: "gemini",
    example: "https://api.example.com/v1beta",
  },
];

type ProviderPreset = (typeof GATEWAY_PROVIDER_PRESETS)[number];

function parseBaseUrl(text: string): URL | null {
  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/** Reads a typed skill source the way myna's ProbeSkills does. */
function skillSourceOf(text: string): LibrarySkillSource | null {
  const value = text.trim();
  if (value === "") return null;
  if (
    value === "~" ||
    value.startsWith("~/") ||
    value.startsWith("/") ||
    /^[A-Za-z]:[\\/]/u.test(value)
  ) {
    return { kind: "folder", dir: value };
  }
  const github =
    /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s#?]+?)(?:\.git)?(?:\/tree\/([^/\s]+)(?:\/(\S+?))?)?\/?$/u.exec(
      value,
    );
  if (github !== null) {
    return {
      kind: "github",
      repo: `${github[1]}/${github[2]}`,
      ...(github[3] === undefined ? {} : { ref: github[3] }),
      ...(github[4] === undefined ? {} : { path: github[4] }),
    };
  }
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value)) {
    return { kind: "github", repo: value };
  }
  if (/^(?:git@|ssh:\/\/|git:\/\/|https?:\/\/)/u.test(value)) {
    return { kind: "git", repo: value };
  }
  return null;
}

/** A library server as myna types it: name, then URL or command. */
function mcpServerLine(server: LibraryMcpServer): string {
  const target =
    server.url !== undefined && server.url !== "" ? server.url : (server.command ?? "");
  const args = server.url !== undefined && server.url !== "" ? [] : (server.args ?? []);
  return [server.name, target, ...args].join(" ");
}

function mcpServerFromLine(line: string, old?: LibraryMcpServer): LibraryMcpServer {
  const words = line
    .trim()
    .split(/\s+/u)
    .filter((word) => word !== "");
  if (words.length < 2) throw new Error("a name, then a URL or a command");
  const name = words[0]!;
  const target = words[1]!;
  const args = words.slice(2);
  if (target.startsWith("http://") || target.startsWith("https://")) {
    if (args.length > 0) throw new Error("a server by URL takes nothing after it");
    const server: LibraryMcpServer = {
      ...(old ?? { name, transport: "http", agents: [] }),
      name,
      transport: "http",
      url: target,
      agents: old?.agents ?? [],
    };
    delete server.command;
    delete server.args;
    delete server.env;
    return server;
  }
  const server: LibraryMcpServer = {
    ...(old ?? { name, transport: "stdio", agents: [] }),
    name,
    transport: "stdio",
    command: target,
    agents: old?.agents ?? [],
  };
  if (args.length > 0) server.args = args;
  else delete server.args;
  delete server.url;
  delete server.headers;
  delete server.oauth;
  return server;
}

const AGENT_HINTS: readonly Hint[] = [
  { key: "↑↓", label: "agent" },
  { key: "←→", label: "field" },
  { key: "↵", label: "change" },
  { key: "s", label: "save profile" },
  { key: "p", label: "profiles" },
  { key: "1–6", label: "pages" },
  { key: "q", label: "quit" },
];
const PROVIDER_HINTS: readonly Hint[] = [
  { key: "↑↓", label: "provider" },
  { key: "↵", label: "models" },
  { key: "e", label: "key" },
  { key: "w", label: "address" },
  { key: "W", label: "per-API addresses" },
  { key: "a", label: "add" },
  { key: "f", label: "family" },
  { key: "u", label: "listed / groups only" },
  { key: "o", label: "on/off" },
  { key: "m", label: "fetch models" },
  { key: "t", label: "test" },
  { key: "b", label: "balances" },
  { key: "d", label: "remove" },
  { key: "1–6", label: "pages" },
];
const GROUP_HINTS: readonly Hint[] = [
  { key: "↑↓", label: "group" },
  { key: "↵", label: "open" },
  { key: "n", label: "new" },
  { key: "o", label: "routing" },
  { key: "d", label: "remove" },
  { key: "u", label: "bring back" },
  { key: "1–6", label: "pages" },
  { key: "q", label: "quit" },
];
const USAGE_HINTS: readonly Hint[] = [
  { key: "←→", label: "period" },
  { key: "t w m A", label: "today · 7 days · 30 days · all" },
  { key: "u", label: "used / left" },
  { key: "c", label: "daily check-in" },
  { key: "r", label: "reload" },
  { key: "1–6", label: "pages" },
  { key: "q", label: "quit" },
];
const SESSIONS_STATS_HINTS: readonly Hint[] = [
  { key: "←→", label: "range" },
  { key: "M", label: "model" },
  { key: "f", label: "folder" },
  { key: "x", label: "clear" },
  { key: "c", label: "tokens / cost" },
  { key: "s", label: "sessions" },
  { key: "r", label: "reload" },
  { key: "1–6", label: "pages" },
  { key: "q", label: "quit" },
];
const SESSIONS_HINTS: readonly Hint[] = [
  { key: "↑↓", label: "session" },
  { key: "↵", label: "resume" },
  { key: "←→", label: "range" },
  { key: "M", label: "model" },
  { key: "f", label: "folder" },
  { key: "x", label: "clear" },
  { key: "s", label: "stats" },
  { key: "r", label: "reload" },
  { key: "1–6", label: "pages" },
  { key: "q", label: "quit" },
];
const LIBRARY_HINTS: readonly Hint[] = [
  { key: "↑↓", label: "item" },
  { key: "↵", label: "agents" },
  { key: "a", label: "add" },
  { key: "e", label: "edit" },
  { key: "u", label: "update skill" },
  { key: "i", label: "bring in" },
  { key: "d", label: "remove" },
  { key: "s", label: "sync" },
  { key: "r", label: "reload" },
  { key: "1–6", label: "pages" },
  { key: "q", label: "quit" },
];
const PICKER_PROFILE_HINTS: readonly Hint[] = [
  { key: "↑↓", label: "move" },
  { key: "↵", label: "apply" },
  { key: "ctrl+e", label: "rename" },
  { key: "ctrl+d", label: "delete" },
  { key: "esc", label: "back" },
];
const PICKER_MODEL_HINTS: readonly Hint[] = [
  { key: "↑↓", label: "move" },
  { key: "↵", label: "on / off" },
  { key: "ctrl+r", label: "fetch models again" },
  { key: "esc", label: "back" },
];
const PICKER_HINTS: readonly Hint[] = [
  { key: "↑↓", label: "move" },
  { key: "↵", label: "select" },
  { key: "esc", label: "back" },
];
const ASK_HINTS: readonly Hint[] = [
  { key: "↵", label: "save" },
  { key: "esc", label: "cancel" },
];
const GROUP_DETAIL_HINTS: readonly Hint[] = [
  { key: "↑↓", label: "model / rule" },
  { key: "J/K", label: "move" },
  { key: "a", label: "add model" },
  { key: "n", label: "new rule" },
  { key: "↵", label: "edit rule" },
  { key: "c", label: "classifier" },
  { key: "d", label: "take out" },
  { key: "o", label: "routing" },
  { key: "s", label: "stays" },
  { key: "esc", label: "back" },
];
const RULE_HINT = `use=<model>, and any of: tokens=200k · images · effort=on|low|medium|high|xhigh|max · agents=codex,claude
intent="a quick question" (the group's classifier tells it) · compact · time=09:00-18:00 · days=mon-fri · tz=Asia/Shanghai
folders=~/work/acme,~/oss · except-folders=~/old · at=<n> · use-effort=low|medium|high|xhigh|max · pause=<model> time=… days=…`;

/** A provider's model in a picker: on in list modes, picked flags in picked mode. */
function modelNote(mode: string | undefined, picked: boolean | undefined): string {
  if (mode !== "picked") return "● on";
  return picked === true ? "● on" : "○ off";
}

/** The models a provider serves under its current mode. */
function servedModelIds(provider: TuiProvider): string[] {
  if (provider.modelMode === "picked") {
    return provider.models.filter((model) => model.picked === true).map((model) => model.id);
  }
  if (provider.modelMode === "none") return [];
  return provider.models.map((model) => model.id);
}

function pickedModels(
  models: TuiProvider["models"],
  ids: readonly string[],
): TuiProvider["models"] {
  return models.map((candidate) => ({ ...candidate, picked: ids.includes(candidate.id) }));
}

function withoutMember(group: TuiGroup, member: string): TuiGroup {
  return { ...group, members: group.members.filter((value) => value !== member), auto: undefined };
}

function withoutRule(group: TuiGroup, index: number): TuiGroup {
  return {
    ...group,
    rules: (group.rules ?? []).filter((_, at) => at !== index),
    auto: undefined,
  };
}

function withAddedModels(provider: TuiProvider, added: readonly string[]): TuiProvider {
  return { ...provider, models: [...provider.models, ...added.map((id) => ({ id }))] };
}

/** A rule's conditions in a few words, as the group page lists them. */
function ruleConditions(rule: GatewayGroupRuleWire): string {
  const parts: string[] = [];
  if (rule.tokens !== undefined) parts.push(`tokens≥${fmtTokens(rule.tokens)}`);
  if (rule.images === true) parts.push("images");
  if (rule.effort !== undefined) parts.push(`effort=${rule.effort}`);
  if ((rule.agents ?? []).length > 0) parts.push(`agents=${(rule.agents ?? []).join(",")}`);
  if (rule.intent !== undefined) parts.push(`intent="${rule.intent}"`);
  if (rule.compact === true) parts.push("compact");
  return parts.join(" · ");
}

/** The agents that hold one library row, as ids, for its toggle picker. */
function libraryHolders(row: LibraryRow, data: LibraryData): string[] {
  switch (row.kind) {
    case "instructions":
      return data.library.instructions.agents
        .filter((agent) => agent.on)
        .map((agent) => agent.agent);
    case "rtk":
      return data.rtk.agents.filter((agent) => agent.on).map((agent) => agent.id);
    case "mcp":
      return data.library.mcp.find((server) => server.name === row.name)?.agents ?? [];
    case "skill":
      return data.library.skills.find((skill) => skill.name === row.name)?.agents ?? [];
    default:
      return [];
  }
}

type PickerAction =
  | "back"
  | "down"
  | "up"
  | "refresh"
  | "rename"
  | "delete"
  | "enter"
  | "backspace"
  | "type"
  | "none";

function pickerNavAction(input: string, key: Key): PickerAction | null {
  if (key.escape) return "back";
  if (key.downArrow || (key.ctrl && input === "n")) return "down";
  if (key.upArrow || (key.ctrl && input === "p")) return "up";
  return null;
}

function pickerControlAction(input: string, key: Key, picker: PickerState): PickerAction | null {
  if (key.ctrl && input === "r" && picker.kind === "models") return "refresh";
  if (key.ctrl && input === "e") return "rename";
  if (key.ctrl && input === "d") return "delete";
  if (key.return) return "enter";
  return null;
}

function pickerAction(input: string, key: Key, picker: PickerState): PickerAction {
  const navigation = pickerNavAction(input, key);
  if (navigation !== null) return navigation;
  const control = pickerControlAction(input, key, picker);
  if (control !== null) return control;
  if (key.backspace || key.delete) return "backspace";
  if (key.ctrl || key.meta || input === "" || input.startsWith("\u001B")) return "none";
  return "type";
}

/** Enter in a picker: toggles a model or gives the picked value to the page. */
function commitPicker(mode: PickerMode, picker: PickerState, match: readonly number[]): void {
  const value = pickerChoice(picker.items, match, picker.cursor, picker.custom, picker.query);
  if (value === null) return;
  if (mode.toggle !== undefined) {
    mode.toggle(value);
    return;
  }
  if (mode.onPick !== undefined) mode.onPick(value);
}

type LoadState<T> =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; data: T }
  | { status: "error"; error: string };

interface PickerMode {
  kind: "picker";
  picker: PickerState;
  onPick?: (value: string) => void;
  onDelete?: (value: string) => void;
  onRename?: (value: string) => void;
  toggle?: (value: string) => void;
}

interface AskMode {
  kind: "ask";
  ask: AskState;
  back?: Mode;
}

interface GroupMode {
  kind: "group";
  gid: string;
  cursor: number;
}

type Mode = { kind: "list" } | PickerMode | AskMode | GroupMode;

interface Cursors {
  agentRow: number;
  agentColumn: number;
  providerRow: number;
  groupRow: number;
  libraryRow: number;
  sessionRow: number;
}

interface PageHints {
  hints: readonly Hint[];
  lines: number;
}

const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;

/** Green/red flash and a busy line, shared by every page's actions. */
function useActions(): {
  flash: { text: string; ok: boolean } | null;
  setFlash: (value: { text: string; ok: boolean } | null) => void;
  busy: boolean;
  run: (work: () => Promise<string | null | void>, ok?: boolean) => Promise<void>;
} {
  const [flash, setFlash] = useState<{ text: string; ok: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (work: () => Promise<string | null | void>, ok = true) => {
    setBusy(true);
    setFlash(null);
    try {
      const text = await work();
      if (text !== null && text !== undefined) {
        setFlash({ text, ok });
      }
    } catch (error) {
      setFlash({ text: errorText(error), ok: false });
    } finally {
      setBusy(false);
    }
  };
  return { flash, setFlash, busy, run };
}

function pageHints(page: number, sessionsStats: boolean, groupMode: boolean): PageHints {
  if (groupMode) return { lines: 2, hints: GROUP_DETAIL_HINTS };
  switch (page) {
    case 0:
      return { lines: 1, hints: AGENT_HINTS };
    case 1:
      return { lines: 1, hints: PROVIDER_HINTS };
    case 2:
      return { lines: 1, hints: GROUP_HINTS };
    case 3:
      return { lines: 1, hints: USAGE_HINTS };
    case 4:
      return { lines: 1, hints: sessionsStats ? SESSIONS_STATS_HINTS : SESSIONS_HINTS };
    default:
      return { lines: 1, hints: LIBRARY_HINTS };
  }
}

function pickerHints(mode: PickerMode): readonly Hint[] {
  if (mode.picker.kind === "profiles") return PICKER_PROFILE_HINTS;
  if (mode.picker.kind === "models") return PICKER_MODEL_HINTS;
  return PICKER_HINTS;
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function cycle<T>(values: readonly T[], current: T): T {
  const index = values.indexOf(current);
  return values[(Math.max(0, index) + 1) % values.length]!;
}

export interface TuiAppProps {
  client: DaemonClient;
  target: string;
  interactive: boolean;
  exitAfterLoad: boolean;
  noColor?: boolean;
}

export function TuiApp({
  client,
  target,
  interactive,
  exitAfterLoad,
  noColor = false,
}: TuiAppProps): React.ReactElement {
  const theme = makeTheme(
    interactive && !noColor && process.env.NO_COLOR === undefined && process.env.TERM !== "dumb",
  );
  const { exit, suspendTerminal } = useApp();
  const { stdout } = useStdout();
  const [size, setSize] = useState({
    columns: stdout.columns ?? DEFAULT_COLUMNS,
    rows: stdout.rows ?? DEFAULT_ROWS,
  });
  const [page, setPage] = useState(0);
  const [mode, setMode] = useState<Mode>({ kind: "list" });
  const [cursor, setCursor] = useState<Cursors>({
    agentRow: 0,
    agentColumn: 0,
    providerRow: 0,
    groupRow: 0,
    libraryRow: 0,
    sessionRow: 0,
  });
  const [period, setPeriod] = useState<UsagePeriod>("7d");
  const [quotaLeft, setQuotaLeft] = useState(false);
  const [sessionRange, setSessionRange] = useState(1);
  const [sessionStats, setSessionStats] = useState(false);
  const [sessionCost, setSessionCost] = useState(false);
  const [sessionFilter, setSessionFilter] = useState<SessionFilter>({
    days: 7,
    model: "",
    folder: "",
  });
  const [confirm, setConfirm] = useState("");
  const [tick, setTick] = useState(0);
  const refreshReports = useRef(false);
  const { flash, setFlash, busy, run } = useActions();

  const [agents, setAgents] = useState<LoadState<AgentsData>>({ status: "idle" });
  const [providers, setProviders] = useState<LoadState<ProvidersData>>({ status: "idle" });
  const [groups, setGroups] = useState<LoadState<GroupsData>>({ status: "idle" });
  const [usage, setUsage] = useState<LoadState<UsageData>>({ status: "idle" });
  const [sessions, setSessions] = useState<LoadState<SessionsData>>({ status: "idle" });
  const [library, setLibrary] = useState<LoadState<LibraryData>>({ status: "idle" });

  useEffect(() => {
    let connected = client.getConnectionState().status === "connected";
    return client.subscribeConnectionStatus((state) => {
      const now = state.status === "connected";
      if (connected && state.status === "disconnected") {
        const reason =
          state.reason === undefined || state.reason === "" ? "" : ` · ${state.reason}`;
        setFlash({ text: `connection lost${reason} · reconnecting…`, ok: false });
      } else if (!connected && now) {
        setTick((value) => value + 1);
        setFlash({ text: "reconnected", ok: true });
      }
      connected = now;
    });
  }, [client, setFlash]);

  useEffect(() => {
    const onChange = () => {
      setSize({ columns: stdout.columns ?? DEFAULT_COLUMNS, rows: stdout.rows ?? DEFAULT_ROWS });
    };
    stdout.on("resize", onChange);
    return () => {
      stdout.off("resize", onChange);
    };
  }, [stdout]);

  useEffect(() => {
    if (page !== 0) return;
    let alive = true;
    setAgents({ status: "loading" });
    loadAgents(client)
      .then((data) => alive && setAgents({ status: "ready", data }))
      .catch((error: unknown) => alive && setAgents({ status: "error", error: errorText(error) }));
    return () => {
      alive = false;
    };
  }, [client, page, tick]);

  useEffect(() => {
    if (page !== 1) return;
    let alive = true;
    setProviders({ status: "loading" });
    loadProviders(client)
      .then(async (data) => {
        if (!alive) return null;
        setProviders({ status: "ready", data });
        const connectedAgents = await loadProviderAgents(client);
        if (!alive || connectedAgents === null) return null;
        setProviders((previous) =>
          previous.status === "ready"
            ? { status: "ready", data: { ...previous.data, agents: connectedAgents } }
            : previous,
        );
        return null;
      })
      .catch((error: unknown) => {
        return alive && setProviders({ status: "error", error: errorText(error) });
      });
    return () => {
      alive = false;
    };
  }, [client, page, tick]);

  useEffect(() => {
    if (page !== 2) return;
    let alive = true;
    setGroups({ status: "loading" });
    loadGroups(client)
      .then((data) => alive && setGroups({ status: "ready", data }))
      .catch((error: unknown) => alive && setGroups({ status: "error", error: errorText(error) }));
    return () => {
      alive = false;
    };
  }, [client, page, tick]);

  useEffect(() => {
    if (page !== 3) return;
    let alive = true;
    const force = refreshReports.current;
    refreshReports.current = false;
    setUsage({ status: "loading" });
    loadUsageTotals(client, period)
      .then(async (totals) => {
        if (!alive) return null;
        setUsage({
          status: "ready",
          data: {
            ...totals,
            reports: [],
            reportsError: null,
            reportsLoading: true,
            checkin: [],
          },
        });
        const [reports, checkin] = await Promise.all([
          loadUsageReports(client, force),
          loadCheckins(client),
        ]);
        if (!alive) return null;
        setUsage((previous) =>
          previous.status === "ready"
            ? {
                status: "ready",
                data: { ...previous.data, ...reports, checkin, reportsLoading: false },
              }
            : { status: "ready", data: { ...totals, ...reports, checkin, reportsLoading: false } },
        );
        return null;
      })
      .catch((error: unknown) => {
        return alive && setUsage({ status: "error", error: errorText(error) });
      });
    return () => {
      alive = false;
    };
  }, [client, page, period, tick]);

  useEffect(() => {
    if (page !== 4) return;
    let alive = true;
    setSessions({ status: "loading" });
    loadSessions(client, undefined)
      .then((data) => alive && setSessions({ status: "ready", data }))
      .catch(
        (error: unknown) => alive && setSessions({ status: "error", error: errorText(error) }),
      );
    return () => {
      alive = false;
    };
  }, [client, page, tick]);

  useEffect(() => {
    if (page !== 4 || !sessionStats) return;
    let alive = true;
    const days = SESSION_RANGES[sessionRange]?.days ?? 0;
    loadSessions(client, days === 0 ? undefined : days)
      .then((data) => {
        if (!alive) return null;
        setSessions((previous) =>
          previous.status === "ready"
            ? {
                status: "ready",
                data: {
                  ...previous.data,
                  activity: data.sessions,
                  activityDays: data.activityDays,
                },
              }
            : { status: "ready", data },
        );
        return null;
      })
      .catch((error: unknown) => {
        if (alive) setFlash({ text: `stats: ${errorText(error)}`, ok: false });
        return null;
      });
    return () => {
      alive = false;
    };
  }, [client, page, sessionRange, sessionStats, setFlash]);

  useEffect(() => {
    if (page !== 5) return;
    let alive = true;
    setLibrary({ status: "loading" });
    loadLibrary(client)
      .then((data) => alive && setLibrary({ status: "ready", data }))
      .catch((error: unknown) => alive && setLibrary({ status: "error", error: errorText(error) }));
    return () => {
      alive = false;
    };
  }, [client, page, tick]);

  useEffect(() => {
    if (!exitAfterLoad) return;
    let current: LoadState<unknown> = agents;
    switch (page) {
      case 1:
        current = providers;
        break;
      case 2:
        current = groups;
        break;
      case 3:
        current = usage;
        break;
      case 4:
        current = sessions;
        break;
      case 5:
        current = library;
        break;
      default:
        break;
    }
    if (current.status === "loading" || current.status === "idle") return;
    const timer = setTimeout(() => exit(), 30);
    return () => clearTimeout(timer);
  }, [exitAfterLoad, exit, page, agents, providers, groups, usage, sessions, library]);

  const reload = () => {
    if (!client.isConnected) {
      void run(async () => {
        await client.connect();
        setTick((value) => value + 1);
        return "reconnected";
      });
      return;
    }
    setFlash({ text: "reloaded", ok: true });
    setTick((value) => value + 1);
  };

  const goTo = (next: number) => {
    setMode({ kind: "list" });
    setConfirm("");
    setPage(next);
  };

  const setSessionDays = (range: number) => {
    setSessionRange(range);
    setSessionFilter((filter) => ({ ...filter, days: SESSION_RANGES[range]?.days ?? 0 }));
    setCursor((value) => ({ ...value, sessionRow: 0 }));
  };

  const openPicker = (picker: PickerState, handlers: Omit<PickerMode, "kind" | "picker"> = {}) => {
    setMode({ kind: "picker", picker, ...handlers });
  };

  const openAsk = (ask: AskState, back?: Mode) => {
    setMode({ kind: "ask", ask, back });
  };

  const enabledProviders = (config: TuiGatewayConfig): TuiProvider[] => config.providers;

  const findProvider = (): TuiProvider | null => {
    if (providers.status !== "ready") return null;
    return enabledProviders(providers.data.config)[cursor.providerRow] ?? null;
  };

  const saveConfig = async (
    change: (config: TuiGatewayConfig) => TuiGatewayConfig,
  ): Promise<TuiGatewayConfig> => {
    if (providers.status !== "ready") throw new Error("no provider list");
    const next = await saveGatewayConfig(client, change(providers.data.config));
    const normalized: TuiGatewayConfig = {
      ...next,
      providers: next.providers ?? [],
      groups: next.groups ?? [],
    };
    setProviders({ status: "ready", data: { ...providers.data, config: normalized } });
    return normalized;
  };

  const findGroup = (gid: string): TuiGroup | null => {
    if (groups.status !== "ready") return null;
    return groups.data.config.groups.find((group) => group.id === gid) ?? null;
  };

  const saveGroups = async (
    change: (config: TuiGatewayConfig) => TuiGatewayConfig,
  ): Promise<TuiGatewayConfig> => {
    if (groups.status !== "ready") throw new Error("no group list");
    const next = await saveGatewayConfig(client, change(groups.data.config));
    const normalized: TuiGatewayConfig = {
      ...next,
      providers: next.providers ?? [],
      groups: next.groups ?? [],
    };
    setGroups({ status: "ready", data: { config: normalized } });
    return normalized;
  };

  const saveLibrary = (data: LibraryData) => {
    setLibrary({ status: "ready", data });
  };

  const pickerKey = (input: string, key: Key) => {
    if (mode.kind !== "picker") return;
    const picker = mode.picker;
    const match = matchOptions(picker.items, picker.query);
    const count = match.length;
    const action = pickerAction(input, key, picker);
    switch (action) {
      case "back":
        setMode({ kind: "list" });
        return;
      case "down":
      case "up": {
        if (count === 0) return;
        const delta = action === "down" ? 1 : -1;
        openPicker({ ...picker, cursor: (picker.cursor + delta + count) % count }, mode);
        return;
      }
      case "refresh":
        if (mode.toggle !== undefined) mode.toggle("__refresh__");
        return;
      case "rename":
      case "delete": {
        const handler = action === "rename" ? mode.onRename : mode.onDelete;
        if (handler === undefined) return;
        const value = pickerChoice(picker.items, match, picker.cursor, false, picker.query);
        if (value === null) return;
        if (action === "delete") setConfirm("");
        handler(value);
        return;
      }
      case "enter":
        commitPicker(mode, picker, match);
        return;
      case "backspace":
      case "type": {
        const query =
          action === "backspace"
            ? Array.from(picker.query).slice(0, -1).join("")
            : picker.query + input;
        openPicker({ ...picker, query, cursor: 0 }, mode);
        return;
      }
      default:
        return;
    }
  };

  const askKey = (input: string, key: Key, submit: (value: string) => void) => {
    if (mode.kind !== "ask") return;
    const ask = mode.ask;
    const back = mode.back ?? { kind: "list" as const };
    if (key.escape) {
      setMode(back);
      return;
    }
    if (key.return) {
      if (ask.value.trim() === "" && !ask.empty) return;
      setMode(back);
      submit(ask.value.trim());
      return;
    }
    if (key.backspace || key.delete) {
      openAsk({ ...ask, value: Array.from(ask.value).slice(0, -1).join("") });
      return;
    }
    if (!key.ctrl && !key.meta && input !== "" && !input.startsWith("\u001B")) {
      openAsk({ ...ask, value: ask.value + input });
    }
  };

  const openAgentField = () => {
    if (agents.status !== "ready") return;
    const snapshot = agents.data.snapshot;
    const entries = arrangedAgents(snapshot);
    const entry = entries[cursor.agentRow];
    if (entry === undefined) return;
    const fields = agentFields(entry);
    const field = fields[cursor.agentColumn % Math.max(1, fields.length)];
    if (field === undefined) return;
    const current = field.value;
    const items =
      field.key === "__model"
        ? snapshot.models.map((model) => ({
            value: model.id,
            note: model.label ?? model.id,
          }))
        : (field.options ?? []).map((option) => ({ value: option }));
    const picker = newPicker({
      title: [entry.name ?? entry.provider, field.label],
      items,
      custom: true,
      empty:
        field.key === "__model" ? "no models known yet, type one" : "no known values, type one",
      kind: "select",
    });
    picker.query = current;
    const save = (value: string) => {
      void run(async () => {
        const result =
          field.key === "__model"
            ? await client.setAgentConnect({
                provider: entry.provider,
                connected: true,
                model: value,
              })
            : await client.setAgentConnect({
                provider: entry.provider,
                connected: entry.connected,
                field: field.key,
                value,
              });
        if (result.snapshot.error !== null) throw new Error(result.snapshot.error);
        setAgents({ status: "ready", data: { snapshot: result.snapshot } });
        return `${entry.name ?? entry.provider} · ${field.label} → ${value === "" ? "default" : value}`;
      });
    };
    openPicker(picker, {
      onPick: (value) => {
        setMode({ kind: "list" });
        save(value);
      },
    });
  };

  const openProfiles = () => {
    if (agents.status !== "ready") return;
    const snapshot = agents.data.snapshot;
    const items = snapshot.profiles.map((profile) => ({
      value: profile.name,
      note: `${new Date(profile.savedAt).toLocaleDateString()}${profile.inUse === true ? " · in use" : ""}`,
    }));
    openPicker(
      newPicker({
        title: ["profiles"],
        items,
        kind: "profiles",
        empty: "no profiles yet · press s in the list to save one",
      }),
      {
        onPick: (name) => {
          setMode({ kind: "list" });
          void run(async () => {
            const result = await client.applyAgentConnectProfile(name);
            setAgents({ status: "ready", data: { snapshot: result.snapshot } });
            return `profile ${name} applied`;
          });
        },
        onDelete: (name) => {
          setMode({ kind: "list" });
          void run(async () => {
            const result = await client.deleteAgentConnectProfile(name);
            setAgents({ status: "ready", data: { snapshot: result.snapshot } });
            return `profile ${name} deleted`;
          });
        },
        onRename: (name) => {
          openAsk({
            title: ["rename profile"],
            hint: `${name} · the settings it holds stay as they are`,
            value: name,
            secret: false,
            empty: false,
            submit: (to) => {
              setMode({ kind: "list" });
              void run(async () => {
                const result = await client.renameAgentConnectProfile(name, to);
                setAgents({ status: "ready", data: { snapshot: result.snapshot } });
                return `profile ${name} renamed to ${to}`;
              });
            },
          });
        },
      },
    );
  };

  const openProviderModels = () => {
    const provider = findProvider();
    if (provider === null) return;
    const items = provider.models.map((model) => ({
      value: model.id,
      note: modelNote(provider.modelMode, model.picked),
    }));
    openPicker(
      newPicker({
        title: ["providers", provider.label ?? provider.id, "models"],
        items,
        kind: "models",
        empty: "no models known yet · ctrl+r asks the vendor for them",
      }),
      {
        toggle: (modelId) => {
          if (modelId === "__refresh__") {
            void run(async () => {
              const result = await client.getGatewayProviderModels(probeTarget(provider));
              if (result.error !== null) throw new Error(result.error);
              const known = new Set(provider.models.map((item) => item.id));
              const added = result.models.filter((id) => !known.has(id));
              const models = [...provider.models, ...added.map((id) => ({ id }))];
              const next = await saveConfig((config) => ({
                ...config,
                providers: config.providers.map((item) =>
                  item.id === provider.id ? { ...item, models } : item,
                ),
              }));
              const saved = next.providers.find((item) => item.id === provider.id);
              if (saved !== undefined) {
                openPicker(
                  newPicker({
                    title: ["providers", saved.label ?? saved.id, "models"],
                    items: saved.models.map((item) => ({
                      value: item.id,
                      note: modelNote(saved.modelMode, item.picked),
                    })),
                    kind: "models",
                  }),
                  { toggle: mode.kind === "picker" ? mode.toggle : undefined },
                );
              }
              return `${result.models.length} models from its list · ${added.length} new`;
            });
            return;
          }
          void run(async () => {
            const servedIds = servedModelIds(provider);
            const on = servedIds.includes(modelId);
            if (on && servedIds.length <= 1) throw new Error("one model has to stay on");
            const nextIds = on ? servedIds.filter((id) => id !== modelId) : [...servedIds, modelId];
            const next = await saveConfig((config) => ({
              ...config,
              providers: config.providers.map((item) => {
                if (item.id !== provider.id) return item;
                return {
                  ...item,
                  modelMode: "picked",
                  models: pickedModels(item.models, nextIds),
                };
              }),
            }));
            const saved = next.providers.find((item) => item.id === provider.id);
            if (saved !== undefined) {
              openPicker(
                newPicker({
                  title: ["providers", saved.label ?? saved.id, "models"],
                  items: saved.models.map((item) => ({
                    value: item.id,
                    note: modelNote(saved.modelMode, item.picked),
                  })),
                  kind: "models",
                }),
                { toggle: mode.kind === "picker" ? mode.toggle : undefined },
              );
            }
            return `${modelId} ${on ? "off" : "on"}`;
          });
        },
      },
    );
  };

  const providerIdFor = (label: string): string => {
    const base = slugify(label) || "provider";
    const known =
      providers.status === "ready" ? providers.data.config.providers.map((item) => item.id) : [];
    if (!known.includes(base)) return base;
    let index = 2;
    while (known.includes(`${base}-${index}`)) index += 1;
    return `${base}-${index}`;
  };

  const addPresetProvider = (preset: ProviderPreset, key: string) => {
    void run(async () => {
      const protocol =
        (Object.keys(preset.endpoints)[0] as TuiProvider["protocol"] | undefined) ?? "openai";
      const baseUrl = preset.endpoints[protocol] ?? "";
      const provider: TuiProvider = {
        id: preset.id,
        label: preset.name,
        protocol,
        baseUrl,
        accounts: key === "" ? [] : [{ id: "default", apiKey: key }],
        models: (preset.models ?? []).map((modelId) => ({ id: modelId })),
        enabled: true,
      };
      await saveConfig((config) => ({
        ...config,
        providers: [...config.providers, provider],
      }));
      return `added ${preset.name}`;
    });
  };

  const askPresetKey = (preset: ProviderPreset) => {
    openAsk({
      title: ["providers", "add", preset.name],
      hint: "the key is kept in gateway.json",
      value: "",
      secret: true,
      empty: true,
      submit: (key) => addPresetProvider(preset, key),
    });
  };

  const addCustomProvider = (api: CustomApi, baseUrl: string, label: string, key: string) => {
    void run(async () => {
      const provider: TuiProvider = {
        id: providerIdFor(label),
        label,
        protocol: api.protocol,
        baseUrl,
        accounts: key === "" ? [] : [{ id: "default", apiKey: key }],
        models: [],
        enabled: true,
      };
      let note = "";
      try {
        const listed = await client.getGatewayProviderModels(probeTarget(provider));
        if (listed.error !== null) {
          note = ` · its list didn't answer: ${truncate(listed.error, 60)}`;
        } else {
          provider.models = listed.models.map((modelId) => ({ id: modelId }));
        }
      } catch (error) {
        note = ` · its list didn't answer: ${truncate(errorText(error), 60)}`;
      }
      await saveConfig((config) => ({
        ...config,
        providers: [...config.providers, provider],
      }));
      return `added ${label} · ${provider.models.length} models${note}`;
    });
  };

  const askCustomKey = (api: CustomApi, baseUrl: string, label: string) => {
    openAsk({
      title: ["providers", "add", label],
      hint: "the key is kept in gateway.json",
      value: "",
      secret: true,
      empty: true,
      submit: (key) => addCustomProvider(api, baseUrl, label, key),
    });
  };

  const askCustomName = (api: CustomApi, baseUrl: string, hostname: string) => {
    openAsk({
      title: ["providers", "add", "custom", "name"],
      hint: `its name in Neox · enter for ${hostname}`,
      value: "",
      secret: false,
      empty: true,
      submit: (name) => {
        const label = name.trim() === "" ? hostname : name.trim();
        askCustomKey(api, baseUrl, label);
      },
    });
  };

  const askCustomUrl = (api: CustomApi) => {
    openAsk({
      title: ["providers", "add", "custom", "base URL"],
      hint: `${api.name} · the base URL, e.g. ${api.example}`,
      value: "",
      secret: false,
      empty: true,
      submit: (text) => {
        const url = parseBaseUrl(text);
        if (url === null) {
          setFlash({
            text: `the base URL is an http:// or https:// address, e.g. ${api.example}`,
            ok: false,
          });
          return;
        }
        askCustomName(api, text.replace(/\/+$/u, ""), url.hostname);
      },
    });
  };

  const addVertexProvider = (
    preset: ProviderPreset,
    project: string,
    location: string,
    credentials: string,
    impersonate: string,
  ) => {
    void run(async () => {
      const protocol =
        (Object.keys(preset.endpoints)[0] as TuiProvider["protocol"] | undefined) ?? "gemini";
      const provider: TuiProvider = {
        id: preset.id,
        label: preset.name,
        protocol,
        baseUrl: preset.endpoints[protocol] ?? "",
        vertex: {
          project,
          location,
          ...(credentials === "" ? {} : { credentials }),
          ...(impersonate === "" ? {} : { impersonate }),
        },
        models: (preset.models ?? []).map((modelId) => ({ id: modelId })),
        enabled: true,
      };
      await saveConfig((config) => ({
        ...config,
        providers: [...config.providers, provider],
      }));
      return `added ${preset.name}`;
    });
  };

  const askVertexImpersonate = (
    preset: ProviderPreset,
    project: string,
    location: string,
    credentials: string,
  ) => {
    openAsk({
      title: ["providers", "add", preset.name, "impersonate"],
      hint: "a service account email to impersonate · enter for none",
      value: "",
      secret: false,
      empty: true,
      submit: (impersonate) =>
        addVertexProvider(preset, project, location, credentials, impersonate.trim()),
    });
  };

  const askVertexCredentials = (preset: ProviderPreset, project: string, location: string) => {
    openAsk({
      title: ["providers", "add", preset.name, "credentials"],
      hint: "a credentials file's path · enter for gcloud's Application Default Credentials",
      value: "",
      secret: false,
      empty: true,
      submit: (credentials) => askVertexImpersonate(preset, project, location, credentials.trim()),
    });
  };

  const askVertexLocation = (preset: ProviderPreset, project: string) => {
    openAsk({
      title: ["providers", "add", preset.name, "location"],
      hint: "global, or a region such as us-central1 · enter for global",
      value: "",
      secret: false,
      empty: true,
      submit: (location) =>
        askVertexCredentials(preset, project, location.trim() === "" ? "global" : location.trim()),
    });
  };

  const askVertexProject = (preset: ProviderPreset) => {
    openAsk({
      title: ["providers", "add", preset.name, "project"],
      hint: "no key: signed with gcloud's Application Default Credentials (gcloud auth application-default login)",
      value: "",
      secret: false,
      empty: true,
      submit: (text) => {
        const project = text.trim();
        if (project === "") {
          setFlash({
            text: `${preset.name} needs the id of your Google Cloud project`,
            ok: false,
          });
          return;
        }
        askVertexLocation(preset, project);
      },
    });
  };

  const openPresets = () => {
    const items = [
      ...GATEWAY_PROVIDER_PRESETS.map((preset) => ({
        value: preset.id,
        note: `${preset.name} · ${preset.kind}`,
      })),
      ...CUSTOM_APIS.map((api) => ({
        value: api.id,
        note: `${api.name} · custom`,
      })),
    ];
    openPicker(newPicker({ title: ["providers", "add"], items, empty: "no presets" }), {
      onPick: (id) => {
        const custom = CUSTOM_APIS.find((api) => api.id === id);
        if (custom !== undefined) {
          askCustomUrl(custom);
          return;
        }
        const preset = GATEWAY_PROVIDER_PRESETS.find((item) => item.id === id);
        if (preset === undefined) return;
        if (preset.vertex === true) {
          askVertexProject(preset);
          return;
        }
        askPresetKey(preset);
      },
    });
  };

  const askProviderField = (
    title: string,
    hint: string,
    value: string,
    apply: (provider: TuiProvider, text: string) => TuiProvider,
    secret = false,
    allowEmpty = true,
  ) => {
    const provider = findProvider();
    if (provider === null) return;
    openAsk({
      title: ["providers", provider.label ?? provider.id, title],
      hint,
      value,
      secret,
      empty: allowEmpty,
      submit: (text) => {
        void run(async () => {
          await saveConfig((config) => ({
            ...config,
            providers: config.providers.map((item) =>
              item.id === provider.id ? apply(item, text) : item,
            ),
          }));
          return `${provider.label ?? provider.id} ${title} ${text === "" ? "cleared" : text}`;
        });
      },
    });
  };

  const testProvider = (provider: TuiProvider) => {
    const model =
      provider.models.find((item) => item.picked === true)?.id ?? provider.models[0]?.id;
    if (model === undefined) {
      setFlash({ text: `${provider.label ?? provider.id}: nothing to test`, ok: false });
      return;
    }
    void run(async () => {
      const result = await client.testGatewayProviderModel(probeTarget(provider), model);
      return result.ok
        ? `${provider.label ?? provider.id}: ${provider.protocol} ✓ ${result.latencyMs} ms`
        : `${provider.label ?? provider.id}: ${provider.protocol} ✗ ${result.status} ${truncate(result.error ?? "failed", 80)}`;
    }, true);
  };

  const fetchProviderModels = (provider: TuiProvider) => {
    void run(async () => {
      const result = await client.getGatewayProviderModels(probeTarget(provider));
      if (result.error !== null) throw new Error(result.error);
      const known = new Set(provider.models.map((item) => item.id));
      const added = result.models.filter((id) => !known.has(id));
      await saveConfig((config) => ({
        ...config,
        providers: config.providers.map((item) =>
          item.id === provider.id ? withAddedModels(item, added) : item,
        ),
      }));
      return `${provider.label ?? provider.id}: ${result.models.length} models · ${added.length} new`;
    });
  };

  const removeProvider = (provider: TuiProvider) => {
    void run(async () => {
      await saveConfig((config) => ({
        ...config,
        providers: config.providers.filter((item) => item.id !== provider.id),
      }));
      return `removed ${provider.label ?? provider.id}`;
    });
  };

  const readProviderBalances = () => {
    if (providers.status !== "ready") return;
    setFlash({ text: "asking the vendors for balances…", ok: true });
    void run(async () => {
      const balances = await loadBalances(client, providers.data.config);
      setProviders({ status: "ready", data: { ...providers.data, balances } });
      const answered = Object.keys(balances).length;
      return answered === 0
        ? "no provider has a balance URL"
        : `${answered} balance${answered === 1 ? "" : "s"} read`;
    });
  };

  const toggleProviderListed = (provider: TuiProvider) => {
    void run(async () => {
      await saveConfig((config) => ({
        ...config,
        providers: config.providers.map((item) =>
          item.id === provider.id
            ? { ...item, exposeModels: item.exposeModels === false ? undefined : false }
            : item,
        ),
      }));
      return `${provider.label ?? provider.id} ${provider.exposeModels === false ? "listed again" : "serves only through routing groups"}`;
    });
  };

  const toggleProviderEnabled = (provider: TuiProvider) => {
    void run(async () => {
      await saveConfig((config) => ({
        ...config,
        providers: config.providers.map((item) =>
          item.id === provider.id ? { ...item, enabled: item.enabled === false } : item,
        ),
      }));
      return `${provider.label ?? provider.id} ${provider.enabled === false ? "switched on" : "switched off"}`;
    });
  };

  const WIRE_LABELS: Record<TuiWire, string> = {
    anthropic: "Anthropic (Messages)",
    openai: "OpenAI (Chat Completions)",
    "openai-responses": "OpenAI Responses",
    gemini: "Gemini",
  };

  /** One provider can answer on several APIs, each at its own address (myna's wires). */
  const askProviderWire = (provider: TuiProvider, wire: TuiWire) => {
    askProviderField(
      `address · ${WIRE_LABELS[wire]}`,
      "a provider of your own can answer on several APIs; empty clears this one",
      provider.wires?.[wire] ?? "",
      (item, text) => {
        const wires = { ...item.wires };
        if (text.trim() === "") {
          delete wires[wire];
        } else {
          wires[wire] = text.trim();
        }
        const next: TuiProvider = { ...item };
        if (Object.keys(wires).length > 0) {
          next.wires = wires;
        } else {
          delete next.wires;
        }
        return next;
      },
    );
  };

  const openProviderWires = (provider: TuiProvider) => {
    const items = (Object.keys(WIRE_LABELS) as TuiWire[]).map((wire) => ({
      value: wire,
      note: provider.wires?.[wire] ?? "not set",
    }));
    openPicker(
      newPicker({
        title: ["providers", provider.label ?? provider.id, "addresses"],
        items,
        empty: "no APIs to set",
      }),
      { onPick: (value) => askProviderWire(provider, value as TuiWire) },
    );
  };

  const providerAskKey = (input: string, provider: TuiProvider): boolean => {
    switch (input) {
      case "a":
        openPresets();
        return true;
      case "W":
        openProviderWires(provider);
        return true;
      case "e":
        askProviderField(
          "key",
          "the key is kept in gateway.json",
          provider.apiKey ?? "",
          (item, text) => ({ ...item, apiKey: text }),
          true,
        );
        return true;
      case "w":
        askProviderField(
          "address",
          "the base URL requests go to",
          provider.baseUrl,
          (item, text) => ({ ...item, baseUrl: text }),
          false,
          false,
        );
        return true;
      case "f":
        askProviderField(
          "family",
          "agents can be shown only some families",
          provider.family ?? "",
          (item, text) => ({ ...item, family: text === "" ? undefined : text }),
        );
        return true;
      default:
        return false;
    }
  };

  const providerActionKey = (input: string, provider: TuiProvider): boolean => {
    switch (input) {
      case "b":
        readProviderBalances();
        return true;
      case "d": {
        const stamp = `provider/${provider.id}`;
        if (confirm !== stamp) {
          setConfirm(stamp);
          setFlash({ text: `press d again to remove ${provider.label ?? provider.id}`, ok: false });
          return true;
        }
        setConfirm("");
        removeProvider(provider);
        return true;
      }
      case "u":
        toggleProviderListed(provider);
        return true;
      case "o":
        toggleProviderEnabled(provider);
        return true;
      case "m":
        fetchProviderModels(provider);
        return true;
      case "t":
        setFlash({ text: `testing ${provider.label ?? provider.id}…`, ok: true });
        testProvider(provider);
        return true;
      default:
        return false;
    }
  };

  const providerKey = (input: string, key: Key) => {
    const provider = findProvider();
    if (provider === null) return;
    const count = Math.max(1, providerCount());
    const move = (by: number) => {
      setCursor((value) => ({ ...value, providerRow: (value.providerRow + by + count) % count }));
    };
    if (key.downArrow || input === "j") return move(1);
    if (key.upArrow || input === "k") return move(-1);
    if (key.return || input === " ") return openProviderModels();
    if (providerAskKey(input, provider)) return;
    providerActionKey(input, provider);
  };

  const providerCount = (): number =>
    providers.status === "ready" ? providers.data.config.providers.length : 0;

  const groupCount = (): number => {
    if (groups.status !== "ready") return 0;
    return groups.data.config.groups.length + (groups.data.config.hiddenGroups ?? []).length;
  };

  const selectedGroup = (): TuiGroup | null => {
    if (groups.status !== "ready") return null;
    return groups.data.config.groups[cursor.groupRow] ?? null;
  };

  const selectedRemovedGroup = (): string | null => {
    if (groups.status !== "ready") return null;
    const hidden = groups.data.config.hiddenGroups ?? [];
    const index = cursor.groupRow - groups.data.config.groups.length;
    return hidden[index] ?? null;
  };

  const updateGroup = (group: TuiGroup, change: (copy: TuiGroup) => TuiGroup) => {
    void run(async () => {
      await saveGroups((config) => ({
        ...config,
        groups: config.groups.map((item) =>
          item.id === group.id
            ? { ...change({ ...item, auto: undefined }), auto: undefined }
            : item,
        ),
      }));
      return `${group.label ?? group.id} changed`;
    });
  };

  const cycleGroupRouting = (group: TuiGroup) => {
    const values = [
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
    if (group.manual === true) {
      updateGroup(group, (copy) => ({ ...copy, manual: undefined, strategy: "order" }));
      return;
    }
    if (group.strategy === "drain") {
      updateGroup(group, (copy) => ({ ...copy, manual: true }));
      return;
    }
    const next = cycle(values, group.strategy);
    updateGroup(group, (copy) => ({ ...copy, strategy: next, manual: undefined }));
  };

  const cycleGroupAffinity = (group: TuiGroup) => {
    const values = [undefined, "auto", "session", "turn", "off", "strict"] as const;
    const next = cycle(values, group.affinity as (typeof values)[number]);
    updateGroup(group, (copy) => ({ ...copy, affinity: next }));
  };

  const groupMemberOptions = (group: TuiGroup | null, modelsOnly = false) => {
    if (groups.status !== "ready") return [];
    return buildGroupMemberOptions(groups.data.config, group, modelsOnly);
  };

  const addGroupMember = (group: TuiGroup) => {
    openPicker(
      newPicker({
        title: ["routing", group.label ?? group.id, "add a model"],
        items: groupMemberOptions(group),
        empty: "every model Neox has is in it",
      }),
      {
        onPick: (value) => {
          setMode({
            kind: "group",
            gid: group.id,
            cursor: mode.kind === "group" ? mode.cursor : 0,
          });
          void run(async () => {
            await saveGroups((config) => ({
              ...config,
              groups: config.groups.map((item) =>
                item.id === group.id
                  ? { ...item, members: [...item.members, value], auto: undefined }
                  : item,
              ),
            }));
            return `${value} added`;
          });
        },
      },
    );
  };

  const openRule = (group: TuiGroup, index: number) => {
    const existing = index >= 0 ? (group.rules ?? [])[index] : undefined;
    const back: Mode = {
      kind: "group",
      gid: group.id,
      cursor: mode.kind === "group" ? mode.cursor : 0,
    };
    openAsk(
      {
        title: ["routing", group.label ?? group.id, index >= 0 ? `rule ${index + 1}` : "new rule"],
        hint: `${RULE_HINT}\nits models: ${group.members.join(", ")}`,
        value: existing === undefined ? "use=" : ruleLine(existing),
        secret: false,
        empty: true,
        submit: (line) => {
          void run(async () => {
            const parsed = withParsedRule(group, index, line);
            await saveGroups((config) => ({
              ...config,
              groups: config.groups.map((item) =>
                item.id === group.id
                  ? {
                      ...item,
                      rules: parsed.rules,
                      classifier: parsed.classifier,
                      auto: undefined,
                    }
                  : item,
              ),
            }));
            return index >= 0 ? `rule ${index + 1} changed` : "rule added";
          });
        },
      },
      back,
    );
  };

  const createGroup = () => {
    openAsk({
      title: ["routing", "new"],
      hint: "then pick its first model; agents choose it as group/<id>",
      value: "",
      secret: false,
      empty: false,
      submit: (name) => {
        const id = slugify(name);
        if (id === "") {
          setFlash({ text: "a group name needs letters or digits", ok: false });
          return;
        }
        openPicker(
          newPicker({
            title: ["routing", name, "first model"],
            items: groupMemberOptions(null),
            empty: "Neox has no models yet · add a provider first",
          }),
          {
            onPick: (value) => {
              setMode({ kind: "list" });
              void run(async () => {
                await saveGroups((config) => ({
                  ...config,
                  groups: [
                    ...config.groups,
                    { id, label: name, members: [value], strategy: "order" },
                  ],
                }));
                return `made group ${name}`;
              });
            },
          },
        );
      },
    });
  };

  const removeGroup = (group: TuiGroup) => {
    void run(async () => {
      await saveGroups((config) => ({
        ...config,
        groups:
          group.auto === true
            ? config.groups.filter((item) => item.id !== group.id)
            : config.groups.filter((item) => item.id !== group.id),
        hiddenGroups:
          group.auto === true
            ? [...new Set([...(config.hiddenGroups ?? []), group.id])]
            : config.hiddenGroups,
      }));
      return `removed ${group.label ?? group.id}`;
    });
  };

  const groupListKey = (input: string, key: Key) => {
    const count = groupCount();
    if (input === "j" || key.downArrow) {
      if (count > 0) setCursor((value) => ({ ...value, groupRow: (value.groupRow + 1) % count }));
      return;
    }
    if (input === "k" || key.upArrow) {
      if (count > 0) {
        setCursor((value) => ({ ...value, groupRow: (value.groupRow + count - 1) % count }));
      }
      return;
    }
    if (input === "n") {
      createGroup();
      return;
    }
    const removedId = selectedRemovedGroup();
    if (removedId !== null) {
      if (input === "u") {
        void run(async () => {
          await saveGroups((config) => ({
            ...config,
            hiddenGroups: (config.hiddenGroups ?? []).filter((id) => id !== removedId),
          }));
          return `brought ${removedId} back`;
        });
      }
      return;
    }
    const group = selectedGroup();
    if (group === null) return;
    if (key.return || input === " ") {
      setMode({ kind: "group", gid: group.id, cursor: 0 });
      return;
    }
    if (input === "o") {
      cycleGroupRouting(group);
      return;
    }
    if (input === "d") {
      const stamp = `group/${group.id}`;
      if (confirm !== stamp) {
        setConfirm(stamp);
        setFlash({ text: `press d again to remove ${group.label ?? group.id}`, ok: false });
        return;
      }
      setConfirm("");
      removeGroup(group);
    }
  };

  const moveGroupCursor = (group: TuiGroup, delta: number) => {
    if (mode.kind !== "group") return;
    const total = group.members.length + (group.rules ?? []).length;
    if (total > 0) {
      setMode({ ...mode, cursor: (mode.cursor + delta + total) % total });
    }
  };

  const editGroupRule = (group: TuiGroup) => {
    if (mode.kind !== "group" || mode.cursor < group.members.length) return;
    const index = mode.cursor - group.members.length;
    if (index < (group.rules ?? []).length) openRule(group, index);
  };

  /**
   * myna's J/K (routing.go updateGroup): swap the entry under the cursor with
   * its neighbour. Models and rules are one list on screen but never mix, so
   * a member stays among the members and a rule stays among the rules.
   */
  const moveGroupEntry = (group: TuiGroup, by: number) => {
    if (mode.kind !== "group") return;
    const from = mode.cursor;
    const moved = movedGroupEntry(group, from, by);
    if (moved === null) return;
    setMode({ ...mode, cursor: moved.cursor });
    void run(async () => {
      await saveGroups((config) => ({
        ...config,
        groups: config.groups.map((item) => {
          if (item.id !== group.id) return item;
          const fresh = movedGroupEntry(item, from, by);
          if (fresh === null) return item;
          return {
            ...item,
            ...(fresh.members === undefined ? {} : { members: fresh.members }),
            ...(fresh.rules === undefined ? {} : { rules: fresh.rules }),
            auto: undefined,
          };
        }),
      }));
      return moved.rules === undefined
        ? `${group.members[from]} moved`
        : `rule ${from - group.members.length + 1} moved to ${moved.cursor - group.members.length + 1}`;
    });
  };

  /** J/K reorder and c (classifier), the group keys that are not navigation. */
  const groupExtraKey = (group: TuiGroup, input: string, key: Key): boolean => {
    if (input === "J" || (key.shift && key.downArrow)) {
      moveGroupEntry(group, 1);
      return true;
    }
    if (input === "K" || (key.shift && key.upArrow)) {
      moveGroupEntry(group, -1);
      return true;
    }
    if (input === "c") {
      openClassifier(group);
      return true;
    }
    return false;
  };

  /** myna's c: the model that tells a rule's intent apart (routing.go openClassifier). */
  const openClassifier = (group: TuiGroup) => {
    if (!(group.rules ?? []).some((rule) => (rule.intent ?? "") !== "")) {
      setFlash({
        text: `${group.label ?? group.id} has no rule with an intent to classify for · n adds one`,
        ok: false,
      });
      return;
    }
    const items = groupMemberOptions(group, true);
    for (const item of items) {
      if (item.value === group.classifier) {
        item.note = `● now · ${item.note ?? item.value}`;
      }
    }
    openPicker(
      newPicker({
        title: ["routing", group.label ?? group.id, "classifier"],
        items,
        empty: "Neox has no models yet · add a provider first",
      }),
      {
        onPick: (value) => {
          setMode({
            kind: "group",
            gid: group.id,
            cursor: mode.kind === "group" ? mode.cursor : 0,
          });
          void run(async () => {
            await saveGroups((config) => ({
              ...config,
              groups: config.groups.map((item) =>
                item.id === group.id ? { ...item, classifier: value, auto: undefined } : item,
              ),
            }));
            return `${group.label ?? group.id} classifies with ${value}`;
          });
        },
      },
    );
  };

  const groupDetailKey = (input: string, key: Key) => {
    if (mode.kind !== "group") return;
    if (input !== "d") setConfirm("");
    const group = findGroup(mode.gid);
    if (group === null) {
      setMode({ kind: "list" });
      return;
    }
    if (key.escape || input === "q") {
      setMode({ kind: "list" });
      return;
    }
    if (groupExtraKey(group, input, key)) return;
    if (input === "j" || key.downArrow) {
      moveGroupCursor(group, 1);
      return;
    }
    if (input === "k" || key.upArrow) {
      moveGroupCursor(group, -1);
      return;
    }
    if (input === "a") {
      addGroupMember(group);
      return;
    }
    if (input === "o") {
      cycleGroupRouting(group);
      return;
    }
    if (input === "s") {
      cycleGroupAffinity(group);
      return;
    }
    if (input === "n") {
      openRule(group, -1);
      return;
    }
    if (key.return || input === "e") {
      editGroupRule(group);
      return;
    }
    if (input === "d") {
      deleteGroupEntry(group);
    }
  };

  const deleteGroupEntry = (group: TuiGroup) => {
    if (mode.kind !== "group") return;
    if (mode.cursor < group.members.length) {
      const member = group.members[mode.cursor]!;
      if (group.members.length <= 1) {
        setFlash({ text: "a group needs a model in it", ok: false });
        return;
      }
      const stamp = `member/${member}`;
      if (confirm !== stamp) {
        setConfirm(stamp);
        setFlash({ text: `press d again to take ${member} out`, ok: false });
        return;
      }
      setConfirm("");
      void run(async () => {
        await saveGroups((config) => ({
          ...config,
          groups: config.groups.map((item) =>
            item.id === group.id ? withoutMember(item, member) : item,
          ),
        }));
        return `${member} taken out`;
      });
      return;
    }
    const index = mode.cursor - group.members.length;
    const stamp = `rule/${index}`;
    if (confirm !== stamp) {
      setConfirm(stamp);
      setFlash({ text: `press d again to remove rule ${index + 1}`, ok: false });
      return;
    }
    setConfirm("");
    void run(async () => {
      await saveGroups((config) => ({
        ...config,
        groups: config.groups.map((item) =>
          item.id === group.id ? withoutRule(item, index) : item,
        ),
      }));
      return `rule ${index + 1} removed`;
    });
  };

  const groupKey = (input: string, key: Key) => {
    if (mode.kind === "group") groupDetailKey(input, key);
    else groupListKey(input, key);
  };

  const sessionModelOptions = (): { value: string; note?: string }[] => {
    if (sessions.status !== "ready") return [{ value: "all models" }];
    const seen = new Map<string, number>();
    for (const session of sessions.data.sessions) {
      for (const model of session.models) {
        seen.set(
          model.model,
          (seen.get(model.model) ?? 0) + model.tokens.input + model.tokens.output,
        );
      }
    }
    return [
      { value: "all models" },
      ...[...seen.entries()]
        .sort((left, right) => right[1] - left[1])
        .map(([name, tokens]) => ({ value: name, note: `${fmtTokens(tokens)} tokens` })),
    ];
  };

  const sessionFolderOptions = (): { value: string; note?: string }[] => {
    if (sessions.status !== "ready") return [{ value: "all folders" }];
    const seen = new Map<string, number>();
    for (const session of sessions.data.sessions) {
      if (session.cwd === "") continue;
      seen.set(
        session.cwd,
        (seen.get(session.cwd) ?? 0) + session.tokens.input + session.tokens.output,
      );
    }
    return [
      { value: "all folders" },
      ...[...seen.entries()]
        .sort((left, right) => right[1] - left[1])
        .map(([folder, tokens]) => ({ value: folder, note: `${fmtTokens(tokens)} tokens` })),
    ];
  };

  const openSessionModelPicker = () => {
    openPicker(
      newPicker({
        title: ["sessions", "model"],
        items: sessionModelOptions(),
        empty: "no model in this range",
      }),
      {
        onPick: (value) => {
          setMode({ kind: "list" });
          setSessionFilter((filter) => ({ ...filter, model: value === "all models" ? "" : value }));
          setCursor((cursorValue) => ({ ...cursorValue, sessionRow: 0 }));
        },
      },
    );
  };

  const openSessionFolderPicker = () => {
    openPicker(
      newPicker({
        title: ["sessions", "folder"],
        items: sessionFolderOptions(),
        empty: "no folder in this range",
      }),
      {
        onPick: (value) => {
          setMode({ kind: "list" });
          setSessionFilter((filter) => ({
            ...filter,
            folder: value === "all folders" ? "" : value,
          }));
          setCursor((cursorValue) => ({ ...cursorValue, sessionRow: 0 }));
        },
      },
    );
  };

  const resumeSession = (session: ExternalSession) => {
    if (session.cwd !== "" && !existsSync(session.cwd)) {
      setFlash({ text: `its folder ${truncate(session.cwd, 60)} isn't there any more`, ok: false });
      return;
    }
    void run(async () => {
      await suspendTerminal(async () => {
        const result = spawnSync(session.resume, {
          shell: true,
          stdio: "inherit",
          cwd: session.cwd === "" ? undefined : session.cwd,
        });
        if (result.error !== undefined && result.error !== null) throw result.error;
        if (result.status !== null && result.status !== 0) {
          throw new Error(`resume: exited with ${result.status}`);
        }
      });
      return "back from the session";
    });
  };

  /** The session-page keys that pick a range, a filter or the view; true when used. */
  const sessionRangeKey = (input: string, key: Key): boolean => {
    const rangeValues = SESSION_RANGES.length;
    if (input === "s" || key.tab) {
      setSessionStats((value) => !value);
      return true;
    }
    if (input === "l" || key.rightArrow) {
      setSessionDays((sessionRange + 1) % rangeValues);
      return true;
    }
    if (input === "h" || key.leftArrow) {
      setSessionDays((sessionRange + rangeValues - 1) % rangeValues);
      return true;
    }
    if (input === "c") {
      setSessionCost((value) => !value);
      return true;
    }
    if (input === "x") {
      setSessionFilter({ days: SESSION_RANGES[sessionRange]?.days ?? 0, model: "", folder: "" });
      setCursor((value) => ({ ...value, sessionRow: 0 }));
      return true;
    }
    if (input === "M") {
      openSessionModelPicker();
      return true;
    }
    if (input === "f") {
      openSessionFolderPicker();
      return true;
    }
    const named = { t: 0, w: 1, m: 2, A: 4 }[input];
    if (named !== undefined) {
      setSessionDays(named);
      return true;
    }
    return false;
  };

  const sessionKey = (input: string, key: Key) => {
    if (sessionRangeKey(input, key)) return;
    if (sessionStats || sessions.status !== "ready") return;
    const shown = filterSessions(sessions.data.sessions, sessionFilter, new Date());
    if (input === "j" || key.downArrow) {
      setCursor((value) => ({
        ...value,
        sessionRow: Math.min(value.sessionRow + 1, Math.max(0, shown.length - 1)),
      }));
      return;
    }
    if (input === "k" || key.upArrow) {
      setCursor((value) => ({ ...value, sessionRow: Math.max(0, value.sessionRow - 1) }));
      return;
    }
    if (!key.return) return;
    const session = shown[cursor.sessionRow];
    if (session === undefined || session.resume === "") {
      setFlash({ text: "this session can't be resumed from here", ok: false });
      return;
    }
    resumeSession(session);
  };

  const toggleLibraryAgents = (kind: string, name: string, on: string[]) => {
    if (library.status !== "ready") return;
    const data = library.data;
    const allAgents = data.library.agents;
    const withPlace = (agent: (typeof allAgents)[number]) => {
      switch (kind) {
        case "mcp":
          return agent.mcpPath !== null;
        case "skill":
          return agent.skillsDir !== null;
        default:
          return true;
      }
    };
    const items =
      kind === "rtk"
        ? data.rtk.agents.map((agent) => ({
            value: agent.id,
            note: `${agent.on ? "● on" : "○ off"}  ${agent.name}`,
          }))
        : allAgents.filter(withPlace).map((agent) => ({
            value: agent.id,
            note: `${on.includes(agent.id) ? "● on" : "○ off"}  ${agent.name}`,
          }));
    openPicker(
      newPicker({
        title: ["library", name, "agents"],
        items,
        kind: "toggle",
        empty: "no agent here has a place for it",
      }),
      {
        toggle: (agent) => {
          void run(async () => {
            if (kind === "rtk") {
              const enabled = !data.rtk.agents.find((item) => item.id === agent)?.on;
              const { rtk } = await client.setLibraryRtk(agent, enabled);
              saveLibrary({ ...data, rtk });
              openPicker(
                newPicker({
                  title: ["library", name, "agents"],
                  items: rtk.agents.map((item) => ({
                    value: item.id,
                    note: `${item.on ? "● on" : "○ off"}  ${item.name}`,
                  })),
                  kind: "toggle",
                }),
                { toggle: mode.kind === "picker" ? mode.toggle : undefined },
              );
              return `RTK ${enabled ? "on" : "off"} for ${agent}`;
            }
            const next = on.includes(agent)
              ? on.filter((value) => value !== agent)
              : [...on, agent];
            let snapshot: LibrarySnapshot;
            if (kind === "instructions") {
              ({ library: snapshot } = await client.saveLibraryInstructions({ agents: next }));
            } else if (kind === "mcp") {
              ({ library: snapshot } = await client.setLibraryMcpAgents(name, next));
            } else {
              ({ library: snapshot } = await client.setLibrarySkillAgents(name, next));
            }
            saveLibrary({ ...data, library: snapshot });
            const row = libraryRows(snapshot, data.rtk, data.discover).find(
              (item) => item.name === name,
            );
            const holders = row?.on ?? [];
            openPicker(
              newPicker({
                title: ["library", name, "agents"],
                items: allAgents.filter(withPlace).map((agentItem) => ({
                  value: agentItem.id,
                  note: `${holders.includes(agentItem.name) ? "● on" : "○ off"}  ${agentItem.name}`,
                })),
                kind: "toggle",
              }),
              { toggle: mode.kind === "picker" ? mode.toggle : undefined },
            );
            return `${name} ${next.includes(agent) ? "given to" : "taken from"} ${agent}`;
          });
        },
      },
    );
  };

  const removeLibraryRow = (row: LibraryRow, data: LibraryData) => {
    if (row.kind === "found-mcp" || row.kind === "found-skill") {
      if (row.own === true) {
        setFlash({
          text: `${row.name} is put there by the agent's app itself, each time it starts: it stays as it is`,
          ok: false,
        });
        return;
      }
      const stamp = `library/${row.kind}/${row.name}`;
      if (confirm !== stamp) {
        setConfirm(stamp);
        setFlash({
          text: `press d again to take ${row.name} out of every agent that has it, kept with the backups`,
          ok: false,
        });
        return;
      }
      setConfirm("");
      const selection = importSelectionOf(row);
      if (selection === null) return;
      void run(async () => {
        const result = await client.removeLibraryDiscovered(selection);
        const discovered = await client.discoverLibrary().catch(() => null);
        saveLibrary({
          ...data,
          library: result.library,
          discover: discovered?.discover ?? data.discover,
        });
        return `removed ${row.name}`;
      });
      return;
    }
    if (row.kind !== "mcp" && row.kind !== "skill") return;
    const stamp = `library/${row.kind}/${row.name}`;
    if (confirm !== stamp) {
      setConfirm(stamp);
      setFlash({
        text: `press d again to take ${row.name} out of the library and every agent`,
        ok: false,
      });
      return;
    }
    setConfirm("");
    void run(async () => {
      const result =
        row.kind === "mcp"
          ? await client.removeLibraryMcpServer(row.name)
          : await client.removeLibrarySkill(row.name);
      saveLibrary({ ...data, library: result.library });
      return `removed ${row.name}`;
    });
  };

  const saveMcpLine = (data: LibraryData, line: string, old?: LibraryMcpServer) => {
    void run(async () => {
      const server = mcpServerFromLine(line, old);
      const result = await client.saveLibraryMcpServer(
        server,
        old === undefined ? {} : { oldName: old.name },
      );
      saveLibrary({ ...data, library: result.library });
      return old === undefined
        ? `added ${server.name} · ↵ on it gives it to agents`
        : `saved ${server.name}`;
    });
  };

  const askMcpLine = (data: LibraryData, old?: LibraryMcpServer) => {
    openAsk({
      title: old === undefined ? ["library", "add", "mcp server"] : ["library", old.name, "edit"],
      hint:
        old === undefined
          ? "e.g. context7 https://mcp.context7.com/mcp · fs npx -y @modelcontextprotocol/server-filesystem ~/code\nthen ↵ on it gives it to agents"
          : "its env, headers and agents stay as they are",
      value: old === undefined ? "" : mcpServerLine(old),
      secret: false,
      empty: true,
      submit: (line) => saveMcpLine(data, line, old),
    });
  };

  const installSkill = (data: LibraryData, source: LibrarySkillSource, name: string) => {
    void run(async () => {
      const result = await client.installLibrarySkills(source, [name]);
      saveLibrary({ ...data, library: result.library });
      return `added ${name} · ↵ on it gives it to agents`;
    });
  };

  const askSkillSource = (data: LibraryData) => {
    openAsk({
      title: ["library", "add", "skills"],
      hint: "owner/repo, a GitHub or GitLab link, a git address (git@host:group/repo.git), or a folder's full path\nneolix looks there for skills, then you pick one",
      value: "",
      secret: false,
      empty: true,
      submit: (text) => {
        void run(async () => {
          const source = skillSourceOf(text);
          if (source === null) {
            throw new Error(
              "that's neither a git repository's link (GitHub, GitLab or another host) nor a folder's full path",
            );
          }
          const { candidates } = await client.findLibrarySkills(source);
          if (candidates.length === 0) {
            setFlash({
              text: "no skills there: a skill is a folder with a SKILL.md",
              ok: false,
            });
            return;
          }
          openPicker(
            newPicker({
              title: ["library", "add", "skills", source.repo ?? source.dir ?? "source"],
              items: candidates.map((candidate) => ({
                value: candidate.name,
                note: candidate.description,
              })),
              empty: "no skills there: a skill is a folder with a SKILL.md",
            }),
            { onPick: (name) => installSkill(data, source, name) },
          );
        });
      },
    });
  };

  const editInstructions = (data: LibraryData) => {
    void run(async () => {
      const before = data.library.instructions.shared;
      const dir = mkdtempSync(join(tmpdir(), "neolix-instructions-"));
      try {
        const file = join(dir, "instructions.md");
        writeFileSync(file, before);
        await suspendTerminal(async () => {
          const editor =
            process.env.VISUAL ||
            process.env.EDITOR ||
            (process.platform === "win32" ? "notepad" : "vi");
          const words = editor
            .trim()
            .split(/\s+/u)
            .filter((word) => word !== "");
          const command = words[0];
          if (command === undefined) throw new Error("no editor: set VISUAL or EDITOR");
          const result = spawnSync(command, [...words.slice(1), file], { stdio: "inherit" });
          if (result.error !== undefined && result.error !== null) throw result.error;
          if (result.status !== null && result.status !== 0) {
            throw new Error(`editor: exited with ${result.status}`);
          }
        });
        const after = readFileSync(file, "utf8");
        if (after === before) return "the instructions are as they were";
        const { library: snapshot } = await client.saveLibraryInstructions({ shared: after });
        saveLibrary({ ...data, library: snapshot });
        return "instructions saved";
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  };

  const openLibraryAdd = () => {
    openPicker(
      newPicker({
        title: ["library", "add"],
        items: [
          { value: "mcp server", note: "a URL, or a command it runs" },
          {
            value: "skills",
            note: "from GitHub, GitLab or any git repository, or a folder on this machine",
          },
        ],
        empty: "nothing to add",
      }),
      {
        onPick: (value) => {
          if (library.status !== "ready") return;
          if (value === "skills") {
            askSkillSource(library.data);
            return;
          }
          askMcpLine(library.data);
        },
      },
    );
  };

  const importFound = (row: LibraryRow, data: LibraryData) => {
    if (row.own === true) {
      setFlash({
        text: `${row.name} is put there by the agent's app itself, each time it starts: it stays as it is`,
        ok: false,
      });
      return;
    }
    const selection = importSelectionOf(row);
    if (selection === null) return;
    void run(async () => {
      const result = await client.importLibraryDiscovered(selection);
      const discovered = await client.discoverLibrary().catch(() => null);
      saveLibrary({
        ...data,
        library: result.library,
        discover: discovered?.discover ?? data.discover,
      });
      return `brought ${row.name} into the library`;
    });
  };

  const editLibraryRow = (row: LibraryRow | undefined, data: LibraryData) => {
    if (row === undefined) return;
    if (row.kind === "instructions") {
      editInstructions(data);
      return;
    }
    if (row.kind === "mcp") {
      const server = data.library.mcp.find((item) => item.name === row.name);
      if (server !== undefined) askMcpLine(data, server);
    }
  };

  const updateLibrarySkill = (row: LibraryRow | undefined, data: LibraryData) => {
    if (row === undefined || row.kind !== "skill") return;
    void run(async () => {
      const { library: snapshot } = await client.updateLibrarySkills([row.name]);
      saveLibrary({ ...data, library: snapshot });
      return `updated ${row.name}`;
    });
  };

  const openLibraryRow = (row: LibraryRow, data: LibraryData) => {
    if (row.kind === "found-mcp" || row.kind === "found-skill") {
      setFlash({
        text: `i brings ${row.name} into the library, for Neox to give it to other agents too`,
        ok: true,
      });
      return;
    }
    if (row.kind === "hook" || row.kind === "subagent") {
      setFlash({ text: `${row.name}: ${row.about}`, ok: true });
      return;
    }
    toggleLibraryAgents(row.kind, row.name, libraryHolders(row, data));
  };

  const libraryKey = (input: string, key: Key) => {
    if (library.status !== "ready") return;
    const data = library.data;
    const rows = libraryRows(data.library, data.rtk, data.discover);
    const moveLibrary = (by: number) => {
      if (rows.length > 0) {
        setCursor((value) => ({
          ...value,
          libraryRow: (value.libraryRow + by + rows.length) % rows.length,
        }));
      }
    };
    if (key.downArrow) return moveLibrary(1);
    if (key.upArrow) return moveLibrary(-1);
    const row = rows[cursor.libraryRow];
    if (key.return || input === " ") {
      if (row !== undefined) openLibraryRow(row, data);
      return;
    }
    switch (input) {
      case "j":
        return moveLibrary(1);
      case "k":
        return moveLibrary(-1);
      case "s":
        setFlash({ text: "writing the library into the agents…", ok: true });
        void run(async () => {
          const { library: snapshot, result } = await client.syncLibrary();
          saveLibrary({ ...data, library: snapshot });
          return result.changed.length === 0
            ? "every agent already had the library"
            : `wrote the library into ${result.changed.join(", ")}`;
        });
        return;
      case "a":
        openLibraryAdd();
        return;
      case "e":
        editLibraryRow(row, data);
        return;
      case "i":
        if (row !== undefined) importFound(row, data);
        return;
      case "u":
        updateLibrarySkill(row, data);
        return;
      case "d": {
        if (row !== undefined) removeLibraryRow(row, data);
        return;
      }
      default:
        return;
    }
  };

  const agentKey = (input: string, key: Key) => {
    if (agents.status !== "ready") return;
    const entries = arrangedAgents(agents.data.snapshot);
    if (input === "j" || key.downArrow) {
      setCursor((value) => ({
        ...value,
        agentRow: (value.agentRow + 1) % Math.max(1, entries.length),
        agentColumn: 0,
      }));
      return;
    }
    if (input === "k" || key.upArrow) {
      setCursor((value) => ({
        ...value,
        agentRow: (value.agentRow + entries.length - 1) % Math.max(1, entries.length),
        agentColumn: 0,
      }));
      return;
    }
    const entry = entries[cursor.agentRow];
    if (entry === undefined) return;
    const fields = Math.max(1, agentFields(entry).length);
    if (input === "l" || key.rightArrow || (key.tab && !key.shift)) {
      setCursor((value) => ({ ...value, agentColumn: (value.agentColumn + 1) % fields }));
      return;
    }
    if (input === "h" || key.leftArrow || (key.tab && key.shift)) {
      setCursor((value) => ({ ...value, agentColumn: (value.agentColumn + fields - 1) % fields }));
      return;
    }
    if (key.return || input === " ") {
      openAgentField();
      return;
    }
    if (input === "S") {
      void run(async () => {
        const result = await client.refreshGatewayCatalog();
        return result.ok
          ? `model catalog synced${result.models === undefined ? "" : ` · ${result.models} models`}`
          : `catalog sync failed: ${result.error ?? "unknown"}`;
      });
      return;
    }
    if (input === "s") {
      openAsk({
        title: ["save profile"],
        hint: "snapshots every agent's current settings",
        value: "",
        secret: false,
        empty: false,
        submit: (name) => {
          void run(async () => {
            const result = await client.saveAgentConnectProfile(name);
            setAgents({ status: "ready", data: { snapshot: result.snapshot } });
            return `saved profile ${name}`;
          });
        },
      });
      return;
    }
    if (input === "p") {
      openProfiles();
    }
  };

  const listKey = (input: string, key: Key) => {
    if (input !== "d") setConfirm("");
    if (input === "q" || key.escape) {
      exit();
      return;
    }
    if (input === "r") {
      if (page === 3) refreshReports.current = true;
      reload();
      return;
    }
    switch (page) {
      case 0:
        agentKey(input, key);
        return;
      case 1:
        providerKey(input, key);
        return;
      case 2:
        groupKey(input, key);
        return;
      case 3:
        usageKey(input, key);
        return;
      case 4:
        sessionKey(input, key);
        return;
      default:
        libraryKey(input, key);
    }
  };

  const usageKey = (inputByPage: string, key: Key) => {
    const input = inputByPage;
    const index = USAGE_PERIODS.indexOf(period);
    if (input === "l" || key.rightArrow) {
      setPeriod(USAGE_PERIODS[(index + 1) % USAGE_PERIODS.length]!);
      return;
    }
    if (input === "h" || key.leftArrow) {
      setPeriod(USAGE_PERIODS[(index + USAGE_PERIODS.length - 1) % USAGE_PERIODS.length]!);
      return;
    }
    if (input === "t") {
      setPeriod("today");
      return;
    }
    if (input === "w") {
      setPeriod("7d");
      return;
    }
    if (input === "m") {
      setPeriod("30d");
      return;
    }
    if (input === "A") {
      setPeriod("all");
      return;
    }
    if (input === "u") {
      setQuotaLeft((value) => !value);
      return;
    }
    if (input === "c") {
      void run(async () => {
        const result = await client.runGatewayCheckin();
        const accounts = await loadCheckins(client);
        setUsage((previous) =>
          previous.status === "ready"
            ? { status: "ready", data: { ...previous.data, checkin: accounts } }
            : previous,
        );
        if (result.entries.length === 0) {
          throw new Error(
            "no check-in account · sign in to WorkBuddy or MiniMax Code in myna, then reload",
          );
        }
        const said = result.entries.map(
          (entry) =>
            `${entry.user}: ${checkinWord(entry.outcome, entry.credit, entry.streak, entry.msg)}`,
        );
        return said.join(" · ");
      });
      return;
    }
  };

  useInput(
    (input, key) => {
      if (key.ctrl && input === "c") {
        exit();
        return;
      }
      if (mode.kind === "picker") {
        pickerKey(input, key);
        return;
      }
      if (mode.kind === "ask") {
        askKey(input, key, mode.ask.submit);
        return;
      }
      if (input.length > 1 && !key.ctrl && !key.meta) {
        let targetPage = page;
        let enter = false;
        for (const char of input) {
          if (char === "\r" || char === "\n") {
            enter = true;
            continue;
          }
          if (char === "q") {
            exit();
            return;
          }
          const next = pageForKey(char, targetPage);
          if (next !== null) targetPage = next;
        }
        if (targetPage !== page) {
          setFlash(null);
          goTo(targetPage);
          return;
        }
        if (enter) listKey("", { ...key, return: true, escape: false });
        return;
      }
      const next = mode.kind === "list" ? pageForKey(input, page) : null;
      if (next !== null) {
        setFlash(null);
        goTo(next);
        return;
      }
      listKey(input, key);
    },
    { isActive: interactive },
  );

  const rows = Math.max(12, size.rows);
  const columns = Math.max(40, size.columns);
  const hintInfo = pageHints(page, sessionStats, mode.kind === "group");
  const innerHeight = rows - 5 - hintInfo.lines;

  const pageBody = (): React.ReactElement => {
    switch (page) {
      case 0:
        return renderLoad(agents, (data) => (
          <AgentsPage
            snapshot={data.snapshot}
            row={cursor.agentRow}
            column={cursor.agentColumn}
            width={columns}
            height={innerHeight}
            theme={theme}
          />
        ));
      case 1:
        return renderLoad(providers, (data) => (
          <ProvidersPage
            config={data.config}
            balances={data.balances}
            row={cursor.providerRow}
            width={columns}
            height={innerHeight}
            theme={theme}
          />
        ));
      case 2:
        if (mode.kind === "group") {
          return renderGroupDetail(mode.gid, innerHeight);
        }
        return renderLoad(groups, (data) => (
          <GroupsPage
            config={data.config}
            row={cursor.groupRow}
            width={columns}
            height={innerHeight}
            theme={theme}
          />
        ));
      case 3:
        return renderLoad(usage, (data) => (
          <UsagePage
            report={data.report}
            reports={data.reports}
            reportsError={data.reportsError}
            reportsLoading={data.reportsLoading}
            agents={data.agents}
            checkin={data.checkin}
            period={period}
            left={quotaLeft}
            width={columns}
            height={innerHeight}
            theme={theme}
          />
        ));
      case 4:
        return renderLoad(sessions, (data) => (
          <SessionsPage
            sessions={data.sessions}
            statsSessions={data.activity ?? data.sessions}
            names={data.names}
            range={sessionRange}
            filter={sessionFilter}
            stats={sessionStats}
            byCost={sessionCost}
            selected={cursor.sessionRow}
            width={columns}
            height={innerHeight}
            now={new Date()}
            theme={theme}
          />
        ));
      default:
        return renderLoad(library, (data) => (
          <LibraryPage
            library={data.library}
            rtk={data.rtk}
            discover={data.discover}
            row={cursor.libraryRow}
            width={columns}
            height={innerHeight}
            theme={theme}
          />
        ));
    }
  };

  function renderLoad<T>(
    state: LoadState<T>,
    render: (data: T) => React.ReactElement,
  ): React.ReactElement {
    if (state.status === "ready") return render(state.data);
    if (state.status === "error") {
      return (
        <Text color={theme.color ? theme.bad : undefined} wrap="wrap">
          {`  ! ${state.error} · r retries`}
        </Text>
      );
    }
    return <Text color={theme.color ? theme.muted : undefined}> … reading {target}</Text>;
  }

  function renderGroupDetail(gid: string, height: number): React.ReactElement {
    if (groups.status !== "ready") {
      return <Text color={theme.color ? theme.muted : undefined}> … reading {target}</Text>;
    }
    const group = findGroup(gid);
    if (group === null) {
      return (
        <Text color={theme.color ? theme.bad : undefined}>
          {" "}
          ! that group is gone · esc goes back
        </Text>
      );
    }
    const ruleCount = (group.rules ?? []).length;
    const visible = Math.max(3, height - 10 - ruleCount);
    const members = group.members.slice(0, visible);
    return (
      <Box flexDirection="column">
        <Text color={theme.color ? theme.muted : undefined}>
          {`  group/${group.id} · ${groupRouting(group)} · ${affinityName(group.affinity)}${group.auto === true ? " · found by Neox: a change makes it yours" : ""}`}
        </Text>
        <Text> </Text>
        <Text color={theme.color ? theme.faint : undefined}>
          {" "}
          models · the first that can take a request gets it
        </Text>
        {members.map((member, index) => {
          const selected = mode.kind === "group" && mode.cursor === index;
          const off = group.off?.includes(member) === true;
          let memberColor: string | undefined;
          if (theme.color) memberColor = selected ? theme.accent : theme.text;
          return (
            <Text key={member} wrap="truncate-end">
              <Text color={theme.color ? theme.accent : undefined}>{selected ? "▸ " : "  "}</Text>
              <Text color={theme.color ? theme.faint : undefined}>{`${index + 1}  `}</Text>
              <Text bold={selected} color={memberColor}>
                {member}
              </Text>
              {group.fast?.includes(member) === true ? (
                <Text color={theme.color ? theme.muted : undefined}> · fast</Text>
              ) : null}
              {off ? (
                <Text color={theme.color ? theme.muted : undefined}> · switched off</Text>
              ) : null}
            </Text>
          );
        })}
        <Text> </Text>
        <Text color={theme.color ? theme.faint : undefined}>
          {
            "  rules · a turn's first matching rule sends it to its model first; a pause leaves its model out while it holds"
          }
        </Text>
        {ruleCount === 0 ? (
          <Text color={theme.color ? theme.muted : undefined}> none</Text>
        ) : (
          (group.rules ?? []).map((rule, index) => {
            const selected = mode.kind === "group" && mode.cursor === group.members.length + index;
            const conditions = ruleConditions(rule);
            const uses = [rule.use, ...(rule.more ?? [])].join(", ");
            return (
              <Text
                key={[
                  rule.use,
                  rule.more?.join(",") ?? "",
                  rule.tokens ?? "",
                  rule.intent ?? "",
                ].join("|")}
              >
                <Text color={theme.color ? theme.accent : undefined}>{selected ? "▸ " : "  "}</Text>
                <Text color={theme.color ? theme.faint : undefined}>{`${index + 1}  `}</Text>
                <Text
                  color={theme.color ? theme.muted : undefined}
                >{`${conditions}${conditions === "" ? "" : " → "}`}</Text>
                <Text
                  color={theme.color ? theme.text : undefined}
                >{`${rule.pause === true ? "pause " : ""}${uses}`}</Text>
              </Text>
            );
          })
        )}
        {(group.rules ?? []).some((rule) => (rule.intent ?? "") !== "") ? (
          <>
            <Text> </Text>
            <Text color={theme.color ? theme.faint : undefined}>
              {`  classifier ${group.classifier ?? "—"} · tells which intent a message is`}
            </Text>
          </>
        ) : null}
      </Box>
    );
  }

  let crumbs: string[] = [];
  let footerHints: readonly Hint[] = hintInfo.hints;
  let bodyNode: React.ReactElement = pageBody();
  if (mode.kind === "picker") {
    crumbs = mode.picker.title;
    footerHints = pickerHints(mode);
    bodyNode = (
      <Picker
        picker={mode.picker}
        theme={theme}
        rows={Math.max(3, innerHeight - 4)}
        width={columns}
      />
    );
  } else if (mode.kind === "ask") {
    crumbs = mode.ask.title;
    footerHints = ASK_HINTS;
    bodyNode = <Ask ask={mode.ask} theme={theme} />;
  } else if (mode.kind === "group") {
    crumbs = ["routing", findGroup(mode.gid)?.label ?? mode.gid];
    footerHints = GROUP_DETAIL_HINTS;
  }

  return (
    <Box flexDirection="column" height={rows}>
      {headerLines(page, crumbs, theme)}
      <Text> </Text>
      <Box flexDirection="column" flexGrow={1}>
        {bodyNode}
      </Box>
      <Text>{PAD}</Text>
      <Text>
        {PAD}
        <Status flash={flash} busy={busy} target={target} theme={theme} />
      </Text>
      <Text wrap="truncate-end">
        {PAD}
        <Hints hints={footerHints} theme={theme} />
      </Text>
    </Box>
  );
}
