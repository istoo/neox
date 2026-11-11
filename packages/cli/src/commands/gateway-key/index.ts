import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Command } from "commander";
import type { Logger } from "pino";
import { resolveNeolixHome } from "@neolix/server/daemon-control";
import { loadUsageFile, statusesOf, type BudgetStatus } from "@neolix/server/gateway-budget";
import {
  GatewayConfigStore,
  newGatewayKeyId,
  type GatewayConfig,
  type GatewayKeyLimit,
} from "@neolix/server/gateway-config";
import {
  addDaemonHostOption,
  addJsonOption,
  localDaemonHome,
} from "../../utils/command-options.js";
import { parseTokens } from "../model/index.js";
import {
  configuredOidcRules,
  oidcRulesForConfig,
  removeOidcRule,
  saveOidcRule,
  type OidcRuleInput,
} from "@neolix/server/gateway-oidc-rules";

/**
 * `neolix gateway-key oidc` — myna's `myna gateway-key oidc list|add|remove`
 * (cli/gateway_keys_cli.go:740). The rules live in this computer's
 * gateway.json; the daemon watches that file and takes a change at once, so
 * this needs no running daemon.
 */

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child: () => silentLogger,
} as unknown as Logger;

/** --home as the command that is running chose it; undefined falls back to NEOLIX_HOME. */
let selectedHome: string | undefined;

function selectHome(command: Command): void {
  selectedHome = localDaemonHome(command);
}

/** --json whether the leaf or the parent parsed it (both register the option). */
function jsonOf(command: Command): boolean {
  return (command.optsWithGlobals() as { json?: boolean }).json === true;
}

async function withStore<T>(work: (store: GatewayConfigStore) => Promise<T>): Promise<T> {
  const neolixHome = resolveNeolixHome({ NEOLIX_HOME: selectedHome ?? process.env.NEOLIX_HOME });
  const store = new GatewayConfigStore({ neolixHome, logger: silentLogger });
  await store.start();
  try {
    return await work(store);
  } finally {
    store.dispose();
  }
}

const UNIT_SECONDS: Record<string, number> = {
  ms: 0.001,
  s: 1,
  m: 60,
  h: 3_600,
  d: 86_400,
};

/** myna's time.ParseDuration, for the --ttl values its CLI takes. */
export function parseTtlSeconds(value: string): number {
  const text = value.trim();
  const pattern = /(\d+(?:\.\d+)?)(ms|s|m|h|d)/g;
  let total = 0;
  let consumed = 0;
  for (const match of text.matchAll(pattern)) {
    consumed += match[0].length;
    const amount = Number(match[1]);
    const unit = UNIT_SECONDS[match[2] ?? ""] ?? 0;
    total += amount * unit;
  }
  if (consumed !== text.length || total <= 0) {
    throw new Error(`--ttl is a duration such as 1h or 30m: "${value}"`);
  }
  return Math.round(total);
}

function formatTtl(seconds: number): string {
  if (seconds % 86_400 === 0) {
    return `${seconds / 86_400}d`;
  }
  if (seconds % 3600 === 0) {
    return `${seconds / 3600}h`;
  }
  if (seconds % 60 === 0) {
    return `${seconds / 60}m`;
  }
  return `${seconds}s`;
}

interface RuleRow {
  id: string;
  key: string;
  ttlSeconds: number;
  audience: string;
  claims: Record<string, string>;
  issuer: string;
}

