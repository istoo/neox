import type { SessionInboundMessage, SessionOutboundMessage } from "../messages.js";
import type { GatewayConversations } from "../llm-gateway/conversations.js";
import type { ExternalSessionsService } from "./service.js";
import type { SessionReadsSnapshot } from "./session-reads.js";
import type { SessionTerminalList } from "./terminals.js";

/** The Mac terminals the host can open, and the one call that opens one. */
export interface ExternalSessionsTerminalHost {
  list(): Promise<SessionTerminalList>;
  open(input: { command: string; cwd: string; label: string }): Promise<void>;
}

/** The consent setting's home, which the session wires to gateway.json. */
export interface ExternalSessionsReadsHost {
  snapshot(): Promise<SessionReadsSnapshot>;
  set(input: {
    all?: boolean | undefined;
    agents?: Record<string, boolean> | undefined;
  }): Promise<SessionReadsSnapshot>;
}

export interface ExternalSessionsSessionOptions {
  service: ExternalSessionsService;
  conversations: GatewayConversations | undefined;
  reads?: ExternalSessionsReadsHost | undefined;
  terminals?: ExternalSessionsTerminalHost | undefined;
  emit(message: SessionOutboundMessage): void;
}

/** The Settings → Use → Sessions RPCs. */
export class ExternalSessionsSession {
  constructor(private readonly options: ExternalSessionsSessionOptions) {}

  public async handleList(
    msg: Extract<SessionInboundMessage, { type: "sessions.external.list.request" }>,
  ): Promise<void> {
    try {
      const list = await this.options.service.list(
        msg.agent,
        msg.activityDays === undefined ? {} : { activityDays: msg.activityDays },
      );
      this.options.emit({
        type: "sessions.external.list.response",
        payload: { requestId: msg.requestId, ...list, error: null },
      });
    } catch (error) {
      this.options.emit({
        type: "sessions.external.list.response",
        payload: {
          requestId: msg.requestId,
          agents: [],
          agent: "",
          sessions: [],
          trash: [],
          trashDir: "",
          home: "",
          recording: this.options.conversations?.isEnabled() ?? false,
          recorded: false,
          error: messageOf(error),
        },
      });
    }
  }

  public async handleSearch(
    msg: Extract<SessionInboundMessage, { type: "sessions.external.search.request" }>,
  ): Promise<void> {
    try {
      const result = await this.options.service.search(msg.agent, msg.query);
      this.options.emit({
        type: "sessions.external.search.response",
        payload: { requestId: msg.requestId, ...result, error: null },
      });
    } catch (error) {
      this.options.emit({
        type: "sessions.external.search.response",
        payload: {
          requestId: msg.requestId,
          hits: [],
          searched: 0,
          total: 0,
          cut: false,
          error: messageOf(error),
        },
      });
    }
  }

  public async handleDelete(
    msg: Extract<SessionInboundMessage, { type: "sessions.external.delete.request" }>,
  ): Promise<void> {
    try {
      const result = await this.options.service.delete(msg.agent, msg.ids);
      this.options.emit({
        type: "sessions.external.delete.response",
        payload: { requestId: msg.requestId, ...result, error: null },
      });
    } catch (error) {
      this.options.emit({
        type: "sessions.external.delete.response",
        payload: { requestId: msg.requestId, deleted: [], refused: [], error: messageOf(error) },
      });
    }
  }

  public async handleRestore(
    msg: Extract<SessionInboundMessage, { type: "sessions.external.restore.request" }>,
  ): Promise<void> {
    try {
      const restored = await this.options.service.restore(msg.key);
      this.options.emit({
        type: "sessions.external.restore.response",
        payload: { requestId: msg.requestId, ...restored, error: null },
      });
    } catch (error) {
      this.options.emit({
        type: "sessions.external.restore.response",
        payload: {
          requestId: msg.requestId,
          agent: "",
          id: "",
          title: "",
          error: messageOf(error),
        },
      });
    }
  }

  public async handlePurge(
    msg: Extract<SessionInboundMessage, { type: "sessions.external.purge.request" }>,
  ): Promise<void> {
    try {
      const keys = msg.all === true ? await this.options.service.trashKeys() : (msg.keys ?? []);
      const result = await this.options.service.purge(keys);
      this.options.emit({
        type: "sessions.external.purge.response",
        payload: { requestId: msg.requestId, ...result, error: null },
      });
    } catch (error) {
      this.options.emit({
        type: "sessions.external.purge.response",
        payload: { requestId: msg.requestId, purged: [], refused: [], error: messageOf(error) },
      });
    }
  }

  public async handleTranscript(
    msg: Extract<SessionInboundMessage, { type: "sessions.external.transcript.request" }>,
  ): Promise<void> {
    try {
      const result = await this.options.service.transcript({
        agent: msg.agent,
        id: msg.id,
        sub: msg.sub,
        offset: msg.offset,
        limit: msg.limit,
      });
      this.options.emit({
        type: "sessions.external.transcript.response",
        payload: { requestId: msg.requestId, ...result, error: null },
      });
    } catch (error) {
      this.options.emit({
        type: "sessions.external.transcript.response",
        payload: {
          requestId: msg.requestId,
          parts: [],
          total: 0,
          cut: false,
          source: "",
          error: messageOf(error),
        },
      });
    }
  }

  public async handleExport(
    msg: Extract<SessionInboundMessage, { type: "sessions.external.export.request" }>,
  ): Promise<void> {
    try {
      const result = await this.options.service.exportMarkdown(msg.agent, msg.id);
      this.options.emit({
        type: "sessions.external.export.response",
        payload: { requestId: msg.requestId, ...result, error: null },
      });
    } catch (error) {
      this.options.emit({
        type: "sessions.external.export.response",
        payload: { requestId: msg.requestId, fileName: "", markdown: "", error: messageOf(error) },
      });
    }
  }

