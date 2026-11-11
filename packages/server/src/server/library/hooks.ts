import { readFile } from "node:fs/promises";
import { writeManagedFile } from "./store.js";
import type { LibraryAgentTarget } from "./paths.js";
import type { AppliedHookEntry, StoredHook, StoredLibrary } from "./store.js";
import { fail, markChanged, type AgentSyncContext } from "./result.js";
import { parseJsonc } from "./mcp.js";

/** Portable events, in the order the page offers them. */
export const HOOK_EVENTS = [
  "turn-end",
  "after-tool",
  "before-tool",
  "prompt",
  "session-start",
] as const;

/** The kinds of tools a portable tool event can be narrowed to. */
export const HOOK_TOOLS = ["shell", "edit"] as const;

interface AgentHookSpec {
  events: Record<string, string>;
  tools: Record<string, string>;
  /** Cursor: an entry is the command itself, not a group of them. */
  flat?: boolean;
  /** Gemini: timeouts in milliseconds. */
  ms?: boolean;
}

const agentHookSpecs: Record<string, AgentHookSpec> = {
  claude: {
    events: {
      "turn-end": "Stop",
      "after-tool": "PostToolUse",
      "before-tool": "PreToolUse",
      prompt: "UserPromptSubmit",
      "session-start": "SessionStart",
    },
    tools: { shell: "Bash", edit: "Edit|Write|MultiEdit" },
  },
  codex: {
    events: {
      "turn-end": "Stop",
      "after-tool": "PostToolUse",
      "before-tool": "PreToolUse",
      prompt: "UserPromptSubmit",
      "session-start": "SessionStart",
    },
    tools: { shell: "Bash", edit: "apply_patch" },
  },
  gemini: {
    events: {
      "turn-end": "AfterAgent",
      "after-tool": "AfterTool",
      "before-tool": "BeforeTool",
      prompt: "BeforeAgent",
      "session-start": "SessionStart",
    },
    tools: { shell: "run_shell_command", edit: "write_file|replace" },
    ms: true,
  },
  cursor: {
    events: {
      "turn-end": "stop",
      "after-tool": "postToolUse",
      "before-tool": "preToolUse",
      prompt: "beforeSubmitPrompt",
      "session-start": "sessionStart",
    },
    tools: { shell: "Shell", edit: "Write" },
    flat: true,
  },
};

const eventNames = agentHookSpecs.claude.events;

const hookNamePattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function checkHook(hook: StoredHook): StoredHook {
  const name = hook.name.trim();
  if (!hookNamePattern.test(name)) {
    throw new Error(`Hook name ${JSON.stringify(name)}: use letters, digits, - and _ only`);
  }
  if (!eventNames[hook.event]) {
    throw new Error(`${name}: no event called ${hook.event}`);
  }
  if (hook.command.trim().length === 0) {
    throw new Error(`${name}: a command is needed`);
  }
  if (hook.timeout !== undefined && (!Number.isInteger(hook.timeout) || hook.timeout <= 0)) {
    throw new Error(`${name}: the timeout is a whole number of seconds`);
  }
  const matcher =
    hook.event === "after-tool" || hook.event === "before-tool" ? hook.matcher?.trim() : undefined;
  return {
    name,
    ...(hook.description?.trim() ? { description: hook.description.trim() } : {}),
    event: hook.event,
    ...(matcher ? { matcher } : {}),
    command: hook.command.trim(),
    ...(hook.timeout ? { timeout: hook.timeout } : {}),
    agents: [...new Set(hook.agents)].sort(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function entryFor(agent: string, hook: StoredHook): unknown {
  const spec = agentHookSpecs[agent];
  if (!spec) {
    return null;
  }
  let matcher: string | undefined;
  if (hook.matcher && (hook.event === "after-tool" || hook.event === "before-tool")) {
    matcher = spec.tools[hook.matcher] ?? hook.matcher;
  }
  let timeout: number | undefined;
  if (hook.timeout) {
    timeout = spec.ms ? hook.timeout * 1000 : hook.timeout;
  }
  if (spec.flat) {
    return {
      ...(matcher ? { matcher } : {}),
      command: hook.command,
      ...(timeout ? { timeout } : {}),
    };
  }
  return {
    ...(matcher ? { matcher } : {}),
    hooks: [
      {
        type: "command",
        command: hook.command,
        ...(timeout ? { timeout } : {}),
      },
    ],
  };
}

function sameEntry(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function readHookFile(file: string): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(file, "utf8");
    if (raw.trim().length === 0) {
      return {};
    }
    const parsed = parseJsonc(raw);
    return isRecord(parsed) ? parsed : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

export async function syncHooks(library: StoredLibrary, context: AgentSyncContext): Promise<void> {
  const { target, backup, result } = context;
  const agent = target.id;
  if (!target.hooksPath) {
    return;
  }
  const desired = library.hooks.filter((hook) => hook.agents.includes(agent));
  const applied = (library.applied[agent] ??= {});
  const previous = applied.hooks ?? [];
  if (previous.length === 0 && desired.length === 0) {
    return;
  }
  let root: Record<string, unknown>;
  try {
    root = await readHookFile(target.hooksPath);
  } catch (error) {
    fail(result, agent, "hook", error);
    return;
  }
  const hooks = isRecord(root.hooks) ? { ...root.hooks } : {};
  const before = JSON.stringify(hooks);
  const readList = (event: string): unknown[] =>
    Array.isArray(hooks[event]) ? [...hooks[event]] : [];
  const writeList = (event: string, list: unknown[]): void => {
    if (list.length > 0) {
      hooks[event] = list;
    } else {
      delete hooks[event];
    }
  };

  for (const entry of previous) {
    writeList(
      entry.event,
      readList(entry.event).filter((candidate) => !sameEntry(candidate, entry.entry)),
    );
  }

  const written: AppliedHookEntry[] = [];
  for (const hook of desired) {
    const spec = agentHookSpecs[agent];
    const event = spec?.events[hook.event];
    const entry = entryFor(agent, hook);
    if (!event || !entry) {
      fail(
        result,
        agent,
        `hook:${hook.name}`,
        new Error(`${target.name} has no hook for ${hook.event}`),
      );
      continue;
    }
    const list = readList(event);
    list.push(entry);
    writeList(event, list);
    written.push({ name: hook.name, event, entry });
  }

  const nextRoot = { ...root };
  if (Object.keys(hooks).length > 0) {
    nextRoot.hooks = hooks;
  } else {
    delete nextRoot.hooks;
  }
  if (written.length > 0) {
    applied.hooks = written;
  } else {
    delete applied.hooks;
  }
  if (JSON.stringify(hooks) === before) {
    return;
  }
  try {
    await backup.keep(agent, target.hooksPath);
    await writeManagedFile(target.hooksPath, `${JSON.stringify(nextRoot, null, 2)}\n`);
  } catch (error) {
    fail(result, agent, "hook", error);
    return;
  }
  markChanged(result, agent);
}

export function hooksView(library: StoredLibrary): StoredHook[] {
  return library.hooks.map((hook) => ({ ...hook, agents: [...hook.agents] }));
}

export function hookCapableAgents(targets: readonly LibraryAgentTarget[]): LibraryAgentTarget[] {
  return targets.filter((target) => target.hooksPath !== undefined);
}
