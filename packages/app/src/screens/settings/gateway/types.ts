import type { GatewayConfigWire, GatewayStatusWire } from "@neolix/protocol/gateway";
import type { GatewaySearchVendor } from "@/hooks/use-gateway-config";

/** What every Settings → Model gateway page receives from `GatewaySettingsSection`. */
export interface GatewayPageProps {
  serverId: string;
  /** The draft when one exists, otherwise the saved config. */
  config: GatewayConfigWire;
  status: GatewayStatusWire | null;
  /** The search APIs plugins give; null when the host has none or is older. */
  searchVendors: GatewaySearchVendor[] | null;
  error: Error | null;
  /** Changes the draft; the save bar below the page persists it. */
  edit: (mutate: (next: GatewayConfigWire) => void) => void;
  /** Applies a change and saves it right away (toggles, modal Save buttons). */
  apply: (mutate: (next: GatewayConfigWire) => void) => Promise<void>;
  /** The masking record a notification opened the page on, once. */
  focusRecord?: string;
  /** The provider the Providers page should open, set by the Usage page. */
  focusProvider?: string;
  /** Sends the reader to a provider's editor, from a plan card's missing key. */
  openProvider?: (providerId: string) => void;
}