  public async handleCodexProvider(
    msg: Extract<SessionInboundMessage, { type: "sessions.external.codex_provider.request" }>,
  ): Promise<void> {
    try {
      const result = await this.options.service.codexProvider(msg.moves);
      this.options.emit({
        type: "sessions.external.codex_provider.response",
        payload: { requestId: msg.requestId, ...result, error: null },
      });
    } catch (error) {
      this.options.emit({
        type: "sessions.external.codex_provider.response",
        payload: { requestId: msg.requestId, moved: [], refused: [], error: messageOf(error) },
      });
    }
  }

  public async handleRelocate(
    msg: Extract<SessionInboundMessage, { type: "sessions.external.relocate_claude.request" }>,
  ): Promise<void> {
    try {
      const result = await this.options.service.relocateClaude({
        from: msg.from,
        to: msg.to,
        token: msg.token,
      });
      this.options.emit({
        type: "sessions.external.relocate_claude.response",
        payload: { requestId: msg.requestId, ...result, error: null },
      });
    } catch (error) {
      this.options.emit({
        type: "sessions.external.relocate_claude.response",
        payload: {
          requestId: msg.requestId,
          preview: null,
          token: null,
          backup: null,
          error: messageOf(error),
        },
      });
    }
  }

  /** Which agents' sessions may be read, for the Sessions page and Settings. */
  public async handleReadsGet(
    msg: Extract<SessionInboundMessage, { type: "sessions.reads.get.request" }>,
  ): Promise<void> {
    try {
      const snapshot = await this.readsHost().snapshot();
      this.options.emit({
        type: "sessions.reads.get.response",
        payload: { requestId: msg.requestId, snapshot, error: null },
      });
    } catch (error) {
      this.options.emit({
        type: "sessions.reads.get.response",
        payload: { requestId: msg.requestId, snapshot: null, error: messageOf(error) },
      });
    }
  }

  public async handleReadsSet(
    msg: Extract<SessionInboundMessage, { type: "sessions.reads.set.request" }>,
  ): Promise<void> {
    try {
      const snapshot = await this.readsHost().set({
        all: msg.all,
        agents: msg.agents,
      });
      this.options.emit({
        type: "sessions.reads.set.response",
        payload: { requestId: msg.requestId, snapshot, error: null },
      });
    } catch (error) {
      this.options.emit({
        type: "sessions.reads.set.response",
        payload: { requestId: msg.requestId, snapshot: null, error: messageOf(error) },
      });
    }
  }

  /** The Mac terminals this host can open a session in (myna's session terminal). */
  public async handleTerminalsList(
    msg: Extract<SessionInboundMessage, { type: "sessions.terminals.list.request" }>,
  ): Promise<void> {
    try {
      const list = await this.terminalsHost().list();
      this.options.emit({
        type: "sessions.terminals.list.response",
        payload: {
          requestId: msg.requestId,
          supported: list.supported,
          apps: list.apps,
          defaultId: list.defaultId,
          error: null,
        },
      });
    } catch (error) {
      this.options.emit({
        type: "sessions.terminals.list.response",
        payload: {
          requestId: msg.requestId,
          supported: false,
          apps: [],
          defaultId: null,
          error: messageOf(error),
        },
      });
    }
  }

  /** Opens a session's own resume line in a terminal on the host. */
  public async handleOpenInTerminal(
    msg: Extract<SessionInboundMessage, { type: "sessions.open_in_terminal.request" }>,
  ): Promise<void> {
    try {
      const session = await this.options.service.sessionForTerminal(msg.agent, msg.id);
      if (session === null) {
        throw new Error("no such session, or it has no resume command");
      }
      await this.terminalsHost().open({
        command: session.command,
        cwd: session.cwd,
        label: session.title,
      });
      this.options.emit({
        type: "sessions.open_in_terminal.response",
        payload: { requestId: msg.requestId, opened: true, error: null },
      });
    } catch (error) {
      this.options.emit({
        type: "sessions.open_in_terminal.response",
        payload: { requestId: msg.requestId, opened: false, error: messageOf(error) },
      });
    }
  }

  private terminalsHost(): ExternalSessionsTerminalHost {
    if (this.options.terminals === undefined) {
      throw new Error("This host opens no session terminals");
    }
    return this.options.terminals;
  }

  private readsHost(): ExternalSessionsReadsHost {
    if (this.options.reads === undefined) {
      throw new Error("This host keeps no session history setting");
    }
    return this.options.reads;
  }

  public async handleRecording(
    msg: Extract<SessionInboundMessage, { type: "sessions.recording.set.request" }>,
  ): Promise<void> {
    const conversations = this.options.conversations;
    try {
      if (conversations === undefined) {
        throw new Error("The gateway is unavailable on this host");
      }
      if (msg.clear === true) {
        await conversations.clear();
        await conversations.setEnabled(false);
      } else if (msg.on !== undefined) {
        await conversations.setEnabled(msg.on);
      }
      this.options.emit({
        type: "sessions.recording.set.response",
        payload: {
          requestId: msg.requestId,
          recording: conversations.isEnabled(),
          error: null,
        },
      });
    } catch (error) {
      this.options.emit({
        type: "sessions.recording.set.response",
        payload: {
          requestId: msg.requestId,
          recording: conversations?.isEnabled() ?? false,
          error: messageOf(error),
        },
      });
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
