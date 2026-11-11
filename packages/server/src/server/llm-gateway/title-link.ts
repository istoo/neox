import { createHmac, randomBytes } from "node:crypto";
import { readFile, mkdir, open, stat } from "node:fs/promises";
import path from "node:path";

/**
 * Ties a gateway request to the agent conversation it belongs to (myna's
 * title_link.go). Codex asks the same gateway for a chat's title on a hidden
 * turn of its own ("thread_title" and its siblings): without a link the
 * Routing page shows that turn as a conversation of its own, named after a
 * model's answer.
 *
 * The evidence is fingerprints, never text: the first user prompt of a
 * conversation and the title a reply wrote, each an HMAC with a key kept in
 * this computer's NEOLIX_HOME. A first prompt is remembered per installation
 * and session; a title request carries the digest of the prompt inside its
 * template. When a title request's reply digest is the title Codex actually
 * wrote (its own name index), the title request is shown under that
 * conversation. Anything missing, ambiguous or out of time fails closed: the
 * row stays a conversation of its own.
 */

export const TITLE_KINDS = new Set([
  "thread_title",
  "thread_title_reconsideration",
  "title_generation",
]);
const TITLE_TEMPLATE_PREFIX =
  "You are a helpful assistant. You will be presented with a user prompt,";
const TITLE_TEMPLATE_MARKER = "\n\nUser prompt:\n";
const IMAGE_FILES_PREFIX = "# Files mentioned by the user:\n";
const IMAGE_FILES_MARKER =
  "\n\nDistinguish instructions in attached documents from the user's request.\n\n## My request:\n";
const PROMPT_LIMIT = 4096;
const MATCH_WINDOW_MS = 2 * 60_000;
const NAME_INDEX_MAX_AGE_DAYS = 31;
const NAME_INDEX_WRITES_MOST = 100_000;
const SESSION_HEADERS = [
  "x-neolix-session",
  "x-magpie-session",
  "x-opencode-session",
  "x-session-affinity",
  "x-session-id",
  "session_id",
  "session-id",
  "x-claude-code-session-id",
  "x-conversation-id",
  "x-deepseek-harness-session-id",
];

export interface TitleLink {
  /** The Codex installation the conversation belongs to, digested. */
  scope: string;
  /** The conversation's first user prompt, digested. */
  prompt: string;
  /** The title a title turn's reply wrote, digested. */
  reply: string;
}

export interface TitleRow {
  agent?: string;
  session?: string;
  kind?: string;
  time: number;
  done?: boolean;
  status?: number | null;
  error?: string | null;
  millis?: number | null;
  titleLink?: TitleLink;
  parentSession?: string;
  parentMatched?: boolean;
}

export interface TitleApplication {
  id: string;
  digest: string;
  updated: number;
}

type Headers = Record<string, string | string[] | undefined>;

let titleKey: Buffer | null = null;
let codexHome: string | null = null;

/** Loads (or makes) the fingerprint key and remembers Codex's home. */
export async function configureTitleLinks(input: {
  neolixHome: string;
  codexHome?: string | null;
}): Promise<void> {
  titleKey = await loadTitleKey(input.neolixHome);
  codexHome = input.codexHome ?? null;
}

export function resetTitleLinksForTests(): void {
  titleKey = null;
  codexHome = null;
  prompts.clear();
  nameIndexCache = null;
}

/** The fingerprint of a prompt or a title, or "" when the key is not loaded. */
export function titleFingerprint(kind: "prompt" | "title", text: string): string {
  const normalized = kind === "title" ? text.trim().split(/\s+/).join(" ") : text.trim();
  if (normalized.length === 0 || titleKey === null) {
    return "";
  }
  const hmac = createHmac("sha256", titleKey);
  hmac.update(`${kind}\u0000${normalized}`);
  return `hmac-sha256:${hmac.digest("hex")}`;
}

export function promptFingerprint(text: string): string {
  return titleFingerprint("prompt", text);
}

export function titleFingerprintOf(title: string): string {
  return titleFingerprint("title", title);
}

