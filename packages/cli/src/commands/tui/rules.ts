import type { GatewayGroupRuleWire, GatewayGroupWire } from "@neolix/protocol/gateway";

/**
 * myna's group rule language, as `myna group rule` and its TUI read it,
 * against Neolix's `GatewayGroupRuleWire`. Pure functions: the caller saves
 * the group through `setGatewayConfig`.
 */

/** The reasoning levels a rule's model can be asked for, lowest first. */
export const RULE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

/** How long an intent may be, in characters (myna's MaxIntent). */
export const MAX_INTENT = 200;

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
const DAY_NAMES = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;
const DAY_ORDER = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const MEMBER_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type RuleTime = NonNullable<GatewayGroupRuleWire["time"]>;

/** What a rule is resolved against: its group's members and classifier. */
export interface RuleGroup {
  id: string;
  members: readonly string[];
  classifier?: string;
}

export interface ParsedRule {
  rule: GatewayGroupRuleWire;
  /** The place asked for with `at=` (from 1), or 0 for the end. */
  at: number;
  /** The group's classifier, when the rule sets one. */
  classifier: string | null;
}

function quoted(value: string): string {
  return JSON.stringify(value);
}

/** Reads 200000, 200k, 1.5m, with `_` separators allowed. */
export function parseTokens(value: string): number {
  let text = value.toLowerCase().trim().replaceAll("_", "");
  let multiplier = 1;
  if (text.endsWith("k")) {
    multiplier = 1_000;
    text = text.slice(0, -1);
  } else if (text.endsWith("m")) {
    multiplier = 1_000_000;
    text = text.slice(0, -1);
  }
  const number = Number(text);
  if (text === "" || !Number.isFinite(number) || number < 0) {
    throw new Error(`tokens ${quoted(value)} is not a length (200000, 200k, 1m)`);
  }
  const tokens = Math.trunc(number * multiplier);
  if (tokens >= Number.MAX_SAFE_INTEGER) {
    throw new Error(`tokens ${quoted(value)} is not a length (200000, 200k, 1m)`);
  }
  return tokens;
}

/** Reads "mon" or "Monday" as the weekday's short name. */
export function parseDay(value: string): string | null {
  const text = value.trim().toLowerCase();
  if (text.length < 3) return null;
  const index = DAY_NAMES.findIndex((name) => name.startsWith(text));
  return index < 0 ? null : WEEKDAYS[index]!;
}

function splitRange(value: string): { from: string; to: string; range: boolean } {
  const at = value.indexOf("-");
  if (at < 0) return { from: value, to: value, range: false };
  return { from: value.slice(0, at), to: value.slice(at + 1), range: true };
}

/** Reads "mon-fri", "sat,sun", "mon,wed-fri"; ranges may wrap (fri-mon). */
export function parseDays(value: string): string[] {
  const days: string[] = [];
  for (const part of value.split(/[,\s]+/u).filter((item) => item !== "")) {
    const { from: fromText, to: toText, range } = splitRange(part.replaceAll("–", "-"));
    const from = parseDay(fromText);
    if (from === null) {
      throw new Error(`days: ${quoted(fromText)} is not a day of the week (mon … sun)`);
    }
    const to = range ? parseDay(toText) : from;
    if (to === null) {
      throw new Error(`days: ${quoted(toText)} is not a day of the week (mon … sun)`);
    }
    let index = WEEKDAYS.indexOf(from as (typeof WEEKDAYS)[number]);
    for (;;) {
      const day = WEEKDAYS[index]!;
      if (!days.includes(day)) days.push(day);
      if (day === to) break;
      index = (index + 1) % WEEKDAYS.length;
    }
  }
  if (days.length === 0) {
    throw new Error("days names the days of the week it holds on: days=mon-fri");
  }
  return days;
}

