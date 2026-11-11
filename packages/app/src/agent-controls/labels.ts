import { i18n } from "@/i18n/i18next";

interface ControlLabelInput {
  id: string;
  label?: string | null;
}

function sentenceCase(value: string): string {
  if (!value) {
    return value;
  }
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}

function splitCompactLabel(value: string, splitHyphen: boolean): string {
  const separatorPattern = splitHyphen ? /[_-]+/g : /_+/g;

  return value
    .replace(separatorPattern, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
}

function formatControlLabel(option: ControlLabelInput, splitHyphen: boolean): string {
  const rawLabel = (option.label ?? option.id).trim();
  return sentenceCase(splitCompactLabel(rawLabel, splitHyphen));
}

const THINKING_LEVEL_KEYS: Record<string, string> = {
  off: "agentControls.thinking.levels.off",
  none: "agentControls.thinking.levels.none",
  low: "agentControls.thinking.levels.low",
  medium: "agentControls.thinking.levels.medium",
  high: "agentControls.thinking.levels.high",
  max: "agentControls.thinking.levels.max",
};

const MODE_LABEL_KEYS: Record<string, string> = {
  default: "agentControls.mode.labels.alwaysAsk",
  alwaysask: "agentControls.mode.labels.alwaysAsk",
  plan: "agentControls.mode.labels.plan",
  acceptedits: "agentControls.mode.labels.acceptEdits",
  fullaccess: "agentControls.mode.labels.fullAccess",
  auto: "agentControls.mode.labels.defaultPermissions",
  autoreview: "agentControls.mode.labels.autoReview",
};

function compactControlId(value: string): string {
  return value.replace(/[\s_-]+/g, "").toLowerCase();
}

export function formatAgentModeLabel(mode: ControlLabelInput): string {
  const idKey = MODE_LABEL_KEYS[compactControlId(mode.id)];
  if (idKey) {
    return i18n.t(idKey);
  }
  return formatControlLabel(mode, mode.label == null);
}

export function formatThinkingOptionLabel(option: ControlLabelInput): string {
  const rawLabel = (option.label ?? option.id).trim();
  const compactLabel = compactControlId(rawLabel);
  const compactId = compactControlId(option.id);
  const levelKey = THINKING_LEVEL_KEYS[compactId];

  // Provider labels like "XHigh (56 | 8m)" carry detail; leave those intact.
  if (levelKey && (compactLabel === compactId || compactLabel === "")) {
    return i18n.t(levelKey);
  }

  if (compactLabel === "xhigh" || compactLabel === "extrahigh") {
    return i18n.t("agentControls.thinking.extraHigh");
  }

  return formatControlLabel(option, true);
}