function printRules(rules: RuleRow[], json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(rules, null, 2)}\n`);
    return;
  }
  if (rules.length === 0) {
    process.stdout.write("No OIDC rules: neox gateway-key oidc add --key <id> --repo owner/name\n");
    return;
  }
  const rows = [
    ["ID", "KEY", "TTL", "AUDIENCE", "CLAIMS", "ISSUER"],
    ...rules.map((rule) => [
      rule.id,
      rule.key,
      formatTtl(rule.ttlSeconds),
      rule.audience,
      Object.entries(rule.claims)
        .map(([name, value]) => `${name}=${value}`)
        .join(" "),
      rule.issuer,
    ]),
  ];
  for (const row of rows) {
    process.stdout.write(`${row.join("\t")}\n`);
  }
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/**
 * myna's `myna gateway-key …` (internal/cli/gateway_keys_cli.go), over this
 * computer's gateway.json. The daemon watches that file, so no daemon is
 * needed.
 *
 * myna gives a key an id of its own; neolix's gateway.json has no id on a key,
 * so a key is named here by its label, or by its secret, as `gateway-key oidc`
 * already names one. See tasks/cli-gap.md.
 */

type KeyEntry = GatewayConfig["keys"][number];
type KeyObject = Extract<KeyEntry, { key: string }>;

/** myna's access.Prefix: a made-up key is the prefix and 48 hex characters. */
const KEY_PREFIX = ["sk", "myna", "key", ""].join("-");
const MAX_LIMITS = 5;
const MAX_LIMIT_DAYS = 3650;
const MAX_LIMIT_HOURS = 8760;
const MIN_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 30 * 24 * 60 * 60;

const gatewayKeyUsage =
  "usage: neox gateway-key list | add <name> [--key <value> | --key -] [--read-only] | " +
  "rotate <id> [--key <value> | --key -] | remove <id> | " +
  "limit <id> [list | off | reset [<n>] | remove <n> | [add] day|week|month|<N>d|<N>h " +
  "[--tokens N] [--cost USD] [--cache-reads]] | " +
  "models <id> [all | <provider>/<model>|<provider>/* ...] | " +
  "accounts <id> [all | <provider>/<account>|<provider>/<key id> ...] | " +
  "quotas <id> [on | off] | " +
  "access <id> [read-only | full] | move <id> <place> | " +
  "issue --ttl <duration> [--name <name>] [--models a,b] [--tokens N] [--cost USD] " +
  "[--read-only] [--from <id>] | issuer <id> [on | off] | " +
  "oidc [list | add --key <id> --repo owner/name … | remove <rule id>]";

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

/** Enough to tell keys apart, never enough to use one (as the gateway masks them). */
function maskKey(key: string): string {
  return key.length > 8 ? `${key.slice(0, 4)}…${key.slice(-4)}` : "…";
}

/** A name as the list prints it: control characters become spaces. */
function printable(value: string): string {
  return [...value]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || code === 127 ? " " : character;
    })
    .join("");
}

function keySecret(entry: KeyEntry): string {
  return typeof entry === "string" ? entry : entry.key;
}

function keyName(entry: KeyEntry): string {
  return typeof entry === "string" ? maskKey(entry) : (entry.label ?? maskKey(entry.key));
}

function keyModels(entry: KeyEntry): string[] {
  return typeof entry === "string" ? [] : entry.models;
}

function keyReadOnly(entry: KeyEntry): boolean {
  return typeof entry === "string" ? false : entry.readOnly;
}

function keyId(entry: KeyEntry): string | null {
  return typeof entry === "string" ? null : (entry.id ?? null);
}

function keyAccounts(entry: KeyEntry): string[] {
  return typeof entry === "string" ? [] : (entry.accounts ?? []);
}

function keyIssues(entry: KeyEntry): boolean {
  return typeof entry === "string" ? false : entry.issues;
}

/** A key of the user's own as the object every setting lives on. */
function asObject(entry: KeyEntry): KeyObject {
  if (typeof entry !== "string") {
    return { ...entry, models: [...entry.models] };
  }
  return { key: entry, models: [], readOnly: false, issues: false };
}

function findKey(config: GatewayConfig, ref: string): { index: number; entry: KeyEntry } {
  const index = config.keys.findIndex((entry) =>
    typeof entry === "string"
      ? entry === ref
      : entry.id === ref || entry.key === ref || entry.label === ref,
  );
  if (index < 0) {
    throw new Error("Key not found");
  }
  return { index, entry: config.keys[index]! };
}

function usageLedgerPath(): string {
  const neolixHome = resolveNeolixHome({ NEOLIX_HOME: selectedHome ?? process.env.NEOLIX_HOME });
  // usage.ts's GATEWAY_USAGE_FILENAME; the gateway writes its ledger here.
  return path.join(neolixHome, "gateway-usage.jsonl");
}

function statusesOfKey(config: GatewayConfig, secret: string, now: Date): BudgetStatus[] {
  return statusesOf(config, secret, now, usageLedgerPath());
}

function perPhrase(status: Pick<BudgetStatus, "period" | "days" | "hours">): string {
  switch (status.period) {
    case "days":
      return `every ${status.days ?? 1} days`;
    case "hours":
      return `every ${status.hours ?? 1} hours`;
    default:
      return `per ${status.period}`;
  }
}

/** A limit's window as myna's Limit.Per says it: "day", "10-day cycle". */
function perLabel(status: Pick<BudgetStatus, "period" | "days" | "hours">): string {
  switch (status.period) {
    case "days":
      return `${status.days ?? 1}-day cycle`;
    case "hours":
      return `${status.hours ?? 1}-hour cycle`;
    default:
      return status.period;
  }
}

const pad = (value: number): string => String(value).padStart(2, "0");

function clock(ms: number): string {
  const at = new Date(ms);
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

function shortClock(ms: number): string {
  const at = new Date(ms);
  return `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** A key's limits in the list, as myna's limitWords: "1200/1000000 tokens per day". */
function limitWords(all: BudgetStatus[]): string {
  if (all.length === 0) {
    return "-";
  }
  return all
    .map((status) => {
      const parts: string[] = [];
      if (status.tokenLimit > 0) {
        parts.push(`${status.tokens}/${status.tokenLimit} tokens`);
      }
      if (status.costLimit > 0) {
        parts.push(`$${status.cost.toFixed(2)}/$${status.costLimit.toFixed(2)}`);
      }
      let text = `${parts.join(" ")} ${perPhrase(status)}`;
      if (status.spent) {
        text += ` (spent until ${shortClock(status.reset)})`;
      }
      return text;
    })
    .join("; ");
}

function stateWord(entry: KeyEntry, now: Date): string {
  let state = "enabled";
  const expiresAt = typeof entry === "string" ? undefined : entry.expiresAt;
  if (expiresAt !== undefined) {
    const at = Date.parse(expiresAt);
    if (Number.isFinite(at)) {
      state = at <= now.getTime() ? "expired" : `until ${shortClock(at)}`;
    }
  }
  if (typeof entry !== "string" && entry.issuer !== undefined) {
    // myna names the issuer's id; neolix has none, and the key itself must not be printed
    state += ` (issued by ${maskKey(entry.issuer)})`;
  } else if (keyIssues(entry)) {
    state += ", issues keys";
  }
  return state;
}

interface KeyListRow {
  id: string | null;
  name: string;
  state: string;
  key: string;
  limit: string;
  models: string[];
  accounts: string[];
  access: string;
}

function keyListRow(config: GatewayConfig, entry: KeyEntry, now: Date): KeyListRow {
  const secret = keySecret(entry);
  return {
    id: keyId(entry),
    name: printable(keyName(entry)),
    state: stateWord(entry, now),
    key: maskKey(secret),
    limit: limitWords(statusesOfKey(config, secret, now)),
    models: keyModels(entry),
    accounts: keyAccounts(entry),
    access: keyReadOnly(entry) ? "read-only" : "full",
  };
}

