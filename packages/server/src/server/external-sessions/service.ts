import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { GatewayConversations } from "../llm-gateway/conversations.js";
import { readGatewaySessionUsage, identityOf, type GatewaySessionUsage } from "./gateway-usage.js";
import { isPacked } from "./compressed.js";
import { renderSessionMarkdown } from "./markdown.js";
import { openCodeStoreOf, readOpenCodeListing, readOpenCodeTranscript } from "./opencode.js";
import { readCodexConfig, type CodexConfig } from "./codex-config.js";
import { readAgySummaries, readOpenCodeSessions, type AgySummary } from "./sqlite.js";
import { cleanTitle, readSessionFile, type SessionPricer } from "./read-session.js";
import {
  ActiveExternalSessionError,
  applyClaudeRelocation,
  moveCodexProvider,
  previewClaudeRelocation,
} from "./relocate.js";
import {
  bestHitInParts,
  HIT_MAX,
  normalizeQuery,
  searchSessionFiles,
  type SessionSearchResult,
} from "./search.js";
import {
  EXTERNAL_SESSION_AGENTS,
  agentLabel,
  canDelete,
  listSessionFiles,
  resolveSessionRoots,
  resumeCommand,
  type ExternalSessionAgentId,
} from "./sources.js";
import {
  DEFAULT_SESSION_READS,
  SessionNotReadError,
  readsSessions,
  type SessionReads,
} from "./session-reads.js";
import { activityOfSpans } from "./activity.js";
import { TRACE_AGENTS, readSessionTraceSpans } from "./trace-spans.js";
import { terminalCommandOf } from "./terminals.js";
import { claudeSubagentPath, listClaudeSubagents } from "./subagents.js";
import { readTranscript, type TranscriptPart } from "./transcript.js";
import { discoverWslRoots, type WslRoots } from "./wsl.js";
import { readWslSaved, writeWslSaved, type WslSaved, type WslSavedDistro } from "./wsl-store.js";
import {
  listTrash,
  moveToTrash,
  purgeFromTrash,
  restoreFromTrash,
  sessionsTrashDir,
} from "./trash.js";
import type { ExternalCodexMove, ExternalRelocatePreview } from "@neolix/protocol/messages";
import type {
  ExternalSession,
  ExternalSessionAgent,
  ExternalSessionRefusal,
  ExternalSessionTrashed,
  SessionFile,
  SessionParse,
  SessionRoots,
} from "./types.js";

// debt: only the newest files are parsed and listed; move the list to a paged reader when older sessions must show.
const PARSE_LIMIT = 1000;
const PARSE_CONCURRENCY = 8;
const ACTIVE_WINDOW_MS = 60_000;
const SEARCH_BUDGET_MS = 8_000;
const WSL_FILE_MAX = 4_000;
const TRANSCRIPT_PARTS = 50;
const TRANSCRIPT_PARTS_MAX = 500;
const PREVIEW_TTL_MS = 5 * 60_000;

export interface ExternalSessionsList {
  agents: ExternalSessionAgent[];
  agent: string;
  sessions: ExternalSession[];
  trash: ExternalSessionTrashed[];
  trashDir: string;
  home: string;
  recording: boolean;
  recorded: boolean;
}

export interface ExternalSessionsServiceOptions {
  neolixHome: string;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  pricer?: SessionPricer;
  conversations?: GatewayConversations;
  now?: () => number;
  /** Whether WSL distros may be probed at all (myna's noWSLAgents). */
  wslEnabled?: () => boolean;
  /** Which agents' sessions may be read (myna's sessionReads gate). */
  reads?: () => SessionReads;
}

interface CachedParse {
  mtimeMs: number;
  size: number;
  metaKey: string;
  parse: SessionParse;
}

export class ExternalSessionsService {
  private readonly neolixHome: string;
  private readonly homeDir: string;
  private readonly roots: SessionRoots;
  private readonly pricer: SessionPricer | undefined;
  private readonly conversations: GatewayConversations | undefined;
  private readonly now: () => number;
  private readonly wslEnabled: () => boolean;
  private readonly reads: () => SessionReads;
  private readonly parses = new Map<string, CachedParse>();
  private readonly parsing = new Map<string, Promise<SessionParse>>();
  private readonly previewed = new Map<string, { from: string; to: string; at: number }>();
  private codexConfig: Promise<CodexConfig> | null = null;
  private openCodeCache: {
    mtimeMs: number;
    sessions: ExternalSession[];
    stores: Map<string, "v1" | "v2">;
  } | null = null;
  private agyCache: { rev: string; rows: Map<string, AgySummary> } | null = null;
  private wslRoots: Promise<WslRoots[]> | null = null;
  private wslSaved: WslSaved | null = null;
  private readonly gatewayTitles = new Map<string, { last: string; title: string }>();
  private wslSavedText = "";