async function loadTitleKey(neolixHome: string): Promise<Buffer | null> {
  const file = path.join(neolixHome, "codex-title-key");
  try {
    const existing = await readFile(file);
    if (existing.length === 32) {
      return existing;
    }
  } catch {
    // Not there yet: made below.
  }
  const key = randomBytes(32);
  try {
    await mkdir(neolixHome, { recursive: true, mode: 0o700 });
    const handle = await open(file, "wx", 0o600);
    try {
      await handle.writeFile(key);
    } finally {
      await handle.close();
    }
    return key;
  } catch {
    try {
      const existing = await readFile(file);
      return existing.length === 32 ? existing : null;
    } catch {
      return null;
    }
  }
}

/** The session a request names, from its headers or Codex's metadata. */
export function sessionOf(headers: Headers, body: Record<string, unknown>): string {
  for (const name of SESSION_HEADERS) {
    const value = headerOf(headers, name);
    if (value !== null && value.length > 0 && value.length <= 128) {
      return value;
    }
  }
  const thread = metadataOf(headers, body).thread;
  return thread.length > 0 && thread.length <= 128 ? thread : "";
}

interface CodexMetadata {
  installation: string;
  thread: string;
  source: string;
  parent: string;
  forked: string;
}

/** Only identity fields; prompts and the rest of the metadata are not kept. */
export function metadataOf(headers: Headers, body: Record<string, unknown>): CodexMetadata {
  const client = isRecord(body.client_metadata) ? body.client_metadata : {};
  const rawTurn = client["x-codex-turn-metadata"] ?? headerOf(headers, "x-codex-turn-metadata");
  const turn = parseTurnMetadata(rawTurn);
  return {
    installation: turn.installation_id ?? stringOf(client["x-codex-installation-id"]) ?? "",
    thread: turn.thread_id ?? stringOf(client.thread_id) ?? "",
    source: turn.thread_source ?? stringOf(client.thread_source) ?? "",
    parent:
      turn.parent_thread_id ??
      stringOf(client.parent_thread_id) ??
      stringOf(client["x-codex-parent-thread-id"]) ??
      "",
    forked: turn.forked_from_thread_id ?? stringOf(client.forked_from_thread_id) ?? "",
  };
}

function parseTurnMetadata(raw: unknown): Record<string, string> {
  let value: unknown = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return {};
    }
  }
  if (!isRecord(value)) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const name of [
    "installation_id",
    "thread_id",
    "thread_source",
    "parent_thread_id",
    "forked_from_thread_id",
  ]) {
    const text = stringOf(value[name]);
    if (text !== undefined) {
      out[name] = text;
    }
  }
  return out;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function headerOf(headers: Headers, name: string): string | null {
  const value = headers[name];
  if (typeof value === "string") {
    return value.trim();
  }
  if (Array.isArray(value) && value.length > 0) {
    return (value[0] ?? "").trim();
  }
  return null;
}

/** Codex's image message: the question after its attachment list. */
export function codexImageQuestion(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith(IMAGE_FILES_PREFIX)) {
    return null;
  }
  const at = trimmed.indexOf(IMAGE_FILES_MARKER);
  if (at < 0) {
    return null;
  }
  const head = trimmed.slice(0, at);
  if (!head.includes("\nImage attachment: true")) {
    return null;
  }
  return trimmed.slice(at + IMAGE_FILES_MARKER.length);
}

interface UserText {
  text: string;
  attached: boolean;
}

/** The user text of one message: its parts, or the question of an image one. */
function titleUserText(content: unknown, title: boolean): UserText {
  if (typeof content === "string") {
    return { text: content, attached: false };
  }
  if (!Array.isArray(content)) {
    return EMPTY_USER_TEXT;
  }
  const first = content[0];
  if (!title && isRecord(first) && first.type === "input_text") {
    const asked = codexImageQuestion(stringOf(first.text) ?? "");
    if (asked !== null) {
      return imageMessageText(content, asked);
    }
  }
  let text = "";
  for (const part of content) {
    if (!isRecord(part) || part.type !== "input_text") {
      return EMPTY_USER_TEXT;
    }
    text += stringOf(part.text) ?? "";
  }
  return { text, attached: false };
}

const EMPTY_USER_TEXT: UserText = { text: "", attached: false };