function printKeyList(config: GatewayConfig, now: Date, json = false): void {
  const rows = config.keys.map((entry) => keyListRow(config, entry, now));
  if (json) {
    // The table says "all" for an empty list; data says the list itself.
    out(JSON.stringify(rows, null, 2));
    return;
  }
  out(["ID", "NAME", "STATE", "GATEWAY KEY", "LIMIT", "MODELS", "ACCOUNTS", "ACCESS"].join("\t"));
  for (const row of rows) {
    out(
      [
        row.id ?? "-",
        row.name,
        row.state,
        row.key,
        row.limit,
        row.models.length === 0 ? "all" : row.models.join(","),
        row.accounts.length === 0 ? "all" : row.accounts.join(","),
        row.access,
      ].join("\t"),
    );
  }
}

export async function gatewayKeyList(args: readonly string[], json = false): Promise<void> {
  if (args.length > 0) {
    throw new Error(gatewayKeyUsage);
  }
  const config = await withStore(async (store) => store.get());
  // the usage a limit counts, from the gateway's own ledger
  await loadUsageFile(usageLedgerPath());
  printKeyList(config, new Date(), json);
}

/** `--key <value>` / `--key -` (from stdin), myna's own-secret option. */
function takeOwnKey(value: string): string {
  if (value !== "-") {
    return value;
  }
  const text = readFileSync(0, "utf8").trim();
  if (text === "") {
    throw new Error("no key came on stdin");
  }
  return text;
}

function checkName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === "" || [...trimmed].length > 120) {
    throw new Error("Use a name between 1 and 120 characters");
  }
  return trimmed;
}

function checkOwnSecret(keys: readonly KeyEntry[], secret: string, except = -1): void {
  const taken = keys.some((entry, index) => index !== except && keySecret(entry) === secret);
  if (taken) {
    throw new Error("That key is the key of another here: give another");
  }
}

function newSecret(): string {
  return `${KEY_PREFIX}${randomBytes(24).toString("hex")}`;
}

export async function gatewayKeyAdd(args: readonly string[]): Promise<void> {
  let name: string | undefined;
  let own: string | undefined;
  let readOnly = false;
  for (let at = 0; at < args.length; at += 1) {
    const word = args[at]!;
    if (word === "--read-only") {
      readOnly = true;
      continue;
    }
    if (word === "--key") {
      const value = args[at + 1];
      if (value === undefined) {
        throw new Error(gatewayKeyUsage);
      }
      own = takeOwnKey(value);
      at += 1;
      continue;
    }
    if (word.startsWith("--key=")) {
      own = takeOwnKey(word.slice("--key=".length));
      continue;
    }
    if (word.startsWith("-") || name !== undefined) {
      throw new Error(gatewayKeyUsage);
    }
    name = word;
  }
  if (name === undefined) {
    throw new Error(gatewayKeyUsage);
  }
  const label = checkName(name);
  let created = "";
  await withStore(async (store) => {
    const config = store.get();
    const keys = config.keys.map((entry) => (typeof entry === "string" ? entry : { ...entry }));
    let secret: string;
    if (own !== undefined) {
      checkOwnSecret(keys, own);
      secret = own;
    } else {
      secret = newSecret();
      while (keys.some((entry) => keySecret(entry) === secret)) {
        secret = newSecret();
      }
    }
    created = secret;
    keys.push({ id: newGatewayKeyId(), key: secret, label, models: [], readOnly, issues: false });
    return store.write({ ...config, keys });
  });
  out(created);
}

export async function gatewayKeyRotate(args: readonly string[]): Promise<void> {
  let id: string | undefined;
  let own: string | undefined;
  for (let at = 0; at < args.length; at += 1) {
    const word = args[at]!;
    if (word === "--key") {
      const value = args[at + 1];
      if (value === undefined) {
        throw new Error(gatewayKeyUsage);
      }
      own = takeOwnKey(value);
      at += 1;
      continue;
    }
    if (word.startsWith("--key=")) {
      own = takeOwnKey(word.slice("--key=".length));
      continue;
    }
    if (word.startsWith("-") || id !== undefined) {
      throw new Error(gatewayKeyUsage);
    }
    id = word;
  }
  if (id === undefined) {
    throw new Error(gatewayKeyUsage);
  }
  const secret = await withStore(async (store) => {
    const config = store.get();
    const found = findKey(config, id);
    const previous = keySecret(found.entry);
    const keys = config.keys.map((entry, index) =>
      index === found.index ? asObject(entry) : entry,
    );
    let next: string;
    if (own !== undefined) {
      checkOwnSecret(keys, own, found.index);
      next = own;
    } else {
      next = newSecret();
      while (keys.some((entry) => keySecret(entry) === next)) {
        next = newSecret();
      }
    }
    keys[found.index] = { ...(keys[found.index] as KeyObject), key: next };
    // myna refers to a key by its id, which a rotation keeps; neolix's
    // gateway.json names it by the secret, so the references follow it
    const linked = keys.map((entry) =>
      typeof entry === "string" || entry.issuer !== previous
        ? entry
        : Object.assign({}, entry, { issuer: next }),
    );
    const oidc =
      config.oidc === undefined
        ? undefined
        : {
            ...config.oidc,
            rules: config.oidc.rules.map((rule) =>
              rule.key === previous ? { ...rule, key: next } : rule,
            ),
          };
    await store.write({ ...config, keys: linked, ...(oidc === undefined ? {} : { oidc }) });
    return next;
  });
  out(secret);
}

export async function gatewayKeyRemove(args: readonly string[]): Promise<void> {
  if (args.length !== 1) {
    throw new Error(gatewayKeyUsage);
  }
  await withStore(async (store) => {
    const config = store.get();
    const found = findKey(config, args[0]!);
    const keys = config.keys.filter((_entry, index) => index !== found.index);
    await store.write({ ...config, keys });
  });
  out("Gateway key removed");
}

