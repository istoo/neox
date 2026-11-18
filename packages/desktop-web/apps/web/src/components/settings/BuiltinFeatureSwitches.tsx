// FILE: BuiltinFeatureSwitches.tsx
// Purpose: Plugins › Built-in › the daemon's feature switches. Turning one off
//          hides its desktop surfaces; a feature with something in use keeps
//          its switch on, as myna's InUse plugins do.
// Layer: Settings UI component

import {
  NEOLIX_BUILTIN_FEATURE_IDS,
  NEOLIX_GATEWAY_CALLS_PAGE_OPTIONS,
  type NeolixBuiltinFeatureId,
} from "@synara/contracts";

import { useBuiltinFeatures } from "~/hooks/useBuiltinFeatures";
import { useTranslation } from "~/i18n";
import { cn } from "~/lib/utils";

import { Switch } from "../ui/switch";

function FeatureRow({
  id,
  enabled,
  inUse,
  callsPage,
  onToggle,
  onCallsPageChange,
}: {
  id: NeolixBuiltinFeatureId;
  enabled: boolean;
  inUse: number;
  callsPage?: number | undefined;
  onToggle: (id: NeolixBuiltinFeatureId, enabled: boolean) => void;
  onCallsPageChange?: ((value: number) => void) | undefined;
}) {
  const { t } = useTranslation();
  const name = t(`settings:builtinFeature_${id}_name`);
  const description = t(`settings:builtinFeature_${id}_description`);

  return (
    <div
      className="flex items-start gap-3 rounded-xl px-3 py-3"
      data-testid={`builtin-feature-${id}`}
    >
      <div className="min-w-0 flex-1">
        <p className="text-ui-lg leading-snug font-semibold text-foreground">{name}</p>
        <p className="mt-0.5 text-ui leading-snug text-muted-foreground">{description}</p>
        {inUse > 0 ? (
          <p className="mt-0.5 text-ui-sm text-muted-foreground/70">
            {t("settings:builtinFeatures_inUse", { count: inUse })}
          </p>
        ) : null}
        {callsPage === undefined ? null : (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className="text-ui-sm text-muted-foreground">
              {t("settings:builtinFeatures_callsPage")}
            </span>
            <div
              role="group"
              aria-label={t("settings:builtinFeatures_callsPage")}
              className="inline-flex overflow-hidden rounded-md border border-border"
            >
              {NEOLIX_GATEWAY_CALLS_PAGE_OPTIONS.map((option) => {
                const active = option === callsPage;
                return (
                  <button
                    key={option}
                    type="button"
                    aria-pressed={active}
                    className={cn(
                      "px-2 py-0.5 text-ui-sm tabular-nums transition-colors",
                      active
                        ? "bg-foreground/10 text-foreground"
                        : "text-muted-foreground hover:bg-[var(--sidebar-accent)] hover:text-foreground",
                    )}
                    onClick={() => onCallsPageChange?.(option)}
                  >
                    {option}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
      <Switch
        checked={enabled}
        disabled={inUse > 0}
        aria-label={name}
        onCheckedChange={(checked) => onToggle(id, checked === true)}
      />
    </div>
  );
}

export function BuiltinFeatureSwitches() {
  const { t } = useTranslation();
  const { useCounts, isEnabled, setEnabled, gatewayCallsPage, setGatewayCallsPage } =
    useBuiltinFeatures();

  return (
    <section aria-label={t("settings:builtinFeatures_title")} className="space-y-0.5">
      <h2 className="px-3 pt-2 pb-1 text-[15px] font-semibold text-foreground">
        {t("settings:builtinFeatures_title")}
      </h2>
      <p className="px-3 pb-2 text-ui leading-snug text-muted-foreground">
        {t("settings:builtinFeatures_hint")}
      </p>
      {NEOLIX_BUILTIN_FEATURE_IDS.map((id) => (
        <FeatureRow
          key={id}
          id={id}
          enabled={isEnabled(id)}
          inUse={useCounts[id]}
          callsPage={id === "gateway" ? gatewayCallsPage : undefined}
          onToggle={(feature, enabled) => void setEnabled(feature, enabled)}
          onCallsPageChange={
            id === "gateway" ? (value) => void setGatewayCallsPage(value) : undefined
          }
        />
      ))}
    </section>
  );
}
