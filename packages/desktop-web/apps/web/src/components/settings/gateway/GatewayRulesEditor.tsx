// FILE: GatewayRulesEditor.tsx
// Purpose: Visual editor for a routing group's rules (conditions and the member
//          they send to), with the raw JSON kept as an advanced view and both
//          sides applying to the same `group.rules`.
// Layer: Settings UI component

import { useEffect, useMemo, useState } from "react";

import { useTranslation } from "~/i18n";
import type { GatewayEffort, GatewayGroup, GatewayGroupRule } from "~/lib/gatewayTypes";

import { Button } from "../../ui/button";
import { GatewayEmpty, GatewayRow, GatewayToggle } from "./GatewayPrimitives";

const EFFORTS: GatewayEffort[] = ["low", "medium", "high", "xhigh", "max"];

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function ruleTimePatch(
  rule: GatewayGroupRule,
  patch: { from?: string; to?: string; days?: string[]; zone?: string },
): void {
  const from = patch.from ?? rule.time?.from ?? "";
  const to = patch.to ?? rule.time?.to ?? "";
  const days = patch.days ?? rule.time?.days ?? [];
  const zone = patch.zone ?? rule.time?.zone ?? "";
  if (from.length === 0 && to.length === 0) {
    rule.time = undefined;
    return;
  }
  rule.time = {
    from,
    to,
    ...(days.length === 0 ? {} : { days }),
    ...(zone.length === 0 ? {} : { zone }),
  };
}

let ruleKeySeq = 0;

function makeRuleKeys(count: number): string[] {
  return Array.from({ length: count }, () => `gateway-rule-${ruleKeySeq++}`);
}

type Translate = ReturnType<typeof useTranslation>["t"];

type ParsedRules = { ok: true; rules: GatewayGroupRule[] } | { ok: false; error: string };

function parseRulesJson(jsonDraft: string, translate: Translate): ParsedRules {
  try {
    const parsed: unknown = JSON.parse(jsonDraft);
    if (!Array.isArray(parsed)) {
      return { ok: false, error: translate("gateway:rules_not_array") };
    }
    const next: GatewayGroupRule[] = [];
    for (const entry of parsed) {
      if (
        entry === null ||
        typeof entry !== "object" ||
        typeof (entry as { use?: unknown }).use !== "string"
      ) {
        return { ok: false, error: translate("gateway:rules_entry_invalid") };
      }
      next.push(structuredClone(entry) as GatewayGroupRule);
    }
    return { ok: true, rules: next };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function CommaField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: readonly string[];
  onChange: (items: string[]) => void;
  placeholder?: string;
}) {
  const [text, setText] = useState(() => value.join(", "));
  useEffect(() => {
    setText(value.join(", "));
  }, [value]);
  return (
    <label className="flex flex-col gap-1">
      <span className="text-ui-xs text-muted-foreground">{label}</span>
      <input
        value={text}
        onChange={(event) => setText(event.currentTarget.value)}
        onBlur={() => onChange(splitList(text))}
        onKeyDown={(event) => {
          if (event.key === "Enter") onChange(splitList(text));
        }}
        placeholder={placeholder}
        className="h-7 rounded border border-[color:var(--color-border)] bg-transparent px-2 text-ui-xs"
      />
    </label>
  );
}

export interface GatewayRulesEditorProps {
  group: GatewayGroup;
  onChange: (mutate: (group: GatewayGroup) => void) => void;
}

