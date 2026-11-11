import { View } from "react-native";
import type { GatewayPriceWire } from "@neolix/protocol/gateway";
import { StatusBadge } from "@/components/ui/status-badge";

interface PeakBadgeProps {
  /** The catalog price's `peak`, from `gateway.pricing.get`. */
  peak: GatewayPriceWire["peak"];
  /** Already translated, e.g. "Off-peak ×2". */
  label: string;
  /** Already translated: the hours the price doubles in. */
  hint?: string;
}

/**
 * A model whose list price is its vendor's off-peak one: the usage page bills
 * it double in the vendor's peak hours. Nothing for a model with one price.
 */
export function PeakBadge({ peak, label, hint }: PeakBadgeProps) {
  if (peak === undefined) {
    return null;
  }
  return (
    <View accessibilityHint={hint}>
      <StatusBadge label={label} variant="warning" size="xs" />
    </View>
  );
}