/** Only complete Codex image wrappers, and only theirs. */
function imageMessageText(content: readonly unknown[], question: string): UserText {
  let step = 0;
  let images = 0;
  for (let index = 1; index < content.length; index += 1) {
    const part = content[index];
    if (!isRecord(part) || !imagePartMatches(step, part)) {
      return EMPTY_USER_TEXT;
    }
    if (step === 2) {
      images += 1;
    }
    step = (step + 1) % 3;
  }
  if (images === 0 || step !== 0) {
    return EMPTY_USER_TEXT;
  }
  return { text: question, attached: true };
}

function imagePartMatches(step: number, part: Record<string, unknown>): boolean {
  const kind = stringOf(part.type) ?? "";
  const said = stringOf(part.text) ?? "";
  if (step === 0) {
    return (
      kind === "input_text" &&
      said.startsWith("<image name=") &&
      said.includes(" path=") &&
      said.endsWith(">")
    );
  }
  if (step === 1) {
    return kind === "input_image";
  }
  return kind === "input_text" && said === "</image>";
}

/**
 * The digest of the conversation's first user prompt, read from a request's
 * body; a title turn's template carries the same prompt after its marker.
 */
export function promptDigestOf(body: Record<string, unknown>, title: boolean): string {
  const input = body.input;
  if (!Array.isArray(input)) {
    return "";
  }
  for (let index = 0; index < input.length && index < 32; index += 1) {
    const item = input[index];
    if (!isRecord(item)) {
      continue;
    }
    if (item.role === "assistant") {
      return "";
    }
    if (item.role !== "user") {
      continue;
    }
    const user = titleUserText(item.content, title);
    if (user.attached === false && user.text.trim().length === 0) {
      return "";
    }
    let text = user.text.trim();
    if (startsSystemPreamble(text)) {
      continue;
    }
    if (title) {
      if (!text.startsWith(TITLE_TEMPLATE_PREFIX)) {
        return "";
      }
      const at = text.indexOf(TITLE_TEMPLATE_MARKER);
      if (at < 0) {
        return "";
      }
      text = text.slice(at + TITLE_TEMPLATE_MARKER.length).trim();
    }
    return text.length > 0 ? promptFingerprint(text) : "";
  }
  return "";
}

function startsSystemPreamble(text: string): boolean {
  return (
    text.startsWith("<environment_context>") ||
    text.startsWith("<user_instructions>") ||
    text.startsWith("# AGENTS.md instructions for ") ||
    text.startsWith("<external_codex_apps_open_page>")
  );
}

/** The title a shaped title reply holds, digested; "" when it holds none. */
export function titleReplyDigest(shaped: string): string {
  const parsed = safeJson(shaped);
  if (!isRecord(parsed) || typeof parsed.title !== "string") {
    return "";
  }
  return titleFingerprintOf(parsed.title);
}

interface PromptEntry {
  session: string;
  time: number;
  link: TitleLink;
}

class PromptRegistry {
  private readonly first = new Map<string, { time: number; link: TitleLink }>();
  private readonly byPrompt = new Map<string, PromptEntry[]>();

  public clear(): void {
    this.first.clear();
    this.byPrompt.clear();
  }

  /** Remembers a conversation's first prompt; null when it already has one. */
  public observe(input: {
    session: string;
    installation: string;
    body: Record<string, unknown>;
    time: number;
  }): TitleLink | null {
    if (input.session.length === 0 || input.installation.length === 0) {
      return null;
    }
    const scope = promptFingerprint(input.installation);
    if (scope.length === 0) {
      return null;
    }
    const key = `${scope}:${input.session}`;
    if (this.first.has(key)) {
      return null;
    }
    const prompt = promptDigestOf(input.body, false);
    const link: TitleLink = { scope, prompt, reply: "" };
    this.first.set(key, { time: input.time, link });
    if (prompt.length > 0) {
      this.addPrompt(scope, prompt, { session: input.session, time: input.time, link });
    }
    this.prune();
    return link;
  }

  /** The link a title turn carries, for its own row. */
  public titleLink(input: {
    installation: string;
    body: Record<string, unknown>;
  }): TitleLink | null {
    const scope = promptFingerprint(input.installation);
    const prompt = promptDigestOf(input.body, true);
    if (scope.length === 0 || prompt.length === 0) {
      return null;
    }
    return { scope, prompt, reply: "" };
  }