export function GatewayRulesEditor({ group, onChange }: GatewayRulesEditorProps) {
  const { t } = useTranslation();
  const rules = group.rules ?? [];
  const [jsonOpen, setJsonOpen] = useState(false);
  const [jsonDraft, setJsonDraft] = useState<string | null>(null);
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [keys, setKeys] = useState<string[]>(() => makeRuleKeys(rules.length));

  useEffect(() => {
    if (keys.length !== rules.length) setKeys(makeRuleKeys(rules.length));
    // makeRuleKeys only advances a counter; the length is the only trigger.
  }, [rules.length, keys.length]);

  const members = useMemo(() => group.members, [group.members]);
  const setRules = (next: GatewayGroupRule[]) =>
    onChange((draft) => {
      draft.rules = next.length === 0 ? undefined : next;
    });

  const updateRule = (index: number, mutate: (rule: GatewayGroupRule) => void) => {
    const next = structuredClone(rules);
    const rule = next[index];
    if (!rule) return;
    mutate(rule);
    setRules(next);
  };

  const moveRule = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= rules.length) return;
    const next = structuredClone(rules);
    const [entry] = next.splice(index, 1);
    if (!entry) return;
    next.splice(target, 0, entry);
    setKeys((current) => {
      const copy = [...current];
      const [key] = copy.splice(index, 1);
      if (key) copy.splice(target, 0, key);
      return copy;
    });
    setRules(next);
  };

  const applyJson = () => {
    if (jsonDraft === null) return;
    const parsed = parseRulesJson(jsonDraft, t);
    if (!parsed.ok) {
      setJsonError(parsed.error);
      return;
    }
    setJsonError(null);
    setRules(parsed.rules);
    setJsonDraft(null);
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-ui-sm text-muted-foreground">{t("gateway:rules")}</div>
          <div className="text-ui-xs text-muted-foreground">{t("gateway:rules_hint")}</div>
        </div>
        <div className="flex items-center gap-1">
          <Button
            size="xs"
            variant="ghost"
            onClick={() => {
              setJsonOpen((open) => !open);
              setJsonDraft(null);
              setJsonError(null);
            }}
          >
            {jsonOpen ? t("gateway:rules_visual") : t("gateway:rules_json")}
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={members.length === 0}
            onClick={() =>
              onChange((draft) => {
                draft.rules = [...(draft.rules ?? []), { use: draft.members[0] ?? "" }];
              })
            }
          >
            {t("gateway:add_rule")}
          </Button>
        </div>
      </div>

      {jsonOpen ? (
        <div className="space-y-2">
          <textarea
            value={jsonDraft ?? JSON.stringify(rules, null, 2)}
            onChange={(event) => setJsonDraft(event.currentTarget.value)}
            rows={10}
            className="w-full resize-y rounded-lg border border-[color:var(--color-border)] bg-transparent px-2.5 py-2 font-mono text-ui-sm outline-none focus-visible:border-foreground/30"
          />
          {jsonError ? <div className="text-ui-xs text-destructive">{jsonError}</div> : null}
          <div className="flex justify-end">
            <Button size="xs" variant="outline" onClick={applyJson}>
              {t("gateway:apply")}
            </Button>
          </div>
        </div>
      ) : rules.length === 0 ? (
        <GatewayEmpty>{t("gateway:rules_empty")}</GatewayEmpty>
      ) : (
        rules.map((rule, index) => {
          const useError = rule.use.trim() === "";
          const timeError =
            rule.time !== undefined &&
            (rule.time.from.trim() === "") !== (rule.time.to.trim() === "");
          return (
            <div
              key={keys[index] ?? `rule-${index}`}
              className="rounded-lg border border-[color:var(--color-border)] p-2.5"
            >
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <span className="text-ui-xs font-medium text-muted-foreground">
                  {t("gateway:rule_number", { number: index + 1 })}
                </span>
                <div className="flex items-center gap-0.5">
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={index === 0}
                    onClick={() => moveRule(index, -1)}
                  >
                    ↑
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={index === rules.length - 1}
                    onClick={() => moveRule(index, 1)}
                  >
                    ↓
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => setRules(rules.filter((_, position) => position !== index))}
                  >
                    {t("gateway:remove")}
                  </Button>
                </div>
              </div>

              <div className="grid gap-2 sm:grid-cols-2">
                <label className="flex flex-col gap-1">
                  <span className="text-ui-xs text-muted-foreground">{t("gateway:rule_use")}</span>
                  <input
                    list={`rule-members-${group.id}`}
                    value={rule.use}
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      updateRule(index, (draft) => {
                        draft.use = value;
                      });
                    }}
                    placeholder="provider/model"
                    aria-invalid={useError}
                    className="h-7 rounded border border-[color:var(--color-border)] bg-transparent px-2 font-mono text-ui-xs"
                  />
                  <datalist id={`rule-members-${group.id}`}>
                    {members.map((member) => (
                      <option key={member} value={member} />
                    ))}
                  </datalist>
                  {useError ? (
                    <span className="text-ui-xs text-destructive">
                      {t("gateway:rule_use_required")}
                    </span>
                  ) : null}
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-ui-xs text-muted-foreground">
                    {t("gateway:rule_use_effort")}
                  </span>
                  <select
                    value={rule.useEffort ?? ""}
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      updateRule(index, (draft) => {
                        draft.useEffort = EFFORTS.find((effort) => effort === value);
                      });
                    }}
                    className="h-7 rounded border border-[color:var(--color-border)] bg-background px-2 text-ui-xs"
                  >
                    <option value="">{t("gateway:unset")}</option>
                    {EFFORTS.map((effort) => (
                      <option key={effort} value={effort}>
                        {effort}
                      </option>
                    ))}
                  </select>
                </label>
                <CommaField
                  label={t("gateway:rule_more")}
                  value={rule.more ?? []}
                  onChange={(more) =>
                    updateRule(index, (draft) => {
                      draft.more = more.length === 0 ? undefined : more;
                    })
                  }
                  placeholder="provider/model, provider/other"
                />
                <CommaField
                  label={t("gateway:rule_agents")}
                  value={rule.agents ?? []}
                  onChange={(agents) =>
                    updateRule(index, (draft) => {
                      draft.agents = agents.length === 0 ? undefined : agents;
                    })
                  }
                  placeholder="Claude Code, Codex"
                />
                <label className="flex flex-col gap-1">
                  <span className="text-ui-xs text-muted-foreground">
                    {t("gateway:rule_tokens")}
                  </span>
                  <input
                    value={rule.tokens === undefined ? "" : String(rule.tokens)}
                    onChange={(event) => {
                      const parsed = Number.parseInt(event.currentTarget.value, 10);
                      updateRule(index, (draft) => {
                        draft.tokens = Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
                      });
                    }}
                    inputMode="numeric"
                    placeholder="≥ tokens"
                    className="h-7 rounded border border-[color:var(--color-border)] bg-transparent px-2 text-ui-xs"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-ui-xs text-muted-foreground">
                    {t("gateway:rule_effort")}
                  </span>
                  <input
                    value={rule.effort ?? ""}
                    onChange={(event) => {
                      const value = event.currentTarget.value || undefined;
                      updateRule(index, (draft) => {
                        draft.effort = value;
                      });
                    }}
                    placeholder="on, high"
                    className="h-7 rounded border border-[color:var(--color-border)] bg-transparent px-2 text-ui-xs"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-ui-xs text-muted-foreground">
                    {t("gateway:rule_intent")}
                  </span>
                  <input
                    value={rule.intent ?? ""}
                    onChange={(event) => {
                      const value = event.currentTarget.value || undefined;
                      updateRule(index, (draft) => {
                        draft.intent = value;
                      });
                    }}
                    placeholder="debug, refactor"
                    className="h-7 rounded border border-[color:var(--color-border)] bg-transparent px-2 text-ui-xs"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-ui-xs text-muted-foreground">
                    {t("gateway:rule_time_from")}
                  </span>
                  <input
                    value={rule.time?.from ?? ""}
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      updateRule(index, (draft) => {
                        ruleTimePatch(draft, { from: value });
                      });
                    }}
                    placeholder="22:00"
                    className="h-7 rounded border border-[color:var(--color-border)] bg-transparent px-2 text-ui-xs"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-ui-xs text-muted-foreground">
                    {t("gateway:rule_time_to")}
                  </span>
                  <input
                    value={rule.time?.to ?? ""}
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      updateRule(index, (draft) => {
                        ruleTimePatch(draft, { to: value });
                      });
                    }}
                    placeholder="08:00"
                    className="h-7 rounded border border-[color:var(--color-border)] bg-transparent px-2 text-ui-xs"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-ui-xs text-muted-foreground">{t("gateway:rule_zone")}</span>
                  <input
                    value={rule.time?.zone ?? ""}
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      updateRule(index, (draft) => {
                        ruleTimePatch(draft, { zone: value });
                      });
                    }}
                    placeholder="Asia/Shanghai"
                    className="h-7 rounded border border-[color:var(--color-border)] bg-transparent px-2 text-ui-xs"
                  />
                </label>
                <CommaField
                  label={t("gateway:rule_days")}
                  value={rule.time?.days ?? []}
                  onChange={(days) =>
                    updateRule(index, (draft) => {
                      ruleTimePatch(draft, { days });
                    })
                  }
                  placeholder="mon, tue"
                />
                <CommaField
                  label={t("gateway:rule_folders")}
                  value={rule.folders ?? []}
                  onChange={(folders) =>
                    updateRule(index, (draft) => {
                      draft.folders = folders.length === 0 ? undefined : folders;
                    })
                  }
                  placeholder="/Users/me/src/*"
                />
                <CommaField
                  label={t("gateway:rule_except_folders")}
                  value={rule.exceptFolders ?? []}
                  onChange={(exceptFolders) =>
                    updateRule(index, (draft) => {
                      draft.exceptFolders = exceptFolders.length === 0 ? undefined : exceptFolders;
                    })
                  }
                  placeholder="/Users/me/src/vendor"
                />
              </div>
              {timeError ? (
                <div className="mt-1 text-ui-xs text-destructive">
                  {t("gateway:rule_time_invalid")}
                </div>
              ) : null}
              <div className="mt-2 flex flex-wrap gap-4">
                <label className="flex items-center gap-2 text-ui-xs">
                  <GatewayToggle
                    checked={rule.images === true}
                    label={t("gateway:rule_images")}
                    onChange={(checked) =>
                      updateRule(index, (draft) => {
                        draft.images = checked ? true : undefined;
                      })
                    }
                  />
                  {t("gateway:rule_images")}
                </label>
                <label className="flex items-center gap-2 text-ui-xs">
                  <GatewayToggle
                    checked={rule.pause === true}
                    label={t("gateway:rule_pause")}
                    onChange={(checked) =>
                      updateRule(index, (draft) => {
                        draft.pause = checked ? true : undefined;
                      })
                    }
                  />
                  {t("gateway:rule_pause")}
                </label>
                <label className="flex items-center gap-2 text-ui-xs">
                  <GatewayToggle
                    checked={rule.compact === true}
                    label={t("gateway:rule_compact")}
                    onChange={(checked) =>
                      updateRule(index, (draft) => {
                        draft.compact = checked ? true : undefined;
                      })
                    }
                  />
                  {t("gateway:rule_compact")}
                </label>
              </div>
            </div>
          );
        })
      )}
      {rules.length > 0 ? (
        <GatewayRow
          title={t("gateway:rules_validation")}
          description={t("gateway:rules_validation_hint")}
        />
      ) : null}
    </div>
  );
}