  constructor(options: ExternalSessionsServiceOptions) {
    this.neolixHome = options.neolixHome;
    this.homeDir = options.homeDir ?? homedir();
    this.roots = resolveSessionRoots(this.homeDir, options.env ?? process.env);
    this.pricer = options.pricer;
    this.conversations = options.conversations;
    this.now = options.now ?? Date.now;
    this.wslEnabled = options.wslEnabled ?? (() => true);
    this.reads = options.reads ?? (() => DEFAULT_SESSION_READS);
  }

  public async list(
    requestedAgent?: string,
    options: { activityDays?: number } = {},
  ): Promise<ExternalSessionsList> {
    await this.conversations?.prune(this.now());
    const [filesByAgent, gatewayUsage, allTrash] = await Promise.all([
      this.allFiles(),
      readGatewaySessionUsage(this.neolixHome),
      listTrash(this.neolixHome),
    ]);
    const trash = allTrash.filter((entry) => this.mayRead(entry.agent));
    const sessionsByAgent = new Map<string, ExternalSession[]>();
    const nativeIds = new Map<string, Set<string>>();
    for (const agent of EXTERNAL_SESSION_AGENTS) {
      const files = this.mayRead(agent) ? (filesByAgent.get(agent) ?? []) : [];
      const parsed = await this.parseFiles(files);
      sessionsByAgent.set(agent, parsed);
      nativeIds.set(agent, new Set(files.map((file) => file.id)));
    }
    const openCode = this.mayRead("opencode") ? await this.openCodeSessions() : [];
    if (openCode.length > 0) {
      sessionsByAgent.set("opencode", openCode);
      nativeIds.set("opencode", new Set(openCode.map((session) => session.id)));
    }
    await this.addGatewaySessions(sessionsByAgent, nativeIds, gatewayUsage);
    await this.applyWslSaved(sessionsByAgent, nativeIds);
    const agents = this.agentsWithCounts(sessionsByAgent);
    const agent = pickAgent(agents, requestedAgent);
    const sessions = sessionsByAgent.get(agent) ?? [];
    sessions.sort((a, b) => b.last.localeCompare(a.last));
    if (options.activityDays !== undefined) {
      await this.addActivity(sessions, options.activityDays);
    }
    const [recording, recorded] = await Promise.all([
      Promise.resolve(this.conversations?.isEnabled() ?? false),
      this.conversations?.hasContent() ?? Promise.resolve(false),
    ]);
    return {
      agents,
      agent,
      sessions,
      trash,
      trashDir: sessionsTrashDir(this.neolixHome),
      home: this.homeDir,
      recording,
      recorded,
    };
  }

  /**
   * Every local session across agents, without gateway-only ones or the
   * per-agent list bookkeeping. The OTel session exporter reads this.
   */
  public async listAll(): Promise<ExternalSession[]> {
    const filesByAgent = await this.allFiles();
    const out: ExternalSession[] = [];
    for (const agent of EXTERNAL_SESSION_AGENTS) {
      if (!this.mayRead(agent)) {
        continue;
      }
      out.push(...(await this.parseFiles(filesByAgent.get(agent) ?? [])));
    }
    if (this.mayRead("opencode")) {
      out.push(...(await this.openCodeSessions()));
    }
    return out;
  }

  public async search(agent: string, query: string): Promise<SessionSearchResult> {
    this.refuseUnread(agent);
    if (agent === "opencode") {
      return this.searchOpenCode(query);
    }
    const files = await this.listAgentFiles(agent);
    return searchSessionFiles({
      agent,
      files,
      query,
      budgetMs: SEARCH_BUDGET_MS,
      now: this.now,
    });
  }

  /** What was said in a session (or one of its subagents), a page at a time. */
  public async transcript(input: {
    agent: string;
    id: string;
    sub?: string | undefined;
    offset?: number | undefined;
    limit?: number | undefined;
  }): Promise<{ parts: TranscriptPart[]; total: number; cut: boolean; source: string }> {
    this.refuseUnread(input.agent);
    const target = await this.findSession(input.agent, input.id);
    if (target === null) {
      throw new Error("no such session");
    }
    const transcript = await this.readTargetTranscript(target, input.sub);
    const offset = Math.max(0, Math.trunc(input.offset ?? 0));
    const limit = Math.min(
      TRANSCRIPT_PARTS_MAX,
      Math.max(1, Math.trunc(input.limit ?? TRANSCRIPT_PARTS)),
    );
    return {
      parts: transcript.parts.slice(offset, offset + limit),
      total: transcript.parts.length,
      cut: transcript.cut,
      source: transcript.source,
    };
  }

