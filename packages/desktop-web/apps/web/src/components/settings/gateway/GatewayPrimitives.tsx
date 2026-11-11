// FILE: GatewayPrimitives.tsx
// Purpose: Small shared controls for the Model gateway settings panes: a labelled
//          section, inline fields, toggles, and an empty/error strip.
// Layer: Settings UI components

import type { ReactNode } from "react";

import { useTranslation } from "~/i18n";
import { cn } from "~/lib/utils";
import {
  SETTINGS_INSET_LIST_CLASS_NAME,
  SETTINGS_OUTLINED_SURFACE_CLASS_NAME,
} from "~/settingsPanelStyles";

import { Badge } from "../../ui/badge";
import { Input } from "../../ui/input";
import { Switch } from "../../ui/switch";
import { SettingsSectionShell } from "../SettingsPanelPrimitives";

export function GatewaySection({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <SettingsSectionShell title={title} action={action}>
      <div
        className={cn(
          SETTINGS_INSET_LIST_CLASS_NAME,
          "divide-y divide-[color:var(--color-border)]",
        )}
      >
        {children}
      </div>
    </SettingsSectionShell>
  );
}

export function GatewayRow({
  title,
  description,
  trailing,
  children,
  className,
}: {
  title: ReactNode;
  description?: ReactNode | undefined;
  trailing?: ReactNode | undefined;
  children?: ReactNode | undefined;
  className?: string | undefined;
}) {
  return (
    <div className={cn("px-3 py-2.5", className)}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 flex-1">
          <div className="text-ui font-medium text-foreground">{title}</div>
          {description === undefined ? null : (
            <div className="mt-0.5 text-ui-sm leading-snug text-muted-foreground">
              {description}
            </div>
          )}
        </div>
        {trailing === undefined ? null : (
          <div className="flex shrink-0 items-center gap-1.5">{trailing}</div>
        )}
      </div>
      {children === undefined ? null : <div className="mt-2">{children}</div>}
    </div>
  );
}

export function GatewayToggle({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean | undefined;
  label: string;
}) {
  return (
    <Switch checked={checked} onCheckedChange={onChange} disabled={disabled} aria-label={label} />
  );
}

export function GatewayField({
  label,
  value,
  onChange,
  placeholder,
  type,
  disabled,
  hint,
  className,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string | undefined;
  type?: string | undefined;
  disabled?: boolean | undefined;
  hint?: string | undefined;
  className?: string | undefined;
}) {
  return (
    <label className={cn("flex flex-col gap-1", className)}>
      <span className="text-ui-sm text-muted-foreground">{label}</span>
      <Input
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        placeholder={placeholder}
        type={type}
        disabled={disabled}
        size="sm"
        variant="soft"
      />
      {hint === undefined ? null : <span className="text-ui-xs text-muted-foreground">{hint}</span>}
    </label>
  );
}

export function GatewayNumberField({
  label,
  value,
  onChange,
  placeholder,
  min,
  max,
  disabled,
  hint,
}: {
  label: string;
  value: number | undefined;
  onChange: (value: number | undefined) => void;
  placeholder?: string | undefined;
  min?: number | undefined;
  max?: number | undefined;
  disabled?: boolean | undefined;
  hint?: string | undefined;
}) {
  return (
    <GatewayField
      label={label}
      value={value === undefined ? "" : String(value)}
      onChange={(text) => {
        const trimmed = text.trim();
        if (trimmed === "") {
          onChange(undefined);
          return;
        }
        const parsed = Number(trimmed);
        if (!Number.isFinite(parsed)) return;
        const bounded =
          min !== undefined || max !== undefined
            ? Math.min(
                max ?? Number.POSITIVE_INFINITY,
                Math.max(min ?? Number.NEGATIVE_INFINITY, parsed),
              )
            : parsed;
        onChange(bounded);
      }}
      placeholder={placeholder}
      type="number"
      disabled={disabled}
      hint={hint}
    />
  );
}

export function GatewayTextarea({
  label,
  value,
  onChange,
  placeholder,
  rows,
  hint,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string | undefined;
  rows?: number | undefined;
  hint?: string | undefined;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-ui-sm text-muted-foreground">{label}</span>
      <textarea
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        placeholder={placeholder}
        rows={rows ?? 6}
        className={cn(
          SETTINGS_OUTLINED_SURFACE_CLASS_NAME,
          "w-full resize-y bg-transparent px-2.5 py-2 font-mono text-ui-sm text-foreground outline-none focus-visible:border-foreground/30",
        )}
      />
      {hint === undefined ? null : <span className="text-ui-xs text-muted-foreground">{hint}</span>}
    </label>
  );
}

export function GatewayEmpty({
  children,
  tone,
}: {
  children: ReactNode;
  tone?: "muted" | "error";
}) {
  return (
    <div
      className={cn(
        "rounded-lg border border-dashed px-3 py-6 text-center text-ui-sm",
        tone === "error"
          ? "border-destructive/30 text-destructive"
          : "border-[color:var(--color-border)] text-muted-foreground",
      )}
    >
      {children}
    </div>
  );
}

export function GatewayPill({
  children,
  tone,
}: {
  children: ReactNode;
  tone?: "muted" | "ok" | "warn" | "error";
}) {
  const variant =
    tone === "ok"
      ? "success"
      : tone === "warn"
        ? "warning"
        : tone === "error"
          ? "error"
          : "outline";
  return (
    <Badge variant={variant} size="sm" className="font-normal">
      {children}
    </Badge>
  );
}

/** Muted label for a read-only figure, with its value beneath. */
export function GatewayStat({
  label,
  value,
  hint,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <div className="min-w-0 px-3 py-2.5">
      <div className="text-ui-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-0.5 truncate text-ui font-medium text-foreground">{value}</div>
      {hint === undefined ? null : (
        <div className="mt-0.5 text-ui-xs text-muted-foreground">{hint}</div>
      )}
    </div>
  );
}

export function useGatewayCopyLabel(label: string): string {
  const { t } = useTranslation();
  return t("gateway:copy", { value0: label });
}
