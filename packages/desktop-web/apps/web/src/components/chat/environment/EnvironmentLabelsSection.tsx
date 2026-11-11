// FILE: EnvironmentLabelsSection.tsx
// Purpose: "Labels" section of the Environment panel — the Neox workspace tags assigned to
//          the active thread's checkout, toggled in place, plus the one-field way to name a new
//          one. Assigning an unknown name creates its catalog definition on the daemon.
// Layer: Environment panel section

import type { ThreadId } from "@synara/contracts";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { CircleCheckIcon } from "~/lib/icons";
import {
  findWorkspaceForDirectory,
  neolixWorkspaceLabelsQueryOptions,
  neolixWorkspacesQueryOptions,
  useSetWorkspaceLabel,
  workspaceLabelColorClass,
} from "~/lib/workspaceLabels";
import { cn } from "~/lib/utils";
import { useTranslation } from "~/i18n";
import { Input } from "~/components/ui/input";

import { EnvironmentLabeledSection, EnvironmentRow } from "./EnvironmentRow";

export function EnvironmentLabelsSection({
  threadId,
  cwd,
}: {
  threadId: ThreadId | null;
  /** The thread's checkout directory; the daemon keys labels by workspace directory. */
  cwd: string | null;
}) {
  const { t } = useTranslation();
  const definitions = useQuery(neolixWorkspaceLabelsQueryOptions());
  const workspaces = useQuery(neolixWorkspacesQueryOptions());
  const [draft, setDraft] = useState("");
  const workspace = findWorkspaceForDirectory(workspaces.data?.workspaces ?? [], cwd);
  const assigned = new Set(workspace?.labels ?? []);
  const setLabel = useSetWorkspaceLabel({
    threadId: threadId ?? "",
    workspaceId: workspace?.id ?? null,
  });
  const labels = definitions.data?.labels ?? [];
  if (!threadId || !cwd) return null;

  const assignDraft = () => {
    const name = draft.trim();
    if (!name || setLabel.isPending) return;
    setDraft("");
    void setLabel.mutateAsync({ label: { name, color: "violet" }, assigned: true });
  };

  return (
    <EnvironmentLabeledSection label={t("chat:environment_labelsSection")}>
      {labels.map((label) => {
        const isAssigned = assigned.has(label.name);
        return (
          <EnvironmentRow
            key={label.name}
            icon={
              <span
                aria-hidden
                className={cn("size-2 rounded-full", workspaceLabelColorClass(label.color))}
              />
            }
            label={label.name}
            trailing={
              isAssigned ? <CircleCheckIcon aria-hidden className="size-3.5 opacity-70" /> : null
            }
            aria-pressed={isAssigned}
            disabled={setLabel.isPending}
            onClick={() => {
              void setLabel.mutateAsync({ label, assigned: !isAssigned });
            }}
          />
        );
      })}
      <div className="flex items-center gap-2 px-2 py-1">
        <Input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            assignDraft();
          }}
          placeholder={t("chat:environment_newLabel")}
          aria-label={t("chat:environment_newLabel")}
          className="h-7 text-ui"
        />
      </div>
    </EnvironmentLabeledSection>
  );
}