function parseWindow(value: string): Pick<GatewayKeyLimit, "period" | "days" | "hours"> {
  if (value === "day" || value === "week" || value === "month") {
    return { period: value };
  }
  if (value.endsWith("d")) {
    const days = Number(value.slice(0, -1));
    if (!Number.isInteger(days) || days < 1 || days > MAX_LIMIT_DAYS) {
      throw new Error(
        `an N-day cycle is a whole number of days from 1 to ${MAX_LIMIT_DAYS}, like 10d: "${value}"`,
      );
    }
    return { period: "days", days };
  }
  if (value.endsWith("h")) {
    const hours = Number(value.slice(0, -1));
    if (!Number.isInteger(hours) || hours < 1 || hours > MAX_LIMIT_HOURS) {
      throw new Error(
        `an N-hour cycle is a whole number of hours from 1 to ${MAX_LIMIT_HOURS}, like 5h: "${value}"`,
      );
    }
    return { period: "hours", hours };
  }
  throw new Error(
    `a limit's period is day, week, month, <N>d (every N days) or <N>h (every N hours), not "${value}"`,
  );
}

function parseKeyLimit(window: string, rest: readonly string[]): GatewayKeyLimit {
  const parsed: GatewayKeyLimit = { ...parseWindow(window), cacheReads: false };
  for (let at = 0; at < rest.length; at += 1) {
    const word = rest[at]!;
    const eq = word.indexOf("=");
    const flag = eq >= 0 ? word.slice(0, eq) : word;
    const value = (): string => {
      if (eq >= 0) {
        return word.slice(eq + 1);
      }
      const next = rest[at + 1];
      if (next === undefined) {
        throw new Error(`${flag} needs a value`);
      }
      at += 1;
      return next;
    };
    if (flag === "--tokens") {
      const raw = value();
      let tokens: number;
      try {
        tokens = parseTokens(raw);
      } catch {
        throw new Error(`--tokens is a count, like 1000000 or 2m: "${raw}"`);
      }
      if (tokens <= 0) {
        throw new Error(`--tokens is a count, like 1000000 or 2m: "${raw}"`);
      }
      parsed.tokens = tokens;
    } else if (flag === "--cost") {
      const raw = value();
      const cost = Number(raw.replace(/^\$/, ""));
      if (!Number.isFinite(cost) || cost < 0) {
        throw new Error(`--cost is US dollars, like 5 or 2.50: "${raw}"`);
      }
      parsed.cost = cost;
    } else if (flag === "--cache-reads") {
      parsed.cacheReads = true;
    } else {
      throw new Error(gatewayKeyUsage);
    }
  }
  if ((parsed.tokens ?? 0) <= 0 && (parsed.cost ?? 0) <= 0) {
    throw new Error("say --tokens, --cost or both, or off for no limit");
  }
  return parsed;
}

function limitsEqual(
  limit: Pick<GatewayKeyLimit, "period" | "days" | "hours">,
  other: Pick<GatewayKeyLimit, "period" | "days" | "hours">,
): boolean {
  return limit.period === other.period && limit.days === other.days && limit.hours === other.hours;
}

/**
 * myna's sinceOf: a cycle of days or hours starts now, a calendar window
 * counts from its own start unless it is the same window reset.
 */
function sinceOf(
  limit: Pick<GatewayKeyLimit, "period" | "days" | "hours">,
  now: string,
  previous?: GatewayKeyLimit,
): string | undefined {
  if (limit.period === "days" || limit.period === "hours") {
    return now;
  }
  return previous !== undefined && limitsEqual(previous, limit) ? previous.since : undefined;
}

function nthLimit(value: string, count: number, name: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > count) {
    if (count === 0) {
      throw new Error(`${name} has no limit`);
    }
    throw new Error(
      `a limit's number is 1 to ${count}, as \`neox gateway-key limit <id>\` lists them: "${value}"`,
    );
  }
  return n - 1;
}

function printLimits(name: string, all: BudgetStatus[]): void {
  if (all.length === 0) {
    out(`${name}: no limit`);
    return;
  }
  out(`Key\t${name}`);
  all.forEach((status, at) => {
    if (all.length > 1) {
      out("\t");
      out(`Limit ${at + 1}\t${perPhrase(status)}, all must have something left`);
    }
    out(
      `Window\tthis ${perLabel(status)}, ${clock(status.start)} – ${clock(status.reset)} (local time)`,
    );
    if (status.tokenLimit > 0) {
      const counted = `input, output and cache writes${status.cacheReads ? ", and cache reads" : ""}`;
      out(
        `Tokens\t${status.tokens} used of ${status.tokenLimit}, ${status.tokensLeft} left (${counted})`,
      );
    } else {
      out(`Tokens\t${status.tokens} used, no cap`);
    }
    const unpriced =
      status.unpriced > 0 ? `, ${status.unpriced} calls without a known price not in it` : "";
    if (status.costLimit > 0) {
      out(
        `Cost\t$${status.cost.toFixed(2)} used of $${status.costLimit.toFixed(2)}, ` +
          `$${status.costLeft.toFixed(2)} left (estimate at Usage prices${unpriced})`,
      );
    } else {
      out(`Cost\t$${status.cost.toFixed(2)} used, no cap (estimate${unpriced})`);
    }
    out(
      `State\t${status.spent ? `spent: requests are refused until ${clock(status.reset)}` : "open"}`,
    );
  });
}