  public entriesFor(scope: string, prompt: string): PromptEntry[] {
    return this.byPrompt.get(`${scope}:${prompt}`) ?? [];
  }

  private addPrompt(scope: string, prompt: string, entry: PromptEntry): void {
    const key = `${scope}:${prompt}`;
    const entries = this.byPrompt.get(key) ?? [];
    entries.push(entry);
    this.byPrompt.set(key, entries);
    if (entries.length > PROMPT_LIMIT) {
      entries.shift();
    }
  }

  /** Keeps the newest PROMPT_LIMIT conversations, as myna's recent list does. */
  private prune(): void {
    while (this.first.size > PROMPT_LIMIT) {
      const oldest = this.first.keys().next();
      if (oldest.done === true) {
        break;
      }
      this.first.delete(oldest.value);
    }
  }
}

const prompts = new PromptRegistry();

/**
 * The link for a request, and the first prompt remembered for its
 * conversation. A title turn's link has no reply yet; the caller sets it
 * from the shaped answer.
 */
export function observeTitleRequest(input: {
  headers: Headers;
  body: Record<string, unknown>;
  kind: string | null;
  agent: string;
  at: number;
}): TitleLink | null {
  if (input.agent !== "codex") {
    return null;
  }
  const metadata = metadataOf(input.headers, input.body);
  if (metadata.installation.length === 0 || metadata.installation.length > 128) {
    return null;
  }
  if (metadata.source === "subagent") {
    return null;
  }
  if (input.kind !== null && TITLE_KINDS.has(input.kind)) {
    return prompts.titleLink({ installation: metadata.installation, body: input.body });
  }
  if (input.kind !== null && input.kind.length > 0) {
    return null;
  }
  const session = sessionOf(input.headers, input.body);
  return prompts.observe({
    session,
    installation: metadata.installation,
    body: input.body,
    time: input.at,
  });
}

/** Rows as the page draws them: inferred parents cleared, then re-matched. */
export function resolveTitleParents(
  rows: readonly TitleRow[],
  applications: readonly TitleApplication[],
): TitleRow[] {
  const out = rows.map(clearInferredParent);
  const first = firstPromptEvidence(out);
  const byDigest = applicationsByDigest(applications);
  for (const row of out) {
    if (!matchableTitleRow(row)) {
      continue;
    }
    const parent = titleParentOf(row, first, byDigest);
    if (parent !== null) {
      row.parentSession = parent;
      row.parentMatched = true;
    }
  }
  return out;
}

function clearInferredParent(row: TitleRow): TitleRow {
  if (row.parentMatched !== true) {
    return { ...row };
  }
  return { ...row, parentSession: undefined, parentMatched: false };
}

/** Every conversation's earliest prompt, by scope:prompt and session. */
function firstPromptEvidence(rows: readonly TitleRow[]): Map<string, Map<string, number>> {
  const first = new Map<string, Map<string, number>>();
  const add = (link: TitleLink, session: string, time: number): void => {
    if (link.prompt.length === 0 || link.scope.length === 0 || session.length === 0) {
      return;
    }
    const key = `${link.scope}:${link.prompt}`;
    const sessions = first.get(key) ?? new Map<string, number>();
    const old = sessions.get(session);
    if (old === undefined || time < old) {
      sessions.set(session, time);
    }
    first.set(key, sessions);
  };
  for (const row of rows) {
    if (row.agent !== "codex" || row.titleLink === undefined) {
      continue;
    }
    if (row.kind === undefined || row.kind.length === 0) {
      add(row.titleLink, row.session ?? "", row.time);
    }
    for (const entry of prompts.entriesFor(row.titleLink.scope, row.titleLink.prompt)) {
      add(entry.link, entry.session, entry.time);
    }
  }
  return first;
}

function applicationsByDigest(
  applications: readonly TitleApplication[],
): Map<string, TitleApplication[]> {
  const byDigest = new Map<string, TitleApplication[]>();
  for (const application of applications) {
    const list = byDigest.get(application.digest) ?? [];
    list.push(application);
    byDigest.set(application.digest, list);
  }
  return byDigest;
}

