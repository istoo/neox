// FILE: tasksSurface.ts
// Purpose: Tasks takes Kanban's place unless the connected server refuses it.
//          Older servers may not offer Tasks; refusal restores Kanban for the session.
// Layer: Web feature gate
// Exports: TASKS_OFFERED_BY_BUILD, isTasksSurfaceEnabled, useTasksSurfaceEnabled,
//          isTasksRefusal, noteTasksRefusal

import { TASKS_UNAVAILABLE_ERROR_CODE } from "@synara/contracts";
import { create } from "zustand";

import { isBetaFeatureOn } from "./betaFeatures";
import { NEOLIX_TASKS_UI_ENABLED } from "./neolixFeatures";

/** Neox 无 todo 后端：Tasks（todo）surface 关闭，Kanban 占据同一 slot。 */
export const NEOLIX_TASKS_ENABLED = NEOLIX_TASKS_UI_ENABLED;

/** Tasks replaces Kanban in Stable and Beta, with the board accessible from its switch. */
export const TASKS_OFFERED_BY_BUILD = isBetaFeatureOn("tasks");

const useTasksRefusalStore = create<{ refused: boolean }>(() => ({ refused: false }));

export function isTasksRefusal(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === TASKS_UNAVAILABLE_ERROR_CODE
  );
}

/** Records that the server does not offer Tasks; returns whether the error said so. */
export function noteTasksRefusal(error: unknown): boolean {
  if (!isTasksRefusal(error)) return false;
  useTasksRefusalStore.setState({ refused: true });
  return true;
}

/** For non-React callers such as route guards. */
export function isTasksSurfaceEnabled(): boolean {
  return TASKS_OFFERED_BY_BUILD && !useTasksRefusalStore.getState().refused;
}

export function useTasksSurfaceEnabled(): boolean {
  return useTasksRefusalStore(
    (state) => NEOLIX_TASKS_ENABLED && TASKS_OFFERED_BY_BUILD && !state.refused,
  );
}