export async function gatewayKeyLimit(args: readonly string[]): Promise<void> {
  const usage = new Error(
    "usage: neox gateway-key limit <id> [off | reset [<n>] | remove <n> | " +
      "[add] day|week|month|<N>d|<N>h [--tokens N] [--cost USD] [--cache-reads]]",
  );
  if (args.length === 0) {
    throw usage;
  }
  await loadUsageFile(usageLedgerPath());
  const id = args[0]!;
  let name = id;
  if (args.length > 1) {
    const config = await withStore(async (store) => store.get());
    const found = findKey(config, id);
    name = keyName(found.entry);
  }
  if (args.length > 1) {
    const action = args[1]!;
    const config = await withStore(async (store) => {
      const current = store.get();
      const found = findKey(current, id);
      const keys = current.keys.map((entry) =>
        typeof entry === "string"
          ? entry
          : { ...entry, limits: entry.limits?.map((l) => ({ ...l })) },
      );
      const target = asObject(keys[found.index]!);
      const have = target.limits ?? [];
      const now = new Date().toISOString();
      if (action === "list") {
        if (args.length > 2) {
          throw usage;
        }
      } else if (action === "reset") {
        if (args.length > 3) {
          throw usage;
        }
        if (have.length === 0) {
          throw new Error(`${name} has no limit to reset`);
        }
        if (args.length === 3) {
          const n = nthLimit(args[2]!, have.length, name);
          target.limits = have.map((limit, at) => (at === n ? { ...limit, since: now } : limit));
        } else {
          target.limits = have.map((limit) => ({ ...limit, since: now }));
        }
      } else if (action === "off") {
        if (args.length > 2) {
          throw usage;
        }
        delete target.limits;
        delete target.dailyTokens;
        delete target.monthlyUsd;
      } else if (action === "remove") {
        if (args.length !== 3) {
          throw usage;
        }
        const n = nthLimit(args[2]!, have.length, name);
        target.limits = have.filter((_limit, at) => at !== n);
      } else if (action === "add") {
        if (args.length < 3) {
          throw usage;
        }
        const limit = parseKeyLimit(args[2]!, args.slice(3));
        if (have.length >= MAX_LIMITS) {
          throw new Error(`A key can have at most ${MAX_LIMITS} limits`);
        }
        if (have.some((existing) => limitsEqual(existing, limit))) {
          throw new Error(
            `${name} already has a limit ${perPhrase(limit)}: change that one instead`,
          );
        }
        target.limits = [...have, { ...limit, since: sinceOf(limit, now) }];
      } else {
        const limit = parseKeyLimit(action, args.slice(2));
        const same = have.find((existing) => limitsEqual(existing, limit));
        if (same !== undefined) {
          // of several, the one counted in the same window is set
          target.limits = have.map((existing) =>
            limitsEqual(existing, limit)
              ? { ...existing, ...limit, since: sinceOf(limit, now, existing) }
              : existing,
          );
        } else if (have.length > 1) {
          throw new Error(
            `${name} has ${have.length} limits and none ${perPhrase(limit)}: ` +
              `add one with \`neox gateway-key limit <id> add ${action} ...\`, ` +
              "or take one off with `remove <n>`",
          );
        } else {
          // the only one is replaced, as before several were allowed
          target.limits = [{ ...limit, since: sinceOf(limit, now) }];
        }
      }
      if (action === "list") {
        return current;
      }
      keys[found.index] = { ...target, limits: target.limits };
      return store.write({ ...current, keys });
    });
    const written = findKey(config, id);
    printLimits(
      keyName(written.entry),
      statusesOfKey(config, keySecret(written.entry), new Date()),
    );
    return;
  }
  const config = await withStore(async (store) => store.get());
  const found = findKey(config, id);
  printLimits(keyName(found.entry), statusesOfKey(config, keySecret(found.entry), new Date()));
}

export async function gatewayKeyModels(args: readonly string[]): Promise<void> {
  if (args.length === 0) {
    throw new Error(
      "usage: neox gateway-key models <id> [all | <provider>/<model>|<provider>/* ...]",
    );
  }
  const id = args[0]!;
  let models: string[] | undefined;
  if (args.length > 1) {
    models = args.slice(1);
    if (models.length === 1 && models[0] === "all") {
      models = [];
    }
  }
  const config = await withStore(async (store) => {
    const current = store.get();
    const found = findKey(current, id);
    if (models === undefined) {
      return current;
    }
    const keys = current.keys.map((entry, index) =>
      index === found.index ? { ...asObject(entry), models: [...models] } : entry,
    );
    return store.write({ ...current, keys });
  });
  const found = findKey(config, id);
  const held = keyModels(found.entry);
  out(
    held.length === 0
      ? `${keyName(found.entry)}: every model`
      : `${keyName(found.entry)}: only ${held.join(", ")}`,
  );
}

/** myna's CleanAccounts: `<provider>/<account>` with an account its provider has. */
export function cleanKeyAccounts(config: GatewayConfig, values: readonly string[]): string[] {
  const kept: string[] = [];
  for (const raw of values) {
    const value = raw.trim();
    if (value === "") {
      continue;
    }
    const slash = value.indexOf("/");
    if (slash <= 0 || slash === value.length - 1) {
      throw new Error(
        `A key's account is <provider>/<account> or <provider>/<key id>, like codex/me@example.com: ${value}`,
      );
    }
    if (value.length > 300) {
      throw new Error("A key's account is at most 300 characters");
    }
    const providerId = value.slice(0, slash);
    const ref = value.slice(slash + 1);
    const provider = config.providers.find((candidate) => candidate.id === providerId);
    if (provider === undefined) {
      throw new Error(`no provider "${providerId}" (neox provider ls lists them)`);
    }
    const accounts = provider.accounts ?? [];
    let keptRef = ref;
    if (accounts.length > 0) {
      const match = accounts.find(
        (account) =>
          account.id.toLowerCase() === ref.toLowerCase() ||
          account.label?.toLowerCase() === ref.toLowerCase(),
      );
      if (match === undefined) {
        throw new Error(`${providerId} has no account "${ref}"`);
      }
      keptRef = match.id;
    }
    const entry = `${providerId}/${keptRef}`;
    if (!kept.some((account) => account.toLowerCase() === entry.toLowerCase())) {
      kept.push(entry);
    }
  }
  if (kept.length > 500) {
    throw new Error("A key can list at most 500 accounts");
  }
  return kept;
}

