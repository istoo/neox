// Synara project import backed by the Neox external-session reader.
//
// Neox can list the Codex/Claude sessions already on disk and resume one as a new agent. Synara
// exposes that as a project catalog (`listProjectImports`), per-item import (`importProject`) and
// a paged transcript for an imported thread (`loadProjectImportHistory`). Keys are derived from
// paths and session ids so the bridge can resolve them again without extra state:
//   projectKey = external session cwd
//   threadKey  = `${daemon agent}:${external session id}`
import {
  type ImportProjectInput,
  type ImportProjectResult,
  type ListProjectImportsInput,
  type ListProjectImportsResult,
  type LoadProjectImportHistoryInput,
  type LoadProjectImportHistoryResult,
  type OrchestrationImportThreadInput,
  type OrchestrationImportThreadResult,
  type ProjectImportProvider,
  type ProjectImportThread,
  ORCHESTRATION_WS_METHODS,
  WsRpcError,
} from "@synara/contracts";
import { Effect } from "effect";

import type { BridgeModel } from "./model.ts";
import { bridgeError, rpcError } from "./rpcErrors.ts";
import type { AnyHandler } from "./stubs.ts";

interface ExternalSession {
  readonly id: string;
  readonly agent: string;
  readonly cwd: string;
  readonly title: string;
  readonly start: string;
  readonly last: string;
}

interface ExternalSessionsPayload {
  readonly sessions: ReadonlyArray<ExternalSession>;
  readonly error: string | null;
}

const DAEMON_AGENT_BY_PROVIDER: Readonly<Record<ProjectImportProvider, string>> = {
  codex: "codex",
  claudeAgent: "claude",
};

const PROVIDER_BY_DAEMON_AGENT: Readonly<Record<string, ProjectImportProvider>> = {
  codex: "codex",
  claude: "claudeAgent",
};

const HISTORY_PAGE_LIMIT = 50;

function fromPromise<A>(_method: string, run: () => Promise<A>): Effect.Effect<A, WsRpcError> {
  return Effect.tryPromise({
    try: run,
    catch: (cause) => rpcError(cause),
  });
}

function iso(value: string | null | undefined, fallback?: string): string {
  const parsed = value ? Date.parse(value) : Number.NaN;
  if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  return fallback ?? new Date().toISOString();
}

function projectIdForCwd(model: BridgeModel, cwd: string): string | null {
  const normalized = cwd.trim().replace(/\/+$/, "");
  if (!normalized) return null;
  let best: { id: string; root: string } | null = null;
  for (const project of model.shellSnapshot().projects) {
    const root = project.workspaceRoot.replace(/\/+$/, "");
    if (normalized !== root && !normalized.startsWith(`${root}/`)) continue;
    if (!best || root.length > best.root.length) best = { id: project.id, root };
  }
  return best?.id ?? null;
}

async function listExternal(model: BridgeModel, agent: string): Promise<ExternalSessionsPayload> {
  const payload = (await model.client.listExternalSessions(
    agent,
  )) as unknown as ExternalSessionsPayload;
  if (payload.error) {
    throw bridgeError("import.list-failed", payload.error, { detail: payload.error });
  }
  return payload;
}

/** Session ids already present as Neox agents, keyed the same way as threadKey. */
async function importedSessionKeys(model: BridgeModel): Promise<Set<string>> {
  const keys = new Set<string>();
  try {
    const agents = await model.client.fetchAgents({
      subscribe: {},
      filter: { includeArchived: true },
    });
    for (const entry of agents.entries) {
      const handle = entry.agent.persistence;
      if (handle?.provider) keys.add(`${handle.provider}:${handle.sessionId}`);
    }
  } catch {
    // An older daemon may not answer; the catalog then reports nothing as imported.
  }
  return keys;
}

async function directoryExists(model: BridgeModel, cwd: string): Promise<boolean> {
  try {
    await model.client.listDirectory(cwd, ".");
    return true;
  } catch {
    return false;
  }
}