/** Minutes past midnight for "H:MM"/"HH:MM", or null. */
export function clockMinutes(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/u.exec(value.trim());
  if (match === null) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

function clockText(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

const zones = new Map<string, boolean>();

/** Whether an IANA zone this runtime knows; "" is the host's clock. */
export function validZone(name: string): boolean {
  if (name === "") return true;
  const cached = zones.get(name);
  if (cached !== undefined) return cached;
  let known = true;
  try {
    const formatter = new Intl.DateTimeFormat("en-US", { timeZone: name });
    known = formatter.resolvedOptions().timeZone !== "";
  } catch {
    known = false;
  }
  zones.set(name, known);
  return known;
}

/** This computer's IANA zone, as a window with none records it. */
export function localZone(): string {
  if (process.env.TZ !== undefined) {
    const zone = process.env.TZ.replace(/^:/u, "");
    if (zone !== "" && zone !== "Local" && validZone(zone)) return zone;
    return "";
  }
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return validZone(zone) ? zone : "";
  } catch {
    return "";
  }
}

/** Reads "09:00-18:00", "22:00-08:00" and "@Asia/Shanghai". */
export function parseTimeWindow(value: string): RuleTime {
  const at = value.indexOf("@");
  const hoursPart = at < 0 ? value : value.slice(0, at);
  const zonePart = at < 0 ? "" : value.slice(at + 1);
  const { from, to, range } = splitRange(hoursPart.replaceAll("–", "-").trim());
  if (!range) {
    throw new Error(
      `time is hours of the day: time=09:00-18:00 (or 22:00-08:00, past midnight; 09:00-18:00@Asia/Shanghai in a time zone), not ${quoted(value)}`,
    );
  }
  const fromText = from.trim();
  const toText = to.trim();
  const fromMinutes = clockMinutes(fromText);
  if (fromMinutes === null) {
    throw new Error(`the time ${quoted(fromText)} is not HH:MM (09:00)`);
  }
  const toMinutes = clockMinutes(toText);
  if (toMinutes === null) {
    throw new Error(`the time ${quoted(toText)} is not HH:MM (18:00)`);
  }
  const zone = zonePart.trim();
  if (!validZone(zone)) {
    throw new Error(
      `the time zone ${quoted(zone)} is not one myna knows: an IANA name such as Asia/Shanghai or America/New_York`,
    );
  }
  return {
    from: clockText(fromMinutes),
    to: clockText(toMinutes),
    ...(zone === "" ? {} : { zone }),
  };
}

/** Checks a folder is a whole path and keeps it as typed but a trailing slash. */
export function cleanFolder(value: string): string {
  let folder = value.trim();
  const trimmed = folder.replace(/[\\/]+$/u, "");
  if (trimmed !== "" && !(trimmed.length === 2 && trimmed[1] === ":")) {
    folder = trimmed;
  }
  const slashed = folder.replaceAll("\\", "/");
  const whole =
    folder === "~" ||
    folder.startsWith("~/") ||
    folder.startsWith("~\\") ||
    folder.startsWith("/") ||
    folder.startsWith("\\\\") ||
    /^[A-Za-z]:(?:\/|$)/u.test(slashed);
  if (!whole) {
    throw new Error(
      `the folder ${quoted(folder)} is not a whole path (/Users/me/work, ~/work, C:\\work)`,
    );
  }
  return folder;
}

function parseFolders(value: string): string[] {
  const folders: string[] = [];
  for (const part of value.split(",")) {
    const text = part.trim();
    if (text === "") continue;
    folders.push(cleanFolder(text));
  }
  return folders;
}

/** The member a typed model names, without the provider or with it. */
export function groupMember(group: RuleGroup, input: string): string {
  const wanted = input.trim().replace(/^myna\//u, "");
  const lower = wanted.toLowerCase();
  const plain = (member: string): string => {
    const at = member.lastIndexOf(":");
    if (at <= 0) return member;
    const suffix = member.slice(at + 1);
    const levels = suffix.split("+").map((part) => part.toLowerCase());
    if (!levels.every((part) => (MEMBER_EFFORTS as readonly string[]).includes(part))) {
      return member;
    }
    return member.slice(0, at);
  };
  const afterFirstSlash = (member: string): string => {
    const at = member.indexOf("/");
    return at < 0 ? "" : member.slice(at + 1);
  };
  const matches: readonly ((member: string) => boolean)[] = [
    (member) => member === wanted,
    (member) => member.toLowerCase() === lower,
    (member) => afterFirstSlash(member).toLowerCase() === lower,
    (member) => member.slice(member.lastIndexOf("/") + 1).toLowerCase() === lower,
    (member) => plain(member).toLowerCase() === lower,
    (member) => afterFirstSlash(plain(member)).toLowerCase() === lower,
  ];
  for (const match of matches) {
    const hits = group.members.filter((member) => match(member));
    if (hits.length === 0) continue;
    if (hits.length === 1) return hits[0]!;
    throw new Error(`${wanted} is ${hits.join(" and ")}: name one`);
  }
  throw new Error(`${wanted} is not in ${group.id} (its models: ${group.members.join(", ")})`);
}

/** Splits a typed line into words, a "quoted part" in one. */
export function ruleWords(line: string): string[] {
  const words: string[] = [];
  let word = "";
  let quotedPart = false;
  let some = false;
  for (const char of line) {
    if (char === '"') {
      quotedPart = !quotedPart;
      some = true;
      continue;
    }
    if (!quotedPart && (char === " " || char === "\t")) {
      if (some) words.push(word);
      word = "";
      some = false;
      continue;
    }
    word += char;
    some = true;
  }
  if (some) words.push(word);
  return words;
}

function setUses(rule: GatewayGroupRuleWire, uses: readonly string[]): void {
  const unique: string[] = [];
  for (const use of uses) {
    if (use !== "" && !unique.includes(use)) unique.push(use);
  }
  rule.use = unique[0] ?? "";
  if (unique.length > 1) rule.more = unique.slice(1);
  else delete rule.more;
}

function parseImages(value: string): boolean | null {
  switch (value.toLowerCase()) {
    case "":
    case "yes":
    case "true":
    case "on":
    case "1":
      return true;
    case "no":
    case "false":
    case "off":
    case "0":
      return false;
    default:
      return null;
  }
}

interface RuleState {
  rule: GatewayGroupRuleWire;
  at: number;
  classifier: string | null;
  zone: string;
  zoned: boolean;
}

type RuleWordHandler = (
  state: RuleState,
  value: string,
  hasValue: boolean,
  group: RuleGroup,
) => void;

function handleUse(state: RuleState, value: string, hasValue: boolean, group: RuleGroup): void {
  void hasValue;
  const uses: string[] = [];
  for (const name of value.split(",")) {
    const trimmed = name.trim();
    if (trimmed !== "") uses.push(groupMember(group, trimmed));
  }
  if (uses.length === 0) {
    throw new Error("use=<model> names the model it sends to, or several in order: use=a,b");
  }
  setUses(state.rule, uses);
}

function handlePause(state: RuleState, value: string, hasValue: boolean, group: RuleGroup): void {
  void hasValue;
  state.rule.use = groupMember(group, value);
  delete state.rule.more;
  state.rule.pause = true;
}

function handleTokens(state: RuleState, value: string, hasValue: boolean): void {
  void hasValue;
  const tokens = parseTokens(value);
  if (tokens > 0) state.rule.tokens = tokens;
  else delete state.rule.tokens;
}

function handleFlag(state: RuleState, field: "images" | "compact", value: string): void {
  const flag = parseImages(value);
  if (flag === null) {
    throw new Error(`${field} takes no value (or yes/no), not ${quoted(value)}`);
  }
  if (flag) state.rule[field] = true;
  else delete state.rule[field];
}

function handleImages(state: RuleState, value: string, hasValue: boolean): void {
  void hasValue;
  handleFlag(state, "images", value);
}

function handleCompact(state: RuleState, value: string, hasValue: boolean): void {
  void hasValue;
  handleFlag(state, "compact", value);
}

function handleEffort(state: RuleState, value: string, hasValue: boolean): void {
  const effort = (hasValue ? value : "on").toLowerCase().trim();
  if (effort === "") delete state.rule.effort;
  else state.rule.effort = effort;
}

function handleUseEffort(state: RuleState, value: string, hasValue: boolean): void {
  void hasValue;
  const effort = value.toLowerCase().trim();
  if (!RULE_EFFORTS.includes(effort as (typeof RULE_EFFORTS)[number])) {
    throw new Error(
      `use-effort is the reasoning the rule's model is asked for: one of ${RULE_EFFORTS.join(", ")}, not ${quoted(value)}`,
    );
  }
  state.rule.useEffort = effort as (typeof RULE_EFFORTS)[number];
}

function handleAgents(state: RuleState, value: string, hasValue: boolean): void {
  void hasValue;
  const agents = value.split(/[,\s]+/u).filter((agent) => agent !== "");
  if (agents.length > 0) state.rule.agents = agents;
  else delete state.rule.agents;
}

function handleIntent(state: RuleState, value: string, hasValue: boolean): void {
  void hasValue;
  const intent = value.trim();
  if (intent === "") {
    throw new Error('intent says what the message asks for: intent="writing or fixing tests"');
  }
  state.rule.intent = intent;
}

function handleTime(state: RuleState, value: string, hasValue: boolean): void {
  void hasValue;
  const window = parseTimeWindow(value);
  if (window.zone !== undefined) {
    state.zone = window.zone;
    state.zoned = true;
  }
  if (state.rule.time !== undefined) window.days = state.rule.time.days;
  state.rule.time = window;
}

function handleZone(state: RuleState, value: string, hasValue: boolean): void {
  void hasValue;
  const zone = value.trim();
  state.zone = zone;
  state.zoned = true;
  if (zone === "" || !validZone(zone)) {
    throw new Error(
      `tz: ${quoted(value)} is not a time zone myna knows: an IANA name such as Asia/Shanghai, Europe/Berlin or America/New_York`,
    );
  }
}

function handleDays(state: RuleState, value: string, hasValue: boolean): void {
  void hasValue;
  const days = parseDays(value);
  state.rule.time ??= { from: "00:00", to: "00:00" };
  state.rule.time.days = days;
}

function handleFolders(state: RuleState, value: string, field: "folders" | "exceptFolders"): void {
  const folders = parseFolders(value);
  if (folders.length === 0) {
    throw new Error(
      field === "folders"
        ? "folders names the working folders it holds in: folders=~/work/acme,~/oss"
        : "except-folders names the working folders it doesn't hold in: except-folders=~/big-task",
    );
  }
  state.rule[field] = [...(state.rule[field] ?? []), ...folders];
}

function handleFolderList(state: RuleState, value: string, hasValue: boolean): void {
  void hasValue;
  handleFolders(state, value, "folders");
}

function handleExceptFolders(state: RuleState, value: string, hasValue: boolean): void {
  void hasValue;
  handleFolders(state, value, "exceptFolders");
}

function handleClassifier(state: RuleState, value: string, hasValue: boolean): void {
  void hasValue;
  state.classifier = value.trim();
  if (state.classifier === "") {
    throw new Error("classifier=<model>: the model that tells which intent a message is");
  }
}

function handleAt(state: RuleState, value: string, hasValue: boolean): void {
  void hasValue;
  if (!/^[+-]?\d+$/u.test(value) || Number(value) < 1) {
    throw new Error(`at is a place from 1, not ${quoted(value)}`);
  }
  state.at = Number(value);
}

const RULE_WORDS: Readonly<Record<string, RuleWordHandler>> = {
  use: handleUse,
  model: handleUse,
  to: handleUse,
  pause: handlePause,
  skip: handlePause,
  tokens: handleTokens,
  context: handleTokens,
  longer: handleTokens,
  images: handleImages,
  image: handleImages,
  compact: handleCompact,
  compacting: handleCompact,
  compaction: handleCompact,
  effort: handleEffort,
  reasoning: handleEffort,
  thinking: handleEffort,
  "use-effort": handleUseEffort,
  useeffort: handleUseEffort,
  "set-effort": handleUseEffort,
  seteffort: handleUseEffort,
  agents: handleAgents,
  agent: handleAgents,
  intent: handleIntent,
  asks: handleIntent,
  about: handleIntent,
  time: handleTime,
  hours: handleTime,
  between: handleTime,
  tz: handleZone,
  zone: handleZone,
  timezone: handleZone,
  "time-zone": handleZone,
  days: handleDays,
  day: handleDays,
  folders: handleFolderList,
  folder: handleFolderList,
  in: handleFolderList,
  project: handleFolderList,
  projects: handleFolderList,
  "except-folders": handleExceptFolders,
  "except-folder": handleExceptFolders,
  exceptfolders: handleExceptFolders,
  "not-in": handleExceptFolders,
  outside: handleExceptFolders,
  classifier: handleClassifier,
  classify: handleClassifier,
  by: handleClassifier,
  at: handleAt,
};

function checkPause(rule: GatewayGroupRuleWire): void {
  if (rule.pause !== true) return;
  if ((rule.more ?? []).length > 0) {
    throw new Error("pause=<model> names one model: give each its own rule");
  }
  if (rule.useEffort !== undefined) {
    throw new Error("pause=<model> sends nothing, so it takes no use-effort=");
  }
  if (
    (rule.tokens ?? 0) > 0 ||
    rule.images === true ||
    (rule.effort ?? "") !== "" ||
    (rule.intent ?? "") !== "" ||
    rule.compact === true
  ) {
    throw new Error(
      "pause=<model> holds by time=, days=, agents=, folders= or except-folders= only",
    );
  }
  if (
    rule.time === undefined &&
    (rule.agents ?? []).length === 0 &&
    (rule.folders ?? []).length === 0 &&
    (rule.exceptFolders ?? []).length === 0
  ) {
    throw new Error(
      "pause=<model> needs time=, days=, agents=, folders= or except-folders=: when the model is left out",
    );
  }
}

function checkIntent(
  rule: GatewayGroupRuleWire,
  classifier: string | null,
  group: RuleGroup,
): void {
  if ((rule.intent ?? "") === "") return;
  if ((classifier === null || classifier === "") && !group.classifier) {
    throw new Error(
      "a rule with an intent needs the group's classifier, the model that tells which intent a message is: add classifier=<model>, best a small fast one",
    );
  }
  if (Array.from(rule.intent ?? "").length > MAX_INTENT) {
    throw new Error(`an intent is at most ${MAX_INTENT} characters`);
  }
}

function finishRule(state: RuleState, group: RuleGroup): ParsedRule {
  if (state.zoned) {
    if (state.rule.time === undefined) {
      throw new Error("tz= is the time zone of time= or days=: give one of them too");
    }
    state.rule.time.zone = state.zone;
  }
  if (state.rule.use === "") {
    throw new Error(
      `use=<model> (or pause=<model>) is missing: one of ${group.members.join(", ")}`,
    );
  }
  checkPause(state.rule);
  checkIntent(state.rule, state.classifier, group);
  return { rule: state.rule, at: state.at, classifier: state.classifier };
}

/**
 * Parses a typed rule, resolving models among the group's members. Errors
 * are myna's own: the TUI shows them as the daemon's would be shown.
 */
export function parseRuleLine(line: string, group: RuleGroup): ParsedRule {
  const state: RuleState = {
    rule: { use: "" },
    at: 0,
    classifier: null,
    zone: "",
    zoned: false,
  };
  for (const word of ruleWords(line)) {
    const equal = word.indexOf("=");
    const key = (equal < 0 ? word : word.slice(0, equal)).trim().toLowerCase();
    const handler = RULE_WORDS[key];
    if (handler === undefined) {
      throw new Error(
        `unknown ${quoted(word)} (use, use-effort, pause, tokens, images, effort, agents, intent, compact, time, days, tz, folders, except-folders, classifier, at)`,
      );
    }
    handler(state, equal < 0 ? "" : word.slice(equal + 1), equal >= 0, group);
  }
  return finishRule(state, group);
}

/** Puts a typed window with no zone on this computer's clock. */
export function inZoneHere(rule: GatewayGroupRuleWire): GatewayGroupRuleWire {
  if (rule.time === undefined || (rule.time.zone ?? "") !== "") return rule;
  const zone = localZone();
  if (zone === "") return rule;
  return { ...rule, time: { ...rule.time, zone } };
}

/** "Mon–Fri", "Sat,Sun", "Mon,Wed–Fri"; "" for every day. */
export function daysText(days: readonly string[]): string {
  const name = (day: string): string => day[0]!.toUpperCase() + day.slice(1);
  const parts: string[] = [];
  for (let index = 0; index < DAY_ORDER.length; ) {
    if (!days.includes(DAY_ORDER[index]!)) {
      index += 1;
      continue;
    }
    let end = index;
    while (end + 1 < DAY_ORDER.length && days.includes(DAY_ORDER[end + 1]!)) end += 1;
    if (end === index) parts.push(name(DAY_ORDER[index]!));
    else if (end === index + 1) parts.push(name(DAY_ORDER[index]!), name(DAY_ORDER[end]!));
    else parts.push(`${name(DAY_ORDER[index]!)}–${name(DAY_ORDER[end]!)}`);
    index = end + 1;
  }
  return parts.join(",");
}

function folderText(folders: readonly string[]): string | null {
  if (folders.length === 0) return null;
  let value = folders.join(",").replaceAll('"', "");
  if (/[ \t]/u.test(value)) value = `"${value}"`;
  return value;
}

function addPart(out: string[], condition: boolean, value: string): void {
  if (condition) out.push(value);
}

function timeLine(time: RuleTime | undefined): string[] {
  if (time === undefined) return [];
  const out: string[] = [];
  const days = time.days ?? [];
  addPart(out, time.from !== time.to || days.length === 0, `time=${time.from}-${time.to}`);
  addPart(out, days.length > 0, `days=${daysText(days).toLowerCase().replaceAll("–", "-")}`);
  addPart(out, (time.zone ?? "") !== "", `tz=${time.zone ?? ""}`);
  return out;
}

/** A rule as ParseRule reads it back (myna's Rule.Line). */
export function ruleLine(rule: GatewayGroupRuleWire): string {
  const uses = [rule.use, ...(rule.more ?? [])].filter((use) => use !== "");
  const out = [rule.pause === true ? `pause=${rule.use}` : `use=${uses.join(",")}`];
  addPart(out, rule.useEffort !== undefined, `use-effort=${rule.useEffort ?? ""}`);
  addPart(out, (rule.tokens ?? 0) > 0, `tokens=${rule.tokens ?? 0}`);
  addPart(out, rule.images === true, "images");
  addPart(out, (rule.effort ?? "") !== "", `effort=${rule.effort ?? ""}`);
  addPart(out, (rule.agents ?? []).length > 0, `agents=${(rule.agents ?? []).join(",")}`);
  addPart(out, (rule.intent ?? "") !== "", `intent="${(rule.intent ?? "").replaceAll('"', "")}"`);
  addPart(out, rule.compact === true, "compact");
  out.push(...timeLine(rule.time));
  const folders = folderText(rule.folders ?? []);
  addPart(out, folders !== null, `folders=${folders ?? ""}`);
  const except = folderText(rule.exceptFolders ?? []);
  addPart(out, except !== null, `except-folders=${except ?? ""}`);
  return out.join(" ");
}

/**
 * Reads a rule into the group: in place of rule `index` (from 0), or
 * added when it is -1; `at=` moves it. Mirrors myna's putRule.
 */
export function withParsedRule(
  group: RuleGroup & Pick<GatewayGroupWire, "rules">,
  index: number,
  line: string,
): { rules: GatewayGroupRuleWire[]; classifier: string | undefined } {
  const parsed = parseRuleLine(line, group);
  const rule = inZoneHere(parsed.rule);
  const rules = [...(group.rules ?? [])];
  let at = parsed.at;
  if (index >= 0 && index < rules.length) {
    rules.splice(index, 1);
    if (at === 0) at = index + 1;
  }
  if (at === 0 || at > rules.length) rules.push(rule);
  else rules.splice(at - 1, 0, rule);
  return {
    rules,
    classifier:
      parsed.classifier !== null && parsed.classifier !== "" ? parsed.classifier : group.classifier,
  };
}