export async function gatewayKeyAccounts(args: readonly string[]): Promise<void> {
  if (args.length === 0) {
    throw new Error(
      "usage: neox gateway-key accounts <id> [all | <provider>/<account>|<provider>/<key id> ...]",
    );
  }
  const id = args[0]!;
  const config = await withStore(async (store) => {
    const current = store.get();
    const found = findKey(current, id);
    if (args.length === 1) {
      return current;
    }
    const accounts =
      args.length === 2 && args[1] === "all" ? [] : cleanKeyAccounts(current, args.slice(1));
    const keys = current.keys.map((entry, index) =>
      index === found.index ? { ...asObject(entry), accounts } : entry,
    );
    return store.write({ ...current, keys });
  });
  const entry = findKey(config, id).entry;
  const accounts = keyAccounts(entry);
  out(
    accounts.length === 0
      ? `${keyName(entry)}: every account`
      : `${keyName(entry)}: only ${accounts.join(", ")}`,
  );
}

export async function gatewayKeyQuotas(args: readonly string[]): Promise<void> {
  const usage = new Error("usage: neox gateway-key quotas <id> [on | off]");
  if (args.length === 0 || args.length > 2) {
    throw usage;
  }
  const id = args[0]!;
  if (args.length === 2 && args[1] !== "on" && args[1] !== "off") {
    throw usage;
  }
  const config = await withStore(async (store) => {
    const current = store.get();
    const found = findKey(current, id);
    if (args.length === 1) {
      return current;
    }
    const keys = current.keys.map((entry, index) =>
      index === found.index ? { ...asObject(entry), quotas: args[1] === "on" } : entry,
    );
    return store.write({ ...current, keys });
  });
  const entry = findKey(config, id).entry;
  const quotas = typeof entry === "string" ? false : (entry.quotas ?? false);
  out(
    quotas
      ? `${keyName(entry)}: told the quotas of the providers and accounts it may use`
      : `${keyName(entry)}: told no quotas when held to a budget, models or accounts`,
  );
}

export async function gatewayKeyAccess(args: readonly string[]): Promise<void> {
  const usage = new Error("usage: neox gateway-key access <id> [read-only | full]");
  if (args.length === 0 || args.length > 2) {
    throw usage;
  }
  const id = args[0]!;
  if (args.length === 2 && args[1] !== "read-only" && args[1] !== "full") {
    throw usage;
  }
  const config = await withStore(async (store) => {
    const current = store.get();
    const found = findKey(current, id);
    if (args.length === 1) {
      return current;
    }
    const keys = current.keys.map((entry, index) =>
      index === found.index ? { ...asObject(entry), readOnly: args[1] === "read-only" } : entry,
    );
    return store.write({ ...current, keys });
  });
  const entry = findKey(config, id).entry;
  out(
    keyReadOnly(entry)
      ? `${keyName(entry)}: read-only, it reads quotas and usage and uses no model, MCP server or write`
      : `${keyName(entry)}: full access, models and stats as its other limits let it`,
  );
}

export async function gatewayKeyMove(args: readonly string[]): Promise<void> {
  if (args.length !== 2) {
    throw new Error("usage: neox gateway-key move <id> <place>");
  }
  const place = Number(args[1]);
  await withStore(async (store) => {
    const current = store.get();
    const found = findKey(current, args[0]!);
    if (!Number.isInteger(place) || place < 1 || place > current.keys.length) {
      throw new Error(
        `a key's place is 1 to ${current.keys.length}, as \`neox gateway-key list\` lists them: "${args[1]}"`,
      );
    }
    const keys = [...current.keys];
    const [moved] = keys.splice(found.index, 1);
    keys.splice(place - 1, 0, moved!);
    return store.write({ ...current, keys });
  });
  out(`Gateway key moved to place ${place}`);
}

interface IssueInput {
  ttl: number;
  name?: string;
  models: string[];
  tokens?: number;
  cost?: number;
  readOnly: boolean;
  from?: string;
}

// eslint-disable-next-line complexity -- one branch per flag myna's issue takes.
function parseIssue(args: readonly string[]): { input: IssueInput; json: boolean } {
  const usage = new Error(
    "usage: neox gateway-key issue --ttl <duration, e.g. 1h> [--name <name>] " +
      "[--models <provider>/<model>,...] [--tokens N] [--cost USD] [--read-only] " +
      "[--from <id>] [--json]",
  );
  let ttl: number | undefined;
  let name: string | undefined;
  let models: string[] = [];
  let tokens: number | undefined;
  let cost: number | undefined;
  let readOnly = false;
  let from: string | undefined;
  let json = false;
  const list = (value: string): string[] =>
    value
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part !== "");
  for (let at = 0; at < args.length; at += 1) {
    const word = args[at]!;
    if (word === "--read-only") {
      readOnly = true;
      continue;
    }
    if (word === "--json") {
      json = true;
      continue;
    }
    if (!["--ttl", "--name", "--models", "--tokens", "--cost", "--from"].includes(word)) {
      throw usage;
    }
    const value = args[at + 1];
    if (value === undefined || value.startsWith("--")) {
      throw usage;
    }
    at += 1;
    if (word === "--ttl") {
      try {
        ttl = parseTtlSeconds(value);
      } catch {
        throw new Error("--ttl is a duration such as 30m, 1h or 24h");
      }
    } else if (word === "--name") {
      name = value;
    } else if (word === "--models") {
      models = list(value);
    } else if (word === "--tokens") {
      const n = Number(value);
      if (!Number.isInteger(n) || n <= 0) {
        throw new Error("--tokens is a whole number above 0");
      }
      tokens = n;
    } else if (word === "--cost") {
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error("--cost is an amount in USD above 0");
      }
      cost = n;
    } else if (word === "--from") {
      from = value;
    }
  }
  if (ttl === undefined) {
    throw usage;
  }
  if (ttl < MIN_TTL_SECONDS || ttl > MAX_TTL_SECONDS) {
    throw new Error("An issued key lives from 1m0s to 30 days: give a ttl such as 1h");
  }
  return { input: { ttl, name, models, tokens, cost, readOnly, from }, json };
}