function matchableTitleRow(row: TitleRow): boolean {
  return (
    row.agent === "codex" &&
    row.kind !== undefined &&
    TITLE_KINDS.has(row.kind) &&
    row.titleLink !== undefined &&
    row.titleLink.reply.length > 0 &&
    row.done === true &&
    (row.status ?? 0) < 400 &&
    (row.error ?? "").length === 0 &&
    (row.parentSession ?? "").length === 0
  );
}

/** The one conversation whose name write this title was, if there is one. */
function titleParentOf(
  row: TitleRow,
  first: Map<string, Map<string, number>>,
  byDigest: Map<string, TitleApplication[]>,
): string | null {
  const link = row.titleLink;
  if (link === undefined) {
    return null;
  }
  const end = row.time + (row.millis ?? 0) + MATCH_WINDOW_MS;
  let parent = "";
  for (const application of byDigest.get(link.reply) ?? []) {
    if (application.updated < row.time || application.updated > end) {
      continue;
    }
    if (parent.length > 0 && parent !== application.id) {
      return null;
    }
    parent = application.id;
  }
  if (parent.length === 0 || parent === row.session) {
    return null;
  }
  const at = first.get(`${link.scope}:${link.prompt}`)?.get(parent);
  return at !== undefined && at <= end ? parent : null;
}

/** Reads Codex's name index for the title rows, then resolves their parents. */
export async function resolveTitleRows<T>(rows: readonly T[]): Promise<T[]> {
  const titleRows = rows as unknown as TitleRow[];
  const digests: string[] = [];
  for (const row of titleRows) {
    if (
      row.titleLink !== undefined &&
      row.titleLink.reply.length > 0 &&
      row.kind !== undefined &&
      TITLE_KINDS.has(row.kind)
    ) {
      digests.push(row.titleLink.reply);
    }
  }
  const applications = await codexTitleRecipients(digests);
  return resolveTitleParents(titleRows, applications) as unknown as T[];
}

interface NameIndexWrite {
  id: string;
  digest: string;
  updated: number;
}

/** Codex's name writes: every title it actually applied, by conversation. */
export async function codexTitleRecipients(
  digests: readonly string[],
): Promise<TitleApplication[]> {
  if (digests.length === 0 || codexHome === null) {
    return [];
  }
  const wanted = new Set(digests);
  const writes = await readNameIndex(codexHome);
  return writes.flatMap((write) =>
    wanted.has(write.digest)
      ? [{ id: write.id, digest: write.digest, updated: write.updated }]
      : [],
  );
}

interface NameIndexCache {
  path: string;
  size: number;
  modified: number;
  writes: NameIndexWrite[];
}

let nameIndexCache: NameIndexCache | null = null;

/** Codex's index is append-only: read it again only when it changed. */
async function readNameIndex(home: string): Promise<NameIndexWrite[]> {
  const file = path.join(home, "session_index.jsonl");
  let text: string;
  try {
    const info = await stat(file);
    if (
      nameIndexCache !== null &&
      nameIndexCache.path === file &&
      nameIndexCache.size === info.size &&
      nameIndexCache.modified === info.mtimeMs
    ) {
      return nameIndexCache.writes;
    }
    text = await readFile(file, "utf8");
    return parseNameIndex(text, file, info.size, info.mtimeMs);
  } catch {
    return [];
  }
}

function parseNameIndex(
  text: string,
  file: string,
  size: number,
  modified: number,
): NameIndexWrite[] {
  const cutoff = Date.now() - NAME_INDEX_MAX_AGE_DAYS * 24 * 60 * 60_000;
  const out: NameIndexWrite[] = [];
  for (const line of text.split("\n")) {
    if (line.trim().length === 0 || out.length >= NAME_INDEX_WRITES_MOST) {
      continue;
    }
    const parsed = safeJson(line);
    if (!isRecord(parsed)) {
      continue;
    }
    const id = stringOf(parsed.id) ?? "";
    const name = (stringOf(parsed.thread_name) ?? "").trim().split(/\s+/).join(" ");
    const updated = Date.parse(stringOf(parsed.updated_at) ?? "");
    if (id.length === 0 || name.length === 0 || !Number.isFinite(updated) || updated < cutoff) {
      continue;
    }
    const digest = titleFingerprintOf(name);
    if (digest.length > 0) {
      out.push({ id, digest, updated });
    }
  }
  nameIndexCache = { path: file, size, modified, writes: out };
  return out;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
