// FILE: gatewayDraftValidation.ts
// Purpose: Client-side checks for gateway drafts that the daemon would refuse:
//   empty routing groups, mask rules without a kind, a non-positive budget and
//   a malformed proxy. Keeps impossible drafts off the wire and names the row
//   that needs attention.
// Layer: Web settings logic.

import type { GatewayConfig } from "~/lib/gatewayTypes";
import { messageOf, type Translator, unwrapRpcMessage } from "~/lib/errorLocalization";
import { t as i18nT } from "~/i18n";

import { isMaskingScore } from "./gatewayMaskingScore.logic";

export type GatewayDraftIssue =
  | { kind: "group-members"; groupId: string; index: number }
  | { kind: "group-invalid"; groupId: string; index: number }
  | { kind: "mask-kind"; line: number }
  | { kind: "mask-score" }
  | { kind: "budget" }
  | { kind: "proxy" };

/** The daemon's proxy rule: "direct", or http(s)/socks5(s) with a host. */
export function isProxyAddress(value: string): boolean {
  const text = value.trim();
  if (text === "direct") return true;
  try {
    const url = new URL(text.includes("://") ? text : `http://${text}`);
    return ["http:", "https:", "socks5:", "socks5h:"].includes(url.protocol);
  } catch {
    return false;
  }
}

/** The warm-up list's accepted clock form: HH:MM, 00:00–23:59. */
export function isWarmAt(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/u.test(value.trim());
}

/** The non-empty entries of a comma-separated warm-up list that are invalid. */
export function invalidWarmAts(text: string): string[] {
  return text
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && !isWarmAt(entry));
}

/** The daemon's group id rule: lowercase letter first, then lowercase letters, digits, dashes. */
const GROUP_ID_PATTERN = /^[a-z][a-z0-9-]*$/u;

/** Everything in a draft the daemon's schema would reject, in document order. */
export function validateGatewayDraft(config: GatewayConfig): GatewayDraftIssue[] {
  const issues: GatewayDraftIssue[] = [];
  (config.groups ?? []).forEach((group, index) => {
    if (!GROUP_ID_PATTERN.test(group.id)) {
      issues.push({ kind: "group-invalid", groupId: group.id, index });
    } else if (group.members.length === 0) {
      issues.push({ kind: "group-members", groupId: group.id, index });
    }
  });
  (config.masking?.rules ?? []).forEach((rule, index) => {
    if (rule.kind.trim().length === 0) {
      issues.push({ kind: "mask-kind", line: index + 1 });
    }
  });
  const score = config.masking?.modelScore;
  if (score !== undefined && !isMaskingScore(score)) issues.push({ kind: "mask-score" });
  const budget = config.budget?.monthlyUsd;
  if (budget !== undefined && !(budget > 0)) issues.push({ kind: "budget" });
  if (
    typeof config.proxy === "string" &&
    config.proxy.trim() !== "" &&
    !isProxyAddress(config.proxy)
  ) {
    issues.push({ kind: "proxy" });
  }
  return issues;
}

export function describeGatewayDraftIssue(
  issue: GatewayDraftIssue,
  translate: Translator = i18nT,
): string {
  if (issue.kind === "group-members") {
    return translate("gateway:error_group_members", { id: issue.groupId });
  }
  if (issue.kind === "group-invalid") {
    return translate("gateway:error_group_invalid", { id: issue.groupId });
  }
  if (issue.kind === "mask-kind") {
    return translate("gateway:error_mask_kind", { line: issue.line });
  }
  if (issue.kind === "mask-score") return translate("gateway:error_mask_score");
  if (issue.kind === "budget") return translate("gateway:error_budget");
  return translate("gateway:error_proxy");
}

interface ZodIssueLike {
  path?: unknown;
  code?: unknown;
}

function zodIssues(message: string): ZodIssueLike[] | null {
  const marker = "Invalid gateway config:";
  const at = message.indexOf(marker);
  if (at < 0) return null;
  try {
    const parsed: unknown = JSON.parse(message.slice(at + marker.length).trim());
    return Array.isArray(parsed) ? (parsed as ZodIssueLike[]) : null;
  } catch {
    return null;
  }
}

function issuePath(issue: ZodIssueLike): Array<string | number> {
  return Array.isArray(issue.path)
    ? issue.path.filter(
        (part): part is string | number => typeof part === "string" || typeof part === "number",
      )
    : [];
}

/**
 * A readable save failure. Zod's English dump never reaches the UI verbatim:
 * known paths name the offending row and an unknown one gets a generic
 * localized summary. Other daemon failures keep their unwrapped reason.
 */
export function localizeGatewaySaveError(
  error: unknown,
  config: GatewayConfig | undefined,
  translate: Translator = i18nT,
): string {
  const message = unwrapRpcMessage(messageOf(error));
  const issues = zodIssues(message);
  if (issues === null) return message;
  const issue = issues[0];
  if (issue === undefined) return translate("gateway:error_invalid_config");
  const path = issuePath(issue);
  const groupIndex = path[0] === "groups" && typeof path[1] === "number" ? path[1] : null;
  if (groupIndex !== null) {
    const group = config?.groups?.[groupIndex];
    const id = group?.id ?? `#${groupIndex + 1}`;
    return path.includes("members")
      ? translate("gateway:error_group_members", { id })
      : translate("gateway:error_group_invalid", { id });
  }
  if (path[0] === "masking" && path[1] === "modelScore") {
    return translate("gateway:error_mask_score");
  }
  if (path[0] === "masking" && path[1] === "rules") {
    const line = typeof path[2] === "number" ? path[2] + 1 : 1;
    return translate("gateway:error_mask_kind", { line });
  }
  if (path[0] === "budget") return translate("gateway:error_budget");
  if (path[0] === "proxy") return translate("gateway:error_proxy");
  if (path[0] === "otel" && path[1] === "endpoint") {
    return translate("gateway:error_otel_endpoint");
  }
  return translate("gateway:error_invalid_config");
}
