import { createHmac, randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "pino";
import { isRecord } from "./ir.js";
import type { GuardFound, LocalMaskingModel } from "../privacy/service.js";
import {
  foldStandIn,
  hintOf,
  ipStandIns,
  jsonEscape,
  replaceStandIn,
  shapeOf,
  splitNamedValue,
  standInOf,
} from "./mask-shape.js";

export const MASK_KEY_FILENAME = "gateway-mask-key";

const MAX_REMEMBERED_VALUES = 100_000;
/** The shortest value matched as already known; shorter ones are ordinary words. */
const KNOWN_MIN = 8;
const PLACEHOLDER_BODY = /[A-Za-z][A-Za-z0-9_]*_[0-9a-fA-F]{8}/g;

/** A kind the user turns on as a group, off until they do (myna's Categories). */
export type MaskCategory = "userhost" | "bucket";

/**
 * Whether a request to this provider is masked. The gateway's masking has to
 * be on, and the provider has to be one the user did not mark unredacted
 * (myna's per-provider Unredacted).
 */
export function masksRequests(
  provider: { unredacted?: boolean },
  maskingEnabled: boolean,
): boolean {
  return maskingEnabled && provider.unredacted !== true;
}

/**
 * Whether the masking settings ask for anything at all (myna's Wanted): Mask
 * secrets, Mask personal data, or the user's own words. A request may mask
 * words alone, with both switches off.
 */
export function maskingWanted(
  masking: { enabled?: boolean; personal?: boolean; words?: readonly string[] } | undefined,
): boolean {
  return (
    masking?.enabled === true || masking?.personal === true || (masking?.words?.length ?? 0) > 0
  );
}

/** Kinds of personal data, masked only while Mask personal data is on. */
const PERSONAL_KINDS = new Set([
  "EMAIL",
  "PHONE",
  "ID_CARD",
  "CARD",
  "IBAN",
  "SSN",
  "PASSPORT",
  "BIRTHDAY",
  "MAC",
  "SERIAL",
  "IP",
  "USERNAME",
  "HOSTNAME",
  "BUCKET",
]);

const ANY_CASE_WORDS = new Map<string, RegExp>();

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Adds every string of a JSON value to `out`, keys included. */
function collectStrings(value: unknown, out: Set<string>): void {
  if (typeof value === "string") {
    out.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectStrings(entry, out);
    }
    return;
  }
  if (isRecord(value)) {
    for (const entry of Object.values(value)) {
      collectStrings(entry, out);
    }
  }
}

/** Where a word is found at or after from, in any case when asked. */
function findWord(text: string, word: string, from: number, anyCase: boolean): number {
  if (!anyCase) {
    return text.indexOf(word, from);
  }
  let pattern = ANY_CASE_WORDS.get(word);
  if (pattern === undefined) {
    pattern = new RegExp(escapeRegExp(word), "gi");
    ANY_CASE_WORDS.set(word, pattern);
  }
  pattern.lastIndex = from;
  const match = pattern.exec(text);
  return match === null ? -1 : match.index;
}

const HAN_KANA = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

/** A letter, digit or _, but not a Han, Hiragana or Katakana character. */
function wordRune(char: string): boolean {
  if (char === "_") {
    return true;
  }
  if (!/[\p{L}\p{Nd}]/u.test(char)) {
    return false;
  }
  return !HAN_KANA.test(char);
}

function characterBefore(text: string, at: number): string {
  return Array.from(text.slice(0, at)).at(-1) ?? "";
}

function characterAt(text: string, at: number): string {
  return Array.from(text.slice(at))[0] ?? "";
}

/**
 * Whether the word at [start, end) is whole: no letter or digit touches it,
 * and a digit is not part of a decimal (myna's wholeWord: 123456 masks no
 * part of 0.123456 or 123456.78).
 */
function wholeWordAt(text: string, start: number, end: number): boolean {
  const first = characterAt(text, start);
  const last = characterBefore(text, end);
  if (wordRune(first) && start > 0) {
    const before = characterBefore(text, start);
    if (wordRune(before)) {
      return false;
    }
    if (/\p{Nd}/u.test(first) && before === ".") {
      if (/\p{Nd}/u.test(characterBefore(text, start - 1))) {
        return false;
      }
    }
  }
  if (wordRune(last) && end < text.length) {
    const after = characterAt(text, end);
    if (wordRune(after)) {
      return false;
    }
    if (/\p{Nd}/u.test(last) && after === ".") {
      if (/\p{Nd}/u.test(characterAt(text, end + 1))) {
        return false;
      }
    }
  }
  return true;
}

interface MaskRule {
  kind: string;
  pattern: RegExp;
  /** A built-in rule unless it is one the user wrote. */
  by?: "rule" | "yours";
  /** Masks only this capture group, keeping the name around it as written. */
  group?: number;
  /** Rejects a regex match that fails a check the value's form implies. */
  validate?: (match: string, text: string, start: number) => boolean;
  /** Set on the rules a category switch turns on; absent rules always run. */
  category?: MaskCategory;
}

export interface CustomMaskRule {
  kind: string;
  /** A prefix matches itself followed by 8+ key characters (myna's Rule). */
  prefix?: string;
  pattern: string;
  flags?: string;
}

const SECRET_NAME =
  "password|passwd|passphrase|secret|token|api[_-]?key|apikey|access[_-]?key|secret[_-]?key|private[_-]?key|auth[_-]?token|refresh[_-]?token|client[_-]?secret|credentials?";
const SECRET_VALUE = String.raw`[A-Za-z0-9_\-/+=~!@#%^&*.]{8,}`;
const VERSION_VALUE =
  /^(?:[~^]|[<>=!~]=?|==)?[vV]?\d+(?:\.\d+)+(?:[-+._]?(?:(?:alpha|beta|rc|pre|preview|post|dev|canary|next|nightly|snapshot|release|final|ga|stable|build|incubating)\d*|[abcm]\d+|\d+))*$/i;
const LINE_REF = /^L?\d+(?:[-–:]L?\d+)*[.,;:]?$/;
const PATH_VALUE =
  /^(?:~\/|\.\.?\/|[A-Za-z]:[\\/]|\/(?:Users|home|tmp|private|var|etc|run|opt|usr|mnt|Volumes|root|srv|nix)\/)/;

/** A month's name as a date writes it; the birthday rule is case-insensitive. */
const MONTHS = String.raw`(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?`;