  /**
   * A session's resume line and folder, for opening in a terminal. The
   * command is the one this service listed, never one the page sent; Neolix's
   * own `cd '<cwd>' && ` prefix (an Antigravity resume carries it) is dropped
   * because the terminal script adds its own cd.
   */
  public async sessionForTerminal(
    agent: string,
    id: string,
  ): Promise<{ command: string; cwd: string; title: string } | null> {
    this.refuseUnread(agent);
    const target = await this.findSession(agent, id);
    if (target === null || target.session.resume.length === 0) {
      return null;
    }
    return {
      command: terminalCommandOf(target.session.resume, target.session.cwd),
      cwd: target.session.cwd,
      title: target.session.title,
    };
  }

  /** A session's whole conversation as Markdown, in myna's export shape. */
  public async exportMarkdown(
    agent: string,
    id: string,
  ): Promise<{ fileName: string; markdown: string }> {
    this.refuseUnread(agent);
    const target = await this.findSession(agent, id);
    if (target === null) {
      throw new Error("no such session");
    }
    const transcript = await this.readTargetTranscript(target, undefined);
    const session = { ...target.session };
    if (session.gateway === true) {
      const asked = transcript.parts.find((part) => part.role === "user" && part.kind === "text");
      if (asked !== undefined) {
        const title = cleanTitle(asked.text);
        if (title.length > 0) {
          session.title = title;
        }
      }
    }
    return renderSessionMarkdown({
      session,
      agentName: agentLabel(agent),
      parts: transcript.parts,
      cut: transcript.cut,
    });
  }

  /** Moves Codex sessions to the provider Codex uses now, backing them up. */
  public async codexProvider(
    moves: readonly { id: string; to: string }[],
  ): Promise<{ moved: ExternalCodexMove[]; refused: ExternalSessionRefusal[] }> {
    this.refuseUnread("codex");
    const files = await this.listAgentFiles("codex");
    const byId = new Map(files.map((file) => [file.id, file]));
    this.codexConfig ??= readCodexConfig(this.roots.codex);
    const config = await this.codexConfig;
    const moved: ExternalCodexMove[] = [];
    const refused: ExternalSessionRefusal[] = [];
    for (const move of moves) {
      const file = byId.get(move.id);
      if (file === undefined) {
        refused.push({ id: move.id, error: "no such session", active: false });
        continue;
      }
      try {
        const result = await moveCodexProvider({
          neolixHome: this.neolixHome,
          codexHome: this.roots.codex,
          id: move.id,
          paths: [file.path, rolloutTwin(file.path)],
          to: move.to,
          now: this.now(),
          sqliteHome: config.sqliteHome,
        });
        this.parses.delete(file.path);
        moved.push(result);
      } catch (error) {
        refused.push({
          id: move.id,
          error: errorMessage(error),
          active: error instanceof ActiveExternalSessionError,
        });
      }
    }
    return { moved, refused };
  }

  /**
   * Moves a Claude project's sessions to the folder another absolute path
   * encodes: without a token it only previews, and the token it returns must
   * come back for the move to run.
   */
  public async relocateClaude(input: {
    from: string;
    to: string;
    token?: string | undefined;
  }): Promise<{
    preview: ExternalRelocatePreview | null;
    token: string | null;
    backup: string | null;
  }> {
    this.refuseUnread("claude");
    if (input.token === undefined || input.token.length === 0) {
      const result = await previewClaudeRelocation({
        configDir: this.roots.claude,
        from: input.from,
        to: input.to,
      });
      this.previewed.set(result.token, { from: input.from, to: input.to, at: this.now() });
      return {
        preview: {
          from: result.from,
          to: result.to,
          sessions: result.sessions,
          bytes: result.bytes,
        },
        token: result.token,
        backup: null,
      };
    }
    const known = this.previewed.get(input.token);
    if (
      known === undefined ||
      known.from !== input.from ||
      known.to !== input.to ||
      this.now() - known.at > PREVIEW_TTL_MS
    ) {
      throw new Error("preview the relocation again");
    }
    const applied = await applyClaudeRelocation({
      configDir: this.roots.claude,
      neolixHome: this.neolixHome,
      from: input.from,
      to: input.to,
      token: input.token,
    });
    this.previewed.delete(input.token);
    // Every session path this service remembered moved with the folder.
    this.parses.clear();
    return { preview: null, token: null, backup: applied.backup };
  }

