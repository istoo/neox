// FILE: GatewayMaskingPane.tsx
// Purpose: What the gateway keeps from vendors — detectors, actions, allow
//          list, custom rules, the local guard model, records and a preview.
// Layer: Settings panel pane

import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { neolixGatewayApi } from "~/lib/neolixGatewayApi";
import type {
  GatewayConfig,
  GatewayMaskingConfig,
  GatewayMaskingPreview,
  GatewayMaskingRecord,
  GatewayMaskingSummary,
} from "~/lib/gatewayTypes";
import { useTranslation } from "~/i18n";
import { toastManager } from "../../ui/toast";

import { Button } from "../../ui/button";
import { SettingsSection } from "../SettingsPanelPrimitives";
import { listText, maskSecret, stringList } from "./gatewayHelpers";
import {
  GatewayEmpty,
  GatewayField,
  GatewayPill,
  GatewayRow,
  GatewayTextarea,
  GatewayToggle,
} from "./GatewayPrimitives";
import {
  MASKING_SCORE_DEFAULT,
  MASKING_SCORE_MAX,
  MASKING_SCORE_MIN,
  effectiveMaskingScore,
  isMaskingScore,
  maskingScoreOptions,
  maskingScoreSelectValue,
} from "./gatewayMaskingScore.logic";

const ACTIONS = ["mask", "warn", "block"] as const;

/** Built-in kinds the daemon's masker knows, in the page's order. */
const MASK_KINDS = [
  "PRIVATE_KEY",
  "API_KEY",
  "GITHUB_TOKEN",
  "AWS_KEY",
  "SLACK_TOKEN",
  "BEARER_TOKEN",
  "TOKEN",
  "PASSWORD",
  "SECRET",
  "EMAIL",
  "PHONE",
  "ID_CARD",
  "CARD",
  "IBAN",
  "SSN",
  "PASSPORT",
  "BIRTHDAY",
  "MAC",
  "SERIAL",
  "IP",
  "USERNAME",
  "HOSTNAME",
  "BUCKET",
] as const;

interface MaskingRuleDraft {
  kind: string;
  prefix?: string | undefined;
  pattern: string;
  flags?: string | undefined;
}

export interface GatewayMaskingProps {
  config: GatewayConfig;
  edit: (mutate: (draft: GatewayConfig) => void) => void;
  apply: (mutate: (draft: GatewayConfig) => void) => Promise<void>;
}

function maskingOf(config: GatewayConfig): GatewayMaskingConfig {
  return config.masking ?? { enabled: false };
}

function updateMasking(
  edit: GatewayMaskingProps["edit"],
  mutate: (draft: GatewayMaskingConfig) => void,
) {
  edit((draft) => {
    const masking = draft.masking ?? { enabled: false };
    mutate(masking);
    draft.masking = masking;
  });
}

type Translate = ReturnType<typeof useTranslation>["t"];

async function runMaskingClear(
  refetchSummary: () => Promise<unknown>,
  refetchRecords: () => Promise<unknown>,
  translate: Translate,
  setClearing: (value: boolean) => void,
): Promise<void> {
  setClearing(true);
  try {
    await neolixGatewayApi.maskingClear();
    await Promise.all([refetchSummary(), refetchRecords()]);
    toastManager.add({ type: "success", title: translate("gateway:masking_cleared") });
  } finally {
    setClearing(false);
  }
}