const RULES: MaskRule[] = [
  {
    kind: "PRIVATE_KEY",
    pattern:
      /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----[\s\S]+?-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/g,
  },
  { kind: "API_KEY", pattern: /\bsk-(?:ant-|proj-|or-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g },
  { kind: "API_KEY", pattern: /\b[a-z]{2,4}_sk_[A-Za-z0-9_-]{20,}/g },
  { kind: "API_KEY", pattern: /\bark-[A-Za-z0-9][A-Za-z0-9_-]{15,}/g },
  {
    kind: "GITHUB_TOKEN",
    pattern:
      /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,})/g,
  },
  { kind: "API_KEY", pattern: /\bAIza[0-9A-Za-z_-]{35}/g },
  { kind: "SLACK_TOKEN", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g },
  { kind: "API_KEY", pattern: /\b(?:sk|rk)_live_[0-9A-Za-z]{20,}/g },
  { kind: "AWS_KEY", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  {
    kind: "API_KEY",
    pattern:
      /\b(?:hf_[A-Za-z0-9]{30,}|gsk_[A-Za-z0-9]{40,}|xai-[A-Za-z0-9]{40,}|npm_[A-Za-z0-9]{36}|pypi-[A-Za-z0-9_-]{50,}|dop_v1_[a-f0-9]{64}|SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43})/g,
  },
  { kind: "TOKEN", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  {
    kind: "PASSWORD",
    pattern: /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s:@/?#"'<>]*:([^\s@/?#"'<>]{3,})@/g,
    group: 1,
    validate: notAVariable,
  },
  {
    kind: "SECRET",
    pattern: new RegExp(
      String.raw`[A-Za-z0-9_.-]*(?:${SECRET_NAME})[A-Za-z0-9_.-]*["']?[ \t]*[:=][ \t]*["']?(${SECRET_VALUE})`,
      "gi",
    ),
    group: 1,
    validate: secretFieldValue,
  },
  {
    kind: "SECRET",
    pattern:
      /(?:^|[^A-Za-z0-9_.-])["']?key["']?[ \t]*[:=][ \t]*["']?([A-Za-z0-9_\-/+=~!@#%^&*.]{16,})/gi,
    group: 1,
    validate: secretFieldValue,
  },
  {
    // user@host as a shell prompt has it (user@host:~$, [user@host ~]$) or
    // as ssh, scp and rsync are given it.
    kind: "USERNAME",
    category: "userhost",
    group: 1,
    pattern:
      /(?:^|[^A-Za-z0-9._%+-])([a-z_][a-z0-9_.-]{0,31})@(?:[A-Za-z0-9][A-Za-z0-9-]{0,62}(?:\.[A-Za-z0-9-]{1,63})*)(?=:[~/]|:[ \t]*$|[ \t]+[~/]|[ \t]*[$%#>])/gm,
    validate: shellUser,
  },
  {
    kind: "HOSTNAME",
    category: "userhost",
    group: 1,
    pattern:
      /(?:^|[^A-Za-z0-9._%+-])[a-z_][a-z0-9_.-]{0,31}@([A-Za-z0-9][A-Za-z0-9-]{0,62}(?:\.[A-Za-z0-9-]{1,63})*)(?=:[~/]|:[ \t]*$|[ \t]+[~/]|[ \t]*[$%#>])/gm,
    validate: shellHost,
  },
  {
    kind: "USERNAME",
    category: "userhost",
    group: 1,
    pattern:
      /\b(?:ssh|scp|sftp|rsync|mosh|ssh-copy-id)\b[^\n@]{0,80}?[ \t"']([a-z_][a-z0-9_.-]{0,31})@/g,
    validate: shellUser,
  },
  {
    kind: "HOSTNAME",
    category: "userhost",
    group: 1,
    pattern:
      /\b(?:ssh|scp|sftp|rsync|mosh|ssh-copy-id)\b[^\n@]{0,80}?[ \t"'][a-z_][a-z0-9_.-]{0,31}@([A-Za-z0-9][A-Za-z0-9-]{0,62}(?:\.[A-Za-z0-9-]{1,63})*)/g,
    validate: shellHost,
  },
  {
    kind: "EMAIL",
    pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g,
    validate: realEmail,
  },
  {
    kind: "ID_CARD",
    pattern: /\b[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/g,
  },
  {
    kind: "PHONE",
    pattern: /(?:\+?86[- ]?)?1[3-9]\d{9}\b/g,
    validate: phoneValue,
  },
  { kind: "CARD", pattern: /\b(?:\d[ -]?){13,19}\b/g, validate: luhnValid },
  { kind: "IBAN", pattern: /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/g, validate: ibanValid },
  {
    kind: "IP",
    pattern:
      /(?<![\d.])(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}(?![\d.])/g,
    validate: ipValue,
  },
  {
    kind: "USERNAME",
    pattern: /(?:[/\\]Users[/\\]|\/home\/)([A-Za-z0-9_-](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?)/g,
    group: 1,
    validate: homeName,
  },
  {
    kind: "MAC",
    pattern:
      /(?<![0-9A-Fa-f:-])[0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5}(?![0-9A-Fa-f:])|\b[0-9A-Fa-f]{2}(?:-[0-9A-Fa-f]{2}){5}\b/g,
    validate: macValue,
  },
  {
    kind: "SSN",
    pattern:
      /(?:\bssn|\bsocial[ \t]+security(?:[ \t]+(?:number|no\.?|#))?)[ \t]*["']?[ \t]*(?:[:#=：][ \t]*)?(?:is[ \t]+)?["']?(\d{9}|\d{3} \d{2} \d{4})/gi,
    group: 1,
    validate: ssnValue,
  },
  { kind: "SSN", pattern: /\b\d{3}-\d{2}-\d{4}\b/g, validate: ssnValue },
  {
    kind: "PASSPORT",
    pattern:
      /(?:\bpassport(?:[ \t]*(?:no\.?|number|num|#))?|\breisepass(?:nummer)?)[ \t]*["']?[ \t]*(?:[:#=：][ \t]*)?(?:is[ \t]+|was[ \t]+)?["']?([A-Z0-9]{6,9})/gi,
    group: 1,
    validate: passportValue,
  },
  {
    kind: "PASSPORT",
    pattern:
      /(?:护照(?:号码|号)?|護照(?:號碼|号码|番号)?|パスポート(?:番号)?)[ \t]*(?:[:：=][ \t]*)?(?:是[ \t]*|は[ \t]*)?["']?([A-Z0-9]{6,9})/g,
    group: 1,
    validate: passportValue,
  },
  {
    kind: "BIRTHDAY",
    pattern: new RegExp(
      String.raw`(?:\bdate[ \t]+of[ \t]+birth|\bbirth[ \t_-]?date|\bbirthday|\bdob\b|\bd\.o\.b\.?|\bborn(?:[ \t]+on)?|\bgeburtsdatum|\bgeboren(?:[ \t]+am)?|生日|出生日期|出生年月日|出生于|出生於|出生|誕生日|生年月日)[ \t]*["']?[ \t]*(?:[:#=：][ \t]*)?(?:is[ \t]+|was[ \t]+|是[ \t]*|为[ \t]*|為[ \t]*|は[ \t]*)?["']?` +
        String.raw`(\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{4}[ \t]*年[ \t]*\d{1,2}[ \t]*月[ \t]*\d{1,2}[ \t]*日?|\d{1,2}[-/.]\d{1,2}[-/.]\d{4}` +
        String.raw`|${MONTHS}[ \t]+\d{1,2}(?:st|nd|rd|th)?,?[ \t]+\d{4}|\d{1,2}(?:st|nd|rd|th)?[ \t]+${MONTHS},?[ \t]+\d{4})`,
      "gi",
    ),
    group: 1,
    validate: birthdayValue,
  },
  {
    kind: "SERIAL",
    pattern:
      /(?:\bserial[ \t_-]?(?:number|num|no\.?|#)?|\bs\/n|\bsn)(?:[ \t]*\([^)\n]{1,20}\))?["']?[ \t]*[:#=：][ \t]*["']?([A-Za-z0-9][A-Za-z0-9-]{4,39})/gi,
    group: 1,
    validate: serialValue,
  },
  {
    kind: "SERIAL",
    pattern:
      // Inline flag groups ((?i:...)) need Node 23+; spell out the case classes so
      // the daemon still loads on the supported Node 22 runtime.
      /(?:序列号|序列號|シリアル番号|[Ss][Ee][Rr][Ii][Ee][Nn][Nn][Uu][Mm][Mm][Ee][Rr])[ \t]*[:：=]?[ \t]*["']?([A-Za-z0-9][A-Za-z0-9-]{4,39})/g,
    group: 1,
    validate: serialValue,
  },
  { kind: "BEARER_TOKEN", pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/gi },
  {
    kind: "HOSTNAME",
    category: "userhost",
    group: 1,
    pattern:
      /(?:^|\n)[ \t]*["']?(?:host[ \t_-]?name|computer[ \t_-]?name|machine[ \t_-]?name|device[ \t_-]?name|主机名|主機名|計算機名|コンピュータ名|コンピューター名)["']?[ \t]*[:=：][ \t]*["']?([A-Za-z0-9][A-Za-z0-9-]{0,62}(?:\.[A-Za-z0-9-]{1,63})*)["']?[ \t]*$/gim,
    validate: lineHost,
  },
  {
    kind: "HOSTNAME",
    category: "userhost",
    group: 1,
    pattern:
      /^[ \t]+HostName[ \t]+([A-Za-z0-9][A-Za-z0-9-]{0,62}(?:\.[A-Za-z0-9-]{1,63})*)[ \t]*$/gm,
    validate: lineHost,
  },
  {
    kind: "USERNAME",
    category: "userhost",
    group: 1,
    pattern:
      /(?:^|\n)[ \t]*["']?(?:user[ \t_-]?name|login[ \t_-]?name|user|login|logname|用户名|用戶名|ユーザー名)["']?[ \t]*[:=：][ \t]*["']?([A-Za-z0-9_][A-Za-z0-9._-]{0,31})["']?[ \t]*$/gim,
    validate: lineUser,
  },
  {
    kind: "USERNAME",
    category: "userhost",
    group: 1,
    pattern: /^[ \t]+User[ \t]+([A-Za-z0-9_][A-Za-z0-9._-]{0,31})[ \t]*$/gm,
    validate: lineUser,
  },
  {
    kind: "BUCKET",
    category: "bucket",
    group: 1,
    pattern:
      /\b(?:s3a?|s3n|gs|oss|cosn?|obs|r2|ks3|bos|tos|az|azure|wasbs?|abfss?):\/\/([A-Za-z0-9](?:[A-Za-z0-9._-]{0,61}[A-Za-z0-9])?)/gi,
    validate: bucketValue,
  },
  {
    kind: "BUCKET",
    category: "bucket",
    group: 1,
    pattern:
      /(?:^|[^A-Za-z0-9.-])([a-z0-9](?:[a-z0-9.-]{0,61}[a-z0-9])?)\.(?:s3(?:[.-](?:dualstack\.)?[a-z0-9-]+)?\.amazonaws\.com(?:\.cn)?|storage\.googleapis\.com|oss-[a-z0-9-]+\.aliyuncs\.com|cos\.[a-z0-9-]+\.myqcloud\.com|obs\.[a-z0-9-]+\.myhuaweicloud\.com|r2\.cloudflarestorage\.com|(?:blob|dfs)\.core\.windows\.net|[a-z0-9-]+\.digitaloceanspaces\.com|tos-[a-z0-9-]+\.volces\.com)/g,
    validate: bucketValue,
  },
  {
    kind: "BUCKET",
    category: "bucket",
    group: 1,
    pattern:
      /(?:^|[^A-Za-z0-9.-])(?:s3(?:[.-](?:dualstack\.)?[a-z0-9-]+)?\.amazonaws\.com(?:\.cn)?|storage\.googleapis\.com|storage\.cloud\.google\.com|[a-z0-9]{3,24}\.blob\.core\.windows\.net|oss-[a-z0-9-]+\.aliyuncs\.com|[a-z0-9-]+\.digitaloceanspaces\.com)\/([A-Za-z0-9](?:[A-Za-z0-9._-]{0,61}[A-Za-z0-9])?)/g,
    validate: bucketValue,
  },
];

export type MaskAction = "mask" | "warn" | "block";

/** One value found: never the value itself, only its kind and shape. */
export interface MaskHit {
  kind: string;
  /** A built-in rule, one the user wrote in the settings, or the local model. */
  by: "rule" | "yours" | "model";
  placeholder: string;
  head: string;
  length: number;
  action?: MaskAction;
}

export interface MaskedText {
  text: string;
  hits: MaskHit[];
  /** A found value was set to block: the caller must not send the request. */
  blocked: boolean;
}

export interface MaskedValue {
  value: unknown;
  hits: MaskHit[];
  blocked: boolean;
}

export interface MaskerOptions {
  neolixHome: string;
  logger: Logger;
  /** Read on every match so a config reload takes effect without a restart. */
  allow: () => readonly string[];
  categories?: () => readonly string[];
  rules?: () => readonly CustomMaskRule[];
  /** What each kind does; a kind absent from it is masked. */
  actions?: () => Readonly<Record<string, MaskAction>>;
  /** Send a key as a made-up key of its form rather than a placeholder. */
  shape?: () => boolean;
  /** The opt-in categories that are on; an absent one is off (myna's default). */
  categorySwitches?: () => Readonly<Record<string, boolean>>;
  /** Whether the built-in rules and the user's rules run (Mask secrets). */
  secrets?: () => boolean;
  /**
   * Whether the personal-data kinds run (Mask personal data, myna's
   * redactPersonal). Off, none of them masks, whatever their own switch says;
   * words and the user's rules do not depend on it. Defaults on for the same
   * reason as `secrets`: the gateway config, not the masker, is off by default.
   */
  personal?: () => boolean;
  /** The user's own words, masked as written unless anyCase says otherwise. */
  words?: () => readonly string[];
  /** A word also matches in other capitals (myna's redactWordsAnyCase). */
  wordsAnyCase?: () => boolean;
  /** A word is not masked inside a longer one (myna's redactWordsWhole). */
  wordsWhole?: () => boolean;
  /**
   * The local model that finds what the rules can't (myna's pii.Model), or
   * null when the settings say it is off. `prime` asks it before a text is
   * masked; a model that fails holds the request back.
   */
  localModel?: () => LocalMaskingModel | null;
  /** The score the model's finds need (0.5–0.95; 0.8 when none). */
  localModelScore?: () => number | undefined;
}

/** The local model couldn't read a request: nothing may be sent. */
export class MaskingUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MaskingUnavailableError";
  }
}

/** The score a model find needs when the settings set none (myna's MinScore). */
const MODEL_DEFAULT_SCORE = 0.8;
/** How many texts' model finds are kept before the table is cleared. */
const MODEL_FOUND_LIMIT = 20_000;

/** How often a value was put back in a reply, by the stand-in that carried it. */
export type RestoreCounts = Map<string, number>;

/**
 * Replaces values with stable stand-ins before a request leaves the machine
 * and puts them back in the reply.
 *
 * A key goes as a made-up key of the same form (myna's `shape.go`), a user
 * name as eight letters, an address as `public-ip-xxxxxxxx`, and anything
 * else as `{{KIND_hash}}`. They are derived from an HMAC key persisted in
 * `$NEOLIX_HOME`, so one value keeps its stand-in across restarts. Values
 * live in memory only; nothing masked is written to a record or the usage
 * ledger.
 */
export class Masker {
  public readonly keyPath: string;

  private key: Buffer | null = null;
  /** What a stand-in or placeholder stood for, while this process runs. */
  private readonly tokenToValue = new Map<string, string>();
  /** The stand-in one kind and value go as, so a repeat is the same. */
  private readonly valueToToken = new Map<string, string>();
  /** A stand-in's kind, for the ones put back in any case or whole. */
  private readonly tokenKinds = new Map<string, string>();
  private readonly allowValues: () => readonly string[];
  private readonly logger: Logger;
  private readonly categories: () => readonly string[];
  private readonly customRules: () => readonly CustomMaskRule[];
  private readonly actionValues: () => Readonly<Record<string, MaskAction>>;
  private readonly shapeValues: () => boolean;
  private readonly categoryValues: () => Readonly<Record<string, boolean>>;
  private readonly secretsValues: () => boolean;
  private readonly personalValues: () => boolean;
  private readonly wordValues: () => readonly string[];
  private readonly wordCase: () => boolean;
  private readonly wordWhole: () => boolean;
  private readonly localModelValues: () => LocalMaskingModel | null;
  private readonly localModelScore: () => number | undefined;
  /** What the local model found, by the text it read (`prime`). */
  private readonly modelFound = new Map<string, readonly GuardFound[]>();
  private readonly compiled = new Map<string, RegExp | null>();

  constructor(options: MaskerOptions) {
    this.keyPath = path.join(options.neolixHome, MASK_KEY_FILENAME);
    this.allowValues = options.allow;
    this.logger = options.logger;
    this.categories = options.categories ?? (() => []);
    this.customRules = options.rules ?? (() => []);
    this.actionValues = options.actions ?? (() => ({}));
    this.shapeValues = options.shape ?? (() => false);
    this.categoryValues = options.categorySwitches ?? (() => ({}));
    this.secretsValues = options.secrets ?? (() => true);
    this.personalValues = options.personal ?? (() => true);
    this.wordValues = options.words ?? (() => []);
    this.wordCase = options.wordsAnyCase ?? (() => false);
    this.wordWhole = options.wordsWhole ?? (() => false);
    this.localModelValues = options.localModel ?? (() => null);
    this.localModelScore = options.localModelScore ?? (() => undefined);
  }

  public async ensureKey(): Promise<void> {
    if (this.key !== null) {
      return;
    }
    try {
      const stored = (await readFile(this.keyPath, "utf8")).trim();
      if (/^[0-9a-f]{64}$/.test(stored)) {
        this.key = Buffer.from(stored, "hex");
        return;
      }
    } catch {
      // Missing key is expected on first run.
    }
    const generated = randomBytes(32);
    this.key = generated;
    try {
      await writeFile(this.keyPath, generated.toString("hex"), { mode: 0o600 });
    } catch (error) {
      this.logger.error({ err: error, file: this.keyPath }, "Cannot persist LLM gateway mask key");
    }
  }

  /** Masks every string inside a JSON value. */
  public maskValue(value: unknown): unknown {
    return this.maskValueWithHits(value).value;
  }

  /**
   * Asks the local model about the strings inside `value` before they are
   * masked. A request is primed first, then masked: the model is async, and
   * masking stays sync. A model that is on but failed throws, so the caller
   * holds the request back rather than sending it with the rules alone
   * (myna's `masking.Model` when the user turned the model on).
   */
  public async prime(value: unknown): Promise<void> {
    const model = this.localModelValues();
    if (model === null) {
      return;
    }
    // The user turned the model on: a request it can't read is held back
    // rather than sent with the rules alone (myna's `masking.Model` in the
    // strict case). Turning it on starts the download in the settings page.
    if (!(await model.installed())) {
      throw new MaskingUnavailableError(
        "the local masking model isn't downloaded; download it in Settings → Model gateway → Masking, or turn it off",
      );
    }
    const texts = new Set<string>();
    collectStrings(value, texts);
    // Two characters can be a whole Chinese name; the model reads every
    // non-empty string, as myna's does.
    const ask = [...texts].filter((text) => text !== "" && !this.modelFound.has(text));
    if (ask.length === 0) {
      return;
    }
    let found: GuardFound[][];
    try {
      found = await model.find(ask);
    } catch (error) {
      throw new MaskingUnavailableError(error instanceof Error ? error.message : String(error));
    }
    if (this.modelFound.size + ask.length > MODEL_FOUND_LIMIT) {
      this.modelFound.clear();
    }
    for (let index = 0; index < ask.length; index += 1) {
      const text = ask[index];
      if (text !== undefined) {
        this.modelFound.set(text, found[index] ?? []);
      }
    }
  }

  /** Masks every string inside a JSON value, telling what was found. */
  public maskValueWithHits(value: unknown): MaskedValue {
    const hits: MaskHit[] = [];
    let blocked = false;
    const walk = (entry: unknown): unknown => {
      if (typeof entry === "string") {
        const masked = this.maskTextWithHits(entry);
        hits.push(...masked.hits);
        blocked = blocked || masked.blocked;
        return masked.text;
      }
      if (Array.isArray(entry)) {
        return entry.map((item) => walk(item));
      }
      if (isRecord(entry)) {
        return Object.fromEntries(Object.entries(entry).map(([key, item]) => [key, walk(item)]));
      }
      return entry;
    };
    return { value: walk(value), hits, blocked };
  }

  /**
   * Puts every stand-in back in a JSON value. A tool call's `arguments` is
   * itself JSON text, so a value goes back into it escaped.
   */
  public restoreValue(value: unknown, counts?: RestoreCounts): unknown {
    if (typeof value === "string") {
      return this.restoreText(value, counts);
    }
    if (Array.isArray(value)) {
      return value.map((entry) => this.restoreValue(entry, counts));
    }
    if (isRecord(value)) {
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [
          key,
          typeof entry === "string" && key === "arguments"
            ? this.restoreText(entry, counts, true)
            : this.restoreValue(entry, counts),
        ]),
      );
    }
    return value;
  }

  public maskText(text: string): string {
    return this.maskTextWithHits(text).text;
  }

  /**
   * Masks one text and tells what was found. `remember: false` (the settings
   * preview) computes stand-ins without keeping any value in memory.
   *
   * A warn or block hit is held out of the following rules under a sentinel
   * and put back at the end: leaving the original in place let a later rule
   * match part of the same value again.
   */
  public maskTextWithHits(text: string, options: { remember?: boolean } = {}): MaskedText {
    const remember = options.remember !== false;
    const hits: MaskHit[] = [];
    const putBack = new Map<string, string>();
    let blocked = false;
    let sentinels = 0;
    let result = text;
    // The model's spans go in before the rules, so a rule's value keeps its
    // kind where both find it (`ruleCovers`): they were computed on the raw
    // text, and their offsets are valid only there.
    const modelHits: MaskHit[] = [];
    result = this.maskModel(result, modelHits, remember, putBack);
    // A value masked once is masked again wherever it is: a later turn's
    // history has it with no rule's context around it (myna's known.go).
    result = this.maskKnown(result, hits);
    for (const rule of this.activeRules()) {
      const pattern = ensureGlobal(rule.pattern);
      pattern.lastIndex = 0;
      for (let match = pattern.exec(result); match !== null; match = pattern.exec(result)) {
        if (match[0].length === 0) {
          pattern.lastIndex += 1;
          continue;
        }
        let value = match[0];
        let start = match.index;
        if (rule.group !== undefined) {
          const grouped = match[rule.group];
          if (grouped === undefined || grouped.length === 0) {
            continue;
          }
          const relative = match[0].indexOf(grouped);
          if (relative < 0) {
            continue;
          }
          value = grouped;
          start += relative;
        }
        if (this.insideToken(result, start, start + value.length)) {
          pattern.lastIndex = start + value.length;
          continue;
        }
        if (rule.validate !== undefined && !rule.validate(value, result, start)) {
          continue;
        }
        if (this.isAllowed(value)) {
          continue;
        }
        const action = this.actionFor(rule.kind);
        const token =
          action === "mask"
            ? this.tokenFor(rule.kind, value, remember)
            : this.buildPlaceholder(rule.kind, value);
        const shape = hintOf(rule.kind, value);
        hits.push({
          kind: rule.kind,
          by: rule.by ?? "rule",
          placeholder: token,
          head: shape.head,
          length: shape.length,
          ...(action === "mask" ? {} : { action }),
        });
        let replacement = token;
        if (action !== "mask") {
          if (action === "block") {
            blocked = true;
          }
          const sentinel = `\u0000mask-${sentinels}\u0000`;
          sentinels += 1;
          putBack.set(sentinel, value);
          replacement = sentinel;
        }
        result = result.slice(0, start) + replacement + result.slice(start + value.length);
        pattern.lastIndex = start + replacement.length;
      }
    }
    // The user's own words go after the rules, so a key or an address a rule
    // knows keeps its kind where a word would also match part of it.
    result = this.maskWords(result, hits, remember);
    for (const [sentinel, value] of putBack) {
      result = result.split(sentinel).join(value);
    }
    hits.push(...modelHits);
    return { text: result, hits, blocked };
  }

  /** Text as a request would go out now, remembering none of it. */
  public preview(text: string): MaskedText {
    return this.maskTextWithHits(text, { remember: false });
  }

  /**
   * Masks the local model's spans in a raw text, before the rules run. A
   * span whose value a rule or one of the user's words also finds is left
   * for that finder, so a rule's kind keeps precedence (myna's `apply`
   * appends the model's spans after the rules').
   */
  private maskModel(
    text: string,
    hits: MaskHit[],
    remember: boolean,
    putBack: Map<string, string>,
  ): string {
    if (this.localModelValues() === null) {
      return text;
    }
    const found = this.modelFound.get(text);
    if (found === undefined || found.length === 0) {
      return text;
    }
    const personal = this.personalValues();
    const secrets = this.secretsValues();
    const min = Math.max(0.5, this.localModelScore() ?? MODEL_DEFAULT_SCORE);
    const spans = found
      .filter((span) => {
        if (span.score < min || span.start < 0 || span.end > text.length) {
          return false;
        }
        return span.kind === "SECRET" ? secrets : personal;
      })
      .sort((left, right) => right.start - left.start);
    let out = text;
    for (const span of spans) {
      let start = span.start;
      let end = span.end;
      const edge = (char: string): boolean =>
        span.kind === "SECRET" ? /\s/u.test(char) : /[\s"',;:]/u.test(char);
      while (start < end && edge(out[start] ?? "")) {
        start += 1;
      }
      while (end > start && edge(out[end - 1] ?? "")) {
        end -= 1;
      }
      if (start >= end) {
        continue;
      }
      const value = out.slice(start, end);
      if (this.isAllowed(value) || this.ruleCovers(value)) {
        continue;
      }
      const action = this.actionFor(span.kind);
      const token =
        action === "mask"
          ? this.tokenFor(span.kind, value, remember)
          : this.buildPlaceholder(span.kind, value);
      const shape = hintOf(span.kind, value);
      hits.push({
        kind: span.kind,
        by: "model",
        placeholder: token,
        head: shape.head,
        length: shape.length,
        ...(action === "mask" ? {} : { action }),
      });
      let replacement = token;
      if (action !== "mask") {
        const sentinel = `\u0000mask-model-${putBack.size}\u0000`;
        putBack.set(sentinel, value);
        replacement = sentinel;
      }
      out = out.slice(0, start) + replacement + out.slice(end);
    }
    return out;
  }

  /** Whether a rule or one of the user's words would mask `value` itself. */
  private ruleCovers(value: string): boolean {
    for (const rule of this.activeRules()) {
      const pattern = ensureGlobal(rule.pattern);
      pattern.lastIndex = 0;
      const match = pattern.exec(value);
      if (match === null) {
        continue;
      }
      if (rule.group !== undefined && (match[rule.group] ?? "").length === 0) {
        continue;
      }
      if (rule.validate !== undefined && !rule.validate(match[0], value, match.index)) {
        continue;
      }
      return true;
    }
    const anyCase = this.wordCase();
    const whole = this.wordWhole();
    for (const raw of this.wordValues()) {
      const word = raw.trim();
      if (word.length < 2) {
        continue;
      }
      const at = findWord(value, word, 0, anyCase);
      if (at < 0) {
        continue;
      }
      if (!whole || wholeWordAt(value, at, at + word.length)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Masks the user's own words: as written, or in any case, and only as
   * whole words where asked (myna's RedactWords, anyCase and whole).
   *
   * debt: myna also matches a word that is a date however the date is
   * written (dateword.go); here it is matched as written.
   */
  private maskWords(text: string, hits: MaskHit[], remember: boolean): string {
    let out = text;
    const anyCase = this.wordCase();
    const whole = this.wordWhole();
    for (const raw of this.wordValues()) {
      const word = raw.trim();
      if (word.length < 2) {
        continue;
      }
      let from = 0;
      for (;;) {
        const at = findWord(out, word, from, anyCase);
        if (at < 0) {
          break;
        }
        const end = at + word.length;
        if ((whole && !wholeWordAt(out, at, end)) || this.insideToken(out, at, end)) {
          from = at + 1;
          continue;
        }
        const value = out.slice(at, end);
        if (this.isAllowed(value)) {
          from = end;
          continue;
        }
        const token = this.tokenFor("TERM", value, remember);
        const shape = hintOf("TERM", value);
        hits.push({
          kind: "TERM",
          by: "yours",
          placeholder: token,
          head: shape.head,
          length: shape.length,
        });
        out = out.slice(0, at) + token + out.slice(end);
        from = at + token.length;
      }
    }
    return out;
  }

  /**
   * Masks values this process already masked, wherever they stand, by the
   * stand-in they went as. Myna's rule is the same and bounds it the same
   * way: a value shorter than eight characters turns up in ordinary text.
   *
   * debt: every remembered value is scanned once per text; myna indexes
   * their first bytes. Move to a prefix index if a long-lived daemon with
   * many values shows masking latency.
   */
  private maskKnown(text: string, hits: MaskHit[]): string {
    let out = text;
    for (const [token, value] of this.tokenToValue) {
      if (value.length < KNOWN_MIN) {
        continue;
      }
      let at = out.indexOf(value);
      if (at < 0) {
        continue;
      }
      const kind = this.tokenKinds.get(token) ?? "SECRET";
      const shape = hintOf(kind, value);
      let last = 0;
      let found = 0;
      let next = "";
      while (at >= 0) {
        if (this.insideToken(out, at, at + value.length)) {
          at = out.indexOf(value, at + 1);
          continue;
        }
        next += out.slice(last, at) + token;
        last = at + value.length;
        found += 1;
        at = out.indexOf(value, last);
      }
      if (found === 0) {
        continue;
      }
      out = next + out.slice(last);
      for (let index = 0; index < found; index += 1) {
        hits.push({
          kind,
          by: "rule",
          placeholder: token,
          head: shape.head,
          length: shape.length,
        });
      }
    }
    return out;
  }

  /** A match inside a stand-in or placeholder already in the text is left be. */
  private insideToken(text: string, start: number, end: number): boolean {
    const open = text.lastIndexOf("{{", start);
    if (open >= 0) {
      const close = text.indexOf("}}", open);
      if (close >= 0 && close + 2 >= end) {
        return true;
      }
    }
    for (const token of this.tokenKinds.keys()) {
      if (token.startsWith("{{")) {
        continue;
      }
      for (let at = text.indexOf(token); at >= 0; at = text.indexOf(token, at + 1)) {
        if (at <= start && at + token.length >= end) {
          return true;
        }
      }
    }
    return false;
  }

  private isAllowed(value: string): boolean {
    return this.allowValues().some((entry) => entry.toLowerCase() === value.toLowerCase());
  }

  private actionFor(kind: string): MaskAction {
    const actions = this.actionValues();
    return actions[kind] ?? actions[kind.toUpperCase()] ?? "mask";
  }

  /** Built-ins narrowed by `categories`, then the config's own patterns. */
  private activeRules(): MaskRule[] {
    const categories = this.categories();
    const switches = this.categoryValues();
    const secrets = this.secretsValues();
    const personal = this.personalValues();
    // With Mask secrets off, only the user's words and (with Mask personal
    // data on) the personal kinds mask; with Mask personal data off, none of
    // them does, whatever its own switch says (myna's Options.covers).
    const builtIns = RULES.filter((rule) => {
      if (!(PERSONAL_KINDS.has(rule.kind) ? personal : secrets)) {
        return false;
      }
      if (categories.length > 0 && !categories.includes(rule.kind)) {
        return false;
      }
      // A kind's own switch wins over its group's; an absent one is on, or
      // for an opt-in group off (myna's RedactKinds over Categories).
      const chosen = switches[rule.kind.toLowerCase()];
      if (chosen !== undefined) {
        return chosen;
      }
      return rule.category === undefined || switches[rule.category] === true;
    });
    const custom: MaskRule[] = [];
    if (secrets) {
      for (const rule of this.customRules()) {
        const pattern = this.compile(rule);
        if (pattern !== null) {
          custom.push({ kind: rule.kind, pattern, by: "yours" });
        }
      }
    }
    return [...builtIns, ...custom];
  }

  private compile(rule: CustomMaskRule): RegExp | null {
    const prefix = rule.prefix?.trim() ?? "";
    const source =
      prefix === ""
        ? rule.pattern
        : `${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[A-Za-z0-9_\\-]{8,}`;
    if (source.length === 0) {
      return null;
    }
    const key = `${source}\u0000${rule.flags ?? ""}`;
    const cached = this.compiled.get(key);
    if (cached !== undefined) {
      return cached;
    }
    let pattern: RegExp | null = null;
    try {
      pattern = new RegExp(source, rule.flags?.replace(/[^gimsuy]/g, "") ?? "");
      if (!pattern.global) {
        pattern = new RegExp(source, `${rule.flags ?? ""}g`.replace(/[^gimsuy]/g, ""));
      }
    } catch (error) {
      this.logger.warn({ err: error, kind: rule.kind }, "Ignoring an invalid masking rule");
    }
    this.compiled.set(key, pattern);
    return pattern;
  }

  /**
   * Puts stand-ins and placeholders back, counting each in `counts` when
   * given. `escaped` is for text that is itself JSON (tool arguments).
   */
  public restoreText(text: string, counts?: RestoreCounts, escaped = false): string {
    let out = this.restoreStandIns(text, counts, escaped);
    out = this.restorePlaceholders(out, counts, escaped);
    return out;
  }

  private restoreStandIns(
    text: string,
    counts: RestoreCounts | undefined,
    escaped: boolean,
  ): string {
    let out = text;
    for (const [token, kind] of this.tokenKinds) {
      const value = this.tokenToValue.get(token);
      if (value === undefined || token.startsWith("{{")) {
        continue;
      }
      const replacement = escaped ? jsonEscape(value) : value;
      if (foldStandIn(kind)) {
        out = replaceStandIn(out, token, replacement, kind, counts);
        continue;
      }
      if (!out.includes(token)) {
        continue;
      }
      const count = out.split(token).length - 1;
      out = out.split(token).join(replacement);
      if (counts !== undefined) {
        counts.set(token, (counts.get(token) ?? 0) + count);
      }
    }
    return out;
  }

  private restorePlaceholders(
    text: string,
    counts: RestoreCounts | undefined,
    escaped: boolean,
  ): string {
    let out = "";
    let last = 0;
    for (const match of text.matchAll(PLACEHOLDER_BODY)) {
      const body = match[0];
      const start = match.index;
      const end = start + body.length;
      if (start < last) {
        continue;
      }
      if (start > 0 && isWordByte(text[start - 1] ?? "")) {
        continue;
      }
      if (end < text.length && isWordByte(text[end] ?? "")) {
        continue;
      }
      const canonical = canonicalPlaceholder(body);
      const value = this.tokenToValue.get(canonical);
      if (value === undefined) {
        continue;
      }
      const widened = braces(text, start, end);
      if (widened.start < last) {
        continue;
      }
      out += text.slice(last, widened.start);
      out += escaped ? jsonEscape(value) : value;
      last = widened.end;
      if (counts !== undefined) {
        counts.set(canonical, (counts.get(canonical) ?? 0) + 1);
      }
    }
    if (last === 0) {
      return text;
    }
    return out + text.slice(last);
  }

  private tokenFor(kind: string, value: string, remember: boolean): string {
    const memo = `${kind}\u0000${value}`;
    const existing = this.valueToToken.get(memo);
    if (existing !== undefined) {
      return existing;
    }
    const { name, rest } = splitNamedValue(value);
    const shaped = this.standInFor(kind, rest);
    if (shaped !== null) {
      const token = name + shaped;
      if (remember) {
        this.remember(shaped, rest, kind, memo, token);
      }
      return token;
    }
    const placeholder = this.buildPlaceholder(kind, value);
    if (remember) {
      this.remember(placeholder, value, kind, memo, placeholder);
    }
    return placeholder;
  }

  /** The made-up value `value` goes as, when one may stand for it. */
  private standInFor(kind: string, value: string): string | null {
    if (this.key === null) {
      return null;
    }
    if (kind === "USERNAME") {
      const candidate = standInOf(this.key, value);
      return candidate !== value && this.available(candidate, value) ? candidate : null;
    }
    if (kind === "IP") {
      for (const candidate of ipStandIns(this.key, value) ?? []) {
        if (this.available(candidate, value)) {
          return candidate;
        }
      }
      return null;
    }
    if (!this.shapeValues()) {
      return null;
    }
    const candidate = shapeOf(this.key, kind, value);
    return candidate !== null && this.available(candidate, value) ? candidate : null;
  }

  private available(token: string, value: string): boolean {
    const taken = this.tokenToValue.get(token);
    return taken === undefined || taken === value;
  }

  private remember(
    token: string,
    value: string,
    kind: string,
    memo: string,
    displayToken: string,
  ): void {
    this.valueToToken.set(memo, displayToken);
    if (this.tokenToValue.get(token) === undefined) {
      this.tokenToValue.set(token, value);
      this.tokenKinds.set(token, kind);
    }
    if (this.tokenToValue.size > MAX_REMEMBERED_VALUES) {
      const oldest = this.tokenToValue.keys().next();
      if (!oldest.done) {
        this.tokenToValue.delete(oldest.value);
        this.tokenKinds.delete(oldest.value);
      }
    }
  }

  public createRestorer(
    options: { escaped?: boolean; counts?: RestoreCounts } = {},
  ): StreamRestorer {
    return new StreamRestorer(
      (text) => this.restoreText(text, options.counts, options.escaped === true),
      (text) => this.partialTail(text),
    );
  }

  /**
   * How much of the end of `text` may be the start of a stand-in or
   * placeholder the next chunk finishes.
   */
  private partialTail(text: string): number {
    const brace = openBraceIndex(text);
    if (brace < text.length) {
      return brace;
    }
    let best = 0;
    const lower = text.toLowerCase();
    for (const [token, kind] of this.tokenKinds) {
      const fold = foldStandIn(kind);
      const hay = fold ? lower : text;
      const needle = fold ? token.toLowerCase() : token;
      const limit = Math.min(needle.length - 1, hay.length);
      for (let size = limit; size > best; size -= 1) {
        if (hay.endsWith(needle.slice(0, size))) {
          best = size;
          break;
        }
      }
    }
    // A placeholder body the model writes without braces, up to its 8 hash
    // characters that may still come.
    const body = /([A-Za-z][A-Za-z0-9_]*_[0-9a-fA-F]{0,8})$/.exec(text)?.[1];
    if (body !== undefined && body.length > best) {
      for (const token of this.tokenToValue.keys()) {
        if (!token.startsWith("{{")) {
          continue;
        }
        if (placeholderStarts(token.slice(2, -2), body)) {
          best = body.length;
          break;
        }
      }
    }
    return text.length - best;
  }

  private buildPlaceholder(kind: string, value: string): string {
    if (this.key === null) {
      throw new Error("Masker key is not loaded");
    }
    const digest = createHmac("sha256", this.key).update(`${kind}\u0000${value}`).digest("hex");
    return `{{${kind}_${digest.slice(0, 8)}}}`;
  }
}

/**
 * Restores stand-ins in a text stream. One split across chunks is held back
 * until it completes, so the client never sees half a stand-in.
 */
export class StreamRestorer {
  private pending = "";
  private readonly restore: (text: string) => string;
  private readonly hold: (text: string) => number;

  constructor(restore: (text: string) => string, hold?: (text: string) => number) {
    this.restore = restore;
    this.hold = hold ?? openBraceIndex;
  }

  public push(text: string): string {
    if (text.length === 0) {
      return "";
    }
    this.pending += text;
    const cut = this.hold(this.pending);
    const ready = this.pending.slice(0, cut);
    this.pending = this.pending.slice(cut);
    return this.restore(ready);
  }

  public flush(): string {
    const ready = this.restore(this.pending);
    this.pending = "";
    return ready;
  }
}

function canonicalPlaceholder(body: string): string {
  const kind = body.slice(0, -9);
  const hash = body.slice(-8);
  return `{{${kind.toUpperCase()}_${hash.toLowerCase()}}}`;
}

function placeholderStarts(body: string, prefix: string): boolean {
  const kind = body.slice(0, -9);
  const hash = body.slice(-8);
  if (prefix.length <= kind.length) {
    return kind.toLowerCase().startsWith(prefix.toLowerCase());
  }
  if (!kind.toLowerCase().startsWith(prefix.slice(0, kind.length).toLowerCase())) {
    return false;
  }
  const rest = prefix.slice(kind.length);
  return rest.startsWith("_") && hash.toLowerCase().startsWith(rest.slice(1).toLowerCase());
}

function isWordByte(character: string): boolean {
  return /^[A-Za-z0-9_]$/.test(character);
}

/** Widens a placeholder body over braces and spaces a model wrote around it. */
function braces(text: string, start: number, end: number): { start: number; end: number } {
  let left = start;
  let leftBraces = 0;
  while (left > 0 && (text[left - 1] === " " || text[left - 1] === "\t")) {
    left -= 1;
  }
  while (leftBraces < 2 && left > 0 && text[left - 1] === "{") {
    left -= 1;
    leftBraces += 1;
  }
  let right = end;
  let rightBraces = 0;
  while (right < text.length && (text[right] === " " || text[right] === "\t")) {
    right += 1;
  }
  while (rightBraces < 2 && right < text.length && text[right] === "}") {
    right += 1;
    rightBraces += 1;
  }
  return {
    start: leftBraces === 2 || (leftBraces === 1 && rightBraces >= 1) ? left : start,
    end: rightBraces === 2 || (rightBraces === 1 && leftBraces >= 1) ? right : end,
  };
}

function openBraceIndex(text: string): number {
  const open = text.lastIndexOf("{{");
  if (open >= 0 && text.indexOf("}}", open) < 0) {
    return open;
  }
  if (text.endsWith("{")) {
    return text.length - 1;
  }
  return text.length;
}

function ensureGlobal(pattern: RegExp): RegExp {
  if (pattern.global) {
    return pattern;
  }
  return new RegExp(pattern.source, `${pattern.flags}g`);
}

const ASSET_TLDS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "ico",
  "mp4",
  "mov",
  "zip",
  "js",
  "ts",
  "json",
  "css",
  "html",
  "xml",
  "yml",
  "yaml",
  "md",
  "txt",
  "pdf",
  "map",
  "lock",
  "woff",
  "woff2",
  "ttf",
  "eot",
]);

function realEmail(value: string): boolean {
  // git@github.com:owner/repo is every git remote, not an address.
  if (/^git@/i.test(value)) {
    return false;
  }
  const tld = value.slice(value.lastIndexOf(".") + 1).toLowerCase();
  return !ASSET_TLDS.has(tld);
}

function notAVariable(value: string): boolean {
  return (
    !value.includes("(") &&
    !/^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z0-9_.]+$/.test(value) &&
    !/^(?:get|set|is|has|max|min|read|write|fetch|create|delete|update)_/i.test(value)
  );
}

function secretFieldValue(value: string): boolean {
  if (!notAVariable(value) || value.startsWith("=")) {
    return false;
  }
  if (PATH_VALUE.test(value) || LINE_REF.test(value) || VERSION_VALUE.test(value)) {
    return false;
  }
  // A name made of words, one of them a secret's, is code's, not a value's.
  return !(
    /^[A-Za-z_][A-Za-z0-9_]*$/.test(value) &&
    !/\d/.test(value) &&
    /(?:token|secret|password|key)/i.test(value)
  );
}

const ID_WORDS =
  /(?:order|uid|no|no\.|#|number|ticket|invoice|id|订单|订单号|单号|编号|流水号|工单|运单号|快递单号|交易号|序号|账单号)\s*$/i;

/** Folder names under /Users that are no one's. */
const NOT_NAMES = new Set([
  "shared",
  "public",
  "guest",
  "default",
  "default user",
  "all users",
  "user",
  "username",
  "user_name",
  "yourname",
  "your-name",
  "your_name",
  "yourusername",
  "you",
  "me",
  "name",
  "example",
  "foo",
  "bar",
  "someone",
  "john",
  "jdoe",
  "runner",
  "node",
  "vscode",
  "codespace",
  "linuxbrew",
  "...",
]);

/** Users of a service or a cloud image, which say nothing of who the user is. */
const NOT_USERS = new Set([
  "git",
  "root",
  "ec2-user",
  "ubuntu",
  "admin",
  "postgres",
  "www-data",
  "nobody",
  "centos",
  "debian",
  "fedora",
  "azureuser",
  "opc",
  "core",
  "vagrant",
  "docker",
  "str",
  "string",
  "int",
  "bool",
  "any",
  "none",
  "null",
  "nil",
  "true",
  "false",
  "undefined",
  "hi",
  "hello",
  "hey",
  "yes",
  "no",
  "ok",
  "okay",
  "thanks",
  "continue",
  "go",
  "stop",
  "help",
  "test",
  "y",
  "n",
]);

/** Hosts everyone's ssh and git go to, and names that are no one's machine. */
const PUBLIC_HOSTS = new Set([
  "github.com",
  "gitlab.com",
  "bitbucket.org",
  "ssh.dev.azure.com",
  "vs-ssh.visualstudio.com",
  "localhost",
  "host",
  "hostname",
  "server",
  "remote",
  "example",
  "your-server",
  "str",
  "string",
  "none",
  "null",
  "true",
  "false",
  "undefined",
]);

/** Buckets docs and examples name. */
const NOT_BUCKETS = new Set([
  "bucket",
  "my-bucket",
  "mybucket",
  "bucket-name",
  "bucketname",
  "my-bucket-name",
  "your-bucket",
  "your-bucket-name",
  "yourbucket",
  "example-bucket",
  "examplebucket",
  "amzn-s3-demo-bucket",
  "doc-example-bucket",
  "s3",
  "www",
  "storage",
  "container",
  "mycontainer",
  "my-container",
  "mystorageaccount",
  "account",
  "upload",
  "download",
  "batch",
  "b",
  "v1",
  "v2",
  "api",
]);

/** What a "User:" line in a chat's transcript says on its own. */
const CHAT_WORDS = new Set([
  "done",
  "why",
  "what",
  "how",
  "sure",
  "please",
  "retry",
  "next",
  "again",
  "great",
  "good",
  "nice",
  "cool",
  "fix",
  "go-ahead",
  "proceed",
  "lgtm",
  "required",
  "optional",
  "unknown",
  "anonymous",
  "guest",
  "current",
  "me",
]);

/** Words of a variable's or a type's name that holds a user: current_user, UserInfo. */
const IDENT_PARTS = new Set([
  "user",
  "users",
  "usr",
  "username",
  "name",
  "names",
  "login",
  "logname",
  "account",
  "acct",
  "owner",
  "author",
  "member",
  "person",
  "profile",
  "current",
  "cur",
  "default",
  "target",
  "new",
  "old",
  "my",
  "the",
  "obj",
  "object",
  "info",
  "id",
  "model",
  "data",
  "record",
  "entity",
  "row",
  "item",
  "input",
  "arg",
  "args",
  "param",
  "value",
  "val",
  "str",
  "type",
  "dto",
  "db",
  "auth",
  "session",
  "self",
]);

/** What a dotted value on a host/user line is read from: request.user, os.hostname. */
const CODE_OBJECTS = new Set([
  "self",
  "this",
  "os",
  "process",
  "request",
  "req",
  "ctx",
  "context",
  "config",
  "cfg",
  "conf",
  "settings",
  "env",
  "args",
  "opts",
  "options",
  "props",
  "params",
  "session",
  "socket",
  "platform",
  "window",
  "location",
  "url",
  "u",
  "r",
  "c",
  "s",
  "m",
  "p",
  "x",
  "data",
  "info",
  "user",
]);

/** A release's version as a host's characters spell it: 4.0.0, 18.2.0-rc.0. */
const VERSION_HOST = /^v?\d+(?:\.\d+)+(?:-[0-9A-Za-z.-]+)?$/;

function versionHost(value: string): boolean {
  if (!VERSION_HOST.test(value)) {
    return false;
  }
  return !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value);
}

function inCode(value: string): boolean {
  const dot = value.lastIndexOf(".");
  if (dot < 0) {
    return false;
  }
  const first = value.slice(0, value.indexOf(".")).toLowerCase();
  const last = value.slice(dot + 1).toLowerCase();
  return (
    CODE_OBJECTS.has(first) ||
    NOT_USERS.has(last) ||
    NOT_NAMES.has(last) ||
    PUBLIC_HOSTS.has(last) ||
    last === "login" ||
    last === "username"
  );
}

function userValue(value: string): boolean {
  const lower = value.toLowerCase();
  return value.length >= 2 && !NOT_USERS.has(lower) && !NOT_NAMES.has(lower);
}

function shellUser(value: string, text: string, start: number): boolean {
  if (!userValue(value)) {
    return false;
  }
  if (start > 0 && text[start - 1] === "@" && versionHost(value)) {
    return false;
  }
  if (text[start + value.length] === "@") {
    const host = /^@([A-Za-z0-9.-]+)/.exec(text.slice(start + value.length))?.[1];
    return host === undefined || !versionHost(host);
  }
  return true;
}

function hostValue(value: string): boolean {
  const lower = value.toLowerCase().replace(/\.$/, "");
  if (lower.length < 2 || PUBLIC_HOSTS.has(lower)) {
    return false;
  }
  if (lower.startsWith("process.") || lower.startsWith("os.") || lower.startsWith("env.")) {
    return false;
  }
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(lower) || lower.includes(":")) {
    return false; // an address is the IP category's
  }
  for (const example of [
    "example.com",
    "example.org",
    "example.net",
    ".example",
    ".test",
    ".invalid",
    ".localhost",
  ]) {
    if (lower === example.replace(/^\./, "") || lower.endsWith(example)) {
      return false;
    }
  }
  return true;
}

function shellHost(value: string, text: string, start: number): boolean {
  return hostValue(value) && !(start > 0 && text[start - 1] === "@" && versionHost(value));
}

function lineHost(value: string): boolean {
  return hostValue(value) && !inCode(value);
}

function lineUser(value: string): boolean {
  const lower = value.toLowerCase();
  if (!userValue(value) || CHAT_WORDS.has(lower) || IDENT_PARTS.has(lower) || inCode(value)) {
    return false;
  }
  const words = value.split(/[^A-Za-z0-9]+/).filter((word) => word.length > 0);
  if (words.length < 2) {
    return true;
  }
  return !words.some((word) => IDENT_PARTS.has(word.toLowerCase()));
}

function bucketValue(value: string): boolean {
  const lower = value.toLowerCase();
  return lower.length >= 3 && !NOT_BUCKETS.has(lower) && !/^\d+$/.test(lower);
}

function homeName(value: string): boolean {
  return value.length > 0 && !value.startsWith(".") && !NOT_NAMES.has(value.toLowerCase());
}

/** An SSN is nine digits in the ranges the SSA gives out, and not an example. */
function ssnValue(value: string): boolean {
  const digits = value.replace(/[- ]/g, "");
  if (!/^\d{9}$/.test(digits)) {
    return false;
  }
  if (digits.startsWith("000") || digits.startsWith("666") || digits.startsWith("9")) {
    return false;
  }
  if (digits.slice(3, 5) === "00" || digits.slice(5) === "0000") {
    return false;
  }
  if (digits === "123456789" || digits === "078051120" || digits === "219099999") {
    return false;
  }
  return !/^(\d)\1{8}$/.test(digits);
}

/** A passport number has five digits at least and is not one character repeated. */
function passportValue(value: string): boolean {
  return (value.match(/\d/g) ?? []).length >= 5 && !/^(.)\1+$/.test(value);
}

function birthdayValue(value: string): boolean {
  const parts = value.match(/\d+/g) ?? [];
  const yearAgo = new Date();
  yearAgo.setFullYear(yearAgo.getFullYear() - 1);
  const valid = (year: number, month: number, day: number): boolean => {
    if (year < 1900 || year > 2099 || month < 1 || month > 12 || day < 1 || day > 31) {
      return false;
    }
    return new Date(year, month - 1, day).getTime() < yearAgo.getTime();
  };
  const num = (part: string | undefined): number => Number(part ?? "0");
  if (parts.length === 2) {
    const lower = value.toLowerCase();
    const months = [
      "jan",
      "feb",
      "mar",
      "apr",
      "may",
      "jun",
      "jul",
      "aug",
      "sep",
      "oct",
      "nov",
      "dec",
    ];
    const at = months.findIndex((month) => lower.includes(month));
    if (at < 0) {
      return false;
    }
    let day = num(parts[0]);
    let year = num(parts[1]);
    if ((parts[0] ?? "").length === 4) {
      day = num(parts[1]);
      year = num(parts[0]);
    }
    return valid(year, at + 1, day);
  }
  if (parts.length !== 3) {
    return false;
  }
  if ((parts[0] ?? "").length === 4) {
    return valid(num(parts[0]), num(parts[1]), num(parts[2]));
  }
  const year = num(parts[2]);
  return valid(year, num(parts[0]), num(parts[1])) || valid(year, num(parts[1]), num(parts[0]));
}

function serialValue(value: string): boolean {
  return value.length >= 6 && /\d/.test(value) && !/^(.)\1*$/.test(value);
}

/** A MAC address, not an example, the broadcast one, or twelve decimal digits. */
function macValue(value: string): boolean {
  const lower = value.toLowerCase().replace(/-/g, ":");
  if (
    /^(?:00:00:00:00:00:00|ff:ff:ff:ff:ff:ff|00:11:22:33:44:55|aa:bb:cc:dd:ee:ff|01:23:45:67:89:ab|12:34:56:78:9a:bc|xx:xx:xx:xx:xx:xx)$/.test(
      lower,
    )
  ) {
    return false;
  }
  return /[a-f]/.test(lower);
}

function phoneValue(value: string, text: string, start: number): boolean {
  if (value.replace(/\D/g, "").length > 11) {
    return true;
  }
  if (start > 0 && text[start - 1] === "#") {
    return false;
  }
  const before = text.slice(Math.max(0, start - 32), start);
  return !ID_WORDS.test(before);
}

function ipValue(_value: string, text: string, start: number): boolean {
  const before = text.slice(Math.max(0, start - 2), start).toLowerCase();
  return !(before.endsWith("v") || before.endsWith("version "));
}

function luhnValid(value: string): boolean {
  const digits = value.replace(/\D/g, "");
  if (digits.length < 13 || digits.length > 19) {
    return false;
  }
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    const digit = Number(digits[index]);
    let add = digit;
    if (double) {
      add = digit > 4 ? digit * 2 - 9 : digit * 2;
    }
    sum += add;
    double = !double;
  }
  return sum % 10 === 0;
}

function ibanValid(value: string): boolean {
  const compact = value.replace(/\s/g, "").toUpperCase();
  if (compact.length < 15 || compact.length > 34) {
    return false;
  }
  const arranged = `${compact.slice(4)}${compact.slice(0, 4)}`;
  let remainder = 0;
  for (const character of arranged) {
    const digits = /[A-Z]/.test(character) ? String(character.charCodeAt(0) - 55) : character;
    for (const digit of digits) {
      remainder = (remainder * 10 + Number(digit)) % 97;
    }
  }
  return remainder === 1;
}