  public async delete(
    agent: string,
    ids: readonly string[],
  ): Promise<{ deleted: string[]; refused: ExternalSessionRefusal[] }> {
    this.refuseUnread(agent);
    const files = await this.listAgentFiles(agent);
    const byId = new Map(files.map((file) => [file.id, file]));
    const usage = await readGatewaySessionUsage(this.neolixHome);
    const deleted: string[] = [];
    const refused: ExternalSessionRefusal[] = [];
    for (const id of ids) {
      try {
        await this.deleteOne(agent, id, byId.get(id) ?? null, usage.get(identityOf(agent, id)));
        deleted.push(id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        refused.push({ id, error: message, active: isActiveError(error) });
      }
    }
    return { deleted, refused };
  }

  public async restore(key: string): Promise<{ agent: string; id: string; title: string }> {
    const manifest = await restoreFromTrash(this.neolixHome, key);
    if (manifest.gateway === true && this.conversations !== undefined) {
      await this.conversations.unhide(manifest.agent, manifest.id);
    }
    return { agent: manifest.agent, id: manifest.id, title: manifest.title };
  }

  public async purge(
    keys: readonly string[],
  ): Promise<{ purged: string[]; refused: { key: string; error: string }[] }> {
    const purged: string[] = [];
    const refused: { key: string; error: string }[] = [];
    for (const key of keys) {
      try {
        await purgeFromTrash(this.neolixHome, key);
        purged.push(key);
      } catch (error) {
        refused.push({ key, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return { purged, refused };
  }

  public trashKeys(): Promise<string[]> {
    return listTrash(this.neolixHome).then((entries) => entries.map((entry) => entry.key));
  }

  private async deleteOne(
    agent: string,
    id: string,
    file: SessionFile | null,
    usage: GatewaySessionUsage | undefined,
  ): Promise<void> {
    if (file !== null) {
      const info = await stat(file.path);
      if (this.now() - info.mtimeMs < ACTIVE_WINDOW_MS) {
        throw new ActiveSessionError();
      }
      const paths = [file.path, ...(await companionPaths(agent, file))];
      const parse = await this.parse(file);
      await moveToTrash({
        neolixHome: this.neolixHome,
        agent,
        id,
        title: parse.title.length > 0 ? parse.title : id,
        cwd: parse.cwd,
        last: parse.last.length > 0 ? parse.last : new Date(info.mtimeMs).toISOString(),
        size: info.size,
        paths,
      });
      return;
    }
    if (usage === undefined) {
      throw new Error(`${id} is not a session of ${agentLabel(agent)}`);
    }
    const paths = (await this.conversations?.pathsOf(agent, id)) ?? [];
    const size = (await this.conversations?.sizeOf(agent, id)) ?? 0;
    await moveToTrash({
      neolixHome: this.neolixHome,
      agent,
      id,
      title: id,
      cwd: "",
      last: usage.last,
      size,
      paths,
      gateway: true,
    });
    await this.conversations?.hide(agent, id, usage.last);
  }

  /**
   * Reads each session's per-day activity from its transcript, for the CLI's
   * `--days` table (myna's Day.Active). Only the agents whose transcripts
   * carry line timestamps have it; the others' columns stay empty.
   */
  private async addActivity(sessions: ExternalSession[], days: number): Promise<void> {
    const since = days > 0 ? startOfDays(this.now(), days) : null;
    const candidates = sessions.filter(
      (session) =>
        TRACE_AGENTS.has(session.agent) &&
        session.path.length > 0 &&
        (since === null || new Date(session.last) >= since),
    );
    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const session = candidates[next];
        next += 1;
        if (session === undefined) {
          return;
        }
        try {
          const spans = await readSessionTraceSpans({
            agent: session.agent,
            session: session.id,
            path: session.path,
          });
          const activity = activityOfSpans(spans);
          if (activity.length > 0) {
            session.activity = activity;
          }
        } catch {
          // An unreadable transcript leaves the day's activity empty.
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(PARSE_CONCURRENCY, candidates.length) }, worker),
    );
  }

  /** Whether the user's consent lets Neolix read agent's session files. */
  private mayRead(agent: string): boolean {
    return readsSessions(this.reads(), agent);
  }

  private refuseUnread(agent: string): void {
    if (!this.mayRead(agent)) {
      throw new SessionNotReadError();
    }
  }

  private async allFiles(): Promise<Map<ExternalSessionAgentId, SessionFile[]>> {
    const out = new Map<ExternalSessionAgentId, SessionFile[]>();
    for (const agent of EXTERNAL_SESSION_AGENTS) {
      // A folder the user did not allow is not even listed (myna's allowed()).
      out.set(agent, this.mayRead(agent) ? await this.listAgentFiles(agent) : []);
    }
    return out;
  }

  private async agyMeta(id: string): Promise<{ title?: string; cwd?: string } | undefined> {
    const dbPath = path.join(this.roots.agy, "conversation_summaries.db");
    const info = await stat(dbPath).catch(() => null);
    if (info === null) {
      return undefined;
    }
    const wal = await stat(`${dbPath}-wal`).catch(() => null);
    const rev = `${info.mtimeMs}:${info.size}:${wal?.mtimeMs ?? 0}:${wal?.size ?? 0}`;
    if (this.agyCache === null || this.agyCache.rev !== rev) {
      this.agyCache = { rev, rows: readAgySummaries(dbPath) };
    }
    const row = this.agyCache.rows.get(id);
    if (row === undefined) {
      return undefined;
    }
    return { title: row.title, cwd: row.cwd };
  }

  /** Searches OpenCode's messages in its own database, under the same budget. */
  private async searchOpenCode(query: string): Promise<SessionSearchResult> {
    const needle = normalizeQuery(query);
    const result: SessionSearchResult = { hits: [], searched: 0, total: 0, cut: false };
    if (needle.length < 2) {
      return result;
    }
    const sessions = [...(await this.openCodeSessions())].sort((a, b) =>
      b.last.localeCompare(a.last),
    );
    result.total = sessions.length;
    const deadline = this.now() + SEARCH_BUDGET_MS;
    for (const session of sessions) {
      if (result.hits.length >= HIT_MAX || this.now() > deadline) {
        result.cut = true;
        break;
      }
      result.searched += 1;
      const store = this.openCodeStore(session.id);
      if (store === null) {
        continue;
      }
      const transcript = readOpenCodeTranscript(this.roots.opencode, store);
      const hit = bestHitInParts(transcript.parts, needle);
      if (hit !== null) {
        result.hits.push({ id: session.id, ...hit });
      }
    }
    if (result.searched < result.total) {
      result.cut = true;
    }
    return result;
  }

  private openCodeTranscript(id: string) {
    const store = this.openCodeStore(id);
    if (store === null) {
      throw new Error("no such session");
    }
    return readOpenCodeTranscript(this.roots.opencode, store);
  }

  private async openCodeSessions(): Promise<ExternalSession[]> {
    const info = await stat(this.roots.opencode).catch(() => null);
    if (info === null) {
      return [];
    }
    const wal = await stat(`${this.roots.opencode}-wal`).catch(() => null);
    const mtimeMs = Math.max(info.mtimeMs, wal?.mtimeMs ?? 0);
    if (this.openCodeCache !== null && this.openCodeCache.mtimeMs === mtimeMs) {
      return this.openCodeCache.sessions;
    }
    const rows = readOpenCodeSessions(this.roots.opencode);
    const sessions = readOpenCodeListing(this.roots.opencode, rows);
    this.openCodeCache = {
      mtimeMs,
      sessions,
      stores: new Map(rows.map((row) => [row.id, row.store])),
    };
    return sessions;
  }

  private openCodeStore(id: string): { id: string; store: "v1" | "v2" } | null {
    const store = this.openCodeCache?.stores.get(id);
    if (store !== undefined) {
      return { id, store };
    }
    return openCodeStoreOf(this.roots.opencode, id);
  }

  /** The session as listed, found from its agent and id, never from a path. */
  private async findSession(
    agent: string,
    id: string,
  ): Promise<{ file: SessionFile | null; session: ExternalSession } | null> {
    if (!isExternalAgent(agent)) {
      return null;
    }
    const files = await this.listAgentFiles(agent);
    const file = files.find((entry) => entry.id === id) ?? null;
    if (file !== null) {
      const session = this.toSession(file, await this.parse(file));
      await this.attachSubagents(session, file);
      return { file, session };
    }
    if (agent === "opencode") {
      const session = (await this.openCodeSessions()).find((entry) => entry.id === id);
      if (session !== undefined) {
        return { file: null, session };
      }
    }
    const usage = (await readGatewaySessionUsage(this.neolixHome)).get(identityOf(agent, id));
    if (usage === undefined) {
      return null;
    }
    const size = (await this.conversations?.sizeOf(agent, id)) ?? 0;
    return { file: null, session: this.gatewaySession(agent, usage, size) };
  }

  private async readTargetTranscript(
    target: { file: SessionFile | null; session: ExternalSession },
    sub: string | undefined,
  ) {
    if (sub !== undefined && sub.length > 0) {
      if (target.session.subagents?.some((entry) => entry.id === sub) !== true) {
        throw new Error("no such subagent in this session");
      }
      if (target.session.agent === "opencode") {
        return this.openCodeTranscript(sub);
      }
      const file = target.file;
      if (file === null) {
        throw new Error("no such subagent in this session");
      }
      const subPath = claudeSubagentPath(file, sub);
      if (subPath === null) {
        throw new Error("no such subagent in this session");
      }
      return readTranscript({ agent: file.agent, path: subPath });
    }
    if (target.session.agent === "opencode") {
      return this.openCodeTranscript(target.session.id);
    }
    if (target.file !== null) {
      return readTranscript({ agent: target.file.agent, path: target.file.path });
    }
    const recorded = await this.conversations?.transcriptOf(
      target.session.agent,
      target.session.id,
    );
    if (recorded === undefined) {
      throw new Error("no saved gateway content for this session");
    }
    return recorded;
  }

  private async attachProvider(session: ExternalSession, file: SessionFile): Promise<void> {
    if (file.agent !== "codex") {
      return;
    }
    this.codexConfig ??= readCodexConfig(this.roots.codex);
    session.usesProvider = (await this.codexConfig).provider;
  }

  private async attachSubagents(session: ExternalSession, file: SessionFile): Promise<void> {
    if (file.agent !== "claude") {
      return;
    }
    const subagents = await listClaudeSubagents(file);
    if (subagents.length > 0) {
      session.subagents = subagents;
    }
  }

  /** What a gateway session was first asked, kept until its record changes. */
  private async gatewayTitle(agent: string, id: string, last: string): Promise<string> {
    const key = `${agent}\u0000${id}`;
    const held = this.gatewayTitles.get(key);
    if (held !== undefined && held.last === last) {
      return held.title;
    }
    const recorded = await this.conversations?.transcriptOf(agent, id);
    const asked = recorded?.parts.find((part) => part.role === "user" && part.kind === "text");
    const title = asked === undefined ? "" : cleanTitle(asked.text);
    // debt: the cache keeps one title per gateway session with no cap; trim by
    // age if a host ever sees tens of thousands of them.
    this.gatewayTitles.set(key, { last, title });
    return title;
  }

  private gatewaySession(agent: string, usage: GatewaySessionUsage, size: number): ExternalSession {
    return {
      id: usage.session,
      agent,
      cwd: "",
      title: usage.session,
      start: usage.start,
      last: usage.last,
      messages: 0,
      size,
      tokens: usage.tokens,
      models: usage.via.map((via) => ({
        model: via.model,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        cost: 0,
        priced: false,
      })),
      cost: usage.cost,
      priced: usage.cost > 0,
      resume: "",
      path: "",
      deletable: true,
      gateway: true,
      via: usage.via,
    };
  }

  private async listAgentFiles(agent: string): Promise<SessionFile[]> {
    if (!isExternalAgent(agent)) {
      return [];
    }
    const files = await listSessionFiles(agent, this.roots);
    const wsl = await this.wslFilesOf(agent);
    if (wsl.length === 0) {
      return files;
    }
    return [...files, ...wsl].sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, WSL_FILE_MAX);
  }

  /** The same agent's sessions in each running WSL distro, on Windows. */
  /**
   * Adds what a stopped distro held when it was last listed, and keeps the
   * running distros' listings for the next time one stops.
   */
  private async applyWslSaved(
    sessionsByAgent: Map<string, ExternalSession[]>,
    nativeIds: Map<string, Set<string>>,
  ): Promise<void> {
    // Off: no distro is listed or probed, and none of a distro's sessions is
    // shown, even one listed while it was on (myna's wslLooks).
    if (!this.wslEnabled()) return;
    this.wslRoots ??= discoverWslRoots();
    const roots = await this.wslRoots;
    const running = new Set(roots.map((entry) => entry.distro));
    this.wslSaved ??= await readWslSaved(this.neolixHome);
    for (const [distro, entry] of Object.entries(this.wslSaved.distros)) {
      if (running.has(distro)) {
        continue;
      }
      for (const saved of entry.sessions) {
        if (!this.mayRead(saved.agent)) {
          continue;
        }
        const sessions = sessionsByAgent.get(saved.agent) ?? [];
        if (sessions.some((session) => session.id === saved.id)) {
          continue;
        }
        sessions.push(saved);
        sessionsByAgent.set(saved.agent, sessions);
        nativeIds.get(saved.agent)?.add(saved.id);
      }
    }
    const distros: Record<string, WslSavedDistro> = {};
    for (const entry of roots) {
      const sessions: ExternalSession[] = [];
      for (const list of sessionsByAgent.values()) {
        for (const session of list) {
          if (session.wsl === entry.distro) {
            sessions.push(session);
          }
        }
      }
      sessions.sort((a, b) => b.last.localeCompare(a.last));
      distros[entry.distro] = { home: wslHomeOf(entry), sessions };
    }
    for (const [distro, entry] of Object.entries(this.wslSaved.distros)) {
      if (!running.has(distro)) {
        distros[distro] = entry;
      }
    }
    const next: WslSaved = { version: 1, distros };
    const text = JSON.stringify(next);
    if (text === this.wslSavedText) {
      return;
    }
    this.wslSavedText = text;
    this.wslSaved = next;
    await writeWslSaved(this.neolixHome, next).catch(() => {});
  }

  private async wslFilesOf(agent: ExternalSessionAgentId): Promise<SessionFile[]> {
    if (!this.wslEnabled()) return [];
    this.wslRoots ??= discoverWslRoots();
    const roots = await this.wslRoots;
    if (roots.length === 0) {
      return [];
    }
    const out: SessionFile[] = [];
    for (const entry of roots) {
      if (entry.roots[agent].length === 0) {
        continue;
      }
      const files = await listSessionFiles(agent, entry.roots);
      for (const file of files) {
        out.push({ ...file, wsl: entry.distro });
      }
    }
    return out;
  }

  private async parseFiles(files: readonly SessionFile[]): Promise<ExternalSession[]> {
    const newest = files.slice(0, PARSE_LIMIT);
    const out: ExternalSession[] = [];
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < newest.length) {
        const index = cursor;
        cursor += 1;
        const file = newest[index];
        if (file === undefined) {
          return;
        }
        const parse = await this.parse(file);
        const session = this.toSession(file, parse);
        await this.attachSubagents(session, file);
        await this.attachProvider(session, file);
        out.push(session);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(PARSE_CONCURRENCY, newest.length) }, () => worker()),
    );
    return out;
  }

  private async parse(file: SessionFile): Promise<SessionParse> {
    const meta = file.agent === "agy" ? await this.agyMeta(file.id) : undefined;
    const metaKey = meta === undefined ? "" : `${meta.title}\u0000${meta.cwd}`;
    const cached = this.parses.get(file.path);
    if (
      cached !== undefined &&
      cached.mtimeMs === file.mtimeMs &&
      cached.size === file.size &&
      cached.metaKey === metaKey
    ) {
      return cached.parse;
    }
    const pending = this.parsing.get(file.path);
    if (pending !== undefined) {
      return pending;
    }
    const run = readSessionFile({
      agent: file.agent,
      path: file.path,
      ...(this.pricer === undefined ? {} : { pricer: this.pricer }),
      ...(meta === undefined ? {} : { meta }),
    })
      .catch((): SessionParse => emptyParse(file))
      .then((parse) => {
        this.parses.set(file.path, { mtimeMs: file.mtimeMs, size: file.size, metaKey, parse });
        this.parsing.delete(file.path);
        return parse;
      });
    this.parsing.set(file.path, run);
    return run;
  }

  private toSession(file: SessionFile, parse: SessionParse): ExternalSession {
    const last = parse.last.length > 0 ? parse.last : new Date(file.mtimeMs).toISOString();
    const start = parse.start.length > 0 ? parse.start : last;
    return {
      id: file.id,
      agent: file.agent,
      cwd: parse.cwd,
      title: parse.title.length > 0 ? parse.title : file.id,
      start,
      last,
      messages: parse.messages,
      size: file.size,
      tokens: parse.tokens,
      models: parse.models,
      cost: parse.cost,
      priced: parse.priced,
      resume: resumeCommand(file.agent, file.id, {
        ...(parse.cwd.length === 0 ? {} : { cwd: parse.cwd }),
        ...(file.wsl === undefined ? {} : { wsl: file.wsl }),
      }),
      ...(file.wsl === undefined ? {} : { wsl: file.wsl }),
      path: file.path,
      deletable: canDelete(file.agent),
      ...(parse.provider === undefined || parse.provider.length === 0
        ? {}
        : { provider: parse.provider }),
    };
  }

  private async addGatewaySessions(
    sessionsByAgent: Map<string, ExternalSession[]>,
    nativeIds: Map<string, Set<string>>,
    usage: Map<string, GatewaySessionUsage>,
  ): Promise<void> {
    for (const entry of usage.values()) {
      if (!this.mayRead(entry.agent)) {
        continue;
      }
      const native = nativeIds.get(entry.agent);
      if (native === undefined || native.has(entry.session)) {
        continue;
      }
      const hidden = await this.conversations?.hiddenSince(entry.agent, entry.session);
      if (hidden !== null && hidden !== undefined && hidden >= entry.last) {
        continue;
      }
      const size = (await this.conversations?.sizeOf(entry.agent, entry.session)) ?? 0;
      const session = this.gatewaySession(entry.agent, entry, size);
      const title = await this.gatewayTitle(entry.agent, entry.session, entry.last);
      if (title.length > 0) {
        session.title = title;
      }
      const sessions = sessionsByAgent.get(entry.agent) ?? [];
      sessions.push(session);
      sessionsByAgent.set(entry.agent, sessions);
    }
    for (const [agent, sessions] of sessionsByAgent) {
      const native = nativeIds.get(agent) ?? new Set<string>();
      for (const session of sessions) {
        if (session.gateway === true || native.has(session.id)) {
          continue;
        }
        const via = usage.get(identityOf(agent, session.id));
        if (via !== undefined && via.via.length > 0) {
          session.via = via.via;
        }
      }
    }
  }

  private agentsWithCounts(
    sessionsByAgent: Map<string, ExternalSession[]>,
  ): ExternalSessionAgent[] {
    const agents: ExternalSessionAgent[] = [];
    for (const agent of EXTERNAL_SESSION_AGENTS) {
      const count = sessionsByAgent.get(agent)?.length ?? 0;
      if (count === 0) {
        continue;
      }
      agents.push({
        agent,
        name: agentLabel(agent),
        count,
        deletable: canDelete(agent),
      });
    }
    agents.sort((a, b) =>
      a.count === b.count ? a.agent.localeCompare(b.agent) : b.count - a.count,
    );
    return agents;
  }
}