export function GatewayMaskingPane({ config, edit, apply }: GatewayMaskingProps) {
  const { t } = useTranslation();
  const masking = maskingOf(config);
  const [days, setDays] = useState(7);
  const [showAllKinds, setShowAllKinds] = useState(false);
  const [recordLimit, setRecordLimit] = useState(50);
  const [previewText, setPreviewText] = useState("");
  const [preview, setPreview] = useState<Awaited<
    ReturnType<typeof neolixGatewayApi.maskingPreview>
  > | null>(null);
  const [clearing, setClearing] = useState(false);

  const summary = useQuery({
    queryKey: ["neolix-gateway", "masking", "summary", days],
    queryFn: () => neolixGatewayApi.maskingSummary({ days }),
  });
  const records = useQuery({
    queryKey: ["neolix-gateway", "masking", "records", days, recordLimit],
    queryFn: () => neolixGatewayApi.maskingRecords({ query: { limit: recordLimit } }),
  });
  const localModel = useQuery({
    queryKey: ["neolix-gateway", "masking", "model"],
    queryFn: neolixGatewayApi.maskingLocalModelStatus,
  });

  // Myna draws the threshold only while masking finds something and the model
  // can run here; 0.8 is the publisher's default, stored as no score at all.
  const score = effectiveMaskingScore(masking.modelScore, localModel.data?.score);
  const scoreOptions = maskingScoreOptions(score);
  const maskingFinds = masking.enabled || masking.personal === true;
  const showScore =
    maskingFinds && (localModel.data?.supported === true || localModel.data?.installed === true);

  const kindNames = useMemo(() => {
    if (showAllKinds) return [...MASK_KINDS];
    const names = new Set<string>(masking.categories ?? []);
    for (const kind of summary.data?.kinds ?? []) names.add(kind.name);
    for (const kind of Object.keys(masking.actions ?? {})) names.add(kind);
    for (const rule of masking.rules ?? []) {
      if (rule.kind.trim().length > 0) names.add(rule.kind.trim());
    }
    return [...names];
  }, [masking.categories, masking.actions, masking.rules, showAllKinds, summary.data]);
  const hiddenKindCount = MASK_KINDS.filter((kind) => !kindNames.includes(kind)).length;

  return (
    <div className="flex flex-col gap-6">
      <SettingsSection title="gateway:masking_title">
        <GatewayRow
          title={t("gateway:masking_enabled")}
          description={t("gateway:masking_enabled_hint")}
          trailing={
            <GatewayToggle
              checked={masking.enabled}
              label={t("gateway:masking_enabled")}
              onChange={(checked) =>
                void apply((draft) => {
                  draft.masking = { ...(draft.masking ?? { enabled: false }), enabled: checked };
                })
              }
            />
          }
        />
        <GatewayRow
          title={t("gateway:masking_personal")}
          description={t("gateway:masking_personal_hint")}
          trailing={
            <GatewayToggle
              checked={masking.personal === true}
              label={t("gateway:masking_personal")}
              onChange={(checked) =>
                updateMasking(edit, (draft) => {
                  draft.personal = checked;
                })
              }
            />
          }
        />
        <GatewayRow
          title={t("gateway:masking_alert")}
          description={t("gateway:masking_alert_hint")}
          trailing={
            <GatewayToggle
              checked={masking.alert === true}
              label={t("gateway:masking_alert")}
              onChange={(checked) =>
                updateMasking(edit, (draft) => {
                  draft.alert = checked;
                })
              }
            />
          }
        />
        <GatewayRow
          title={t("gateway:masking_shape")}
          description={t("gateway:masking_shape_hint")}
          trailing={
            <GatewayToggle
              checked={masking.shape === true}
              label={t("gateway:masking_shape")}
              onChange={(checked) =>
                updateMasking(edit, (draft) => {
                  draft.shape = checked;
                })
              }
            />
          }
        />
        <GatewayRow
          title={t("gateway:masking_route")}
          description={t("gateway:masking_route_hint")}
        >
          <GatewayField
            label=""
            value={masking.routeTo ?? ""}
            placeholder="provider/model"
            onChange={(value) =>
              updateMasking(edit, (draft) => {
                draft.routeTo = value || undefined;
              })
            }
          />
        </GatewayRow>
        <GatewayRow
          title={t("gateway:masking_allow")}
          description={t("gateway:masking_allow_hint")}
        >
          <GatewayTextarea
            label=""
            value={listText(masking.allow)}
            onChange={(value) =>
              updateMasking(edit, (draft) => {
                draft.allow = stringList(value);
              })
            }
            rows={2}
          />
        </GatewayRow>
        <GatewayRow
          title={t("gateway:masking_words")}
          description={t("gateway:masking_words_hint")}
        >
          <GatewayTextarea
            label=""
            value={listText(masking.words)}
            onChange={(value) =>
              updateMasking(edit, (draft) => {
                draft.words = stringList(value);
              })
            }
            rows={2}
          />
        </GatewayRow>
        <div className="flex flex-wrap gap-4 px-3 py-2">
          <label className="flex items-center gap-2 text-ui-sm">
            <GatewayToggle
              checked={masking.wordsAnyCase === true}
              label={t("gateway:masking_words_any_case")}
              onChange={(checked) =>
                updateMasking(edit, (draft) => {
                  draft.wordsAnyCase = checked;
                })
              }
            />
            {t("gateway:masking_words_any_case")}
          </label>
          <label className="flex items-center gap-2 text-ui-sm">
            <GatewayToggle
              checked={masking.wordsWhole === true}
              label={t("gateway:masking_words_whole")}
              onChange={(checked) =>
                updateMasking(edit, (draft) => {
                  draft.wordsWhole = checked;
                })
              }
            />
            {t("gateway:masking_words_whole")}
          </label>
          <label className="flex items-center gap-2 text-ui-sm">
            <GatewayToggle
              checked={masking.categorySwitches?.userhost === true}
              label={t("gateway:masking_userhost")}
              onChange={(checked) =>
                updateMasking(edit, (draft) => {
                  draft.categorySwitches = { ...draft.categorySwitches, userhost: checked };
                })
              }
            />
            {t("gateway:masking_userhost")}
          </label>
          <label className="flex items-center gap-2 text-ui-sm">
            <GatewayToggle
              checked={masking.categorySwitches?.bucket === true}
              label={t("gateway:masking_bucket")}
              onChange={(checked) =>
                updateMasking(edit, (draft) => {
                  draft.categorySwitches = { ...draft.categorySwitches, bucket: checked };
                })
              }
            />
            {t("gateway:masking_bucket")}
          </label>
        </div>
      </SettingsSection>

      <SettingsSection title="gateway:masking_kinds">
        {kindNames.length === 0 ? (
          <div className="px-3 py-2">
            <GatewayEmpty>{t("gateway:masking_no_kinds")}</GatewayEmpty>
          </div>
        ) : (
          kindNames.map((kind) => (
            <GatewayRow
              key={kind}
              title={kind}
              trailing={
                <select
                  value={masking.actions?.[kind] ?? "mask"}
                  onChange={(event) => {
                    const value = event.currentTarget.value as (typeof ACTIONS)[number];
                    updateMasking(edit, (draft) => {
                      draft.actions = {
                        ...draft.actions,
                        [kind]: value,
                      };
                    });
                  }}
                  className="h-7 rounded-md border border-[color:var(--color-border)] bg-background px-2 text-ui-xs"
                >
                  {ACTIONS.map((action) => (
                    <option key={action} value={action}>
                      {action}
                    </option>
                  ))}
                </select>
              }
            />
          ))
        )}
        {hiddenKindCount > 0 || showAllKinds ? (
          <div className="px-3 py-2">
            <Button
              size="xs"
              variant="ghost"
              onClick={() => setShowAllKinds((current) => !current)}
            >
              {showAllKinds
                ? t("gateway:masking_show_fewer")
                : t("gateway:masking_show_all", { count: hiddenKindCount })}
            </Button>
          </div>
        ) : null}
        <MaskingRuleRows config={config} edit={edit} />
      </SettingsSection>

      <SettingsSection title="gateway:masking_model_title">
        {localModel.isLoading ? (
          <div className="px-3 py-2 text-ui-sm text-muted-foreground">{t("gateway:loading")}</div>
        ) : localModel.data ? (
          <>
            <GatewayRow
              title={localModel.data.model || "AstrLink Guard"}
              description={`${t(
                localModel.data.supported
                  ? "gateway:masking_supported"
                  : "gateway:masking_unsupported",
              )} · ${t(
                localModel.data.installed
                  ? "gateway:masking_installed"
                  : "gateway:masking_notInstalled",
              )}${localModel.data.device ? ` · ${localModel.data.device}` : ""}${
                localModel.data.error ? ` · ${localModel.data.error}` : ""
              }`}
              trailing={
                <div className="flex flex-wrap gap-1">
                  {localModel.data.downloading ? (
                    <>
                      <GatewayPill tone="warn">
                        {t("gateway:masking_downloading", {
                          done: Math.round(localModel.data.done ?? 0),
                          total: Math.round(localModel.data.total ?? 0),
                        })}
                      </GatewayPill>
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={() =>
                          void neolixGatewayApi
                            .maskingLocalModelCancel()
                            .then(() => localModel.refetch())
                        }
                      >
                        {t("gateway:cancel")}
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() =>
                          void neolixGatewayApi
                            .maskingLocalModelDownload()
                            .then(() => localModel.refetch())
                        }
                      >
                        {t("gateway:download")}
                      </Button>
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={() =>
                          void neolixGatewayApi
                            .maskingLocalModelRemove()
                            .then(() => localModel.refetch())
                        }
                      >
                        {t("gateway:remove")}
                      </Button>
                    </>
                  )}
                </div>
              }
            />
            <div className="grid gap-2 px-3 py-2 sm:grid-cols-2">
              <GatewayField
                label={t("gateway:masking_model")}
                value={masking.model ?? ""}
                placeholder="astrlink-guard"
                onChange={(value) =>
                  updateMasking(edit, (draft) => {
                    draft.model = value || undefined;
                  })
                }
              />
            </div>
            {showScore ? (
              <GatewayRow
                title={t("gateway:masking_score")}
                description={t("gateway:masking_score_hint")}
                trailing={
                  <div className="flex flex-col items-end gap-1">
                    <select
                      aria-label={t("gateway:masking_score")}
                      value={maskingScoreSelectValue(score)}
                      onChange={(event) => {
                        const value = event.currentTarget.value;
                        updateMasking(edit, (draft) => {
                          if (value === "") {
                            draft.modelScore = undefined;
                            return;
                          }
                          const parsed = Number(value);
                          if (!isMaskingScore(parsed)) return;
                          draft.modelScore = parsed;
                        });
                      }}
                      className="h-7 rounded-md border border-[color:var(--color-border)] bg-background px-2 text-ui-xs"
                    >
                      <option value="">
                        {t("gateway:masking_score_default", { score: MASKING_SCORE_DEFAULT })}
                      </option>
                      {scoreOptions.map((option) => (
                        <option key={option} value={String(option)}>
                          {String(option)}
                        </option>
                      ))}
                    </select>
                    <span className="text-ui-xs text-muted-foreground">
                      {t("gateway:masking_score_range")}
                      {score === MASKING_SCORE_MIN ? ` · ${t("gateway:masking_score_most")}` : null}
                      {score === MASKING_SCORE_MAX
                        ? ` · ${t("gateway:masking_score_least")}`
                        : null}
                    </span>
                    {masking.model === localModel.data.model ? null : (
                      <span className="text-ui-xs text-muted-foreground">
                        {t("gateway:masking_score_model_off")}
                      </span>
                    )}
                  </div>
                }
              />
            ) : null}
          </>
        ) : (
          <div className="px-3 py-2">
            <GatewayEmpty>{t("gateway:masking_no_model")}</GatewayEmpty>
          </div>
        )}
      </SettingsSection>

      <SettingsSection title="gateway:masking_summary_title">
        <div className="flex flex-wrap items-center gap-2 px-3 py-2">
          <select
            value={days}
            onChange={(event) => setDays(Number(event.currentTarget.value))}
            className="h-7 rounded-md border border-[color:var(--color-border)] bg-background px-2 text-ui-xs"
          >
            <option value={7}>{t("gateway:days_7")}</option>
            <option value={30}>{t("gateway:days_30")}</option>
          </select>
          <Button size="xs" variant="ghost" onClick={() => void summary.refetch()}>
            {t("gateway:refresh")}
          </Button>
          <select
            value={recordLimit}
            onChange={(event) => setRecordLimit(Number(event.currentTarget.value))}
            aria-label={t("gateway:masking_record_limit")}
            className="h-7 rounded-md border border-[color:var(--color-border)] bg-background px-2 text-ui-xs"
          >
            <option value={50}>50</option>
            <option value={100}>100</option>
            <option value={200}>200</option>
          </select>
          <Button
            size="xs"
            variant="ghost"
            disabled={clearing}
            onClick={() => {
              if (!window.confirm(t("gateway:masking_clear_confirm"))) return;
              void runMaskingClear(summary.refetch, records.refetch, t, setClearing);
            }}
          >
            {t("gateway:masking_clear")}
          </Button>
        </div>
        {summary.data ? (
          <div className="grid grid-cols-2 gap-px bg-[color:var(--color-border)] sm:grid-cols-5">
            <MaskStat label={t("gateway:masking_values")} value={summary.data.n} />
            <MaskStat label={t("gateway:masking_distinct")} value={summary.data.distinct} />
            <MaskStat label={t("gateway:masking_requests")} value={summary.data.requests} />
            <MaskStat label={t("gateway:masking_blocked")} value={summary.data.blocked} />
            <MaskStat label={t("gateway:masking_restored")} value={summary.data.restored} />
          </div>
        ) : null}
        {(summary.data?.kinds ?? []).length > 0 ? (
          <div className="flex flex-wrap gap-1 px-3 py-2">
            {summary.data?.kinds.map((kind) => (
              <GatewayPill key={kind.name}>
                {kind.name} · {kind.n}
              </GatewayPill>
            ))}
          </div>
        ) : null}
        {summary.data ? (
          <>
            <DayStrip days={summary.data.days} />
            <div className="grid gap-2 px-3 py-2 sm:grid-cols-2">
              <SummaryList title={t("gateway:masking_by_agent")} entries={summary.data.agents} />
              <SummaryList
                title={t("gateway:masking_by_provider")}
                entries={summary.data.providers}
              />
            </div>
            <div className="flex flex-wrap gap-1 px-3 pb-2 text-ui-xs text-muted-foreground">
              <span>{t("gateway:masking_by_rule", { count: summary.data.by.rule })}</span>
              <span>· {t("gateway:masking_by_yours", { count: summary.data.by.yours })}</span>
              <span>· {t("gateway:masking_by_model", { count: summary.data.by.model })}</span>
            </div>
          </>
        ) : null}
        {records.isLoading ? (
          <div className="px-3 py-2 text-ui-sm text-muted-foreground">{t("gateway:loading")}</div>
        ) : (records.data?.records.length ?? 0) === 0 ? (
          <div className="px-3 py-2">
            <GatewayEmpty>{t("gateway:masking_no_records")}</GatewayEmpty>
          </div>
        ) : (
          records.data?.records.map((record) => <RecordRow key={record.key} record={record} />)
        )}
      </SettingsSection>

      <SettingsSection title="gateway:masking_preview_title">
        <div className="space-y-2 px-3 py-2">
          <GatewayTextarea
            label={t("gateway:masking_preview_input")}
            value={previewText}
            onChange={setPreviewText}
            rows={4}
            placeholder={t("gateway:masking_placeholder")}
          />
          <div className="flex justify-end">
            <Button
              size="xs"
              variant="outline"
              disabled={!previewText.trim()}
              onClick={async () => {
                try {
                  setPreview(await neolixGatewayApi.maskingPreview(previewText));
                } catch (error) {
                  toastManager.add({
                    type: "error",
                    title: error instanceof Error ? error.message : String(error),
                  });
                }
              }}
            >
              {t("gateway:masking_preview_run")}
            </Button>
          </div>
          {preview ? (
            <>
              <HighlightedPreview text={preview.text} hits={preview.hits} />
              <div className="flex flex-wrap gap-1">
                {preview.off ? (
                  <GatewayPill tone="muted">{t("gateway:masking_off")}</GatewayPill>
                ) : null}
                {preview.blocked ? (
                  <GatewayPill tone="error">{t("gateway:masking_blocked")}</GatewayPill>
                ) : null}
              </div>
              {preview.hits.length > 0 ? (
                <div className="space-y-1">
                  {preview.hits.map((hit) => (
                    // A preview hit has no id but its place in the text.
                    // oxlint-disable-next-line react/no-array-index-key
                    <div
                      key={`${hit.placeholder}-${hit.kind}-${hit.head ?? ""}-${hit.len}`}
                      className="flex flex-wrap items-center justify-between gap-1 border-t border-[color:var(--color-border)] pt-1 text-ui-xs"
                    >
                      <span className="min-w-0 truncate font-mono">
                        {hit.placeholder}
                        {hit.head ? ` · ${maskSecret(hit.head)}` : ""}
                      </span>
                      <span className="flex items-center gap-1 text-muted-foreground">
                        <GatewayPill tone={hit.action === "block" ? "error" : "muted"}>
                          {hit.kind}
                        </GatewayPill>
                        <GatewayPill>{hit.by}</GatewayPill>
                        <GatewayPill tone={hit.action === "block" ? "error" : "muted"}>
                          {hit.action ?? "mask"}
                        </GatewayPill>
                        <span>{hit.len}</span>
                      </span>
                    </div>
                  ))}
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      </SettingsSection>
    </div>
  );
}

function MaskStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-[var(--color-background-elevated-primary-opaque)] px-3 py-2">
      <div className="text-ui-xs text-muted-foreground">{label}</div>
      <div className="text-ui font-medium">{value}</div>
    </div>
  );
}

function RecordRow({ record }: { record: GatewayMaskingRecord }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const detail = useQuery({
    queryKey: ["neolix-gateway", "masking", "record", record.key],
    queryFn: () => neolixGatewayApi.maskingRecord(record.key),
    enabled: open,
  });
  return (
    <div>
      <GatewayRow
        title={`${record.agent ?? record.provider ?? "gateway"} · ${record.model ?? ""}`}
        description={`${record.t} · ${t("gateway:masking_record_values", { count: record.n })}${
          record.blocked ? ` · ${t("gateway:masking_blocked")}` : ""
        }`}
        trailing={
          <div className="flex flex-wrap items-center gap-1">
            {record.values.slice(0, 4).map((value) => (
              <GatewayPill key={value.p} tone={value.a === "block" ? "error" : "muted"}>
                {value.k}
              </GatewayPill>
            ))}
            <Button size="xs" variant="ghost" onClick={() => setOpen((value) => !value)}>
              {open ? t("gateway:hide") : t("gateway:details")}
            </Button>
          </div>
        }
      />
      {open ? (
        <div className="mx-3 mb-2 rounded-md bg-foreground/4 px-2 py-1.5 text-ui-xs text-muted-foreground">
          {detail.isLoading ? (
            t("gateway:loading")
          ) : detail.data === null ? (
            t("gateway:unknown")
          ) : (
            <div className="space-y-0.5">
              {(detail.data?.values ?? record.values).map((value) => (
                // A record's values have no id but their place.
                // oxlint-disable-next-line react/no-array-index-key
                <div key={`${value.p}-${value.k}`} className="flex flex-wrap justify-between gap-1">
                  <span className="font-mono">
                    {value.p} · {value.k}
                    {value.h ? ` · ${value.h}` : ""}
                  </span>
                  <span>
                    {t("gateway:masking_value_detail", {
                      len: value.l,
                      count: value.n,
                      action: value.a ?? "mask",
                    })}
                  </span>
                </div>
              ))}
              {detail.data?.back
                ? Object.entries(detail.data.back).map(([name, count]) => (
                    <div key={name}>{t("gateway:masking_restored_by", { name, count })}</div>
                  ))
                : null}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

/** The user's own patterns, edited row by row instead of as one JSON block. */
function MaskingRuleRows({
  config,
  edit,
}: {
  config: GatewayConfig;
  edit: GatewayMaskingProps["edit"];
}) {
  const { t } = useTranslation();
  const rules = (config.masking?.rules ?? []) as MaskingRuleDraft[];
  const write = (next: MaskingRuleDraft[]) =>
    updateMasking(edit, (draft) => {
      draft.rules =
        next.length === 0
          ? undefined
          : next.map((rule) => ({
              kind: rule.kind,
              pattern: rule.pattern,
              ...(rule.prefix ? { prefix: rule.prefix } : {}),
              ...(rule.flags ? { flags: rule.flags } : {}),
            }));
    });
  const change = (index: number, patch: Partial<MaskingRuleDraft>) =>
    write(rules.map((rule, at) => (at === index ? { ...rule, ...patch } : rule)));
  return (
    <div className="space-y-2 px-3 py-2">
      <div className="text-ui-sm text-muted-foreground">{t("gateway:masking_rules")}</div>
      <div className="text-ui-xs text-muted-foreground">{t("gateway:masking_rules_hint")}</div>
      {rules.map((rule, index) => (
        <div
          // The rows are positional: a rule has no id of its own.
          // oxlint-disable-next-line react/no-array-index-key
          key={`${rule.kind}:${rule.pattern}:${rule.prefix ?? ""}:${rule.flags ?? ""}`}
          className="grid gap-1.5 rounded-md border border-[color:var(--color-border)] p-2 sm:grid-cols-5"
        >
          <div className="flex flex-col gap-1">
            <GatewayField
              label={t("gateway:masking_rule_kind")}
              value={rule.kind}
              onChange={(value) => change(index, { kind: value })}
            />
            {rule.kind.trim() === "" ? (
              <div className="text-ui-xs text-destructive">
                {t("gateway:error_mask_kind", { line: index + 1 })}
              </div>
            ) : null}
          </div>
          <GatewayField
            label={t("gateway:masking_rule_prefix")}
            value={rule.prefix ?? ""}
            onChange={(value) => change(index, { prefix: value || undefined })}
          />
          <GatewayField
            label={t("gateway:masking_rule_pattern")}
            value={rule.pattern}
            onChange={(value) => change(index, { pattern: value })}
          />
          <GatewayField
            label={t("gateway:masking_rule_flags")}
            value={rule.flags ?? ""}
            onChange={(value) => change(index, { flags: value || undefined })}
          />
          <div className="flex items-end">
            <Button
              size="xs"
              variant="ghost"
              onClick={() => write(rules.filter((_, at) => at !== index))}
            >
              {t("gateway:remove")}
            </Button>
          </div>
        </div>
      ))}
      <Button
        size="xs"
        variant="ghost"
        onClick={() => write([...rules, { kind: "", pattern: "" }])}
      >
        {t("gateway:masking_rule_add")}
      </Button>
    </div>
  );
}

function DayStrip({ days }: { days: GatewayMaskingSummary["days"] }) {
  const max = Math.max(1, ...days.map((day) => day.n));
  if (days.length === 0) return null;
  return (
    <div className="flex h-12 items-end gap-0.5 px-3 py-2">
      {days.map((day) => (
        <div
          key={day.day}
          title={`${day.day}: ${day.n} · ${day.requests}`}
          className="min-w-[3px] flex-1 rounded-sm bg-foreground/20 hover:bg-foreground/40"
          style={{ height: `${Math.max(2, (day.n / max) * 100)}%` }}
        />
      ))}
    </div>
  );
}

function SummaryList({
  title,
  entries,
}: {
  title: string;
  entries: Array<{ name: string; n: number }>;
}) {
  if (entries.length === 0) return null;
  return (
    <div>
      <div className="mb-0.5 text-ui-xs uppercase tracking-wide text-muted-foreground">{title}</div>
      <div className="space-y-0.5">
        {entries.slice(0, 10).map((entry) => (
          <div key={entry.name} className="flex justify-between gap-2 text-ui-xs">
            <span className="truncate">{entry.name}</span>
            <span className="text-muted-foreground">{entry.n}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** The preview text with each placeholder coloured by its action. */
function HighlightedPreview({ text, hits }: { text: string; hits: GatewayMaskingPreview["hits"] }) {
  const segments: Array<{ id: number; text: string; action?: string | undefined }> = [];
  const push = (text: string, action?: string) => {
    segments.push({ id: segments.length, text, ...(action === undefined ? {} : { action }) });
  };
  let index = 0;
  while (index < text.length) {
    let at = -1;
    let picked: GatewayMaskingPreview["hits"][number] | null = null;
    for (const hit of hits) {
      const found = text.indexOf(hit.placeholder, index);
      if (found >= 0 && (at < 0 || found < at)) {
        at = found;
        picked = hit;
      }
    }
    if (picked === null || at < 0) {
      push(text.slice(index));
      break;
    }
    if (at > index) push(text.slice(index, at));
    push(picked.placeholder, picked.action ?? "mask");
    index = at + picked.placeholder.length;
  }
  return (
    <pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded-md bg-foreground/5 p-2 text-ui-sm">
      {segments.map((segment) =>
        segment.action === undefined ? (
          <span key={segment.id}>{segment.text}</span>
        ) : (
          <mark
            key={segment.id}
            className={
              segment.action === "block"
                ? "rounded bg-destructive/20 text-destructive"
                : segment.action === "warn"
                  ? "rounded bg-warning/20 text-warning"
                  : "rounded bg-foreground/15 text-foreground"
            }
          >
            {segment.text}
          </mark>
        ),
      )}
    </pre>
  );
}