async function listImports(
  model: BridgeModel,
  input: ListProjectImportsInput,
): Promise<ListProjectImportsResult> {
  const importedKeys = await importedSessionKeys(model);
  const sources: Array<{
    provider: ProjectImportProvider;
    error: string | null;
  }> = [];
  const threadsByCwd = new Map<string, ProjectImportThread[]>();

  for (const provider of input.providers) {
    const agent = DAEMON_AGENT_BY_PROVIDER[provider];
    try {
      const payload = await listExternal(model, agent);
      for (const session of payload.sessions) {
        if (!session.id.trim() || !session.cwd.trim()) continue;
        const key = `${session.agent}:${session.id}`;
        const thread: ProjectImportThread = {
          key,
          provider,
          title: session.title.trim() || `${agent} session ${session.id.slice(-8)}`,
          cwd: session.cwd,
          createdAt: iso(session.start),
          updatedAt: iso(session.last),
          archived: false,
          alreadyImported: importedKeys.has(key),
        };
        const existing = threadsByCwd.get(session.cwd) ?? [];
        existing.push(thread);
        threadsByCwd.set(session.cwd, existing);
      }
      sources.push({ provider, error: null });
    } catch (cause) {
      sources.push({
        provider,
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  const projects = await Promise.all(
    [...threadsByCwd.entries()].map(async ([workspaceRoot, threads]) => {
      const providers = [...new Set(threads.map((thread) => thread.provider))];
      threads.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      return {
        key: workspaceRoot,
        title: workspaceRoot.split("/").findLast((segment) => segment.length > 0) || workspaceRoot,
        workspaceRoot,
        directoryExists: await directoryExists(model, workspaceRoot),
        existingProjectId: projectIdForCwd(
          model,
          workspaceRoot,
        ) as ListProjectImportsResult["projects"][number]["existingProjectId"],
        providers,
        threads,
      };
    }),
  );
  projects.sort((left, right) => left.workspaceRoot.localeCompare(right.workspaceRoot));

  return { projects, sources };
}

function providerForThread(model: BridgeModel, threadId: string): ProjectImportProvider | null {
  const shell = model.draft(threadId) ?? model.entry(threadId)?.agent;
  const provider = shell
    ? "modelSelection" in shell
      ? shell.modelSelection.provider
      : shell.provider
    : null;
  if (!provider) return null;
  return PROVIDER_BY_DAEMON_AGENT[provider === "claudeAgent" ? "claude" : provider] ?? null;
}

async function ensureProject(model: BridgeModel, cwd: string): Promise<string> {
  const existing = projectIdForCwd(model, cwd);
  if (existing) return existing;
  const added = (await model.client.addProject(cwd)) as unknown as {
    project?: { projectId: string } | null;
    error?: string | null;
  };
  if (!added.project) {
    throw bridgeError("import.register-failed", added.error ?? `Could not register ${cwd}.`, {
      path: cwd,
      ...(added.error ? { detail: added.error } : {}),
    });
  }
  return added.project.projectId;
}

async function importThread(
  model: BridgeModel,
  input: OrchestrationImportThreadInput,
): Promise<OrchestrationImportThreadResult> {
  const provider = providerForThread(model, input.threadId);
  if (!provider) {
    throw bridgeError("import.unknown-provider", `Unknown provider for thread ${input.threadId}.`, {
      thread: input.threadId,
    });
  }
  const agent = DAEMON_AGENT_BY_PROVIDER[provider];
  const externalId = input.externalId.trim();
  const sessions = await listExternal(model, agent);
  const session = sessions.sessions.find((candidate) => candidate.id === externalId);
  if (!session) {
    throw bridgeError("import.session-not-found", `External session ${externalId} was not found.`, {
      session: externalId,
    });
  }
  const imported = await model.client.importAgent({
    providerId: agent,
    providerHandleId: externalId,
    cwd: session.cwd,
  });
  // The daemon assigns its own agent id; the caller's draft id cannot be reused without a
  // bridge-side alias, so the imported thread is reported under the id that now exists.
  return { threadId: imported.id as OrchestrationImportThreadResult["threadId"] };
}

async function findImportedAgent(
  model: BridgeModel,
  agent: string,
  externalId: string,
): Promise<string | null> {
  try {
    const agents = await model.client.fetchAgents({
      subscribe: {},
      filter: { includeArchived: true },
    });
    for (const entry of agents.entries) {
      const handle = entry.agent.persistence;
      if (handle?.provider === agent && handle.sessionId === externalId) return entry.agent.id;
    }
  } catch {
    // Treat an unreadable agent list as "not imported yet".
  }
  return null;
}

async function importProject(
  model: BridgeModel,
  input: ImportProjectInput,
): Promise<ImportProjectResult> {
  const projectCwd = (input.workspaceRoot?.trim() || input.projectKey).trim();
  if (!projectCwd) {
    throw bridgeError("import.no-workspace", "The import target has no workspace root.");
  }

  if (input.threadKey === null) {
    const projectId = await ensureProject(model, projectCwd);
    return {
      projectId: projectId as ImportProjectResult["projectId"],
      threadId: null,
      status: "project-linked",
    };
  }

  const separator = input.threadKey.indexOf(":");
  if (separator <= 0) {
    throw bridgeError("import.malformed-key", `Malformed import key ${input.threadKey}.`, {
      key: input.threadKey,
    });
  }
  const agent = input.threadKey.slice(0, separator);
  const externalId = input.threadKey.slice(separator + 1);
  const sessions = await listExternal(model, agent);
  const session = sessions.sessions.find((candidate) => candidate.id === externalId);
  const cwd = input.workspaceRoot?.trim() || session?.cwd || projectCwd;

  const alreadyImported = await findImportedAgent(model, agent, externalId);
  if (alreadyImported) {
    const projectId = await ensureProject(model, cwd);
    return {
      projectId: projectId as ImportProjectResult["projectId"],
      threadId: alreadyImported as ImportProjectResult["threadId"],
      status: "already-present",
    };
  }

  const imported = await model.client.importAgent({
    providerId: agent,
    providerHandleId: externalId,
    cwd,
  });
  const projectId = await ensureProject(model, cwd);
  return {
    projectId: projectId as ImportProjectResult["projectId"],
    threadId: imported.id as ImportProjectResult["threadId"],
    status: "imported",
  };
}

async function loadHistory(
  model: BridgeModel,
  input: LoadProjectImportHistoryInput,
): Promise<LoadProjectImportHistoryResult> {
  const entry = model.entry(input.threadId);
  const handle = entry?.agent.persistence;
  if (!entry || !handle) return { nextCursor: null, messages: [] };

  let offset = 0;
  if (input.cursor !== undefined) {
    if (!/^\d+$/.test(input.cursor)) {
      throw bridgeError("import.invalid-cursor", "The import history cursor is invalid.");
    }
    offset = Number(input.cursor);
  }
  const transcript = await model.client.getExternalSessionTranscript({
    agent: handle.provider,
    id: handle.sessionId,
    offset,
    limit: HISTORY_PAGE_LIMIT,
  });
  if (transcript.error) {
    throw bridgeError("import.transcript-failed", transcript.error, { detail: transcript.error });
  }

  const createdAt = iso(entry.agent.createdAt);
  const updatedAt = iso(entry.agent.updatedAt, createdAt);
  const messages: Array<{
    messageId: string;
    role: "user" | "assistant";
    text: string;
    createdAt: string;
    updatedAt: string;
  }> = [];
  transcript.parts.forEach((part, index) => {
    if (part.role !== "user" && part.role !== "assistant") return;
    const text = part.text.trim();
    if (!text) return;
    messages.push({
      messageId: `${input.threadId}:${offset + index}`,
      role: part.role,
      text: part.text,
      createdAt,
      updatedAt,
    });
  });

  const consumed = offset + transcript.parts.length;
  return {
    nextCursor: consumed < transcript.total ? String(consumed) : null,
    messages: messages as unknown as LoadProjectImportHistoryResult["messages"],
  };
}

export function makeImportHandlers(model: BridgeModel): Record<string, AnyHandler> {
  return {
    [ORCHESTRATION_WS_METHODS.listProjectImports]: (payload) =>
      fromPromise("orchestration.listProjectImports", () =>
        listImports(model, payload as ListProjectImportsInput),
      ),
    [ORCHESTRATION_WS_METHODS.importThread]: (payload) =>
      fromPromise("orchestration.importThread", () =>
        importThread(model, payload as OrchestrationImportThreadInput),
      ),
    [ORCHESTRATION_WS_METHODS.importProject]: (payload) =>
      fromPromise("orchestration.importProject", () =>
        importProject(model, payload as ImportProjectInput),
      ),
    [ORCHESTRATION_WS_METHODS.loadProjectImportHistory]: (payload) =>
      fromPromise("orchestration.loadProjectImportHistory", () =>
        loadHistory(model, payload as LoadProjectImportHistoryInput),
      ),
  };
}
