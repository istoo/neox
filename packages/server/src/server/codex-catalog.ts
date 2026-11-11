/**
 * The catalog Codex reads for the gateway's models (myna's `codexcat`,
 * `internal/codexcat/codexcat.go:352-420`): Codex's own `models.json`
 * shape, so `/model` and the agent's picker show the same models the
 * gateway serves. Only fields Codex requires or that change behaviour are
 * set; the rest take Codex's defaults.
 */
export interface CodexCatalogModel {
  id: string;
  label?: string;
  contextWindow?: number;
  images?: boolean;
  /**
   * The reasoning levels the user keeps of this model (myna's ModelEfforts,
   * `model-prefs.ts`); empty for a model that reasons at none, absent for
   * one the user said nothing about.
   */
  efforts?: string[];
}

export interface CodexCatalogEntry {
  slug: string;
  display_name: string;
  description: string;
  base_instructions: string;
  supported_reasoning_levels: { effort: string; description: string }[];
  shell_type: string;
  visibility: string;
  supported_in_api: boolean;
  priority: number;
  support_verbosity: boolean;
  apply_patch_tool_type: string;
  truncation_policy: { mode: string; limit: number };
  experimental_supported_tools: string[];
  input_modalities: string[];
  context_window?: number;
  service_tiers: unknown[];
  supports_search_tool: boolean;
  supports_parallel_tool_calls: boolean;
  supports_reasoning_summaries: boolean;
  /** "v1" on OpenAI's own models when Neolix's CodexAgentsV1 is on (myna's codexcat). */
  multi_agent_version?: string;
  /** The model Codex's auto-review runs on, in place of its own pick. */
  auto_review_model_override?: string;
}

/** myna's WorkingWindow: the window a longer model is told unless FullContext. */
export const WORKING_WINDOW = 272_000;

/** What Neolix's gateway tells Codex about its models (myna's AGENT_PREFS semantics). */
export interface CodexCatalogOptions {
  /** OpenAI's own models say multi-agent V1. */
  agentsV1?: boolean;
  /** Ids of OpenAI's own models, whose entries say V1. */
  openAiModels?: readonly string[];
  /** "" is Codex's own pick, "session" the entry's own model, else a model id. */
  autoReview?: string;
  /** Tell a model's whole window rather than the compacting one. */
  fullContext?: boolean;
  /** The window to compact at, in tokens; 0 is WORKING_WINDOW. */
  compactAt?: number;
}

/** Codex's levels for a model served through the gateway; myna offers these. */
const LEVELS: { effort: string; description: string }[] = [
  { effort: "low", description: "Fastest, least reasoning" },
  { effort: "medium", description: "Balanced" },
  { effort: "high", description: "More reasoning" },
  { effort: "xhigh", description: "Most reasoning" },
];

/** What a level means, for the levels a user's own list may add. */
const LEVEL_DESCRIPTIONS: Record<string, string> = {
  low: "Fastest, least reasoning",
  medium: "Balanced",
  high: "More reasoning",
  xhigh: "Most reasoning",
  max: "Most reasoning",
  none: "No reasoning",
};

/**
 * The levels one model is offered: the user's list when they gave one (myna
 * keeps theirs, and a level it did not describe goes by its own name),
 * otherwise Codex's usual four.
 */
function levelsOf(model: CodexCatalogModel): { effort: string; description: string }[] {
  if (model.efforts === undefined) {
    return LEVELS;
  }
  return model.efforts.map((effort) => ({
    effort,
    description: LEVEL_DESCRIPTIONS[effort] ?? effort,
  }));
}

export function codexCatalogEntries(
  models: readonly CodexCatalogModel[],
  options: CodexCatalogOptions = {},
): CodexCatalogEntry[] {
  const openAi = new Set(options.openAiModels ?? []);
  const configuredCompact =
    options.compactAt !== undefined && options.compactAt > 0 ? options.compactAt : WORKING_WINDOW;
  const compaction = options.fullContext === true ? 0 : configuredCompact;
  const autoReview = options.autoReview ?? "";
  return models.map((model, index) => {
    const label = model.label ?? model.id;
    // A longer window is told as the compacting one, so the agent leaves
    // room for its answer (myna's Window).
    const contextWindow =
      model.contextWindow === undefined || compaction <= 0
        ? model.contextWindow
        : Math.min(model.contextWindow, compaction);
    const levels = levelsOf(model);
    return {
      slug: model.id,
      display_name: label,
      description: `${label} via Neox`,
      base_instructions: "",
      supported_reasoning_levels: levels,
      shell_type: "unified_exec",
      visibility: "list",
      supported_in_api: true,
      priority: index + 1,
      support_verbosity: false,
      apply_patch_tool_type: "freeform",
      truncation_policy: { mode: "tokens", limit: 10_000 },
      experimental_supported_tools: [],
      input_modalities: model.images === true ? ["text", "image"] : ["text"],
      ...(contextWindow === undefined ? {} : { context_window: contextWindow }),
      service_tiers: [],
      supports_search_tool: true,
      supports_parallel_tool_calls: true,
      supports_reasoning_summaries: levels.length > 0,
      ...(options.agentsV1 === true && openAi.has(model.id) ? { multi_agent_version: "v1" } : {}),
      ...(autoReview.length === 0
        ? {}
        : { auto_review_model_override: autoReview === "session" ? model.id : autoReview }),
    };
  });
}

/** A whole `models.json`, as `model_catalog_json` and `/v1/codex/models` give it. */
export function codexCatalogJson(
  models: readonly CodexCatalogModel[],
  options: CodexCatalogOptions = {},
): string {
  return `${JSON.stringify({ models: codexCatalogEntries(models, options) }, null, 1)}\n`;
}
