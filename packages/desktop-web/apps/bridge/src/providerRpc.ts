import type {
  ProviderComposerCapabilities,
  ProviderListCommandsResult,
  ProviderListModelsResult,
  ProviderListSkillsResult,
} from "@synara/contracts";

import { thinkingOptionFor } from "./commands.ts";
import { bridgeError } from "./rpcErrors.ts";
import type { DaemonClient } from "./neolix.ts";
import type { ProviderDirectory } from "./providers.ts";

interface NeolixModel {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly isSelectable?: boolean;
  readonly isDefault?: boolean;
}

// Claude ids may carry a context-window qualifier (`claude-opus-4-8[1m]`). The front end strips
// it before looking a model up, so the list is keyed by the bare id: a qualified entry folds
// into its bare twin, and one with no twin is listed under the bare id.
// debt: the 1M variant is not offered as a context-window option; add contextWindowOptions and
// map the composer's option back to the `[1m]` id when the picker needs it.
const CONTEXT_WINDOW_SUFFIX = /\[[^\]]+\]$/u;

function bareModelId(id: string): string {
  return id.replace(CONTEXT_WINDOW_SUFFIX, "");
}

function bareLabel(label: string): string {
  return label.replace(/\s*[([]1M(?: context)?[)\]]\s*$/iu, "").trim() || label;
}

async function selectableModels(client: DaemonClient, neolixProvider: string) {
  const response = await client.listProviderModels(neolixProvider as never);
  const models = ((response.models ?? []) as NeolixModel[]).filter(
    (m) => m.isSelectable !== false && m.id.trim() && m.label.trim(),
  );
  return { models, error: response.error ?? null };
}

/** The daemon's default model for a provider, if it marks one. */
export async function defaultModelId(
  client: DaemonClient,
  neolixProvider: string,
): Promise<string | null> {
  const { models } = await selectableModels(client, neolixProvider);
  const chosen = models.find((m) => m.isDefault);
  return chosen ? bareModelId(chosen.id) : null;
}

/** The model picker's list for one Synara provider instance, read live from the daemon. */
export async function listModels(
  client: DaemonClient,
  directory: ProviderDirectory,
  input: { readonly provider: string; readonly instanceId?: string },
): Promise<ProviderListModelsResult> {
  const neolixProvider = await directory.resolve(client, input);
  if (!neolixProvider) return { models: [], degraded: true, error: "Provider is not available." };
  const { models: available, error } = await selectableModels(client, neolixProvider);
  const bySlug = new Map<string, { slug: string; name: string; description?: string }>();
  for (const m of available) {
    const slug = bareModelId(m.id);
    const qualified = slug !== m.id;
    if (qualified && bySlug.has(slug)) continue;
    bySlug.set(slug, {
      slug,
      name: qualified ? bareLabel(m.label) : m.label,
      ...(m.description?.trim() ? { description: m.description.trim() } : {}),
    });
  }
  return {
    models: [...bySlug.values()],
    source: "neolix",
    ...(error ? { degraded: true, error } : {}),
  } as ProviderListModelsResult;
}

/**
 * Composer features the bridge can serve today. Skill/plugin discovery and thread import have
 * no Neox route yet, so the composer hides those affordances instead of offering dead ones.
 */
export function composerCapabilities(provider: string): ProviderComposerCapabilities {
  return {
    provider,
    // Skills reach the composer as native slash commands (`provider.listCommands`), which is
    // also how Claude and Codex expose them; skill mentions stay off because Neox message
    // sends carry no skill reference.
    supportsSkillMentions: false,
    supportsSkillDiscovery: true,
    supportsNativeSlashCommandDiscovery: true,
    supportsPluginMentions: false,
    supportsPluginDiscovery: false,
    supportsRuntimeModelList: true,
    supportsThreadCompaction: false,
    supportsThreadImport: false,
  } as ProviderComposerCapabilities;
}

interface NeolixCommand {
  readonly name: string;
  readonly description: string;
  readonly argumentHint?: string;
  readonly kind?: "command" | "skill";
}

interface NeolixCommandList {
  readonly commands?: readonly NeolixCommand[];
  readonly error?: string | null;
}

interface DiscoverySelection {
  readonly provider: string;
  readonly instanceId?: string;
  readonly model: string;
  readonly options?: Record<string, unknown>;
}