export async function gatewayKeyIssue(args: readonly string[], jsonOption = false): Promise<void> {
  const parsed = parseIssue(args);
  const { input } = parsed;
  // --json was read from args until the option was registered on the command.
  const json = jsonOption || parsed.json;
  const now = new Date();
  const expires = new Date(now.getTime() + input.ttl * 1000);
  const label = checkName(input.name ?? `Issued ${clock(now.getTime()).slice(0, 16)}`);
  let created = "";
  // eslint-disable-next-line complexity -- one check per thing an issued key is held to.
  const written = await withStore(async (store) => {
    const config = store.get();
    const keys = config.keys.map((entry) => (typeof entry !== "string" ? { ...entry } : entry));
    let issuer: KeyObject | undefined;
    if (input.from !== undefined) {
      const found = findKey(config, input.from);
      const parent = asObject(found.entry);
      if (
        parent.issuer !== undefined ||
        (parent.expiresAt !== undefined && Date.parse(parent.expiresAt) <= now.getTime())
      ) {
        throw new Error("The key issuing is no longer an enabled gateway key");
      }
      if (!parent.issues) {
        throw new Error(
          "This gateway key can't issue keys: turn it on with neox gateway-key issuer <id> on",
        );
      }
      issuer = parent;
    }
    let expiresAt = expires;
    if (issuer?.expiresAt !== undefined) {
      const parentExpires = new Date(issuer.expiresAt);
      if (parentExpires < expiresAt) {
        expiresAt = parentExpires;
      }
    }
    let models = [...input.models];
    if (issuer !== undefined && issuer.models.length > 0) {
      // a key that names none may use its issuer's, as POST /v1/myna/keys clamps
      if (models.length === 0) {
        models = [...issuer.models];
      }
      for (const model of models) {
        if (!issuer.models.includes(model)) {
          throw new Error(
            `The key issuing may not use ${model}, so the key it issues can't either`,
          );
        }
      }
    }
    let limits: GatewayKeyLimit[] | undefined;
    if ((input.tokens ?? 0) > 0 || (input.cost ?? 0) > 0) {
      const hours = Math.max(Math.ceil((expiresAt.getTime() - now.getTime()) / 3_600_000), 1);
      limits = [
        {
          period: "hours",
          hours,
          ...(input.tokens === undefined ? {} : { tokens: input.tokens }),
          ...(input.cost === undefined ? {} : { cost: input.cost }),
          cacheReads: false,
          since: now.toISOString(),
        },
      ];
    }
    created = newSecret();
    const entry: KeyObject = {
      id: newGatewayKeyId(),
      key: created,
      label,
      models,
      readOnly: input.readOnly || issuer?.readOnly === true,
      issues: false,
      expiresAt: expiresAt.toISOString(),
      ...(input.from === undefined ? {} : { issuer: keySecret(findKey(config, input.from).entry) }),
      ...(limits === undefined ? {} : { limits }),
    };
    keys.push(entry);
    return store.write({ ...config, keys });
  });
  const issued = written.keys.find((entry) => keySecret(entry) === created);
  if (issued === undefined) {
    throw new Error("Key not found");
  }
  if (typeof issued === "string") {
    throw new Error("Key not found");
  }
  if (json) {
    out(
      JSON.stringify(
        {
          ...(issued.id === undefined ? {} : { id: issued.id }),
          name: issued.label,
          key: issued.key,
          expires: issued.expiresAt,
          ...(issued.issuer === undefined ? {} : { issuer: maskKey(issued.issuer) }),
          ...(issued.models.length === 0 ? {} : { models: issued.models }),
          ...(issued.limits === undefined ? {} : { limit: issued.limits[0] }),
          ...(issued.readOnly ? { readOnly: true } : {}),
        },
        null,
        2,
      ),
    );
    return;
  }
  out(issued.key);
}

export async function gatewayKeyIssuer(args: readonly string[]): Promise<void> {
  const usage = new Error("usage: neox gateway-key issuer <id> [on | off]");
  if (args.length === 0 || args.length > 2) {
    throw usage;
  }
  const id = args[0]!;
  if (args.length === 2 && args[1] !== "on" && args[1] !== "off") {
    throw usage;
  }
  const config = await withStore(async (store) => {
    const current = store.get();
    const found = findKey(current, id);
    if (args.length === 1) {
      return current;
    }
    const on = args[1] === "on";
    const entry = asObject(found.entry);
    if (on && (entry.issuer !== undefined || entry.expiresAt !== undefined)) {
      throw new Error("An issued key can't issue keys of its own: let a key of yours issue them");
    }
    const keys = current.keys.map((candidate, index) =>
      index === found.index ? { ...entry, issues: on } : candidate,
    );
    return store.write({ ...current, keys });
  });
  const entry = findKey(config, id).entry;
  out(
    keyIssues(entry)
      ? `${keyName(entry)}: may issue short-lived keys, each held to its own models, accounts, limits and life`
      : `${keyName(entry)}: issues no keys`,
  );
}

