/**
 * The vendor presets live in @neolix/protocol/gateway-presets, shared with
 * the CLI (`neolix presets`, `neolix provider add <preset>`); this module keeps
 * the app's existing import path.
 */
export {
  GATEWAY_PROVIDER_PRESETS,
  type GatewayProviderPreset,
  type GatewayProviderPresetKind,
} from "@neolix/protocol/gateway-presets";
