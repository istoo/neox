// FILE: subagentDetach.logic.ts
// Purpose: The subagent "Detach" decision, kept out of the dock component. A detached child
//          leaves its parent track and continues as a standalone agent. Labels and confirm copy
//          stay in the component; this module decides when the confirmation runs and what
//          happens after it.
// Layer: Chat subagent presentation logic

/** A title is only useful as a label when it says something other than the default "New Agent". */
export function resolveDetachSubagentLabel(title: string | null | undefined): string | null {
  if (typeof title !== "string") return null;
  const normalized = title.trim();
  if (!normalized) return null;
  if (normalized.toLowerCase() === "new agent") return null;
  return normalized;
}

export interface DetachSubagentDeps {
  /** Ask the user; resolves false when they cancel. */
  readonly confirm: () => Promise<boolean>;
  readonly detach: () => Promise<void>;
  /** Runs only after the daemon accepted the detach. */
  readonly onDetached: () => void;
  readonly reportError: (error: unknown) => void;
}

/** Returns true when the subagent was detached. */
export async function requestDetachSubagent(deps: DetachSubagentDeps): Promise<boolean> {
  const confirmed = await deps.confirm();
  if (!confirmed) return false;
  try {
    await deps.detach();
  } catch (error) {
    deps.reportError(error);
    return false;
  }
  deps.onDetached();
  return true;
}
