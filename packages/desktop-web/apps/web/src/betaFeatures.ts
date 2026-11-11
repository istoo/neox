// FILE: betaFeatures.ts
// Purpose: The web app's read of the shared Beta-only feature list.
// Layer: Route/UI support
// Exports: DESKTOP_FLAVOR, isBetaFeatureOn, visibleProviderDescriptors, VISIBLE_PROVIDER_DESCRIPTORS

import {
  ACCOUNT_INBOX_BETA_FEATURE,
  desktopFlavorFromProtocol,
  GROUPS_BETA_FEATURE,
  INBOX_BETA_FEATURE,
  INLINE_VISUALS_BETA_FEATURE,
  isBetaFeatureEnabled,
  MCP_CONNECTORS_BETA_FEATURE,
  NATIVE_EDITOR_BETA_FEATURE,
  PULL_REQUEST_AUTO_FIX_BETA_FEATURE,
} from "@synara/shared/betaFeatures";
import { PROVIDER_DESCRIPTORS } from "@synara/shared/providerMetadata";

import {
  NEOLIX_GROUPS_UI_ENABLED,
  NEOLIX_INLINE_VISUALS_UI_ENABLED,
  NEOLIX_UNSUPPORTED_PROVIDER_KINDS,
} from "./neolixFeatures";

// The desktop serves the app from its own scheme, so the protocol names the
// host flavor (branding.ts uses the same signal for display names). A dev
// build serves `synara:` too, so import.meta.env.DEV disambiguates it. SSR and
// tests have no window and resolve to "unknown", which keeps Beta-only
// features on — the server gate is the authoritative one.
export const DESKTOP_FLAVOR = desktopFlavorFromProtocol(
  typeof window === "undefined" ? undefined : window.location?.protocol,
  import.meta.env.DEV,
);

// A provider's feature key is its ProviderKind, so the drivers Neox's daemon cannot run
// are switched off here and every picker, settings list and onboarding row drops them.
export const isBetaFeatureOn = (feature: string): boolean =>
  !NEOLIX_UNSUPPORTED_PROVIDER_KINDS.has(feature) && isBetaFeatureEnabled(feature, DESKTOP_FLAVOR);

/**
 * Neox 无 Hubs/Groups 后端：组件与路由保留，但入口与后台工作全部关闭。
 * Hubs is available in Stable and Beta. The shared feature policy also controls
 * server APIs, background work, and whether saved hub folders act as containers.
 */
export const GROUPS_ON: boolean = NEOLIX_GROUPS_UI_ENABLED && isBetaFeatureOn(GROUPS_BETA_FEATURE);

/**
 * Neox 无 Inbox 后端：路由、rail 与启动查询都关闭。
 * Inbox is available in Stable and Beta. Tasks within it retain their separate gate.
 */
export const INBOX_ON: boolean = false && isBetaFeatureOn(INBOX_BETA_FEATURE);

/** Neox 无账号 Inbox 历史：与 INBOX_ON 一起关闭。 */
export const ACCOUNT_INBOX_ON: boolean = false && isBetaFeatureOn(ACCOUNT_INBOX_BETA_FEATURE);

/**
 * Auto-fix CI is available in Stable and Beta; watching a PR remains opt-in.
 */
export const PULL_REQUEST_AUTO_FIX_ON = isBetaFeatureOn(PULL_REQUEST_AUTO_FIX_BETA_FEATURE);

/**
 * Neox 无 Inline visuals 后端：渲染入口保持关闭。
 * Inline visuals are available in Stable and Beta. HTML keeps the same
 * sandbox and desktop-only execution boundary; component specs also work on the web.
 */
export const INLINE_VISUALS_ON: boolean =
  NEOLIX_INLINE_VISUALS_UI_ENABLED && isBetaFeatureOn(INLINE_VISUALS_BETA_FEATURE);

/**
 * Connectors are available in Stable and Beta, including Settings and `@`
 * mentions for provider sessions that support them.
 */
export const MCP_CONNECTORS_ON = isBetaFeatureOn(MCP_CONNECTORS_BETA_FEATURE);

/** The native Code OSS engine is enabled in Stable and Beta; Pierre remains the gated alternative. */
export type CodeEditorEngine = "native" | "pierre";

export function codeEditorEngine(
  isOn: (feature: string) => boolean = isBetaFeatureOn,
): CodeEditorEngine {
  return isOn(NATIVE_EDITOR_BETA_FEATURE) ? "native" : "pierre";
}

/**
 * Stable and Beta use the same native editing engine, language-service and
 * debugger controls. The server applies the same shared availability policy.
 */
export const CODE_EDITOR_ENGINE = codeEditorEngine();
export const NATIVE_EDITOR_ON = CODE_EDITOR_ENGINE === "native";

/**
 * Provider descriptors with Beta-only providers removed on Stable. A
 * provider's feature key is its ProviderKind, so an unlisted kind is always
 * visible. Selectable lists (pickers, settings, onboarding) consume this;
 * display-only rendering of existing threads keeps PROVIDER_DESCRIPTORS.
 */
export function visibleProviderDescriptors(
  isOn: (feature: string) => boolean = isBetaFeatureOn,
): (typeof PROVIDER_DESCRIPTORS)[number][] {
  return PROVIDER_DESCRIPTORS.filter((d) => isOn(d.kind));
}

export const VISIBLE_PROVIDER_DESCRIPTORS = visibleProviderDescriptors();
