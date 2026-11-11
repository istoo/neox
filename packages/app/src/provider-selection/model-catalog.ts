import type { AgentModelDefinition } from "@neolix/protocol/agent-types";

export function findModelByReference(
  models: AgentModelDefinition[] | null,
  modelId: string,
): AgentModelDefinition | null {
  if (!models || models.length === 0) return null;
  const normalizedModelId = modelId.trim();
  if (!normalizedModelId) return null;
  return (
    models.find((model) => model.id === normalizedModelId) ??
    models.find((model) => model.aliases?.includes(normalizedModelId)) ??
    null
  );
}

export function filterSelectableModels(
  models: AgentModelDefinition[] | null,
): AgentModelDefinition[] | null {
  return models?.filter((model) => model.isSelectable !== false) ?? null;
}

const ROUTING_PREFIX_PATTERN = /^([^/]+)\/(.+)$/;
const ONE_MILLION_MARKER_PATTERN = /\[1m\]$/i;

export interface ModelDisplayName {
  /** What lists show: the label without its routing prefix, plus the 1M tag. */
  label: string;
  /** The routing prefix (`ghcp`, `group`, …), shown as the source marker. */
  source: string | null;
  /** The localized 1M context tag when the id carries `[1m]`. */
  contextLabel: string | null;
  /** The untouched id, for tooltips and details. */
  rawId: string;
}

/**
 * A model's user-facing name. Gateway ids carry a routing prefix and a `[1m]`
 * marker (`ghcp/claude-opus-5-5[1m]`); lists show the name without the prefix
 * and name the marker, while the raw id stays in details.
 */
export function formatModelDisplayName(
  model: { id: string; label?: string | null },
  oneMillionContextLabel: string,
): ModelDisplayName {
  const rawId = model.id.trim();
  const providedLabel = model.label?.trim();
  const routingPrefix = ROUTING_PREFIX_PATTERN.exec(rawId);
  const source = routingPrefix?.[1] ?? null;
  const idWithoutSource = routingPrefix?.[2] ?? rawId;
  const hasOneMillionMarker =
    ONE_MILLION_MARKER_PATTERN.test(idWithoutSource) ||
    ONE_MILLION_MARKER_PATTERN.test(rawId) ||
    (providedLabel ? ONE_MILLION_MARKER_PATTERN.test(providedLabel) : false);

  const baseLabel = providedLabel && providedLabel !== rawId ? providedLabel : idWithoutSource;
  const labelWithoutMarker = baseLabel.replace(ONE_MILLION_MARKER_PATTERN, "").trim();
  const displayBase = labelWithoutMarker || idWithoutSource.replace(ONE_MILLION_MARKER_PATTERN, "");

  return {
    label: hasOneMillionMarker ? `${displayBase} · ${oneMillionContextLabel}` : displayBase,
    source,
    contextLabel: hasOneMillionMarker ? oneMillionContextLabel : null,
    rawId,
  };
}
