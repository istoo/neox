import { createHmac } from "node:crypto";
import { isIP } from "node:net";

/**
 * The made-up values masking sends instead of placeholders, ported from
 * myna's `internal/redact/shape.go`: a key keeps its prefix, length and the
 * kind of character in each place; a user name goes as eight letters; a
 * public address goes as `public-ip-xxxxxxxx`.
 *
 * A made-up value is derived from the key file, so the same value goes as
 * the same stand-in across restarts, and it is only ever kept in memory.
 */

const MIN_SHAPE = 8;
const MIN_RANDOM = 6;
const STAND_IN_LEN = 8;
const IP_STAND_IN_HEAD = "public-ip-";
const IP_STAND_IN_LEN = 8;
const KEY_PREFIXES = [
  "sk-ant-api03-",
  "sk-ant-oat01-",
  "sk-ant-admin01-",
  "sk-svcacct-",
  "sk-or-v1-",
  "github_pat_",
];

const NAMED_VALUE = /^[A-Za-z_][A-Za-z0-9_.-]*[ \t]*[=:][ \t]*/;

export function foldStandIn(kind: string): boolean {
  return kind === "USERNAME" || kind === "IP";
}

export function shapeByte(character: string): boolean {
  return /^[A-Za-z0-9._-]$/.test(character);
}

/** The start of a value that names its kind and stays as it is. */
export function shapeHead(value: string): string {
  for (const prefix of KEY_PREFIXES) {
    if (value.startsWith(prefix)) {
      return prefix;
    }
  }
  if (value.startsWith("AKIA") || value.startsWith("ASIA")) {
    return value.slice(0, 4);
  }
  for (let index = 0; index < value.length && index <= 4; index += 1) {
    const character = value[index] ?? "";
    if ((character === "-" || character === "_") && index > 0) {
      return value.slice(0, index + 1);
    }
    if (!/[A-Za-z]/.test(character)) {
      break;
    }
  }
  return "";
}

/** A value found with its name (`OPENAI_API_KEY=sk_…`) split into both. */
export function splitNamedValue(value: string): { name: string; rest: string } {
  const match = NAMED_VALUE.exec(value);
  return match === null
    ? { name: "", rest: value }
    : { name: value.slice(0, match[0].length), rest: value.slice(match[0].length) };
}

function byteStream(seed: Buffer): () => number {
  let stream = Buffer.alloc(0);
  let counter = 0;
  return () => {
    if (stream.length === 0) {
      const counterBytes = Buffer.alloc(8);
      counterBytes.writeBigUInt64BE(BigInt(counter));
      counter += 1;
      stream = createHmac("sha256", seed).update(counterBytes).digest();
    }
    const byte = stream[0] ?? 0;
    stream = stream.subarray(1);
    return byte;
  };
}

/** `value` as a made-up key of its form, or null where it may not be one. */
export function shapeOf(key: Buffer, kind: string, value: string): string | null {
  if (kind === "USERNAME" || kind === "IP" || kind === "TERM" || value.length < MIN_SHAPE) {
    return null;
  }
  if (![...value].every((character) => shapeByte(character))) {
    return null;
  }
  const head = shapeHead(value);
  const rest = value.slice(head.length);
  const hex = hexCase(rest);
  const seed = createHmac("sha256", key).update(`shape\u0000${kind}\u0000${value}`).digest();
  const next = byteStream(seed);
  let out = head;
  let made = 0;
  for (const character of rest) {
    const set = characterSet(character, hex);
    if (set === "") {
      out += character;
      continue;
    }
    made += 1;
    out += set[next() % set.length];
  }
  return made < MIN_RANDOM || out === value ? null : out;
}

interface HexCase {
  lower: boolean;
  upper: boolean;
}

function hexCase(rest: string): HexCase {
  let lower = true;
  let upper = true;
  for (const character of rest) {
    if (/[0-9._-]/.test(character)) {
      continue;
    }
    if (/[a-f]/.test(character)) {
      upper = false;
    } else if (/[A-F]/.test(character)) {
      lower = false;
    } else {
      lower = false;
      upper = false;
    }
  }
  return { lower, upper };
}