export function createGatewayKeyCommand(): Command {
  const command = new Command("gateway-key").description(
    "Gateway keys, and the OIDC rules a CI token is traded for one under",
  );
  const oidc = command.command("oidc").description("OIDC rules: list, add, remove");

  const oidcList = oidc.command("list").description("List the OIDC rules");
  addDaemonHostOption(addJsonOption(oidcList));
  oidcList.action(async (_options: unknown, cmd: Command) => {
    selectHome(cmd);
    const rules = await withStore(async (store) => configuredOidcRules(store.get()));
    printRules(rules, jsonOf(cmd));
  });

  const oidcAdd = oidc
    .command("add")
    .description("Add a rule: a token matching it gets a key, held to the gateway key it names")
    .requiredOption("--key <id>", "gateway key (label or secret) the issued keys are held to")
    .option("--repo <owner/name>", "claim repository=owner/name")
    .option("--owner <owner>", "claim repository_owner=owner")
    .option("--ref <ref>", "claim ref=refs/heads/main")
    .option("--environment <name>", "claim environment=name")
    .option("--claim <name=value...>", "another claim the token must have", collect, [])
    .option("--ttl <duration>", "how long an issued key lives, such as 1h (default 1h)")
    .option("--issuer <url>", "the token's issuer (default GitHub Actions)")
    .option("--audience <aud>", "the token's aud (default neolix-<rule id>)");
  addDaemonHostOption(addJsonOption(oidcAdd));
  oidcAdd.action(
    async (options: Record<string, string | string[] | boolean | undefined>, cmd: Command) => {
      selectHome(cmd);
      const json = jsonOf(cmd);
      const claims: Record<string, string> = {};
      for (const [flag, claim] of [
        ["repo", "repository"],
        ["owner", "repository_owner"],
        ["ref", "ref"],
        ["environment", "environment"],
      ] as const) {
        const value = options[flag];
        if (typeof value === "string") {
          claims[claim] = value;
        }
      }
      for (const entry of Array.isArray(options.claim) ? options.claim : []) {
        const at = entry.indexOf("=");
        if (at <= 0) {
          throw new Error(`--claim is name=value: "${entry}"`);
        }
        claims[entry.slice(0, at)] = entry.slice(at + 1);
      }
      const input: OidcRuleInput = {
        key: String(options.key ?? ""),
        claims,
        ...(typeof options.ttl === "string" ? { ttlSeconds: parseTtlSeconds(options.ttl) } : {}),
        ...(typeof options.issuer === "string" ? { issuer: options.issuer } : {}),
        ...(typeof options.audience === "string" ? { audience: options.audience } : {}),
      };
      const { rule } = await withStore(async (store) => {
        const change = saveOidcRule(store.get(), input);
        await store.write({ ...store.get(), oidc: oidcRulesForConfig(change.rules) });
        return change;
      });
      if (json) {
        process.stdout.write(`${JSON.stringify(rule, null, 2)}\n`);
        return;
      }
      process.stdout.write(
        `OIDC rule ${rule.id}: a token from ${rule.issuer} with audience ${rule.audience} and ` +
          `${Object.keys(rule.claims).length} claim(s) matched gets a key held to ${rule.key}, ` +
          `living up to ${formatTtl(rule.ttlSeconds)}.\n` +
          "POST it to /v1/myna/keys/oidc as Authorization: Bearer <token>.\n",
      );
    },
  );

  const oidcRemove = oidc
    .command("remove")
    .description("Remove a rule by id")
    .argument("<id>", "the rule's id (neox gateway-key oidc list)");
  addDaemonHostOption(addJsonOption(oidcRemove));
  oidcRemove.action(async (id: string, _options: unknown, cmd: Command) => {
    selectHome(cmd);
    const json = jsonOf(cmd);
    const { removed, rules } = await withStore(async (store) => {
      const change = removeOidcRule(store.get(), id);
      await store.write({ ...store.get(), oidc: oidcRulesForConfig(change.rules) });
      return change;
    });
    if (json) {
      process.stdout.write(`${JSON.stringify(rules, null, 2)}\n`);
      return;
    }
    process.stdout.write(`OIDC rule ${removed.id} removed\n`);
  });

  // The rest take their words as typed, as myna's CLI reads them. They all
  // read and write this computer's gateway.json, so --home selects it and
  // --host is refused (localDaemonHome).
  const word = (name: string): Command => {
    const leaf = command
      .command(name)
      .argument("[args...]")
      .allowUnknownOption(true)
      .description(`${name} — see neox gateway-key`);
    addDaemonHostOption(addJsonOption(leaf));
    return leaf;
  };
  const localWord =
    (name: string, run: (args: string[]) => Promise<void>, supportsJson = false) =>
    async (args: string[] | undefined, _options: unknown, cmd: Command): Promise<void> => {
      selectHome(cmd);
      if (jsonOf(cmd) && !supportsJson) {
        throw new Error(
          `neox gateway-key ${name} has no JSON output (neox gateway-key list --json does)`,
        );
      }
      await run(args ?? []);
    };

  word("list").action(async (args: string[] | undefined, _options: unknown, cmd: Command) => {
    selectHome(cmd);
    await gatewayKeyList(args ?? [], jsonOf(cmd));
  });
  word("add").action(localWord("add", gatewayKeyAdd));
  word("rotate").action(localWord("rotate", gatewayKeyRotate));
  word("remove").action(localWord("remove", gatewayKeyRemove));
  word("limit").action(localWord("limit", gatewayKeyLimit));
  word("models").action(localWord("models", gatewayKeyModels));
  word("accounts").action(localWord("accounts", gatewayKeyAccounts));
  word("quotas").action(localWord("quotas", gatewayKeyQuotas));
  word("access").action(localWord("access", gatewayKeyAccess));
  word("move").action(localWord("move", gatewayKeyMove));
  word("issue").action(async (args: string[] | undefined, _options: unknown, cmd: Command) => {
    selectHome(cmd);
    await gatewayKeyIssue(args ?? [], jsonOf(cmd));
  });
  word("issuer").action(localWord("issuer", gatewayKeyIssuer));

  command.action(async (_options: unknown, cmd: Command) => {
    selectHome(cmd);
    await gatewayKeyList([], jsonOf(cmd));
  });

  return command;
}