export interface CommandDiscoveryInput {
  readonly provider: string;
  readonly instanceId?: string | undefined;
  readonly cwd: string;
  readonly threadId?: string | undefined;
  /** Set when the thread id already names a live Neox agent. */
  readonly threadIsAgent?: boolean | undefined;
  /** The draft thread's model selection, so draft command discovery matches its provider config. */
  readonly selection?: DiscoverySelection | undefined;
  /** Draft interaction mode: plan mode advertises different slash commands. */
  readonly interactionMode?: string | undefined;
}

/**
 * The model draft discovery runs against. The daemon lists nothing for a draft without a model,
 * and a fresh "New chat" draft has no bridge record yet to read its selection from, so it falls
 * back to the provider's default (else its first selectable model), as the daemon does at spawn.
 */
async function draftDiscoveryModel(
  client: DaemonClient,
  neolixProvider: string,
  selection: DiscoverySelection | undefined,
): Promise<string | null> {
  if (selection?.model && selection.model !== "default") return selection.model;
  try {
    const { models } = await selectableModels(client, neolixProvider);
    const chosen = models.find((m) => m.isDefault) ?? models[0];
    return chosen ? bareModelId(chosen.id) : null;
  } catch {
    // No model list: keep the daemon's own answer for a model-less draft.
    return null;
  }
}

/** Reads the provider's commands for a live agent, or for a draft before one exists. */
async function readCommands(
  client: DaemonClient,
  neolixProvider: string,
  input: CommandDiscoveryInput,
): Promise<NeolixCommand[]> {
  const thinkingOptionId = thinkingOptionFor(input.selection);
  const isAgent = Boolean(input.threadId && input.threadIsAgent);
  const draftModel = isAgent
    ? null
    : await draftDiscoveryModel(client, neolixProvider, input.selection);
  const response = (
    input.threadId && isAgent
      ? await client.listCommands(input.threadId)
      : await client.listCommands({
          agentId: input.threadId ?? `draft:${neolixProvider}`,
          draftConfig: {
            provider: neolixProvider as never,
            cwd: input.cwd,
            ...(draftModel ? { model: draftModel } : {}),
            ...(input.interactionMode === "plan" ? { modeId: "plan" } : {}),
            ...(thinkingOptionId ? { thinkingOptionId } : {}),
          },
        })
  ) as NeolixCommandList;
  if (response.error) {
    throw bridgeError("command.list-failed", response.error, { detail: response.error });
  }
  return [...(response.commands ?? [])];
}

function validCommands(commands: readonly NeolixCommand[], kind?: "command" | "skill") {
  return commands.filter(
    (command) =>
      typeof command.name === "string" &&
      command.name.trim().length > 0 &&
      (kind === undefined || command.kind === kind),
  );
}

/**
 * Native slash commands for the composer. Neox reports skills in the same list with
 * `kind: "skill"`; they stay here too because providers expose them as slash commands.
 */
export async function listCommands(
  client: DaemonClient,
  directory: ProviderDirectory,
  input: CommandDiscoveryInput,
): Promise<ProviderListCommandsResult> {
  const neolixProvider = await directory.resolve(client, input);
  if (!neolixProvider) return { commands: [], source: "neolix" };
  const commands = validCommands(await readCommands(client, neolixProvider, input));
  return {
    commands: commands.map((command) => {
      const name = command.name.trim();
      const description = command.description?.trim();
      return description ? { name, description } : { name };
    }),
    source: "neolix",
  };
}

/**
 * Skills as descriptors. Neox publishes a skill's name and description but not its file path,
 * so the name doubles as the path the composer inserts.
 */
export async function listSkills(
  client: DaemonClient,
  directory: ProviderDirectory,
  input: CommandDiscoveryInput,
): Promise<ProviderListSkillsResult> {
  const neolixProvider = await directory.resolve(client, input);
  if (!neolixProvider) return { skills: [] };
  const commands = validCommands(await readCommands(client, neolixProvider, input), "skill");
  return {
    skills: commands.map((command) => {
      const name = command.name.trim();
      const description = command.description?.trim();
      const descriptor: {
        name: string;
        path: string;
        enabled: boolean;
        scope: string;
        description?: string;
      } = { name, path: name, enabled: true, scope: neolixProvider };
      if (description) descriptor.description = description;
      return descriptor;
    }),
    source: "neolix",
  };
}