function characterSet(character: string, hex: HexCase): string {
  if (character === "-" || character === "_" || character === ".") {
    return "";
  }
  if (hex.lower) {
    return "0123456789abcdef";
  }
  if (hex.upper) {
    return "0123456789ABCDEF";
  }
  if (/[A-Z]/.test(character)) {
    return "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  }
  if (/[a-z]/.test(character)) {
    return "abcdefghijklmnopqrstuvwxyz";
  }
  return "0123456789";
}

/** The user name `value` goes as: eight lowercase letters. */
export function standInOf(key: Buffer, value: string): string {
  const sum = createHmac("sha256", key).update(`user\u0000${value}`).digest();
  let out = "";
  for (let index = 0; index < STAND_IN_LEN; index += 1) {
    out += String.fromCharCode(97 + ((sum[index] ?? 0) % 26));
  }
  return out;
}

/** An address as myna compares it: IPv4-mapped IPv6 unwrapped, IPv6 compressed. */
export function canonicalAddress(value: string): string | null {
  if (isIP(value) === 4) {
    return value;
  }
  if (isIP(value) !== 6) {
    return null;
  }
  let canonical = value.toLowerCase();
  try {
    canonical = new URL(`http://[${value}]/`).hostname.slice(1, -1);
  } catch {
    // Keep the text as it came.
  }
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonical);
  if (mapped !== null) {
    const high = Number.parseInt(mapped[1] ?? "0", 16);
    const low = Number.parseInt(mapped[2] ?? "0", 16);
    return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
  }
  return canonical;
}

/** The stand-ins `address` may go as, in the order they are tried. */
export function ipStandIns(key: Buffer, address: string): string[] | null {
  const canonical = canonicalAddress(address);
  if (canonical === null) {
    return null;
  }
  const out: string[] = [];
  for (let index = 0; index < 8; index += 1) {
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(index));
    const sum = createHmac("sha256", key).update(`ip\u0000${canonical}`).update(counter).digest();
    let candidate = IP_STAND_IN_HEAD;
    for (let at = 0; at < IP_STAND_IN_LEN; at += 1) {
      candidate += String.fromCharCode(97 + ((sum[at] ?? 0) % 26));
    }
    out.push(candidate);
  }
  return out;
}

/** What a value looks like: its first characters and its length. */
export function hintOf(kind: string, value: string): { head: string; length: number } {
  const runes = [...value];
  const length = runes.length;
  if (length < 2) {
    return { head: "", length };
  }
  if (kind === "CARD" || kind === "IBAN" || length < 16) {
    return { head: runes[0] ?? "", length };
  }
  let count = 0;
  for (const character of runes) {
    if (count >= 4 || !/[A-Za-z_-]/.test(character)) {
      break;
    }
    count += 1;
    if (character === "-" || character === "_") {
      break;
    }
  }
  return { head: runes.slice(0, Math.max(count, 1)).join(""), length };
}

function nameByte(character: string | undefined): boolean {
  return character !== undefined && /[0-9A-Za-z_-]/.test(character);
}

/** An address stand-in is put back only where it is a whole host name. */
export function wholeAddress(text: string, start: number, end: number): boolean {
  const before = start > 0 ? text[start - 1] : undefined;
  const after = end < text.length ? text[end] : undefined;
  if (before !== undefined && (nameByte(before) || before === ".")) {
    return false;
  }
  if (after !== undefined && nameByte(after)) {
    return false;
  }
  const afterNext = end + 1 < text.length ? text[end + 1] : undefined;
  return !(after === "." && nameByte(afterNext));
}

/** `text` with each case-folded stand-in replaced, counted when asked. */
export function replaceStandIn(
  text: string,
  standIn: string,
  value: string,
  kind: string,
  counts?: Map<string, number>,
): string {
  const lower = text.toLowerCase();
  const needle = standIn.toLowerCase();
  let out = "";
  let last = 0;
  let at = 0;
  while (at <= text.length) {
    const found = lower.indexOf(needle, at);
    if (found < 0) {
      break;
    }
    const end = found + standIn.length;
    at = found + 1;
    if (kind === "IP" && !wholeAddress(text, found, end)) {
      continue;
    }
    out += text.slice(last, found) + value;
    last = end;
    at = end;
    if (counts !== undefined) {
      counts.set(standIn, (counts.get(standIn) ?? 0) + 1);
    }
  }
  if (last === 0) {
    return text;
  }
  return out + text.slice(last);
}

/** JSON-escaped text for a value put back inside a JSON string. */
export function jsonEscape(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}
