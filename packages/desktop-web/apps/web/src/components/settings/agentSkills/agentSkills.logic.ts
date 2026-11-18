// FILE: agentSkills.logic.ts
// Purpose: Pure decisions behind Settings › Host › Orchestration skills, kept
//          out of the panel so the React file only wires state to controls.
// Layer: Settings UI logic

import type {
  AgentSkillOperation,
  AgentSkillSelection,
  AgentSkillsStatus,
} from "@synara/contracts";

const OP_KIND_ORDER: Record<AgentSkillOperation["kind"], number> = {
  add: 0,
  update: 1,
  delete: 2,
};

/** Whether the host has Neolix's skills installed in any form, current or not. */
export function areSkillsInstalled(status: AgentSkillsStatus | null): boolean {
  return status !== null && status.state !== "not-installed";
}

/** Whether the saved selection names any skill there is to install. */
export function hasSelectedSkills(status: AgentSkillsStatus | null): boolean {
  if (!status) return false;
  if (status.selection.mode === "all") return status.available.length > 0;
  return status.selection.skills.some((name) => status.available.includes(name));
}

/**
 * Adding and updating are work to offer; deleting a deselected skill is a
 * choice made in the picker, not an update to advertise here.
 */
export function maintenanceOperations(
  status: AgentSkillsStatus | null,
): readonly AgentSkillOperation[] {
  return status?.ops.filter((op) => op.kind !== "delete") ?? [];
}

/** Whether the installed copy trails the bundled one in a way Update can fix. */
export function needsSkillUpdate(status: AgentSkillsStatus | null): boolean {
  return status?.state === "drift" && maintenanceOperations(status).length > 0;
}

/** The update confirmation body: what will be added or refreshed, in a stable order. */
export function formatUpdateMessage(
  ops: readonly AgentSkillOperation[],
  t: (key: string) => string,
): string {
  return ops
    .toSorted(
      (a, b) => OP_KIND_ORDER[a.kind] - OP_KIND_ORDER[b.kind] || a.name.localeCompare(b.name),
    )
    .map((op) => `${t(`settings:agentSkills_operations_${op.kind}`)} ${op.name}`)
    .join("\n");
}

export function isSkillSelected(selection: AgentSkillSelection, name: string): boolean {
  return selection.mode === "all" || selection.skills.includes(name);
}

/**
 * Leaving `all` keeps every currently installed skill checked, so turning the
 * switch off is a starting point rather than a reset.
 */
export function toggleAllSelection(
  nextAll: boolean,
  available: readonly string[],
): AgentSkillSelection {
  return nextAll ? { mode: "all" } : { mode: "custom", skills: [...available] };
}

/** Toggles one skill in a `custom` selection; `all` is left alone. */
export function toggleSkillSelection(
  selection: AgentSkillSelection,
  name: string,
): AgentSkillSelection {
  if (selection.mode === "all") return selection;
  const skills = selection.skills.includes(name)
    ? selection.skills.filter((skill) => skill !== name)
    : [...selection.skills, name].toSorted();
  return { mode: "custom", skills };
}