class ActiveSessionError extends Error {
  constructor() {
    super("The session was written to in the last minute; it may still be running");
    this.name = "ActiveSessionError";
  }
}

function isActiveError(error: unknown): boolean {
  return error instanceof ActiveSessionError;
}

function rolloutTwin(file: string): string {
  return isPacked(file) ? file.slice(0, -".zst".length) : `${file}.zst`;
}

function wslHomeOf(entry: WslRoots): string {
  return entry.roots.claude.replace(/\\\.claude$/u, "");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pickAgent(agents: readonly ExternalSessionAgent[], requested?: string): string {
  if (requested !== undefined && agents.some((agent) => agent.agent === requested)) {
    return requested;
  }
  return agents[0]?.agent ?? "";
}

export function isExternalAgent(agent: string): agent is ExternalSessionAgentId {
  return (EXTERNAL_SESSION_AGENTS as readonly string[]).includes(agent);
}

async function companionPaths(agent: string, file: SessionFile): Promise<string[]> {
  if (agent === "agy" && !file.path.endsWith(".db")) {
    // An Antigravity conversation is its whole brain folder.
    const dir = path.resolve(file.path, "..", "..", "..");
    try {
      const info = await stat(dir);
      return info.isDirectory() ? [dir] : [];
    } catch {
      return [];
    }
  }
  if (agent !== "claude") {
    return [];
  }
  // A Claude session's subagent transcripts live in a folder named after it.
  const dir = path.join(path.dirname(file.path), file.id);
  try {
    const info = await stat(dir);
    return info.isDirectory() ? [dir] : [];
  } catch {
    return [];
  }
}

function emptyParse(file: SessionFile): SessionParse {
  const last = new Date(file.mtimeMs).toISOString();
  return {
    title: "",
    cwd: "",
    start: last,
    last,
    messages: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    models: [],
    cost: 0,
    priced: false,
  };
}

/** The local midnight that starts a range of days, today included. */
function startOfDays(now: number, days: number): Date {
  const today = new Date(now);
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  start.setDate(start.getDate() - (days - 1));
  return start;
}
